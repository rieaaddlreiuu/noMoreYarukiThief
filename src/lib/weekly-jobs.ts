import { retryDelay } from "./domain";
import { safeError } from "./security";
import { previousWeek, type WeeklyReport } from "./weekly-summary";
import type { WeeklyStore } from "./weekly-store";

export async function runWeeklyJobs(deps: {
  store: WeeklyStore; deliver: (row: WeeklyReport, signal: AbortSignal) => Promise<string>;
}, now = new Date(), budgetMs = 40_000) {
  const until = Date.now() + budgetMs;
  const week = previousWeek(now);
  const counts = { prepared: 0, sent: 0, retry: 0, stale: 0 };
  console.log("[weekly] run", { weekStart: week.weekStart });
  // Each server's delivery day/hour is checked by the database; only servers that are due get a report.
  counts.prepared = await deps.store.prepare(week.weekStart);
  for (let i = 0; i < 10 && Date.now() < until - 10_000; i++) {
    const row = await deps.store.claim();
    if (!row) break;
    try {
      const id = await deps.deliver(row, AbortSignal.timeout(Math.max(1, Math.min(15_000, until - Date.now() - 8_000))));
      if (await deps.store.finish(row, id)) counts.sent++;
      else counts.stale++;
    } catch (error) {
      const e = error as { name?: string; status?: number; message?: string } | null;
      console.error("[weekly] delivery failed", { attempts: row.attempts, type: e?.constructor?.name, status: e?.status, message: e?.message?.slice(0, 200) });
      const requested = error && typeof error === "object" && "retryAfter" in error ? Number(error.retryAfter) : 0;
      await deps.store.retry(row, safeError(error), Math.max(retryDelay(row.attempts), Number.isFinite(requested) ? requested : 0));
      counts.retry++;
    }
  }
  return counts;
}
