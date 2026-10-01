# アーキテクチャ解説

このドキュメントは、「開発ニキ」（このリポジトリのアプリケーション）の仕組みを、前提知識ゼロの人でも読み通せるように説明するものです。個別の設定手順は [setup.md](./setup.md)、ローカル検証は [docs/localhost-testing.md](./localhost-testing.md) を参照してください。ここでは「そもそも何が・どこで・なぜ動いているか」を教科書的に積み上げて説明します。

## 0. このアプリが何をするものか

一言で言うと、**「Discordの中で使う、開発の宣言と達成判定bot」**です。

1. ユーザーがDiscordで「今日中にログイン画面を実装する」と宣言する
2. 期限までに、宣言した通りのコミットをGitHubにpushしたかを自動でチェックする
3. 期限が来たら、達成・未達成をDiscordのチャンネルに自動投稿する

これを実現するために、**4つの外部サービス**が連携しています。

| サービス | このアプリでの役割 |
| --- | --- |
| **Discord** | ユーザーとの対話窓口（コマンド入力・結果通知） |
| **GitHub** | 本人確認（OAuth）とコミット履歴の参照 |
| **Vercel** | アプリ本体（Next.js）のホスティング先 |
| **Supabase** | データベース（PostgreSQL）と定期実行（Cron） |

まずはこの4つがどう繋がっているか、全体図で見てから、1つずつ深掘りします。

## 1. 全体構成図

```
                         ┌─────────────────────────┐
                         │        Discord           │
                         │ (ユーザーが操作する場所)   │
                         └───────────┬───────────────┘
                                     │ ① /niki コマンド実行
                                     │    → DiscordのサーバーがPOST
                                     ▼
┌────────────────────────────────────────────────────────────┐
│                     Vercel（このアプリ本体）                   │
│                                                              │
│  /api/discord/interactions  ← ①Discordコマンドの受付          │
│  /api/github/start          ← ②GitHub連携リンクを開いた時      │
│  /api/github/callback       ← ③GitHub認可後のリダイレクト先     │
│  /api/jobs/evaluate         ← ④定期実行で叩かれる判定バッチ     │
│                                                              │
└───────┬───────────────────┬───────────────────┬─────────────┘
        │②③GitHub API呼び出し│④DB読み書き        │①④Discordへ返信/通知
        ▼                   ▼                   ▼
   ┌─────────┐        ┌───────────┐        ┌──────────┐
   │ GitHub   │        │ Supabase  │        │ Discord   │
   │ (OAuth・  │        │ (Postgres  │        │ (返信・    │
   │  Commit  │        │  ＋Cron)   │        │  通知投稿) │
   │  API)    │        │            │        │           │
   └─────────┘        └─────┬─────┘        └──────────┘
                             │ ⑤5分おきに
                             │ POST /api/jobs/evaluate
                             ▼
                    （上の Vercel の④に戻る）
```

ポイントは、**Vercel上のこのアプリが「ハブ」になっていて、他の3サービスはこのアプリを介してしか繋がらない**ということです。DiscordとGitHubとSupabaseが直接会話することはありません。

## 2. 登場人物（外部サービス）の基礎知識

### 2-1. Vercel — アプリの置き場所

Next.js（このアプリが使っているWebフレームワーク）のプロジェクトを、そのままインターネット上で動かしてくれるホスティングサービスです。

- `git push` するだけで自動的にビルド・デプロイされます（[4-2章](./setup.md#4-2-vercelの手動デプロイ)）
- デプロイすると `https://xxxxx.vercel.app` のような公開URLが発行されます
- このアプリのコードには常駐プロセス（ずっと起動し続けるサーバー）という概念がなく、**リクエストが来た時だけ一時的にプログラムが起動して処理し、終わったら消える**（サーバーレス）という方式です

### 2-2. Discord — ユーザーとの対話窓口

DiscordはSlackに似たチャットアプリです。このアプリは「Bot」としてDiscordサーバー（＝チャットのコミュニティ、通称guild）に参加し、`/niki` から始まるスラッシュコマンドで操作されます。

Discord Botには大きく2つの通信方式があり、これを混同すると仕組みが理解できなくなるので最初に整理します。

| 方式 | 仕組み | このアプリでの採用 |
| --- | --- | --- |
| **Gateway方式** | Bot側からDiscordに常時接続（WebSocket）を張りっぱなしにし、イベントを待ち受ける | **不採用**（[過去に試して撤回済み](#7-過去の試行echo-bot)） |
| **Interactions（Webhook）方式** | Discord側が、事前に登録されたURLへその都度HTTP POSTを送ってくる | **採用** |

このアプリはWebhook方式のみを使っています。つまり、**アプリからDiscordに接続しにいくのではなく、Discordからアプリに送られてくる**のが基本の向きです（詳しくは[3章](#3-discordとの通信-interactions-webhook)）。

### 2-3. GitHub — 本人確認とコミット確認

GitHubは2つの目的で使われます。

1. **OAuth認可**: 「Discordのこのユーザー＝GitHubのこのアカウント」を本人確認つきで紐づける
2. **Commit API**: 宣言の期限が来たら、対象リポジトリ・ブランチに本人名義のコミットがあるかを確認する

このアプリはGitHubの**個人情報や秘密情報を保存しません**。OAuthで得られる「そのユーザーのアクセストークン」は、本人確認（`/user` API呼び出し）に一度使うだけで、DBに保存せず捨てます（[3-1章](./setup.md#3-github-oauth-app)）。

### 2-4. Supabase — データベースと定期実行

SupabaseはPostgreSQL（本格的なリレーショナルデータベース）を、管理画面つきでホスティングしてくれるサービスです。このアプリでは2つの機能を使っています。

1. **DB本体**: 宣言・ユーザー・通知などのデータを保存するテーブル群
2. **Cron（`pg_cron`）**: 「5分おきに、Vercel上の判定APIをHTTPで呼び出す」という定期実行の仕組み

なぜアプリ自身がタイマーを持たず、Supabase Cronに定期実行を任せているかというと、**サーバーレス環境（Vercel）にはプロセスがずっと起動し続ける前提がなく、`setInterval`のような仕組みを自前で組めない**からです。かわりに、DB側から一定間隔でアプリを「起こしにいく」構成になっています。

## 3. Discordとの通信（Interactions Webhook）

### 3-1. なぜ「Discordから」アプリに繋げられるのか

Discord Developer Portalという管理画面で、あらかじめ次の設定をしておきます。

- **Interactions Endpoint URL** = `https://<Vercelの本番URL>/api/discord/interactions`

これを登録しておくと、ユーザーが `/niki` コマンドを打つたびに、**Discordの運営サーバーがこのURLに向かって直接HTTP POSTを送ってくる**ようになります。つまり通信のきっかけを作っているのはDiscord側の設定です。アプリ側が能動的にDiscordへ「コマンドありますか？」と聞きにいくことはありません。

### 3-2. なりすまし対策（署名検証）

Interactions Endpoint URLは公開されたURLなので、誰でもそこにPOSTを送ろうと思えば送れてしまいます。それを防ぐため、Discordは全てのリクエストに電子署名を付けてきます。

| ヘッダー名 | 内容 |
| --- | --- |
| `X-Signature-Ed25519` | Discordの秘密鍵で作られた署名 |
| `X-Signature-Timestamp` | リクエスト送信時刻 |

アプリ側は、Discord Developer Portalで確認できる**公開鍵**（環境変数 `DISCORD_PUBLIC_KEY`）を使ってこの署名を検証します（[route.ts:34-41](../src/app/api/discord/interactions/route.ts#L34-L41)）。署名が合わなければ即座に401エラーで拒否します。

> 公開鍵暗号の要点: 「秘密鍵で署名 → 公開鍵で検証」という組み合わせでは、公開鍵を知っていても偽の署名は作れません。だから `DISCORD_PUBLIC_KEY` は秘密にする必要がなく、逆に `DISCORD_BOT_TOKEN`（後述）は絶対に外部へ漏らしてはいけません。

### 3-3. リクエストからレスポンスまでの流れ

[route.ts](../src/app/api/discord/interactions/route.ts) が実際の受付処理です。処理の順番を表にします。

| 手順 | 内容 | 対応コード |
| --- | --- | --- |
| ① | サイズ上限チェック（64KB超は拒否） | [route.ts:38-40](../src/app/api/discord/interactions/route.ts#L38-L40) |
| ② | 署名検証 | [route.ts:41](../src/app/api/discord/interactions/route.ts#L41) |
| ③ | `PING`（type 1）なら即座に`PONG`を返す | [route.ts:45](../src/app/api/discord/interactions/route.ts#L45) |
| ④ | コマンドの形式をzodで検証 | [route.ts:46-47](../src/app/api/discord/interactions/route.ts#L46-L47) |
| ⑤ | 想定外のBotアプリからの偽装でないか確認 | [route.ts:48](../src/app/api/discord/interactions/route.ts#L48) |
| ⑥ | **先に「今処理中です」という一次応答を返す** | [route.ts:51](../src/app/api/discord/interactions/route.ts#L51) |
| ⑦ | 一次応答を返した**後**で、実際のDB操作などを実行 | [route.ts:50](../src/app/api/discord/interactions/route.ts#L50) |

③の`PING`は、Developer PortalでURLを保存する時に一度だけ送られてくる疎通確認です。これに正しく応答できないと、そもそもURLの登録自体が保存できません。

⑥⑦が最も直感に反する部分なので、次の節で詳しく説明します。

### 3-4. 「3秒ルール」と2段階応答

Discordの仕様上、**コマンドを受け取ってから3秒以内に何かしら応答しないとタイムアウト扱いになります**。しかし、このアプリの実際の処理（DBへの読み書き、GitHubへの問い合わせなど）は3秒以内に終わる保証がありません。

そこで、Discordが用意している「2段階で返事をする」仕組みを使います。

```
時刻 0.0秒: Discordからコマンド受信
時刻 0.1秒: 「考え中です...」という一次応答（type 5 = deferred）を即座に返す ← 3秒ルールをここでクリア
時刻 0.1秒〜数秒後: バックグラウンドで本処理（DB更新・GitHub確認など）を実行
時刻 数秒後: 本処理の結果で、さっきの返信を「編集」して確定した内容に差し替える
```

コードで言うと、[route.ts:50-51](../src/app/api/discord/interactions/route.ts#L50-L51) の

```ts
after(() => processInteraction(parsed.data));
return Response.json({ type: 5, data: { flags: 64 } });
```

がこれにあたります。`after()` はNext.jsの機能で、「レスポンスを返したあとに、バックグラウンドで続きの処理を実行する」ためのものです。`type: 5` が「考え中です」という一次応答、`flags: 64` はその表示を本人だけに見せる（Ephemeral）指定です。

そして本処理（[route.ts:13-32](../src/app/api/discord/interactions/route.ts#L13-L32)の`processInteraction`）が完了すると、[client.ts](../src/lib/discord/client.ts)の`editReply`が呼ばれ、**さっき返した一次応答を、確定した内容に編集**します。この「編集」もDiscordへの新しいHTTPリクエストです（後述）。

### 3-5. アプリからDiscordへの通信（逆方向）

ここまでは「Discord → アプリ」向きの通信でした。逆に「アプリ → Discord」向きの通信も存在します。これは普通のREST API呼び出しで、特別な仕組みはありません。

[client.ts](../src/lib/discord/client.ts) が窓口です。

| 関数 | 用途 | 認証方法 |
| --- | --- | --- |
| `editReply` | 一次応答を確定内容に編集 | インタラクション固有のトークン（URLの一部） |
| `deliver` | 通知チャンネルへメッセージ投稿 | `Bot <トークン>` ヘッダー |
| `assertChannel` / `assertMember` | チャンネルや参加者の存在確認 | `Bot <トークン>` ヘッダー |

`Bot <トークン>` の `<トークン>` が環境変数 `DISCORD_BOT_TOKEN` です。これはDiscord Developer Portalの「Bot」画面で発行され、**このアプリだけが持っている、Botとしてなりすまし操作するための鍵**です。この値が漏れると誰でもそのBotとして投稿・操作ができてしまうため、`DISCORD_PUBLIC_KEY`とは違って厳重に秘密にする必要があります。

まとめると：

| 向き | 使うもの | 目的 |
| --- | --- | --- |
| Discord → アプリ | `DISCORD_PUBLIC_KEY`（公開鍵） | 届いたリクエストが本物のDiscordからかを検証 |
| アプリ → Discord | `DISCORD_BOT_TOKEN`（秘密鍵的なもの） | アプリがBotとして振る舞うことをDiscordに証明 |

**「アプリにbotの情報を入れるだけでは通信できないのでは」という疑問への回答**: その直感は正しく、実際には次の**両方**が揃って初めて成立しています。

1. Discord Developer Portal側に「アプリの公開URL」を登録する（＝Discordがどこにリクエストを送ればいいか分かる状態にする）
2. アプリ側に「Botのトークン・公開鍵」を設定する（＝アプリが受信リクエストを検証し、返信・投稿を送れる状態にする）

どちらか片方だけでは通信できません。

### 3-6. コマンド定義の事前登録

スラッシュコマンド（`/niki`）は、勝手に認識されるわけではなく、**事前にDiscordへ「このコマンドを使います」と登録**しておく必要があります。これを行うのが [scripts/register-commands.mjs](../scripts/register-commands.mjs) で、`npm run discord:register` から実行します（[4-1章](./setup.md#4-1-discord-botの詳細設定)）。

これは実行時の通信ではなく、**開発者が手動で一度（コマンド定義を変えるたびに）実行する準備作業**です。実行時にDiscordから飛んでくるリクエストの処理（3-3節）とは別物と考えてください。

## 4. GitHubとの通信（OAuth + Commit API）

### 4-1. なぜOAuthが必要か

「Discordのこの人」と「GitHubのこのアカウント」が同一人物であることを、なりすましなく確認する必要があります。パスワードを直接聞くのは論外なので、GitHubが提供する**OAuth 2.0**という標準プロトコルを使います。

### 4-2. 全体の流れ（PKCE付き Authorization Code Flow）

```
① Discordで /niki github を実行
       │  アプリがDBに「10分間有効・1回限りの ticket」を発行
       ▼
② ユーザーだけに見える返信に、連携リンクが表示される
   [GitHubアカウントを連携する](APP_URL/api/github/start?ticket=xxxx)
       │  ユーザーがブラウザでこのリンクを開く
       ▼
③ /api/github/start がticketを検証し、
   GitHubの認可ページへブラウザをリダイレクト
       │  ここで初めてGitHub側のページが開く
       ▼
④ ユーザーがGitHub側で「Authorize」を押す
       │  GitHubがブラウザを /api/github/callback?code=... にリダイレクト
       ▼
⑤ /api/github/callback がcodeをGitHubのトークンAPIに送り、
   一時的なアクセストークンと交換
       │  そのトークンで /user API を呼び、本人のgithub_idを取得
       │  トークン自体はここで破棄（DBに保存しない）
       ▼
⑥ DiscordのユーザーIDとGitHubのユーザーIDをDBに保存して連携完了
```

対応コード: [start/route.ts](../src/app/api/github/start/route.ts)、[callback/route.ts](../src/app/api/github/callback/route.ts)。

ここで重要なのは、**GitHubがアプリのサーバーに直接HTTPリクエストを送ってくるわけではない**という点です。③④⑤の主役は常に**ユーザー自身のブラウザ**で、ブラウザがGitHubとアプリの間を行き来（リダイレクト）しているだけです。これはDiscordのWebhook方式（Discordのサーバーが直接アプリを叩く）とは仕組みが根本的に異なります。だからこそ、[localhost-testing.md](./localhost-testing.md#3-discordコマンドをlocalhostで受信するには公開urlが必要)にある通り、**GitHub連携だけはローカルのlocalhostのままでもトンネル無しで最後まで動作確認できます**（ブラウザがlocalhostにアクセスできるため）。一方Discordのコマンドは、Discordのサーバーが直接localhostへは到達できないため、公開URLが必須になります。

### 4-3. PKCE・state・Cookieの役割

OAuthには、リンクを横取りされたり、他人のログインセッションに割り込まれたりする攻撃手法が知られており、それぞれに対策があります。

| 仕組み | 何を防ぐか |
| --- | --- |
| **ticket**（1回限り・10分間） | `/niki github` の返信リンクを他人に使い回されること |
| **state** | GitHubからのcallbackが、自分が開始したリクエストに対応するものか確認（CSRF対策） |
| **PKCE**（`code_challenge`/`code_verifier`） | 認可コード（`code`）を途中で盗まれても、正しい`verifier`を持たない第三者が使えないようにする |
| **HttpOnly Cookie**（`browser`） | callbackを受けたブラウザが、リンクを開いた本人のブラウザと同一であることを確認 |

これらはすべて[start/route.ts](../src/app/api/github/start/route.ts)と[callback/route.ts](../src/app/api/github/callback/route.ts)、および[security.ts](../src/lib/security.ts)で実装されています。

### 4-4. Commit APIによる達成判定

宣言の期限が来ると、Cronから起動される判定処理（[6章](#6-定期実行cron-による判定バッチ)）が、GitHubのCommit APIを使って「宣言登録時刻〜期限の間に、本人のGitHub IDがauthorになっているコミットが、指定ブランチに存在するか」を確認します（[github.ts](../src/lib/github.ts)、判定条件の詳細は[7章](./setup.md#7-判定再試行の仕様)）。

この確認には、`TOKEN_ENCRYPTION_KEY`設定時はそのユーザーの暗号化保存済みOAuthトークンを使い、無い・失効している場合は`GITHUB_API_TOKEN`という**運営側の1本のトークン**にフォールバックします（[3-2章](./setup.md#3-2-github_api_tokenについて)）。未認証だと1時間60リクエストの制限に達しやすいため、これらのトークンでレート制限を緩和しています。

## 5. データベース（Supabase / PostgreSQL）

### 5-1. なぜアプリのメモリではなくDBに保存するのか

Vercelのようなサーバーレス環境は、リクエストごとにプログラムが起動・終了するため、**変数に保存したデータはリクエストが終わると消えます**。宣言内容やユーザーの連携情報のような「ずっと覚えておくべきデータ」は、外部の永続的なデータベース（Supabase＝PostgreSQL）に保存する必要があります。

### 5-2. テーブル構成

| テーブル | 役割 |
| --- | --- |
| `users` | Discord ID ⇔ GitHub ID の対応表（1 GitHub IDにつき1 Discord IDのみ） |
| `guild_settings` | サーバー（guild）ごとの通知先チャンネル |
| `memberships` | どのサーバーでどのユーザーが連携済みか |
| `declarations` | 宣言本体（内容・リポジトリ・ブランチ・期限・判定結果） |
| `notifications` | Discordへの通知の送信予約・送信状態・再試行情報 |
| `oauth_sessions` | OAuth手続き中の一時データ（10分間だけ有効） |
| `interaction_receipts` | 同じDiscordコマンドが再送された時に二重処理しないための受付記録 |

（定義: [supabase/migrations/202609260001_mvp.sql](../supabase/migrations/202609260001_mvp.sql)）

### 5-3. アクセス制御（RLS）

Supabaseは本来、ブラウザ側のJavaScriptから直接DBを触れる「anon key」という仕組みも提供していますが、このアプリは**それを一切使いません**。

- 全テーブルで Row Level Security（RLS）を有効化
- しかし許可ポリシーは1つも作らない → **ポリシーが無いRLS有効テーブルは全ロールからアクセス拒否がデフォルト**
- `anon`・`authenticated`ロールへの権限を明示的に`revoke`
- `service_role`（バックエンド用の強い権限）にのみ`grant`

つまり、**DBへ触れる経路はNext.jsのサーバー側コード（`SUPABASE_SERVICE_ROLE_KEY`を持つ側）だけ**に限定されています。ブラウザや外部から直接Supabaseを叩いても、署名検証・本人確認を通過していないリクエストは弾かれます（詳細: [setup.md 2-1章](./setup.md#2-1-rlsと権限の詳細)）。

### 5-4. データベース関数（RPC）

DBへの複雑な更新（例: 「宣言が1件も無いことを確認してから作成する」）は、Next.js側で複数クエリを組み立てるのではなく、`niki_`から始まるPostgreSQL関数（例: `niki_create_declaration`）としてDB側に定義し、アプリはそれを1回呼ぶだけにしています。これにより、**複数のリクエストが同時に来ても、DBのトランザクション機構が競合を防ぐ**ことができます（同時に2つの宣言を登録しようとしても、片方だけが成功する、など）。

## 6. 定期実行（Cron）による判定バッチ

### 6-1. なぜCronが必要か

宣言の期限判定や通知の送信は、「誰かがコマンドを打った瞬間」には起こらず、**時間が経過した結果として**発生します。サーバーレスのアプリには「裏で時計を見ながら待ち構えるプロセス」が存在できないため、外部から定期的に「起こしにいく」仕組みが必要です。

### 6-2. 仕組み

```
Supabase側:
  pg_cron（PostgreSQL拡張）が5分おきにスケジュールを発火
       │
       │  pg_net（PostgreSQL拡張、DBからHTTPリクエストを送れるようにする）を使って
       ▼
  POST https://<本番URL>/api/jobs/evaluate
  Authorization: Bearer <CRON_SECRET>
       │
       ▼
Vercel側:
  /api/jobs/evaluate が Bearer トークンを検証
       │
       ▼
  進行中の宣言をチェック（GitHub Commit API）。期限前は30分おき（最後の1時間は10分おき）に達成だけを検出し、未達成は期限後の確認でのみ確定する
  → 結果をDBに保存
  → 通知をDiscordへ投稿
```

（設定: [supabase/cron.sql](../supabase/cron.sql)、実装: [evaluate/route.ts](../src/app/api/jobs/evaluate/route.ts)、[jobs.ts](../src/lib/jobs.ts)）

`CRON_SECRET`は、Supabase Vault（Supabase側の秘密情報保管庫）と、Vercelの環境変数の両方に同じ値を設定しておくことで、**「このリクエストは本当にSupabaseのCronから来たものだ」とアプリ側が確認できる**ようにする共有の合言葉です。Discordの署名検証（[3-2章](#3-2-なりすまし対策署名検証)）とは違う仕組みですが、目的（なりすまし防止）は同じです。

### 6-3. 二重実行・重複通知への対策

5分おきに動くバッチが、前回の実行が終わっていない・失敗した場合に重複処理をしないよう、以下の対策が入っています。

- DBの行ロックと「実行権限（lease）」による排他制御
- 実行が途中で止まっても、2分後には他のCron実行が引き継げる
- Discord投稿時に固定nonceを使い、再試行時は「Bot自身の過去の投稿」をDiscordの履歴から照合してから送る（二重投稿防止）

詳細な仕様は[setup.md 7章](./setup.md#7-判定再試行の仕様)にまとまっています。

## 7. 過去の試行（echo bot）

Gitの履歴には、Gateway接続（常時WebSocket接続）を使う「echoできるbot」を実装したコミット（`ae7bf93`）と、それを取り消したコミット（`f6c552c`）が残っています。現在のコードベースにはGateway方式のコードは存在せず、[2-2章](#2-2-discord--ユーザーとの対話窓口)で説明したInteractions Webhook方式のみが採用されています。サーバーレス環境（Vercel）とは「常時接続」の相性が悪く、リクエスト駆動のWebhook方式の方が自然に噛み合うためと考えられます。

## 8. まとめ: 誰が誰に何を送っているか

最後に、すべての通信を送信元→送信先の形で一覧にします。

| # | 送信元 | 送信先 | 内容 | きっかけ |
| --- | --- | --- | --- | --- |
| 1 | Discordのサーバー | アプリ（`/api/discord/interactions`） | スラッシュコマンドの内容 | ユーザーが`/niki`を実行 |
| 2 | アプリ | Discord API | 一次応答の編集・チャンネルへの投稿 | 上記1の処理完了後 |
| 3 | ユーザーのブラウザ | アプリ（`/api/github/start`） | 連携用ticket | Discordの返信リンクをクリック |
| 4 | アプリ | ユーザーのブラウザ（リダイレクト） | GitHub認可ページへの誘導 | 上記3を受けて |
| 5 | ユーザーのブラウザ | GitHub | OAuth認可 | GitHubの画面で承認 |
| 6 | GitHub | ユーザーのブラウザ（リダイレクト） | 認可コード | 上記5の結果 |
| 7 | ユーザーのブラウザ | アプリ（`/api/github/callback`） | 認可コード | 上記6のリダイレクト |
| 8 | アプリ | GitHub API | コード⇔トークン交換、本人確認 | 上記7を受けて |
| 9 | アプリ | Supabase（Postgres） | 宣言・ユーザー情報の読み書き | 各種コマンド処理・Cron実行時 |
| 10 | Supabase（pg_cron/pg_net） | アプリ（`/api/jobs/evaluate`） | 判定バッチの起動 | 5分おきの定期実行 |
| 11 | アプリ | GitHub Commit API | 対象ブランチのコミット履歴 | 上記10を受けて、確認時刻が来た宣言ごと（期限前を含む） |

この表と[1章の全体構成図](#1-全体構成図)を突き合わせながら読むと、「このアプリはハブであり、外部サービス同士が直接話すことはない」という全体像がつかめるはずです。

## 9. サーバーの構成 — どのmoduleで何を作っているか

ここまでは「外部サービスとどう繋がっているか」でした。ここからは視点を変えて、**Vercel上で動く「アプリ本体」そのものが、どんなnpmパッケージ（module）を組み合わせてできているか**を説明します。最後に、「AIを使わずNext.js初心者が一から同じ構成を組むならどういう手順・順番になるか」という視点でまとめます。

### 9-1. 使っているモジュール一覧

[package.json](../package.json)の依存関係を、役割ごとに分類します。

| モジュール | 役割 | このアプリでの使いどころ |
| --- | --- | --- |
| `next` | Webフレームワーク本体。ルーティング・サーバー機能・ビルドを提供 | アプリ全体の土台。App Router（`src/app/`配下がそのままURLになる方式）を使用 |
| `react` / `react-dom` | UI構築ライブラリ | [layout.tsx](../src/app/layout.tsx) / [page.tsx](../src/app/page.tsx)（トップページの案内文のみ、対話UIはDiscord側にある） |
| `zod` | 実行時の型検証（バリデーション） | Discordから届いたJSON・ユーザー入力（宣言内容・期限など）が期待通りの形式か検証 |
| `discord-interactions` | Discordの署名検証ヘルパー | [security.ts:19](../src/lib/security.ts#L19)の`verifyKey`（Ed25519署名検証） |
| `@octokit/rest` | GitHub公式のAPIクライアント | [github.ts](../src/lib/github.ts)でCommit APIを呼ぶ際に使用 |
| `@supabase/supabase-js` | SupabaseへのDBクライアント | [store.ts:2](../src/lib/store.ts#L2)の`createClient`。DB関数（RPC）呼び出しに使用 |
| `server-only` | 「このファイルはサーバー側でしか読み込めない」と明示するだけの空パッケージ | [config.ts:1](../src/lib/config.ts#L1)、[store.ts:1](../src/lib/store.ts#L1)などの先頭。誤ってブラウザ用コードに秘密情報付きファイルを取り込んだ場合にビルドエラーにする安全装置 |
| `tailwindcss` | CSSを部品化せず、クラス名の組み合わせで書けるようにするスタイリングツール | [globals.css](../src/app/globals.css)、トップページの見た目 |
| `typescript` | JavaScriptに型を付ける言語拡張 | プロジェクト全体（`.ts`/`.tsx`ファイル） |
| `vitest` | テスト実行ツール | `npm test`。GitHub/DiscordはSDK呼び出しをモックに差し替え、DBはPGliteで検証 |
| `@electric-sql/pglite`（devDependency） | PostgreSQLをWebAssemblyで動かし、実際のSupabaseなしにSQL・RPCをテストできるようにするツール | テストコードの中だけで使用。本番では使わない |
| `eslint` | コードの書き方チェック（静的解析） | `npm run lint` |

自分でNode.js標準機能だけを使い、上記モジュールを一切使わなかった場合に代わりに必要になる作業も併記します。

| モジュールが肩代わりしていること | モジュールなしで自作する場合 |
| --- | --- |
| `next`のルーティング | 自分で`http.createServer`を書き、URLパスごとに`if`分岐でハンドラーを呼び分ける |
| `zod`の入力検証 | 届いたJSONの型・範囲・正規表現チェックを1つずつ手書き |
| `discord-interactions`の署名検証 | Node.jsの`node:crypto`でEd25519の検証ロジックを自前実装（このアプリも一部は`node:crypto`を直接使用。[security.ts:1](../src/lib/security.ts#L1)） |
| `@octokit/rest`のAPI呼び出し | `fetch()`でGitHubのURLとヘッダーを直接組み立てる（実際、Discord側は`@octokit`を使わず素の`fetch`で自作している。[client.ts:17](../src/lib/discord/client.ts#L17)） |
| `@supabase/supabase-js`のDB接続 | PostgreSQL用のドライバ（`pg`など）で直接SQL接続文字列を扱う |

この比較から分かる通り、**モジュールは「車輪の再発明をしない」ためのショートカット**であり、仕組みそのもの（HTTPで受けてHTTPで返す、JSONを検証する、署名を確かめる）はどれも普通のプログラミングの延長です。実際、このプロジェクトはDiscord/GitHubへの発信を専用SDKでなく素の`fetch`で書いており（`@octokit/rest`は受信済みコミット取得のみに限定使用）、**「モジュールを使う部分」と「素の`fetch`で十分な部分」を線引きしている**実例にもなっています。

### 9-2. ディレクトリ構成とApp Routerの考え方

```
src/
├─ app/                          ← ここがそのままURLになる（App Router）
│  ├─ layout.tsx                  全ページ共通の外枠（<html>など）
│  ├─ page.tsx                    "/" のページ本体
│  ├─ globals.css                 全体CSS
│  └─ api/                        "/api/..." のHTTPエンドポイント群
│     ├─ discord/interactions/route.ts   POST /api/discord/interactions
│     ├─ github/start/route.ts           GET/POST /api/github/start
│     ├─ github/callback/route.ts        GET /api/github/callback
│     └─ jobs/evaluate/route.ts          POST /api/jobs/evaluate
└─ lib/                          ← URLを持たない、純粋なロジック置き場
   ├─ config.ts                    環境変数の読み出し・検証
   ├─ security.ts                  署名検証・トークン生成などの暗号系ユーティリティ
   ├─ domain.ts                    ドメインのルール（期限のパース、集計計算など）
   ├─ store.ts                     Supabase呼び出しの窓口
   ├─ github.ts                    GitHub API呼び出しの窓口
   ├─ jobs.ts                      Cronバッチのロジック
   └─ discord/
      ├─ client.ts                 Discordへの発信窓口
      ├─ handler.ts                 /niki サブコマンドの分岐処理
      ├─ commands.ts                Discordに登録するコマンド定義（データ）
      ├─ messages.ts                Discordへ送るメッセージ本文の組み立て
      └─ permissions.ts             Discord権限ビットの計算
```

App Routerの最大の特徴は、**「`app/`配下のフォルダ階層＝URLのパス階層」というファイルベースルーティング**です。`app/api/discord/interactions/route.ts`というファイルパスがそのまま`/api/discord/interactions`というURLになり、そのファイルの中の`export async function POST(request)`が「このURLにPOSTが来た時の処理」になります。ルーティング設定ファイルを別に書く必要がありません。

`app/`の外にある`lib/`は、Next.jsが特別扱いするディレクトリではなく、**「URLを持たない、ただのTypeScriptモジュール」を置くための開発者側の整理**です。`route.ts`側は薄く保ち（受信・検証・呼び出しの配線だけ）、実際の判断ロジックは`lib/`に切り出す、という一般的な設計方針がこのリポジトリでも徹底されています（例えば[route.ts](../src/app/api/discord/interactions/route.ts)は52行しかなく、実処理は[handler.ts](../src/lib/discord/handler.ts)・[jobs.ts](../src/lib/jobs.ts)側にあります）。

### 9-3. リクエスト1本が処理される流れ（コードレベル）

`/niki declare ...`を例に、実際に呼ばれる関数を上から順に追います。

```
route.ts        POST(request)
  ├─ security.ts   verifyDiscordRequest()         ← 署名検証
  ├─ handler.ts    interactionSchema.safeParse()  ← zodでJSON形式を検証
  └─ (after)
     handler.ts    handleCommand()
       ├─ store.ts     requireMember()             ← Supabaseへ問い合わせ
       ├─ domain.ts    declarationInput.parse()    ← 入力値（内容・期限など）を検証
       ├─ domain.ts    parseDeadline()             ← 日本時間の文字列をUTCへ変換
       ├─ github.ts    validateRepository()        ← GitHubにリポジトリ・ブランチの実在確認
       └─ store.ts     createDeclaration()         ← SupabaseのRPCを呼び、DBへ保存
     client.ts      editReply()                    ← Discordへ結果を返信
```

このように、**1つのエンドポイント（`route.ts`）が、複数の`lib/`モジュールを順番に呼び出す「配線役」**になっているのが、このアプリのサーバー構成の基本パターンです。他の3つのエンドポイント（`github/start`、`github/callback`、`jobs/evaluate`）も同じ形（受信 → 検証 → `lib/`の関数を呼ぶ → 応答）を繰り返しています。

### 9-4. もしNext.js初心者がAIを使わず一から組むなら

「知識ゼロから、既存のAI支援なしにこの構成へたどり着くには」という前提で、実際に手を動かす順番の目安を示します。一気に全部作ろうとせず、**小さく動くものを積み上げる**のが唯一の現実的な進め方です。

| 段階 | やること | この段階で学ぶこと |
| --- | --- | --- |
| ① | `npx create-next-app` でプロジェクトを作り、`npm run dev`でトップページが表示されることを確認する | Next.jsの基本的な起動・ビルドの流れ |
| ② | `app/api/hello/route.ts` を自分で作り、`export function GET() { return Response.json({ ok: true }) }` を書いて`/api/hello`にアクセスできることを確認する | App RouterのRoute Handlerの書き方（ファイル＝URLという感覚） |
| ③ | Discord Developer Portalで自分のBotアプリを作り、[Discord公式のInteractions解説](https://docs.discord.com/developers/interactions/receiving-and-responding)を読みながら、まず「署名検証なしでPINGにPONGを返すだけ」のエンドポイントを作る（**この段階ではローカルで完結せず、ngrok等の公開URLが要る**ことに早めに気づくのが重要） | Webhook型の外部連携の基本形。3秒ルールの存在 |
| ④ | `discord-interactions`パッケージを入れ、公式ドキュメント通りに署名検証を追加する | 「公開URLだから誰でも叩ける」→「だから検証が要る」という因果関係 |
| ⑤ | 1個だけスラッシュコマンドを手動でDiscord REST APIに登録するスクリプトを書き、実際にDiscordでコマンドを打って、ハードコードした固定文言を返せるようにする | コマンド登録（設定）と実行時処理（配信）が別物であること |
| ⑥ | `zod`を導入し、受け取ったコマンドの形式を検証してから処理する形に直す | 「外部から来たデータは信用しない」という原則と、型安全な検証の書き方 |
| ⑦ | 3秒以内に処理が終わらないケースを想定し、Discordのdeferred応答（`type: 5`）→後から`editReply`で編集、という2段階に直す | 同期応答と非同期処理の分離、Next.jsの`after()` |
| ⑧ | Supabaseの無料プロジェクトを作り、`@supabase/supabase-js`で最小限のテーブル（例: メッセージのログ）に読み書きしてみる | 外部マネージドDBの使い方、環境変数でのURL・キー管理 |
| ⑨ | RLSを有効化し、まず「ポリシーなしで全部拒否」を体験してから、`service_role`だけ許可する設計に気づく | 「デフォルト拒否」のセキュリティ思想 |
| ⑩ | GitHub OAuth Appを作り、`state`だけ（PKCE無し）のシンプルなAuthorization Code Flowを実装して動かす | ブラウザ経由のリダイレクト型連携の基本形（Webhook型との違い） |
| ⑪ | ここまで動いたら、PKCE・HttpOnly Cookieを追加して攻撃耐性を上げる | セキュリティは「後から積み増せる」設計にしておくと学習しやすい |
| ⑫ | Vercelにデプロイし、本番URLでDiscord/GitHubの設定を向け直す。ローカルとの違い（環境変数、HTTPS必須）にここで初めて直面する | 開発環境と本番環境の差分吸収 |
| ⑬ | Supabase CronでVercelの自作APIを定期的に叩けるようにし、Bearerトークンで認証する | 「サーバーレスにはタイマーがない」問題の一般的な解決パターン |
| ⑭ | 二重実行・重複通知が起きることを実際に確認してから、lease・nonce・履歴照合などの対策を足す | 「まず素朴に作って壊れ方を見てから対策する」という順序の重要性 |

この順番のポイントは、**「Discord Webhook」「GitHub OAuth」「Supabase DB」「Cron」の4本柱を、それぞれ最小構成で一度動かしてから、後で安全対策（署名検証・PKCE・RLS・排他制御）を足していく**という進め方です。最初から全部の防御を実装しようとすると、何が壊れているのか切り分けられず挫折しやすいので、**「動く→正しくする→安全にする」の3段階**を意識すると一からでも到達可能な規模の構成です。

## 10. APIサーバーの構成としくみ（Route Handlerの書き方）

9章では「どのモジュールを使っているか」という部品の話をしました。ここでは、**「TypeScriptで実際にAPIサーバーをどう書くか」**という、コードの文法・作法に絞って説明します。Next.js（App Router）でAPIを書く時の単位は **Route Handler** と呼ばれます。

### 10-1. Route Handlerの最小形

`app/`配下の好きなフォルダに`route.ts`というファイルを置き、HTTPメソッド名と同じ名前の関数を`export`するだけで、そのURLのAPIが出来上がります。

```ts
// app/api/hello/route.ts
export async function GET() {
  return Response.json({ message: "Hello" });
}
```

これだけで `GET /api/hello` が動きます。対応できるメソッド名は `GET` `POST` `PUT` `PATCH` `DELETE` `HEAD` `OPTIONS` で、**定義していないメソッドで呼ばれると自動的に405エラーになります**。「ルーティング設定を別ファイルに書く」という作業がそもそも存在せず、**ファイルの置き場所＝URL、関数名＝HTTPメソッド**というのがNext.jsのApp Routerの根本ルールです。

### 10-2. リクエストの受け取り方

引数の`request`は、ブラウザ標準の[`Request`](https://developer.mozilla.org/docs/Web/API/Request)そのもの（またはそれを拡張した`NextRequest`）です。特別な独自APIではなく、**Web標準のFetch APIと同じ形**で読み書きできます。

| 取り出したいもの | 書き方 | このアプリでの実例 |
| --- | --- | --- |
| リクエストボディ（文字列） | `await request.text()` | [route.ts:39](../src/app/api/discord/interactions/route.ts#L39)（Discordの署名検証は生の文字列が必要なため） |
| リクエストボディ（JSON） | `await request.json()` | 一般的なAPIで最もよく使う形（このアプリはDiscordの都合で`text()`→自前`JSON.parse`を使用） |
| フォームデータ | `await request.formData()` | [start/route.ts:27](../src/app/api/github/start/route.ts#L27) |
| ヘッダー | `request.headers.get("authorization")` | [evaluate/route.ts:17](../src/app/api/jobs/evaluate/route.ts#L17) |
| クエリパラメータ（`?ticket=xxx`） | `request.nextUrl.searchParams.get("ticket")`（`NextRequest`限定の便利機能） | [start/route.ts:10](../src/app/api/github/start/route.ts#L10) |
| Cookie | `request.cookies.get("name")?.value`（`NextRequest`限定） | [callback/route.ts:14](../src/app/api/github/callback/route.ts#L14) |

`request.text()`と`request.json()`はどちらか一方しか呼べません（ボディは一度しか読めないストリームだからです）。JSONを期待するAPIでも、**署名検証のように「元の文字列のまま」でないと検証できない処理がある場合は`text()`で受けてから自分で`JSON.parse`する**必要があります。これがまさに[route.ts:39-44](../src/app/api/discord/interactions/route.ts#L39-L44)の書き方です。

### 10-3. レスポンスの返し方

返す値も同様にWeb標準の[`Response`](https://developer.mozilla.org/docs/Web/API/Response)です。よく使う3パターンを覚えれば大抵書けます。

```ts
// ① JSONを返す（一番よく使う）
return Response.json({ ok: true });
return Response.json({ error: "Bad Request" }, { status: 400 });

// ② ステータスコードだけ・本文なしで返す
return new Response("Invalid signature", { status: 401 });

// ③ HTMLなど、JSON以外を返す（Content-Typeを自分で指定）
return new Response("<h1>Hi</h1>", { headers: { "Content-Type": "text/html" } });
```

このアプリでは[oauth-response.ts](../src/lib/oauth-response.ts)が③のパターンで、GitHub連携の案内画面をHTML文字列として直接組み立てて返しています（Reactコンポーネントを使わず、素の文字列＋`new Response`で十分なケースです）。

Next.js独自の`NextResponse`（`next/server`からimport）はこの`Response`を拡張したもので、**Cookieの設定**や**リダイレクト**を書きやすくしてくれます。

```ts
import { NextResponse } from "next/server";

// Cookieを付けて返す
const response = NextResponse.json({ ok: true });
response.cookies.set("name", "value", { httpOnly: true, maxAge: 600 });

// リダイレクトする（303 = POSTの結果をGETで転送させる、というHTTPの正しい作法）
return NextResponse.redirect(url, 303);
```

実例: [start/route.ts:43-44](../src/app/api/github/start/route.ts#L43-L44)でGitHubの認可ページへ`NextResponse.redirect`し、同時に`response.cookies.set`でCookieを仕込んでいます。

### 10-4. 「このAPIの動作モード」を指定する設定変数

`route.ts`の中では、関数の外側に特別な名前の変数を`export`することで、Next.js側の挙動を切り替えられます。このアプリで使っているのは2つです。

```ts
export const runtime = "nodejs";   // 実行環境をNode.js標準に固定する
export const maxDuration = 60;     // このAPIの最大実行時間（秒）
```

- `runtime = "nodejs"`: Next.jsには軽量な"Edge"実行環境という選択肢もありますが、`node:crypto`（署名検証やハッシュ計算）やSupabaseクライアントなど、Node.js標準機能に依存するコードを使うため、全APIで明示的にNode.js環境を指定しています（[route.ts:10](../src/app/api/discord/interactions/route.ts#L10)ほか）。
- `maxDuration = 60`: GitHub APIへの問い合わせなど、時間がかかる可能性のある処理があるAPIに設定し、Vercelにタイムアウトを60秒まで許可してもらう指定です。

これらは`route.ts`ファイルごとに個別設定でき、「このAPIは重い処理をするから長め」「こっちは軽いからデフォルトのまま」と使い分けられます。

### 10-5. エラーハンドリングの型

外部連携が多いAPIサーバーでは、**「失敗したときに何を返すか」を先に設計しておく**ことが重要です。このアプリの各`route.ts`は、だいたい次の型で書かれています。

```ts
export async function POST(request: Request) {
  // ① 設定不備（環境変数が無いなど）→ 503
  let secret: string;
  try { secret = env("CRON_SECRET"); }
  catch { return Response.json({ error: "Not configured" }, { status: 503 }); }

  // ② 認証・認可の失敗 → 401 / 403
  if (!正しい) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // ③ 本処理。失敗したら握りつぶさず、ログに残してから503などを返す
  try {
    const result = await 本処理();
    return Response.json(result);
  } catch (error) {
    console.error("処理に失敗", safeError(error));   // 生のエラーをそのまま出さない
    return Response.json({ error: "Evaluation unavailable" }, { status: 503 });
  }
}
```

（実例: [evaluate/route.ts](../src/app/api/jobs/evaluate/route.ts)がほぼこの型そのままです）

ポイントは2つあります。

1. **エラーの種類ごとにステータスコードを使い分ける**（設定不備=503、認証失敗=401、入力不正=400、想定外の失敗=503など）。呼び出す側（Discord・GitHub・Supabase Cron）が、どう再試行すべきかをステータスコードから判断できるようにするためです。
2. **`console.error`に出すエラーは[security.ts](../src/lib/security.ts)の`safeError()`で加工してから出す**（[security.ts:23-29](../src/lib/security.ts#L23-L29)）。外部SDKの生のエラーオブジェクトには、Authorizationヘッダーやトークンなどの秘密情報がそのまま含まれていることがあるため、ログにすら残さないという方針です。

### 10-6. zodによる「型は合っているが値がおかしい」への対処

TypeScriptの型チェックは**コンパイル時**にしか効きません。外部（Discordやユーザー入力）から届くデータは実行時には「ただのJSON」でしかなく、TypeScriptの型は保証してくれません。そこで`zod`を使い、**実行時に「本当にこの形をしているか」を1回だけ確認し、以後はTypeScriptの型として安心して使う**という書き方をします。

```ts
import { z } from "zod";

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  age: z.number().int().min(0),
});

export async function POST(request: Request) {
  const json = await request.json();
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  // ここから先は parsed.data が { name: string; age: number } 型として安全に使える
}
```

実例: [handler.ts:9-17](../src/lib/discord/handler.ts#L9-L17)の`interactionSchema`が、Discordから届くコマンドの形式（コマンド名・オプション・権限など）を丸ごと検証しています。`safeParse`は失敗しても例外を投げず`{ success: false }`を返すため分岐が書きやすく、`parse`は失敗すると例外を投げるため「呼び出し元で`try/catch`する」書き方に向いています（このアプリは場面によって両方使い分けています）。

### 10-7. まとめ: Route Handler 1つの標準的な骨格

9章と10章の内容を合わせると、このアプリの`route.ts`はどれも次の骨格に収束します。

```ts
export const runtime = "nodejs";      // ← 実行環境の指定（必要なら）
export const maxDuration = 60;        // ← タイムアウト延長（必要なら）

export async function POST(request: Request) {
  // 1. 設定・認証まわりの前提条件を確認する（早期return）
  // 2. リクエストの中身を取り出す（text/json/formData/searchParams/cookies）
  // 3. zodなどで形式を検証する
  // 4. lib/ 配下の関数を呼んで実処理をする（DBアクセス・外部API呼び出し）
  // 5. 成功/失敗に応じたステータスコードでResponseを返す
}
```

この「受け取る→検証する→lib/に処理を委譲する→返す」という型さえ覚えてしまえば、Next.jsのAPIサーバーは**普通のTypeScript関数の集まり**として書けます。特別なフレームワーク文法を大量に覚える必要はなく、Web標準の`Request`/`Response`とファイル配置のルールさえ押さえれば十分です。
