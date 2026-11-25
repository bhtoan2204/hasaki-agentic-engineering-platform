# Chat `vault.set_key` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let chat change one allowlisted key of a KV v2 secret on the QC Vault, behind a user confirmation; production Vault stays read-only.

**Architecture:** Copy the `kafka.publish` pattern: a `confirm: true` integration tool whose `preflight` enforces QC-only and the allowlist, and whose handler does a CAS-guarded KV v2 merge-patch. Everything else (operation row, idempotency, audit, verify) already exists in `chat_operations`.

**Tech Stack:** TypeScript (Node test runner, zod), existing `src/integrations/vault.ts`, `src/agent/toolRegistry.ts`.

**Spec:** `docs/superpowers/specs/2026-11-25-vault-set-key-design.md`

## Global Constraints

- Production Vault is read-only: a write is refused unless `config.vault.baseUrl` host matches `/(^|[.-])qc([.-]|\d|$)/i` and does not match `/(^|[^a-z])(prod|production|live|prd)([^a-z]|$)/i`.
- `vault.writeAllow` defaults to `[]` (writes disabled); the key match is exact and case-sensitive.
- Write = KV v2 `PATCH {mount}/data/{rest}`, `Content-Type: application/merge-patch+json`, body `{"options":{"cas":<version>},"data":{<key>:<value>}}`. KV v1 and missing secrets are refused.
- The old value never appears in results, errors, logs or the operation card.
- Tool: `readOnly: false`, `confirm: true`, no `preauthorized`.
- Repo rules: no new comments except a one-line non-obvious trap; minimal diff; no `Co-Authored-By`. Commits of type `feat`/`fix`/`refactor`/`perf` need a `func: <FUNCTION_CODE>` footer: ask the user for the code, never invent it.

## Review Focus

- Path escape: `secret/payment/../prod/x` or `//` must not slip past a prefix allowlist (normalize, reject `..`). Task 1.
- Key case: `otel_endpoint` when only `OTEL_ENDPOINT` is allowlisted is refused. Task 1.
- Empty or oversized value (`""`, > 4000 chars) is refused; deletion is not a feature. Task 3 (schema) and Task 2.
- Secret does not exist: clear error, nothing is created. Task 2.
- CAS conflict (another writer bumped the version): readable failure, no overwrite. Task 2.

---

### Task 1: Config and QC/allowlist preflight

**Files:**
- Modify: `src/config.ts:398-399` (type) and `src/config.ts:798` (default)
- Modify: `src/integrations/vault.ts`
- Create: `test/vault-write.test.ts`

**Interfaces:**
- Produces: `config.vault.writeAllow: Array<{ path: string; keys: string[] }>`; `vaultWriteTarget(path: string, key: string): Promise<{ path: string; mount: string; rest: string }>` exported from `vault.ts` (throws `Error` with a human message on any refusal).

- [ ] **Step 1: Write failing tests** in `test/vault-write.test.ts` (use `test/env.ts` import pattern of `test/chat-operations.test.ts`; set `config.vault` fields per test and restore after). Names and assertions:
  - `vault write target: production host is refused even when allowlisted` → host `vault.example.vn` and `vault-prod.example.dev` both reject with `/not a QC environment/`.
  - `vault write target: empty allowlist disables writes` → rejects with `/disabled/`.
  - `vault write target: path and key must match the allowlist` → path outside prefix rejects; `otel_endpoint` vs allowed `OTEL_ENDPOINT` rejects; a `*` suffix entry matches by prefix.
  - `vault write target: path escapes are refused` → `secret/payment/../prod/x` and paths containing `..` reject.
  - `vault write target: production-looking path is refused` → `secret/payment-prod/x` rejects even under `secret/payment*`.
  All of these reject before any network call, so no fake server is needed.

- [ ] **Step 2: Run** `node --disable-warning=ExperimentalWarning --import ./test/env.ts --test test/vault-write.test.ts` — expect FAIL (`vaultWriteTarget` not exported).

- [ ] **Step 3: Implement.** Add `writeAllow` to the `vault` config type and `writeAllow: []` to the default (the file merge at `config.ts:1000` already spreads defaults). In `vault.ts` add `vaultWriteTarget`: check order = host (QC and not production) → allowlist non-empty → normalize path (trim slashes, collapse `//`, reject `..`) → production regex on the path → allowlist match (exact path or `*`-suffix prefix, key exact) → resolve with the existing `mounts()`/`split()` and refuse `version !== 2`. Reuse the Kafka regexes by copying them as local constants (they are not exported from `kafka.ts`; do not refactor `kafka.ts`).

- [ ] **Step 4: Run** the same command — expect PASS. Also run `npx tsc --noEmit`.

- [ ] **Step 5: Commit** (ask the user for `func:` code first).

### Task 2: `setVaultKey` against KV v2

**Files:**
- Modify: `src/integrations/vault.ts` (extend private `call` opts: `method` also `"PATCH"`, optional `body`, set `Content-Type: application/merge-patch+json` when PATCH)
- Modify: `test/vault.integration.ts` (extend the fake Vault: GET `/v1/<mount>/data/...` returning `metadata.version`, PATCH recording method, content-type and parsed body; a flag to simulate CAS mismatch with Vault's 400 `check-and-set parameter did not match`)

**Interfaces:**
- Consumes: `vaultWriteTarget` (Task 1), `requireToken()`, `describeValue`.
- Produces: `setVaultKey(a: { path: string; key: string; value: string }): Promise<{ written: true; path: string; key: string; version: number; downstream_verified: false }>`.

- [ ] **Step 1: Write failing integration tests** in `test/vault.integration.ts` (fake server `baseUrl` must satisfy the QC regex, e.g. reuse how the file sets `config.vault.baseUrl` and make the host contain `qc`; if the loopback host cannot, stub only the host check by pointing `baseUrl` at a `qc.localhost` name that resolves to 127.0.0.1):
  - `setVaultKey sends one CAS-guarded merge-patch` → the PATCH body deep-equals `{options:{cas:<fake version>},data:{OTEL_ENDPOINT:"http://otel-qc:4317"}}`, content-type is `application/merge-patch+json`, no PUT/POST to the data path, result `version` is the new version.
  - `setVaultKey fails on CAS mismatch without overwriting` → rejects with `/changed|check-and-set/i`.
  - `setVaultKey refuses a missing secret` → GET 404 rejects with `/does not exist/`, no PATCH recorded.
  - `setVaultKey never leaks old values` → result and thrown error strings contain none of `SECRET_VALUES`.

- [ ] **Step 2: Run** `npm run test:integration -- test/vault.integration.ts` (check `test/run-integration.ts` for the exact filter syntax) — expect FAIL.

- [ ] **Step 3: Implement `setVaultKey`** in `vault.ts`: call `vaultWriteTarget`, GET the data path for `metadata.version` (404 → `Error("secret ... does not exist; creating secrets is not supported")`), PATCH with the CAS body, map the CAS 400 to a readable "secret changed since it was read; retry" error. Check how `publishMessage` in `kafka.ts` reports a timeout so the operation becomes `unknown` rather than `failed`, and mirror that for the PATCH call.

- [ ] **Step 4: Run** the integration file — expect PASS.

- [ ] **Step 5: Commit** (ask for `func:` code).

### Task 3: Register the tool, policy line, docs

**Files:**
- Modify: `src/agent/toolRegistry.ts` (after `vault.keys`, ~line 870)
- Modify: `src/chat/policy.ts:39`
- Modify: `src/integrations/vault.ts` header comment, `docs/architecture/interactive-agent-chat-operations.md` (new "Vault set_key (QC)" section modeled on "Kafka publish (QC)")
- Test: `test/vault-write.test.ts`

**Interfaces:**
- Consumes: `vaultWriteTarget`, `setVaultKey`, `describeValue`, `vaultAvailable`.
- Produces: integration tool `vault.set_key`.

- [ ] **Step 1: Write failing tests** in `test/vault-write.test.ts`:
  - `vault.set_key cannot be called directly by any agent, only through a confirmed operation` → mirror the `kafka.publish` test at `test/chat-operations.test.ts:59`.
  - `vault.set_key rejects empty and oversized values` → `callTool` input validation fails for `""` and a 4001-char string.

- [ ] **Step 2: Run** the file — expect FAIL (unknown tool).

- [ ] **Step 3: Register `vault.set_key`**: input `z.object({ path: z.string().min(1), key: z.string().min(1).max(200), value: z.string().min(1).max(4000) })`; `readOnly: false`, `confirm: true`, `available: vaultAvailable`; `preflight: async ({path,key,value}) => ({ ...(await vaultWriteTarget(path,key)), ...shownValue })` where `shownValue` is `describeValue(key, value)` reduced to `value` or `length` (inspect how the `kafka.publish` preflight result is rendered in the operation row/card and keep the same shape); `handler: (a) => setVaultKey(a)`. Summary/description state: QC only, one key, user confirms, old value never shown, read back with `vault.keys` then `operations.verify`. In `policy.ts` add `vault.set_key` to the `e.g. kafka.publish` example. Update the `vault.ts` header and the architecture doc (config example with `vault.writeAllow`, QC-only rule, CAS, limits; note it is unverified against the real QC Vault).

- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit` — expect all PASS.

- [ ] **Step 5: Commit** (ask for `func:` code).

- [ ] **Step 6 (manual, after merge):** the owner adds `vault.writeAllow` for the payment prefix, connects a Vault token whose policy allows `patch`/`update`, and asks chat to change `OTEL_ENDPOINT`; confirm the card, then check `vault.keys` read-back.
