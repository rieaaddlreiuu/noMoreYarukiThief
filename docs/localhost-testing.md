# localhostでのテスト方法

このプロジェクトをローカル環境（localhost）で動かし、テストするための手順です。詳細な環境構築は [setup.md](./setup.md) を参照してください。ここではローカルテストに絞って説明します。

## 1. 自動テスト（外部サービス不要）

Discord/GitHub/Supabaseの実アカウントを用意しなくても、以下は手元で完結します。

```powershell
npm install
npm test          # vitest。GitHub/Discord HTTP境界はモック、DBはPGlite(WASM)で検証
npm run lint
npm run typecheck
npm run build
```

ロジックやDBマイグレーションの検証だけならこれで十分です。実際にDiscord上で動かして確認したい場合は次の手順に進みます。

## 2. 開発サーバーの起動

```powershell
Copy-Item .env.example .env.local
```

`.env.local` に必要な値を設定します（各値の意味は [setup.md](./setup.md#1-ローカルの準備) 参照）。ローカルのみ `APP_URL=http://localhost:3000` が使用可能です。

```powershell
npm run dev
```

`http://localhost:3000` でアプリが起動します。トップページはDiscord操作案内のみで、宣言・取消・状況表示などの機能はDiscordのスラッシュコマンド経由でのみ動作します。

## 3. Discordコマンドをlocalhostで受信するには（公開URLが必要）

Discordの **Interactions Endpoint URL** はDiscord側のサーバーからHTTPSで到達できる必要があるため、`http://localhost:3000` を直接登録することはできません。ローカルの開発サーバーをDiscordから叩けるようにするには、トンネルツールで一時的な公開HTTPS URLを作成し、それを`APP_URL`として使います。

例: [ngrok](https://ngrok.com/) を使う場合

### ngrokの登録・導入

1. [ngrok公式サイト](https://ngrok.com/) にアクセスし、アカウントを作成します（GitHub/Googleアカウントでのサインアップも可能）。
2. サインアップ後のダッシュボードの [Setup & Installation](https://dashboard.ngrok.com/get-started/setup) ページから、OS向けのインストール方法が案内されます。Windowsの場合はインストーラー、またはパッケージマネージャーで導入できます。

   ```powershell
   choco install ngrok
   ```

   または公式サイトからバイナリをダウンロードして展開しても構いません。
3. ダッシュボードの [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) ページに表示される認証トークンを、以下のコマンドでローカルに登録します（初回のみ）。

   ```powershell
   ngrok config add-authtoken <あなたのAuthtoken>
   ```

4. 登録が完了すると、ローカルの3000番ポートを公開できるようになります。

Linux（Ubuntu/WSL等）でsnapが使える場合は以下でも導入できます。

```bash
sudo snap install ngrok
ngrok config add-authtoken <あなたのAuthtoken>
```

```powershell
ngrok http 3000
```

無料アカウントで初めて起動すると、アカウントに固定ドメインがまだ割り当てられておらず `ERR_NGROK_15013`（"Your account is requesting a dev domain that does not exist"）になることがあります。その場合はダッシュボードの [Domains](https://dashboard.ngrok.com/domains) ページで無料の静的ドメイン（`xxxx.ngrok-free.app` や `xxxx.ngrok-free.dev`）を1つ作成し、そのドメインを指定して起動します。

```bash
ngrok http --url=xxxx.ngrok-free.dev 3000
```

ダッシュボードの「New Endpoint」ウィザードでドメインを作成する場合は、以下を選びます。

- **What do you want this endpoint to do?** → 「Forward to a service running on a machine」（ローカルの3000番ポートに転送するため）
- **Availability** → **Public**（Discord/GitHubからの到達に必要。Internalだと外部から届かない）
- **Pooling** → オフ（デフォルトのまま。同一URLに複数エージェントを束ねる機能で、今回は1プロセスしか立てないため不要）
- **How should we handle traffic?** → 「No Traffic Policy」（BASIC認証やGoogleログインを要求すると、DiscordのWebhookやGitHubのOAuthコールバックが認証で弾かれてしまうため）

発行された `https://xxxx.ngrok-free.dev` を一時的に `.env.local` の `APP_URL` に設定し、Discord Developer PortalのInteractions Endpoint URLに `https://xxxx.ngrok-free.dev/api/discord/interactions` を設定します。GitHub OAuth AppのAuthorization callback URLも同様に合わせます（`https://xxxx.ngrok-free.dev/api/github/callback`）。

トンネルURLは起動のたびに変わるため、都度Discord/GitHub側の設定を更新するか、固定サブドメインが使えるプランを利用してください。

### ngrokの仕組みとセキュリティーリスク

ngrokは、ローカルPCで動くサーバーとngrokのクラウドの間に常時接続のトンネルを張り、外部からの公開URL宛リクエストをそのトンネル経由でPCに転送する仕組みです。PC側から外向きに接続を開始するため、ルーターのポート開放は不要ですが、その分以下のリスクがあります。

- **ローカルサーバーがそのままインターネットに露出する**: `localhost:3000` で動いているものはURLを知る第三者から到達可能になります。同じPC上の他の開発サーバーを誤って公開しないよう注意してください。
- **URLを知っていれば誰でもアクセスできる**: 無料プランのランダムURLは推測されにくいものの非公開情報ではありません。「No Traffic Policy」（認証なし）で運用する場合、URLが漏れると誰でも到達できます。
- **本番相当のシークレットを公開状態のサーバーで扱うことになる**: `.env.local` にDiscord Bot Token、GitHub OAuth Secret、Supabaseのservice role keyなど強い権限を持つ値を置いた状態で外部公開することになるため、漏洩時の被害が大きくなります。開発用のDiscordアプリ・GitHub OAuth App・Supabaseプロジェクトを本番とは別に用意することを推奨します。
- **`CRON_SECRET`のような認証必須API以外も存在自体は露出する**: `/api/jobs/evaluate` はBearer認証で保護されていますが、エンドポイントの存在自体は隠せません。
- **セッションを止め忘れると公開され続ける**: 使い終わったら `Ctrl+C` 等でngrokプロセスを停止し、公開状態を終了させてください。`.env.local`やngrokのURLをスクリーンショット・チャット・公開リポジトリなどに残さないことも重要です。

### 公開せずにlocalhostだけでテストできる範囲

すべての確認にトンネルが必要なわけではありません。

- **自動テスト・画面起動確認**（本ドキュメント1章・2章）は公開不要です。
- **GitHub OAuthの連携フロー**は、GitHub側からサーバー宛に直接リクエストが来るわけではなく、「ユーザー自身のブラウザがリダイレクトされる」仕組みです。そのためGitHub OAuth AppのCallback URLに `http://localhost:3000/api/github/callback` を登録すれば、**ngrokなしでOAuth連携まで最後まで確認できます**（GitHubはlocalhostのcallback URL登録を公式にサポートしています）。
- **Discordのスラッシュコマンド**だけは、Discordのサーバーが `Interactions Endpoint URL` へ直接HTTP POSTしてくるサーバー間通信のため、ユーザーのブラウザを経由せず、localhostには物理的に到達できません。ngrok等で外部到達可能なURLを用意する以外に方法がなく、代替としてはコマンドハンドラーのロジックをvitestで直接importして呼び出す（署名検証を経ないユニットテスト）方法があります。

### 代替案: Vercelに開発/テスト用デプロイを作る

PCを直接インターネットに晒したくない場合は、Vercel上に**本番とは別の開発用プロジェクト**を作り、そちらをDiscord/GitHubの接続先にする方法もあります。ngrokと比べたメリット・注意点は以下の通りです。

**メリット**

- URLが安定し、明示的に作成・削除できるため「今公開されているか」が管理しやすい（ngrokは停止し忘れると公開され続ける）
- 自分のPCそのものを外部到達可能にしないため、PC上の他ポート・他プロセスが誤って露出するリスクがない
- Deployment Protection（Vercel Authentication、パスワード保護、許可リスト等）で柔軟にアクセス制御できる
- 環境変数（シークレット）をVercel側で管理でき、ローカルPCの紛失・マルウェア等による漏洩経路を減らせる

**注意点**

- 開発用のVercelプロジェクトと、開発専用のDiscord Bot・GitHub OAuth App・Supabaseプロジェクトを用意し、本番のシークレットと混同しないこと
- Deployment Protectionを有効にしないと、ngrokの「No Traffic Policy」と同程度の露出状態になる点は変わらない
- Deployment ProtectionをONにする場合、`/api/discord/interactions` 等Discord/GitHubから直接叩かれるパスがブロックされないよう、パス単位の除外設定が必要

一時的な動作確認であれば「開発用Vercelプロジェクト + 開発用Discord/GitHub/Supabase」の組み合わせの方が、PCを直接晒すngrokよりセキュリティー上は無難です。デプロイ手順自体は [setup.md 4章](./setup.md#4-vercelとdiscord) と同じ流れで、本番用ではなく開発/テスト用の一式を別途作成してください。

コマンド登録:

```powershell
npm run discord:register
```

Botをサーバーに追加し `/niki setup channel:#開発記録` → `/niki github` → `/niki declare ...` の流れで動作確認できます（詳細は [setup.md 6章](./setup.md#6-discordで使う) 参照）。

## 4. Supabase（DB）

このプロジェクトはSupabaseのローカルCLIには対応しておらず、ホスト型のSupabaseプロジェクトを使う前提です。ローカルテスト用に開発用のSupabaseプロジェクトを別途作成し、[初期マイグレーション](../supabase/migrations/202609260001_mvp.sql) をSQL Editorで実行してから `.env.local` の `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` に設定してください。

自動テスト（`npm test`）はPGlite（WASM上のPostgreSQL）でDBロジックを検証するため、Supabaseプロジェクトなしでも実行できます。

## 5. 定期実行API（Cron）の手動確認

Supabase Cronを使わず、ローカルから手動で判定APIを叩いて確認できます。

```powershell
node --env-file=.env.local --input-type=module -e "const r = await fetch(process.env.APP_URL + '/api/jobs/evaluate', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } }); console.log(r.status, await r.text());"
```

## まとめ

| 確認したいこと | 必要なもの |
| --- | --- |
| ロジック・DB制約の検証 | `npm test` のみ（外部サービス不要） |
| 型・Lint・ビルド | `npm run typecheck` / `npm run lint` / `npm run build` |
| 画面の起動確認 | `npm run dev` → `http://localhost:3000` |
| Discordコマンドの実動作確認 | `npm run dev` + トンネル（ngrok等）+ Discord/GitHub OAuth設定 + Supabaseプロジェクト |
