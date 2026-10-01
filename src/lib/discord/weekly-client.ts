import "server-only";
import { env } from "../config";
import { hashToken } from "../security";
import { weeklyMarker, weeklyPayload, type WeeklyReport } from "../weekly-summary";
import { createDiscordClient, DiscordApiError } from "./client";

type HistoryMessage = { id: string; timestamp: string; author: { id: string }; embeds: { footer?: { text: string } }[] };

export async function deliverWeekly(row: WeeklyReport, signal: AbortSignal): Promise<string> {
  async function request<T>(path: string, body?: FormData | string): Promise<T> {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
      headers: { Authorization: `Bot ${env("DISCORD_BOT_TOKEN")}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) }, body,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new DiscordApiError(response.status, typeof error.retry_after === "number" ? Math.ceil(error.retry_after) : 60);
    }
    return response.json() as Promise<T>;
  }

  if (row.attempts > 1) {
    // A successful POST followed by a failed DB write must not result in another message.
    const botId = await createDiscordClient().assertChannel(row.guild_id, row.channel_id, signal);
    const earliest = Date.parse(row.first_attempt_at) - 5_000;
    let before = "";
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const messages = await request<HistoryMessage[]>(`/channels/${row.channel_id}/messages?limit=100${before ? `&before=${before}` : ""}`);
      const found = messages.find((message) => message.author.id === botId && message.embeds.some((embed) => embed.footer?.text === weeklyMarker(row.id)));
      if (found) return found.id;
      if (messages.length < 100 || Date.parse(messages.at(-1)!.timestamp) < earliest) { complete = true; break; }
      before = messages.at(-1)!.id;
    }
    if (!complete) throw new Error("Weekly history scan incomplete");
  }

  const { message, attachment } = weeklyPayload(row);
  const payload = { ...message, nonce: hashToken(`weekly:${row.id}`).slice(0, 24), enforce_nonce: true };
  let body: string | FormData = JSON.stringify(payload);
  if (attachment) {
    const filename = `weekly-${row.week_start}.txt`;
    body = new FormData();
    body.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }));
    body.append("files[0]", new Blob([attachment], { type: "text/plain;charset=utf-8" }), filename);
  }
  return (await request<{ id: string }>(`/channels/${row.channel_id}/messages`, body)).id;
}
