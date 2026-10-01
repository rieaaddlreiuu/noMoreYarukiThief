import { discordText } from "./domain";

const DAY = 86_400_000;
const JST = 9 * 3_600_000;
export type Week = { start: string; end: string; weekStart: string; lastDay: string; dueAt: string };

export function weekFromStart(value: string): Week {
  const start = new Date(`${value}T00:00:00+09:00`);
  const local = new Date(start.getTime() + JST);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(start.getTime()) ||
      local.toISOString().slice(0, 10) !== value || local.getUTCDay() !== 1) throw new Error("Week must start on a valid Monday");
  return { start: start.toISOString(), end: new Date(start.getTime() + 7 * DAY).toISOString(), weekStart: value,
    lastDay: new Date(local.getTime() + 6 * DAY).toISOString().slice(0, 10),
    dueAt: new Date(start.getTime() + 7 * DAY + JST).toISOString() };
}

export function previousWeek(now = new Date()): Week {
  const local = new Date(now.getTime() + JST);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7 - 7);
  return weekFromStart(local.toISOString().slice(0, 10));
}

export type WeeklyMember = { discord_id: string; github_login: string; succeeded: number; failed: number };
export type WeeklySnapshot = { guild_id: string; channel_id: string; declaration_count: number; members: WeeklyMember[] };
export type WeeklyReport = {
  id: string; guild_id: string; channel_id: string; week_start: string; snapshot: WeeklySnapshot;
  attempts: number; first_attempt_at: string; lease_token: string;
};

export function weeklyStats(members: WeeklyMember[]) {
  const succeeded = members.reduce((sum, member) => sum + member.succeeded, 0);
  const failed = members.reduce((sum, member) => sum + member.failed, 0);
  const maxSuccess = Math.max(0, ...members.map((member) => member.succeeded));
  // With equal positive successes, a smaller denominator means a higher exact rate.
  const candidates = members.filter((member) => maxSuccess > 0 && member.succeeded === maxSuccess);
  const minFailure = Math.min(...candidates.map((member) => member.failed));
  const maxFailure = Math.max(0, ...members.map((member) => member.failed));
  return { succeeded, failed, rate: succeeded + failed ? succeeded / (succeeded + failed) : null,
    mvp: candidates.filter((member) => member.failed === minFailure),
    slacker: members.filter((member) => maxFailure > 0 && member.failed === maxFailure) };
}

const rateText = (success: number, failure: number) => success + failure ? `${(100 * success / (success + failure)).toFixed(1)}%` : "対象なし";

export function weeklyText(snapshot: WeeklySnapshot, week: Week): string {
  if (snapshot.declaration_count === 0) return `${week.weekStart}〜${week.lastDay}は宣言ゼロだ、今週は小さく一つ宣言しろよ。`;
  const stats = weeklyStats(snapshot.members);
  const names = (members: WeeklyMember[]) => members.map((member) => discordText(member.github_login)).join("、") || "不在";
  return [
    "先週の結果をまとめたぞ。",
    `対象期間: ${week.weekStart}〜${week.lastDay} JST（期限基準）`,
    `チーム全体: 達成 ${stats.succeeded} / 未達成 ${stats.failed} / 達成率 ${rateText(stats.succeeded, stats.failed)}`,
    "メンバー別:",
    ...snapshot.members.map((member) => `<@${member.discord_id}> (${discordText(member.github_login)}) 達成 ${member.succeeded} / 未達成 ${member.failed} / 達成率 ${rateText(member.succeeded, member.failed)}`),
    `MVP: ${names(stats.mvp)}${stats.mvp.length ? "、言ったことをやったな、よくやった。" : ""}`,
    `サボり王: ${names(stats.slacker)}`,
    stats.slacker.length ? "期限を守れなかった分は、今週取り返せよ。" : "今週も一つずつ積み上げていこうぜ。",
    "集計時点で確定した達成・未達成のみ（判定待ち・取消は対象外）",
  ].join("\n");
}

export const weeklyMarker = (id: string) => `週次記録: ${id}`;

export function weeklyPayload(report: Pick<WeeklyReport, "id" | "week_start" | "snapshot">) {
  const text = weeklyText(report.snapshot, weekFromStart(report.week_start));
  // Keep a server's whole week in one Discord message, even for large teams.
  const attachment = text.length > 1900 ? text : null;
  return {
    message: { content: attachment ? "先週の結果をまとめたぞ、全員分の記録は添付を見てくれ。今週も手を動かそうぜ。" : text,
      allowed_mentions: { parse: [] }, embeds: [{ footer: { text: weeklyMarker(report.id) } }] },
    attachment,
  };
}
