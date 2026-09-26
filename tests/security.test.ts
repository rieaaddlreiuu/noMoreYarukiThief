import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { equalSecret, hashToken, pkceChallenge, randomToken, safeError, verifyDiscordRequest } from "../src/lib/security";
import { BOT_PERMISSIONS, canSetup, channelPermissions } from "../src/lib/discord/permissions";
import { guildId, applicationId } from "./fixtures";

describe("Discord signature verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const now = 1_790_424_000_000;
  const timestamp = String(now / 1000);
  const body = '{"type":1}';
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const headers = new Headers({ "x-signature-ed25519": signature, "x-signature-timestamp": timestamp });
  it("accepts a valid raw-body signature", async () => expect(await verifyDiscordRequest(body, headers, key, now)).toBe(true));
  it("rejects altered bodies, expired timestamps, and malformed signatures", async () => {
    expect(await verifyDiscordRequest(body + " ", headers, key, now)).toBe(false);
    expect(await verifyDiscordRequest(body, headers, key, now + 301_000)).toBe(false);
    expect(await verifyDiscordRequest(body, new Headers(), key, now)).toBe(false);
  });
});

it("uses opaque hashed tokens and standard S256 PKCE", () => {
  expect(randomToken()).toHaveLength(43);
  expect(hashToken("ticket")).toHaveLength(64);
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  expect(equalSecret("a", "a")).toBe(true);
  expect(equalSecret("a", "ab")).toBe(false);
  expect(safeError(Object.assign(new Error("TOKEN_SECRET"), { status: 429 }))).toBe("External API HTTP 429");
  expect(safeError(new Error("TOKEN_SECRET"))).not.toContain("TOKEN_SECRET");
});

describe("Discord permission boundaries", () => {
  it("requires manage-guild or administrator to set up", () => {
    expect(canSetup("0")).toBe(false);
    expect(canSetup("32")).toBe(true);
    expect(canSetup("8")).toBe(true);
    expect(canSetup("16")).toBe(false);
  });
  it("applies everyone, aggregate role, and member overwrites in order", () => {
    const roles = [{ id: guildId, permissions: BOT_PERMISSIONS.toString() }, { id: "role", permissions: "0" }];
    const overwrites = [{ id: guildId, type: 0, allow: "0", deny: "2048" }, { id: "role", type: 0, allow: "2048", deny: "0" }];
    expect(channelPermissions(guildId, applicationId, ["role"], roles, overwrites)).toBe(BOT_PERMISSIONS);
    overwrites.push({ id: applicationId, type: 1, allow: "0", deny: "65536" });
    expect(channelPermissions(guildId, applicationId, ["role"], roles, overwrites) & 65536n).toBe(0n);
  });
});
