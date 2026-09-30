import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Declaration, Notification } from "../src/lib/domain";
import type { JobStore } from "../src/lib/store";
import { runJobs } from "../src/lib/jobs";
import { channelId, discordId, guildId, otherDiscordId, otherGuildId } from "./fixtures";

let db: PGlite;
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ row: T }>(sql, params)).rows[0]?.row ?? null;
const scalar = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ value: T }>(sql, params)).rows[0].value;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(readFileSync(new URL("../supabase/migrations/202609260001_mvp.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/migrations/202609300001_ai_judgement.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/migrations/202610010001_notify_channel.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/migrations/202610020001_notify_channel_mirror.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate public.guild_settings, public.users, public.interaction_receipts restart identity cascade;");
  await db.query("insert into public.guild_settings (guild_id, channel_id) values ($1,$3),($2,$3)", [guildId, otherGuildId, channelId]);
  await db.query("select public.niki_link_github($1,$2,1234,'octocat')", [discordId, guildId]);
  await db.query("select public.niki_link_github($1,$2,5678,'other')", [otherDiscordId, guildId]);
  await db.query("select public.niki_link_github($1,$2,1234,'octocat')", [discordId, otherGuildId]);
});

async function createDeclaration(interaction = "500000000000000001", server = guildId) {
  return (await one<Declaration>("select to_jsonb(d) as row from public.niki_create_declaration($1,$2,$3,'開発する','owner/repo','main',now() + interval '1 day') d", [interaction, server, discordId]))!;
}

async function expiredDeclaration() {
  return (await one<Declaration>(`insert into public.declarations as d
    (interaction_id,guild_id,discord_id,github_id,content,repository,branch,created_at,deadline)
    values ('500000000000000010',$1,$2,1234,'開発','owner/repo','main',now()-interval '2 hours',now()-interval '1 hour')
    returning to_jsonb(d) as row`, [guildId, discordId]))!;
}

const store: JobStore = {
  claimCheck: () => one<Declaration>("select to_jsonb(d) as row from public.niki_claim_check() d"),
  finishCheck: (row, sha, aiReason) => scalar<boolean>("select public.niki_finish_check($1,$2,$3,$4) as value", [row.id, row.lease_token, sha, aiReason ?? null]),
  retryCheck: async (row, error, delay) => { await db.query("select public.niki_retry_check($1,$2,$3,$4)", [row.id, row.lease_token, error, delay]); },
  claimNotification: (declarationId) => one<Notification>("select to_jsonb(n) as row from public.niki_claim_notification($1) n", [declarationId ?? null]),
  getDeclaration: async (id) => (await one<Declaration>("select to_jsonb(d) as row from public.declarations d where id=$1", [id]))!,
  finishNotification: (row, messageId) => scalar<boolean>("select public.niki_finish_notification($1,$2,$3) as value", [row.id, row.lease_token, messageId]),
  retryNotification: async (row, error, delay) => { await db.query("select public.niki_retry_notification($1,$2,$3,$4)", [row.id, row.lease_token, error, delay]); },
};

describe("personal notification channel mirrors the guild channel", () => {
  const personal = "900000000000000001";
  const channels = async () => (await db.query<{ kind: string; channel_id: string }>("select kind, channel_id from public.notifications order by sequence")).rows;
  const setPersonal = (channel: string | null) => db.query("select public.niki_set_notify_channel($1,$2,$3)", [guildId, discordId, channel]);
  it("posts declared and cancelled notifications to the guild default first, then the personal channel", async () => {
    await setPersonal(personal);
    await createDeclaration();
    await db.query("select public.niki_cancel_declaration($1,$2)", [guildId, discordId]);
    expect(await channels()).toEqual([
      { kind: "declared", channel_id: channelId }, { kind: "declared", channel_id: personal },
      { kind: "cancelled", channel_id: channelId }, { kind: "cancelled", channel_id: personal },
    ]);
  });
  it("creates a single row when unset or when the personal channel is the guild default", async () => {
    await createDeclaration();
    expect(await channels()).toEqual([{ kind: "declared", channel_id: channelId }]);
    await db.query("truncate public.notifications, public.declarations cascade");
    await setPersonal(channelId);
    await createDeclaration("500000000000000004");
    expect(await channels()).toEqual([{ kind: "declared", channel_id: channelId }]);
  });
  it("mirrors the result notification once and keeps existing notifications fixed", async () => {
    const expired = await expiredDeclaration();
    await setPersonal(personal);
    const claimed = (await store.claimCheck())!;
    expect(claimed.id).toBe(expired.id);
    await store.finishCheck(claimed, null);
    await setPersonal(null);
    expect(await channels()).toEqual([{ kind: "result", channel_id: channelId }, { kind: "result", channel_id: personal }]);
    await expect(db.query("insert into public.notifications (declaration_id, kind, channel_id) values ($1,'result',$2)", [expired.id, personal])).rejects.toThrow();
  });
  it("does not let a failing personal channel block the guild default channel", async () => {
    await setPersonal(personal);
    const row = await createDeclaration();
    const first = (await store.claimNotification(row.id))!;
    expect(first.channel_id).toBe(channelId);
    await store.finishNotification(first, "1");
    const second = (await store.claimNotification(row.id))!;
    expect(second.channel_id).toBe(personal);
    await store.retryNotification(second, "boom", 60);
    await db.query("select public.niki_cancel_declaration($1,$2)", [guildId, discordId]);
    const next = (await store.claimNotification(row.id))!;
    expect(next).toMatchObject({ kind: "cancelled", channel_id: channelId });
  });
  it("requires an active membership and a valid snowflake", async () => {
    await expect(db.query("select public.niki_set_notify_channel($1,$2,$3)", [otherGuildId, otherDiscordId, personal])).rejects.toThrow("LINK_REQUIRED");
    await expect(db.query("select public.niki_set_notify_channel($1,$2,'abc')", [guildId, discordId])).rejects.toThrow();
  });
});

describe("transactional declaration management", () => {
  it("saves a declaration and notification together and deduplicates its interaction", async () => {
    const row = await createDeclaration();
    expect((await createDeclaration()).id).toBe(row.id);
    expect(await scalar("select count(*)::int as value from public.notifications")).toBe(1);
    await expect(createDeclaration("500000000000000002")).rejects.toThrow();
    expect(await scalar("select count(*)::int as value from public.declarations")).toBe(1);
    expect((await createDeclaration("500000000000000003", otherGuildId)).guild_id).toBe(otherGuildId);
  });
  it("prevents a nonparticipant from declaring and a second Discord user from taking a linked GitHub identity", async () => {
    await expect(db.query("select public.niki_create_declaration('500000000000000020',$1,$2,'開発','owner/repo','main',now()+interval '1 day')", [otherGuildId, otherDiscordId])).rejects.toThrow("LINK_REQUIRED");
    await expect(db.query("select public.niki_link_github($1,$2,1234,'octocat')", [otherDiscordId, guildId])).rejects.toThrow();
  });
  it("cancels only the caller's declaration in the supplied guild, before deadline", async () => {
    const row = await createDeclaration();
    expect(await one("select to_jsonb(d) as row from public.niki_cancel_declaration($1,$2) d", [otherGuildId, discordId])).toBeNull();
    expect(await one("select to_jsonb(d) as row from public.niki_cancel_declaration($1,$2) d", [guildId, otherDiscordId])).toBeNull();
    expect((await one<Declaration>("select to_jsonb(d) as row from public.niki_cancel_declaration($1,$2) d", [guildId, discordId]))?.status).toBe("cancelled");
    expect(await scalar("select count(*)::int as value from public.notifications where declaration_id=$1", [row.id])).toBe(2);
    expect(await store.claimCheck()).toBeNull();
    const expired = await expiredDeclaration();
    expect(await one("select to_jsonb(d) as row from public.niki_cancel_declaration($1,$2) d", [guildId, discordId])).toBeNull();
    expect((await store.getDeclaration(expired.id)).status).toBe("pending");
  });
  it("snapshots the GitHub ID used when declaring", async () => {
    const row = await createDeclaration();
    await db.query("select public.niki_link_github($1,$2,9876,'new-account')", [discordId, guildId]);
    expect((await store.getDeclaration(row.id)).github_id).toBe(1234);
  });
});

describe("leases, retry, and the complete declaration/result loop", () => {
  it("allows one claim, recovers an expired lease, and rejects an old worker", async () => {
    const original = await expiredDeclaration();
    const [first, second] = await Promise.all([store.claimCheck(), store.claimCheck()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const old = (first ?? second)!;
    await db.query("update public.declarations set lease_until=now()-interval '1 second' where id=$1", [original.id]);
    const current = (await store.claimCheck())!;
    expect(await store.finishCheck(old, null)).toBe(false);
    expect(await store.finishCheck(current, "a".repeat(40))).toBe(true);
    expect(await store.finishCheck(current, "a".repeat(40))).toBe(false);
    expect(await scalar("select count(*)::int as value from public.notifications where kind='result'")).toBe(1);
  });
  it.each(["a".repeat(40), null])("saves achievement/failure and posts once, even on repeated cron runs (%s)", async (sha) => {
    const row = await expiredDeclaration();
    const findCommit = vi.fn().mockResolvedValue(sha ? { sha } : null);
    const deliver = vi.fn().mockResolvedValue("600000000000000001");
    expect(await runJobs({ store, findCommit, deliver })).toMatchObject({ checked: 1, notified: 1 });
    expect((await store.getDeclaration(row.id)).status).toBe(sha ? "succeeded" : "failed");
    expect(await runJobs({ store, findCommit, deliver })).toMatchObject({ checked: 0, notified: 0 });
    expect(findCommit).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("keeps GitHub API errors pending and outside failure counts", async () => {
    const row = await expiredDeclaration();
    const findCommit = vi.fn().mockRejectedValue(Object.assign(new Error("secret"), { status: 503 }));
    const deliver = vi.fn();
    expect(await runJobs({ store, findCommit, deliver })).toMatchObject({ checkRetry: 1, notified: 0 });
    expect(await store.getDeclaration(row.id)).toMatchObject({ status: "pending", last_check_error: "External API HTTP 503" });
    expect(deliver).not.toHaveBeenCalled();
    expect(await store.claimCheck()).toBeNull();
  });
  it("retries only the notification after posting fails", async () => {
    const row = await expiredDeclaration();
    const findCommit = vi.fn().mockResolvedValue({ sha: "b".repeat(40) });
    const deliver = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue("600000000000000002");
    expect(await runJobs({ store, findCommit, deliver })).toMatchObject({ checked: 1, notificationRetry: 1 });
    await db.exec("update public.notifications set next_attempt_at=now()");
    expect(await runJobs({ store, findCommit, deliver })).toMatchObject({ checked: 0, notified: 1 });
    expect((await store.getDeclaration(row.id)).status).toBe("succeeded");
    expect(findCommit).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it("delivers declaration and cancellation messages in order", async () => {
    const row = await createDeclaration();
    await db.query("select public.niki_cancel_declaration($1,$2)", [guildId, discordId]);
    const first = (await store.claimNotification(row.id))!;
    expect(first.kind).toBe("declared");
    expect(await store.claimNotification(row.id)).toBeNull();
    await store.finishNotification(first, "600000000000000003");
    expect((await store.claimNotification(row.id))?.kind).toBe("cancelled");
  });
});

describe("OAuth and database access boundaries", () => {
  it("binds single-use state to the browser and enforces expiry", async () => {
    await db.query("insert into public.oauth_sessions(ticket_hash,discord_id,guild_id) values('ticket',$1,$2)", [discordId, guildId]);
    expect(await scalar("select public.niki_begin_oauth('ticket','state','browser','verifier') as value")).toBe(true);
    expect(await scalar("select public.niki_begin_oauth('ticket','state2','browser','verifier') as value")).toBe(false);
    expect(await one("select to_jsonb(s) as row from public.niki_consume_oauth('state','wrong-browser') s")).toBeNull();
    expect(await one("select to_jsonb(s) as row from public.niki_consume_oauth('state','browser') s")).toMatchObject({ discord_id: discordId, guild_id: guildId });
    expect(await one("select to_jsonb(s) as row from public.niki_consume_oauth('state','browser') s")).toBeNull();
    await db.query("insert into public.oauth_sessions(ticket_hash,discord_id,guild_id,expires_at) values('expired',$1,$2,now()-interval '1 second')", [discordId, guildId]);
    expect(await scalar("select public.niki_begin_oauth('expired','new','browser','verifier') as value")).toBe(false);
  });
  it("does not grant public clients table access or job execution", async () => {
    expect(await scalar("select has_table_privilege('anon','public.declarations','select') as value")).toBe(false);
    expect(await scalar("select has_table_privilege('authenticated','public.oauth_sessions','select') as value")).toBe(false);
    expect(await scalar("select has_function_privilege('anon','public.niki_claim_check()','execute') as value")).toBe(false);
    expect(await scalar("select has_function_privilege('service_role','public.niki_claim_check()','execute') as value")).toBe(true);
    expect(await scalar("select has_function_privilege('anon','public.niki_finish_check(uuid,uuid,text,text)','execute') as value")).toBe(false);
    expect(await scalar("select has_function_privilege('service_role','public.niki_finish_check(uuid,uuid,text,text)','execute') as value")).toBe(true);
    expect(await scalar("select relrowsecurity as value from pg_class where oid='public.declarations'::regclass")).toBe(true);
  });
});
