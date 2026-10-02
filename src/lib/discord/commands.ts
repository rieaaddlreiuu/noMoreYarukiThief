export const nikiCommand = {
  name: "niki", description: "開発の宣言・GitHub連携・チームの状況確認",
  type: 1, integration_types: [0], contexts: [0],
  options: [
    { type: 1, name: "setup", description: "通知先を設定（サーバー管理権限が必要）", options: [
      { type: 7, name: "channel", description: "Botの通知先テキストチャンネル", required: true, channel_types: [0] },
    ] },
    { type: 1, name: "weekly", description: "週次サマリーの投稿日時を設定する（サーバー管理権限が必要。省略時は現在の設定を表示）", options: [
      { type: 4, name: "day", description: "投稿する曜日", choices: ["月", "火", "水", "木", "金", "土", "日"].map((name, index) => ({ name: `${name}曜日`, value: index + 1 })) },
      { type: 4, name: "hour", description: "投稿する時（日本時間 0〜23）", min_value: 0, max_value: 23 },
      { type: 5, name: "enabled", description: "falseで週次サマリーを停止、trueで再開" },
    ] },
    { type: 1, name: "github", description: "自分のGitHubアカウントをこのサーバーで連携する" },
    { type: 1, name: "declare", description: "開発内容と期限を宣言する", options: [
      { type: 3, name: "content", description: "何を開発するか", required: true, min_length: 1, max_length: 500 },
      { type: 3, name: "repository", description: "公開リポジトリ（owner/repository）", required: true, max_length: 140 },
      { type: 3, name: "deadline", description: "日本時間の期限。例: 23時 / 明日 9時 / 3時間後 / 10/5 21:00 / YYYY-MM-DD HH:mm", required: true, min_length: 1, max_length: 100 },
      { type: 3, name: "branch", description: "対象ブランチ（省略時は現在のデフォルトブランチ）", max_length: 255 },
    ] },
    { type: 1, name: "notify", description: "このチャンネルを自分の通知先に追加する（サーバー既定にも引き続き投稿）", options: [
      { type: 5, name: "reset", description: "trueで個人の通知先を解除する" },
    ] },
    { type: 1, name: "cancel", description: "自分の期限前の宣言を取り消す" },
    { type: 1, name: "status", description: "チームの宣言・結果・達成率・連続達成日数を見る", options: [
      { type: 4, name: "page", description: "表示するページ", min_value: 1, max_value: 1000000 },
      { type: 6, name: "member", description: "このメンバーの状況を見る（省略時は自分）" },
      { type: 5, name: "all", description: "trueでサーバー全体の状況を見る" },
    ] },
  ],
};
