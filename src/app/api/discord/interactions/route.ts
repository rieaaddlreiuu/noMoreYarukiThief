import { after } from "next/server";
import { appOrigin, env } from "@/lib/config";
import { createDiscordClient } from "@/lib/discord/client";
import { commandErrorMessage, handleCommand, interactionSchema, type Interaction } from "@/lib/discord/handler";
import { validateRepository } from "@/lib/github";
import { dispatchNotifications } from "@/lib/jobs";
import { safeError, verifyDiscordRequest } from "@/lib/security";
import { createStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

async function processInteraction(interaction: Interaction) {
  const discord = createDiscordClient();
  let declarationId: string | undefined;
  try {
    const store = createStore();
    if (!await store.claimInteraction(interaction.id)) {
      console.log("[interaction] duplicate, ignored", { id: interaction.id });
      return;
    }
    console.log("[interaction] processing", { id: interaction.id });
    const result = await handleCommand(interaction, { store, discord, origin: appOrigin, validateRepository });
    declarationId = result.declarationId;
    await discord.editReply(interaction.application_id, interaction.token, result.message);
  } catch (error) {
    console.error("Discord command failed", safeError(error));
    await discord.editReply(interaction.application_id, interaction.token, { content: commandErrorMessage(error) })
      .catch((replyError) => console.error("Discord reply failed", safeError(replyError)));
  }
  if (declarationId) {
    // A reply failure must never roll back an already-saved declaration. Cron also drains this outbox.
    await dispatchNotifications({ store: createStore(), deliver: discord.deliver }, declarationId)
      .catch((error) => console.error("Immediate notification deferred to cron", safeError(error)));
  }
}

export async function POST(request: Request) {
  let publicKey: string;
  try { publicKey = env("DISCORD_PUBLIC_KEY"); }
  catch { return new Response("Not configured", { status: 503 }); }
  if (Number(request.headers.get("content-length")) > 65_536) return new Response("Too large", { status: 413 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 65_536) return new Response("Too large", { status: 413 });
  if (!await verifyDiscordRequest(body, request.headers, publicKey)) {
    console.warn("[interaction] invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch { return new Response("Invalid JSON", { status: 400 }); }
  if (payload && typeof payload === "object" && "type" in payload && payload.type === 1) return Response.json({ type: 1 });
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) console.warn("[interaction] schema mismatch", { issues: parsed.error.issues.map((i) => i.path.join(".")) });
  if (!parsed.success) return Response.json({ type: 4, data: { content: "サーバー内で /niki コマンドを実行してください。", flags: 64, allowed_mentions: { parse: [] } } });
  if (parsed.data.application_id !== process.env.DISCORD_APPLICATION_ID) return new Response("Wrong application", { status: 401 });
  // All database/API work runs after the response to meet Discord's 3-second acknowledgement limit.
  after(() => processInteraction(parsed.data));
  return Response.json({ type: 5, data: { flags: 64 } });
}
