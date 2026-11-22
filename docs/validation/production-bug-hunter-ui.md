# Production Errors: Bug Hunter in the incident accordion

Branch `feat/bug-hunter-inline-ui` from `main` @ `07182d0`, 2026-11-22. Everything ran offline:

- the private PostgreSQL test cluster;
- the real server and Workflow Engine;
- the Agent Harness, with the scripted fake `codex` agents;
- the bubblewrap reproduction sandbox;
- Chromium on the production bundle.

No VPN, SigNoz or Splunk was used, and no paid provider was called.

## What changed

### Inline Bug Hunter

Expanding an incident in the **Incidents** tab now shows the Bug Hunter panel directly below the evidence. From there the user can:

- start a hunt, choosing repositories and a provider;
- watch the timeline and the intermediate results;
- cancel;
- read the findings;
- create a fix task;
- open the workflow run, a single step, or **View incident details**.

The Incident Detail page keeps the full history of hunts.

### One implementation, two places

Both the accordion and Incident Detail are built from the same components in `web/src/pages/prodErrors/bugHuntParts.tsx`:

- `HuntView`
- `HuntTimeline`
- `HuntResults`
- `StartHuntForm`
- `StatusPill`
- the `useHuntDetail` and `usePolling` hooks

`BugHunter.tsx` composes them twice: `BugHunter` for the detail page and `BugHunterInline` for the accordion. There is no second backend path and no change to verification semantics.

### Timeline

The old compressed horizontal stage chips are replaced by a vertical, responsive timeline built from the workflow's own step rows. For each stage it shows:

- the state, as both an icon and a word: done, in progress, pending, failed, waiting for input, or skipped;
- the elapsed time, computed from `started_at`/`finished_at` and the server's time;
- the attempt number, when the stage is being retried;
- a one-line description of what a pending or active stage does (a static, localized description of the stage, not an agent action);
- for the running stage, the **last recorded event** (a platform log line or a tool name from `workflow_events`), labelled "Last recorded: …";
- the recorded error, for a failed stage;
- the reason, for a skipped stage.

A stage is a link (to `#/runs/:id/:step`) only once it has run, because only then does the run view have a transcript or logs for it. Pending stages are plain status indicators.

### Results by phase

| Phase                               | What is shown                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued, or investigating            | "No verified findings yet — the hunt is still investigating."                                                                                                                                                        |
| Hunter done, triage not yet run     | "The hunter found N candidate(s) — not verified, hypotheses only", with an `unverified` tag on each                                                                                                                  |
| Triage done, report not yet written | "Independently verifying N claim(s)", listing the platform-built claims only, plus how many were deferred or rejected                                                                                                |
| Completed                           | First "N code bug(s) confirmed" or "Finished: no code bug was confirmed". Then Confirmed and Suspected findings, open. Then Blocked and Rejected, behind disclosure. Then coverage and execution, behind disclosure. |
| Partial                             | The same as Completed, with a partial-result notice                                                                                                                                                                  |
| Failed                              | The failed stage, its recorded reason, and a link to the step                                                                                                                                                        |
| Canceled                            | "The bug hunt was canceled; no findings were produced."                                                                                                                                                              |

"0 confirmed" is never shown while a hunt is running.

**Findings.** Each finding keeps two separate pills: **Code bug** and **Incident cause**. It also shows the trigger, expected → actual, the verification basis and the reproduction outcome with its log link. The finer detail sits behind "Detailed evidence": revision, causality basis, command, execution path, alternatives, missing proof and hunter evidence. A fix task shows a loading state and then a link to its run.

### Row header and requests

| What                         | How                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hunt state on collapsed rows | **One** batched request, `GET /api/bug-hunts/summary?fingerprints=…`: the requester's latest hunt per incident, in a single SQL query. Collapsed rows issue no other requests and render no Bug Hunter body. |
| Hunt detail                  | `GET /api/bug-hunts/:id` (existing), fetched only by the expanded row                                                                                                                                        |
| Polling the open row         | Every 5 s, only while that hunt is active, the row is open and the browser tab is visible. Labelled "Refreshes every 5 s (not real-time)".                                                                   |
| Polling the summary          | Only while a _collapsed_ row has an active hunt. The open row's hunt polls itself, so the two never poll the same hunt.                                                                                      |
| Summary refreshes on change  | Refreshed once when a hunt started from the accordion finishes. Not refreshed on every poll.                                                                                                                 |
| Remembered hunt per incident | Kept in page state, so collapsing and reopening, and list refreshes, keep the same run                                                                                                                       |

The existing filters, search, deep links, scan, lifecycle and work-item actions are unchanged.

### Backend additions (small)

- `GET /api/bug-hunts/summary`.
- `GET /api/bug-hunts/:id` gains:
  - per stage: `error`, `skipped_reason`, `attempt` and `max_attempts`;
  - `activity`: the running stage's last recorded event;
  - `verifying`: triage's claims, including only id, location, category and claim;
  - `server_time`.

### Other

- **Responsive:** a single column on narrow screens and no fixed-width rows.
- **Languages:** Vietnamese and English for all new text, including stage names. A step that is not part of Bug Hunter keeps the workflow's own name.
- **No native browser dialogs.**

## Verification

| Command                                                                                               | Result                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit -p .` and `-p web`, `npm run lint`                                                  | clean                                                                                                                                               |
| `npm test`                                                                                            | 1208/1208                                                                                                                                           |
| `node test/run-integration.ts` Bug Hunter, prodErrors, prod-errors-go, analytics, idempotency, intake | 65/65                                                                                                                                               |
| `npm run build && CHROMIUM_BIN=<nix chromium> npm run smoke:bug-hunter`                               | 2/2                                                                                                                                                 |
| `npm run smoke:prod-errors-tabs` (existing incident list on a stubbed API, EN and VI)                 | PASS / PASS                                                                                                                                         |
| `npm run test:integration` (full)                                                                     | 976/979. The 3 failures are the known pre-existing local ones (`evaluation.integration.ts` ×2; `repository-remotes`, from the host `~/.gitconfig`). |

### New integration tests (`test/production-bug-hunter.integration.ts`, 11/11)

**Progress for the UI.** A scripted hunter pauses so the API can be observed while the stage runs. The test checks:

- the status is queued before anything runs, with no result shown;
- the `hunt` stage is `RUNNING`, with `started_at`, `server_time` and its last recorded activity;
- after the hunter, its candidate appears as unverified;
- after triage, the status is `verifying` and the claims carry no hunter hypothesis or evidence;
- the batched summary covers several incidents in one call and only the requester's hunts.

**Failed stage.** The failing `hunt` stage exposes its recorded reason (`… submit_result …`).

### Browser journeys (`test/bug-hunter.browser.ts`)

The test advances the real scheduler step by step while the page polls, so every intermediate state is real. Numbers refer to the spec's list:

| #       | Journey                           | Asserted                                                                                                                                                                                                                                                                       |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1, 11   | Collapsed list                    | One summary request and no detail requests. Header badges show `1 confirmed`, `Failed` and `Queued`. No Bug Hunter body on collapsed rows.                                                                                                                                     |
| 1       | Expand an incident without a hunt | Bug Hunter is shown inline, with the "No bug hunt yet" text                                                                                                                                                                                                                    |
| 2       | Start from the accordion          | One `POST`. The hunt appears as Queued, with the polling notice and "No verified findings yet". A pending stage is not a link.                                                                                                                                                 |
| 3, 4, 5 | Scheduler advances                | The hunter's candidates are labelled "not verified, hypotheses only". The `hunt` stage shows Done and becomes a link; `triage` shows Pending. No "no bug confirmed" text appears. After triage, the panel shows "Independently verifying 1 claim(s)" and the status Verifying. |
| 8       | Cancel                            | The status becomes Canceled, the results text says canceled, and the row header shows Canceled                                                                                                                                                                                 |
| 10      | Collapse and reopen               | The same hunt id is shown                                                                                                                                                                                                                                                      |
| 6, 7    | Completed hunt                    | Confirmed `Fill` shows Code bug CONFIRMED, Incident cause PROBABLE and `reproduced`. Suspected `Format` is listed. Detailed evidence shows the `go test` command. Create fix task ends with a run link.                                                                        |
| 9       | Failed hunt                       | The callout reads "Bug Hunter: … submit_result …" with a step link, and the timeline marks the stage Failed                                                                                                                                                                    |
| 11      | Requests                          | Detail requests went only to the three hunts that were expanded                                                                                                                                                                                                                |
| 12      | Incident Detail                   | Reached through "View incident details"; its hunt history renders                                                                                                                                                                                                              |
| 13      | Vietnamese at 390 px              | Both verdict pills and the Vietnamese stage names are shown, and no Bug Hunter element extends past the viewport                                                                                                                                                               |
| 5, 8    | Across the run                    | No browser-native dialogs and no page errors                                                                                                                                                                                                                                   |

### Screenshots (`docs/validation/production-bug-hunter-ui/`)

- [Collapsed incidents](production-bug-hunter-ui/1-collapsed.png)
- [Expanded, before a hunt](production-bug-hunter-ui/2-expanded-before.png)
- [Active hunt (verifying)](production-bug-hunter-ui/3-active.png)
- [Completed with findings](production-bug-hunter-ui/4-completed.png)
- [Failed hunt](production-bug-hunter-ui/5-failed.png)
- [Mobile, Vietnamese](production-bug-hunter-ui/6-mobile-vi.png)

## Limitations

- **Activity is the last recorded event, not live streaming.** A provider that records nothing during a long turn shows no activity line, only the elapsed time.
- **The summary covers the requester's own hunts.** An admin in support mode sees others' hunts only on Incident Detail.
- **Scripted agents.** The agents are scripted, so the journeys verify the UI and the platform, not a model's findings.

## CI and delivery

- **Commit:** on branch `feat/bug-hunter-inline-ui`, pushed.
- **CI on this branch: NOT VERIFIED.** CI runs on pushes to `main` and on pull requests, and no PR could be opened because `gh` is not authenticated on this machine.
