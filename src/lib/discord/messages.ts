import { discordText, formatJst, statistics, type Declaration, type Member, type Notification } from "../domain";

export type Message = {
  content?: string;
  embeds?: { title?: string; description?: string; color?: number; footer?: { text: string }; fields?: { name: string; value: string }[] }[];
  allowed_mentions?: { parse: string[]; users?: string[] };
};

export const notificationMarker = (id: string) => `記録ID: ${id}`;
const target = (d: Declaration) => `${discordText(d.repository)} / ${discordText(d.branch)}`;
const commitUrl = (d: Declaration) => `https://github.com/${d.repository}/commit/${d.commit_sha}`;

export function notificationMessage(row: Notification, d: Declaration): Message {
  const succeeded = d.status === "succeeded";
  const title = row.kind === "declared" ? "開発の宣言" : row.kind === "cancelled" ? "宣言を取消" : succeeded ? "達成" : "未達成";
  const line = row.kind === "declared" ? "宣言、受け取ったで。コミット待ってるぞ。"
    : row.kind === "cancelled" ? "この宣言は取り消し。判定と集計の対象から外したで。"
    : succeeded ? "有言実行やな！ ちゃんと手を動かしたの、ニキは見てたで。"
    : "宣言は立派やったな！ 今回は条件に合うコミットを見つけられんかったで。";
  return {
    content: `<@${d.discord_id}> ${line}`,
    allowed_mentions: { parse: [], users: [d.discord_id] },
    embeds: [{ title, description: discordText(d.content), color: 0xcceeff,
      fields: [
        { name: "対象", value: target(d) },
        { name: "期限", value: formatJst(d.deadline) },
        ...(row.kind === "result" && succeeded ? [{ name: "確認したコミット", value: `[${d.commit_sha?.slice(0, 7)}](${commitUrl(d)})` }] : []),
        ...(row.kind === "result" && !succeeded && d.ai_reason ? [{ name: "AIの判定理由", value: discordText(d.ai_reason) }] : []),
      ], footer: { text: notificationMarker(row.id) },
    }],
  };
}

export function statusMessage(members: Member[], declarations: Declaration[], page = 1, pendingNotifications = 0, now = new Date()): Message {
  const active = declarations.filter((d) => d.status === "pending").sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  const history = declarations.filter((d) => d.status !== "pending");
  const stats = statistics(members, declarations, now);
  const pageSize = 5;
  const pages = Math.max(1, ...[active, history, stats].map((rows) => Math.ceil(rows.length / pageSize)));
  const selected = Math.min(Math.max(1, page), pages);
  const slice = <T>(rows: T[]) => rows.slice((selected - 1) * pageSize, selected * pageSize);
  const label = (d: Declaration) => d.status === "succeeded" ? "達成" : d.status === "failed" ? "未達成" : d.status === "cancelled" ? "取消（集計対象外）"
    : Date.parse(d.deadline) > now.getTime() ? "進行中" : d.last_check_error ? "確認エラー・再試行待ち" : "確認待ち";
  const shorten = (value: string, length: number) => discordText(value.slice(0, length)) + (value.length > length ? "…" : "");
  const describe = (d: Declaration) => `<@${d.discord_id}> — **${label(d)}**\n${shorten(d.content, 80)}\n${shorten(d.repository, 70)} / ${shorten(d.branch, 35)}\n期限: ${formatJst(d.deadline)}${d.commit_sha ? `\n[コミット](${commitUrl(d)})` : ""}`;
  const totalSucceeded = declarations.filter((d) => d.status === "succeeded").length;
  const totalFailed = declarations.filter((d) => d.status === "failed").length;
  return {
    content: `**チームの状況**\n進行中・確認待ち ${active.length}件 / 達成 ${totalSucceeded}件 / 未達成 ${totalFailed}件${pendingNotifications ? `\n投稿待ちの通知: ${pendingNotifications}件（自動再試行）` : ""}\n${selected}/${pages}ページ${pages > 1 ? " · /niki status page:番号 で切替" : ""}`,
    allowed_mentions: { parse: [] },
    embeds: [
      { title: "進行中・確認待ち", description: slice(active).map(describe).join("\n\n") || "このページに宣言はありません。", color: 0xcceeff },
      { title: "最近の結果", description: slice(history).map(describe).join("\n\n") || "このページに結果はありません。" },
      { title: "メンバー別の記録", description: slice(stats).map((s) => `<@${s.discord_id}> (${discordText(s.github_login)})\n達成 ${s.succeeded} / 未達成 ${s.failed} · 達成率 ${s.rate === null ? "未集計" : `${s.rate}%`} · 連続 ${s.streak}日`).join("\n\n") || "このページに参加者はいません。",
        footer: { text: "達成率は判定済みのみ。連続日数は期限の日本時間の日付で集計。" } },
    ],
  };
}
