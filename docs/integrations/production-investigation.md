# Production Incident Investigation (Splunk)

Read-only workflow that answers operational questions about real production incidents from Splunk logs, repository
code and cross-service event correlation. It runs on demand (never continuously) and never changes code, data,
configuration or Splunk objects.

- Workflow id `production-incident-investigation`, category **Operations / Debugging**, `execution_mode: read_only`
  (validated: a read-only workflow cannot contain `coding_agent`, `command` or `git_pull_request` steps).
- UI: sidebar **Điều tra Production / Investigations** (`#/investigations`), the run view (DAG) shows an investigation
  card, `#/investigations/<run id>` shows the evidence.
- Code: `src/investigation/` (pure logic + steps), `src/integrations/splunk.ts` (client, guard rails, evidence store),
  `migrations/043_splunk_searches.sql`, `web/src/pages/Investigations.tsx`.

## How it fits the existing platform

Nothing new orchestrates: the workflow is a seeded template on the existing DAG engine (durable steps, retries,
resume, `run_if`), its agent steps are ordinary read-only `agent` steps (Claude, Codex, Cursor or Antigravity through
the existing executors and tool bridge), and the deterministic parts are `integration` actions.

```
parse_request (integration: investigation_parse)          request → identifiers, window, objectives, initial SPL
  └ discover (integration: repository_discovery, optional) repository ranking (+AI when ambiguous); no repos → continue
      ├ analyze_code  (agent, read-only)                    code_intelligence.search + Grep/Read: services, log formats, ids
      └ search_logs   (agent, read-only)                    splunk_search, labels events by evidence_ref
          correlate   (integration: investigation_correlate) labels × stored evidence → timeline, completeness
            refine_search (agent, run_if correlate.complete == false)  one bounded refinement round
              timeline (integration: investigation_correlate, final)
                latency (integration: investigation_latency)
                  analyze_findings (agent)                  answers, findings, hypotheses, next steps
                    report (integration: investigation_report)  summary + developer report (artifact)
```

Bounded: one refinement round, at most 6 + 8 searches requested by the step instructions, and a hard per-run
`splunk.queryBudget`. Interrupted or re-executed steps reuse stored searches (same query + window in the same run is
answered from `splunk_searches`, not Splunk), so resuming never restarts every search.

## Trust model (no hallucination)

Agents only **label** stored log events by reference (`S<search id>:<n>`). The deterministic steps:

- reject labels whose reference is not in a stored search of the run;
- take timestamp, precision, timezone, service and identifiers from the stored event — an agent's stated time is
  ignored (recorded as a conflict), an identifier the agent claims is used only if it occurs in the event;
- relate events only through shared identifiers (`order_code`, `shipment_code`, `shipment_id`, `tracking_no`,
  `request_id`, `trace_id`, `correlation_id`, `message_id`, by value, ≥ 6 characters) — never by time proximity.
  Direct match with the requested entity = **confirmed**; reached through another identifier = **inferred**; no
  identifier path = **unknown**, listed separately and never used for conclusions;
- fold identical log lines returned by overlapping searches, number Kafka redeliveries (same message id), number
  outbound attempts, sort by the logged time (out-of-order arrival does not matter);
- pair latency events by a shared request-scope id first (request/correlation/message/trace id); otherwise by a shared
  business id with the closest preceding event (inferred, ambiguity stated when several attempts fit); a synchronous
  response is never paired across different request ids; a negative difference is reported as clock skew, not a
  latency;
- keep a synchronous HTTP response, an asynchronous callback, broker delay and end-to-end time as separate latencies,
  each with the two compared events and a qualification (a callback delay is not the partner's pure processing time);
- report a label URL that was only seen later as "first observed", not as its generation time;
- cap the findings agent's classifications by the evidence they cite and drop unknown references.

## Splunk integration

Credentials are never sent to a model, never returned to the browser and are stored with the existing encrypted
secrets (`user_secrets` / `shared_secrets`).

| Credential | Where | Notes |
|---|---|---|
| Personal Splunk Web session (cookie) | Integrations → Splunk | Existing mechanism (Google SAML, no token needed). Calls go through Splunk Web's `/<locale>/splunkd/__raw` proxy with the CSRF form key. |
| Personal Splunk token | Integrations → Splunk → *personal token* | `Authorization: Bearer`. Sent to `splunk.managementUrl` when set (e.g. `https://splunk:8089`), else through the Splunk Web proxy. |
| Shared service-account token | Integrations → Splunk → *shared* (admin only) | Members use it only when `splunk.allowSharedToken` is true. A personal credential always wins. Every search is still audited per user. |

**Test connection** (`POST /api/integrations/splunk/test`, tool `splunk_test_connection`) checks identity, warns when
the account has write/admin capabilities (`delete_by_keyword`, `admin_all_objects`, …) and runs a 15-minute
`| tstats count` per default index.

Endpoints differ between Splunk versions and deployments, so the client uses `search/jobs` (create, poll, results with
`offset`/`count`, cancel on timeout) by default and `search/v2/jobs/export` (falling back to `search/jobs/export` on 404)
in `mode: "export"`.

### Guard rails (`validateInvestigationSpl`, `resolveWindow`)

- Read-only commands only (`delete`, `collect`, `outputlookup`, `sendemail`, `rest`, `map`, `script`, `dbx*`, … refused
  anywhere, including subsearches).
- `index=` required, no wildcard index, within `splunk.allowedIndexes` when set.
- No leading-wildcard terms; a base search with nothing but index/sourcetype/source/host must aggregate (`stats`,
  `timechart`, `head` …).
- A time range is required. Inline `earliest=`/`latest=` in the base search are lifted out and validated like the tool
  arguments (absolute times are read in `splunk.timezone`); time modifiers elsewhere are refused. The window is capped
  at `splunk.maxMinutes`, results at `splunk.maxResults`, concurrency at `splunk.concurrency`, searches per run at
  `splunk.queryBudget`.
- Every search is a row in `splunk_searches` (user, run, step, SPL, window, mode, credential kind, sid, rows, duration,
  error). Results are stored only as sanitized, normalized events: credentials, `Authorization`, cookies, phone,
  e-mail, address, names, card numbers, signed-URL parameters are redacted (identifiers are extracted before masking).
  Agents receive compact events (timestamp, index, source, sourcetype, service, identifiers, short excerpt) and fetch a
  full sanitized event only on request (`splunk_get_event`).
- Access: searches and events are visible only within their run (agents) or to the run's authorized viewers (API,
  `requireRun`); outside a run, only to the user who ran them.

### Agent tools

`splunk_search`, `splunk_get_event`, `splunk_get_search_results`, `splunk_get_search_status`,
`splunk_build_search_url`, `splunk_test_connection` (all read-only, discovered through `list_tools` / `call_tool`).
The older relative-window `splunk.search` stays for the production error scan and existing prompts.

### Manual mode

Without a working credential, `splunk_search` inside a run records a `manual_pending` search and returns the SPL,
window and Splunk Web link; the agent asks the user (`ask_user`). The user runs it in Splunk Web, exports JSON or CSV
(`_time`, `_raw`) and pastes it into the search card of the investigation page
(`POST /api/runs/:id/investigation/manual-results`). The paste is parsed, capped and sanitized like API results (the raw
paste is not stored); the agent continues with `splunk_get_search_results`.

## Configuration (`config.json` → `splunk`, no secrets)

```json
"splunk": {
  "baseUrl": "https://siem.hasaki.work",
  "managementUrl": "",
  "locale": "en-US",
  "environment": "production",
  "timezone": "Asia/Ho_Chi_Minh",
  "allowedIndexes": ["k8s_prod"],
  "defaultIndexes": ["k8s_prod"],
  "maxMinutes": 10080,
  "maxResults": 500,
  "timeoutSeconds": 60,
  "concurrency": 3,
  "queryBudget": 25,
  "allowSharedToken": false
}
```

Setup: run migrations (automatic at start), open **Integrations → Splunk**, paste the Splunk Web cookie or a personal
token of a **read-only** role, press **Test connection**. Administrators may add a shared service-account token and turn
on `allowSharedToken`. Production investigation is only verified once that test succeeds against the real Splunk with
the intended role.

## API

| | |
|---|---|
| `POST /api/runs` `{ workflow: "production-incident-investigation", inputs: { request, environment?, indexes?, earliest?, latest? }, output_locale }` | start |
| `GET /api/runs/:id/investigation` | searches (audit + sanitized events), parsed request, timeline, latency, report |
| `POST /api/runs/:id/investigation/manual-results` `{ search_id, text }` | manual mode |
| `POST /api/workflows/route` `{ text }` | intent routing suggestion (workflows declaring `triggers`) |
| `POST /api/integrations/splunk/token` · `/test` · `/shared` · `/shared/clear` | credentials / test (shared = admin) |

## Tests and evaluation

- `test/investigation.test.ts` — Vietnamese/English parsing, timezone/precision, redaction, pasted results,
  correlation, duplicates and redelivery, out-of-order events, retries and attempts, incorrect pairing, latency, clock
  skew, empty/incomplete evidence, report and finding validation, template/read-only validation, intent routing.
- `test/splunk-investigation.test.ts` — mock Splunk: SPL guard rails, token authentication failures (401/403), test
  connection, job search with epoch window, dedup/resume, pagination, empty results, export v2→v1 fallback, timeout
  cancellation, query budget, manual mode, cross-run/cross-user isolation, shared token permission, and an end-to-end
  DAG run (interrupted step resumed from stored searches, refinement round, Vietnamese report, nothing state-changing).
- `npm run eval:investigation` — adds the production-investigation benchmark (synthetic HasakiNOW logs in
  `src/investigation/fixtures.ts`: careful, adversarial, incomplete, observed-only and no-access scenarios).
  `scoreTimelineScenario(scenario, labels)` grades labels produced by a live agent on the same synthetic searches.

No test needs production credentials.

## Limitations

- Only one Splunk environment is configured at a time (`splunk.environment`); the form's environment is informational.
- Request parsing is deterministic (common Vietnamese/English date and time phrasings, identifier shapes); agents see
  the raw request and may search other identifiers, but the initial window comes from the parser or the explicit form.
- Event typing is the agent's interpretation of a log line; the platform verifies references, times and identifiers,
  not the semantic label.
- The `datetime-local` filters are interpreted with the fixed `+07:00` offset for `Asia/Ho_Chi_Minh` (UTC otherwise).
