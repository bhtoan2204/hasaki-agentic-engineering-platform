/**
 * Built-in workflow templates. Seeded on startup as normal versioned definitions (is_template = true):
 * editing one publishes a new version; running runs stay pinned to the version they started with.
 */

// Tests only the Go packages touched on the branch (oms-api has a known red baseline elsewhere), npm otherwise.
export const TEST_COMMAND = `set -e
if [ -f go.mod ]; then
  pkgs=$(git diff --name-only "origin/$BASE_BRANCH...HEAD" -- '*.go' | xargs -r -n1 dirname | sort -u | sed 's|^|./|')
  echo "== go build ./..."
  go build ./...
  # -short lets integration tests that honour testing.Short() skip; the timeout bounds tests that hang on remote DB/ES.
  # GO_TEST_SKIP (set by the platform): tests already known to fail on the same base commit — not re-run.
  if [ -n "$pkgs" ]; then echo "== go test -short -timeout 5m \${GO_TEST_SKIP:+-skip $GO_TEST_SKIP} $pkgs"; go test -short -timeout 5m \${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} $pkgs; else echo "no Go packages changed"; fi
elif [ -f package.json ]; then
  if [ ! -d node_modules ] || [ -z "$(find node_modules -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit 2>/dev/null)" ]; then
    echo "== install dependencies"
    if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || { echo "npm ci refused (package-lock.json out of sync with package.json?): installing from package.json, lock file untouched"; npm install --no-package-lock --ignore-scripts --no-audit --no-fund; }; else npm install --ignore-scripts --no-audit --no-fund; fi
  fi
  npm test --if-present
else
  echo "no test runner detected"
fi`;

/**
 * Test policy for every coding step: unit tests validate business flow only. A test that reaches a real DB, Elasticsearch,
 * Redis, Kafka, queue or HTTP service that is not local to the test process hangs or fails on whoever runs it, so the
 * agent rewrites it against a mock/fake/in-memory double, or deletes it when it only exercised the infrastructure.
 */
export const TEST_POLICY =
  "Test policy: unit tests validate business flow only. A test (new, changed, or one in a package you run) that connects to a real database, " +
  "Elasticsearch, Redis, Kafka, a queue or any HTTP/gRPC service that is not started locally by the test itself must be fixed or removed: " +
  "rewrite it to use mocks, fakes or in-memory doubles behind the existing interfaces so it asserts the business logic, or delete it when " +
  "it only exercised the infrastructure and has no business assertion left. Never add a new test that needs remote infrastructure. " +
  "List every rewritten or deleted test with the reason under verification.";

/**
 * Verification for this platform (TypeScript). The parent process strips DATABASE_URL and other secrets before the
 * shell starts; these guards refuse to continue if that isolation is missing. Targeted tests map changed modules to
 * unit test files (no PostgreSQL) and integration test files (one shared cluster, only when one matches). The full `npm run test:all` script, integration tests included, runs once, later,
 * on the same commit.
 */
const SELF_TEST_GUARD = `set -euo pipefail
if [ -n "\${DATABASE_URL:-}" ]; then echo "refusing verification: DATABASE_URL is set" >&2; exit 2; fi
admin="\${TEST_DATABASE_ADMIN_URL:-}"
case "$admin" in
  */platform|*/platform\\?*) echo "refusing verification: admin URL names the application database" >&2; exit 2 ;;
esac
if [ ! -f package.json ]; then echo "package.json is required" >&2; exit 1; fi
if [ ! -x node_modules/.bin/tsc ]; then npm ci --ignore-scripts --no-audit --no-fund; fi`;

/**
 * Lints the changed files (paths on stdin) and fails only on errors the branch adds. Errors are matched to the merge
 * base by rule + message count per file (line numbers shift), so debt already in a touched file does not block a
 * repair loop that cannot and should not clean it up. Falls back to plain eslint when the Node API is unavailable.
 * Runs inside shell single quotes: no single quotes, backticks or template placeholders in this source.
 */
export const ESLINT_NEW_ERRORS_JS = String.raw`const fs = require("fs");
const cp = require("child_process");
const files = fs.readFileSync(0, "utf8").split(/\r?\n/).filter((f) => f && fs.existsSync(f));
let ESLint;
try { ({ ESLint } = require("eslint")); } catch {}
if (!ESLint) {
  const r = cp.spawnSync("npx", ["--no-install", "eslint", "--no-error-on-unmatched-pattern", ...files], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
(async () => {
  const eslint = new ESLint();
  const key = (m) => (m.ruleId || "parse") + " " + m.message;
  const errors = (results) => results.flatMap((r) => r.messages).filter((m) => m.severity === 2);
  const tally = (msgs) => msgs.reduce((c, m) => c.set(key(m), (c.get(key(m)) || 0) + 1), new Map());
  const report = [];
  let added = 0, known = 0;
  for (const f of files) {
    if (await eslint.isPathIgnored(f)) continue;
    const head = await eslint.lintFiles([f]);
    const now = errors(head);
    if (!now.length) continue;
    const old = cp.spawnSync("git", ["show", process.env.LINT_BASE + ":" + f], { encoding: "utf8", maxBuffer: 1 << 28 });
    const before = old.status === 0 ? tally(errors(await eslint.lintText(old.stdout, { filePath: f }))) : new Map();
    const after = tally(now);
    let fileAdded = 0;
    for (const [k, n] of after) fileAdded += Math.max(0, n - (before.get(k) || 0));
    added += fileAdded;
    known += now.length - fileAdded;
    const grown = now.filter((m) => after.get(key(m)) > (before.get(key(m)) || 0));
    if (grown.length) report.push({ ...head[0], messages: grown, errorCount: grown.length, warningCount: 0, fatalErrorCount: 0, fixableErrorCount: 0, fixableWarningCount: 0 });
  }
  if (report.length) {
    console.log(await (await eslint.loadFormatter("stylish")).format(report));
    console.log(added + " new eslint error(s) introduced by this branch (listed lines share a rule and message whose count grew vs the merge base)");
  }
  if (known) console.log("eslint: " + known + " error(s) already present on the merge base in changed files were ignored");
  process.exit(added ? 1 : 0);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(2); });`;

const eslintNewErrors = (base: string) => `echo "== eslint (changed files, new errors only)"
  printf '%s\\n' "$files" | LINT_BASE="$(git merge-base "${base}" HEAD 2>/dev/null || echo "${base}")" node -e '${ESLINT_NEW_ERRORS_JS}'`;

export const PLATFORM_TARGETED_COMMAND = `${SELF_TEST_GUARD}
base="origin/$BASE_BRANCH"
changed=$(git diff --name-only "$base...HEAD" || true)
echo "== typecheck"
npx --no-install tsc -p . --pretty false --noEmit --incremental false
files=$(printf '%s\\n' "$changed" | grep -E '\\.(ts|tsx)$' || true)
if [ -n "$files" ] && [ -x node_modules/.bin/eslint ]; then
  ${eslintNewErrors("$base")}
elif [ -n "$files" ]; then
  echo "eslint not installed; lint skipped"
fi
tests=$(
  {
    printf '%s\\n' "$changed" | grep -E '^test/.*\\.test\\.ts$' || true
    printf '%s\\n' "$changed" | sed -n 's|^src/\\(.*\\)\\.ts$|test/\\1.test.ts|p'
    printf '%s\\n' "$changed" | sed -n 's|.*/\\([^/]*\\)\\.ts$|test/\\1.test.ts|p'
  } | sort -u | while IFS= read -r f; do if [ -n "$f" ] && [ -f "$f" ]; then printf '%s\\n' "$f"; fi; done
)
integration=$(
  {
    printf '%s\\n' "$changed" | grep -E '^test/.*\\.integration\\.ts$' || true
    printf '%s\\n' "$changed" | sed -n 's|^src/\\(.*\\)\\.ts$|test/\\1.integration.ts|p'
    printf '%s\\n' "$changed" | sed -n 's|.*/\\([^/]*\\)\\.ts$|test/\\1.integration.ts|p'
  } | sort -u | while IFS= read -r f; do if [ -n "$f" ] && [ -f "$f" ]; then printf '%s\\n' "$f"; fi; done
)
if [ -n "$tests" ]; then
  echo "== targeted tests"
  preload=./test/env.ts; [ -f test/env.ts ] || preload=./test/setup.ts
  # shellcheck disable=SC2086
  node --disable-warning=ExperimentalWarning --import "$preload" --test $tests
fi
if [ -n "$integration" ]; then
  echo "== targeted integration tests"
  # shellcheck disable=SC2086
  node --disable-warning=ExperimentalWarning test/run-integration.ts $integration
fi
if [ -z "$tests" ] && [ -z "$integration" ]; then
  echo "no matching test files for the diff; targeted suite skipped"
fi`;

export const PLATFORM_REGRESSION_COMMAND = `${SELF_TEST_GUARD}
if node -e 'process.exit(require("./package.json").scripts?.["test:all"] ? 0 : 1)'; then
  echo "== full regression (npm run test:all)"
  npm run test:all
else
  echo "== full regression (npm test)"
  npm test
fi`;

/** Refuses the application database only when the command runner already marked this checkout as the live platform. */
const FEATURE_SELF_GUARD = `if [ "\${PLATFORM_SELF_TEST:-}" = "1" ]; then
  if [ -n "\${DATABASE_URL:-}" ]; then echo "refusing verification: DATABASE_URL is set" >&2; exit 2; fi
  admin="\${TEST_DATABASE_ADMIN_URL:-}"
  case "$admin" in
    */platform|*/platform\\?*) echo "refusing verification: admin URL names the application database" >&2; exit 2 ;;
  esac
fi`;

/** Typecheck, lint and tests for the modules touched on the branch. Full-suite regression is a later step. */
export const FEATURE_TARGETED_COMMAND = `set -euo pipefail
${FEATURE_SELF_GUARD}
if [ -f go.mod ]; then
  pkgs=$(git diff --name-only "origin/$BASE_BRANCH...HEAD" -- '*.go' | xargs -r -n1 dirname | sort -u | sed 's|^|./|')
  echo "== go build ./..."
  go build ./...
  if [ -n "$pkgs" ]; then echo "== go test -short -timeout 5m \${GO_TEST_SKIP:+-skip $GO_TEST_SKIP} $pkgs"; go test -short -timeout 5m \${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} $pkgs; else echo "no Go packages changed"; fi
elif [ -f package.json ]; then
  if [ ! -d node_modules ] || [ -z "$(find node_modules -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit 2>/dev/null)" ]; then
    echo "== install dependencies"
    if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || { echo "npm ci refused (package-lock.json out of sync with package.json?): installing from package.json, lock file untouched"; npm install --no-package-lock --ignore-scripts --no-audit --no-fund; }; else npm install --ignore-scripts --no-audit --no-fund; fi
  fi
  echo "== typecheck"
  if [ -x node_modules/.bin/tsc ]; then npx --no-install tsc -p . --pretty false --noEmit --incremental false; else echo "tsc not installed; typecheck skipped"; fi
  changed=$(git diff --name-only "origin/$BASE_BRANCH...HEAD" || true)
  files=$(printf '%s\\n' "$changed" | grep -E '\\.(ts|tsx|js|jsx)$' || true)
  if [ -n "$files" ] && [ -x node_modules/.bin/eslint ]; then
    ${eslintNewErrors("origin/$BASE_BRANCH")}
  else
    echo "eslint skipped"
  fi
  if [ -f test/setup.ts ]; then
    tests=$(
      {
        printf '%s\\n' "$changed" | grep -E '^test/.*\\.test\\.ts$' || true
        printf '%s\\n' "$changed" | sed -n 's|^src/\\(.*\\)\\.ts$|test/\\1.test.ts|p'
      } | sort -u | while IFS= read -r f; do if [ -n "$f" ] && [ -f "$f" ]; then printf '%s\\n' "$f"; fi; done
    )
    if [ -n "$tests" ]; then
      echo "== targeted tests"
      preload=./test/env.ts; [ -f test/env.ts ] || preload=./test/setup.ts
      node --disable-warning=ExperimentalWarning --import "$preload" --test $tests
    else
      echo "no matching test files; targeted suite skipped"
    fi
  else
    echo "no platform test harness; the regression step runs npm test"
  fi
else
  echo "no test runner detected"
fi`;

/** Broader gate after review. Bounded with -short / the step timeout. Not a second scheduler. */
export const FEATURE_REGRESSION_COMMAND = `set -euo pipefail
${FEATURE_SELF_GUARD}
if [ -f go.mod ]; then
  echo "== go build ./..."
  go build ./...
  echo "== go test -short -timeout 8m ./..."
  go test -short -timeout 8m ./...
elif [ -f package.json ]; then
  if [ ! -d node_modules ] || [ -z "$(find node_modules -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit 2>/dev/null)" ]; then
    echo "== install dependencies"
    if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund || { echo "npm ci refused (package-lock.json out of sync with package.json?): installing from package.json, lock file untouched"; npm install --no-package-lock --ignore-scripts --no-audit --no-fund; }; else npm install --ignore-scripts --no-audit --no-fund; fi
  fi
  echo "== regression (npm test)"
  npm test --if-present
else
  echo "no regression runner detected"
fi`;

const ANALYZE = {
  instructions:
    "Analyse the engineering request. Restate the goal, list functional requirements, acceptance criteria, " +
    "affected business areas, unknowns and risks. Read code only to understand terminology; do not design the change yet. " +
    "If business behaviour is ambiguous and cannot be settled from the code, ask the developer.",
  output_contract:
    "{ goal, requirements: string[], acceptance_criteria: string[], keywords: string[], unknowns: string[], risks: string[] }",
};

const DISCOVER = { action: "repository_discovery", use_ai: true, max_candidates: 5 };
const CONFIRM_REPOS = {
  message: "Xác nhận repo sẽ được sửa cho lần chạy này.",
  select_repositories: true,
  show_outputs: ["discover"],
};

const IMPLEMENT = {
  // The repair loop runs the tests that match the diff. The full suite stays on the later regression step.
  verify: { command: FEATURE_TARGETED_COMMAND, timeout_seconds: 900 },
  instructions:
    "Implement the approved plan. Call prepare_branch for each repository before editing and edit ONLY inside the returned " +
    "worktree paths. Make the smallest correct change, run the relevant build/tests, commit with the platform commit convention. " +
    "Do not push: a later workflow step opens the pull request. Finish by calling submit_result with " +
    "{ summary, pull_requests: { <repo>: { title, summary, decisions: [{title, detail}] } }, verification }. " +
    TEST_POLICY,
  output_contract:
    "{ summary, pull_requests: { [repo]: { title, summary, decisions } }, verification }",
};

const SELF_IMPLEMENT = {
  ...IMPLEMENT,
  verify: { command: PLATFORM_TARGETED_COMMAND, timeout_seconds: 900 },
  instructions:
    IMPLEMENT.instructions +
    " This run targets the platform that is executing it. Call prepare_branch and edit only the returned worktree. " +
    "Do not write the running checkout, restart the server, deploy, merge, or run schema migrations against the application database. " +
    "Do not read .env, config.json or credential files. Do not weaken tool policy, authorization or test isolation to make the task pass. " +
    "A later step runs the full test script in a separate process with an isolated database.",
};

/** Code review follow-up: fix what the review found, on the reviewed branch. */
const FIX_FROM_REVIEW = {
  instructions:
    "Fix the findings of this run's code review. Read the full outputs of the analyze, architecture and security steps with " +
    "read_step_output. The approval comment on this step (if any) says which findings to fix or skip; without one, fix the " +
    "high and medium severity findings and leave low ones as not done. Verify each finding in the code before changing it: " +
    "if it is not real, do not change code, list it under not_fixed with the reason. Call prepare_branch for each repository " +
    "you change: when the run reviewed a branch, you get that branch and commit on top of it (never rewrite its history). " +
    "Make the smallest correct change, add or update a test where it proves the fix, run the relevant build/tests, commit with " +
    "the platform commit convention. Do not push: a later step opens the pull request. Finish by calling submit_result with " +
    "{ summary, fixed: [{ finding, repo, file, change }], not_fixed: [{ finding, reason }], pull_requests: { <repo>: { title, summary, decisions: [{title, detail}] } }, verification }. " +
    TEST_POLICY,
  output_contract:
    "{ summary, fixed: [{ finding, repo, file, change }], not_fixed: [{ finding, reason }], pull_requests: { [repo]: { title, summary, decisions } }, verification }",
};

const REVIEW = {
  independent: true,
  max_repairs: 2,
  instructions:
    "Review the diff of every workspace branch against origin/$BASE_BRANCH (git diff, read-only). Check correctness, the " +
    "approved plan or fix proposal, coding standards and security policies in your context. For every finding include a precise file/line, " +
    "the relevant code or test evidence, why it violates a requirement, and a concrete repair suggestion. Report findings; do not modify code.",
  output_contract:
    "{ approved: boolean, findings: [{ severity: 'high'|'medium'|'low', file, line, issue, evidence, suggestion }], summary }",
  workspace_read: true,
  // Scope + curated per-language rules from Alibaba OpenCodeReview (delegation mode, no extra model/API key).
  open_code_review: true,
};

/**
 * Evidence-gated investigation (src/agent/evidence.ts). The platform normalizes these fields deterministically: claims
 * without usable provenance are downgraded, root-cause status is capped by verified evidence and never rises between
 * steps without new evidence, and fix risk has a detected floor. Steps opt in with config.evidence.
 */
const CLAIMS_CONTRACT =
  "claims: [{ id, claim, classification: 'OBSERVED_FACT'|'CODE_FACT'|'HYPOTHESIS'|'ASSUMPTION'|'CONFIRMED_ROOT_CAUSE', source_type, source_ref, repository, commit, file_path, line_range, confidence: 'low'|'medium'|'high', verification_status: 'verified'|'unverified'|'missing'|'contradicted', supports?: string[], contradicts?: string[] }]";
const EVIDENCE_RULES =
  "Evidence rules: classify every critical claim. OBSERVED_FACT needs an observable source (production_log, api_response, database, test_output, screenshot, user_report…) and a source_ref you actually saw; " +
  "CODE_FACT needs repository, file_path, line_range and the commit you read. Earlier agent outputs are opinions, not evidence: repeating a hypothesis never makes it a fact. " +
  "If a source (logs/Splunk, database, external API docs) was not available to you, list it under missing_evidence and do not claim it was inspected. " +
  "Never copy secrets or raw customer payloads into claims; cite a reference instead. Use low/medium/high, never numeric confidence.";
const ROOT_CAUSE_CONTRACT =
  "root_cause_assessment: { status: 'CONFIRMED'|'PROBABLE'|'UNCONFIRMED'|'INSUFFICIENT_EVIDENCE', confidence: 'low'|'medium'|'high', explanation, supporting_claims: string[] }";

const INVESTIGATION_HANDOFF =
  "If run inputs contain `investigation` (handed over from a read-only production investigation), start from it: its findings, timeline and latencies cite evidence_refs (S<search>:<n>). " +
  "Re-read the events you rely on with call_tool splunk_get_event before classifying them as OBSERVED_FACT (source_type production_log, source_ref = the evidence_ref); its hypotheses and missing_evidence are open questions, not facts. ";

const BUG_ANALYZE = {
  evidence: "analysis",
  instructions:
    "Analyse the reported problem: symptoms, expected vs actual behaviour, reproduction hints, affected flows. Read attachments (screenshots often hold the actual error). " +
    INVESTIGATION_HANDOFF +
    "Report coverage explicitly: verified observations, code paths inspected, hypotheses, missing evidence, an impact assessment (do not infer an exact blast radius from one log event), " +
    "suggestions for collecting the missing evidence, and safe next actions. " +
    EVIDENCE_RULES,
  output_contract:
    "{ symptoms, expected, actual, keywords: string[], reproduction: string[], unknowns: string[], verified_observations?: string[], code_paths_inspected?: string[], hypotheses?: string[], " +
    "missing_evidence?: string[], impact_assessment?: { summary, scope: 'known'|'estimated'|'unknown', exact: boolean }, evidence_suggestions?: string[], safe_next_actions?: string[], " +
    CLAIMS_CONTRACT.replace("claims:", "claims?:") +
    " }",
};

const BUG_ROOT_CAUSE = {
  evidence: "root_cause",
  instructions:
    "Find the root cause with evidence (file:line at a known commit, logs, data flow). List competing hypotheses and how each was confirmed or ruled out. " +
    INVESTIGATION_HANDOFF +
    "Assess the root cause separately from any fix: CONFIRMED only when a CONFIRMED_ROOT_CAUSE claim rests on verified facts; PROBABLE when verified facts point to it but alternatives remain; " +
    "UNCONFIRMED when it is a plausible hypothesis; INSUFFICIENT_EVIDENCE when the needed data was not available. Explain the assessment in one or two sentences. " +
    "Do not raise the status of an earlier step's conclusion unless you cite NEW verified evidence. " +
    EVIDENCE_RULES,
  output_contract:
    "{ root_cause, evidence: string[], hypotheses: [{ hypothesis, verdict, evidence }], missing_evidence?: string[], " +
    ROOT_CAUSE_CONTRACT +
    ", " +
    CLAIMS_CONTRACT +
    " }",
};

const BUG_FIX_PROPOSAL = {
  evidence: "fix_proposal",
  instructions:
    "Propose the smallest correct fix and a regression test. Fix confidence is separate from root-cause confidence: a LOW-risk change (diagnostic logs, richer error messages, input validation, " +
    "non-invasive tests, error classification without behaviour change) may proceed with an unconfirmed root cause when its correctness is independently supported. " +
    "MEDIUM risk (retry, timeout, fallback, idempotency, error handling with business effect) needs side_effects and rollback. " +
    "HIGH risk (order/shipment/payment/refund states or amounts, inventory, reconciliation, marking an external operation successful without confirmation, skipping transitions or checks) " +
    "needs every business_invariants field answered from the authoritative source of truth — 'unknown' is not an answer — and must not rest on a hypothesis. " +
    "Never infer that an external operation succeeded from the mere presence of an identifier. Prefer a LOW-risk change when the root cause is not confirmed. " +
    "Keep the root_cause_assessment of the root-cause step unless you have new verified evidence. List assumptions the implementation must NOT treat as fact under prohibited_assumptions. " +
    EVIDENCE_RULES,
  output_contract:
    "{ summary, changes: [{ repo, files, description }], regression_tests: string[], required_tests?: string[], risks: string[], missing_evidence?: string[], prohibited_assumptions?: string[], " +
    ROOT_CAUSE_CONTRACT +
    ", fix_assessment: { risk: 'LOW'|'MEDIUM'|'HIGH', confidence: 'low'|'medium'|'high', explanation, side_effects, rollback, business_invariants?: { current_state, target_state, source_of_truth, preconditions, external_contract, idempotency, retry_behavior, side_effects, concurrency, failure_handling, regression_tests } }, " +
    CLAIMS_CONTRACT +
    " }",
};

const BUG_IMPLEMENT = {
  ...IMPLEMENT,
  instructions:
    IMPLEMENT.instructions +
    " Implement ONLY the approved change scope in evidence_summary.approved_scope; optional or speculative ideas are not requirements, and open hypotheses or prohibited assumptions must not be coded as facts. " +
    "If you must change anything outside the approved scope, list it in scope_deviations with its risk: a deviation riskier than the approved risk pauses for renewed approval.",
  output_contract:
    "{ summary, pull_requests: { [repo]: { title, summary, decisions } }, verification, scope_deviations?: [{ description, files, risk: 'LOW'|'MEDIUM'|'HIGH', reason }] }",
};

const BUG_REVIEW = {
  ...REVIEW,
  scope_review: true,
  instructions:
    REVIEW.instructions +
    " Also judge the diff against the APPROVED scope (evidence_summary.approved_scope and the approval output), not against a rewritten proposal: is every change inside it; was any open hypothesis or prohibited assumption implemented as fact; " +
    "are business invariants preserved; are external API assumptions supported by evidence; does the change add state transitions nobody approved; do the tests exercise failure paths, not only the happy path; " +
    "does the code/commit still describe the diagnosis as uncertain when the root cause is not CONFIRMED. Passing unit tests do not make a speculative business-state change acceptable: " +
    "FAIL with findings for fixable defects, BLOCKED when evidence or human approval is missing.",
  output_contract:
    "{ verdict: 'PASS'|'FAIL'|'BLOCKED', findings: [{ severity, file, line, explanation, evidence }], summary, blocked_reason?, scope_check: { in_scope: boolean, unsupported_assumptions: string[], unintended_state_transitions: string[], invariants_preserved: boolean|null, tests_cover_failure_paths: boolean, diagnosis_uncertainty_preserved: boolean|null } }",
};

/**
 * Production Incident Investigation (read-only). Agents search Splunk and label stored events by reference; the
 * deterministic steps (src/investigation/) validate labels against the stored evidence, correlate by identifiers,
 * rebuild the timeline, measure latency between the right event pairs and write the report. Bounded: one refinement
 * round runs only when evidence is incomplete, and every search counts against splunk.queryBudget.
 */
const INVESTIGATION_EVENT_TYPES =
  "OUTBOUND_MESSAGE_CREATED | MESSAGE_PUBLISHED | MESSAGE_CONSUMED | PARTNER_REQUEST_SENT | PARTNER_REQUEST_ACCEPTED | PARTNER_RESPONSE_RECEIVED | PARTNER_CALLBACK_RECEIVED | " +
  "TRACKING_NUMBER_RECEIVED | TRACKING_NUMBER_PERSISTED | SHIPPING_LABEL_REQUESTED | SHIPPING_LABEL_URL_GENERATED | SHIPPING_LABEL_URL_OBSERVED | SHIPPING_LABEL_URL_PERSISTED | " +
  "STATE_CHANGED | RETRY_SCHEDULED | ERROR | OTHER (or another UPPER_SNAKE type for other domains, e.g. PAYMENT_CALLBACK_RECEIVED)";
const INVESTIGATION_RULES =
  "Investigation rules: this workflow is READ-ONLY — never change code, data, configuration, Kafka, or Splunk objects. " +
  "The environment is inputs.environment (default production). " +
  "QC (inputs.environment = qc) has NO Splunk: never call splunk_search there and ignore the SPL in parse_request.initial_queries. Find the service's Argo CD app with argocd.list_apps " +
  "and its workloads/pods with argocd.app_pods (check restarts / CrashLoopBackOff), then search its logs with call_tool name=qc_log_search, filtering by a concrete identifier over since_minutes " +
  "covering parse_request.time; its lines are stored as events with event_refs exactly like Splunk events. Kafka UI (kafka.*: topics, consumer lag, messages) and the QC databases " +
  "(read-only queries) may confirm what the logs show. " +
  "Production: search logs only with call_tool name=splunk_search. Always pass earliest/latest (start from parse_request.time) and name the index from parse_request.indexes. " +
  "Filter by a concrete identifier first; search broader identifiers (shipment id, tracking number, request id, Kafka key) only after the first results reveal them; " +
  "widen the time window at most twice and only after an empty result; never search every index or use leading wildcards. " +
  "Label only events you actually saw in a search result, by event_ref. The platform reads timestamps, services and identifiers from the stored log itself — do not restate times as your own facts and never invent an event_ref, URL, payload or time. " +
  "Use distinct event types for internal message creation, broker publish, consumer processing, HTTP request sent, synchronous HTTP response, asynchronous partner callback, tracking-number availability, " +
  "label URL generation and the first time a label URL is merely observed or persisted — they are different moments. Never relate events only because they are close in time. " +
  "If the result says manual_required, ask the user once with ask_user (include the SPL, the window and the splunk_url, and ask them to paste the results into the investigation panel), then read them with splunk_get_search_results. " +
  "Quote only what the question needs from production data.";
const INVESTIGATION_EVENTS_CONTRACT = `events: [{ evidence_ref: 'S<search id>:<n>', event_type: ${JSON.stringify(INVESTIGATION_EVENT_TYPES)}, ids?: { order_code?, shipment_code?, shipment_id?, tracking_no?, request_id?, trace_id?, correlation_id?, message_id? }, note? }]`;
const INVESTIGATION_SEARCH_CONTRACT = `{ searches: number[], ${INVESTIGATION_EVENTS_CONTRACT}, discovered_identifiers: { [field]: string[] }, observations: string[], missing: string[] }`;

const PRODUCTION_INVESTIGATION = {
  name: "Production Incident Investigation",
  description:
    "Read-only: parse the request → discover services & code paths → search logs (production: Splunk, QC: Argo CD) → correlate events → refine (bounded) → timeline → latency → findings → evidence-backed report",
  category: "Operations / Debugging",
  execution_mode: "read_only",
  triggers: {
    phrases: [
      "debug production",
      "production issue",
      "production incident",
      "prod issue",
      "incident",
      "check splunk",
      "splunk",
      "production log",
      "prod log",
      "trace this order",
      "trace order",
      "find when the callback",
      "callback happened",
      "when the callback",
      "shipment creation was slow",
      "why shipment",
      "response time",
      "took to respond",
      "shipping label",
      "kiem tra log",
      "xem log",
      "log don hang",
      "truy vet",
      "thoi gian now phan hoi",
      "now phan hoi",
      "thoi gian phan hoi",
      "tim thoi diem",
      "sinh shipping label",
      "loi production",
      "su co",
    ],
    requires_any: [
      "production",
      "prod",
      "splunk",
      "log",
      "logs",
      "callback",
      "webhook",
      "order",
      "don hang",
      "van don",
      "shipment",
      "tracking",
      "phan hoi",
      "respond",
      "label",
      "trace",
      "truy vet",
      "incident",
      "su co",
    ],
    excludes: [
      "implement",
      "refactor",
      "add a feature",
      "write a test",
      "write tests",
      "create a pr",
      "open a pr",
      "them tinh nang",
      "viet test",
      "sua code",
      "tao pr",
      "code review",
    ],
    explicit: [
      "splunk",
      "production log",
      "prod log",
      "log production",
      "log prod",
      "kiem tra log",
      "xem log",
    ],
  },
  inputs: {
    request: {
      description:
        "what to investigate, in Vietnamese or English (identifiers, approximate time, question)",
      required: true,
    },
    environment: {
      description:
        "production (Splunk logs) or qc (no Splunk: Argo CD pod logs, Kafka UI, QC databases); default production",
      required: false,
    },
    indexes: {
      description: "Splunk indexes to search (default: splunk.defaultIndexes)",
      required: false,
    },
    earliest: {
      description: "explicit start of the search window (ISO-8601 with offset)",
      required: false,
    },
    latest: {
      description: "explicit end of the search window (ISO-8601 with offset)",
      required: false,
    },
  },
  steps: [
    {
      key: "parse_request",
      type: "integration",
      name: "Parse Request & Identify Entities",
      config: { action: "investigation_parse" },
    },
    {
      key: "discover",
      type: "integration",
      name: "Discover Services & Repositories",
      depends_on: ["parse_request"],
      config: { ...DISCOVER, optional: true },
    },
    {
      key: "analyze_code",
      type: "agent",
      name: "Analyze Code Paths",
      depends_on: ["discover"],
      max_attempts: 2,
      config: {
        instructions:
          "Map the business flow behind the investigation request (inputs.request, parse_request.objectives) in the discovered repositories, READ-ONLY. " +
          "Use call_tool code_intelligence.search (symbols, references, exact) plus Grep/Read to find, as candidates to confirm: the outbound shipment/order creation, the partner integration client " +
          "(e.g. HasakiNOW when the request names it — do not assume), Kafka/RabbitMQ publishers and consumers, external API request/response handling, callback/webhook handlers, " +
          "tracking-number persistence and shipping-label generation/persistence. For each, record the service/container name it runs as, the exact log statements (message text and logged fields) " +
          "and which identifiers they carry (order code, shipment id, request id, trace id, Kafka key). These log formats are what the searches will look for. " +
          "If no repository is available, say so and return empty lists — do not guess file paths. Cite code as repo:path:line.",
        output_contract:
          "{ services: [{ name, repo, role, container_name?, evidence }], log_patterns: [{ service, event_type, message_pattern, fields: string[], code_location }], identifier_fields: string[], " +
          "flow: string[], code_locations: [{ repo, file, line, description }], notes: string[] }",
      },
    },
    {
      key: "search_logs",
      type: "agent",
      name: "Search Initial Logs",
      depends_on: ["discover"],
      max_attempts: 2,
      config: {
        instructions:
          "Run the initial log searches for inputs.environment (production: splunk_search starting with parse_request.initial_queries or an equivalent bounded query on the identifier; " +
          "qc: qc_log_search on the services' Argo CD apps filtered by the identifier) over parse_request.time, then read the results: " +
          "identify which service logged what, which identifiers appear (shipment id, tracking number, request/trace/correlation id, Kafka message id) and label every relevant event. " +
          "Run at most 6 searches in this step. " +
          INVESTIGATION_RULES,
        output_contract: INVESTIGATION_SEARCH_CONTRACT,
      },
    },
    {
      key: "correlate",
      type: "integration",
      name: "Correlate Events",
      depends_on: ["analyze_code", "search_logs"],
      config: { action: "investigation_correlate" },
    },
    {
      key: "refine_search",
      type: "agent",
      name: "Refine SPL & Search Additional Logs",
      depends_on: ["correlate"],
      run_if: { step: "correlate", path: "complete", equals: false },
      max_attempts: 2,
      config: {
        instructions:
          "Evidence is incomplete (correlate.missing). Close the gaps with targeted searches: use correlate.identifiers and analyze_code.log_patterns/services to search for the missing event types " +
          "(e.g. the partner callback by shipment id or tracking number in the callback service, the label URL by tracking number), label events in correlate.unlabeled_refs that matter, " +
          "and label nothing you did not see. Run at most 8 searches. If an event cannot be found, list exactly what evidence is missing and why. " +
          INVESTIGATION_RULES,
        output_contract: INVESTIGATION_SEARCH_CONTRACT,
      },
    },
    {
      key: "timeline",
      type: "integration",
      name: "Reconstruct Timeline",
      depends_on: ["refine_search"],
      config: { action: "investigation_correlate", final: true },
    },
    {
      key: "latency",
      type: "integration",
      name: "Calculate Latency",
      depends_on: ["timeline"],
      config: { action: "investigation_latency", from: "timeline" },
    },
    {
      key: "analyze_findings",
      type: "agent",
      name: "Analyze Findings",
      depends_on: ["latency"],
      max_attempts: 2,
      config: {
        instructions:
          "Interpret the validated evidence: timeline (timeline.timeline, already ordered and correlated by the platform), latency.latencies (with the compared events and qualification) and analyze_code. " +
          "Answer each question of parse_request.questions. Every finding cites evidence_refs from the timeline; classify it 'confirmed' only when the cited log lines show it directly, 'inferred' when it follows " +
          "from correlated evidence, 'unknown' otherwise — the platform lowers any classification the evidence does not support and drops unknown references. " +
          "Do not recompute or restate latencies differently; explain which events were compared. Keep a synchronous HTTP response and an asynchronous callback separate, and never present broker or end-to-end time " +
          "as the partner's pure processing time. When the exact label generation time is not logged, say the URL was first observed at that time. Put root-cause ideas under hypotheses, missing data under missing_evidence " +
          "(say which log or field would settle it) and concrete next investigation steps under next_steps. Do not search further. READ-ONLY.",
        output_contract:
          "{ answers: [{ question, answer, evidence_refs: string[] }], findings: [{ statement, classification: 'confirmed'|'inferred'|'unknown', evidence_refs: string[], code_location? }], " +
          "hypotheses: [{ hypothesis, supporting_refs: string[] }], missing_evidence: string[], next_steps: string[] }",
      },
    },
    {
      key: "report",
      type: "integration",
      name: "Generate Report",
      depends_on: ["analyze_findings"],
      config: {
        action: "investigation_report",
        from: {
          timeline: "timeline",
          latency: "latency",
          findings: "analyze_findings",
          code: "analyze_code",
        },
      },
    },
  ],
};

export const cleanup = (...after: string[]) => ({
  key: "cleanup",
  type: "integration",
  name: "Cleanup",
  depends_on: after,
  config: { action: "cleanup_workspaces" },
});

export const isCleanupStep = (s: { type?: string; config?: Record<string, unknown> | null }) =>
  s.type === "integration" && s.config?.action === "cleanup_workspaces";

type GraphStep = {
  key: string;
  depends_on: string[];
  type?: string;
  config?: Record<string, unknown> | null;
};

/** Terminal steps of the work itself: cleanup and report steps are siblings after it, never dependencies. */
export const workTerminals = (
  steps: GraphStep[],
  exclude: (s: GraphStep) => boolean = isCleanupStep,
) => {
  const work = steps.filter((s) => !exclude(s));
  return work.filter((s) => !work.some((o) => o.depends_on.includes(s.key))).map((s) => s.key);
};

export function injectedCleanup(steps: GraphStep[]) {
  const step = cleanup(
    ...workTerminals(steps, (s) => isCleanupStep(s) || s.type === "task_result_report"),
  );
  let key = step.key;
  for (let n = 2; steps.some((s) => s.key === key); n++) key = `${step.key}_${n}`;
  return { ...step, key, config: { ...step.config, injected: true } };
}

export const TEMPLATES: Array<{ key: string; spec: Record<string, unknown> }> = [
  {
    key: "work-item-analysis",
    spec: {
      name: "Work Item Analysis",
      description: "Read-only: analyse the request and recommend repositories. Changes nothing.",
      steps: [
        { key: "analyze", type: "agent", name: "Requirement Analysis", config: ANALYZE },
        {
          key: "discover",
          type: "integration",
          name: "Repository Discovery",
          depends_on: ["analyze"],
          config: DISCOVER,
        },
      ],
    },
  },
  {
    key: "feature-implementation",
    spec: {
      name: "Feature Implementation",
      description:
        "Requirement analysis → repository discovery → architecture plan → approval → implementation → tests → review → PR",
      feedback_step: "implement",
      replan_step: "plan",
      steps: [
        { key: "analyze", type: "agent", name: "Requirement Analysis", config: ANALYZE },
        {
          key: "discover",
          type: "integration",
          name: "Repository Discovery",
          depends_on: ["analyze"],
          config: DISCOVER,
        },
        {
          key: "confirm_repos",
          type: "human_approval",
          name: "Confirm Repositories",
          depends_on: ["discover"],
          config: CONFIRM_REPOS,
        },
        {
          key: "plan",
          type: "agent",
          name: "Architecture Review & Plan",
          depends_on: ["confirm_repos"],
          config: {
            instructions:
              "Design the change for the confirmed repositories: components touched, data/contract changes, migration needs, " +
              "test strategy, rollout risks, alternatives rejected. Reference concrete files (path:line).",
            output_contract:
              "{ summary, changes: [{ repo, files: string[], description }], tests: string[], risks: string[], alternatives: string[] }",
          },
        },
        {
          key: "approve_plan",
          type: "human_approval",
          name: "Approve Plan",
          depends_on: ["plan"],
          config: {
            message: "Duyệt kế hoạch kiến trúc trước khi code.",
            show_outputs: ["plan"],
            on_reject: { reexecute: "plan" },
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["approve_plan"],
          config: IMPLEMENT,
          max_attempts: 2,
        },
        {
          key: "test",
          type: "command",
          name: "Testing",
          depends_on: ["implement"],
          config: {
            command: TEST_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
          },
        },
        { key: "review", type: "agent", name: "Code Review", depends_on: ["test"], config: REVIEW },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["review"],
          config: { mode: "approval", content_from: "implement" },
        },
        cleanup("pr"),
      ],
    },
  },
  {
    key: "bug-investigation",
    spec: {
      name: "Bug Investigation",
      description:
        "Problem analysis → repository discovery → root cause → fix proposal → approval → fix → regression tests → code review → PR",
      feedback_step: "implement",
      replan_step: "root_cause",
      steps: [
        { key: "analyze", type: "agent", name: "Problem Analysis", config: BUG_ANALYZE },
        {
          key: "discover",
          type: "integration",
          name: "Repository Discovery",
          depends_on: ["analyze"],
          config: DISCOVER,
        },
        {
          key: "confirm_repos",
          type: "human_approval",
          name: "Confirm Repositories",
          depends_on: ["discover"],
          config: { ...CONFIRM_REPOS, auto_approve_unambiguous: true },
        },
        {
          key: "root_cause",
          type: "agent",
          name: "Root Cause Investigation",
          depends_on: ["confirm_repos"],
          config: BUG_ROOT_CAUSE,
        },
        {
          key: "fix_proposal",
          type: "agent",
          name: "Fix Proposal",
          depends_on: ["root_cause"],
          config: BUG_FIX_PROPOSAL,
        },
        {
          key: "approve_fix",
          type: "human_approval",
          name: "Approve Fix",
          depends_on: ["fix_proposal"],
          config: {
            show_outputs: ["root_cause", "fix_proposal"],
            approve_scope_from: "fix_proposal",
            on_reject: { reexecute: "fix_proposal" },
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["approve_fix"],
          config: BUG_IMPLEMENT,
          max_attempts: 2,
        },
        {
          key: "regression_test",
          type: "command",
          name: "Regression Testing",
          depends_on: ["implement"],
          config: {
            command: TEST_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
          },
        },
        {
          key: "review",
          type: "agent",
          name: "Code Review",
          depends_on: ["regression_test"],
          config: BUG_REVIEW,
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["review"],
          config: { mode: "approval", content_from: "implement" },
        },
        cleanup("pr"),
      ],
    },
  },
  {
    key: "code-review",
    spec: {
      name: "Code Review",
      description:
        "Repository / branch selection → code analysis (OpenCodeReview rules) → architecture → security → review report → optional: fix the findings on the reviewed branch → tests → PR",
      inputs: {
        repositories: {
          description:
            "repositories to review (optional: when empty, the run asks you to pick them)",
          required: false,
        },
        branch: {
          description:
            "branch to review against the base branch (empty = review the base branch itself); fixes are committed on it",
          required: false,
        },
        focus: { description: "what to focus on", required: false },
      },
      steps: [
        // Asks which repositories to review unless the run was started with them (then it passes straight through).
        {
          key: "select",
          type: "human_approval",
          name: "Repository / PR Selection",
          config: {
            message: "Chọn repo và branch cần review cho lần chạy này.",
            select_repositories: true,
            ask_branch: true,
            auto_approve_preselected: true,
          },
        },
        {
          key: "analyze",
          type: "agent",
          name: "Code Analysis",
          depends_on: ["select"],
          config: {
            instructions:
              "Review the selected repositories (read-only). Each repository's branch under review is inputs.branches[<repo>] " +
              "(else inputs.branch): review `git diff origin/$BASE_BRANCH...origin/<that branch>` in that repository. A repository " +
              "without a branch: review the areas named in inputs.focus on the base branch. Report correctness and maintainability issues.",
            output_contract:
              "{ findings: [{ severity, repo, file, line, issue, suggestion }], summary }",
            open_code_review: true,
          },
        },
        {
          key: "architecture",
          type: "agent",
          name: "Architecture Validation",
          depends_on: ["analyze"],
          config: {
            instructions:
              "Validate the reviewed code against the architecture guidelines and repository conventions in your context.",
            output_contract: "{ violations: [{ guideline, repo, file, detail }], summary }",
          },
        },
        {
          key: "security",
          type: "agent",
          name: "Security Review",
          depends_on: ["analyze"],
          config: {
            instructions:
              "Review the same code for security issues: injection, authz gaps, secrets, PII handling, unsafe deserialisation.",
            output_contract:
              "{ findings: [{ severity, repo, file, line, issue, suggestion }], summary }",
            skills: ["security-review"],
          },
        },
        {
          key: "report",
          type: "integration",
          name: "Review Report",
          depends_on: ["architecture", "security"],
          config: {
            action: "publish_report",
            from: ["analyze", "architecture", "security"],
            title: "Code review report",
          },
        },
        // Optional follow-up: approve to let the agent fix the review findings (the approval comment says which ones);
        // skip it to end with the report only — tests and PR then have nothing to do and finish without changes.
        {
          key: "fix",
          type: "coding_agent",
          name: "Fix Review Findings",
          depends_on: ["report"],
          requires_approval: true,
          config: FIX_FROM_REVIEW,
        },
        {
          key: "fix_test",
          type: "command",
          name: "Testing",
          depends_on: ["fix"],
          run_if: { step: "fix", status: "COMPLETED" },
          config: {
            command: TEST_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
          },
        },
        {
          key: "fix_pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["fix_test"],
          run_if: { step: "fix", status: "COMPLETED" },
          config: { mode: "approval", content_from: "fix" },
        },
        cleanup("fix_pr"),
      ],
    },
  },
  {
    key: "refactoring",
    spec: {
      name: "Refactoring",
      description:
        "Select repository → analyse code → refactoring plan → human approval → refactor → regression tests → PR",
      feedback_step: "refactor",
      replan_step: "analyze",
      inputs: {
        repositories: { description: "repository to refactor", required: true },
        goal: { description: "refactoring goal", required: true },
      },
      steps: [
        {
          key: "select",
          type: "integration",
          name: "Select Repository",
          config: { action: "select_repositories" },
        },
        {
          key: "analyze",
          type: "agent",
          name: "Analyze Code",
          depends_on: ["select"],
          config: {
            instructions:
              "Analyse the code relevant to inputs.goal: structure, coupling, test coverage, risky areas.",
            output_contract: "{ summary, hotspots: [{ file, issue }], test_coverage, risks }",
          },
        },
        {
          key: "plan",
          type: "agent",
          name: "Refactoring Plan",
          depends_on: ["analyze"],
          config: {
            instructions:
              "Produce a behaviour-preserving refactoring plan in small verifiable steps, with the tests that prove behaviour is unchanged.",
            output_contract: "{ summary, steps: [{ description, files }], safety_net: string[] }",
          },
        },
        {
          key: "approval",
          type: "human_approval",
          name: "Human Approval",
          depends_on: ["plan"],
          config: { show_outputs: ["plan"], on_reject: { reexecute: "plan" } },
        },
        {
          key: "refactor",
          type: "coding_agent",
          name: "Refactor",
          depends_on: ["approval"],
          config: IMPLEMENT,
          max_attempts: 2,
        },
        {
          key: "regression_test",
          type: "command",
          name: "Regression Testing",
          depends_on: ["refactor"],
          config: {
            command: TEST_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["regression_test"],
          config: { mode: "approval", content_from: "refactor" },
        },
        cleanup("pr"),
      ],
    },
  },
  { key: "production-incident-investigation", spec: PRODUCTION_INVESTIGATION },
  {
    key: "platform-self-development",
    spec: {
      name: "Platform Self-Development",
      description:
        "Change this platform in an isolated worktree: analyse, plan, approve, implement, targeted tests, independent review, full regression, GitHub or Bitbucket pull request. The running checkout is not modified.",
      category: "Platform / Internal Tooling",
      execution_mode: "self_development",
      feedback_step: "implement",
      replan_step: "plan",
      steps: [
        { key: "analyze", type: "agent", name: "Requirement Analysis", config: ANALYZE },
        {
          key: "discover",
          type: "integration",
          name: "Repository Discovery",
          depends_on: ["analyze"],
          config: DISCOVER,
        },
        {
          key: "confirm_repos",
          type: "human_approval",
          name: "Confirm Repositories",
          depends_on: ["discover"],
          config: { ...CONFIRM_REPOS, auto_approve_preselected: true },
        },
        {
          key: "plan",
          type: "agent",
          name: "Architecture Review & Plan",
          depends_on: ["confirm_repos"],
          config: {
            instructions:
              "Design the change for the confirmed repositories. Name the modules and dependencies affected, the test strategy " +
              "(targeted checks first, full npm test before the pull request), and rollout risks. Do not plan a restart, deploy, " +
              "merge, or migration of the running application's database. Reference concrete files (path:line).",
            output_contract:
              "{ summary, changes: [{ repo, files: string[], description }], tests: string[], risks: string[], alternatives: string[] }",
          },
        },
        {
          key: "approve_plan",
          type: "human_approval",
          name: "Approve Plan",
          depends_on: ["plan"],
          config: {
            message: "Duyệt kế hoạch trước khi sửa mã nguồn của chính nền tảng.",
            show_outputs: ["plan"],
            on_reject: { reexecute: "plan" },
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["approve_plan"],
          config: SELF_IMPLEMENT,
          max_attempts: 2,
        },
        {
          key: "targeted_test",
          type: "command",
          name: "Targeted Tests",
          depends_on: ["implement"],
          config: {
            command: PLATFORM_TARGETED_COMMAND,
            timeout_seconds: 900,
            on_failure: "ask",
            require_workspace: true,
          },
        },
        {
          key: "review",
          type: "agent",
          name: "Code Review",
          depends_on: ["targeted_test"],
          config: {
            ...REVIEW,
            instructions:
              REVIEW.instructions +
              " This diff is to the platform that is running the review. Fail the review if it weakens authorization, " +
              "tool policy, worktree isolation, secret handling, or makes tests use the application database.",
          },
        },
        {
          key: "regression_test",
          type: "command",
          name: "Full Regression",
          depends_on: ["review"],
          config: {
            command: PLATFORM_REGRESSION_COMMAND,
            timeout_seconds: 1800,
            on_failure: "ask",
            require_workspace: true,
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["regression_test"],
          config: { mode: "approval", content_from: "implement" },
        },
        cleanup("pr"),
      ],
    },
  },
  {
    key: "intelligent-feature-engineering",
    spec: {
      name: "Intelligent Feature Engineering",
      description:
        "Complex features and cross-module changes: requirements, repository discovery, architecture, an approved plan, implementation in a worktree, targeted checks, independent review, regression, then a pull request. Learning stays a reviewable proposal.",
      category: "Engineering",
      execution_mode: "standard",
      feedback_step: "implement",
      replan_step: "architecture",
      inputs: {
        goal: {
          description: "Feature goal when it is narrower than the work item text",
          required: false,
        },
        repositories: {
          description: "Repositories to change. Empty lets discovery recommend them",
          required: false,
        },
      },
      steps: [
        {
          key: "understand",
          type: "agent",
          name: "Understand Requirements",
          config: {
            instructions:
              "Extract the engineering request. Do not design the change and do not search the whole codebase. " +
              "Read code only to pin down terminology. If a behaviour cannot be settled from the request, ask the developer. " +
              "Produce objectives, acceptance criteria, constraints, assumptions, ambiguities and risks.",
            output_contract:
              "{ goal, objectives: string[], acceptance_criteria: string[], constraints: string[], assumptions: string[], ambiguities: string[], keywords: string[], risks: string[] }",
          },
        },
        {
          key: "discover",
          type: "integration",
          name: "Discover Context & Experience",
          depends_on: ["understand"],
          config: DISCOVER,
        },
        {
          key: "confirm_repos",
          type: "human_approval",
          name: "Confirm Repositories",
          depends_on: ["discover"],
          config: CONFIRM_REPOS,
        },
        {
          key: "architecture",
          type: "agent",
          name: "Architecture & Impact Analysis",
          depends_on: ["confirm_repos"],
          config: {
            instructions:
              "The confirmed repositories are already selected. Applicable knowledge and approved task memory are already in your context; " +
              "use search_knowledge and search_task_memory only for a gap, and call_tool code_intelligence.search for the symbols and dependencies this change touches. " +
              "Do not rank repositories again. Record what you consulted so later steps reuse this output instead of searching again. " +
              "Evaluate affected modules, dependency impact, alternatives, compatibility and architectural risks. Cite path:line.",
            output_contract:
              "{ summary, modules: [{ repo, path, reason }], dependencies: string[], symbols: [{ repo, name, path }], knowledge: string[], experience: string[], alternatives: [{ option, rejected_because }], compatibility: string[], risks: string[] }",
          },
        },
        {
          key: "plan",
          type: "agent",
          name: "Decompose & Plan",
          depends_on: ["architecture"],
          config: {
            instructions:
              "Turn the architecture output into one ordered implementation plan for this run. " +
              "Subtasks are logical plan items, not child runs and not a second scheduler. " +
              "Each subtask names its dependencies, the files it touches, its acceptance criteria and how it will be verified. " +
              "Do not search the repository again unless a file cited above is missing. " +
              "Targeted checks run before the independent review; the broader regression runs after that review and before the pull request.",
            output_contract:
              "{ summary, subtasks: [{ id, title, depends_on: string[], files: string[], acceptance_criteria: string[], verification: string[] }], risks: string[], verification_strategy: string[] }",
          },
        },
        {
          key: "approve_plan",
          type: "human_approval",
          name: "Human Plan Approval",
          depends_on: ["plan"],
          config: {
            message: "Duyệt kế hoạch trước khi sửa mã nguồn. Từ chối sẽ làm lại bước lập kế hoạch.",
            show_outputs: ["understand", "architecture", "plan"],
            on_reject: { reexecute: "plan" },
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["approve_plan"],
          config: {
            ...IMPLEMENT,
            instructions:
              IMPLEMENT.instructions +
              " Implement only the approved plan's subtasks, in that order, inside the worktrees returned by prepare_branch. " +
              "Do not modify the running application's checkout, restart it, deploy, or merge. " +
              "Do not create child runs. Read the plan output instead of repeating discovery.",
          },
          max_attempts: 2,
        },
        {
          key: "targeted_test",
          type: "command",
          name: "Targeted Verification",
          depends_on: ["implement"],
          config: {
            command: FEATURE_TARGETED_COMMAND,
            timeout_seconds: 900,
            baseline_compare: "go",
            on_failure: "ask",
            require_workspace: true,
          },
        },
        {
          key: "review",
          type: "agent",
          name: "Independent Review & Repair",
          depends_on: ["targeted_test"],
          config: {
            ...REVIEW,
            instructions:
              REVIEW.instructions +
              " Judge the diff against the approved acceptance criteria, the architecture constraints, security, correctness and maintainability. " +
              "Repair stays inside the existing review budget. Do not open a new run.",
          },
        },
        {
          key: "regression_test",
          type: "command",
          name: "Regression & Quality Gate",
          depends_on: ["review"],
          config: {
            command: FEATURE_REGRESSION_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
            require_workspace: true,
          },
        },
        {
          key: "quality_gate",
          type: "human_approval",
          name: "Quality Gate",
          depends_on: ["regression_test"],
          config: {
            message:
              "Kiểm tra bắt buộc phải đạt trước khi mở pull request. Từ chối sẽ làm lại bước hiện thực.",
            show_outputs: ["targeted_test", "review", "regression_test"],
            on_reject: { reexecute: "implement" },
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["quality_gate"],
          config: { mode: "approval", content_from: "implement" },
        },
        cleanup("pr"),
      ],
    },
  },
];

// Not seeded: an admin installs it as a private workflow (POST /api/workflows with this key and spec) so only they run it.
export const PONYTAIL_PILOT_TEMPLATE = {
  key: "ponytail-nonproduction-pilot",
  spec: {
    name: "Ponytail non-production pilot",
    description: "Explicit opt-in only; evaluate against baseline before production rollout.",
    steps: [
      {
        key: "implement",
        type: "coding_agent",
        name: "Pilot implementation",
        config: {
          skills: ["skill.ext.ponytail"],
          instructions:
            "Implement the requested change in this non-production pilot. Preserve all verification gates.",
        },
      },
      {
        key: "review",
        type: "agent",
        name: "Pilot review",
        depends_on: ["implement"],
        config: { ...REVIEW, skills: ["skill.ext.ponytail-review"] },
      },
    ],
  },
};
