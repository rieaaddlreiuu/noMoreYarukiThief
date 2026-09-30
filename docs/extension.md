# 拡張案（AI判定・共著者パース・あおりメッセージ・定期レポート）

このドキュメントは、実装済みの機能に対する4つの拡張案の**仕様と実装方針の叩き台**です。実装済みコードではなく、設計段階のメモとして書いています。実装に入る前に、各案の「検討事項」に挙げたトレードオフについて合意を取ることを推奨します。

全案に共通する設計方針は次の通りです（既存コードの流儀を踏襲）。

- 新しい外部API（Gemini等）は`GITHUB_API_TOKEN`と同じ「**任意強化**」パターンにする。対応する環境変数が未設定なら、機能自体をスキップし、既存の挙動にフォールバックする。既存環境を一切壊さない。
- 外部APIの失敗は、判定の正しさに関わる処理（1・2）では「未達成」に倒さず「確認エラー」として再試行する。装飾的な処理（3・4）では、失敗しても本来の通知・処理は止めず、固定文言や省略にフォールバックする。
- 外部API・AIの出力は`zod`で構造化検証してから使う。自由文をそのまま信用しない。
- Discordに表示する文字列は[domain.ts](src/lib/domain.ts)の`discordText()`で必ずエスケープする（Markdown記法やメンションのインジェクション対策）。
- エラーは[security.ts](src/lib/security.ts)の`safeError()`を通してからログ・DBに記録する（秘密情報の漏洩防止）。

---

## 1. コミットの中身をAIが読んで、宣言を達成したか判断する

> **ステータス: 実装済み** — 以下の仕様・処理フローに沿って実装しました。「実装方針」の表に実際の変更ファイルへのリンクを反映済みです。当初はコミットメッセージのみを判定材料にしていましたが、メッセージだけ宣言に合わせたコミット（空コミットや無関係な変更）を見抜けないため、変更差分も読むように拡張しました。

### 課題

現在の[matchesDeclaration](src/lib/github.ts#L42-L47)は「本人のコミットが期限内に存在するか」だけを見ており、コミット内容が宣言（`declarations.content`）と関係あるかは判定していません。

### 仕様

- 判定材料は**コミットメッセージと変更差分**。差分は1件ごとにGitHub APIの呼び出しが必要なため、**新しい順に最大10件**（マージコミットを除く）だけ取得し、残りの候補はメッセージのみで判定する
- マージコミットは親（first parent）との差分に他人の変更が混ざりうるため、差分を取得せずメッセージのみで判定する
- 差分は1ファイル2,000文字・1コミット8,000文字・全体40,000文字で打ち切り、ロックファイル・minifyされたファイル・sourcemapは差分を省略する（ファイル名と増減行数は渡す）。判定がチェック1件あたりの20秒の時間枠に収まるようにするため
- AIのAPIキー（`GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）のいずれかが設定されている場合だけAI判定を有効化。未設定なら現状通り「author+期間一致の最初の1件」を採用する
- プロバイダーはGemini・OpenAI（ChatGPT）・Anthropic（Claude）から選べる。`AI_PROVIDER`で明示でき、未設定ならキーのあるものをGemini → OpenAI → Anthropicの順で使う（既存のGemini利用環境の挙動を変えないため）。`AI_MODEL`で既定モデルを上書きできる
- AI呼び出しはコミット候補ごとではなく、**候補一覧をまとめて1回**で判定する（Cronの40秒バジェットに収まりやすくするため）

### 処理フロー

```
① 対象ブランチのコミット履歴を、宣言登録時刻〜期限の範囲で全ページ取得（既存のまま、最大2,000件）
② author id が一致するコミットを候補として全件集める（現状は最初の1件で打ち切っている部分を変更）
③ AIのAPIキー未設定 → 候補先頭のshaを返す（現状と同じ挙動）
④ AIのAPIキー設定済み・候補あり →
   マージコミット以外の新しい候補から最大10件、GET /repos/{owner}/{repo}/commits/{sha} で変更ファイルと差分を並列取得
   （取得失敗は「確認エラー」として再試行。少ない材料で判定しない）
   候補の (sha短縮形, message, 差分) 一覧と宣言内容(content)をJSONにまとめて選択中のAIに送り、
   「一致した候補のindex（またはnull）＋簡潔な理由」を構造化JSON(responseSchema)で受け取る
   → indexが候補配列の範囲内かを検証してから採用する（LLM出力を無条件に信用しない）
   → 一致なしと判定されたら「未達成」に倒す
```

### 実装方針

| 変更対象 | 内容 |
| --- | --- |
| 新規 [ai/index.ts](src/lib/ai/index.ts) | `judgeCommits(content, candidates, signal)` と、使うプロバイダーを決める`aiProvider()`を実装。判定データは`judgeInput()`でJSON化し（差分の文字数上限・生成ファイル省略もここで行う）、システム指示とは分けて送る。レスポンスは`z.object({ matchedIndex: z.number().int().nullable(), reason: z.string() })`で検証し、`reason`は200文字に切り詰め、範囲外indexは`null`扱いにする。システム指示・判定データ・結果の検証は全プロバイダー共通 |
| 新規 [ai/gemini.ts](src/lib/ai/gemini.ts)・[ai/openai.ts](src/lib/ai/openai.ts)・[ai/anthropic.ts](src/lib/ai/anthropic.ts) | 各社APIの呼び出し。Geminiは[client.ts](src/lib/discord/client.ts)と同様SDKを追加せず`fetch`でREST APIを叩く。OpenAIは公式SDK（`openai`）のResponses APIで`text.format`（strictなJSON Schema）・`store: false`・`reasoning.effort: "low"`を指定。Anthropicは公式SDK（`@anthropic-ai/sdk`）で`output_config.format`（JSON Schema）・`effort: "low"`・`fallbacks: "default"`（ベータ`server-side-fallback-2026-07-01`）を指定。拒否・打ち切り・未完了の応答は判定結果として扱わず例外にする。SDKの自動リトライは切り、再試行はジョブキューに任せる |
| [github.ts](src/lib/github.ts) | `CommitCandidate`に`commit.message`と`parents`を追加。`findQualifyingCommit`を「全候補収集→分岐」に変更し、戻り値を`{ sha: string; aiReason?: string } \| null`に変更。ページ走査未完了チェックはAI判定より先に行う。AI判定前に、マージ以外の新しい候補最大10件の差分を`repos.getCommit`で取得する |
| 新規 [202609300001_ai_judgement.sql](supabase/migrations/202609300001_ai_judgement.sql) | `declarations`に`ai_reason text`（nullable、500文字以内のcheck制約）列を追加。`niki_finish_check(uuid,uuid,text)`を`drop function`し、`p_ai_reason`引数を追加した新シグネチャで再作成。新シグネチャに対して`revoke`/`grant`（`service_role`のみ許可）をやり直す |
| [store.ts](src/lib/store.ts) | `finishCheck(row, sha, aiReason?)`に対応 |
| [jobs.ts](src/lib/jobs.ts) | `checkOne`の呼び出しを新しい戻り値の形に合わせて更新。AI呼び出しの例外は既存の`retryCheck`経路にそのまま乗る（未達成にしない） |
| [messages.ts](src/lib/discord/messages.ts) | `notificationMessage()`の`result`かつ未達成のケースで、`d.ai_reason`があれば「AIの判定理由」フィールドを追加表示（`discordText()`でエスケープ） |
| `.env.example` / [docs/setup.md](docs/setup.md) | `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `AI_PROVIDER` / `AI_MODEL`（いずれも任意）を追記。未設定時は従来通りと明記。マイグレーション適用順序（コードデプロイより先に適用）も明記 |
| [tests/ai.test.ts](tests/ai.test.ts)・[tests/github.test.ts](tests/github.test.ts)・[tests/database.test.ts](tests/database.test.ts)・[tests/domain.test.ts](tests/domain.test.ts) | 正常系・HTTPエラー・スキーマ不正・APIキー未設定・PGliteでの新マイグレーション適用と権限・Discord表示のエスケープを検証 |

### 検討事項

- **プロンプトインジェクション**: `content`（宣言者入力）も`commit.message`・差分（コミット作者入力。コード中のコメントも含む）も信頼できない外部入力。データはJSON文字列としてシステム指示と分けて渡し、メッセージや差分の中身で候補の区切りを偽装できないようにしている。システム指示でデータ中の指示文に従わないよう明示し、構造化出力を強制する。`reason`はDiscord表示前に必ずエスケープする（対応済み）。ただし宣言者本人が自分の宣言を「達成」に見せかける改ざん（差分にそれらしいコードを足す等）は、自己申告型のツールである以上完全には防げない
- **候補が多い宣言**: コミット数が多いと、まとめて渡すプロンプトが長くなる。差分は上記の上限で抑えているが、メッセージのみの候補数の上限（例: 先頭50件など）は**未実装**。運用で問題が出た場合に追加検討する
- **GitHub APIの消費**: 差分取得で1判定あたり最大10リクエスト増える。`GITHUB_API_TOKEN`未設定（未認証60回/時）では数件の判定でレート制限に達しうるため、AI判定を使う場合はトークンの設定を推奨する
- **レイテンシ**: 差分を含めるとプロンプトが数万文字になり、AIの応答時間が伸びる。チェック1件の時間枠（20秒）を超えると確認エラーとして再試行されるため、頻発する場合は差分の文字数上限か取得件数を下げる
- **判定基準のブレ**: 「宣言内容に向けた作業か」の粒度をAIがどう解釈するかは実行のたびに揺れうる。厳密な採点基準ではなく「明らかに無関係な変更でなければ許容する」程度の緩い基準をシステムプロンプトで指示している（差分が空・形だけの場合は達成の根拠にしない）

---

## 2. squashしたときのコミットメッセージのCo-authored-byをパースして作者集合に加える

> **ステータス: 中止（保留）** — 検討の結果、この拡張はひとまず実装しないことになりました。以下は設計メモとして残していますが、着手の予定はありません。再検討する場合は「検討事項」のなりすましリスクへの対応方針から詰め直してください。

### 課題

チーム開発でPRを**Squash and merge**すると、GitHubは複数コミットを1つに統合します。統合後のコミットの`author`（構造化フィールド）には基本的に1人分の情報しか入らず、実際に貢献した他のメンバー（`Co-authored-by:`としてコミットメッセージに記載される）は、今の`matchesDeclaration`（`commit.author.id`のみを見る）では**達成カウントされません**。

### 仕様

- コミットメッセージ内の`Co-authored-by: Name <email>`行をパースし、GitHubのユーザーIDを抽出できたものを「そのコミットの共著者ID集合」に加える
- 宣言のauthor判定を「`commit.author.id === declaration.github_id`」から「`declaration.github_id ∈ (author.id ∪ 共著者ID集合)`」に拡張する

### GitHubのnoreplyメールアドレス形式を使ったID抽出

GitHub Web UIの「Add co-author」機能で追加された共著者は、通常`<id>+<login>@users.noreply.github.com`という形式のメールアドレスで記録されます。この形式には**GitHubのユーザーIDが直接埋め込まれている**ため、追加のAPI呼び出しなしでIDを取得できます。

```ts
// src/lib/co-authors.ts（新規）
const coAuthorPattern = /^co-authored-by:.*<(\d+)\+[^@]+@users\.noreply\.github\.com>$/gim;

export function parseCoAuthorIds(message: string): number[] {
  return [...message.matchAll(coAuthorPattern)].map((match) => Number(match[1]));
}
```

`git commit`をコマンドラインで手打ちし、カスタムのメールアドレスで`Co-authored-by:`を書いた場合はこの形式に合致せず拾えません。それを拾うには、連携時にGitHubのメールアドレスをDBへ保存し（要OAuthスコープ拡張、下記「検討事項」参照）、そのメールと突き合わせる仕組みが追加で必要になります。MVPとしてはnoreply形式のみサポートするのが現実的です。

### 実装方針

| 変更対象 | 内容 |
| --- | --- |
| 新規 `src/lib/co-authors.ts` | `parseCoAuthorIds(message: string): number[]` |
| [github.ts](src/lib/github.ts) | `matchesDeclaration`（および1番のAI判定で使う候補収集ロジック）の author 一致判定に、`parseCoAuthorIds(commit.commit.message)`の結果を`includes`で加える |

スキーマ変更・マイグレーション追加は不要（noreply形式のみサポートする場合、計算はコミットメッセージの文字列処理だけで完結する）。

### 検討事項（重要：なりすましリスク）

- **Co-authored-byは自己申告であり、GitHub側で暗号学的に検証されているわけではありません**。悪意のあるコミット作者が、他人の実在するGitHubユーザーIDを`Co-authored-by:`に書けば、その人が実際には何もしていなくても「達成」扱いにできてしまいます。これはGitのCo-authored-by慣習そのものが持つ性質であり、このアプリ固有の欠陥ではありませんが、**「author.idは偽装できないから信頼する」という既存の設計前提を、この機能はわずかに緩める**ことになります
- 緩和策の一案: 「コミットの主author（`commit.author.id`）が、その宣言と同じguildの連携済みメンバーである場合のみ、そのコミットのCo-authored-by共著者判定を有効にする」といった制限を加え、赤の他人が単独であらゆる宣言をなりすまし達成させることを防ぐ
- メールアドレスでの突き合わせ（noreply形式以外）まで対応する場合、GitHub OAuthのスコープを現状の`scope: ""`（追加スコープなし）から`user:email`に広げる必要があり、これは「本人確認以外の情報を要求しない」という現状の設計方針（[setup.md 3章](docs/setup.md#3-github-oauth-app)）からの逸脱になるため、慎重な検討が必要

---

## 3. あおりメッセージをAIが作成

### 課題

現在の通知文言（[messages.ts:16-19](src/lib/discord/messages.ts#L16-L19)）は固定文言です。

```ts
const line = row.kind === "declared" ? "宣言、受け取ったで。コミット待ってるぞ。"
  : row.kind === "cancelled" ? "この宣言は取り消し。判定と集計の対象から外したで。"
  : succeeded ? "有言実行やな！ ちゃんと手を動かしたの、ニキは見てたで。"
  : "宣言は立派やったな！ 今回は条件に合うコミットを見つけられんかったで。";
```

これをAIに、宣言内容・結果・連続達成日数などの文脈に応じた「ニキ」キャラクターのセリフとして動的生成させる。

### 仕様

- `GEMINI_API_KEY`が設定されている場合だけ動的生成を試み、失敗時・未設定時は既存の固定文言にフォールバックする（**判定の正しさには影響しない装飾要素なので、失敗しても通知配信自体は止めない**）
- キャラクターのトーン（関西弁、辛口だが根は励ましている）を崩さないよう、システムプロンプトに既存の固定文言をfew-shot例として渡す
- 入力として渡す文脈: 宣言内容(`content`)、結果(`succeeded`/`failed`/`declared`/`cancelled`)、連続達成日数(`streak`、[domain.ts](src/lib/domain.ts)の`statistics()`から取得可能)、直近の達成率など
- 出力は`z.object({ line: z.string().max(120) })`のような構造化JSONで受け取り、長さを制限してDiscordのメッセージに収まるようにする
- 出力は必ず`discordText()`でエスケープしてから`content`に埋め込む（AIが宣言内容をそのまま引用した場合、Markdown記法やメンション文字列が混入する可能性があるため）

### 実装方針

| 変更対象 | 内容 |
| --- | --- |
| [ai.ts](#1-コミットの中身をaiが読んで宣言を達成したか判断する)（1番と共通化） | `generateTauntLine(context, signal): Promise<string>` を追加。失敗時は`null`を返す（例外を投げて呼び出し元を止めない設計にする） |
| [messages.ts](src/lib/discord/messages.ts) | `notificationMessage()`を`async`化し、`generateTauntLine`の結果があれば使う、なければ既存の`line`定数にフォールバックする分岐を追加 |
| 呼び出し元（[route.ts](src/app/api/discord/interactions/route.ts)の`processInteraction`、[jobs.ts](src/lib/jobs.ts)の`notifyOne`） | `notificationMessage`が非同期になることに伴う型・await の追従 |

### 検討事項

- **コスト・頻度**: 通知のたびにAI呼び出しが発生すると、コミット判定用の呼び出し（1番）と合わせてAPI利用量が増える。軽量モデル・短いプロンプトに絞る、あるいは「結果通知（`result`）のときだけ動的生成し、宣言・取消のときは固定文言のまま」のように対象を絞ることを検討
- **content-safety（あおりの行き過ぎ防止）**: 「あおり」は面白さが目的だが、人格否定や過度に攻撃的な表現に踏み込むと不快感・ハラスメントになりうる。システムプロンプトで「からかうが人格は否定しない」等の制約を明示し、Geminiの安全性設定（safety settings）も有効にしておく
- **レイテンシ**: `/niki declare`等はDiscordの3秒ルール対策で既に`after()`による非同期処理になっているため（[3-4章](docs/architecture.md#3-4-3秒ルールと2段階応答)）、AI呼び出しの追加レイテンシ自体は許容範囲内だが、Cronの40秒バジェット（[jobs.ts](src/lib/jobs.ts)の`runJobs`）内で複数件処理する場合は1件あたりの時間増に注意

---

## 4. 定期的にコントリビューションを自動で表示する

### 課題

現在、チームの状況（達成率・連続日数など）は`/niki status`をユーザーが**手動で実行したとき**にしか見られません。これを定期的（例: 毎日決まった時刻）に、設定した通知チャンネルへ自動投稿できるようにする。

### 仕様

- 既存の`/niki status`のロジック（[store.ts](src/lib/store.ts)の`teamStatus`、[messages.ts](src/lib/discord/messages.ts)の`statusMessage`）を再利用し、guildごとに設定チャンネルへ定期投稿する
- スケジュールは[cron.sql](supabase/cron.sql)の`niki-evaluate`と同じ仕組み（Supabase `pg_cron` + `pg_net`）で、新しいジョブ名・新しいエンドポイントを追加する
- MVPとしては「毎日決まった時刻に、`guild_settings`が設定済みの全guildへ投稿」を対象にし、guildごとのON/OFF・頻度設定は将来拡張とする

### 処理フロー

```
Supabase側:
  pg_cron が毎日決まった時刻（例: JST 21:00 = UTC 12:00）に発火
       ↓
  POST /api/jobs/report
  Authorization: Bearer <REPORT_CRON_SECRET>
       ↓
Vercel側:
  guild_settings を全件取得
  各guildについて store.teamStatus(guildId) を呼び、statusMessage 相当を組み立てて
  discord.deliver 相当でそのguildの通知チャンネルへ投稿
```

### 実装方針

| 変更対象 | 内容 |
| --- | --- |
| 新規 `src/app/api/jobs/report/route.ts` | [evaluate/route.ts](src/app/api/jobs/evaluate/route.ts)と同型（Bearer secret認証、`runtime = "nodejs"`）。`store`から`guild_settings`を全件取得し、guildごとに要約メッセージを組み立てて投稿する |
| [store.ts](src/lib/store.ts) | 全guild一覧を取得する関数（例: `listGuildsForReport()`）を追加。既存の`teamStatus(guildId)`は再利用 |
| [messages.ts](src/lib/discord/messages.ts) | `statusMessage`をそのまま使うか、定期投稿向けに要約を絞った軽量版（例: 直近24時間の結果のみ）を追加するか検討 |
| [cron.sql](supabase/cron.sql) | 新しい`cron.schedule('niki-report', '0 12 * * *', ...)`を追加。Vaultに`niki_report_secret`（または既存`niki_cron_secret`を共用）を登録 |
| `.env.example` / `docs/setup.md` | 新しいcron設定手順・環境変数を追記 |

### 検討事項

- **重複投稿の防止**: 既存の`notifications`テーブルは`declaration_id`に紐づく設計のため、宣言と無関係な定期レポートをそのまま流用できない。単純化するなら「重複してもチームの状況表示なので実害は小さい」と割り切って**冪等性を保証しない**（Cronが多重発火しても、同じ内容がもう一度投稿されるだけ）設計にするか、`guild_settings`に`last_report_at`のような列を足して「直近N時間以内に投稿済みならスキップ」という簡易ガードを設けるかを選ぶ
- **投稿量の制御**: guild数・宣言数が増えると、1回のCron実行で全guild分の投稿をこなす必要があり、[jobs.ts](src/lib/jobs.ts)の`runJobs`と同様に時間予算・件数上限の管理が必要になる
- **opt-out**: 全guildに強制的に日次投稿されると、使っていないguildや通知が多すぎると感じるguildから苦情が出る可能性がある。`/niki setup`にレポートのON/OFFオプションを増やすなど、guild側で制御できる余地を早めに用意しておくと運用しやすい

---

## 5. ユーザーごとに通知チャンネルを変更できるようにする

> **ステータス: 実装済み（案B: guild既定に複製投稿）** — 当初の案A（差し替え）から変更しました。`/niki notify`は実行したチャンネルを個人の追加通知先にし（`reset:true`で解除）、通知は`notifications`をチャンネルごとの独立行（`unique (declaration_id, kind, channel_id)`）としてguild既定と個人チャンネルの両方に投稿します。マイグレーションは[202610010001_notify_channel.sql](supabase/migrations/202610010001_notify_channel.sql)と[202610020001_notify_channel_mirror.sql](supabase/migrations/202610020001_notify_channel_mirror.sql)。公開性はguild既定への必須投稿で担保されるため、非公開チャンネルの扱いは問題になりません。以下の仕様・実装方針は当初案Aの設計メモです。

### 課題

現在`/niki setup`で設定できる通知先は**guildにつき1チャンネルだけ**（[guild_settings](supabase/migrations/202609260001_mvp.sql#L10-L14)テーブル）で、宣言・取消・結果の通知は全メンバー分がそのチャンネルに集まります（[niki_create_declaration](supabase/migrations/202609260001_mvp.sql#L116-L140)などが`guild_settings.channel_id`を参照して`notifications`行を作成）。メンバーが増えるほど1チャンネルの流量が増え、自分に関係する通知を追いにくくなります。

### 仕様

- 各メンバーが、自分の宣言・結果通知だけを送る**個人の優先チャンネル**を任意で設定できるようにする
- 優先チャンネルが未設定のメンバーは、これまで通りguildの既定チャンネル（`/niki setup`で設定したもの）に届く
- 優先チャンネルは同一guild内のテキストチャンネルに限定する（他guildへの送信や、宣言と無関係なguildへの漏洩を防ぐため）
- 通知先は既存の設計方針（[setup.md 7章](docs/setup.md#7-判定再試行の仕様)の「通知先は通知の予約時に固定する」）を踏襲し、宣言・結果それぞれの通知が作成された時点での優先チャンネル設定をそのまま使う（後から設定を変えても、すでに作成済みの通知の宛先は変わらない）

### 処理フロー

```
① ユーザーが /niki notify channel:#個人チャンネル を実行
② Botがそのチャンネルへの投稿権限（見る/送信/埋め込みリンク/履歴を読む）を確認
   → 既存の assertChannel と同じチェックをそのまま流用
③ memberships テーブルの該当行に notify_channel_id として保存
④ 以後、そのユーザーの宣言・取消・結果通知は
   coalesce(memberships.notify_channel_id, guild_settings.channel_id) の値を宛先として作成される
⑤ /niki notify （channel省略）で個人設定を解除 → guildの既定チャンネルに戻る
```

### 実装方針

| 変更対象 | 内容 |
| --- | --- |
| 新規マイグレーション | `memberships`に`notify_channel_id text`（nullable、`check (notify_channel_id ~ '^[0-9]{17,20}$')`）列を追加 |
| 新規マイグレーション | `niki_set_notify_channel(p_guild_id text, p_discord_id text, p_channel_id text)`関数を追加。`memberships`に該当行が無ければ既存の`LINK_REQUIRED`と同様の例外を投げる。`p_channel_id`が`null`なら解除。既存の`revoke`/`grant`パターン（`service_role`のみ許可）を踏襲 |
| 既存マイグレーションの関数は変更せず、新規マイグレーションで置き換え | [niki_create_declaration](supabase/migrations/202609260001_mvp.sql#L116-L140)・cancel時の通知作成（同ファイル150-151行目）・result通知作成（同177-178行目）の3箇所を、`guild_settings`単独参照から`memberships`とのJOIN＋`coalesce(m.notify_channel_id, gs.channel_id)`に変更する（`create or replace function`で上書き） |
| [commands.ts](src/lib/discord/commands.ts) | `/niki`に新しいサブコマンド`notify`を追加。オプション`channel`（type 7、任意・省略可）。値を省略した場合は「解除」として扱う |
| [handler.ts](src/lib/discord/handler.ts) | `notify`コマンドの分岐を追加。`requireSetup`→（`requireMember`相当のチェック）→`discord.assertChannel(guildId, channelId)`→`store.setNotifyChannel(guildId, discordId, channelId)`という流れで、既存の`setup`コマンドの実装パターンをほぼそのまま踏襲できる |
| [store.ts](src/lib/store.ts) | `setNotifyChannel(guildId, discordId, channelId)`を追加し、`niki_set_notify_channel`を呼ぶ |

### 検討事項

- **公開性とのトレードオフ**: このアプリの宣言機能は「チームの目に触れることで達成を後押しする」という社会的圧力を意図的に利用しています（[setup.md](docs/setup.md)にも「宣言・取消・結果の通知は設定したチャンネルに公開します」と明記）。個人チャンネルへの分散を無制限に許すと、この「チーム全体に見える」という前提が崩れ、実質的に自分だけが見えるチャンネルへ通知を隠せてしまいます。運用ポリシーとして、次のいずれかを選ぶ必要があります。
  - **A. 完全に個人チャンネルへ差し替え**（今回の仕様案の前提）: 自由度は高いが、公開性の担保はガバナンス（サーバー内のチャンネル権限設定など）に委ねる
  - **B. guildの既定チャンネルにも必ず複製投稿する**（個人チャンネルは「追加の通知先」として扱う）: 公開性を保ったまま見やすさも改善できるが、実装（1件の判定・通知に対して複数チャンネルへ配信する必要がある）と通知テーブルの設計（`notifications.channel_id`を1件から複数件に拡張する必要がある）がやや複雑になる
  - どちらを採るかは、このBotを「本人のための進捗管理ツール」と捉えるか「チームの相互監視ツール」と捉えるかという製品方針の判断が必要
- **権限確認の対象**: `assertChannel`は現状「Bot自身がそのチャンネルに投稿できるか」しか見ておらず、「そのチャンネルをguildの他のメンバーが見られるか」までは確認しません。Discordのインタラクションペイロードには、チャンネル型オプションを使った場合に呼び出し本人の権限が`resolved`情報として含まれることがあり、これを使って「本人が見えない非公開チャンネルへの設定を弾く」といった追加チェックができる可能性がありますが、Discord APIの現行仕様を確認した上で採否を決める必要があります
- **guild脱退・チャンネル削除時の扱い**: 優先チャンネルが削除された場合の挙動（既存の[setup.md 7章](docs/setup.md#7-判定再試行の仕様)にある「元のチャンネルを削除した場合は、DBで保留中通知の`channel_id`を修正する必要がある」と同様の運用対応が必要になる点）をドキュメント化しておく
