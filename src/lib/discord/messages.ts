import { discordText, formatJst, statistics, type Declaration, type Member, type Notification } from "../domain";

export type Message = {
  content?: string;
  embeds?: { title?: string; description?: string; color?: number; footer?: { text: string }; fields?: { name: string; value: string }[] }[];
  allowed_mentions?: { parse: string[]; users?: string[] };
};

export const notificationMarker = (id: string) => `記録ID: ${id}`;
const target = (d: Declaration) => `${discordText(d.repository)} / ${discordText(d.branch)}`;
const commitUrl = (d: Declaration) => `https://github.com/${d.repository}/commit/${d.commit_sha}`;

export type NikiScene = "declared" | "cancelled" | "succeeded" | "failed" | "checkError";
type NikiWords = { name: string; content: string; deadline: string };

// Character sheet: docs/niki-character.md. Each line uses the name at most once so the declarer is mentioned only once.
export const nikiLines: Record<NikiScene, ((w: NikiWords) => string)[]> = {
  declared: [
    (w) => `${w.name}が宣言したぞ。「${w.content}」、期限は${w.deadline}。言ったな？聞いたからな。`,
    (w) => `おっ、${w.name}。「${w.content}」を${w.deadline}までにか。いい顔してんじゃねぇか。`,
    (w) => `宣言受理。${w.deadline}に俺が見に行く。コミットは嘘つかねぇぞ、${w.name}。`,
    (w) => `${w.name}、「${w.content}」な。みんなも聞いたよな？もう逃げ道はねぇぞ。`,
  ],
  cancelled: [
    (w) => `${w.name}が宣言を取り下げた。……まぁ、引く勇気も大事だ。次は守れよ。`,
    (w) => `取消了解。今回は見逃してやる。次はねぇからな、${w.name}。`,
    (w) => `${w.name}、撤退か。作戦の練り直しなら許す。サボりなら許さねぇ。`,
  ],
  succeeded: [
    (w) => `${w.name}、やったじゃねぇか！「${w.content}」、確かに見届けた。`,
    (w) => `コミット確認。${w.name}、お前は口だけじゃなかったな。`,
    (w) => `期限内にやり切った${w.name}に拍手。こういうのが一番かっこいいんだよ。`,
    (w) => `${w.name}の草がまた伸びた。いい芝だ、この調子で育てていけ。`,
    (w) => `宣言して、やった。それだけのことが一番難しいんだ。よくやった、${w.name}。`,
    (w) => `「${w.content}」完了。${w.name}、今日のメシはうまいぞ。`,
  ],
  failed: [
    (w) => `${w.name}……「${w.content}」はどこ行った？俺のところには何も届いてねぇぞ。`,
    (w) => `期限切れだ、${w.name}。やる気泥棒にまんまと盗まれたな。次は守り切れよ。`,
    (w) => `コミットは嘘つかねぇ。つまり今回はゼロってことだ。次で取り返せ、${w.name}。`,
    (w) => `${w.name}、宣言だけは立派だったな。次は手も動かそうぜ。`,
    (w) => `おい${w.name}、「明日やる」は今日やらなかった奴のセリフだぞ。明日こそな。`,
    (w) => `今回は負けだな、${w.name}。1行でいい、次は何か残せ。`,
  ],
  checkError: [
    () => "GitHubの様子がおかしい。判定はちょっと待ってろ、逃がしはしねぇから。",
  ],
};

// `name` is inserted as given (a mention or an already-escaped display name). `content` is user text:
// it is shortened so the message stays far below Discord's 2000-character limit, then escaped.
export function nikiLine(scene: NikiScene, words: NikiWords, random: () => number = Math.random) {
  const lines = nikiLines[scene];
  const chars = Array.from(words.content);
  const content = discordText(chars.slice(0, 100).join("")) + (chars.length > 100 ? "…" : "");
  return lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))]({ ...words, content });
}

export function notificationMessage(row: Notification, d: Declaration, random: () => number = Math.random): Message {
  const succeeded = d.status === "succeeded";
  const title = row.kind === "declared" ? "開発の宣言" : row.kind === "cancelled" ? "宣言を取消" : succeeded ? "達成" : "未達成";
  const scene = row.kind === "result" ? (succeeded ? "succeeded" : "failed") : row.kind;
  return {
    content: nikiLine(scene, { name: `<@${d.discord_id}>`, content: d.content, deadline: formatJst(d.deadline) }, random),
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

export function statusMessage(members: Member[], declarations: Declaration[], page = 1, pendingNotifications = 0, now = new Date(), memberId?: string): Message {
  if (memberId) {
    members = members.filter((m) => m.discord_id === memberId);
    declarations = declarations.filter((d) => d.discord_id === memberId);
  }
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
    content: `**${memberId ? `<@${memberId}>の状況` : "チームの状況"}**\n進行中・確認待ち ${active.length}件 / 達成 ${totalSucceeded}件 / 未達成 ${totalFailed}件${pendingNotifications ? `\n投稿待ちの通知: ${pendingNotifications}件（自動再試行）` : ""}\n${selected}/${pages}ページ${pages > 1 ? ` · /niki status ${memberId ? `member:<@${memberId}> ` : "all:true "}page:番号 で切替` : ""}`,
    allowed_mentions: { parse: [] },
    embeds: [
      { title: "進行中・確認待ち", description: slice(active).map(describe).join("\n\n") || "このページに宣言はありません。", color: 0xcceeff },
      { title: "最近の結果", description: slice(history).map(describe).join("\n\n") || "このページに結果はありません。" },
      { title: "メンバー別の記録", description: slice(stats).map((s) => `<@${s.discord_id}> (${discordText(s.github_login)})\n達成 ${s.succeeded} / 未達成 ${s.failed} · 達成率 ${s.rate === null ? "未集計" : `${s.rate}%`} · 連続 ${s.streak}日`).join("\n\n") || "このページに参加者はいません。",
        footer: { text: "達成率は判定済みのみ。連続日数は期限の日本時間の日付で集計。" } },
    ],
  };
}
