import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ assertChannel: vi.fn() }));
vi.mock("../src/lib/discord/client", async (original) => ({ ...await original<typeof import("../src/lib/discord/client")>(), createDiscordClient: () => ({ assertChannel: mocks.assertChannel }) }));
import { deliverWeekly } from "../src/lib/discord/weekly-client";
import { weeklyMarker, type WeeklyReport } from "../src/lib/weekly-summary";

const row: WeeklyReport = { id: "weekly-id", guild_id: "100000000000000001", channel_id: "300000000000000001", week_start: "2026-09-28", attempts: 1,
  first_attempt_at: "2026-10-05T00:00:00Z", lease_token: "lease",
  snapshot: { guild_id: "100000000000000001", channel_id: "300000000000000001", declaration_count: 0, members: [] } };
const signal = () => AbortSignal.timeout(10_000);
beforeEach(() => { vi.stubEnv("DISCORD_BOT_TOKEN", "test-token"); mocks.assertChannel.mockResolvedValue("bot-id"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("sends one message with a stable nonce and no mass pings", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "posted" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await deliverWeekly(row, signal())).toBe("posted");
  expect(fetcher).toHaveBeenCalledOnce();
  const body = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(body).toMatchObject({ enforce_nonce: true, allowed_mentions: { parse: [] } });
  expect(body.nonce).toHaveLength(24);
  expect(body.embeds[0].footer.text).toBe(weeklyMarker(row.id));
});
it("finds the bot's earlier post after delivery succeeded but DB completion failed", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([{ id: "already-posted", author: { id: "bot-id" }, timestamp: row.first_attempt_at,
    embeds: [{ footer: { text: weeklyMarker(row.id) } }] }]));
  vi.stubGlobal("fetch", fetcher);
  expect(await deliverWeekly({ ...row, attempts: 2 }, signal())).toBe("already-posted");
  expect(fetcher.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
});
it("ignores a forged marker from another author and sends only after a complete scan", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ id: "forged", author: { id: "other" }, timestamp: row.first_attempt_at,
    embeds: [{ footer: { text: weeklyMarker(row.id) } }] }])).mockResolvedValueOnce(Response.json({ id: "posted" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await deliverWeekly({ ...row, attempts: 2 }, signal())).toBe("posted");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not send if history cannot be fully checked", async () => {
  const fetcher = vi.fn(async () => Response.json(Array.from({ length: 100 }, (_, i) => ({ id: String(i), author: { id: "bot-id" }, timestamp: row.first_attempt_at, embeds: [] }))));
  vi.stubGlobal("fetch", fetcher);
  await expect(deliverWeekly({ ...row, attempts: 2 }, signal())).rejects.toThrow("scan incomplete");
  expect(fetcher).toHaveBeenCalledTimes(10);
});
it("does not send without history permissions on a retry", async () => {
  mocks.assertChannel.mockRejectedValueOnce(new Error("missing permission"));
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(deliverWeekly({ ...row, attempts: 2 }, signal())).rejects.toThrow("missing permission");
  expect(fetcher).not.toHaveBeenCalled();
});
it("sends a full large report as an attachment in the same post", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "posted" })); vi.stubGlobal("fetch", fetcher);
  const members = Array.from({ length: 100 }, (_, i) => ({ discord_id: String(200000000000000001n + BigInt(i)), github_login: `member${i}`, succeeded: 1, failed: 0 }));
  await deliverWeekly({ ...row, snapshot: { ...row.snapshot, declaration_count: 100, members } }, signal());
  const body = fetcher.mock.calls[0][1].body as FormData;
  expect(body).toBeInstanceOf(FormData);
  expect(await (body.get("files[0]") as Blob).text()).toContain("member99");
  expect(JSON.parse(body.get("payload_json") as string).content.length).toBeLessThanOrEqual(2000);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("propagates rate limits without exposing response bodies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ retry_after: 120, message: "private" }, { status: 429 })));
  await expect(deliverWeekly(row, signal())).rejects.toMatchObject({ status: 429, retryAfter: 120, message: "Discord API HTTP 429" });
});
