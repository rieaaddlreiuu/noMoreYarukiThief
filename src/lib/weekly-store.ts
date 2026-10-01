import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "./config";
import type { WeeklyReport, WeeklySnapshot } from "./weekly-summary";

export function createWeeklyStore() {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) },
  });
  async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error("Weekly database operation failed");
    return data as T;
  }
  return {
    preview: (week: string, after = "") => rpc<WeeklySnapshot[]>("niki_weekly_preview", { p_week: week, p_after: after, p_limit: 100 }),
    prepare: (week: string) => rpc<number>("niki_prepare_weekly", { p_week: week }),
    async claim(): Promise<WeeklyReport | null> { return (await rpc<WeeklyReport[]>("niki_claim_weekly"))[0] ?? null; },
    finish: (row: WeeklyReport, messageId: string) => rpc<boolean>("niki_finish_weekly", { p_id: row.id, p_lease: row.lease_token, p_message_id: messageId }),
    retry: (row: WeeklyReport, error: string, delay: number) => rpc<void>("niki_retry_weekly", { p_id: row.id, p_lease: row.lease_token, p_error: error, p_delay: delay }),
  };
}
export type WeeklyStore = ReturnType<typeof createWeeklyStore>;
