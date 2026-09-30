import "server-only";
import type { VerdictRequest } from ".";

export const GeminiApiError = class extends Error {
    constructor(public status: number) { super(`Gemini API HTTP ${status}`); }
}

export async function generateWithGemini({ apiKey, model, system, user, signal }: VerdictRequest) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
                systemInstruction: {
                parts: [{ text: system }],
                },
                contents: [
                    { role: "user", parts: [{ text: user }] }
                ],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            matchedIndex: { type: "INTEGER", nullable: true },
                            reason: { type: "STRING" },
                        },
                        required: ["matchedIndex", "reason"],
                    },
                },
            }),
            signal,
            cache: "no-store",
        },
    );

    if (!response.ok) {
        throw new GeminiApiError(response.status);
    }

    const body = await response.json();
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") throw new Error("Unexpected Gemini response shape");
    return text;
}
