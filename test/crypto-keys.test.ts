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

const original = {
  secret: process.env.AUTH_SECRET,
  previous: process.env.AUTH_SECRET_PREVIOUS,
  format: process.env.AUTH_CIPHERTEXT_FORMAT,
};
const OLD = "old-secret-value-0123456789";
const NEW = "new-secret-value-9876543210";

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
  process.env.AUTH_SECRET = OLD;
  delete process.env.AUTH_SECRET_PREVIOUS;
  const stored = legacyCiphertext(OLD, "token-123");
  assert.equal(decryptSecret(stored), "token-123");
  assert.equal(decryptDetailed(stored).format, "legacy");
});

test("new writes are legacy by default and v2 with a key id when asked", () => {
  process.env.AUTH_SECRET = OLD;
  delete process.env.AUTH_CIPHERTEXT_FORMAT;
  assert.equal(writeFormat(), "legacy");
  const legacy = encryptSecret("a");
  assert.doesNotMatch(legacy, /^v2:/);
  assert.equal(decryptSecret(legacy), "a");

  process.env.AUTH_CIPHERTEXT_FORMAT = "v2";
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
  process.env.AUTH_CIPHERTEXT_FORMAT = "v3";
  assert.throws(() => writeFormat(), /legacy" or "v2"/);
});

test("after rotation old values (legacy and v2) read through AUTH_SECRET_PREVIOUS", () => {
  process.env.AUTH_SECRET = OLD;
  process.env.AUTH_CIPHERTEXT_FORMAT = "v2";
  const oldKid = keyRing().current.kid;
  const oldV2 = encryptSecret("v2-value");
  const oldLegacy = legacyCiphertext(OLD, "legacy-value");

  process.env.AUTH_SECRET = NEW;
  process.env.AUTH_SECRET_PREVIOUS = OLD;
  const ring = keyRing();
  assert.notEqual(ring.current.kid, oldKid);
  assert.equal(decryptSecret(oldV2), "v2-value");
  assert.equal(decryptDetailed(oldLegacy).kid, oldKid);
  assert.equal(decryptSecret(oldLegacy), "legacy-value");
  // New writes use the new key.
  assert.equal(decryptDetailed(encryptSecret("fresh")).kid, ring.current.kid);
});

test("a missing key fails with a message that names the cause, never with garbage", () => {
  process.env.AUTH_SECRET = OLD;
  process.env.AUTH_CIPHERTEXT_FORMAT = "v2";
  const oldKid = keyRing().current.kid;
  const oldV2 = encryptSecret("x");
  const oldLegacy = legacyCiphertext(OLD, "y");

  process.env.AUTH_SECRET = NEW;
  delete process.env.AUTH_SECRET_PREVIOUS;
  assert.throws(() => decryptSecret(oldV2), new RegExp(`key ${oldKid}.*AUTH_SECRET_PREVIOUS`));
  assert.throws(
    () => decryptSecret(oldLegacy),
    /no configured key decrypts this stored secret \(tried 1 key\)/,
  );
  assert.throws(() => decryptSecret("AAAA"), /corrupt/);
  assert.throws(() => decryptSecret("v2::AAAA"), /corrupt/);
});

test("a tampered value fails authentication", () => {
  process.env.AUTH_SECRET = OLD;
  process.env.AUTH_CIPHERTEXT_FORMAT = "v2";
  const stored = encryptSecret("secret");
  const [prefix, kid, body] = stored.split(":");
  const raw = Buffer.from(body, "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decryptSecret(`${prefix}:${kid}:${raw.toString("base64")}`));
});

test("key configuration is validated", () => {
  process.env.AUTH_SECRET = "short";
  assert.throws(() => keyRing(), /AUTH_SECRET is missing or shorter than 16/);
  process.env.AUTH_SECRET = NEW;
  process.env.AUTH_SECRET_PREVIOUS = "too-short";
  assert.throws(() => keyRing(), /AUTH_SECRET_PREVIOUS has an entry shorter/);
  process.env.AUTH_SECRET_PREVIOUS = `${OLD}, ${NEW}`;
  assert.throws(() => keyRing(), /must not repeat a secret/);
  process.env.AUTH_SECRET_PREVIOUS = `${OLD},${OLD}`;
  assert.throws(() => keyRing(), /must not repeat a secret/);
  process.env.AUTH_SECRET_PREVIOUS = ` ${OLD} , `;
  assert.equal(keyRing().all.length, 2);
});

test("session hashes: the current key first, and every configured key is a candidate", () => {
  process.env.AUTH_SECRET = OLD;
  delete process.env.AUTH_SECRET_PREVIOUS;
  const before = sessionHash("tok");
  assert.deepEqual(sessionHashes("tok"), [before]);
  process.env.AUTH_SECRET = NEW;
  process.env.AUTH_SECRET_PREVIOUS = OLD;
  const hashes = sessionHashes("tok");
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], sessionHash("tok"));
  assert.ok(hashes.includes(before));
  assert.notEqual(hashes[0], before);
});
