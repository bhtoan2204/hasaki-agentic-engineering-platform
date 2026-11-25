import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  decryptDetailed,
  decryptSecret,
  encryptSecret,
  keyRing,
  sessionHash,
  sessionHashes,
  writeFormat,
} from "../src/auth/crypto.ts";
import { config } from "../src/config.ts";

const original = {
  secret: config.auth.secret,
  previous: config.auth.secretPrevious,
  format: config.auth.ciphertextFormat,
};
const OLD = "old-secret-value-0123456789";
const NEW = "new-secret-value-9876543210";

const FIELDS = {
  AUTH_SECRET: "secret",
  AUTH_SECRET_PREVIOUS: "secretPrevious",
  AUTH_CIPHERTEXT_FORMAT: "ciphertextFormat",
} as const;
function restore(name: keyof typeof FIELDS, value: string | undefined) {
  config.auth[FIELDS[name]] = value;
}
afterEach(() => {
  restore("AUTH_SECRET", original.secret);
  restore("AUTH_SECRET_PREVIOUS", original.previous);
  restore("AUTH_CIPHERTEXT_FORMAT", original.format);
});

/** The format before key ids, written by an independent copy of the old algorithm. */
function legacyCiphertext(secret: string, plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

test("a value written in the old format still decrypts with the same AUTH_SECRET", () => {
  config.auth.secret = OLD;
  config.auth.secretPrevious = undefined;
  const stored = legacyCiphertext(OLD, "token-123");
  assert.equal(decryptSecret(stored), "token-123");
  assert.equal(decryptDetailed(stored).format, "legacy");
});

test("new writes are legacy by default and v2 with a key id when asked", () => {
  config.auth.secret = OLD;
  config.auth.ciphertextFormat = undefined;
  assert.equal(writeFormat(), "legacy");
  const legacy = encryptSecret("a");
  assert.doesNotMatch(legacy, /^v2:/);
  assert.equal(decryptSecret(legacy), "a");

  config.auth.ciphertextFormat = "v2";
  const v2 = encryptSecret("b");
  const kid = keyRing().current.kid;
  assert.match(v2, new RegExp(`^v2:${kid}:[A-Za-z0-9+/=]+$`));
  assert.deepEqual(
    {
      plain: decryptDetailed(v2).plain,
      kid: decryptDetailed(v2).kid,
      format: decryptDetailed(v2).format,
    },
    { plain: "b", kid, format: "v2" },
  );
});

test("an unknown format setting is refused", () => {
  config.auth.ciphertextFormat = "v3";
  assert.throws(() => writeFormat(), /legacy" or "v2"/);
});

test("after rotation old values (legacy and v2) read through AUTH_SECRET_PREVIOUS", () => {
  config.auth.secret = OLD;
  config.auth.ciphertextFormat = "v2";
  const oldKid = keyRing().current.kid;
  const oldV2 = encryptSecret("v2-value");
  const oldLegacy = legacyCiphertext(OLD, "legacy-value");

  config.auth.secret = NEW;
  config.auth.secretPrevious = OLD;
  const ring = keyRing();
  assert.notEqual(ring.current.kid, oldKid);
  assert.equal(decryptSecret(oldV2), "v2-value");
  assert.equal(decryptDetailed(oldLegacy).kid, oldKid);
  assert.equal(decryptSecret(oldLegacy), "legacy-value");
  // New writes use the new key.
  assert.equal(decryptDetailed(encryptSecret("fresh")).kid, ring.current.kid);
});

test("a missing key fails with a message that names the cause, never with garbage", () => {
  config.auth.secret = OLD;
  config.auth.ciphertextFormat = "v2";
  const oldKid = keyRing().current.kid;
  const oldV2 = encryptSecret("x");
  const oldLegacy = legacyCiphertext(OLD, "y");

  config.auth.secret = NEW;
  config.auth.secretPrevious = undefined;
  assert.throws(() => decryptSecret(oldV2), new RegExp(`key ${oldKid}.*AUTH_SECRET_PREVIOUS`));
  assert.throws(
    () => decryptSecret(oldLegacy),
    /no configured key decrypts this stored secret \(tried 1 key\)/,
  );
  assert.throws(() => decryptSecret("AAAA"), /corrupt/);
  assert.throws(() => decryptSecret("v2::AAAA"), /corrupt/);
});

test("a tampered value fails authentication", () => {
  config.auth.secret = OLD;
  config.auth.ciphertextFormat = "v2";
  const stored = encryptSecret("secret");
  const [prefix, kid, body] = stored.split(":");
  const raw = Buffer.from(body, "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decryptSecret(`${prefix}:${kid}:${raw.toString("base64")}`));
});

test("key configuration is validated", () => {
  config.auth.secret = "short";
  assert.throws(() => keyRing(), /AUTH_SECRET is missing or shorter than 16/);
  config.auth.secret = NEW;
  config.auth.secretPrevious = "too-short";
  assert.throws(() => keyRing(), /AUTH_SECRET_PREVIOUS has an entry shorter/);
  config.auth.secretPrevious = `${OLD}, ${NEW}`;
  assert.throws(() => keyRing(), /must not repeat a secret/);
  config.auth.secretPrevious = `${OLD},${OLD}`;
  assert.throws(() => keyRing(), /must not repeat a secret/);
  config.auth.secretPrevious = ` ${OLD} , `;
  assert.equal(keyRing().all.length, 2);
});

test("session hashes: the current key first, and every configured key is a candidate", () => {
  config.auth.secret = OLD;
  config.auth.secretPrevious = undefined;
  const before = sessionHash("tok");
  assert.deepEqual(sessionHashes("tok"), [before]);
  config.auth.secret = NEW;
  config.auth.secretPrevious = OLD;
  const hashes = sessionHashes("tok");
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], sessionHash("tok"));
  assert.ok(hashes.includes(before));
  assert.notEqual(hashes[0], before);
});
