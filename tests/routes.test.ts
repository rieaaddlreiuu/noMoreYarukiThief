import { generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applicationId, discordId, guildId } from "./fixtures";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), createStore: vi.fn(), cleanup: vi.fn(), beginOAuth: vi.fn(), consumeOAuth: vi.fn(), linkGitHub: vi.fn(),
  exchangeGitHubCode: vi.fn(), assertMember: vi.fn(), runJobs: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: mocks.after }));
vi.mock("../src/lib/store", () => ({ createStore: mocks.createStore }));
vi.mock("../src/lib/github", () => ({ validateRepository: vi.fn(), findQualifyingCommit: vi.fn(), exchangeGitHubCode: mocks.exchangeGitHubCode }));
vi.mock("../src/lib/jobs", () => ({ runJobs: mocks.runJobs, dispatchNotifications: vi.fn() }));
vi.mock("../src/lib/discord/client", () => ({ createDiscordClient: () => ({ assertMember: mocks.assertMember, deliver: vi.fn() }) }));

import { POST as discordPost } from "../src/app/api/discord/interactions/route";
import { POST as jobsPost } from "../src/app/api/jobs/evaluate/route";
import { GET as oauthStart, HEAD as oauthStartHead, POST as oauthStartPost } from "../src/app/api/github/start/route";
import { GET as oauthCallback } from "../src/app/api/github/callback/route";
import { oauthCookieName } from "../src/lib/oauth-response";

beforeEach(() => {
  mocks.createStore.mockReturnValue({ cleanup: mocks.cleanup, beginOAuth: mocks.beginOAuth, consumeOAuth: mocks.consumeOAuth, linkGitHub: mocks.linkGitHub });
  mocks.runJobs.mockResolvedValue({ checked: 1, notified: 1 });
  vi.stubEnv("APP_URL", "https://niki.example");
  vi.stubEnv("DISCORD_APPLICATION_ID", applicationId);
  vi.stubEnv("GITHUB_CLIENT_ID", "test-client");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-secret");
});
afterEach(() => vi.unstubAllEnvs());

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
function signedRequest(payload: unknown) {
  vi.stubEnv("DISCORD_PUBLIC_KEY", publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"));
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://niki.example/api/discord/interactions", { method: "POST", body, headers: {
    "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"), "x-signature-timestamp": timestamp,
  } });
}

describe("Discord HTTP entry point", () => {
  it("handles signed PING without a database or bot token", async () => {
    expect(await (await discordPost(signedRequest({ type: 1 }))).json()).toEqual({ type: 1 });
    expect(mocks.createStore).not.toHaveBeenCalled();
  });
  it("defers ephemeral replies before any network/database work", async () => {
    const payload = { id: "500000000000000001", application_id: applicationId, type: 2, token: "test", guild_id: guildId,
      member: { user: { id: discordId }, permissions: "0" }, data: { name: "niki", options: [{ type: 1, name: "status" }] } };
    expect(await (await discordPost(signedRequest(payload))).json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect((await discordPost(signedRequest({ ...payload, application_id: "400000000000000002" }))).status).toBe(401);
  });
  it("rejects requests without a valid signature", async () => {
    signedRequest({ type: 1 });
    expect((await discordPost(new Request("https://niki.example/api/discord/interactions", { method: "POST", body: '{"type":1}' }))).status).toBe(401);
  });
});

describe("scheduled endpoint authentication", () => {
  it("rejects wrong/missing secrets before touching the database", async () => {
    vi.stubEnv("CRON_SECRET", "x".repeat(64));
    expect((await jobsPost(new Request("https://niki.example/api/jobs/evaluate", { method: "POST" }))).status).toBe(401);
    expect(mocks.createStore).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", "short");
    expect((await jobsPost(new Request("https://niki.example/api/jobs/evaluate", { method: "POST" }))).status).toBe(503);
  });
  it("runs the persisted job queue with the configured bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "x".repeat(64));
    const result = await jobsPost(new Request("https://niki.example/api/jobs/evaluate", { method: "POST", headers: { authorization: `Bearer ${"x".repeat(64)}` } }));
    expect(result.status).toBe(200);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.runJobs).toHaveBeenCalledOnce();
  });
});

describe("GitHub OAuth routes", () => {
  const state = "s".repeat(43);
  const browser = "b".repeat(43);
  const ticket = "t".repeat(43);
  function startPost(value = ticket, origin: string | null = "https://niki.example") {
    return new NextRequest("https://niki.example/api/github/start", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body: new URLSearchParams({ ticket: value }),
    });
  }
  function callback(query = `state=${state}&code=code`) {
    return new NextRequest(`https://niki.example/api/github/callback?${query}`, { headers: { cookie: `${oauthCookieName(state)}=${browser}` } });
  }
  it("keeps tickets untouched when previews request HEAD or repeated GETs", async () => {
    const url = `https://niki.example/api/github/start?ticket=${ticket}`;
    const head = oauthStartHead(new NextRequest(url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (let i = 0; i < 2; i++) {
      const response = oauthStart(new NextRequest(url));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://github.com");
      const html = await response.text();
      expect(html).toContain('<form action="/api/github/start" method="post">');
      expect(html).toContain(`name="ticket" value="${ticket}"`);
      expect(html).toContain("GitHubで連携する");
    }
    expect(mocks.createStore).not.toHaveBeenCalled();
    expect(mocks.beginOAuth).not.toHaveBeenCalled();
  });
  it("starts OAuth only on confirmation and redirects the POST as a GET with PKCE", async () => {
    mocks.beginOAuth.mockResolvedValue(true);
    const response = await oauthStartPost(startPost());
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("redirect_uri")).toBe("https://niki.example/api/github/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toHaveLength(43);
    expect(location.searchParams.get("scope")).toBe("");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.beginOAuth).toHaveBeenCalledOnce();
  });
  it("rejects cross-site and malformed submissions before consuming a ticket", async () => {
    expect((await oauthStartPost(startPost(ticket, "https://other.example"))).status).toBe(403);
    expect((await oauthStartPost(startPost(ticket, null))).status).toBe(403);
    expect((await oauthStartPost(startPost("invalid"))).status).toBe(400);
    expect((await oauthStartPost(new NextRequest("https://niki.example/api/github/start", {
      method: "POST", headers: { origin: "https://niki.example", "content-type": "application/json" }, body: "{}",
    }))).status).toBe(400);
    expect(oauthStart(new NextRequest("https://niki.example/api/github/start?ticket=invalid")).status).toBe(400);
    expect(mocks.createStore).not.toHaveBeenCalled();
  });
  it("preserves the single-use restriction after the confirmation is submitted", async () => {
    mocks.beginOAuth.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await oauthStartPost(startPost())).status).toBe(303);
    const repeated = await oauthStartPost(startPost());
    expect(repeated.status).toBe(400);
    expect(await repeated.text()).toContain("リンクが期限切れ、または使用済みです");
  });
  it("rejects expired tickets and missing browser state", async () => {
    mocks.beginOAuth.mockResolvedValue(false);
    expect((await oauthStartPost(startPost())).status).toBe(400);
    expect((await oauthCallback(new NextRequest(`https://niki.example/api/github/callback?state=${state}&code=code`))).status).toBe(400);
    expect(mocks.exchangeGitHubCode).not.toHaveBeenCalled();
  });
  it("links the revalidated GitHub identity to the stored Discord user/guild only", async () => {
    mocks.consumeOAuth.mockResolvedValue({ discord_id: discordId, guild_id: guildId, code_verifier: "verifier" });
    mocks.exchangeGitHubCode.mockResolvedValue({ id: 1234, login: "octocat" });
    const response = await oauthCallback(callback());
    expect(response.status).toBe(200);
    expect(mocks.exchangeGitHubCode).toHaveBeenCalledWith("code", "verifier");
    expect(mocks.assertMember).toHaveBeenCalledWith(guildId, discordId);
    expect(mocks.linkGitHub).toHaveBeenCalledWith(discordId, guildId, 1234, "octocat");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("rejects replay and treats denied authorization as a cancellation", async () => {
    mocks.consumeOAuth.mockResolvedValueOnce(null);
    expect((await oauthCallback(callback())).status).toBe(400);
    expect(mocks.exchangeGitHubCode).not.toHaveBeenCalled();
    mocks.consumeOAuth.mockResolvedValueOnce({ discord_id: discordId, guild_id: guildId, code_verifier: "verifier" });
    expect((await oauthCallback(callback(`state=${state}&error=access_denied`))).status).toBe(400);
    expect(mocks.linkGitHub).not.toHaveBeenCalled();
  });
});
