import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWeeklyStore } from "../src/lib/weekly-store";
import type { WeeklyReport } from "../src/lib/weekly-summary";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://database.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps preview read-only and passes the cursor to the paged RPC", async () => {
  const snapshots = [{ guild_id: "100000000000000001", channel_id: "300000000000000001", declaration_count: 0, members: [] }];
  const fetcher = vi.fn().mockResolvedValue(Response.json(snapshots)); vi.stubGlobal("fetch", fetcher);
  expect(await createWeeklyStore().preview("2026-09-28", "100000000000000000")).toEqual(snapshots);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(String(fetcher.mock.calls[0][0])).toContain("/rpc/niki_weekly_preview");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ p_week: "2026-09-28", p_after: "100000000000000000", p_limit: 100 });
});
it("unwraps SETOF claims but preserves scalar completion and preparation results", async () => {
  const row = { id: "id", lease_token: "lease" } as WeeklyReport;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return Response.json(url.endsWith("niki_prepare_weekly") ? 2 : url.endsWith("niki_finish_weekly") ? true : [row]);
  }));
  const store = createWeeklyStore();
  expect(await store.claim()).toEqual(row);
  expect(await store.prepare("2026-09-28")).toBe(2);
  expect(await store.finish(row, "message")).toBe(true);
});
it("returns null for an empty claim", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
  expect(await createWeeklyStore().claim()).toBeNull();
});
it("hides PostgREST details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "private data", code: "XX000" }, { status: 400 })));
  await expect(createWeeklyStore().preview("2026-09-28")).rejects.toThrow("Weekly database operation failed");
});
