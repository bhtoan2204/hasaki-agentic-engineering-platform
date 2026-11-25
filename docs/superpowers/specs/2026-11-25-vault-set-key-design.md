# Chat: `vault.set_key` (QC only)

## Intent

Let a developer ask chat to change one env key in a service's Vault secret on QC (first use: `OTEL_ENDPOINT` in the payment project). Today chat only has `vault.list` and `vault.keys`, which are read-only and withhold values.

## Goals

- A confirm-gated tool `vault.set_key` that sets one key at one KV path on the QC Vault.
- Writes are limited by a config allowlist of path prefix and key names.
- Production Vault is read-only: every write is refused, whatever the allowlist says.

## Non-goals

- Restarting or syncing the service after the change (ArgoCD sync / pod restart stays manual).
- Deleting keys or secrets, creating new secrets, or writing several keys in one call.
- Any write path outside chat (agent workflows, MCP).

## Anti-goals

- Old secret values must never reach the model, logs, audit rows or the confirmation card.
- A write must never overwrite keys other than the requested one.

## Approaches

1. **Confirm-gated tool following `kafka.publish`** (chosen): reuses `chat_operations`, preflight, idempotency, audit and verify.
2. Let the model write directly: rejected, drops the human confirmation.
3. Open write access to the whole Vault: rejected, exceeds "payment, this key only".

## Design

- **Environment check (preflight)**: refuse unless `config.vault.baseUrl` host matches the QC pattern used by `kafkaPublishTarget` (`(^|[.-])qc([.-]|\d|$)`) and does not match the production pattern (`prod|production|live|prd`). The target path is also refused if it looks like production. Production therefore stays read-only: `vault.list` and `vault.keys` keep working, `vault.set_key` is refused.
- **Allowlist**: `vault.writeAllow: [{ path: string, keys: string[] }]`, default empty (writes disabled). `path` is a KV path; a trailing `*` means prefix. The key must be in `keys`.
- **Write**: KV v2 `PATCH {mount}/data/{rest}` with `Content-Type: application/merge-patch+json`, body `{ "options": { "cas": <current version> }, "data": { <key>: <value> } }`. Only the requested key changes. A CAS mismatch fails the operation with a clear message instead of overwriting. KV v1 mounts are refused.
- **Token**: the user's own Vault token (`requireToken()`). A 403 from missing policy is reported as is.
- **Operation flow**: `readOnly: false`, `confirm: true`, not preauthorized. The card shows path, key and the new value when the key name is not sensitive (same rule as `describeValue`); otherwise only its length. The old value is never shown.
- **Result**: `{ written: true, version, downstream_verified: false }`. The policy asks the model to read back with `vault.keys` and call `operations.verify` before claiming success.
- **Idempotency and audit**: handled by the existing `chat_operations` machinery.

## Constraints

- Follow existing patterns in `src/integrations/vault.ts`, `src/agent/toolRegistry.ts` and `src/chat/policy.ts`.
- The integration doc header in `vault.ts` ("The platform only reads") and `docs/architecture/interactive-agent-chat-operations.md` must be updated.

## Left to the builder

- The exact payment Vault path prefix for `writeAllow` (the owner fills it in config; not hard-coded).
- Tests: unit for preflight (QC vs prod host, allowlist, key not allowed, KV v1), integration with a fake Vault (PATCH body, CAS conflict, no old value leaked, agent cannot call without a confirmed operation).
- Not yet verified against the real QC Vault: PATCH support and the token's policy.
