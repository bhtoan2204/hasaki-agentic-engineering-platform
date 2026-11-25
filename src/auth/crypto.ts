import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config.ts";

/**
 * Application keys live outside the database. Missing or short values fail closed.
 *
 * AUTH_SECRET is the current key (it encrypts); AUTH_SECRET_PREVIOUS is a comma-separated list of older secrets that
 * only decrypt. Design and rollout: docs/architecture/key-rotation.md.
 */
export interface AuthKey {
  /** First 12 hex characters of SHA-256("hasaki-orbit/kid/v1:" + secret): derived, never typed by an operator. */
  kid: string;
  key: Buffer;
}
export interface KeyRing {
  current: AuthKey;
  /** The current key first, then the previous ones in configured order. */
  all: AuthKey[];
}
export type CiphertextFormat = "legacy" | "v2";

const MIN_SECRET_CHARS = 16;
const V2_PREFIX = "v2:";

const keyFor = (secret: string): AuthKey => ({
  kid: createHash("sha256").update(`hasaki-orbit/kid/v1:${secret}`).digest("hex").slice(0, 12),
  key: createHash("sha256").update(secret).digest(),
});

let ringMemo: { source: string; ring: KeyRing } | undefined;

/** Reads and validates the key configuration; throws on a missing, short or duplicated secret. */
export function keyRing(): KeyRing {
  const current = config.auth.secret ?? "";
  const previous = config.auth.secretPrevious ?? "";
  const source = `${current}\n${previous}`;
  if (ringMemo?.source === source) return ringMemo.ring;
  if (current.length < MIN_SECRET_CHARS)
    throw new Error("AUTH_SECRET is missing or shorter than 16 characters");
  const olds = previous
    .split(",")
    .map((secret) => secret.trim())
    .filter(Boolean);
  for (const secret of olds)
    if (secret.length < MIN_SECRET_CHARS)
      throw new Error("AUTH_SECRET_PREVIOUS has an entry shorter than 16 characters");
  const secrets = [current, ...olds];
  const all = secrets.map(keyFor);
  if (
    new Set(secrets).size !== secrets.length ||
    new Set(all.map((k) => k.kid)).size !== all.length
  )
    throw new Error("AUTH_SECRET and AUTH_SECRET_PREVIOUS must not repeat a secret");
  const ring = { current: all[0], all };
  ringMemo = { source, ring };
  return ring;
}

/** Format new values are written in. "legacy" until every machine sharing the database runs a reader for "v2". */
export function writeFormat(): CiphertextFormat {
  const raw = config.auth.ciphertextFormat ?? "legacy";
  if (raw !== "legacy" && raw !== "v2")
    throw new Error('AUTH_CIPHERTEXT_FORMAT must be "legacy" or "v2"');
  return raw;
}

/** The current key's bytes. */
export function authSecret(): Buffer {
  return keyRing().current.key;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Session lookup hash under one key. The raw token is only in the HttpOnly cookie. */
const hashWith = (key: Buffer, token: string) => sha256(`${key.toString("hex")}:${token}`);

/** The hash stored for a new session (current key). */
export function sessionHash(token: string): string {
  return hashWith(keyRing().current.key, token);
}

/** Every hash a session cookie could be stored under (current key first): sessions survive a rotation. */
export function sessionHashes(token: string): string[] {
  return keyRing().all.map((k) => hashWith(k.key, token));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function seal(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, buf: Buffer): string {
  if (buf.length < 12 + 16 + 1) throw new Error("stored secret is corrupt");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/**
 * AES-256-GCM with the current key. Legacy: base64(iv || tag || ciphertext). v2: "v2:<kid>:" + the same base64.
 * Never log the plaintext.
 */
export function encryptSecret(plain: string, format: CiphertextFormat = writeFormat()): string {
  const { current } = keyRing();
  const body = seal(current.key, plain).toString("base64");
  return format === "v2" ? `${V2_PREFIX}${current.kid}:${body}` : body;
}

export interface Decrypted {
  plain: string;
  format: CiphertextFormat;
  /** The key that decrypted it. */
  kid: string;
}

/** Decrypts with whichever configured key fits and says which one, so a re-encrypt can skip current values. */
export function decryptDetailed(stored: string): Decrypted {
  const ring = keyRing();
  if (stored.startsWith(V2_PREFIX)) {
    const end = stored.indexOf(":", V2_PREFIX.length);
    const kid = end < 0 ? "" : stored.slice(V2_PREFIX.length, end);
    if (!kid) throw new Error("stored secret is corrupt");
    const key = ring.all.find((k) => k.kid === kid);
    if (!key)
      throw new Error(
        `stored secret was encrypted with key ${kid}, which is not configured: add the old secret to AUTH_SECRET_PREVIOUS`,
      );
    return {
      plain: open(key.key, Buffer.from(stored.slice(end + 1), "base64")),
      format: "v2",
      kid,
    };
  }
  const buf = Buffer.from(stored, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("stored secret is corrupt");
  for (const key of ring.all) {
    try {
      return { plain: open(key.key, buf), format: "legacy", kid: key.kid };
    } catch {
      /* GCM authentication failed: not this key */
    }
  }
  throw new Error(
    `no configured key decrypts this stored secret (tried ${ring.all.length} key${ring.all.length === 1 ? "" : "s"})`,
  );
}

export function decryptSecret(stored: string): string {
  return decryptDetailed(stored).plain;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
