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
  // No posting of the just-ended week before Monday 09:00 JST. Older retries can still drain.
  if (now.getTime() >= Date.parse(week.dueAt)) counts.prepared = await deps.store.prepare(week.weekStart);
  for (let i = 0; i < 10 && Date.now() < until - 10_000; i++) {
    const row = await deps.store.claim();
    if (!row) break;
    try {
      const id = await deps.deliver(row, AbortSignal.timeout(Math.max(1, Math.min(15_000, until - Date.now() - 8_000))));
      if (await deps.store.finish(row, id)) counts.sent++;
      else counts.stale++;
    } catch (error) {
      const requested = error && typeof error === "object" && "retryAfter" in error ? Number(error.retryAfter) : 0;
      await deps.store.retry(row, safeError(error), Math.max(retryDelay(row.attempts), Number.isFinite(requested) ? requested : 0));
      counts.retry++;
    }
  }
  return counts;
}
