import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyKey } from "discord-interactions";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function verifyDiscordRequest(body: string, headers: Headers, publicKey: string, now = Date.now()) {
  const signature = headers.get("x-signature-ed25519") ?? "";
  const timestamp = headers.get("x-signature-timestamp") ?? "";
  if (!/^\d+$/.test(timestamp) || !/^[\da-f]{128}$/i.test(signature) || !/^[\da-f]{64}$/i.test(publicKey)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try { return await verifyKey(body, signature, timestamp, publicKey); }
  catch { return false; }
}

export function safeError(error: unknown) {
  // External SDK errors can contain Authorization headers, OAuth codes or webhook tokens.
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return `External API HTTP ${error.status}`;
  }
  return error instanceof Error && error.name === "TimeoutError" ? "External API timeout" : "Processing failed";
}
