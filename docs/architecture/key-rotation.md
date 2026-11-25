# Encryption key rotation (design)

Status: **approved and implemented** (`src/auth/crypto.ts`, `src/auth/rotation.ts`, `src/cli/rotate-keys.ts`). The four
decisions in section 10 were taken as proposed: derived key id, two-release rollout, checkpoints left on the old key,
sessions survive rotation.

Goal: change the application key without losing a single stored credential, with a reader/writer that understands
several keys, and a re-encrypt command that is safe to repeat.

## 1. What `AUTH_SECRET` is used for today

`AUTH_SECRET` (>= 16 characters, validated at start in `src/server.ts`) is read in one place, `authSecret()` in
`src/auth/crypto.ts`, which returns `SHA-256(AUTH_SECRET)` (32 bytes). Everything below goes through that function.
There is no KDF salt and no key id; the 16-character minimum allows a low-entropy key, which is a separate weakness
(see section 9).

| Use                                 | Where                                                       | Stored in                                                            | Effect of changing the key                                                        |
| ----------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| AES-256-GCM of personal credentials | `putUserSecret` / `getUserSecret` (`src/auth/secrets.ts`)   | `user_secrets.ciphertext`                                            | unreadable until re-encrypted                                                     |
| AES-256-GCM of shared credentials   | `putSharedSecret` / `getSharedSecret`                       | `shared_secrets.ciphertext`                                          | unreadable until re-encrypted                                                     |
| Telegram chat binding               | `src/telegram/store.ts:190` (direct SQL, `encryptSecret`)   | `user_secrets`, kind `telegram_chat`                                 | same as above                                                                     |
| Legacy credential claim             | `src/integrations/legacy.ts` (decrypts, compares, encrypts) | `user_secrets`                                                       | same as above                                                                     |
| Execution workspace checkpoints     | `src/git/workspaceCheckpoint.ts:199`                        | `workflow_artifacts.content` (kind `execution_checkpoint_workspace`) | unreadable; see 4.3                                                               |
| **Session lookup hash**             | `sessionHash()`: `SHA-256(hex(key) + ":" + token)`          | `sessions.token_hash`                                                | **every session is logged out** (not re-encryptable: the raw token is not stored) |

`user_secrets` kinds (from the call sites): `hasaki_token`, `bitbucket_token`, `bitbucket_user`, `github_token`,
`gitlab_token:<host>`, a GitLab SSH key per host, `telegram_chat`, `git_background_sync` (a flag, value `"1"`), and the
Splunk/Argo/Vault/Kafka/SigNoz credentials saved through `src/integrations/personal.ts` and `accounts.ts`.
`shared_secrets` kinds: `telegram` (bot settings JSON), `splunk_token`, `database:<key>` (project database passwords).

Not related to `AUTH_SECRET` (verified by grep over `src/`, `go/`, `web/`, `test/`):

- Password hashes: Argon2 (`src/auth/password.ts`), self-contained.
- The HMAC key of `src/git/nodeDependencies.ts`: a random file key, separate.
- `platform-go` does not read `AUTH_SECRET`.
- Agent subprocess environments strip `AUTH_SECRET` (`src/agent/environment.ts`, `isolation.ts`); that must stay true.

## 2. Current ciphertext format

```
base64( iv[12] || tag[16] || ciphertext )      AES-256-GCM, key = SHA-256(AUTH_SECRET), no AAD
```

No version, no key id. The stored value is exactly that base64 string. Decryption with a wrong key fails GCM
authentication and throws; a too-short value throws "stored secret is corrupt".

## 3. New format

```
v2:<kid>:base64( iv[12] || tag[16] || ciphertext )
```

- `:` is not in the base64 alphabet, so a `v2:` value can never be mistaken for the old format (which stays
  recognisable as "anything that does not start with `v2:`"). Same cipher, same iv/tag layout, so only the prefix is new.
- `kid` = first 12 hex characters of `SHA-256("hasaki-orbit/kid/v1:" + secret)`. It is **derived from the key material**, so
  operators never type or mismatch a label, and it reveals nothing useful (the input is a high-entropy secret behind a
  hash). Two different secrets colliding on 48 bits is not a realistic concern for a handful of keys; the loader
  rejects a configuration where two secrets share a kid.
- No AAD in this change. Binding the ciphertext to its row (table + kind + user) would stop a database writer from
  swapping ciphertexts between rows, but it changes every call site and makes re-encryption row-aware; out of scope,
  listed in section 9.

## 4. Key configuration and compatibility

### 4.1 Configuration

| Variable                 | Meaning                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`            | **Current key**: encrypts new values. Unchanged name and meaning, so existing deployments need no change. |
| `AUTH_SECRET_PREVIOUS`   | Optional, comma-separated older secrets: **decrypt-only**.                                                |
| `AUTH_CIPHERTEXT_FORMAT` | `legacy` (default in the first release) or `v2`: the format new writes use. See 4.2.                      |

Rotating = put the new secret in `AUTH_SECRET` and the old one at the front of `AUTH_SECRET_PREVIOUS`. Startup validation
applies the 16-character rule to every listed secret and refuses duplicates.

### 4.2 Reading (backward compatible) and the rollout order

`decryptSecret(stored)`:

1. `v2:<kid>:...`: use the configured key with that kid. Unknown kid: fail with an error naming the kid and saying that
   the old secret must be added to `AUTH_SECRET_PREVIOUS`. Never fall back to guessing.
2. No `v2:` prefix (legacy value): try the current key, then each previous key (GCM authentication tells which one is
   right). If none works: fail with "no configured key decrypts this value (tried N keys)". An existing, unrotated
   deployment has exactly one key, so behaviour is identical to today.

**Shared-database hazard.** Several platform instances (one per developer machine) share one database and must hold a
compatible key (`docs/reliability/phase1.md`). An instance on old code cannot read `v2:` values at all. So the rollout is
two releases, not one:

1. **Release A**: reader understands both formats; `AUTH_CIPHERTEXT_FORMAT` defaults to `legacy`, so it still writes the
   old format. Nothing changes for anyone, and no machine can write something another machine cannot read.
2. Wait until every machine runs release A. (Whether the instance heartbeat can report a code version has not been checked;
   if it cannot, this is a manual confirmation.)
3. Only then set `AUTH_CIPHERTEXT_FORMAT=v2` and rotate.

Mixed-key hazard: a machine that has not received the new `AUTH_SECRET`/`AUTH_SECRET_PREVIOUS` will fail to read rows
written with the new key. Rotation therefore needs the new configuration on every machine before the first
re-encrypt; this is a manual precondition in the runbook.

### 4.3 Sessions

`sessionHash()` becomes `sessionHashes(token)`: one hash per configured key (current first). Login inserts the current
key's hash; lookup and logout use `token_hash = ANY($1)`. Sessions therefore survive a rotation while the old key is
still listed, and expire normally (default 72 h). With no previous keys the query is the same as today. When the old
key is finally dropped, sessions that were created under it are simply logged out; that is acceptable and documented.

### 4.4 Execution workspace checkpoints (decision needed)

`workflow_artifacts.content` for kind `execution_checkpoint_workspace` holds an encrypted workspace snapshot, and its
digest is recorded inside `workflow_checkpoints.execution` (`workspace_artifact_digest`) and covered by
`execution_digest`. Re-encrypting the artifact would change the digest and require rewriting the checkpoint JSON and
its digest: a change to an integrity chain for data that is short-lived (at most `RETURNED_RETENTION` = 8 per step,
retired as new ones are written).

**Recommendation: do not re-encrypt them.** They stay readable as long as the old key is in `AUTH_SECRET_PREVIOUS`. The
CLI reports how many remain per key id (`--verify`), and an operator drops the old key only when that count (and the
session grace) is acceptable. If you prefer to re-encrypt them anyway, say so: it is an additional, separately tested
step that also updates the two digests in one transaction.

## 5. Re-encrypt CLI

`npm run auth:rotate-keys` (`src/cli/rotate-keys.ts`, same `--use-system-ca --env-file-if-exists=.env` launcher as
`admin:bootstrap`).

```
npm run auth:rotate-keys -- --dry-run            # count only, writes nothing
npm run auth:rotate-keys                          # re-encrypt with the current key
npm run auth:rotate-keys -- --verify              # report rows per key id; exit 1 if any row is undecryptable
options: --batch-size N (default 200)  --format v2|legacy (default: AUTH_CIPHERTEXT_FORMAT)
```

Scope: `user_secrets` and `shared_secrets` only.

Per batch, in one transaction:

1. Select the next rows after the last primary key (keyset pagination), skipping rows already in the target form
   (`v2:<current kid>:` prefix, or legacy form when `--format legacy`), `FOR UPDATE`.
2. Decrypt with any configured key; encrypt with the current key; **decrypt the result again and compare** before
   writing (the same check `legacy.ts` already does).
3. `UPDATE ... SET ciphertext = $new WHERE <pk> AND ciphertext = $old` (compare-and-swap, so a concurrent
   `putUserSecret` is never overwritten with stale data). `updated_at` is left alone: it means "when the user changed it".
4. A row that cannot be decrypted is **left untouched** and counted as failed; it never aborts the batch and is never
   deleted.

Properties: idempotent (a second run finds nothing to do and reports 0 rewritten); restartable after a crash (each
batch is atomic, progress is derived from the data, not from a cursor file); safe alongside a running server; prints
`scanned / rewritten / already current / failed` per table and in total; exit code 1 if anything failed.
`--dry-run` runs the same selection and decryption but rolls every transaction back, so it also proves that every row is
decryptable before anything is written.

## 6. Runbook

1. Release A is on every machine (4.2). Take a backup: `pg_dump -t user_secrets -t shared_secrets -t sessions`.
2. Generate the new secret: `openssl rand -base64 48`.
3. On every machine: `AUTH_SECRET=<new>`, `AUTH_SECRET_PREVIOUS=<old>`, `AUTH_CIPHERTEXT_FORMAT=v2`; restart.
4. `auth:rotate-keys --dry-run`, then `auth:rotate-keys`, then `auth:rotate-keys --verify` (expect 0 rows under the old key id).
5. After the session lifetime and the checkpoint retention window (4.4) have passed, remove the old secret from
   `AUTH_SECRET_PREVIOUS` and restart.

## 7. Rollback

- **Before step 4 of the runbook** (nothing rewritten): put the old secret back as `AUTH_SECRET`, remove the new one.
- **After rewriting**: swap the variables back (old = `AUTH_SECRET`, new = `AUTH_SECRET_PREVIOUS`) and run
  `auth:rotate-keys` again: it re-encrypts to the old key. Idempotence works in both directions.
- **Back to the old file format** (e.g. returning to pre-release-A code): set the old key as current, run
  `auth:rotate-keys --format legacy`, then verify no `v2:` value remains (`--verify` counts them) before downgrading code.
- Worst case: restore the `pg_dump` of `user_secrets`/`shared_secrets` from step 1; those rows are only decryptable with
  the key that wrote them, which is why the old secret must be kept until `--verify` is clean and the backup is no
  longer needed.

## 8. Tests planned for step B

Integration (`test/*.integration.ts`): a legacy ciphertext (written with the old algorithm) reads after the change;
rows read after rotation; a wrong or missing key fails with the documented message and names the kid; the CLI is
idempotent, honours `--dry-run` (no row changes), reports counts, rewrites in batches, skips undecryptable rows without
losing them, and does not overwrite a concurrent update; sessions created before a rotation still authenticate while
the old key is listed.
Unit: format parse/serialise, kid derivation and duplicate-kid rejection, config validation.

## 9. Not in scope, noted

- A KDF (HKDF/scrypt) instead of a bare SHA-256, and a minimum entropy check rather than 16 characters.
- AAD binding to table/kind/user.
- An envelope scheme (a data key per row wrapped by a master key) so rotation never rewrites rows; worthwhile only if
  rotation becomes frequent.
- External KMS.

## 10. Decisions (all taken as proposed)

1. **Key id derived from the key** (proposed) vs. an explicit label such as `AUTH_SECRET_V2=...`.
2. **Two-release rollout** (reader first, writer later; proposed) vs. a single release (simpler, but a machine on old code
   breaks as soon as anyone writes a `v2:` value).
3. **Checkpoint artifacts left on the old key until retired** (proposed) vs. re-encrypting them with digest updates.
4. **Sessions survive rotation** via multi-key lookup (proposed) vs. accepting a global logout.
