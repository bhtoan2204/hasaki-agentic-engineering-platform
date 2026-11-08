# Antigravity streaming and independent review repair

## Antigravity prompt transport

The adapter uses the documented `agy --input-format stream-json --output-format stream-json` protocol. It writes exactly one NDJSON user event to stdin and closes stdin after flushing it. Prompt content is not placed in argv or child environment variables. Writes are chunked and honor stream backpressure; stdout and stderr buffering are bounded. Resume continues to pass the persisted conversation ID through `--conversation`.

The parser accepts the CLI's `init`, `step_update`, and terminal `result` events, including partial NDJSON chunks. Step usage is accumulated, while terminal result usage replaces it because that value is cumulative. Missing token fields remain unknown; Antigravity does not report cost here, so cost remains unavailable. Auxiliary completions use the same transport.

The adapter does not pass `--dangerously-skip-permissions`. Coding execution retains configured sandboxing and platform hooks/broker authorization. The CLI's normal permission behavior therefore remains in force; the adapter does not auto-approve tool access.

## Feature implementation review flow

Newly published `feature-implementation` template versions mark the review step independent and set `max_repairs: 2`. A valid PASS bound to the reviewed Git heads allows the PR step to continue. An actionable FAIL reexecutes the configured feedback step (`implement`) through the workflow's existing DAG reexecution path, preserves previous attempts/worktree changes, reruns dependent tests and review, and stops after two repairs. A BLOCKED verdict waits for human input. Missing, contradictory, or insufficiently evidenced FAIL verdicts become BLOCKED; they cannot authorize a PR or trigger a code change.

Before PR creation, verification evidence is compared with the current worktree heads. A changed or uncovered head blocks publication. Historical runs continue using their immutable pinned workflow definition versions. Read-only `bug-investigation`, `refactoring`, and `code-review` workflows do not receive an implicit repair loop; the latter keeps its explicit human-approved fix step.

The adapter tests use a deterministic fake CLI. The controlled CLI protocol smoke test was run separately against the installed Antigravity CLI; automated tests do not make live provider calls.
