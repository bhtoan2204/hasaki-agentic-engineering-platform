import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Application key lives outside the database. Missing or short values fail closed. */
export function authSecret(): Buffer {
  const raw = process.env.AUTH_SECRET ?? "";
  if (raw.length < 16) throw new Error("AUTH_SECRET is missing or shorter than 16 characters");
  return createHash("sha256").update(raw).digest();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Session lookup key. The raw token is only in the HttpOnly cookie. */
export function sessionHash(token: string): string {
  return sha256(`${authSecret().toString("hex")}:${token}`);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** AES-256-GCM. The stored string is iv || tag || ciphertext, base64. Never log the plaintext. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", authSecret(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const buf = Buffer.from(stored, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("stored secret is corrupt");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", authSecret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
