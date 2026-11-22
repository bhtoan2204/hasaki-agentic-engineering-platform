# Agent Harness: execution efficiency and budget reliability

Reference incident: **Run #153** (REQ-126, `platform-self-development`). Committed on `main`, on the owner's instruction not to create feature branches, from `372a70a`. The commit SHA and CI status are in §8.

What ran and where:

- The Run #153 audit used **read-only** queries (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`) on the installation database, and `git log`/`rev-parse` on its checkout and worktree.
- Run #153, REQ-126 and their worktrees were **not modified**.
- Tests ran on the private PostgreSQL test cluster, with the real Workflow Engine and Agent Harness.
- No paid model was called.

## 1. Audit: confirmed defects vs. configured behaviour

| Observation in Run #153                                                                                                                                                                    | Finding                                                                      | Status                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------- |
| Analyze and Plan analysed `56824d6`, while the Bug Hunter commits (`07182d0`, `38a8611`) were already on `origin/main`. The agent asked the user, then searched the server's own checkout. | (a) Below                                                                    | **Defect**, fixed                      |
| Plan and Implement re-read files that Analyze had already read.                                                                                                                            | (b) Below                                                                    | **Defect**, fixed                      |
| The run budget was $5 and spend reached $6.54, yet the implement preflight said "warning only" (projected $8.58).                                                                          | (c) Below                                                                    | **Configured behaviour, not a defect** |
| Acknowledgement while auditing (c)                                                                                                                                                         | (d) Below                                                                    | **Defect**, fixed                      |
| Tool calls (analyze 19 Bash, plan 21, implement 129)                                                                                                                                       | Most of the duplication came from (a) and (b). No tool-call limit was added. | No other change                        |

**(a) Stale revision.**

- Agent steps prepare their checkout with `prepareRepository(repo, refresh=false)`. That only ran `git ls-remote <url> HEAD` (an authorization probe) and **never fetched**. The run's checkout therefore stayed at its last fetch, `56824d6`.
- The Implement worktree was cut from a freshly fetched `origin/main` (`56cd6ea`).
- So **one run analysed one revision and implemented on another**. The `ls-remote` answer that would have revealed this was discarded.

**(b) Missed handoff.**

- `collectFileRefs` hands ancestors' file references to the next step, but only from `Read`/`Edit`/`Write`/`MultiEdit`/`Grep` tool calls.
- Analyze and Plan in Run #153 read source only through Bash (`sed -n`, `grep -n`, `git show`), so **zero** references reached Plan or Implement.
- The handoff also did not know which revision a reference came from.

**(c) "Warning only" was the configuration.**

- The installation's `.env` sets `COST_BUDGET_ACTION`; the loaded policy was `action: "warn"`, `runUsd: 5`, `warnPct: 0.8`.
- With `warn` the platform records warnings and never pauses, so the run behaved as configured. The code default is `pause`.
- The gap was transparency: the "exceeded" event, the evidence and the UI did not say which policy applied.

**(d) Acknowledgement defect.**

- The preflight treated **any** earlier `exceeded`/`preflight_projected` event as the developer's acknowledgement, including warnings recorded under `warn`.
- A run that overran while the policy was `warn` would therefore never pause again after an admin switched to `pause`, although nobody acknowledged anything.

**Unchanged.** Verified correct and kept:

- the soft-pause model;
- resume as the acknowledgement;
- the post-attempt check, which fires once per scope;
- automatic retries are budget-checked, and the scheduler never claims a job of a `PAUSED` run;
- the provider-dependent in-turn enforcement.

## 2. Changes

### Repository preflight and revision consistency

**`src/repos/freshness.ts` (new).** `ensureFreshBase` compares the remote's commit for the base branch with the local `origin/<branch>`. Only when they differ does it fetch, and the fetch updates remote-tracking refs only.

**`prepareRepository`** uses it in three ways:

- For URL repositories, the authorization probe became `ls-remote <url> refs/heads/<base>`, so there is no extra network round trip unless the checkout is stale.
- For local repositories, `git ls-remote origin` / `git fetch origin` are used. Local checkouts are never moved.
- The primary checkout is still aligned only when it is clean (`alignCheckoutToBase`, unchanged: non-forced, and it skips a checkout with local changes).

**`src/workflow/sourceRevision.ts` (new) and migration `095_source_revisions.sql`:**

- **Pin.** The first agent step pins each repository's fresh base in `workflow_runs.source_revisions`: branch, commit, checkout head, remote commit, freshness, whether it fetched, time and step. Concurrent pins resolve to the first writer.
- **Decision.** Pinning records an `execution_decisions` row (`kind: source_revision`, `RECORD`).
- **Prompt.** Every agent prompt gets a "Source revision for this run" section with the pinned `branch@sha`.
- **Drift.** If an analysis step's checkout is not at the pin, the step:
  - records an explicit transition (`source_revision`, `RECONCILE`, from/to commits);
  - is told to base its conclusions on the pinned commit (`git diff --stat <pin> HEAD`, `git show <pin>:<path>`) and not to look for other copies of the repository.

  Nothing is reset or rebased.

**`prepareBranch` / `prepareLockedWorkspace`.** A new run branch is cut from the pinned commit instead of the then-current tip, so Implement starts where Analyze and Plan looked; `created_from` reads `origin/main@<sha>`.

- If the pin is not available, preparation fails with a clear error and never invents a base.
- Existing branches and worktrees, stacked subtasks and recovery are unchanged; uncommitted work in a worktree is preserved.

**Attempt metrics** record `source_revision` (pinned and read commit per repository). Harness evidence carries `source_revisions`.

### Cross-step handoff (existing mechanism, no new store)

`collectFileRefs` (`src/workflow/context.ts`) now also:

- **Reads shell commands.** It hands on files named by **read-only shell commands** (`cat`, `sed`, `head`, `tail`, `grep`, `rg`, `nl`, `wc`, `awk`, `git show|diff|log|blame|grep`) from both Claude's `Bash` and Codex's `shell` events. Absolute paths under the run's workspaces are made relative; commands that write are ignored.
- **Checks the revision.** It drops every reference from an ancestor attempt that read a different revision than the run's pin. The excluded attempts are recorded in the snapshot's `prompt_plan.file_refs_stale_attempts`. Attempts from before pinning have no revision and are kept.

Isolation is unchanged: withheld ancestors (`config.withhold`) are removed from `upstream` before references are collected, so their exploration never reaches the step.

The handoff stays a list of references (paths), not excerpts or transcripts, and the agent can re-read anything.

### Cost policy transparency and the acknowledgement fix

- **Budget events.** Post-attempt `warning`/`exceeded` and preflight events now record:
  - `action` — what the platform did: `pause` or `warn`;
  - `policy_action` — the configured policy;
  - `enforcement: platform_soft_pause`;
  - `provider_hard_limit: false`.

  An overrun under `warn` reads "— warning only (cost policy: warn)".

- **Acknowledgement fix.** A scope counts as acknowledged only when an event **actually paused** the run. Older events without `action` keep their previous meaning. The fix is in both the engine preflight (`budgets.ts`) and the in-attempt budget stage.
- **Harness evidence.** `cost.policy` carries `{ action, acknowledged }` and `provider_hard_limit: false`.
- **API.** `GET` run cost returns `policy: { action, warn_pct, unknown_estimate, enforcement, provider_hard_limit, acknowledged }` (`costPolicy()` in `report/cost.ts`).
- **UI.** The run Cost panel states, in VI and EN, what happens at the budget:
  - _pause:_ "the run pauses before its next attempt or turn until you resume (platform soft pause; no provider-enforced cap)";
  - _warn:_ "warning only, the run continues (COST_BUDGET_ACTION=warn)";
  - plus a note when the overrun was already acknowledged.

### Files

- **New:**
  - `migrations/095_source_revisions.sql`
  - `src/repos/freshness.ts`
  - `src/workflow/sourceRevision.ts`
  - `test/harness-execution-efficiency.integration.ts`
- **Modified:**
  - `src/repos/workspaces.ts`, `src/git.ts`, `src/git/provider.ts`
  - `src/workflow/context.ts`, `src/workflow/decisions.ts`, `src/workflow/budgets.ts`
  - `src/agent/harness/stages/{preflight,execute,budget}.ts`, `src/agent/harness/{state,evidence}.ts`
  - `src/report/cost.ts`
  - `web/src/components/Cost.tsx`, `web/src/i18n/catalog.ts`

## 3. Cost policy semantics (as implemented)

| Setting                    | At `warn_pct` | At 100% after an attempt                                          | Projected overrun before an attempt (incl. automatic retries)                  | During a turn                                                              |
| -------------------------- | ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `COST_BUDGET_ACTION=warn`  | Warning event | "exceeded — warning only" event; the run continues                | Event "warning only"; the attempt runs                                         | Not limited                                                                |
| `COST_BUDGET_ACTION=pause` | Warning event | The run is PAUSED; resuming is the acknowledgement for that scope | The run is PAUSED before the attempt; queued jobs are not claimed while paused | Providers that report cost: stopped between turns. Others: preflight only. |

- **Acknowledgement:** only from resuming a pause the platform made. A warning under `warn` never acknowledges.
- **No hard cap is claimed:** no provider enforces a dollar cap, and estimates (the maximum of earlier attempts, or a historical median) are projections, not guarantees.

## 4. Tests

| Command                                                                                                                     | Result                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node test/run-integration.ts test/harness-execution-efficiency.integration.ts`                                             | **9/9**                                                                                                                                                                          |
| `npm test`                                                                                                                  | 1208/1208                                                                                                                                                                        |
| `npx tsc --noEmit -p .` and `-p web`, `npm run lint`                                                                        | clean                                                                                                                                                                            |
| `npm run arch:check`                                                                                                        | 5 cycles / 6 violations (unchanged baseline)                                                                                                                                     |
| `npm run test:integration` (full; includes CodeAct, Bug Hunter, self-development, codex, engine and coding-workflow suites) | **985/988**. The 3 failures are the known pre-existing local ones (`evaluation.integration.ts` ×2; `repository-remotes`, from the host `~/.gitconfig`).                          |
| Mutation check: each fix reverted, the matching test run                                                                    | Without the freshness fix, "stale checkout…" **fails**. Without the acknowledgement fix, "a warning … is not an acknowledgement" **fails**. Both files were restored afterwards. |

How the spec's required cases are covered:

| #   | Requirement                                       | Test                                                                                                                                                     |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stale checkout detected before source analysis    | The remote moves after the checkout's last fetch. The first step pins the new commit (`freshness: refreshed`, `fetched: true`), and the prompts name it. |
| 2   | Base revision propagated across steps             | Plan does not re-pin. After the remote moves again, a new worktree starts at the pin (`created_from origin/main@<pin>`), not the newer tip.              |
| 3   | Worktree changes preserved during recovery        | Uncommitted edits survive re-preparation of the worktree. An uncommitted file in the checkout is untouched; a local checkout is never moved.             |
| 4   | Handoff reused at the same revision               | Bash reads of the exploring step reach the next step                                                                                                     |
| 5   | Changed revision invalidates the handoff          | Exploration recorded at another revision is excluded, and the exclusion is recorded                                                                      |
| 6   | Independent review cannot access withheld context | The step with `withhold` receives none of the withheld step's file references                                                                            |
| 7   | `warn` stays non-blocking                         | 3 steps × $0.7 against a $1 budget complete. The event says "warning only (cost policy: warn)" and the cost API reports `policy.action: warn`.           |
| 8   | `pause` needs acknowledgement                     | The run pauses before step three; `runOnce` runs nothing while paused; it resumes, completes, and reports `acknowledged: ["run"]`                        |
| 9   | Documented acknowledgement                        | A warning recorded under `warn` does not count. After switching to `pause`, the next projected retry pauses.                                             |
| 10  | Retry and recovery obey the policy                | Case 9 (the retry preflight), plus the existing engine test "cost preflight: a retry projected over the budget pauses BEFORE the attempt"                |
| 11  | No regression                                     | Full integration suite above                                                                                                                             |
| —   | Missing pin                                       | A run whose pinned base no longer exists fails clearly instead of inventing a source state                                                               |

## 5. Benchmark

### Methodology

There is no paid run, so **no claim of real token or cost savings** is made. Two kinds of measurement:

1. A replay of **Run #153's recorded tool events** (real data, read-only) through the old and new handoff logic.
2. Deterministic fixtures through the real engine and harness.

### Run #153 replay: references handed to later steps

|                                                         | Old `collectFileRefs` (file tools only) | New (+ read-only shell) |
| ------------------------------------------------------- | --------------------------------------- | ----------------------- |
| References from Analyze available to Plan               | **0**                                   | **8**                   |
| References from Analyze and Plan available to Implement | 0                                       | 28                      |
| Files Plan re-read that Analyze had already read        | 6 of 20                                 | (now pointed to)        |
| Files Implement re-read that Analyze or Plan had read   | 18 of 87                                | (now pointed to)        |

The re-reads are the duplication the handoff can now point at. Whether a model actually reads less, and what that saves in tokens, needs a paid run.

### Revision consistency (fixture, real engine and harness)

|                                           | Baseline (fix reverted)                                             | Optimized                          |
| ----------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| Revision analysed by Analyze and Plan     | The stale `c1`                                                      | The current `c2` (fetched, pinned) |
| Revision Implement's worktree starts from | Whatever tip exists when it starts (`c3` if the remote moved again) | `c2`, the pin                      |
| Same revision across the run              | No                                                                  | Yes                                |

### Overhead of the freshness check (local repository, 3 runs)

| Case                 | Time                                |
| -------------------- | ----------------------------------- |
| Base already current | 16–22 ms (one `ls-remote`)          |
| Base stale           | about 45 ms (`ls-remote` + `fetch`) |

For URL repositories the `ls-remote` already happened on every preflight, so the only addition is a fetch when the checkout is actually stale.

Stage durations, provider turns and token usage in the fixtures come from scripted agents, so they are not reported as savings.

## 6. Limitations

- **Analysis on a moved checkout.** Analysis steps still read the checkout's working tree. When it is not at the pin (a dirty checkout that cannot be aligned, or a local checkout), the step is told and the transition is recorded, but the files on disk are at the checkout's head. Reading the pin needs `git show`.
- **Shell parsing is heuristic.** It recognizes common read-only commands and file extensions; anything else is simply not handed on, which is the safe direction.
- **The pin does not follow later changes on main.** A run keeps its pinned base. Moving to a newer main needs an explicit step: a re-run, or the existing branch/rebase workflow.
- **Leftover temp directories.** Before the full run, `/tmp` (7.8 GB tmpfs) was 85% full of leftover test directories (`ctp-test-*`, `ctp-verification-cache-*`) from earlier runs today. They were removed after checking that no process used them. Test runs leave these behind; that existed before this change.

## 7. Recommendation for this installation

To have budgets pause runs as in Run #153's expectation, set `COST_BUDGET_ACTION=pause` (or remove it, because the code default is `pause`). The Cost panel now shows which policy applies.

## 8. CI and delivery

- **Commit:** on `main`; the SHA is given in the final report.
- **CI:** read from the public GitHub Actions API after the push; the result is in the final report.
- Not deployed. Run #153 was not modified.
