# SigNoz observability

SigNoz is a second production telemetry source next to Splunk. Agents read logs, traces and metrics through read-only
platform tools, and the Production Incident Investigation workflow can use Splunk, SigNoz or both.

## Setup (per user)

1. In SigNoz: **Settings → Service Accounts → New Service Account**. Assign a read-only role (`signoz-viewer`), then
   **Keys → Add Key** and copy the key (it is shown once). Use a dedicated service account with the least privilege.
2. In the platform: **Integrations → SigNoz**. Enter the domain (SigNoz Cloud or self-hosted, `https://…`) and the key,
   then **Test & enable**. The key is tested before it is saved.

- Each user stores their own domain and key, encrypted in `user_secrets` (kind `signoz`, AES-256-GCM). A run uses its
  owner's configuration only. The key is never returned to the browser and never reaches prompts, tool results, logs or
  artifacts.
- Changes apply without a restart. The current user's config updates on save; workers reload personal integrations at
  most every 15 seconds.
- Leaving the key empty on a later save keeps the stored key. **Disable** keeps the configuration but hides the tools.
  **Disconnect** deletes it.
- Save, test, failed save and disconnect are written to `audit_log` (`integration.signoz.*`), without secrets.

### Self-hosted on a private network

Private, loopback, link-local, CGNAT and ULA destinations are blocked by default. An administrator approves specific
hosts in **Settings → Integration → Approved internal SigNoz hosts**. That setting is audited as
`settings.operator.update` and applies immediately. Only approved hosts may use `http://`. Cloud metadata addresses
(`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, …) are always blocked.

## API compatibility

Only documented SigNoz API is used:

| Purpose | Request |
|---|---|
| Key check | `GET /api/v1/service_accounts/me` (200 = valid, 401 = invalid) |
| Every query | `POST /api/v5/query_range`, header `SIGNOZ-API-KEY`, `start`/`end` in Unix ms, `requestType` `raw` / `scalar` / `time_series`, `compositeQuery.queries[]` of `builder_query` |
| Services | `query_range` scalar `count()` over traces grouped by `service.name` (no dedicated endpoint is documented) |
| One trace | `query_range` raw traces with `trace_id = '…'` (no trace-by-id endpoint is documented) |

The v5 API is required. If `/api/v5/query_range` answers 404 or 405, the result is reported as `unsupported_api`.
Older self-hosted versions without service accounts (before v0.114.0) fail the key check gracefully and go on to the
query probe.

Errors are classified for the UI and for agents:

| Kind | Meaning |
|---|---|
| `auth_failed` | 401 |
| `forbidden` | 403 or `authz_forbidden` |
| `unsupported_api` | 404 or 405 |
| `invalid_query` | 400 or 422, with SigNoz's `error.message` |
| `server_error` | 5xx after retries |
| `connection_failed` | network or TLS error, timeout, refused redirect, oversized response |
| `blocked_destination` | the SSRF policy refused the destination |
| `not_configured` | no SigNoz configuration for this user |
| `budget_exhausted` | the run or step query budget is used up |

An empty result is a success, and it says explicitly that the absence of data is not evidence of health.

## Network safety (`src/integrations/safeHttp.ts`)

- The URL must be https (http only for an approved internal host). Userinfo, query strings and fragments are refused.
- Every resolved address is checked when the socket connects, which also defeats DNS rebinding. IP-literal hosts are
  checked up front.
- Redirects are never followed, so the key is never forwarded. TLS verification stays on and uses the system CA, as the
  server does.
- Timeout (`signoz.timeoutMs`), a response size cap (`signoz.maxResponseBytes`), bounded retries with jitter on network
  errors, 429 and 5xx (`signoz.maxRetries`), and a per-user token-bucket rate limit.

## Agent tools

These tools are read-only and available to every agent provider through the platform MCP tools (`list_tools` /
`call_tool`). They are hidden from `list_tools`, the step prompt's integration catalog and `call_tool` when the run owner
has not configured SigNoz or has disabled it.

| Tool | Use |
|---|---|
| `signoz_list_services` | services with span counts (learn service names) |
| `signoz_aggregate_logs` | count / count_distinct / avg / p95 grouped by fields; `time_series=true` for spikes |
| `signoz_search_logs` | raw logs, stored as evidence events (`S<search>:<n>`) |
| `signoz_search_traces` | spans (operation, errors, status code), stored as evidence events |
| `signoz_get_trace` | every span of one trace, in time order |
| `signoz_query_metrics` | one metric as time series, with min/max/avg/last per series |

- **Filters.** `service`, `environment`, `severity`, `operation`, `trace_id`, `span_id`, `has_error` and `status_code`
  are compiled into a quoted, escaped `filter.expression`.
- **Free expression.** An optional free `expression` is bounded to 1000 characters, may not contain `;` or backticks,
  and must have balanced quotes.
- **Evidence.** Raw rows are stored like Splunk and Argo CD events in `splunk_searches` (mode `signoz`). They flow
  through correlation, timeline and report, and `splunk_get_event` reads them.
- **Untrusted content.** Telemetry text comes back inside one `<untrusted_input source="signoz_telemetry">` block,
  marked as untrusted data. Counts, ids and refs stay structured.

### Budgets (`config.json` → `signoz`)

| Key | Default |
|---|---|
| `defaultMinutes` | 15 |
| `maxMinutes` | 7 days |
| `defaultLimit` | 100 |
| `maxLimit` | 1000 |
| `timeoutMs` | 15000 |
| `maxRetries` | 2 |
| `maxResponseBytes` | 2 MB |
| `maxCallsPerStep` | 20 |

Every SigNoz call, aggregates included, is recorded as one search row. It counts against both the run budget
(`splunk.queryBudget`, shared with Splunk and Argo CD searches) and the per-step cap.

## Investigations

`production-incident-investigation` takes `inputs.observability`:

| Value | Sources |
|---|---|
| `auto` (default) | every source the run owner has connected; Splunk when none is connected, since its manual mode still works |
| `splunk` | Splunk only |
| `signoz` | SigNoz only |
| `both` | Splunk and SigNoz |

QC investigations still use Argo CD.

`parse_request` outputs `observability` and `signoz_queries`, which are suggested starting points: errors grouped by
service, then logs by identifier. It adds a note when SigNoz was selected but is not connected.

The investigation rules tell agents to:
- aggregate first, then narrow;
- use traces for latency and failed spans;
- keep confirmed findings apart from hypotheses;
- treat missing telemetry as missing evidence, never as health.

## Architecture decisions

- **No new provider framework.** A small `selectProviders` helper (`src/investigation/observability.ts`) chooses
  sources. The Splunk integration is unchanged apart from `storeExternalSearch` accepting `source: "signoz"`.
- **Evidence store reuse.** Reusing `splunk_searches` gives SigNoz the existing evidence refs, dedup, run budget,
  authorization (`authorizedRow`), timeline and report with no parallel store. Migration `064` only widens its
  mode/auth checks.
- **Personal credentials,** matching Splunk's personal model: no shared key and no admin-managed SigNoz account.

## Known limitations

- The scheduled production-error scan (`src/prodErrors/scan.ts`) remains Splunk-only.
- Metrics need the exact metric name. There is no documented metric-catalog endpoint in use.
- `deployment.environment` is the conventional OpenTelemetry resource attribute used for the `environment` filter.
  Deployments that label environments differently should use `expression`.
- Raw result pages use `offset`. SigNoz's `nextCursor` is reported but not used for paging.
