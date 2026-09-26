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

作成するテーブル:

- `users`: DiscordとGitHubの対応。1つのGitHub IDは1つのDiscord IDにだけ対応。
- `guild_settings`: サーバーごとの通知先。
- `memberships`: そのサーバーで連携した参加者。
- `declarations`: 宣言と判定結果。宣言時のGitHub ID・ブランチを固定保存。
- `notifications`: 宣言公開・取消・結果の通知予約、送信状態、再試行情報。
- `oauth_sessions`: 10分間有効の一時認可情報。リンクとstateはハッシュで保存。
- `interaction_receipts`: Discordの再送・リプレイに対する受付済みID。

全テーブルでRLSを有効にし、anon/authenticatedからのアクセスとRPC実行を許可していません。アクセスは署名や権限を検証したバックエンドのservice roleに限定しています。

## 3. GitHub OAuth App

GitHub Settings → Developer settings → OAuth Appsでアプリを作成します。

- Homepage URL: `APP_URL`
- Authorization callback URL: `APP_URL/api/github/callback`
- Client IDとClient Secretを環境変数へ設定。
- callbackのワイルドカードは不要。上記のURLと一致させます。

OAuthでは公開プロフィールの本人確認だけを行い、`repo`、`user:email` などの追加scopeは要求しません。PKCEとstate、HttpOnly Cookieの照合を行います。ユーザーのOAuthアクセストークンは `/user` の呼び出し後に保持しません。公開コミット取得には運営側の任意の `GITHUB_API_TOKEN` を使います。

## 4. VercelとDiscord

1. このNext.jsプロジェクトをVercelにデプロイし、`.env.local` と同じサーバー用変数を設定します。`APP_URL` は確定した本番URLにします。GitHub側のcallbackも合わせます。
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
6. 各ユーザーが `/niki github` を実行し、本人だけに表示されるリンクからGitHubを認可します。別のサーバーで使う場合も、そのサーバーでこの操作を行います。

開発用のguildコマンドからglobalコマンドに切り替える際は、重複表示を避けるため開発用コマンドをDiscord側で整理してください。本スクリプトは他の登録を自動削除しません。

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
/niki cancel
/niki status
/niki status page:2
```

- `branch` は省略可能。宣言時点のデフォルトブランチ名を保存します。コミットがまだない空のリポジトリは宣言時に弾きます。
- 期限は日本時間の `YYYY-MM-DD HH:mm`。DBはUTCで保存します。
- 判定待ち・確認エラーを含め、未確定の宣言は1人・1サーバーにつき1件までです。
- 本人が期限前の宣言だけを取り消せます。取消も通知され、集計には含まれません。
- コマンドへの応答は本人だけに表示。宣言・取消・結果の通知は設定したチャンネルに公開します。
- `/niki status` は同じサーバーの宣言・結果・参加者別集計を表示します。各欄5件ずつのページ切替で、集計自体は全履歴を対象にします。確認エラーと投稿待ちも表示します。

## 7. 判定・再試行の仕様

コミットのGitHub `author.id` が宣言時の連携IDと一致し、`commit.committer.date` が **宣言登録時刻以上・期限以下** の場合に達成とします。author名やメールアドレスだけでは本人とみなしません。期限後の確認時点で指定ブランチに存在するコミットを対象にします。push時刻、機能の完成、後でforce pushされた履歴の存在は保証しません。

GitHubの404・403・レート制限・通信障害、リポジトリの非公開化、ブランチ削除、走査上限到達は「確認エラー」として保留します。正常な取得が最後まで完了し、一致がない場合だけ未達成です。1回のコミット走査は最大2,000件で、それ以上なら未達成にはしません。通常は小さい開発チーム向けの範囲です。

判定と通知は別々のキューを持ちます。DBの行ロック、期限付きの実行権限、トランザクションで重複実行を防ぎます。実行が途中で止まっても2分後に再取得でき、次回Cronで処理されます。通常のエラーは1分から最大1時間の待ち時間で再試行し、APIが明示するレート制限の待ち時間も反映します。実際の再試行は5分間隔のCronに合わせて行われます。

Discord送信には固定nonceを使用し、再試行時にはBot自身の投稿の記録IDを履歴から照合します。送信後にDB更新が失敗した場合も、見つかった投稿を送信済みとして記録します。過去の通知を手動削除した場合は再送される可能性があります。履歴権限がない場合や1,000件の履歴走査で安全に確認できない場合は、重複投稿を避けるため通知を保留します。この場合は管理者が `notifications.last_error` と対象チャンネルを確認してください。

通知先は通知の予約時に固定します。`/niki setup` で通知先を変えても、予約済み通知は元のチャンネルへ送ります。元のチャンネルを削除した場合は、DBで保留中通知の `channel_id` を修正する必要があります。

1回の定期処理は約40秒・最大10巡（判定と通知を各1件ずつ）です。残りは次の実行へ引き継ぎます。期限ぴったりの通知は保証しません。期限切れのOAuth情報と24時間以上前のinteraction受付記録は定期処理で削除し、利用履歴は保持します。

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

## 参照したAPI仕様

- [Discord: Interactionの受信と応答](https://docs.discord.com/developers/interactions/receiving-and-responding) — 初期応答は3秒以内、処理はdeferred response後に実行。
- [Discord: Message API](https://docs.discord.com/developers/resources/message) — `enforce_nonce` の重複確認は直近数分に限られるため、履歴照合を併用。
- [GitHub: OAuth Appの認可](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) — state、PKCE、認可後の本人再確認。
- [GitHub: Commit API](https://docs.github.com/en/rest/commits/commits) — ブランチ、期間、ページ指定による公開コミット取得。
- [Supabase: Cron](https://supabase.com/docs/guides/cron/quickstart) — DBから定期HTTP呼び出し。
