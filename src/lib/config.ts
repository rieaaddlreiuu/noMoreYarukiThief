import "server-only";
import { z } from "zod";

export function env(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

export function appOrigin() {
  const value = z.url().parse(env("APP_URL"));
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("APP_URL must be an origin without a path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("APP_URL must use HTTPS (except localhost)");
  }
  return url.origin;
}
