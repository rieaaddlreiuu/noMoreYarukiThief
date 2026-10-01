# 開発ニキの起動と運用

Node.js 22.14以降（推奨24 LTS）、Discord Application、GitHub OAuth App、Supabaseプロジェクト、公開HTTPS URLが必要です。秘密情報はすべてサーバー側で使います。

## 1. ローカルの準備

```powershell
npm install
Copy-Item .env.example .env.local
```

`.env.local` を設定します。実値をGitへコミットしないでください。

| 変数 | 内容 |
| --- | --- |
| `APP_URL` | 公開URLのorigin。例: `https://your-app.vercel.app`。末尾のパスは付けない。ローカルのみ `http://localhost:3000` が使用可能 |
| `DISCORD_APPLICATION_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_PUBLIC_KEY` | 同画面のPublic Key。受信署名の検証用 |
| `DISCORD_BOT_TOKEN` | Bot画面で発行するBot Token |
| `DISCORD_GUILD_ID` | 開発用サーバーID。指定するとコマンドをそのサーバーだけに登録。全体公開時は省略 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth Appの認証情報 |
| `GITHUB_API_TOKEN` | 任意。公開リポジトリ参照のAPIレート制限を緩和する運営側のトークン。非公開リポジトリ権限は不要。未設定でも動作するが、共有IPの未認証レート制限に達しやすい |
| `GEMINI_API_KEY` | 任意。コミットメッセージが宣言内容と一致するかをAIで判定する機能を有効化する。未設定なら従来通り「author一致・期限内の最初のコミット」を達成として採用する。[Google AI Studio](https://aistudio.google.com/apikey)で発行できる |
| `GEMINI_MODEL` | 任意。AI判定に使うGeminiモデル名。未設定なら `gemini-3.8-flash`。モデルが廃止されて404になった場合に差し替える |
| `SUPABASE_URL` | SupabaseのProject URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabaseのバックエンド用service role key。ブラウザ用のanon keyは使用しない |
| `CRON_SECRET` | 定期実行APIの認証用。32文字以上のランダムな値 |

`CRON_SECRET` は以下で生成できます。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```powershell
npm run dev
```

トップページはDiscordでの操作案内のみです。宣言・取消・状況表示はDiscord内で行います。

## 2. SupabaseのDB

Supabase SQL Editorで [初期マイグレーション](../supabase/migrations/202609260001_mvp.sql) を1回実行します。Supabase CLIを使う場合は、プロジェクトをリンクして `supabase db push` でも適用できます。

その後、`supabase/migrations/`配下に追加されたマイグレーション（例: [AI判定用マイグレーション](../supabase/migrations/202609300001_ai_judgement.sql)）をファイル名の日付順に同様の方法で適用します。この特定のマイグレーションは`niki_finish_check`関数を`drop function`してから引数を追加した新しいシグネチャで再作成するため、**アプリのコードをデプロイする前に適用してください**（先にコードだけデプロイすると、新シグネチャでRPCを呼び出すコードとDB側の旧関数が不一致になりエラーになります）。

作成するテーブル:

- `users`: DiscordとGitHubの対応。1つのGitHub IDは1つのDiscord IDにだけ対応。
- `guild_settings`: サーバーごとの通知先。
- `memberships`: そのサーバーで連携した参加者。
- `declarations`: 宣言と判定結果。宣言時のGitHub ID・ブランチを固定保存。
- `notifications`: 宣言公開・取消・結果の通知予約、送信状態、再試行情報。
- `oauth_sessions`: 10分間有効の一時認可情報。リンクとstateはハッシュで保存。
- `interaction_receipts`: Discordの再送・リプレイに対する受付済みID。

全テーブルでRLSを有効にし、anon/authenticatedからのアクセスとRPC実行を許可していません。アクセスは署名や権限を検証したバックエンドのservice roleに限定しています。

### 2-1. RLSと権限の詳細

[初期マイグレーション](../supabase/migrations/202609260001_mvp.sql) の末尾で、全テーブルに対して以下を行っています。

- `alter table ... enable row level security` を実行しつつ、許可ポリシー(`create policy`)は1件も作成しません。ポリシーが存在しないRLS有効テーブルは、ポリシー対象ロールからのアクセスが全件拒否されます。
- `revoke all ... from public, anon, authenticated` で、SupabaseのAPIキー経由でアクセスする`anon`ロール・`authenticated`ロールおよび`public`から、SELECT/INSERT/UPDATE/DELETEを含む全権限を明示的に剥奪します。
- `grant all ... to service_role` で、`service_role`にのみ全テーブルへのアクセスを許可します。
- `niki_`プレフィックスの関数(`niki_link_github`、`niki_create_declaration`など)も同様に、`public`/`anon`/`authenticated`から`revoke`し、`service_role`にのみ`execute`を`grant`します。各関数は`set search_path = ''`を指定し、スキーマ名を必ず`public.`修飾で参照することでsearch_path経由のなりすましを防いでいます。

この構成により、ブラウザから直接Supabaseへ接続する用途（anon keyを使うクライアント）は一切機能しません。データベース操作は必ずNext.jsのサーバー側（Route Handler）が`SUPABASE_SERVICE_ROLE_KEY`を使って行い、Discordの署名検証・Discord/GitHubの本人確認を通過したリクエストだけがこれらの関数を呼び出せます。**anon keyはこのプロジェクトでは使用しません**。Supabaseダッシュボードの Project Settings → API に表示される`anon` `public`キーを`.env.local`や本番環境変数に設定しないでください。

追加でテーブルやRPCを増やす場合も、この「RLS有効化 + ポリシーなし + service_roleのみgrant」のパターンを踏襲し、anon/authenticatedへ権限を付与しないでください。

## 3. GitHub OAuth App

GitHub Settings → Developer settings → OAuth Appsでアプリを作成します。

- Homepage URL: `APP_URL`
- Authorization callback URL: `APP_URL/api/github/callback`
- Client IDとClient Secretを環境変数へ設定。
- callbackのワイルドカードは不要。上記のURLと一致させます。

OAuthでは公開プロフィールの本人確認だけを行い、`repo`、`user:email` などの追加scopeは要求しません。PKCEとstate、HttpOnly Cookieの照合を行います。ユーザーのOAuthアクセストークンは `/user` の呼び出し後に保持しません。公開コミット取得には運営側の任意の `GITHUB_API_TOKEN` を使います。

### 3-1. OAuth App登録フォームの各設定

`Homepage URL`と`Redirect URI`（Authorization callback URLの入力欄）には、`APP_URL`という文字列そのものではなく実際のURLを入力します。

- ローカル開発用に別のOAuth Appを作る場合: `http://localhost:3000` / `http://localhost:3000/api/github/callback`
- 本番・Vercelデプロイ用: `https://<実際のVercelドメイン>` / `https://<実際のVercelドメイン>/api/github/callback`

ローカルと本番で`APP_URL`が異なる場合は、別々のOAuth Appを作るか、1つのOAuth Appの`Redirect URI`に両方のcallback URLを追加登録してください（最大10件まで登録可能）。

Redirect URI欄の下にある追加設定は、いずれもデフォルトのままで構いません。

| 設定 | 推奨 | 理由 |
| --- | --- | --- |
| Allow wildcard matching | OFF（チェックなし） | callback URLは1つに固定できるため、サブドメイン・パスのワイルドカード許可は不要かつ余計な攻撃面を増やすだけ |
| Enable Device Flow | OFF（チェックなし） | CLIやスマートTVなどブラウザ操作しにくい端末向けの認可方式。本プロジェクトは通常のブラウザ経由Authorization Code Flow（+PKCE）のみを使うため不要 |
| Expire user access tokens | ON（チェックあり、デフォルト） | GitHub推奨のデフォルト設定。本プロジェクトは`/user`呼び出し後にアクセストークンを保持しないため有効期限・refresh_tokenの仕組み自体を使う場面はないが、有効にしておいても動作に影響しない |

### 3-2. `GITHUB_API_TOKEN`について

`GITHUB_API_TOKEN`は、各ユーザーが`/niki github`で連携する際のOAuthトークンとは別物で、**運営側（Bot管理者）が任意で用意する1つのトークン**です。宣言の期限後にコミット履歴をGitHub Commit APIで確認する処理（[7章](#7-判定再試行の仕様)）でのみ使います。

- 未設定でも動作しますが、GitHub REST APIは未認証だと1時間あたり60リクエストという制限があり、共有IPのVercel環境では他の利用者と合算ですぐ制限に達しやすくなります。設定すると1時間あたり5,000リクエストまで緩和されます。
- レート制限に達した場合は「確認エラー」として保留され、判定失敗（未達成）にはなりません（[7章](#7-判定再試行の仕様)）。ただし判定が遅延するため、実運用では設定を推奨します。
- 必要な権限は公開リポジトリのコミット閲覧のみです。非公開リポジトリへのアクセス権（Classic tokenの`repo`スコープなど）は不要です。運営者自身の [GitHub Personal Access Token](https://github.com/settings/tokens) を、Classic tokenならscopeを何も選択せずに、Fine-grained tokenならpublic repositoryへの読み取りのみで発行し、`GITHUB_API_TOKEN`に設定してください。

## 4. VercelとDiscord

1. このNext.jsプロジェクトをVercelにデプロイし、`.env.local` と同じサーバー用変数を設定します。`APP_URL` は確定した本番URLにします。GitHub側のcallbackも合わせます。手動デプロイの詳細手順は [4-2](#4-2-vercelの手動デプロイ) を参照してください。
2. Discord Developer Portalで **Interactions Endpoint URL** を `APP_URL/api/discord/interactions` に設定します。署名付きPINGに応答します。Gateway接続やMessage Content Intentは不要です。
3. ローカルから次を実行し、`/niki` を登録します。既存の別コマンドは削除しません。

```powershell
npm run discord:register
```

4. コマンドの出力にあるInstall URLでBotをサーバーに追加します。必要なscopeは `bot` と `applications.commands`。通知先で次の権限を付与します。
   - チャンネルを見る
   - メッセージを送信
   - 埋め込みリンク
   - メッセージ履歴を読む（送信済みの照合に使用）
5. サーバー管理者が `/niki setup channel:#開発記録` を実行します。通常のテキストチャンネルが対象です。
6. 各ユーザーが `/niki github` を実行し、本人だけに表示されるリンクを開いて「GitHubで連携する」を押し、GitHubを認可します。リンクのプレビュー表示では使用済みになりません。有効期限は発行から10分で、ボタンを押して認可を開始できるのは1回です。別のサーバーで使う場合も、そのサーバーでこの操作を行います。

開発用のguildコマンドからglobalコマンドに切り替える際は、重複表示を避けるため開発用コマンドをDiscord側で整理してください。本スクリプトは他の登録を自動削除しません。

### 4-1. Discord Botの詳細設定

**Bot画面（Developer Portal → Bot）**

- **PUBLIC BOT**: サーバー管理者以外もBotを自サーバーに追加できるようにするかの設定です。運用チーム内だけで使うならOFFのままで構いません。
- **Privileged Gateway Intents**（PRESENCE INTENT / SERVER MEMBERS INTENT / MESSAGE CONTENT INTENT）: いずれも**有効化不要**です。このBotはDiscordのGateway（常時接続のWebSocket）に接続せず、DiscordがHTTPS経由でInteractions Endpoint URLへ送ってくるWebhook形式のリクエストのみを処理するため、Gateway専用の特権インテントは使いません。
- Bot Tokenは「Reset Token」を押すと再発行され、旧トークンは即座に無効になります。再発行した場合は`DISCORD_BOT_TOKEN`を更新し、再デプロイしてください。

**Interactions Endpoint URLの検証の仕組み**

Discordは`APP_URL/api/discord/interactions`宛にPOSTするたびに、リクエストヘッダーへEd25519署名(`X-Signature-Ed25519`)とタイムスタンプ(`X-Signature-Timestamp`)を付与します。サーバー側は`discord-interactions`パッケージと`DISCORD_PUBLIC_KEY`を使ってこの署名を検証し、不正なリクエストは拒否します。Developer Portal側でEndpoint URLを保存する際に送られる`PING`（type 1）に対しても、同じ署名検証を通過したうえで`PONG`（type 1）を返す必要があります。署名検証に失敗するURLは保存できません。ローカル開発でこのURLを検証する方法は [docs/localhost-testing.md](./localhost-testing.md) を参照してください。

**Install URLのpermissions値**

`npm run discord:register`実行後に出力されるInstall URLの`permissions=84992`は、以下のDiscord権限ビットの合計です。

| 権限 | ビット値 |
| --- | --- |
| チャンネルを見る (View Channel) | 1024 |
| メッセージを送信 (Send Messages) | 2048 |
| 埋め込みリンク (Embed Links) | 16384 |
| メッセージ履歴を読む (Read Message History) | 65536 |

合計 84992。これ以外の権限（メンション全員、メッセージ管理など）は要求しません。招待URLの`scope`は`bot applications.commands`固定です。

**`scripts/register-commands.mjs`の挙動**

- `DISCORD_APPLICATION_ID`と`DISCORD_BOT_TOKEN`を必須で読み、`DISCORD_GUILD_ID`があればguild限定登録、なければglobal登録のエンドポイントにPOSTします。IDは17〜20桁の数字であることを正規表現で検証します。
- `POST /applications/{id}/(guilds/{guild}/)?commands`は指定した1コマンド(`/niki`)だけを**upsert**するAPIで、他にBotが持つ別コマンドを削除しません。
- global登録では`contexts`（DM/グループDMでの利用可否）と`integration_types`（サーバー導入かユーザー導入か）をコマンド定義に含めますが、guild限定登録のAPIはこれらのフィールドを受け付けないため、スクリプトが自動的に削除してから送信します。
- global コマンドの変更はDiscord全体への反映に最大1時間程度かかることがあります。動作確認中は`DISCORD_GUILD_ID`を設定した即時反映のguildコマンドを使うことを推奨します。

### 4-2. Vercelの手動デプロイ

このリポジトリに`vercel.json`は含まれておらず、VercelはNext.jsプロジェクトを自動検出します（Framework Preset: Next.js、Build Command: `next build`、Output: 自動）。追加の設定ファイルは不要です。

**初回セットアップ（ダッシュボード）**

1. [Vercel](https://vercel.com/) にログインし、「Add New... → Project」からこのGitHubリポジトリをImportします。
2. Project Settings → General → **Node.js Version** を確認します。`package.json`の`engines.node`は`>=22.14.0`を要求するため、Vercel側でも22.x系（利用可能な最新のLTS）を選択してください。デフォルトのまま古いバージョンになっている場合は明示的に変更します。
3. Project Settings → Environment Variables に、[1章](#1-ローカルの準備)の表と同じ変数（`APP_URL`は本番のVercel URL、`SUPABASE_SERVICE_ROLE_KEY`や`DISCORD_BOT_TOKEN`などの秘密情報を含む）をProduction環境向けに登録します。PreviewやDevelopment環境を使う場合は、開発用のDiscord Bot・GitHub OAuth App・Supabaseプロジェクトを別途用意し、そちらの値を設定してください（本番の秘密情報をPreview環境と共有しない）。
4. 初回のGit push（またはImport時の初回ビルド）で自動的にデプロイされます。

**GitHub連携によるデプロイ（通常運用）**

デフォルトの連携では、リンクしたブランチ（例: `main`）へのpushやマージのたびに自動でProductionデプロイが実行されます。Pull Requestを作ると、そのブランチ用のPreviewデプロイも自動生成されます。

**再デプロイ（Redeploy）— コードを変更せずに反映し直す場合**

環境変数を追加・変更しただけで、コードの変更なしに再ビルドしたい場合などに使います。

1. Vercelダッシュボードで対象プロジェクトの **Deployments** タブを開きます。
2. 反映したいデプロイメント（通常は最新のProductionデプロイ）の右側「...」メニューから **Redeploy** を選びます。
3. 確認ダイアログが出ます。環境変数の変更を反映したい場合は「Use existing Build Cache」の**チェックを外して**再ビルドしてください（ビルドキャッシュを使い回すと、ビルド時にしか読まれない値が古いまま残ることがあります）。実行時にのみ参照される環境変数（このプロジェクトのサーバー用変数は基本的に実行時参照）であればキャッシュ有無に関わらず反映されますが、迷ったらキャッシュなしで再ビルドするのが安全です。

**Vercel CLIによる手動デプロイ**

Gitホスティングを介さずローカルから直接デプロイしたい場合や、開発用の一時的なデプロイを作りたい場合に使えます（[docs/localhost-testing.md](./localhost-testing.md)の「代替案: Vercelに開発/テスト用デプロイを作る」も参照）。

```powershell
npm install -g vercel
vercel login
vercel link          # 初回のみ。既存のVercelプロジェクトと紐付ける
vercel env pull .env.local   # Vercel側に設定済みの環境変数をローカルへ取得する場合
```

Preview環境（一時的な検証用URL）へのデプロイ:

```powershell
vercel
```

Production環境（`APP_URL`として使う本番ドメイン）への手動デプロイ:

```powershell
vercel --prod
```

`vercel --prod`はローカルのソースをそのままVercelへアップロードしてビルド・デプロイします。GitHubへのpushを経由しないため、コミットしていない変更が本番に反映されてしまわないよう注意してください。

**共通の注意点**

- 環境変数を追加・変更した後は、既存のデプロイには自動反映されません。Redeployするか、新しいデプロイをトリガーしてください。
- Deployment Protection（Vercel Authentication、パスワード保護など）を有効にする場合は、Discord/GitHubから直接叩かれる`/api/discord/interactions`・`/api/github/callback`・Supabase Cronから叩かれる`/api/jobs/evaluate`が保護対象から除外されるよう、Protection Bypass設定やパス単位の除外を行ってください。除外されていないと、これらのエンドポイントが認証で弾かれて機能しなくなります。

## 5. Supabase Cron

SupabaseでCron（`pg_cron`）、`pg_net`、Vaultを有効にします。Vaultの画面から次の2件を登録します。

| Vaultの名前 | 値 |
| --- | --- |
| `niki_app_url` | Vercelの `APP_URL` と同じorigin（末尾の `/` なし） |
| `niki_cron_secret` | Vercelの `CRON_SECRET` と同じ値 |

[cron.sql](../supabase/cron.sql) をSQL Editorで実行すると、5分ごとに `POST /api/jobs/evaluate` を呼びます。同じジョブ名で再実行するとスケジュールを更新できます。Vercel Cronは使用しません。

定期呼び出し先にはSupabaseからのアクセスが必要です。VercelのDeployment Protectionなどで外部アクセスを遮断している場合は、本番エンドポイントへ到達できる設定にします。API自体はBearer secretで認証します。

初回の疎通確認は、ローカルで環境変数を読み込んで以下を実行できます（保存済みの期限超過宣言を実際に判定し、通知します）。

```powershell
node --env-file=.env.local --input-type=module -e "const r = await fetch(process.env.APP_URL + '/api/jobs/evaluate', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } }); console.log(r.status, await r.text());"
```

レスポンスの `checked` は確定した判定数、`notified` は送信済みにした通知数です。`checkRetry` / `notificationRetry` は再試行待ちに戻した件数、`stale` は古い実行権限による更新を拒否した件数です。API障害を処理して再試行を保存できた場合はHTTP 200になります。CronのHTTP成功だけでなくこの件数も確認してください。

## 6. Discordで使う

```text
/niki setup channel:#開発記録
/niki github
/niki declare content:ログイン画面を実装する repository:owner/repository deadline:2026-09-28 22:00 branch:feature/login
/niki notify
/niki notify reset:true
/niki cancel
/niki status
/niki status page:2
```

- `branch` は省略可能。宣言時点のデフォルトブランチ名を保存します。コミットがまだない空のリポジトリは宣言時に弾きます。
- 期限は日本時間で入力・表示し、DBはUTCで保存します。従来の `YYYY-MM-DD HH:mm` に加え、以下の書き方が使えます。全角数字・全角コロン・全角スペースも使えます。
  - `23:00` / `23時` / `23時30分`: 今日のその時刻。過ぎていれば明日の同時刻。
  - `今日` / `きょう`、`明日` / `あした`、`明後日` / `あさって`: 指定日の23:59。
  - `明日 9時` / `明日9:00` / `今日の23時` / `あさって 18時30分`: 指定日の時刻。「今日」の過ぎた時刻はエラーになります。
  - `30分後` / `3時間後`: 入力を処理した時刻から指定した分・時間だけ後。`2日後` は2日後の23:59。
  - `10/5` / `10/5 21:00` / `10/5 21時`: 今年の指定日（時刻省略時は23:59）。過ぎていれば来年として解釈します。
- 期限は今から10分以上後、30日以内（ちょうど10分後・30日後も可）です。来年として解釈した結果30日を超える場合や、存在しない日時はエラーになります。従来は「現在より後」のみを確認していましたが、入力形式の追加に合わせてこの範囲に統一しました。
- 入力エラーの理由と書き方の例は本人だけに表示されます。公開通知の期限表示は従来どおり `YYYY-MM-DD HH:mm JST` です。
- この変更の反映時は、アプリのデプロイに加えて管理者が `npm run discord:register` でコマンドを再登録してください（期限欄の説明と文字数制限を更新するため）。
- 判定待ち・確認エラーを含め、未確定の宣言は1人・1サーバーにつき1件までです。
- 本人が期限前の宣言だけを取り消せます。取消も通知され、集計には含まれません。
- コマンドへの応答は本人だけに表示。宣言・取消・結果の通知は設定したチャンネルに公開します。
- `/niki status` は同じサーバーの宣言・結果・参加者別集計を表示します。各欄5件ずつのページ切替で、集計自体は全履歴を対象にします。確認エラーと投稿待ちも表示します。

## 7. 判定・再試行の仕様

コミットのGitHub `author.id` が宣言時の連携IDと一致し、`commit.committer.date` が **宣言登録時刻以上・期限以下** の場合に達成とします。author名やメールアドレスだけでは本人とみなしません。期限後の確認時点で指定ブランチに存在するコミットを対象にします。push時刻、機能の完成、後でforce pushされた履歴の存在は保証しません。

GitHubの404・403・レート制限・通信障害、リポジトリの非公開化、ブランチ削除、走査上限到達は「確認エラー」として保留します。正常な取得が最後まで完了し、一致がない場合だけ未達成です。1回のコミット走査は最大2,000件で、それ以上なら未達成にはしません。通常は小さい開発チーム向けの範囲です。

`GEMINI_API_KEY` が設定されている場合は、author・期間が一致するコミット候補が複数あるとき、コミットメッセージの内容が宣言内容と対応するものだけを達成と判定します（無関係な候補しかなければ未達成）。判定理由は結果通知に表示されます。AI呼び出し自体の失敗（HTTPエラー・レスポンス不正など）は未達成にはせず「確認エラー」として保留・再試行します。未設定の場合は従来通り、候補の先頭1件をそのまま採用します。

判定と通知は別々のキューを持ちます。DBの行ロック、期限付きの実行権限、トランザクションで重複実行を防ぎます。実行が途中で止まっても2分後に再取得でき、次回Cronで処理されます。通常のエラーは1分から最大1時間の待ち時間で再試行し、APIが明示するレート制限の待ち時間も反映します。実際の再試行は5分間隔のCronに合わせて行われます。

Discord送信には固定nonceを使用し、再試行時にはBot自身の投稿の記録IDを履歴から照合します。送信後にDB更新が失敗した場合も、見つかった投稿を送信済みとして記録します。過去の通知を手動削除した場合は再送される可能性があります。履歴権限がない場合や1,000件の履歴走査で安全に確認できない場合は、重複投稿を避けるため通知を保留します。この場合は管理者が `notifications.last_error` と対象チャンネルを確認してください。

通知先は通知の予約時に固定します。`/niki setup` で通知先を変えても、予約済み通知は元のチャンネルへ送ります。元のチャンネルを削除した場合は、DBで保留中通知の `channel_id` を修正する必要があります。

`/niki notify` を実行したチャンネルは、自分の宣言・取消・結果通知の**追加の通知先**になります。サーバー既定チャンネルにも従来どおり同じ通知が投稿されるため、チーム全体への公開は保たれます（個人チャンネルが既定と同じ場合は1件のみ）。`/niki notify reset:true` で解除できます。通知先は予約時に固定されるため、変更後に作成される通知から反映されます。実行するチャンネルはサーバーの通常のテキストチャンネルで、Botの投稿権限が必要です。個人チャンネルへの投稿が失敗して再試行中でも、既定チャンネルへの投稿は止まりません。個人チャンネルを削除した場合は、`/niki notify reset:true` で解除するか、DBで保留中通知の `channel_id` を修正してください。この機能には [通知先マイグレーション](../supabase/migrations/202610010001_notify_channel.sql) と [複製投稿マイグレーション](../supabase/migrations/202610020001_notify_channel_mirror.sql) が必要で、**コードのデプロイより先に日付順で適用してください**。`/niki notify` を表示するには `npm run discord:register` でコマンドを再登録します。

1回の定期処理は約40秒・最大10巡（判定と通知を各1件ずつ）です。残りは次の実行へ引き継ぎます。期限ぴったりの通知は保証しません。期限切れのOAuth情報と24時間以上前のinteraction受付記録は定期処理で削除し、利用履歴は保持します。

### 週次サマリー

毎週月曜9:00（JST）に、前週の期限を持つ宣言の確定結果から、チーム・メンバー別の達成率、MVP、サボり王をサーバー既定チャンネルへ投稿します。設定には週次用DB追加とCron登録が必要です。既存の `CRON_SECRET` を共用し、コマンド再登録は不要です。[導入手順・投稿しない試し実行・集計ルール](./weekly-summary.md)を参照してください。

## 8. 検証

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

テストは外部の実アカウントに接続せずに実行できます。GitHub/Discord HTTP境界はモックし、SQLマイグレーション・制約・RPC・処理全体の再試行はPGlite（PostgreSQLをWASMで実行）で検証します。SupabaseのHTTP APIやCron、Vercel、Discord/GitHubの実接続までを自動テストで保証するものではありません。

実環境の受入確認:

1. 3人がGitHub連携し、各自の宣言と取消・状況表示が使える。
2. 対象ブランチへ本人名義のコミットを作る宣言と、コミットを作らない宣言を用意する。
3. 期限後に手動呼び出しをせず、Cronで達成・未達成が保存・投稿される。
4. 同じ定期APIを再度呼び、同じ結果が重複投稿されない。
5. GitHubの取得失敗が未達成にならず、通知権限の一時不足では結果を保持したまま通知だけ再試行される。
6. 別サーバーの `/niki status` に他サーバーのデータが含まれない。

実サービスでの受入確認には、環境変数設定・DB適用・Bot導入・Cron登録が必要です。

`GEMINI_API_KEY`を設定してAI判定を使う場合は、追加で次を確認します。

1. `GEMINI_API_KEY`設定済み・宣言内容と無関係なコミットメッセージ → 未達成になり、結果通知に「AIの判定理由」フィールドが表示される。
2. `GEMINI_API_KEY`設定済み・宣言内容と対応するコミットメッセージ → 達成になる。
3. `GEMINI_API_KEY`を外して同じ手順を実行 → 従来通り、author・期間が一致する最初のコミットで達成判定される（フォールバック確認）。
4. `GEMINI_API_KEY`を無効な値にして呼び出し失敗を起こす → 宣言が`pending`のまま保留・再試行され、`declarations.last_check_error`に`safeError()`経由の文字列（秘密情報を含まない）が記録される。

## 参照したAPI仕様

- [Discord: Interactionの受信と応答](https://docs.discord.com/developers/interactions/receiving-and-responding) — 初期応答は3秒以内、処理はdeferred response後に実行。
- [Discord: Message API](https://docs.discord.com/developers/resources/message) — `enforce_nonce` の重複確認は直近数分に限られるため、履歴照合を併用。
- [GitHub: OAuth Appの認可](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) — state、PKCE、認可後の本人再確認。
- [GitHub: Commit API](https://docs.github.com/en/rest/commits/commits) — ブランチ、期間、ページ指定による公開コミット取得。
- [Supabase: Cron](https://supabase.com/docs/guides/cron/quickstart) — DBから定期HTTP呼び出し。
