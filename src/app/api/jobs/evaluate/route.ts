import { env } from "@/lib/config";
import { createDiscordClient } from "@/lib/discord/client";
import { findCommitWithUserToken } from "@/lib/github";
import { runJobs } from "@/lib/jobs";
import { equalSecret, safeError } from "@/lib/security";
import { createStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let secret: string;
  try {
    secret = env("CRON_SECRET");
    if (secret.length < 32) throw new Error("CRON_SECRET too short");
  } catch {
    console.error("[cron:evaluate] CRON_SECRET missing or too short");
    return Response.json({ error: "Not configured" }, { status: 503 });
  }
  if (!equalSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    // A mismatch with the Supabase Vault secret ends up here and is otherwise invisible.
    console.warn("[cron:evaluate] unauthorized", { hasAuthHeader: request.headers.has("authorization") });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log("[cron:evaluate] start");
  try {
    const store = createStore();
    await store.cleanup();
    const counts = await runJobs({ store, findCommit: findCommitWithUserToken(store), deliver: createDiscordClient().deliver });
    console.log("[cron:evaluate] done", counts);
    return Response.json(counts, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Scheduled evaluation failed", safeError(error));
    return Response.json({ error: "Evaluation unavailable; jobs will be retried" }, { status: 503 });
  }
}
