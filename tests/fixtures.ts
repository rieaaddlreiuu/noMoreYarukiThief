import type { Declaration, Notification } from "../src/lib/domain";

export const guildId = "100000000000000001";
export const otherGuildId = "100000000000000002";
export const discordId = "200000000000000001";
export const otherDiscordId = "200000000000000002";
export const channelId = "300000000000000001";
export const applicationId = "400000000000000001";

export const declaration = (overrides: Partial<Declaration> = {}): Declaration => ({
  id: "11111111-1111-4111-8111-111111111111", interaction_id: "500000000000000001",
  guild_id: guildId, discord_id: discordId, github_id: 1234, content: "ログイン画面を実装する",
  repository: "owner/repository", branch: "main", created_at: "2026-09-26T10:00:00.000Z",
  deadline: "2026-09-26T13:00:00.000Z", status: "pending", commit_sha: null, ai_reason: null, checked_at: null,
  check_attempts: 1, last_check_error: null, lease_token: "22222222-2222-4222-8222-222222222222", ...overrides,
});

export const notification = (overrides: Partial<Notification> = {}): Notification => ({
  id: "33333333-3333-4333-8333-333333333333", declaration_id: declaration().id, kind: "result",
  channel_id: channelId, attempts: 1, lease_token: "44444444-4444-4444-8444-444444444444",
  first_attempt_at: "2026-09-26T13:05:00.000Z", created_at: "2026-09-26T13:05:00.000Z", ...overrides,
});
