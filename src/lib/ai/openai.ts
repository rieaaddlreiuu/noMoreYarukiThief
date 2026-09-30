import "server-only";
import OpenAI from "openai";
import type { VerdictRequest } from ".";

export async function generateWithOpenAI({ apiKey, model, system, user, signal }: VerdictRequest) {
  // Retries belong to the job queue, which backs off and keeps the declaration pending.
  const client = new OpenAI({ apiKey, maxRetries: 0 });
  const response = await client.responses.create({
    model,
    instructions: system,
    input: user,
    // The verdict is all we need; do not keep the request on OpenAI's side.
    store: false,
    // A match/no-match judgement needs little deliberation, and low effort keeps it inside the check timeout.
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "verdict",
        strict: true,
        schema: {
          type: "object",
          properties: {
            matchedIndex: { type: ["integer", "null"] },
            reason: { type: "string" },
          },
          required: ["matchedIndex", "reason"],
          additionalProperties: false,
        },
      },
    },
  }, { signal });

  if (response.status !== "completed") throw new Error(`OpenAI response ${response.status}`);
  const content = response.output.flatMap((item) => item.type === "message" ? item.content : []);
  if (content.some((part) => part.type === "refusal")) throw new Error("OpenAI refused the judgement");
  return response.output_text;
}
