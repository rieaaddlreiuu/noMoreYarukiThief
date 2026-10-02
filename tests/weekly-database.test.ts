import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WeeklyReport, WeeklySnapshot } from "../src/lib/weekly-summary";

let db: PGlite;
const guild = "100000000000000001", other = "100000000000000002", user = "200000000000000001", user2 = "200000000000000002";
const query = async <T>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows;
const preview = () => query<WeeklySnapshot>("select * from public.niki_weekly_preview('2026-09-28')");
const claim = async () => (await query<WeeklyReport>("select * from public.niki_claim_weekly()"))[0] ?? null;
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const name of ["202609260001_mvp.sql", "202609300001_ai_judgement.sql", "202610010001_notify_channel.sql", "202610020001_notify_channel_mirror.sql", "202610030001_weekly_summary.sql", "202610040001_early_check.sql", "202610050001_github_token.sql", "202610060001_weekly_schedule.sql"]) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("truncate public.guild_settings, public.users cascade;");
  await db.query("insert into public.guild_settings values ($1,'300000000000000001',now()),($2,'300000000000000002',now())", [guild, other]);
  await db.query("select public.niki_link_github($1,$2,1,'first')", [user, guild]);
  await db.query("select public.niki_link_github($1,$2,2,'second')", [user2, guild]);
  await db.query("select public.niki_link_github($1,$2,1,'first')", [user, other]);
});

async function add(deadline: string, status = "succeeded", server = guild, member = user) {
  await db.query(`insert into public.declarations (interaction_id,guild_id,discord_id,github_id,content,repository,branch,created_at,deadline,status,commit_sha)
    values(gen_random_uuid()::text,$1,$2,1,'test','owner/repo','main','2020-01-01',$3,$4,$5)`, [server, member, deadline, status, status === "succeeded" ? "a".repeat(40) : null]);
}

it("uses deadline, not creation time; includes JST Sunday 23:59 and excludes next Monday 00:00", async () => {
  await add("2026-09-27T14:59:59.999Z"); // Before start.
  await add("2026-09-27T15:00:00Z"); // Monday 00:00 JST.
  await add("2026-10-04T14:59:00Z", "failed");
  await add("2026-10-04T14:59:59.999Z");
  await add("2026-10-04T15:00:00Z", "failed");
  await add("2026-10-01T00:00:00Z", "pending");
  await add("2026-10-02T00:00:00Z", "cancelled");
  await add("2026-10-02T00:00:00Z", "failed", other);
  const rows = await preview();
  expect(rows[0]).toMatchObject({ guild_id: guild, declaration_count: 5, members: [
    { discord_id: user, succeeded: 2, failed: 1 }, { discord_id: user2, succeeded: 0, failed: 0 },
  ] });
  expect(rows[1]).toMatchObject({ guild_id: other, declaration_count: 1, members: [{ succeeded: 0, failed: 1 }] });
  expect(await query("select * from public.weekly_reports")).toHaveLength(0);
});

it("retains finalized contributions from inactive members", async () => {
  await add("2026-10-01T00:00:00Z");
  await db.query("update public.memberships set active=false where guild_id=$1", [guild]);
  expect((await preview())[0].members).toEqual([{ discord_id: user, github_login: "first", succeeded: 1, failed: 0 }]);
});

it("pages guilds without losing servers and validates live week dates", async () => {
  expect(await query("select * from public.niki_weekly_preview('2026-09-28',$1,1)", [guild])).toMatchObject([{ guild_id: other }]);
  await expect(db.query("select public.niki_prepare_weekly('2999-01-07')")).rejects.toThrow();
  await expect(db.query("select public.niki_prepare_weekly('2020-01-07')")).rejects.toThrow();
});

it("freezes snapshots/channels and creates only one report per server and week", async () => {
  await Promise.all([db.query("select public.niki_prepare_weekly('2020-01-06')"), db.query("select public.niki_prepare_weekly('2020-01-06')")]);
  expect(await query("select * from public.weekly_reports")).toHaveLength(2);
  await db.query("update public.guild_settings set channel_id='300000000000000009'");
  await add("2020-01-07T00:00:00Z");
  await db.query("select public.niki_prepare_weekly('2020-01-06')");
  expect(await query("select channel_id,snapshot->>'declaration_count' as count from public.weekly_reports where guild_id=$1", [guild]))
    .toEqual([{ channel_id: "300000000000000001", count: "0" }]);
});

it("leases work exclusively, rejects stale completion, and never reclaims sent reports", async () => {
  await db.query("delete from public.guild_settings where guild_id=$1", [other]);
  await db.query("select public.niki_prepare_weekly('2020-01-06')");
  const [a, b] = await Promise.all([claim(), claim()]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  const old = (a ?? b)!;
  await db.query("update public.weekly_reports set lease_until=now()-interval '1 second'");
  const fresh = (await claim())!;
  expect(fresh.attempts).toBe(2);
  expect(await query("select public.niki_finish_weekly($1,$2,'msg') as ok", [old.id, old.lease_token])).toEqual([{ ok: false }]);
  expect(await query("select public.niki_finish_weekly($1,$2,'msg') as ok", [fresh.id, fresh.lease_token])).toEqual([{ ok: true }]);
  await db.query("select public.niki_prepare_weekly('2020-01-06')");
  expect(await claim()).toBeNull();
});

it("retries failures without changing the saved report and isolates other servers", async () => {
  await db.query("select public.niki_prepare_weekly('2020-01-06')");
  const first = (await claim())!;
  await db.query("select public.niki_retry_weekly($1,$2,'failed',60)", [first.id, first.lease_token]);
  const second = (await claim())!;
  expect(second.guild_id).not.toBe(first.guild_id);
  await db.query("select public.niki_finish_weekly($1,$2,'msg')", [second.id, second.lease_token]);
  expect(await claim()).toBeNull();
  await db.query("update public.weekly_reports set next_attempt_at=now() where id=$1", [first.id]);
  const retry = (await claim())!;
  expect(retry.id).toBe(first.id);
  expect(retry.snapshot).toEqual(first.snapshot);
});

it("restricts data and functions to the backend role", async () => {
  expect(await query("select has_table_privilege('anon','public.weekly_reports','select') as ok")).toEqual([{ ok: false }]);
  expect(await query("select has_table_privilege('authenticated','public.weekly_reports','insert') as ok")).toEqual([{ ok: false }]);
  expect(await query("select relrowsecurity as ok from pg_class where oid='public.weekly_reports'::regclass")).toEqual([{ ok: true }]);
  for (const fn of ["niki_weekly_preview(date,text,integer,boolean)", "niki_prepare_weekly(date)", "niki_claim_weekly()", "niki_finish_weekly(uuid,uuid,text)", "niki_retry_weekly(uuid,uuid,text,integer)"]) {
    expect(await query("select has_function_privilege('anon',$1,'execute') as ok", [`public.${fn}`])).toEqual([{ ok: false }]);
    expect(await query("select has_function_privilege('service_role',$1,'execute') as ok", [`public.${fn}`])).toEqual([{ ok: true }]);
  }
});

it("prepares more than 100 servers over repeated runs without starvation", async () => {
  await db.exec(`insert into public.guild_settings (guild_id,channel_id)
    select (100000000000000100::bigint + n)::text, '300000000000000001' from generate_series(1,105) n;`);
  expect(await query("select public.niki_prepare_weekly('2020-01-06') as count")).toEqual([{ count: 100 }]);
  expect(await query("select public.niki_prepare_weekly('2020-01-06') as count")).toEqual([{ count: 7 }]);
  expect(await query("select public.niki_prepare_weekly('2020-01-06') as count")).toEqual([{ count: 0 }]);
  expect(await query("select * from public.weekly_reports")).toHaveLength(107);
});

describe("per-server delivery schedule", () => {
  // Week 2026-09-28 ends 2026-10-05 00:00 JST; Friday 18:00 JST is 2026-10-09T09:00Z.
  const setSchedule = (server: string, day: number, hour: number, enabled = true) =>
    db.query("update public.guild_settings set weekly_day=$2, weekly_hour=$3, weekly_enabled=$4 where guild_id=$1", [server, day, hour, enabled]);

  it("defaults to Monday 09:00 JST, enabled", async () => {
    expect(await query("select weekly_day, weekly_hour, weekly_enabled from public.guild_settings where guild_id=$1", [guild]))
      .toEqual([{ weekly_day: 1, weekly_hour: 9, weekly_enabled: true }]);
  });

  it("prepares only servers whose own delivery time has passed", async () => {
    await setSchedule(other, 7, 23);
    // Past weeks are always due for the Monday 09:00 default; the Sunday 23:00 server is due 6 days 14 hours later.
    const recent = "(date_trunc('week', now() at time zone 'Asia/Tokyo') - interval '7 days')::date";
    const [{ week }] = await query<{ week: string }>(`select to_char(${recent}, 'YYYY-MM-DD') as week`);
    const rows = await query<{ guild_id: string }>("select guild_id from public.niki_weekly_preview($1::date,'',100,true)", [week]);
    const due = (day: number, hour: number) => Date.parse(`${week}T00:00:00+09:00`) + 7 * 86_400_000 + (day - 1) * 86_400_000 + hour * 3_600_000 <= Date.now();
    expect(rows.some((row) => row.guild_id === guild)).toBe(due(1, 9));
    expect(rows.some((row) => row.guild_id === other)).toBe(due(7, 23));
  });

  it("does not prepare disabled servers or claim their pending reports until re-enabled", async () => {
    await setSchedule(other, 1, 9, false);
    expect(await query("select public.niki_prepare_weekly('2020-01-06') as count")).toEqual([{ count: 1 }]);
    expect(await query("select guild_id from public.weekly_reports")).toEqual([{ guild_id: guild }]);
    await setSchedule(guild, 1, 9, false);
    expect(await claim()).toBeNull();
    await setSchedule(guild, 1, 9, true);
    expect((await claim())?.guild_id).toBe(guild);
  });

  it("does not post again when the schedule changes after the week was prepared", async () => {
    await db.query("select public.niki_prepare_weekly('2020-01-06')");
    await setSchedule(guild, 5, 18);
    expect(await query("select public.niki_prepare_weekly('2020-01-06') as count")).toEqual([{ count: 0 }]);
    expect(await query("select * from public.weekly_reports")).toHaveLength(2);
  });

  it("refuses to prepare a week that has not ended yet", async () => {
    await expect(db.query("select public.niki_prepare_weekly('2999-01-07')")).rejects.toThrow();
  });

  it("rejects out-of-range settings", async () => {
    await expect(setSchedule(guild, 8, 9)).rejects.toThrow();
    await expect(setSchedule(guild, 1, 24)).rejects.toThrow();
  });
});
