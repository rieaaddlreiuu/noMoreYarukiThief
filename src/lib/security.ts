import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyKey } from "discord-interactions";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// TOKEN_ENCRYPTION_KEY is 32 random bytes, base64 encoded (openssl rand -base64 32). Null means "not configured".
export function parseTokenKey(value: string | undefined) {
  const key = Buffer.from(value?.trim() ?? "", "base64");
  return key.length === 32 ? key : null;
}

export function encryptToken(token: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), encrypted].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

// A wrong key, tampering or an unknown format all yield null so callers fall back instead of failing.
export function decryptToken(value: string, key: Buffer) {
  const [version, iv, tag, encrypted, ...rest] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted || rest.length) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

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
