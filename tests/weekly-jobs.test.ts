import { expect, it, vi } from "vitest";
import { runWeeklyJobs } from "../src/lib/weekly-jobs";
import type { WeeklyStore } from "../src/lib/weekly-store";
import type { WeeklyReport } from "../src/lib/weekly-summary";

const row = { id: "id", lease_token: "lease", attempts: 1 } as WeeklyReport;
function dependencies() {
  const store: WeeklyStore = { preview: vi.fn(), prepare: vi.fn().mockResolvedValue(1), claim: vi.fn().mockResolvedValueOnce(row).mockResolvedValue(null),
    finish: vi.fn().mockResolvedValue(true), retry: vi.fn().mockResolvedValue(undefined) };
  return { store, deliver: vi.fn().mockResolvedValue("message") };
}
it("always prepares the previous week and leaves each server's delivery time to the database", async () => {
  const deps = dependencies();
  expect(await runWeeklyJobs(deps, new Date("2026-10-09T09:00:00Z"))).toEqual({ prepared: 1, sent: 1, retry: 0, stale: 0 });
  expect(deps.store.prepare).toHaveBeenCalledWith("2026-09-28");
  expect(deps.store.finish).toHaveBeenCalledWith(row, "message");
});
it("continues to other reports after a delivery error, sanitizing saved errors", async () => {
  const deps = dependencies();
  vi.mocked(deps.store.claim).mockReset().mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, id: "other" }).mockResolvedValue(null);
  deps.deliver.mockRejectedValueOnce(Object.assign(new Error("secret token"), { status: 429, retryAfter: 300 }));
  expect(await runWeeklyJobs(deps)).toMatchObject({ sent: 1, retry: 1 });
  expect(deps.store.retry).toHaveBeenCalledWith(row, "External API HTTP 429", 300);
});
it("retains pending work when Discord succeeds but completion fails", async () => {
  const deps = dependencies();
  vi.mocked(deps.store.finish).mockRejectedValueOnce(new Error("database unavailable"));
  expect(await runWeeklyJobs(deps)).toMatchObject({ sent: 0, retry: 1 });
  expect(deps.store.retry).toHaveBeenCalledWith(row, "Processing failed", 60);
});
it("does not report stale work as sent and bounds execution", async () => {
  const deps = dependencies();
  vi.mocked(deps.store.finish).mockResolvedValue(false);
  expect(await runWeeklyJobs(deps)).toMatchObject({ stale: 1, sent: 0 });
  const short = dependencies();
  await runWeeklyJobs(short, new Date(), 0);
  expect(short.store.claim).not.toHaveBeenCalled();
});
