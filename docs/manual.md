# アプリ仕様書：開発ニキ（開発促進Discord Bot）

このドキュメントは、本リポジトリのアプリケーション「開発ニキ」の**全仕様**を1か所にまとめたものです。詳細な導入手順は[setup.md](./setup.md)、仕組みの解説は[architecture.md](./architecture.md)、未実装の拡張案は[extension.md](./extension.md)を参照してください。本書はそれらの内容を仕様という切り口で再構成した要約兼リファレンスです。

## 1. アプリ概要

開発が続かない学生エンジニア向けに、**開発の宣言・GitHubでの活動確認・Discordでの声かけ**を行うBotです。

> 宣言する → 仲間に見える → GitHubで自動確認 → ニキが称える／煽る

操作はDiscord内で完結し、GitHub連携時のみブラウザを使用します。独立したWebアプリ画面は原則作りません。

### 利用の流れ

```text
管理者がBotをサーバーに追加
    ↓
通知先チャンネルを設定（/niki setup）
    ↓
各ユーザーがGitHubアカウントを連携（/niki github）
    ↓
「何を・どのリポジトリで・いつまでに」を宣言（/niki declare）
    ↓
Botが宣言をチャンネルに公開
    ↓
期限後、GitHubのコミットを自動確認
    ↓
達成／未達成の結果を保存し、ニキが投稿
    ↓
コマンドからチームの状況を確認（/niki status）
```

## 2. MVPの前提・スコープ

| 項目 | 扱い |
| --- | --- |
| チーム | 1 Discordサーバー＝1チーム |
| 参加者 | GitHub連携を行い、利用を開始した人。サーバー全員は自動登録しない |
| 対象リポジトリ | 公開リポジトリのみ |
| 対象ブランチ | 宣言時に1本指定。未指定ならデフォルトブランチ |
| 宣言数 | 1人・1サーバーにつき、進行中は1件まで |
| 時刻 | 入力・表示は日本時間（JST）。DBにはUTCで保存 |
| ニキの投稿 | 固定テンプレート。LLMは使わない |
| 自動判定の対象 | 宣言内容の完成ではなく、条件を満たすコミットの有無 |

### MVPに含めないもの

| 対象外・後回し | 内容 |
| --- | --- |
| 独立したWeb UI | Webダッシュボード、ログイン画面、独自のチーム作成・招待画面 |
| 高度なGitHub対応 | 非公開リポジトリ、複数ブランチ横断、宣言内容の完成判定 |
| AI・演出の拡張 | LLMによる文章生成、煽り強度の選択 |
| 継続支援の拡張 | 宣言前リマインド、週次サマリー |
| その他 | スマホアプリ、GitHub以外のGitサービス、ポイント・報酬設計 |

これらは[extension.md](./extension.md)に拡張案（AI判定・共著者パース・あおりメッセージAI生成・定期レポート・個人通知チャンネル）として設計メモがあり、いずれも未実装です。

## 3. コマンド仕様（`/niki`）

すべて`/niki <サブコマンド>`の形式。定義は[commands.ts](../src/lib/discord/commands.ts)。

| サブコマンド | 説明 | 引数 |
| --- | --- | --- |
| `setup` | 通知先チャンネルを設定（サーバー管理権限が必要） | `channel`（必須・テキストチャンネル） |
| `weekly` | 週次サマリーの投稿曜日・時刻・停止を設定（サーバー管理権限が必要。省略時は現在の設定を表示） | `day`（月〜日）、`hour`（0〜23）、`enabled`（任意） |
| `github` | 自分のGitHubアカウントをこのサーバーで連携する | なし（本人だけに見える認可リンクを返信） |
| `declare` | 開発内容と期限を宣言する | `content`（必須・1〜500文字）、`repository`（必須・`owner/repository`形式・最大140文字）、`deadline`（必須・`YYYY-MM-DD HH:MM`形式のJST日時・16文字固定）、`branch`（任意・最大255文字、省略時はデフォルトブランチ） |
| `cancel` | 自分の期限前の宣言を取り消す | なし |
| `status` | チームの宣言・結果・達成率・連続達成日数を見る | `page`（任意・1〜1,000,000） |

### 宣言の入力例

```text
内容：ログイン画面を実装する
リポジトリ：owner/repository
ブランチ：feature/login
期限：2026-09-28 22:00
```

通知では宣言者をメンションし、内容・対象（リポジトリ／ブランチ）・期限を表示します。宣言入力にはスラッシュコマンドの引数を使用し、独自のログイン画面・チーム招待画面・Webhook URL登録画面は作りません。

### 自動処理

| 処理 | 内容 |
| --- | --- |
| 期限判定 | 5〜10分おきに、期限を過ぎた未判定の宣言を取得しGitHubを確認する |
| 結果通知 | 達成なら称賛、未達成なら煽りのテンプレートをDiscordに投稿する |

## 4. 達成判定の仕様

### 達成条件

以下をすべて満たすコミットが、期限後の確認で1件以上取得できたら達成。

- 指定リポジトリ・指定ブランチに存在する。
- 連携したGitHubユーザーが`author`として紐付いている（`author.id`で本人確認）。
- コミット日時（`commit.committer.date`に統一）が、宣言登録時刻から期限までの範囲内にある（両端を含む）。

コミット日時を使う簡易判定であり、期限内にpushされたことの厳密な保証や、宣言した機能の完成確認は行いません。判定ロジックの実体は[github.ts](../src/lib/github.ts)の`matchesDeclaration`／`findQualifyingCommit`です。

### 判定状態

| 状況 | 扱い |
| --- | --- |
| 期限前 | 進行中 |
| 対象コミットがある | 達成 |
| 正常に確認でき、対象コミットがない | 未達成 |
| GitHub APIの障害・権限不足など | 確認待ち／確認エラーとして再試行 |
| 本人が取消済み | 判定対象外 |

APIエラーは未達成扱いにしません。結果の判定とDiscord通知の送信状態は別管理で、通知に失敗した場合は通知だけを再試行します。期限ぴったりの通知は保証されず、期限後の定期処理（Cron）でまとめて通知されます。

### 集計ルール

- **達成率** ＝ 達成件数 ÷（達成・未達成が確定した件数）。進行中・取消・確認エラーは分母に含めない。
- **連続達成日数** ＝ 期限の日本時間の日付を基準に、1件以上達成した日が連続した日数。同日複数達成は1日分。達成のない日で途切れる。当日未達成の場合は前日までの記録を表示する。

## 5. 通知メッセージ仕様

通知は[messages.ts](../src/lib/discord/messages.ts)の`notificationMessage`で組み立てられ、固定テンプレートです（LLM不使用）。

| 種別（`kind`） | タイトル | 本文の例 |
| --- | --- | --- |
| `declared`（宣言時） | 開発の宣言 | 「宣言、受け取ったで。コミット待ってるぞ。」 |
| `cancelled`（取消時） | 宣言を取消 | 「この宣言は取り消し。判定と集計の対象から外したで。」 |
| `result`・達成 | 達成 | 「有言実行やな！ ちゃんと手を動かしたの、ニキは見てたで。」 |
| `result`・未達成 | 未達成 | 「宣言は立派やったな！ 今回は条件に合うコミットを見つけられんかったで。」 |

宣言者にメンション付きで通知し、埋め込み（embed）に「対象」「期限」、達成時は確認したコミットへのリンクを表示します。表示文字列はすべて`discordText()`でエスケープし、Markdown記法・メンションのインジェクションを防ぎます。

`/niki status`の応答（`statusMessage`）は、進行中・確認待ちの宣言／最近の結果／メンバー別の達成率・連続達成日数の3ブロックをページング表示します（1ページ5件）。省略時は自分の分、`member`で他のメンバー、`all:true`でサーバー全体を表示します。

## 6. 技術スタック

| 分野 | 採用 | 役割 |
| --- | --- | --- |
| 言語 | TypeScript | 全体の実装 |
| バックエンド | Next.js 16 / Route Handlers（App Router） | Discord受付、GitHub連携、宣言管理、判定API |
| ホスティング | Vercel | Next.jsのデプロイ（サーバーレス） |
| DB | Supabase PostgreSQL | ユーザー・設定・宣言・結果の保存 |
| DBアクセス | `@supabase/supabase-js` | バックエンドからのデータ操作（service role限定） |
| 定期実行 | Supabase Cron（`pg_cron` + `pg_net`） | 5〜10分おきに判定APIを呼ぶ |
| Discord連携 | HTTP Interactions（Webhook方式）+ Discord REST API | コマンド受付・投稿。Gateway（常時接続）方式は不採用 |
| Discord署名検証 | `discord-interactions` | 受信リクエストのEd25519検証 |
| GitHub本人確認 | GitHub OAuth App（PKCE付きAuthorization Code Flow） | Discord IDとGitHub IDの紐付け |
| GitHubデータ取得 | GitHub REST API / `@octokit/rest` | リポジトリ・コミットの取得 |
| 入力検証 | Zod | 宣言・コマンド・設定の入力チェック |

### 全体構成図

```text
Discord ── ①コマンド ──▶ Vercel（Next.js）
                              ├─ Supabase（DB＋Cron）
                              ├─ GitHub OAuth（本人確認）
                              ├─ GitHub API（コミット確認）
                              └─ Discord API（返信・通知）
Supabase Cron ── ⑤5分おき POST /api/jobs/evaluate ──▶ Vercel（上記④に戻る）
```

このアプリがハブとなり、Discord・GitHub・Supabaseは互いに直接通信しません。

## 7. APIエンドポイント一覧

| エンドポイント | メソッド | 役割 |
| --- | --- | --- |
| `/api/discord/interactions` | POST | Discordスラッシュコマンドの受付（署名検証→2段階応答→`lib/discord/handler.ts`） |
| `/api/github/start` | GET/POST | GitHub連携リンクを開いた時。ticket検証→GitHub認可ページへリダイレクト |
| `/api/github/callback` | GET | GitHub認可後のリダイレクト先。code⇔token交換→本人確認→DB保存 |
| `/api/jobs/evaluate` | POST | Cronから呼ばれる判定バッチ（Bearer `CRON_SECRET`認証） |

Discordの3秒応答ルールに対応するため、`/api/discord/interactions`はdeferred応答（type 5）を即返し、`after()`でバックグラウンド処理後に`editReply`で内容を確定します。

## 8. データモデル

主なテーブル（定義: [supabase/migrations/202609260001_mvp.sql](../supabase/migrations/202609260001_mvp.sql)）。

| テーブル | 役割 |
| --- | --- |
| `users` | DiscordユーザーID ⇔ GitHubユーザーIDの対応（1 GitHub IDにつき1 Discord IDのみ） |
| `guild_settings` | Discordサーバー（guild）ごとの通知先チャンネル |
| `memberships` | サーバーごとの参加状態（GitHub連携済みメンバー） |
| `declarations` | 宣言者、サーバー、内容、リポジトリ、ブランチ、登録時刻、期限、判定状態、検出コミットSHA、確認日時、通知状態 |
| `notifications` | 宣言公開・取消・結果通知の送信予約、送信状態、再試行情報 |
| `oauth_sessions` | GitHub OAuth連携用の一時情報（10分間有効・ハッシュ保存） |
| `interaction_receipts` | Discordコマンドの再送に対する二重処理防止用の受付記録 |

### アクセス制御

全テーブルでRow Level Security（RLS）を有効化し、許可ポリシーは作成しません（＝デフォルト全拒否）。`anon`・`authenticated`ロールへの権限は明示的に剥奪し、`service_role`（バックエンド専用）にのみ権限を付与します。ブラウザ側のanon keyはこのプロジェクトでは一切使用しません。複雑な更新は`niki_`プレフィックスのPostgreSQL関数（RPC、例: `niki_create_declaration`）としてDB側に定義し、トランザクションで競合を防ぎます。

権限方針：初期設定（`/niki setup`）は管理権限のある人だけ、宣言の取消（`/niki cancel`）は本人だけが実行できます。秘密情報はすべてバックエンド（サーバー側）で管理し、サーバーをまたぐデータの閲覧・変更は行いません。

## 9. セキュリティ仕様

| 対象 | 仕組み |
| --- | --- |
| Discordリクエストのなりすまし対策 | `X-Signature-Ed25519` / `X-Signature-Timestamp`ヘッダーを`DISCORD_PUBLIC_KEY`で検証。不一致は401 |
| Discordリクエストのサイズ制限 | 64KB超は拒否 |
| Discordへの発信認証 | `DISCORD_BOT_TOKEN`（`Bot <トークン>`）。厳重に秘匿 |
| GitHub連携の1回限りリンク | `/niki github`発行の`ticket`（10分間有効・1回限り） |
| OAuthのCSRF対策 | `state`パラメータでcallbackの対応関係を確認 |
| OAuthの認可コード横取り対策 | PKCE（`code_challenge`/`code_verifier`） |
| OAuthのブラウザ同一性確認 | HttpOnly Cookie（`browser`） |
| Cronリクエストのなりすまし対策 | `Authorization: Bearer <CRON_SECRET>`（Supabase Vaultと環境変数で共有） |
| ログ・エラー出力の秘密情報保護 | `security.ts`の`safeError()`で加工してからログ・DBに記録 |

GitHub OAuthはユーザーの個人情報・秘密情報を保存しません。取得したアクセストークンは本人確認（`/user`呼び出し）に一度使うだけでDBには保存せず破棄します。コミット取得には運営側の共有トークン`GITHUB_API_TOKEN`（任意設定・レート制限緩和用）を使います。

## 10. 定期実行（Cron）と重複対策

- Supabase `pg_cron`が5〜10分おきに`POST /api/jobs/evaluate`を叩き、期限を過ぎた未判定の宣言だけをGitHub Commit APIで確認します。
- 二重実行・重複通知への対策として、DBの行ロックと「実行権限（lease）」による排他制御を行い、実行が途中で止まっても2分後には他のCron実行が引き継げます。
- Discord投稿時は固定nonceを使い、再試行時は過去の自分の投稿をDiscord履歴から照合してから送ることで二重投稿を防ぎます。

## 11. 完成条件（MVP）

最初に完成させるのは「宣言 → 保存 → GitHub確認 → 結果投稿」の一周。その後に状況表示・集計・例外処理を仕上げます。MVP完成は以下を満たす状態です。

- 3人が自分のGitHubアカウントを連携し、Discordから宣言・取消・状況確認を行える。
- 手動操作なしで期限後の判定と結果投稿が実行される。
- 達成・未達成の両方を再現でき、API障害を未達成にせず、定期処理の重複で同じ結果を繰り返し投稿しない。
- 自分たちの利用履歴が保存され、発表で実際の宣言・コミット・通知・集計を示せる。

このMVPが扱うのは「宣言した後の行動促進」までです。宣言自体をしない人への働きかけ（宣言前リマインドなど）は、拡張案（[extension.md](./extension.md)）で扱います。

## 12. 関連ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [setup.md](./setup.md) | 環境変数、Discord Bot／GitHub OAuth App／Supabaseの設定手順、デプロイ手順 |
| [architecture.md](./architecture.md) | 各外部サービスとの通信の仕組み、コード構成、Route Handlerの書き方の教科書的解説 |
| [localhost-testing.md](./localhost-testing.md) | ローカル環境での動作検証方法 |
| [extension.md](./extension.md) | 未実装の拡張案（AI判定、共著者パース、あおりメッセージAI生成、定期レポート、個人通知チャンネル） |
