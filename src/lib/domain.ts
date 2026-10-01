import { z } from "zod";

export const snowflake = z.string().regex(/^\d{17,20}$/);
export const repositoryName = z.string().trim().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/,
  "リポジトリは owner/repository の形式で入力してください。",
).refine((value) => ![".", ".."].includes(value.split("/")[1]));

export class UserError extends Error {}

export type DeclarationStatus = "pending" | "succeeded" | "failed" | "cancelled";
export type Declaration = {
  id: string;
  interaction_id: string;
  guild_id: string;
  discord_id: string;
  github_id: number;
  content: string;
  repository: string;
  branch: string;
  created_at: string;
  deadline: string;
  status: DeclarationStatus;
  commit_sha: string | null;
  ai_reason: string | null;
  judged_shas: string[];
  checked_at: string | null;
  next_check_at?: string;
  check_attempts: number;
  last_check_error: string | null;
  lease_token: string | null;
};

export type Notification = {
  id: string;
  declaration_id: string;
  kind: "declared" | "result" | "cancelled";
  channel_id: string;
  attempts: number;
  lease_token: string;
  first_attempt_at: string;
  created_at: string;
};

export type Member = { discord_id: string; github_login: string };
export type MemberStats = Member & {
  succeeded: number;
  failed: number;
  pending: number;
  rate: number | null;
  streak: number;
};

const jstDateTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function formatJst(value: string | Date) {
  return `${jstDateTime.format(new Date(value))} JST`;
}

export function jstDay(value: string | Date) {
  return new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export { parseDeadline } from "./deadline";

export const declarationInput = z.object({
  content: z.string().trim().min(1, "宣言の内容を入力してください。").max(500),
  repository: repositoryName,
  branch: z.string().trim().min(1).max(255).optional(),
  deadline: z.string(),
});

export function statistics(members: Member[], declarations: Declaration[], now = new Date()): MemberStats[] {
  const today = jstDay(now);
  const previous = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return members.map((member) => {
    const rows = declarations.filter((row) => row.discord_id === member.discord_id);
    const succeeded = rows.filter((row) => row.status === "succeeded");
    const failed = rows.filter((row) => row.status === "failed").length;
    const days = new Set(succeeded.map((row) => jstDay(row.deadline)));
    let cursor = days.has(today) ? today : previous(today);
    let streak = 0;
    while (days.has(cursor)) { streak++; cursor = previous(cursor); }
    return {
      ...member, succeeded: succeeded.length, failed,
      pending: rows.filter((row) => row.status === "pending").length,
      rate: succeeded.length + failed ? Math.round(succeeded.length / (succeeded.length + failed) * 100) : null,
      streak,
    };
  });
}

// Do not let user content turn into Discord formatting or additional mentions.
export function discordText(value: string) {
  return value.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1").replace(/@/g, "@\u200b");
}

export function retryDelay(attempt: number) {
  return Math.min(3600, 60 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}
