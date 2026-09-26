import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordClient } from "../src/lib/discord/client";
import { notificationMarker } from "../src/lib/discord/messages";
import { BOT_PERMISSIONS } from "../src/lib/discord/permissions";
import { applicationId, channelId, declaration, guildId, notification } from "./fixtures";

beforeEach(() => vi.stubEnv("DISCORD_BOT_TOKEN", "test-only-token"));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function mockApi(history: unknown[], permissions = BOT_PERMISSIONS) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/users/@me")) return Response.json({ id: applicationId });
    if (url.endsWith(`/channels/${channelId}`)) return Response.json({ id: channelId, guild_id: guildId, type: 0, permission_overwrites: [] });
    if (url.endsWith("/roles")) return Response.json([{ id: guildId, permissions: permissions.toString() }]);
    if (url.includes("/members/")) return Response.json({ roles: [] });
    if (init?.method === "POST") return Response.json({ id: "600000000000000001" });
    return Response.json(history);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("durable notification deduplication", () => {
  it("sends a stable nonce and allows only the declarer's mention", async () => {
    const fetcher = mockApi([]);
    const id = await createDiscordClient().deliver(notification(), declaration({ status: "succeeded", commit_sha: "a".repeat(40) }), AbortSignal.timeout(1000));
    expect(id).toBe("600000000000000001");
    const body = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(body.nonce).toHaveLength(24);
    expect(body.enforce_nonce).toBe(true);
    expect(body.allowed_mentions.parse).toEqual([]);
  });
  it("finds an already-posted event after a worker crash without reposting", async () => {
    const row = notification({ attempts: 2 });
    const fetcher = mockApi([{ id: "600000000000000099", timestamp: row.created_at, author: { id: applicationId }, embeds: [{ footer: { text: notificationMarker(row.id) } }] }]);
    expect(await createDiscordClient().deliver(row, declaration(), AbortSignal.timeout(1000))).toBe("600000000000000099");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it("does not treat another user's copied marker as its own message", async () => {
    const row = notification({ attempts: 2 });
    const fetcher = mockApi([{ id: "600000000000000099", timestamp: row.created_at, author: { id: "other" }, embeds: [{ footer: { text: notificationMarker(row.id) } }] }]);
    await createDiscordClient().deliver(row, declaration(), AbortSignal.timeout(1000));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });
  it("holds a retry if history is inaccessible or the scan is incomplete", async () => {
    const row = notification({ attempts: 2 });
    let fetcher = mockApi([], BOT_PERMISSIONS & ~65536n);
    await expect(createDiscordClient().deliver(row, declaration(), AbortSignal.timeout(1000))).rejects.toThrow("権限");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fetcher = mockApi(Array.from({ length: 100 }, (_, i) => ({ id: `600000000000000${String(i).padStart(3, "0")}`, timestamp: row.created_at, author: { id: applicationId }, embeds: [] })));
    await expect(createDiscordClient().deliver(row, declaration(), AbortSignal.timeout(1000))).rejects.toThrow("incomplete");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
