import type { JobStore } from "./store";
import { type Declaration, type Notification, retryDelay } from "./domain";
import { safeError } from "./security";

export type JobDependencies = {
  store: JobStore;
  findCommit: (row: Declaration, signal: AbortSignal) => Promise<{ sha: string; aiReason?: string } | null>;
  deliver: (row: Notification, declaration: Declaration, signal: AbortSignal) => Promise<string>;
};

function delayFor(error: unknown, attempts: number) {
  const external = error as { retryAfter?: number; response?: { headers?: Record<string, string> } } | null;
  const headers = external?.response?.headers;
  const rateReset = headers?.["x-ratelimit-remaining"] === "0" ? Number(headers["x-ratelimit-reset"]) - Date.now() / 1000 : 0;
  const requested = Math.max(Number(external?.retryAfter) || 0, Number(headers?.["retry-after"]) || 0, rateReset || 0);
  return Math.ceil(Math.min(86_400, Math.max(retryDelay(attempts), requested)));
}

async function checkOne(deps: JobDependencies, row: Declaration, deadline: number) {
  try {
    const result = await deps.findCommit(row, AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))));
    return await deps.store.finishCheck(row, result?.sha ?? null, result?.aiReason) ? "checked" : "stale";
  } catch (error) {
    await deps.store.retryCheck(row, safeError(error), delayFor(error, row.check_attempts));
    return "checkRetry";
  }
}

async function notifyOne(deps: Pick<JobDependencies, "store" | "deliver">, row: Notification, deadline: number) {
  try {
    const declaration = await deps.store.getDeclaration(row.declaration_id);
    const messageId = await deps.deliver(row, declaration, AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))));
    return await deps.store.finishNotification(row, messageId) ? "notified" : "stale";
  } catch (error) {
    await deps.store.retryNotification(row, safeError(error), delayFor(error, row.attempts));
    return "notificationRetry";
  }
}

export async function runJobs(deps: JobDependencies, { budgetMs = 40_000, maxRounds = 10 } = {}) {
  const deadline = Date.now() + budgetMs;
  const counts = { checked: 0, checkRetry: 0, notified: 0, notificationRetry: 0, stale: 0 };
  for (let round = 0; round < maxRounds && Date.now() < deadline - 3_000; round++) {
    const check = await deps.store.claimCheck();
    if (check) counts[await checkOne(deps, check, deadline)]++;
    if (Date.now() >= deadline - 3_000) break;
    const notification = await deps.store.claimNotification();
    if (notification) counts[await notifyOne(deps, notification, deadline)]++;
    if (!check && !notification) break;
  }
  return counts;
}

export async function dispatchNotifications(deps: Pick<JobDependencies, "store" | "deliver">, declarationId: string) {
  const deadline = Date.now() + 15_000;
  for (let count = 0; count < 3 && Date.now() < deadline - 3_000; count++) {
    const row = await deps.store.claimNotification(declarationId);
    if (!row) break;
    await notifyOne(deps, row, deadline);
  }
}
