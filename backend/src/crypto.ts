import crypto from "node:crypto";
import { config } from "./config.ts";

const key = () => crypto.createHash("sha256").update(`enc:${config.appSecret}`).digest();

/** AES-256-GCM. Used for the Google refresh token at rest. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8");
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function sign(value: string): string {
  return crypto.createHmac("sha256", `sig:${config.appSecret}`).update(value).digest("base64url").slice(0, 22);
}

export function verifySignature(value: string, signature: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
