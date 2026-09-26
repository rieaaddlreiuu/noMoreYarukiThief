import "server-only";
import { env } from "../config";
import { type Declaration, type Notification, UserError } from "../domain";
import { hashToken } from "../security";
import { BOT_PERMISSIONS, channelPermissions } from "./permissions";
import { type Message, notificationMarker, notificationMessage } from "./messages";

export class DiscordApiError extends Error {
  constructor(public status: number, public retryAfter = 60) { super(`Discord API HTTP ${status}`); }
}

type Channel = { id: string; guild_id: string; type: number; permission_overwrites: { id: string; type: number; allow: string; deny: string }[] };
type DiscordMessage = { id: string; timestamp: string; author: { id: string }; embeds: { footer?: { text: string } }[] };

export function createDiscordClient() {
  async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; webhook?: boolean } = {}): Promise<T> {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method: options.method ?? "GET", cache: "no-store",
      headers: { "Content-Type": "application/json", ...(!options.webhook ? { Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new DiscordApiError(response.status, typeof body.retry_after === "number" ? Math.ceil(body.retry_after) : 60);
    }
    return response.json() as Promise<T>;
  }

  async function assertChannel(guildId: string, channelId: string, signal = AbortSignal.timeout(15_000)) {
    const [channel, self] = await Promise.all([
      request<Channel>(`/channels/${channelId}`, { signal }),
      request<{ id: string }>("/users/@me", { signal }),
    ]);
    if (channel.guild_id !== guildId || channel.type !== 0) throw new UserError("このサーバーの通常のテキストチャンネルを指定してください。");
    const [member, roles] = await Promise.all([
      request<{ roles: string[] }>(`/guilds/${guildId}/members/${self.id}`, { signal }),
      request<{ id: string; permissions: string }[]>(`/guilds/${guildId}/roles`, { signal }),
    ]);
    const permissions = channelPermissions(guildId, self.id, member.roles, roles, channel.permission_overwrites);
    if ((permissions & BOT_PERMISSIONS) !== BOT_PERMISSIONS) {
      throw new UserError("Botに「チャンネルを見る」「メッセージを送信」「埋め込みリンク」「メッセージ履歴を読む」の権限が必要です。");
    }
    return self.id;
  }

  return {
    assertChannel,
    async assertMember(guildId: string, discordId: string) {
      await request(`/guilds/${guildId}/members/${discordId}`);
    },
    async editReply(applicationId: string, token: string, message: Message) {
      await request(`/webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`, {
        method: "PATCH", body: { allowed_mentions: { parse: [] }, ...message }, webhook: true,
      });
    },
    async deliver(row: Notification, declaration: Declaration, signal: AbortSignal): Promise<string> {
      if (row.attempts > 1) {
        // Discord nonce deduplication lasts only minutes. Reconcile durable history on every retry.
        const botId = await assertChannel(declaration.guild_id, row.channel_id, signal);
        const earliest = Date.parse(row.first_attempt_at) - 5_000;
        let before = "";
        let complete = false;
        for (let page = 0; page < 10; page++) {
          const messages = await request<DiscordMessage[]>(`/channels/${row.channel_id}/messages?limit=100${before ? `&before=${before}` : ""}`, { signal });
          const found = messages.find((message) => message.author.id === botId && message.embeds.some((embed) => embed.footer?.text === notificationMarker(row.id)));
          if (found) return found.id;
          if (messages.length < 100 || Date.parse(messages.at(-1)!.timestamp) < earliest) { complete = true; break; }
          before = messages.at(-1)!.id;
        }
        if (!complete) throw new Error("Notification history scan incomplete");
      }
      const posted = await request<{ id: string }>(`/channels/${row.channel_id}/messages`, {
        method: "POST", signal,
        body: { ...notificationMessage(row, declaration), nonce: hashToken(row.id).slice(0, 24), enforce_nonce: true },
      });
      return posted.id;
    },
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;
