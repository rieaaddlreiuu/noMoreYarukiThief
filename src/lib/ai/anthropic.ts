import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { VerdictRequest } from ".";

export async function generateWithAnthropic({ apiKey, model, system, user, signal }: VerdictRequest) {
  // Retries belong to the job queue, which backs off and keeps the declaration pending.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    // A safety decline is re-run server-side on the fallback model Anthropic recommends for its category.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages: [{ role: "user", content: user }],
    output_config: {
      // A match/no-match judgement needs little deliberation, and low effort keeps it inside the check timeout.
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            matchedIndex: { anyOf: [{ type: "integer" }, { type: "null" }] },
            reason: { type: "string" },
          },
          required: ["matchedIndex", "reason"],
          additionalProperties: false,
        },
      },
    },
  }, { signal });

  // A refusal or truncated answer is not a verdict; throwing keeps the declaration pending for a retry.
  if (response.stop_reason !== "end_turn") throw new Error(`Claude stopped with ${response.stop_reason}`);
  const text = response.content.find((block) => block.type === "text");
  if (!text) throw new Error("Unexpected Claude response shape");
  return text.text;
}
