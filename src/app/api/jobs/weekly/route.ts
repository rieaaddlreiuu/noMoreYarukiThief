import { z } from "zod";
import { env } from "@/lib/config";
import { equalSecret, safeError } from "@/lib/security";
import { previousWeek, weekFromStart, weeklyText } from "@/lib/weekly-summary";
import { createWeeklyStore } from "@/lib/weekly-store";
import { runWeeklyJobs } from "@/lib/weekly-jobs";
import { deliverWeekly } from "@/lib/discord/weekly-client";

export const runtime = "nodejs";
export const maxDuration = 60;

const inputSchema = z.object({
  dryRun: z.boolean().default(true),
  weekStart: z.string().optional(),
  after: z.string().regex(/^\d{17,20}$/).optional(),
}).strict().refine((input) => input.dryRun || (input.weekStart === undefined && input.after === undefined));

export async function POST(request: Request) {
  let secret: string;
  try {
    secret = env("CRON_SECRET");
    if (secret.length < 32) throw new Error("CRON_SECRET too short");
  } catch { return Response.json({ error: "Not configured" }, { status: 503 }); }
  if (!equalSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let input: z.infer<typeof inputSchema>;
  let week;
  try {
    const body = await request.text();
    if (body.length > 4096) return new Response("Too large", { status: 413 });
    input = inputSchema.parse(body.trim() ? JSON.parse(body) : {});
    week = input.weekStart ? weekFromStart(input.weekStart) : previousWeek();
  } catch { return Response.json({ error: "Use dryRun: true and optionally a Monday weekStart (YYYY-MM-DD); live runs accept only dryRun: false." }, { status: 400 }); }
  try {
    const store = createWeeklyStore();
    if (input.dryRun) {
      const rows = await store.preview(week.weekStart, input.after);
      return Response.json({ dryRun: true, week, reports: rows.map((snapshot) => ({ ...snapshot, content: weeklyText(snapshot, week) })),
        nextCursor: rows.length === 100 ? rows.at(-1)!.guild_id : null }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ dryRun: false, ...await runWeeklyJobs({ store, deliver: deliverWeekly }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Weekly summary failed", safeError(error));
    return Response.json({ error: "Weekly summary unavailable; pending deliveries will be retried" }, { status: 503 });
  }
}
