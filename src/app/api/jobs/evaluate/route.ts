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
  } catch { return Response.json({ error: "Not configured" }, { status: 503 }); }
  if (!equalSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const store = createStore();
    await store.cleanup();
    const counts = await runJobs({ store, findCommit: findCommitWithUserToken(store), deliver: createDiscordClient().deliver });
    return Response.json(counts, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Scheduled evaluation failed", safeError(error));
    return Response.json({ error: "Evaluation unavailable; jobs will be retried" }, { status: 503 });
  }
}
