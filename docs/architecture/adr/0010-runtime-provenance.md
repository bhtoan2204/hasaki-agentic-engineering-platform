# ADR 0010: Runtime provenance at sensitive sinks

Status: accepted · Date: 2026-11-21

## Context

Prompts already wrap untrusted content (`untrusted()` blocks) and say it cannot grant permissions, but nothing at
runtime connected the arguments of a mutating action to where those values came from. A PR comment, a log line or a
document could supply the destination of an operation, and a pre-authorized QC/Kafka rule would run it without the
owner seeing it (reproduced by `test/taint.integration.ts` before this change: an injected Kafka topic was proposed and
published automatically).

An LLM is not a taint-preserving interpreter: labels cannot be tracked through its reasoning. Enforcement therefore
happens where the platform controls execution, against records the platform itself wrote.

## Decision

`src/agent/taint.ts` + `proposeOperation` (`src/chat/operations.ts`):

- **Sinks** (`SINKS`): every mutating registry tool, with its target and payload fields — `kafka.publish`
  (targets `cluster`, `topic`; payload `value`, `key`, `headers`, `partition`), `qc_http.request` (target `url`;
  payload `body`, `query`, `headers`). A unit test fails when a new mutating tool is registered without a declaration.
- **Origin of each value** (strings/numbers inside the field; URLs also without query and by path; short values as
  whole words): `trusted` if the owner wrote it in this conversation, or — for a target — it is inside the operator's
  pre-authorized scope (`kafkaPreauthorized`, `qcPreauthorized`); otherwise `untrusted` if it appears in an
  observation of this conversation (tool results including CodeAct, attached documents); otherwise `unknown`.
  Only this owner's records of this conversation are read: another user's words never vouch for a value.
- **Decision.** Untrusted target → refused (nothing is proposed). Unknown target or untrusted payload → the owner must
  confirm (never the pre-authorized auto path). Otherwise unchanged behaviour.
- **Records.** `chat_operations.provenance` (migration 090) and an audit `chat.operation.taint` per proposal hold the
  decision and per-field origin with record refs (`message:<id>`, `chat:<conv>:tool:<id>`, `document:<id>`), never
  the values. Arguments cannot carry provenance (only declared fields are classified, from platform records).
- **CodeAct** (ADR 0008) cannot reach a sink at all; its outputs are chat tool results, hence observations.

`method` and `auth` of QC requests are not classified: they are small operator vocabularies governed by the
pre-authorized rules (DELETE never runs unconfirmed) and by host-bound auth profiles checked by the tool.

## Coverage and limits

| Path | Protection |
|---|---|
| Chat mutating operations (Kafka, QC HTTP) | provenance decision above + allowlists + owner confirmation + idempotency |
| CodeAct nested calls | read-only broker; no sink reachable |
| Workflow agents (`call_tool`) | mutating integrations refused (no confirmed operation outside chat) — unchanged |
| Native provider tools (shell, edit, web) in workflow steps | **not instrumented by provenance**: tool policy (`decide`), protected paths, ALWAYS_DENIED shell commands and, with `isolation.mode=enforce`, the OS sandbox and egress allowlist remain the boundary. A command copied from a log into Bash is not detected as tainted. |
| Notifications (webhook, Telegram) | destinations come from configuration / the owner's binding only — not model-supplied |

Matching is textual: a value transformed by the model (re-encoded, split, paraphrased) is `unknown`, which still
blocks auto-execution of an unknown target but not of an unknown payload. This reduces, not eliminates, injection risk;
the owner's confirmation remains the authority for everything outside the pre-authorized scope.

## Measurements

Deterministic tests, no model: 10 classification cases (`test/taint.test.ts`) and 6 end-to-end chat cases
(`test/taint.integration.ts`): PR-comment destination refused, observed payload forced to confirmation even on a
pre-authorized target, owner-stated operation still auto-runs, cross-user isolation, CodeAct-derived target refused,
revocation between proposal and confirmation. Existing operation suites (chat-operations, qc-operations) pass
unchanged. Overhead: three indexed queries bounded to 200 rows × 200 KB per proposal.
