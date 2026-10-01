# 毎週月曜の振り返り

先週の宣言の達成・未達成を集計し、チームと各メンバーの成績、MVP・サボり王をニキが週に1回発表する機能です。
投稿せずに内容を確認できる試し実行モードも用意しています。

毎週月曜9:00（日本時間）に、先週の結果を `/niki setup` で設定したサーバーの通知チャンネルへ投稿します。個人の追加通知先には複製しません。Discordコマンドの追加・再登録は不要です。

## 集計ルール

- 先週の月曜0:00以上、今週の月曜0:00未満の**期限**を持つ宣言を対象にします。作成日や判定日ではありません。
- 達成率 = 達成数 ÷（達成数 + 未達成数）。判定待ち・確認エラー・取消を分母に含めません。チーム全体も件数の合計から計算します。
- 連携中の各メンバーを表示します。期間内に確定した結果がある人は、連携が無効になっていても集計に含めます。
- MVPは達成数が最多の人。同数なら達成率が高い人、それも同じなら全員です。達成ゼロなら「不在」です。順位は表示用の丸め前の値で比較します。
- サボり王は未達成数が最多の人。同数なら全員、未達成ゼロなら「不在」です。宣言しなかった人を未達成扱いにはしません。
- 確定結果がない人の達成率は「対象なし」です。判定待ち・取消だけの週もゼロ件の表を表示します。期間内の宣言自体がゼロの場合は一言だけ投稿します。
- 週次投稿の準備時点で結果と通知先を固定します。後から判定が確定しても投稿済みの週は更新・再投稿しません。
- メンション通知は飛ばしません。大人数で本文が長くなる場合は、全員分を同じ投稿のテキストファイルに添付します。

## マージ後に行うこと

既存の判定機能が動いており、SupabaseのCron・pg_net・Vaultが設定済みであることを前提にします。

1. Supabaseで対象プロジェクトを開き、左メニューの **SQL Editor → New query** を開きます。
2. [週次サマリー用SQL](../supabase/migrations/202610030001_weekly_summary.sql) の中身をすべて貼り付け、**Run** を押します。これは投稿済みの記録を保存する場所などを追加します。1回だけ実行してください。ファイル名の日付が未来でも待つ必要はありません。
3. Vercelで、このPRを含む本番デプロイが **Ready** になっていることを確認します。DB追加前に自動デプロイされても既存処理は変わりませんが、週次APIはDB追加後に使ってください。
4. 下の「試し実行」で内容を確認します。Discordへの投稿も投稿済み記録の作成も行いません。
5. [週次Cron用SQL](../supabase/weekly-cron.sql) を別のNew queryに貼り付けて **Run** を押します。月曜9:00の実行と失敗時の再試行を登録します。これは同じ名前で更新できるので、再実行してもジョブは増えません。

Vaultの `niki_app_url`（本番URL）と `niki_cron_secret`（Vercelの `CRON_SECRET` と同じ値）をそのまま使います。新しい秘密キーは不要です。Cronの時刻はUTCで、`0 0 * * 1` が月曜9:00 JSTに相当します。

再試行ジョブは毎時5〜55分の5分間隔で動きます。月曜の起動を逃した場合も、その週の未作成分を準備します。そのため、**初回登録が火曜以降なら、直前の週のサマリーが次の再試行時刻に投稿されます**。月曜0〜9時には新しい週の投稿を準備しません。通知済みの週は再投稿しません。

## 試し実行（Discordに投稿しない）

SupabaseのSQL Editorで次を実行します。URLと認証はVaultから取得するため、秘密の値を貼り付ける必要はありません。

```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'niki_app_url') || '/api/jobs/weekly',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'niki_cron_secret')
  ),
  body := '{"dryRun":true}'::jsonb,
  timeout_milliseconds := 60000
) as request_id;
```

返ってきた `request_id` の数字を控えます。数秒後、**別の実行**で次の `123` をその数字に置き換えて実行します。

```sql
select status_code, content, error_msg
from net._http_response
where id = 123;
```

- `status_code` が `200` なら成功です。`content` 内の `reports` → `content` が投稿予定の文章です。
- 結果が0行なら少し待って、結果を見るSQLだけを再実行してください。
- `401` は認証の不一致、`503` は環境設定やDB・通信の問題です。Vercelのログも確認してください。
- `dryRun` は省略しても `true` です。`false` にすると実際の投稿処理になるので、試し実行では変えないでください。

別の週を試す場合、bodyを `'{"dryRun":true,"weekStart":"2026-09-28"}'::jsonb` にします。`weekStart` は日本時間で月曜日の日付です。実投稿では任意の日付指定は受け付けません。

APIとして直接呼ぶ場合は `POST /api/jobs/weekly` に `Authorization: Bearer <CRON_SECRET>` とJSONを送ります。試し実行は最大100サーバーずつ返し、`nextCursor` がnullでなければその値を次のリクエストの `after` に指定できます。

## 動作確認と復旧

```sql
select guild_id, week_start, status, attempts, sent_at, last_error
from public.weekly_reports
order by week_start desc, guild_id;
```

`sent` が投稿済み、`pending` が投稿待ちです。1回のAPI呼び出しで最大100サーバー分を準備し、最大10件を約40秒の範囲で送信します。残りは次の再試行に引き継ぎます。障害などで9:00ちょうどに届かない場合があります。

サーバーと週の組み合わせをDBで一意にし、同時実行は期限付きの実行権限で制御します。再送前はBot自身の投稿の記録IDを履歴から確認し、Discord送信成功後にDB更新が失敗しても、見つかった投稿を記録して新規投稿を避けます。Discordのnonceによる短時間の重複抑止も併用します。

Botには「チャンネルを見る・メッセージを送信・埋め込みリンク・メッセージ履歴を読む」の権限が必要です。長い本文の添付には「ファイルを添付」も必要です。権限不足や履歴1,000件で確認しきれない場合は、重複投稿を避けるため保留します。`last_error` と通知チャンネルの状態を確認してください。送信結果が未確定な投稿や記録を手動削除すると重複防止の手がかりを失うため、削除しないでください。

定期投稿を止める場合は、SupabaseのCron画面で `niki-weekly-summary` と `niki-weekly-summary-retry` の両方を無効にします。既存の `niki-evaluate` は変更しません。

参考: [DiscordのメッセージAPI（nonce・添付）](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx)
