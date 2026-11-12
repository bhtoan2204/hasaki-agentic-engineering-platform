import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { execution } from "../src/auth/execution.ts";
import { hashPassword } from "../src/auth/password.ts";
import { ensureTestOwner } from "../src/auth/testOwner.ts";
import {
  clearSharedSplunkToken,
  clearSplunkCookie,
  getEvent,
  investigationSearch,
  searchResults,
  searchStatus,
  setSharedSplunkToken,
  setSplunkToken,
  splunkStatus,
  splunkTestConnection,
  storeExternalSearch,
  submitManualResults,
  validateInvestigationSpl,
} from "../src/integrations/splunk.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { getRun, startRun, reexecuteStep } from "../src/workflow/engine.ts";
import { drain } from "../src/workflow/scheduler.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { registerExecutor, type ExecutionContext } from "../src/workflow/executors/registry.ts";
import { integrationExecutor, setAiRepositoryRanker } from "../src/workflow/executors/builtin.ts";
import { investigationDetail, startFixFromInvestigation } from "../src/investigation/service.ts";
import { repositories } from "../src/repos/service.ts";
import type { ExecResult } from "../src/workflow/types.ts";
import * as F from "../src/investigation/fixtures.ts";

process.env.SPLUNK_POLL_MS = "20";
const GOOD = "good-token-0123456789abcdefghij";
const ADMINISH = "admin-token-0123456789abcdefghij";
let server: Server;
const jobs = new Map<string, { search: string; earliest: string; latest: string; polls: number }>();
const log: Array<{ method: string; path: string; form?: URLSearchParams; auth?: string }> = [];
let sidSeq = 0;
let alive = true;

function rowsFor(search: string): Record<string, unknown>[] {
  if (search.includes("NOTHING")) return [];
  if (search.includes("MANYROWS"))
    return Array.from({ length: 7 }, (_, i) => ({
      _time: `2026-11-10T08:4${i}:00.000+07:00`,
      index: "k8s_prod",
      _raw: JSON.stringify({ message: `row ${i}`, order_code: "MANYROWS0001" }),
    }));
  if (search.includes(F.ORDER)) return F.SEARCH_BY_ORDER;
  if (search.includes(F.SHIPMENT)) return F.SEARCH_BY_SHIPMENT;
  if (search.includes("hasakinow response")) return F.SEARCH_CONNECTOR;
  return [];
}

before(async () => {
  await migrate();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace(/^\/en-US\/splunkd\/__raw/, "");
    const json = (code: number, b: unknown) => (
      res.writeHead(code, { "content-type": "application/json" }),
      res.end(JSON.stringify(b))
    );
    const auth = String(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      log.push({ method: req.method!, path, form, auth });
      if (!alive || ![`Bearer ${GOOD}`, `Bearer ${ADMINISH}`].includes(auth))
        return json(401, {
          messages: [{ type: "ERROR", text: "call not properly authenticated" }],
        });
      if (path === "/services/authentication/current-context")
        return json(200, {
          entry: [
            {
              content: {
                username: auth.includes("admin") ? "svc-admin" : "svc-readonly",
                roles: ["user"],
                capabilities: auth.includes("admin") ? ["search", "delete_by_keyword"] : ["search"],
              },
            },
          ],
        });
      if (req.method === "POST" && path === "/services/search/jobs") {
        const search = form.get("search")!;
        if (search.includes("FORBIDDENIDX"))
          return json(403, { messages: [{ type: "ERROR", text: "index not permitted for role" }] });
        if (form.get("exec_mode") === "oneshot") return json(200, { results: [{ count: "42" }] });
        const sid = `sid-${++sidSeq}`;
        jobs.set(sid, {
          search,
          earliest: form.get("earliest_time")!,
          latest: form.get("latest_time")!,
          polls: 0,
        });
        return json(201, { sid });
      }
      if (
        req.method === "POST" &&
        (path === "/services/search/v2/jobs/export" || path === "/services/search/jobs/export")
      ) {
        const search = form.get("search")!;
        if (path.includes("/v2/") && search.includes("OLDSPLUNK"))
          return json(404, { messages: [{ type: "ERROR", text: "not found" }] });
        const head = Number(search.match(/\| head (\d+)$/)?.[1] ?? 1000);
        const rows = rowsFor(search.includes("OLDSPLUNK") ? F.ORDER : search).slice(0, head);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          [
            JSON.stringify({ preview: true, result: { _raw: "partial" } }),
            ...rows.map((r) => JSON.stringify({ preview: false, result: r })),
          ].join("\n"),
        );
        return;
      }
      const m = path.match(/^\/services\/search\/jobs\/([^/]+)(\/results|\/control)?$/);
      if (m) {
        const j = jobs.get(decodeURIComponent(m[1]));
        if (!j) return json(404, { messages: [{ type: "FATAL", text: "Unknown sid." }] });
        if (m[2] === "/control") return json(200, {});
        if (m[2] === "/results") {
          const off = Number(url.searchParams.get("offset") ?? 0);
          const count = Number(url.searchParams.get("count") ?? 100);
          return json(200, { results: rowsFor(j.search).slice(off, off + count) });
        }
        j.polls++;
        const slow = j.search.includes("SLOWJOB");
        return json(200, {
          entry: [
            {
              content: {
                dispatchState: slow ? "RUNNING" : "DONE",
                isDone: !slow,
                doneProgress: slow ? 0.1 : 1,
                eventCount: rowsFor(j.search).length,
                resultCount: rowsFor(j.search).length,
                scanCount: 1000,
                ttl: 600,
              },
            },
          ],
        });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.splunk.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  config.splunk.managementUrl = "";
  config.splunk.allowedIndexes = ["k8s_prod"];
  config.splunk.defaultIndexes = ["k8s_prod"];
  registerBuiltinTools();
});
after(async () => {
  await settleBackground();
  server.close();
  await pool.end();
});

/** A real run row so searches can reference it (FK); the engine is not driven here. */
async function bareRun(ownerId?: number) {
  await seedTemplates();
  const run = await startRun({
    definitionKey: "production-incident-investigation",
    inputs: { request: F.REQUEST_VI },
    start: false,
    ...(ownerId ? { ownerId } : {}),
  });
  return run.id;
}

const W = { earliest: "2026-11-10T08:35:00+07:00", latest: "2026-11-10T09:15:00+07:00" };

test("SPL guard rails: index required and allowed, no wildcards, inline time lifted, unbounded refused", () => {
  assert.throws(() => validateInvestigationSpl(`"${F.ORDER}"`), /index=/);
  assert.throws(
    () => validateInvestigationSpl(`index=* "${F.ORDER}"`),
    /không được phép|not allowed|wildcard/,
  );
  config.splunk.allowedIndexes = [];
  try {
    assert.throws(
      () => validateInvestigationSpl(`index=k8s* "${F.ORDER}"`),
      /wildcard indexes are not allowed/,
    );
  } finally {
    config.splunk.allowedIndexes = ["k8s_prod"];
  }
  assert.throws(
    () => validateInvestigationSpl(`index=hr_prod "${F.ORDER}"`),
    /không được phép|hr_prod/,
  );
  assert.throws(() => validateInvestigationSpl(`index=k8s_prod *VL160RW01`), /leading-wildcard/);
  assert.throws(() => validateInvestigationSpl(`index=k8s_prod`), /unbounded/);
  assert.ok(validateInvestigationSpl(`index=k8s_prod | stats count by sourcetype`));
  for (const bad of [
    "index=k8s_prod x | delete",
    "index=k8s_prod x | outputlookup a.csv",
    "index=k8s_prod x | collect index=k8s_prod",
    "| rest /services/authentication/users",
    "index=k8s_prod x | sendemail to=a@b.c",
    "index=k8s_prod [| rest /x] x",
    'index=k8s_prod x | map search="search x"',
  ])
    assert.throws(() => validateInvestigationSpl(bad), /không được phép|not allowed|index/, bad);
  const v = validateInvestigationSpl(
    `index=k8s_prod "${F.ORDER}" earliest="11/10/2026:08:35:00" latest="11/10/2026:09:15:00" | table _time message _raw | sort 0 _time | head 500`,
  );
  assert.equal(v.earliest, "11/10/2026:08:35:00");
  assert.equal(v.latest, "11/10/2026:09:15:00");
  assert.doesNotMatch(
    v.spl,
    /earliest|latest/,
    "inline window removed from the SPL; enforced through the job parameters instead",
  );
  assert.throws(
    () =>
      validateInvestigationSpl(`index=k8s_prod x | append [search index=k8s_prod y earliest=0]`),
    /time modifiers/,
  );
});

test("authentication: invalid token refused before saving; 401 marks the credential invalid; 403 explained; status never leaks the token", async () => {
  await clearSplunkCookie();
  await assert.rejects(setSplunkToken("short"), /không đúng dạng/);
  await assert.rejects(
    setSplunkToken("bad-token-0123456789abcdefghijkl"),
    /token bị từ chối \(401\)/,
  );
  const st = await setSplunkToken(GOOD);
  assert.equal(st.connected, true);
  assert.equal(st.auth, "token");
  assert.equal(st.user, "svc-readonly");
  assert.doesNotMatch(JSON.stringify(st), new RegExp(GOOD));
  const sent = log.find(
    (l) => l.path === "/services/authentication/current-context" && l.auth === `Bearer ${GOOD}`,
  );
  assert.ok(sent, "token sent as a Bearer header through the Splunk Web proxy");
  const runId = await bareRun();
  await assert.rejects(
    investigationSearch({ query: `index=k8s_prod FORBIDDENIDX ${F.ORDER}`, ...W }, { runId }),
    /403: tài khoản Splunk không có quyền/,
  );
  alive = false;
  await assert.rejects(
    investigationSearch({ query: `index=k8s_prod "${F.ORDER}" x`, ...W }, { runId }),
    /401/,
  );
  assert.equal((await splunkStatus()).connected, false);
  alive = true;
  await setSplunkToken(GOOD);
});

test("test connection reports identity, read-only posture and index access", async () => {
  await setSplunkToken(GOOD);
  const r = await splunkTestConnection();
  assert.equal(r.ok, true);
  assert.equal(r.read_only, true);
  assert.deepEqual(r.indexes, [{ index: "k8s_prod", ok: true, events_15m: 42 }]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(GOOD));
  await setSplunkToken(ADMINISH);
  const w = await splunkTestConnection();
  assert.equal(w.read_only, false);
  assert.match(w.warning!, /delete_by_keyword/);
  await setSplunkToken(GOOD);
});

test("job search: absolute window sent as epoch, structured sanitized events, dedup within the run (resume), audit row", async () => {
  await setSplunkToken(GOOD);
  const runId = await bareRun();
  const before = log.filter(
    (l) => l.path === "/services/search/jobs" && l.method === "POST",
  ).length;
  const r: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}" | sort 0 _time`, ...W },
    { runId, stepKey: "search_logs" },
  );
  assert.equal(r.status, "done");
  assert.equal(r.result_count, F.SEARCH_BY_ORDER.length);
  const job = [...jobs.values()].at(-1)!;
  assert.equal(job.earliest, String(Date.parse(W.earliest) / 1000));
  assert.equal(job.latest, String(Date.parse(W.latest) / 1000));
  assert.equal(r.window.earliest, "2026-11-10T08:35:00+07:00");
  assert.match(r.splunk_url, /\/en-US\/app\/search\/search\?q=search\+index%3Dk8s_prod/);
  const reqEvt = r.events.find(
    (e: any) => e.ids.request_id?.[0] === "req-7f3a91" && /request/.test(e.excerpt),
  );
  assert.equal(reqEvt.timestamp, F.EXPECTED.request_sent);
  assert.equal(reqEvt.service, "hasakinow-connector");
  assert.equal(reqEvt.index, "k8s_prod");
  assert.doesNotMatch(JSON.stringify(r), /0912345678|Nguyen Van A|sk_live_|abcdef1234567890/);
  const full: any = await getEvent(reqEvt.event_ref, { runId });
  assert.match(full.raw, /"receiver_phone":"\*\*\*"/);
  assert.equal(full.provenance.search_id, r.search_id);
  // same query + window again in the same run → stored result, no new Splunk job, no budget used
  const again: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}" | sort 0 _time`, ...W },
    { runId },
  );
  assert.equal(again.cached, true);
  assert.equal(again.search_id, r.search_id);
  assert.equal(
    log.filter((l) => l.path === "/services/search/jobs" && l.method === "POST").length,
    before + 1,
  );
  const audit = await one(pool, "SELECT * FROM splunk_searches WHERE id = $1", [r.search_id]);
  assert.equal(audit.step_key, "search_logs");
  assert.equal(audit.auth, "token");
  assert.equal(audit.status, "done");
  assert.ok(audit.duration_ms >= 0);
  assert.doesNotMatch(JSON.stringify(audit.events), /0912345678|sk_live_/);
});

test("pagination through the job, empty results, export (v2 then v1 fallback), timeout cancels the job", async () => {
  await setSplunkToken(GOOD);
  const runId = await bareRun();
  const r: any = await investigationSearch(
    { query: `index=k8s_prod MANYROWS`, ...W, max_results: 3 },
    { runId },
  );
  assert.equal(r.result_count, 3);
  assert.equal(r.truncated, true);
  const page: any = await searchResults(r.search_id, 3, 3, { runId });
  assert.equal(page.returned, 3);
  assert.equal(page.events[0].excerpt, "row 3");
  const tail: any = await searchResults(r.search_id, 6, 3, { runId });
  assert.equal(tail.returned, 1);
  assert.equal(((await searchStatus(r.search_id, { runId })) as any).job.state, "DONE");

  const empty: any = await investigationSearch(
    { query: `index=k8s_prod NOTHING`, ...W },
    { runId },
  );
  assert.equal(empty.result_count, 0);
  assert.match(empty.note, /no events matched/);

  const ex: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}"`, ...W, mode: "export" },
    { runId },
  );
  assert.equal(ex.result_count, F.SEARCH_BY_ORDER.length, "preview rows skipped");
  assert.match(
    log
      .filter((l) => l.path.endsWith("/export"))
      .at(-1)!
      .form!.get("search")!,
    /\| head 201$/,
    "export is bounded with head",
  );
  const old: any = await investigationSearch(
    { query: `index=k8s_prod OLDSPLUNK`, ...W, mode: "export" },
    { runId },
  );
  assert.equal(old.result_count, F.SEARCH_BY_ORDER.length);
  assert.ok(
    log.some((l) => l.path === "/services/search/jobs/export"),
    "fell back to the v1 export endpoint",
  );

  const saved = config.splunk.timeoutSeconds;
  config.splunk.timeoutSeconds = 1;
  try {
    await assert.rejects(
      investigationSearch({ query: `index=k8s_prod SLOWJOB`, ...W }, { runId }),
      /quá 1s, đã huỷ/,
    );
  } finally {
    config.splunk.timeoutSeconds = saved;
  }
  assert.ok(log.some((l) => /\/control$/.test(l.path) && l.form?.get("action") === "cancel"));
  const failed = await one(
    pool,
    "SELECT status, error FROM splunk_searches WHERE run_id = $1 AND query LIKE '%SLOWJOB%'",
    [runId],
  );
  assert.equal(failed.status, "failed");
});

test("query budget per run", async () => {
  await setSplunkToken(GOOD);
  const runId = await bareRun();
  const saved = config.splunk.queryBudget;
  config.splunk.queryBudget = 2;
  try {
    await investigationSearch({ query: `index=k8s_prod NOTHING a1`, ...W }, { runId });
    await investigationSearch({ query: `index=k8s_prod NOTHING a2`, ...W }, { runId });
    await assert.rejects(
      investigationSearch({ query: `index=k8s_prod NOTHING a3`, ...W }, { runId }),
      /query budget exhausted/,
    );
    assert.equal(
      ((await investigationSearch({ query: `index=k8s_prod NOTHING a1`, ...W }, { runId })) as any)
        .cached,
      true,
      "a stored result is still served",
    );
  } finally {
    config.splunk.queryBudget = saved;
  }
});

test("manual mode: not connected → pending search with SPL and link; pasted export is sanitized and served to the agent", async () => {
  await clearSplunkCookie();
  const runId = await bareRun();
  const r: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}"`, ...W },
    { runId, stepKey: "search_logs" },
  );
  assert.equal(r.manual_required, true);
  assert.equal(r.status, "manual_pending");
  assert.match(r.instructions, /Never invent results/);
  // asking again does not create a second pending search
  assert.equal(
    ((await investigationSearch({ query: `index=k8s_prod "${F.ORDER}"`, ...W }, { runId })) as any)
      .search_id,
    r.search_id,
  );
  const paste = F.SEARCH_BY_ORDER.map((x) => JSON.stringify({ preview: false, result: x })).join(
    "\n",
  );
  const done: any = await submitManualResults(runId, { search_id: r.search_id, text: paste });
  assert.equal(done.result_count, F.SEARCH_BY_ORDER.length);
  const res: any = await searchResults(r.search_id, 0, 50, { runId });
  assert.equal(res.total_stored, F.SEARCH_BY_ORDER.length);
  assert.doesNotMatch(
    JSON.stringify(
      await one(pool, "SELECT events FROM splunk_searches WHERE id = $1", [r.search_id]),
    ),
    /0912345678|sk_live_/,
  );
  const cached: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}"`, ...W },
    { runId },
  );
  assert.equal(cached.cached, true);
  await assert.rejects(
    submitManualResults(runId, { search_id: r.search_id, text: "not results" }),
    /neither JSON|CSV/,
  );
  // the tool stays available without a connection (manual mode) inside a run
  const t = await callTool(
    "splunk_search",
    { query: `index=k8s_prod "${F.SHIPMENT}"`, ...W },
    { runId, allowedRepositories: [], mode: "analysis" },
  );
  assert.equal(t.ok, true);
  assert.equal((t.result as any).manual_required, true);
  await setSplunkToken(GOOD);
});

test("access isolation: another run or another user cannot read a search or event", async () => {
  await setSplunkToken(GOOD);
  const owner = await ensureTestOwner();
  const runA = await bareRun();
  const r: any = await investigationSearch(
    { query: `index=k8s_prod "${F.ORDER}" iso`, ...W },
    { runId: runA },
  );
  const other = await one(
    pool,
    "INSERT INTO users (username, password_hash, role) VALUES ('investigator-b', $1, 'member') RETURNING id",
    [await hashPassword("pw-investigator-b")],
  );
  const runB = await bareRun(Number(other.id));
  await assert.rejects(searchResults(r.search_id, 0, 10, { runId: runB }), /not found/);
  await assert.rejects(getEvent(`S${r.search_id}:0`, { runId: runB }), /not found/);
  const viaTool = await callTool(
    "splunk_get_event",
    { event_ref: `S${r.search_id}:0` },
    { runId: runB, allowedRepositories: [], mode: "analysis" },
  );
  assert.equal(viaTool.ok, false);
  // outside a run: only the actor's own searches
  await execution.run({ userId: Number(other.id), kind: "user" }, async () => {
    await assert.rejects(searchStatus(r.search_id), /not found/);
  });
  await execution.run({ userId: owner, kind: "user" }, async () => {
    assert.equal(((await searchStatus(r.search_id)) as any).search_id, r.search_id);
  });
  // personal credentials are per user: user B has no Splunk login of their own
  await execution.run({ userId: Number(other.id), kind: "user" }, async () => {
    assert.equal((await splunkStatus()).connected, false);
  });
});

test("shared service token: admin-managed, used by members only when allowed; personal credential wins", async () => {
  const other = await one(
    pool,
    "INSERT INTO users (username, password_hash, role) VALUES ('investigator-c', $1, 'member') RETURNING id",
    [await hashPassword("pw-investigator-c")],
  );
  await setSharedSplunkToken(GOOD);
  await execution.run({ userId: Number(other.id), kind: "user" }, async () => {
    config.splunk.allowSharedToken = false;
    assert.equal((await splunkStatus()).connected, false);
    config.splunk.allowSharedToken = true;
    const st = await splunkStatus();
    assert.equal(st.connected, true);
    assert.equal(st.source, "shared");
    assert.equal(st.auth, "shared_token");
  });
  config.splunk.allowSharedToken = false;
  await clearSharedSplunkToken();
  const row = await one(
    pool,
    "SELECT count(*)::int AS n FROM shared_secrets WHERE kind = 'splunk_token'",
  );
  assert.equal(row.n, 0);
});

// ---------------------------------------------------------------- end to end through the DAG engine

test("end to end: Vietnamese request → DAG with scripted agents → refine round → timeline, latency, Vietnamese report; interrupted step resumes from stored searches", async () => {
  await seedTemplates();
  setAiRepositoryRanker(null);
  await repositories.upsert("oms-background", {
    projects: ["OMS"],
    services: ["shipment", "outbox", "hasakinow"],
    description: "kafka consumers, hasakinow connector",
  });
  const owner = await ensureTestOwner();
  await execution.run({ userId: owner, kind: "user" }, () => setSplunkToken(GOOD));
  const calls: Record<string, number> = {};
  const tool = async (ctx: ExecutionContext, name: string, args: unknown) => {
    const r = await callTool(name, args, {
      runId: ctx.run.id,
      allowedRepositories: ctx.run.allowed_repositories,
      mode: "analysis",
      stepKey: ctx.step.key,
    });
    if (!r.ok) throw new Error(r.error);
    return r.result as any;
  };
  const labelAll = (res: any, pick: (e: any) => string | null) =>
    res.events
      .map((e: any) => ({ evidence_ref: e.event_ref, event_type: pick(e) }))
      .filter((x: any) => x.event_type);
  const classify = (e: any) =>
    /outbound shipment created/.test(e.excerpt)
      ? "OUTBOUND_MESSAGE_CREATED"
      : /kafka publish/.test(e.excerpt)
        ? "MESSAGE_PUBLISHED"
        : /hasakinow request/.test(e.excerpt)
          ? "PARTNER_REQUEST_SENT"
          : /hasakinow response/.test(e.excerpt)
            ? "PARTNER_RESPONSE_RECEIVED"
            : /consumed shipment/.test(e.excerpt)
              ? "MESSAGE_CONSUMED"
              : /callback received/.test(e.excerpt)
                ? "PARTNER_CALLBACK_RECEIVED"
                : /tracking number persisted/.test(e.excerpt)
                  ? "TRACKING_NUMBER_PERSISTED"
                  : /generating shipping label/.test(e.excerpt)
                    ? "SHIPPING_LABEL_REQUESTED"
                    : /label url generated/.test(e.excerpt)
                      ? "SHIPPING_LABEL_URL_GENERATED"
                      : /label persisted/.test(e.excerpt)
                        ? "SHIPPING_LABEL_URL_PERSISTED"
                        : null;
  const agent = {
    async execute(ctx: ExecutionContext): Promise<ExecResult> {
      const n = (calls[ctx.step.key] = (calls[ctx.step.key] ?? 0) + 1);
      const parsed = ctx.input.upstream.parse_request.output;
      switch (ctx.step.key) {
        case "analyze_code":
          return {
            kind: "completed",
            output: {
              services: [
                { name: "hasakinow-connector", repo: "oms-background", role: "partner client" },
              ],
              log_patterns: [],
              identifier_fields: ["shipment_id"],
              flow: [],
              code_locations: [
                {
                  repo: "oms-background",
                  file: "app/hasakinow/client.go",
                  line: 88,
                  description: "POST /v1/orders",
                },
              ],
              notes: [],
            },
          };
        case "search_logs": {
          const q0 = parsed.initial_queries[0];
          const r = await tool(ctx, "splunk_search", {
            query: q0.query,
            earliest: q0.earliest,
            latest: q0.latest,
          });
          // interrupted once after searching: the retry must reuse the stored result
          if (n === 1) return { kind: "failed", error: "worker lost (simulated)", retryable: true };
          assert.equal(r.cached, true, "retry served from the stored search");
          // first pass labels only the order-code events: the callback and label generation are still missing
          return {
            kind: "completed",
            output: {
              searches: [r.search_id],
              events: labelAll(r, (e) =>
                /label url generated/.test(e.excerpt) ? null : classify(e),
              ),
              discovered_identifiers: {},
              observations: [],
              missing: [],
            },
          };
        }
        case "refine_search": {
          const corr = ctx.input.upstream.correlate.output;
          assert.equal(corr.complete, false);
          assert.ok(corr.missing.some((m: any) => m.objective === "shipping_label_time"));
          const shipment = corr.identifiers.shipment_id[0];
          const r = await tool(ctx, "splunk_search", {
            query: `index=k8s_prod "${shipment}"`,
            earliest: parsed.time.earliest,
            latest: parsed.time.latest,
          });
          return {
            kind: "completed",
            output: {
              searches: [r.search_id],
              events: [
                ...labelAll(r, classify),
                { evidence_ref: "S424242:0", event_type: "PARTNER_CALLBACK_RECEIVED" },
              ],
              discovered_identifiers: {},
              observations: [],
              missing: [],
            },
          };
        }
        case "analyze_findings": {
          const tl = ctx.input.upstream.timeline.output.timeline;
          const cb = tl.find((t: any) => t.event_type === "PARTNER_CALLBACK_RECEIVED");
          return {
            kind: "completed",
            output: {
              answers: [],
              findings: [
                {
                  statement: "HasakiNOW gửi callback kèm mã tracking sau ~77 giây",
                  classification: "confirmed",
                  evidence_refs: [cb.evidence_ref],
                },
                {
                  statement: "Label sinh lúc 08:49:00",
                  classification: "confirmed",
                  evidence_refs: ["S777:1"],
                },
              ],
              hypotheses: [
                {
                  hypothesis: "Thời gian chờ chủ yếu do điều phối tài xế phía HasakiNOW",
                  supporting_refs: [cb.evidence_ref],
                },
              ],
              missing_evidence: ["log phía HasakiNOW về thời điểm tài xế nhận đơn"],
              next_steps: ["đối chiếu với log HasakiNOW cho partner_ref NOWREF-1188"],
            },
          };
        }
      }
      return { kind: "completed", output: {} };
    },
  };
  registerExecutor("agent", agent);
  registerExecutor("integration", integrationExecutor);
  const run = await startRun({
    definitionKey: "production-incident-investigation",
    inputs: { request: F.REQUEST_VI },
    title: "Điều tra đơn 2611095VL160RW01",
    outputLocale: "vi",
    ownerId: owner,
  });
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      // skip retry backoff in the test
      await q(
        pool,
        "UPDATE workflow_jobs SET available_at = now() WHERE run_id = $1 AND status = 'queued'",
        [run.id],
      );
      await drain();
    }
  };
  await settle();
  const r = await getRun(run.id);
  const st = Object.fromEntries(r.steps.map((s) => [s.key, s.status]));
  assert.equal(
    r.status,
    "COMPLETED",
    JSON.stringify(st) +
      " " +
      r.steps
        .map((s) => s.error)
        .filter(Boolean)
        .join("; "),
  );
  assert.equal(st.refine_search, "COMPLETED", "incomplete evidence triggered one refinement round");
  assert.equal(calls.search_logs, 2);
  const steps = Object.fromEntries(r.steps.map((s) => [s.key, s]));
  const tl = steps.timeline.output;
  assert.equal(tl.complete, true);
  assert.deepEqual(
    tl.rejected.map((x: any) => x.evidence_ref),
    ["S424242:0"],
    "fabricated reference rejected",
  );
  const lat = steps.latency.output.latencies;
  assert.equal(
    lat.find((l: any) => l.key === "partner_sync_response").latency_ms,
    F.EXPECTED.sync_latency_ms,
  );
  assert.equal(
    lat.find((l: any) => l.key === "partner_callback").latency_ms,
    F.EXPECTED.callback_latency_ms,
  );
  const rep = steps.report.output;
  assert.equal(rep.status, "complete");
  assert.equal(rep.summary.outbound_at, F.EXPECTED.request_sent);
  assert.equal(rep.summary.shipping_label.at, F.EXPECTED.label_generated);
  assert.deepEqual(
    rep.findings.map((f: any) => f.classification),
    ["inferred", "unknown"],
    "claims capped by evidence",
  );
  assert.match(rep.report_markdown, /## Tóm tắt/);
  assert.match(rep.report_markdown, /app\/hasakinow\/client\.go/);
  assert.doesNotMatch(rep.report_markdown, /0912345678|Nguyen Van A|sk_live_|abcdef1234567890/);
  const art = await one(
    pool,
    "SELECT kind, name FROM workflow_artifacts WHERE run_id = $1 AND kind = 'report'",
    [run.id],
  );
  assert.equal(art.name, "Bao-cao-dieu-tra.md");
  const searches = await q(
    pool,
    "SELECT step_key, status FROM splunk_searches WHERE run_id = $1 ORDER BY id",
    [run.id],
  );
  assert.deepEqual(
    searches.map((s: any) => s.step_key),
    ["search_logs", "refine_search"],
    "the interrupted step did not search twice",
  );
  const detail = await investigationDetail(run.id);
  assert.equal(detail.searches.length, 2);
  assert.equal(detail.report.status, "complete");
  assert.ok(detail.searches[0].events.every((e: any) => !/0912345678/.test(e.raw)));

  // re-executing the search step keeps the stored searches (no new Splunk job for the same query)
  const jobsBefore = sidSeq;
  await reexecuteStep(run.id, "search_logs", {});
  calls.search_logs = 1; // the scripted agent asserts a cached result on its next call
  await settle();
  assert.equal((await getRun(run.id)).status, "COMPLETED");
  assert.equal(sidSeq, jobsBefore + 0, "re-execution reused the stored order search");
  // read-only: nothing in this run can push, edit or open a PR
  assert.equal(
    (await q(pool, "SELECT 1 FROM pull_requests WHERE run_id = $1", [run.id])).length,
    0,
  );
  assert.equal(
    (
      await q(
        pool,
        "SELECT 1 FROM workflow_steps WHERE run_id = $1 AND type IN ('coding_agent','command','git_pull_request')",
        [run.id],
      )
    ).length,
    0,
  );
});

test("continue to fix: hands the findings to Bug Investigation (same owner, locale, linked evidence), idempotent, blocked without a report", async () => {
  const owner = await ensureTestOwner();
  const inv = await one(
    pool,
    "SELECT id FROM workflow_runs WHERE definition_key = 'production-incident-investigation' AND status = 'COMPLETED' ORDER BY id DESC LIMIT 1",
  );
  assert.ok(inv, "the end-to-end investigation run exists");
  const r = await startFixFromInvestigation(Number(inv.id));
  assert.equal(r.existing, false);
  const fix = await one(pool, "SELECT * FROM workflow_runs WHERE id = $1", [r.run_id]);
  assert.equal(fix.definition_key, "bug-investigation");
  assert.equal(fix.output_locale, "vi");
  assert.equal(Number(fix.owner_id), owner);
  assert.equal(fix.inputs.investigation_run_id, Number(inv.id));
  assert.equal(fix.inputs.investigation.status, "complete");
  assert.ok(
    fix.inputs.investigation.timeline.some((t: any) => t.event_type === "PARTNER_REQUEST_SENT"),
  );
  assert.doesNotMatch(
    JSON.stringify(fix.inputs),
    /0912345678|Nguyen Van A|sk_live_|abcdef1234567890/,
    "only sanitized evidence is handed over",
  );
  assert.deepEqual(
    await startFixFromInvestigation(Number(inv.id)),
    { run_id: r.run_id, existing: true },
    "no duplicate while the fix run is active",
  );
  // the fix run's agents can re-read the investigation's evidence; an unrelated run cannot
  const ref = fix.inputs.investigation.timeline[0].evidence_ref;
  assert.equal(((await getEvent(ref, { runId: r.run_id })) as any).event_ref, ref);
  const other = await bareRun();
  await assert.rejects(getEvent(ref, { runId: other }), /not found/);
  // an investigation without a report cannot be handed over
  await assert.rejects(startFixFromInvestigation(other), /no report yet/);
  // the investigation run itself is unchanged and still read-only
  assert.equal(
    (
      await q(
        pool,
        "SELECT 1 FROM workflow_steps WHERE run_id = $1 AND type IN ('coding_agent','command','git_pull_request')",
        [inv.id],
      )
    ).length,
    0,
  );
});

test("QC (no Splunk): Argo CD log lines are stored as run evidence with refs, readable like Splunk events, without a Splunk link", async () => {
  const runId = await bareRun();
  const now = Date.now();
  const input = {
    source: "argocd" as const,
    query: `argocd app=oms-api-qc target=Deployment/oms-api filter="${F.ORDER}" since=60m`,
    earliest: now - 3_600_000,
    latest: now,
    rows: [
      {
        _time: "2026-11-10T08:40:00.000+07:00",
        _raw: JSON.stringify({
          message: "create shipment",
          order_code: F.ORDER,
          shipment_id: F.SHIPMENT,
        }),
        "kubernetes.container_name": "oms-api",
        index: "argocd-qc",
        sourcetype: "argocd:pod_log",
      },
      {
        _time: "2026-11-10T08:40:02.000+07:00",
        _raw: `ERROR partner timeout order=${F.ORDER}`,
        "kubernetes.container_name": "oms-api",
        index: "argocd-qc",
        sourcetype: "argocd:pod_log",
      },
    ],
  };
  const r: any = await storeExternalSearch(input, { runId, stepKey: "search_logs" });
  assert.equal(r.environment, "qc");
  assert.equal(r.mode, "argocd");
  assert.equal(r.splunk_url, undefined, "QC has no Splunk link");
  assert.equal(r.events.length, 2);
  const ref = r.events[0].event_ref ?? r.events[0].ref;
  assert.match(ref, new RegExp(`^S${r.search_id}:0$`));
  const ev: any = await getEvent(ref, { runId });
  assert.match(JSON.stringify(ev), new RegExp(F.ORDER));
  // the same query moments later reuses the stored lines (no second search against the budget)
  const again: any = await storeExternalSearch(input, { runId, stepKey: "search_logs" });
  assert.equal(again.search_id, r.search_id);
  assert.equal(again.cached, true);
  // the investigation panel lists it with the run's environment and no Splunk link
  const inv: any = await investigationDetail(runId);
  const s = inv.searches.find((x: any) => x.id === r.search_id);
  assert.equal(s.splunk_url, null);
  assert.equal(s.mode, "argocd");
});
