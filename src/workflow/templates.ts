import { LATENT_REVIEW_RULE, LATENT_SWEEP } from "../latentRisk/checklist.ts";

/**
 * Built-in workflow templates. Seeded on startup as normal versioned definitions (is_template = true):
 * editing one publishes a new version; running runs stay pinned to the version they started with.
 */

// Resolve the trusted helper on the current worker, not from a persisted machine-specific path.
const NODE_DEPENDENCIES =
  'node "${PLATFORM_NODE_DEPENDENCIES:?Verification worker dependency helper is unavailable}" "$PWD"\nunset PLATFORM_DEPENDENCY_EVIDENCE_DIR';

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
  ${NODE_DEPENDENCIES}
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
 * unit test files (no PostgreSQL) and integration test files (one shared cluster, only when one matches).
 * When no tests match, the repository's unit suite runs as a fallback. The full `npm run test:all` script, integration tests included, runs once, later,
 * on the same commit.
 */
const SELF_TEST_GUARD = `set -euo pipefail
if [ -n "\${DATABASE_URL:-}" ]; then echo "refusing verification: DATABASE_URL is set" >&2; exit 2; fi
admin="\${TEST_DATABASE_ADMIN_URL:-}"
case "$admin" in
  */platform|*/platform\\?*) echo "refusing verification: admin URL names the application database" >&2; exit 2 ;;
esac
if [ ! -f package.json ]; then echo "package.json is required" >&2; exit 1; fi
${NODE_DEPENDENCIES}`;

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
  echo "== unit suite (targeted selection empty)"
  npm test
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
  ${NODE_DEPENDENCIES}
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
  ${NODE_DEPENDENCIES}
  echo "== regression (npm test)"
  npm test --if-present
else
  echo "no regression runner detected"
fi`;

/**
 * Verification command for MICRO profile. Unlike FEATURE_TARGETED_COMMAND, MICRO has no later
 * regression step; if test/setup.ts is absent (an ordinary Node repository) or no targeted tests match,
 * it falls back to running unit tests (npm test --if-present) so tests are never skipped before PR approval.
 */
export const FEATURE_MICRO_TARGETED_COMMAND = `set -euo pipefail
${FEATURE_SELF_GUARD}
if [ -f go.mod ]; then
  pkgs=$(git diff --name-only "origin/$BASE_BRANCH...HEAD" -- '*.go' | xargs -r -n1 dirname | sort -u | sed 's|^|./|')
  echo "== go build ./..."
  go build ./...
  if [ -n "$pkgs" ]; then
    echo "== go test -short -timeout 5m \${GO_TEST_SKIP:+-skip $GO_TEST_SKIP} $pkgs"
    go test -short -timeout 5m \${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} $pkgs
  else
    echo "== go test -short -timeout 5m ./..."
    go test -short -timeout 5m \${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} ./...
  fi
elif [ -f package.json ]; then
  ${NODE_DEPENDENCIES}
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
      echo "== unit tests fallback (npm test)"
      npm test --if-present
    fi
  else
    echo "== unit tests (npm test)"
    npm test --if-present
  fi
else
  echo "no test runner detected"
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
  output_schema: {
    type: "object",
    required: ["summary", "pull_requests", "verification"],
    properties: {
      summary: { type: "string", minLength: 1 },
      pull_requests: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["title", "summary", "decisions"],
          properties: {
            title: { type: "string", minLength: 1 },
            summary: { type: "string" },
            decisions: {
              type: "array",
              items: {
                type: "object",
                required: ["title", "detail"],
                properties: { title: { type: "string" }, detail: { type: "string" } },
              },
            },
          },
        },
      },
      verification: { type: ["object", "string"] },
      outcome: { enum: ["IMPLEMENTED", "NO_CHANGE_REQUIRED", "BLOCKED", "FAILED"] },
    },
  },
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
    "the relevant code or test evidence, why it violates a requirement, and a concrete repair suggestion. " +
    "Also check the added lines for AI slop (load skill ai-slop if available): guards for states that cannot happen, re-validation of already validated input, " +
    "swallowed or double-logged errors, comments the minimal-comments standard rejects, placeholder/TODO stubs, helpers that duplicate an existing one in the repo, " +
    "unrequested backward-compat shims, single-use abstractions, tests that assert nothing, and edits outside the task. Prefix such findings with [slop], " +
    "cite the evidence (the invariant, the existing helper, the lost error) and keep them low unless they hide a defect (a swallowed error is medium or high); " +
    "low [slop] findings alone do not reject the change. " +
    LATENT_REVIEW_RULE +
    "Report findings; do not modify code.",
  output_contract:
    "{ approved: boolean, findings: [{ severity: 'high'|'medium'|'low', file, line, issue, evidence, suggestion }], summary }",
  workspace_read: true,
  // Scope + curated per-language rules from Alibaba OpenCodeReview (delegation mode, no extra model/API key).
  open_code_review: true,
  // Adds the deterministic latent-risk probe's candidates for this diff to the prompt (src/latentRisk).
  latent_risks: true,
};

/**
 * Evidence-gated investigation (src/agent/evidence.ts). The platform normalizes these fields deterministically: claims
 * without usable provenance are downgraded, root-cause status is capped by verified evidence and never rises between
 * steps without new evidence, and fix risk has a detected floor. Steps opt in with config.evidence.
 */
const CLAIMS_CONTRACT =
  "claims: [{ id, claim, classification: 'OBSERVED_FACT'|'CODE_FACT'|'HYPOTHESIS'|'ASSUMPTION'|'CONFIRMED_ROOT_CAUSE', source_type?, source_ref?, repository?, commit?, file_path?, line_range?, confidence: 'low'|'medium'|'high', verification_status: 'verified'|'unverified'|'missing'|'contradicted', supports?: string[], contradicts?: string[] }]";
const EVIDENCE_RULES =
  "Evidence rules: classify every critical claim. OBSERVED_FACT needs an observable source (production_log, api_response, database, test_output, screenshot, user_report…) and a source_ref you actually saw; " +
  "CODE_FACT needs repository, file_path, line_range and the commit you read. Earlier agent outputs are opinions, not evidence: repeating a hypothesis never makes it a fact. " +
  "If a source (logs/Splunk, database, external API docs) was not available to you, list it under missing_evidence and do not claim it was inspected. " +
  "Never copy secrets or raw customer payloads into claims; cite a reference instead. Use low/medium/high, never numeric confidence.";
const REQUIRED_TESTS_RULE =
  "required_tests holds only executable test IDs the platform runs after implementation: Go `<module path>/<package path>/TestName`, or a Node --test file such as `<repo>::test/foo.test.ts`. " +
  "Prefix `<repo>::` when the ID could match more than one repository. Never put shell commands (go build, npm run lint/build), prose or test descriptions there; " +
  "list those under regression_tests. Leave required_tests empty when no such test exists yet in a form you can name exactly. ";
const ROOT_CAUSE_CONTRACT =
  "root_cause_assessment: { status: 'CONFIRMED'|'PROBABLE'|'UNCONFIRMED'|'INSUFFICIENT_EVIDENCE', confidence: 'low'|'medium'|'high', explanation, supporting_claims: string[] }";

const INVESTIGATION_HANDOFF =
  "If run inputs contain `investigation` (handed over from a read-only production investigation), start from it: its findings, timeline and latencies cite evidence_refs (S<search>:<n>). " +
  "Its evidence may come from Splunk or SigNoz (both use S<search>:<n> refs). Re-read the events you rely on with call_tool splunk_get_event before classifying them as OBSERVED_FACT (source_type production_log, source_ref = the evidence_ref); its hypotheses and missing_evidence are open questions, not facts. ";

/** M4: one read-only evidence step; the platform verifies its claims (provenance, `observed`) and reports. */
const INCIDENT_INVESTIGATE = {
  evidence: "root_cause",
  instructions:
    "Investigate inputs.request READ-ONLY, in this order. (A) Collect evidence with the authorized tools (traces, logs, read-only queries). " +
    "When several deterministic lookups must be combined (correlate traces with logs, aggregate large results, join with code or knowledge), " +
    "run them in ONE platform.execute_code program that returns a compact result; call a single tool directly. " +
    "(B) Correlate by request/trace/order ids, service, time window and error fingerprint; keep observed facts, correlations and hypotheses apart. " +
    "(C) Find the owning code with platform.search_code/get_symbol/find_dependencies/navigate_code (syntax hits are candidates: check the live file) and relevant verified knowledge; " +
    "use task memory only when its freshness is FRESH. (D) Assess the root cause against supporting AND contradicting evidence; a symptom fix " +
    "(raise a timeout, add a retry) is not a root cause unless evidence shows why the operation is slow or failing. " +
    "Evidence citations: for a fact taken from a CodeAct nested call, set source_ref to its `codeact:<execution>:<seq>` ref from `evidence` and, for every identifier or count you state, " +
    "add observed: { pointer: '/<json pointer into that call's result>', equals | count | includes } so the platform can check it. " +
    "Code facts need repository, file_path, line_range and commit. Put what you could not inspect under missing_evidence and next investigation steps under next_steps. " +
    EVIDENCE_RULES,
  output_contract:
    "{ summary, hypotheses: string[], next_steps: string[], missing_evidence?: string[], " +
    ROOT_CAUSE_CONTRACT +
    ", " +
    CLAIMS_CONTRACT.replace(
      "contradicts?: string[] }]",
      "contradicts?: string[], observed?: { pointer, equals?, count?, includes? } }]",
    ) +
    " }",
};

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
    REQUIRED_TESTS_RULE +
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
 * Codebase improvement: a proactive assessment that may end with "no changes needed". Built from the evidence-gated
 * bug-fix machinery: the selected finding is the root cause (claims checked for provenance), the proposal carries the
 * fix risk and a blast radius checked against the platform's own impact analysis, and the implementation is held to
 * Root Cause First at strict depth, so a change ships only with a platform-run test that fails before and passes after.
 */
const IMPROVE_WHEN = { step: "assess", path: "decision", equals: "IMPROVE" };
const ASSESS_SIGNALS =
  "(1) Orient from what the platform already knows: repository metadata, the codebase map and knowledge in your context, platform.get_production_errors for the services, and inputs.focus if given. " +
  "(2) Collect deterministic signals before reading code: production errors and latencies, failing or skipped tests, lint or vet output you can run read-only, code_intelligence searches. " +
  "(3) Read only the hotspots those signals point to (search_code, get_symbol, find_dependencies, targeted Read). This is a repository-wide assessment from signals, not a file-by-file review: say what you did not inspect. " +
  "Report only findings backed by evidence: a confirmed defect, a measured bottleneck, a security risk, or a maintainability issue with a concrete consequence. Never invent improvements or propose speculative refactoring. " +
  "A finding is implementable only when a platform-runnable test can demonstrate it: it fails on the current code and passes once the finding is fixed (for performance, the test asserts the measured budget: allocations, query count, complexity bound or a time budget with margin). " +
  "Classify each finding into one kind: CONCURRENCY (race, deadlock), MEMORY (leak, unbounded cache), RESOURCE (goroutine, connection or file descriptor leak), DATABASE (N+1, redundant query, missing transaction), " +
  "PERFORMANCE (blocking I/O, needless serialization, excessive allocation), CODE_QUALITY (dead code, unused dependency, duplicated logic), RELIABILITY (missing timeout, retry storm, ignored cancellation), " +
  "DATA_INTEGRITY (lost update, duplicate processing, invalid state transition), SECURITY (injection, SSRF, sensitive data exposure), BUSINESS_LOGIC (edge case, wrong condition, missing validation), DISTRIBUTED (missing idempotency, inconsistent state, message loss). " +
  "Use the read-only analysers when they fit: go vet, go test -race, staticcheck, golangci-lint run, govulncheck, deadcode, benchmarks with -benchmem, and go tool pprof -top/-list on a profile written to /tmp. " +
  LATENT_SWEEP +
  "Load the verification-recipes skill: it says, per kind, which test demonstrates the finding. " +
  "Give each finding the repository its code is in (`repo`) and, in `related_repos`, the other selected repositories with the same defect or affected by it. " +
  "Give each finding a `title` of at most 80 characters naming the defect, and the `symbol` (function, method or type) its code is in: findings are tracked across scans by repo, category, file and symbol. " +
  "Confirm every finding with the code index yourself (platform search_code, get_symbol, find_dependencies or navigate_code) before reporting it: the platform marks a finding as unverified unless one of YOUR code-intelligence calls in this step returned its file, and an unverified finding cannot be fixed. ";
const FINDING_KINDS =
  "'CONCURRENCY'|'MEMORY'|'RESOURCE'|'DATABASE'|'PERFORMANCE'|'CODE_QUALITY'|'RELIABILITY'|'DATA_INTEGRITY'|'SECURITY'|'BUSINESS_LOGIC'|'DISTRIBUTED'";
const FINDINGS_CONTRACT =
  "findings: [{ id, kind: " +
  FINDING_KINDS +
  ", severity: 'high'|'medium'|'low', title?, repo, file, line, symbol?, issue, evidence, implementable: boolean, why_not?, related_repos?: string[] }]";
const IMPROVE_ASSESS = {
  evidence: "root_cause",
  code_evidence: "required",
  latent_risks: true,
  instructions:
    "Assess the selected repositories for ONE improvement worth making, in stages, and stop as soon as the evidence decides. " +
    ASSESS_SIGNALS +
    "When inputs.finding is set (a person chose it from an assessment), work on exactly that finding: re-check it against the current code, and select it if it still holds or answer NO_CHANGES_NEEDED with why; never switch to another finding. " +
    "When inputs.decision is also set, a person has decided what the correct behaviour is (it was report-only because that decision was missing): treat it as a requirement, so the finding is implementable when a test can demonstrate the decided behaviour. " +
    "Otherwise select at most one implementable finding. Give the selected finding as `selected` with its `target` (repo, files, symbols) and set decision IMPROVE; keep the other findings listed for separate runs. " +
    "When nothing qualifies, set decision NO_CHANGES_NEEDED: that is a valid result. root_cause_assessment rates the selected finding (CONFIRMED only on verified facts). " +
    EVIDENCE_RULES,
  output_contract:
    "{ decision: 'IMPROVE'|'NO_CHANGES_NEEDED'|'UNVERIFIED', summary, " +
    FINDINGS_CONTRACT +
    ", selected?: { finding_id, kind: " +
    FINDING_KINDS +
    ", expected_benefit }, target?: { repo, files: string[], symbols: string[] }, coverage: { inspected: string[], signals: string[], not_inspected: string[] }, missing_evidence?: string[], " +
    ROOT_CAUSE_CONTRACT +
    ", " +
    CLAIMS_CONTRACT +
    " }",
};
/** The read-only assessment a person picks findings from: every evidence-backed finding, none selected or changed. */
const IMPROVE_SCAN = {
  evidence: "analysis",
  code_evidence: "required",
  latent_risks: true,
  instructions:
    "Assess the selected repositories in stages and list every evidence-backed finding (at most 20, most severe first). Nothing is changed and nothing is selected here: a person picks the findings to fix. " +
    ASSESS_SIGNALS +
    "Set decision FINDINGS when you report at least one finding, NO_CHANGES_NEEDED when nothing qualifies (a valid result). " +
    EVIDENCE_RULES,
  output_contract:
    "{ decision: 'FINDINGS'|'NO_CHANGES_NEEDED', summary, " +
    FINDINGS_CONTRACT +
    ", coverage: { inspected: string[], signals: string[], not_inspected: string[] }, missing_evidence?: string[], " +
    CLAIMS_CONTRACT.replace("claims:", "claims?:") +
    " }",
};
const IMPROVE_PROPOSAL = {
  ...BUG_FIX_PROPOSAL,
  instructions:
    "Propose the smallest change that fixes the selected finding of the assessment and nothing else. " +
    "Establish its blast radius before any code changes: callers and dependencies (find_dependencies, search_code), entry points, business flows, API and data contracts, and cross-repository consumers from the blast_radius step (its confirmed links are static; uncertain ones are inferred). " +
    "blast_radius.status is ESTABLISHED only when every affected caller and consumer is known; otherwise PARTIAL or UNKNOWN with what is uncertain. An unestablished blast radius is not a failure, but a human must acknowledge it before anything is implemented. " +
    "State the expected benefit as a measurable quantity with its current value, and the verification plan. required_tests names the ONE executable test that fails on the current code and passes after the change (it is run by the platform on both). " +
    "Changes must preserve business behaviour, public contracts and architectural boundaries unless the finding is exactly that defect. " +
    "When inputs.decision is set, the change implements exactly that decision of a person, nothing broader. " +
    BUG_FIX_PROPOSAL.instructions,
  output_contract: BUG_FIX_PROPOSAL.output_contract.replace(
    "{ summary,",
    "{ summary, finding_id, blast_radius: { status: 'ESTABLISHED'|'PARTIAL'|'UNKNOWN', confirmed: string[], uncertain: string[] }, expected_benefit: { metric, current, target }, verification_plan: string[],",
  ),
};
const IMPROVE_IMPLEMENT = {
  ...BUG_IMPLEMENT,
  root_cause_depth: "strict",
  instructions:
    BUG_IMPLEMENT.instructions +
    " Write the regression test named in required_tests first and keep it in the repository: it is the durable evidence. " +
    "Never commit audit reports, notes, temporary verification scripts, screenshots, videos or generated evidence: the platform stores evidence as run artifacts.",
};
const IMPROVE_REVIEW = {
  ...BUG_REVIEW,
  root_cause_depth: "strict",
  instructions:
    BUG_REVIEW.instructions +
    " Also compare the cross-repository impact of the actual diff (impact step) with the blast radius approved before implementation: a consumer or contract the approval did not cover is BLOCKED, not PASS. " +
    "Do not claim the absence of regressions beyond what the tests and analyses actually covered.",
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
  "Production sources are parse_request.observability (splunk, signoz or both); use only those. " +
  "SigNoz (call_tool signoz_*): start with signoz_aggregate_logs (errors grouped by service.name, time_series=true for spikes) or parse_request.signoz_queries, " +
  "then narrow with signoz_search_logs / signoz_search_traces on a concrete identifier, service or trace_id, follow failing or slow requests with signoz_get_trace (by trace_id or request_id), and check latency/throughput/error rate with signoz_query_metrics; " +
  "a request id seen in logs or a span (request.id) links both: search the other source with it. For a slow request read signoz_get_trace `gaps` (time with no child span = uninstrumented work) and inspect the code between the `after` and `before` spans; " +
  "always pass earliest/latest from parse_request.time and keep windows small. SigNoz rows are stored as events with event_refs exactly like Splunk events. " +
  "No telemetry for a service or window is NOT evidence that it is healthy: report it as missing evidence. Keep confirmed findings (an event you saw) apart from hypotheses. " +
  "Splunk: search logs only with call_tool name=splunk_search. Always pass earliest/latest (start from parse_request.time) and name the index from parse_request.indexes. " +
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
    "Read-only: parse the request → discover services & code paths → search logs (production: Splunk and/or SigNoz, QC: Argo CD) → correlate events → refine (bounded) → timeline → latency → findings → evidence-backed report",
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
      "check signoz",
      "signoz",
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
    observability: {
      description:
        "production telemetry source: auto (every source you connected; default), splunk, signoz or both",
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
          "Run the initial log searches for inputs.environment (production: for each source in parse_request.observability — splunk_search starting with parse_request.initial_queries, " +
          "signoz_* starting with parse_request.signoz_queries — or an equivalent bounded query on the identifier; " +
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
          "In a later investigation round the feedback lists the next actions chosen by the platform: do them in order, never repeat an equivalent search, " +
          "count affected objects by distinct identifier (stats dc(<id field>) by the identifier, not dc(_raw)) and keep windows bounded. " +
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
          "(say which log or field would settle it) and concrete next investigation steps under next_steps. Do not search further. READ-ONLY. " +
          "Hypotheses: give each an id, a kind (direct_trigger = what immediately raised the error, contributing_factor, causal_origin = where the defect or bad input " +
          "really comes from, systemic_recurrence = why it keeps happening, e.g. retries amplifying it), the observations it predicts, supporting_refs AND contradicting_refs " +
          "(evidence that argues against it), and the code_location (repo:path:line) of the mechanism. Keep alternatives apart (malformed input at its source vs provider contract " +
          "vs retry amplification vs a deploy regression) and never present a mitigation (retry, timeout, log level, validation bypass) as the cause. The platform sets each " +
          "status from the evidence. deployed: the commit each failing service actually ran, only when read from a stored record (evidence_ref), else omit it. " +
          "Never copy personal data (phone numbers, names, addresses) — describe its shape (length, prefix class) instead.",
        output_contract:
          "{ answers: [{ question, answer, evidence_refs: string[] }], findings: [{ statement, classification: 'confirmed'|'inferred'|'unknown', evidence_refs: string[], code_location? }], " +
          "hypotheses: [{ id, statement, kind: 'direct_trigger'|'contributing_factor'|'causal_origin'|'systemic_recurrence', service?, supporting_refs: string[], contradicting_refs: string[], " +
          "predicted_observations: string[], code_location? }], deployed?: [{ service, commit, evidence_ref }], missing_evidence: string[], next_steps: string[] }",
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

/**
 * Production Bug Hunter (started from a Production Errors incident): the incident-investigation steps (investigate +
 * evidence report) plus a bounded, evidence-driven bug hunt. Everything is read-only; the only code that runs is the
 * verifier's focused reproduction test, executed by the platform in a throwaway network-isolated export.
 *   context → scope ─┐
 *   context → investigate → evidence
 *   scope → hunt → triage → verify (independent; hunter output withheld) → reproduce → report
 */
const BUG_HUNT_CANDIDATE =
  "{ repository, commit, file_path, function, line_start: number, line_end: number, category, hypothesis, trigger, expected, actual, supporting_evidence: string[], reproduction_strategy, confidence: number, uncertainty }";
export const BUG_HUNT_HUNTER = {
  instructions:
    "Hunt for REAL, reproducible defects in the code that the bug hunt scope (upstream `scope`) ties to the incident (upstream `context`). READ-ONLY. " +
    "Start from the scope's functions and lines at the recorded revision; read callers, error handling, retries, state transitions, database transactions, concurrency and cancellation around them. " +
    "Do not scan the whole repository. Look for: incorrect business logic, race conditions, deadlocks, retry amplification, idempotency violations, incorrect error handling, resource leaks, " +
    "transaction consistency, incorrect state transitions, boundary conditions, silent data corruption, unexpected nil/null behaviour, missing cancellation propagation. " +
    "For every candidate give the exact location (repository, commit = the scope revision, file_path, function, line_start, line_end), category " +
    "(business_logic|race_condition|deadlock|retry_amplification|idempotency|error_handling|resource_leak|transaction_consistency|state_transition|boundary_condition|data_corruption|nil_handling|cancellation|other), " +
    "the hypothesis, the triggering input or execution condition, expected vs actual behaviour, supporting_evidence (what you read: file:line facts, incident evidence), a reproduction_strategy " +
    "(the smallest focused test), confidence 0..1 and the uncertainty. Report at most 5 candidates, strongest first; prefer none to a speculative one. " +
    "A candidate is a hypothesis: never call it a confirmed bug or a confirmed root cause — an independent verifier decides. List inspected_files and what you could not inspect under missing_evidence.",
  output_contract: `{ summary, candidates: [${BUG_HUNT_CANDIDATE}], inspected_files: string[], missing_evidence?: string[] }`,
  agent: { max_tool_calls: 80, timeout_ms: 1_200_000, context_tokens: 24000 },
};
export const BUG_HUNT_VERIFIER = {
  // The hunter's reasoning and evidence never reach this step: only the platform-built claims (triage.to_verify).
  withhold: ["hunt"],
  instructions:
    "You are an INDEPENDENT verifier of bug claims (upstream `triage`.to_verify). You did not write them; do not trust them. For EACH claim, independently: " +
    "(1) read the implementation at the given repository revision; (2) validate the claimed execution path; (3) check the issue is reachable from real inputs; " +
    "(4) design the smallest safe reproduction: a NEW Go test file in the function's package directory (test_file directly inside package_dir, test_name, complete test_code) that FAILS on the current code because of the defect " +
    "— fixtures and fakes only, never a real database, broker, network or credential; the platform runs it in an isolated, network-disabled copy and you cannot edit files; " +
    "(5) decide whether the behaviour violates the intended contract; (6) name alternative explanations; (7) reject unsupported claims. " +
    "verdict: CONFIRMED only when a failing test or code you quote proves the defect (cite code_evidence with the exact excerpt and its file_path/line_start/line_end, and the execution_path); " +
    "SUSPECTED when plausible but unproven; REJECTED when the code contradicts the claim; BLOCKED when the code or evidence needed is unavailable. " +
    "Separately judge incident_link (SUPPORTED|NOT_SUPPORTED|UNKNOWN): whether the persisted incident evidence in `context` connects to THIS defect — a real bug is not automatically the incident's cause.",
  output_contract:
    "{ summary, verdicts: [{ id, verdict: 'CONFIRMED'|'SUSPECTED'|'REJECTED'|'BLOCKED', reason, execution_path: string[], code_evidence: [{ file_path, line_start: number, line_end: number, excerpt }], " +
    "alternative_explanations: string[], incident_link: 'SUPPORTED'|'NOT_SUPPORTED'|'UNKNOWN', incident_link_reason, reproduction?: { test_file, test_name, package_dir, test_code } }] }",
  agent: { max_tool_calls: 80, timeout_ms: 1_200_000, context_tokens: 24000 },
};
export const PRODUCTION_BUG_HUNT = {
  name: "Production Bug Hunt",
  description:
    "Read-only, started from a production incident: persisted incident evidence → bounded code scope (stack frames, LSP / Code Intelligence) → incident investigation + evidence report → bug hunter → triage (dedupe, reuse, budget) → independent verifier → isolated reproduction → report with separate bug and incident-causality verdicts.",
  category: "Operations / Debugging",
  execution_mode: "read_only",
  inputs: {
    fingerprint: { description: "production incident fingerprint", required: true },
    request: { description: "the incident, as the investigation's request", required: true },
  },
  steps: [
    {
      key: "context",
      type: "integration",
      name: "Incident Context",
      config: { action: "bug_hunt_context" },
    },
    {
      key: "scope",
      type: "integration",
      name: "Scope Discovery",
      depends_on: ["context"],
      config: { action: "bug_hunt_scope" },
    },
    {
      key: "investigate",
      type: "agent",
      name: "Collect, Correlate & Diagnose",
      depends_on: ["context", "scope"],
      max_attempts: 2,
      config: INCIDENT_INVESTIGATE,
    },
    {
      key: "evidence",
      type: "integration",
      name: "Verify Investigation Evidence",
      depends_on: ["investigate"],
      config: {
        action: "evidence_report",
        from: "investigate",
        objectives: { required_sources: ["trace", "log", "code"], require_root_cause: true },
      },
    },
    {
      key: "hunt",
      type: "agent",
      name: "Bug Hunter",
      depends_on: ["evidence"],
      max_attempts: 2,
      config: BUG_HUNT_HUNTER,
    },
    {
      key: "triage",
      type: "integration",
      name: "Candidate Triage",
      depends_on: ["hunt"],
      config: { action: "bug_hunt_triage" },
    },
    {
      key: "verify",
      type: "agent",
      name: "Independent Verification",
      depends_on: ["triage"],
      run_if: { step: "triage", path: "verify_needed", equals: true },
      max_attempts: 2,
      config: BUG_HUNT_VERIFIER,
    },
    {
      key: "reproduce",
      type: "integration",
      name: "Isolated Reproduction",
      depends_on: ["verify"],
      config: { action: "bug_hunt_reproduce" },
    },
    {
      key: "report",
      type: "integration",
      name: "Bug Hunt Report",
      depends_on: ["reproduce"],
      config: { action: "bug_hunt_report" },
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

/** Merge the branches the PR step published into release/qc; conflicts are resolved and built + tested before the push. */
export const qcMerge = (after: string) => ({
  key: "qc_merge",
  type: "integration",
  name: "Merge into release/qc",
  depends_on: [after],
  config: {
    action: "merge_into_branch",
    target: "release/qc",
    pr_from: after,
    command: TEST_COMMAND,
  },
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
              "{ summary, acceptance_criteria: string[], changes: [{ repo, files: string[], description }], non_goals: string[], tests: string[], risks: string[], rollback: string, alternatives: string[] }",
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
        qcMerge("pr"),
        cleanup("qc_merge"),
      ],
    },
  },
  {
    key: "incident-investigation",
    spec: {
      name: "Incident Investigation (evidence-driven)",
      description:
        "Read-only: collect and correlate evidence (CodeAct when several lookups combine) → code and knowledge correlation → root-cause assessment → deterministic verification and report. Changes nothing.",
      inputs: {
        request: {
          description: "what to investigate (symptom, identifiers, time window, question)",
          required: true,
        },
      },
      steps: [
        {
          key: "discover",
          type: "integration",
          name: "Repository Discovery",
          config: { ...DISCOVER, optional: true },
        },
        {
          key: "investigate",
          type: "agent",
          name: "Collect, Correlate & Diagnose",
          depends_on: ["discover"],
          max_attempts: 2,
          config: INCIDENT_INVESTIGATE,
        },
        {
          key: "report",
          type: "integration",
          name: "Verify & Report",
          depends_on: ["investigate"],
          // What the investigation must establish with platform-verified evidence (an outage leaves it incomplete).
          config: {
            action: "evidence_report",
            from: "investigate",
            objectives: { required_sources: ["trace", "log", "code"], require_root_cause: true },
          },
        },
        {
          key: "proof",
          type: "integration",
          name: "Proof of Diagnosis",
          depends_on: ["report"],
          // Read-only: records the diagnosis verdict (no fix), never blocks the report.
          config: {
            action: "proof_of_fix",
            root_cause_from: "investigate",
            report_from: "report",
            block_on: [],
          },
        },
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
          key: "impact",
          type: "integration",
          name: "Cross-Repository Impact",
          depends_on: ["implement"],
          // Read-only: dependencies and breaking changes in other repositories, for the reviewer and the PR.
          config: { action: "impact_analysis" },
        },
        {
          key: "review",
          type: "agent",
          name: "Code Review",
          depends_on: ["regression_test", "impact"],
          config: BUG_REVIEW,
        },
        {
          key: "proof",
          type: "integration",
          name: "Proof of Fix",
          depends_on: ["review"],
          // Deterministic verdict from the recorded evidence; FAILED blocks the PR (agent/proofOfFix.ts).
          config: {
            action: "proof_of_fix",
            root_cause_from: "root_cause",
            implement_from: "implement",
            test_from: "regression_test",
            review_from: "review",
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["proof"],
          config: { mode: "approval", content_from: "implement" },
        },
        qcMerge("pr"),
        cleanup("qc_merge"),
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
        qcMerge("fix_pr"),
        cleanup("qc_merge"),
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
        qcMerge("pr"),
        cleanup("qc_merge"),
      ],
    },
  },
  {
    key: "codebase-assessment",
    spec: {
      name: "Codebase Assessment",
      description:
        "Read-only: an agent assesses the repository and lists evidence-backed findings with their severity; a person picks the ones to fix (codebase-improvement)",
      execution_mode: "read_only",
      inputs: {
        repositories: { description: "repositories to assess", required: true },
        focus: { description: "area or signal to start from (optional)", required: false },
      },
      steps: [
        {
          key: "select",
          type: "integration",
          name: "Select Repository",
          config: { action: "select_repositories" },
        },
        {
          key: "assess",
          type: "agent",
          name: "Repository Assessment",
          depends_on: ["select"],
          config: IMPROVE_SCAN,
        },
        {
          key: "report",
          type: "integration",
          name: "Assessment Report",
          depends_on: ["assess"],
          config: { action: "publish_report", from: ["assess"], title: "Codebase assessment" },
        },
      ],
    },
  },
  {
    key: "codebase-improvement",
    spec: {
      name: "Codebase Improvement",
      description:
        "Repository assessment → (no changes needed, or) blast radius → proposal → approval → fix with a regression test → regression tests → impact → independent review → proof → PR",
      feedback_step: "implement",
      replan_step: "assess",
      inputs: {
        repositories: { description: "repositories to assess", required: true },
        focus: { description: "area or signal to start from (optional)", required: false },
      },
      steps: [
        {
          key: "select",
          type: "integration",
          name: "Select Repository",
          config: { action: "select_repositories" },
        },
        {
          key: "assess",
          type: "agent",
          name: "Repository Assessment",
          depends_on: ["select"],
          config: IMPROVE_ASSESS,
        },
        {
          key: "report",
          type: "integration",
          name: "Assessment Report",
          depends_on: ["assess"],
          config: { action: "publish_report", from: ["assess"], title: "Codebase assessment" },
        },
        {
          key: "blast_radius",
          type: "integration",
          name: "Blast Radius",
          depends_on: ["assess"],
          run_if: IMPROVE_WHEN,
          config: { action: "impact_analysis", from: "assess" },
        },
        {
          key: "proposal",
          type: "agent",
          name: "Improvement Proposal",
          depends_on: ["blast_radius"],
          run_if: IMPROVE_WHEN,
          config: IMPROVE_PROPOSAL,
        },
        {
          key: "approve",
          type: "human_approval",
          name: "Approve Improvement",
          depends_on: ["proposal"],
          run_if: IMPROVE_WHEN,
          config: {
            show_outputs: ["assess", "blast_radius", "proposal"],
            approve_scope_from: "proposal",
            on_reject: { reexecute: "proposal" },
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["approve"],
          run_if: IMPROVE_WHEN,
          config: IMPROVE_IMPLEMENT,
          max_attempts: 2,
        },
        {
          key: "regression_test",
          type: "command",
          name: "Regression Testing",
          depends_on: ["implement"],
          run_if: IMPROVE_WHEN,
          config: {
            command: TEST_COMMAND,
            timeout_seconds: 1800,
            baseline_compare: "go",
            on_failure: "ask",
          },
        },
        {
          key: "impact",
          type: "integration",
          name: "Cross-Repository Impact",
          depends_on: ["implement"],
          run_if: IMPROVE_WHEN,
          config: { action: "impact_analysis" },
        },
        {
          key: "review",
          type: "agent",
          name: "Independent Review",
          depends_on: ["regression_test", "impact"],
          run_if: IMPROVE_WHEN,
          config: IMPROVE_REVIEW,
        },
        {
          key: "proof",
          type: "integration",
          name: "Proof of Improvement",
          depends_on: ["review"],
          run_if: IMPROVE_WHEN,
          // Only a platform-verified improvement may be published: missing proof is unverified, not a pass.
          config: {
            action: "proof_of_fix",
            root_cause_from: "assess",
            implement_from: "implement",
            test_from: "regression_test",
            review_from: "review",
            block_on: ["FAILED", "INCONCLUSIVE", "PARTIAL"],
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["proof"],
          run_if: IMPROVE_WHEN,
          config: { mode: "approval", content_from: "implement" },
        },
        cleanup("pr", "report"),
      ],
    },
  },
  { key: "production-incident-investigation", spec: PRODUCTION_INVESTIGATION },
  { key: "production-bug-hunt", spec: PRODUCTION_BUG_HUNT },
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
        // No repository confirmation: a self-development run always targets this platform's one repository,
        // selected when the run starts.
        {
          key: "plan",
          type: "agent",
          name: "Architecture Review & Plan",
          depends_on: ["discover"],
          config: {
            instructions:
              "Design the change for the selected repository. Name the modules and dependencies affected, the test strategy " +
              "(targeted checks first, full npm test before the pull request), and rollout risks. Do not plan a restart, deploy, " +
              "merge, or migration of the running application's database. Reference concrete files (path:line).",
            output_contract:
              "{ summary, acceptance_criteria: string[], changes: [{ repo, files: string[], description }], non_goals: string[], tests: string[], risks: string[], rollback: string, alternatives: string[] }",
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
        // The platform's own repository has only `main`: there is no release/qc branch to merge into.
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
        qcMerge("pr"),
        cleanup("qc_merge"),
      ],
    },
  },
  {
    key: "micro-change",
    spec: {
      name: "Bounded Local Change",
      description:
        "Verified single-repository leaf changes; MICRO combines local phases while retaining verification and PR approval.",
      steps: [
        {
          key: "analyze",
          type: "agent",
          name: "Local Analysis",
          config: {
            instructions:
              "Inspect the hinted symbols, requirements, risk and direct dependencies. Stay within the confirmed repository and file scope.",
          },
        },
        {
          key: "plan",
          type: "agent",
          name: "Local Plan",
          depends_on: ["analyze"],
          config: {
            instructions:
              "State the smallest correct change and its targeted verification. Escalate uncertain impact before editing.",
          },
        },
        {
          key: "implement",
          type: "coding_agent",
          name: "Implementation",
          depends_on: ["plan"],
          config: {
            ...IMPLEMENT,
            verify: {
              command: FEATURE_MICRO_TARGETED_COMMAND,
              broad_command: FEATURE_REGRESSION_COMMAND,
              timeout_seconds: 900,
            },
          },
        },
        {
          key: "self_review",
          type: "agent",
          name: "Self-review",
          depends_on: ["implement"],
          config: {
            independent: false,
            instructions:
              "Review the diff against the requirements, scope and risk; verify test evidence and report limitations.",
          },
        },
        {
          key: "approve_diff",
          type: "human_approval",
          name: "Approve Diff",
          depends_on: ["self_review"],
          config: {
            message: "Review the diff and verification evidence before publishing.",
            show_outputs: ["implement"],
          },
        },
        {
          key: "pr",
          type: "git_pull_request",
          name: "Pull Request",
          depends_on: ["approve_diff"],
          config: { mode: "approval", content_from: "implement" },
        },
        qcMerge("pr"),
        cleanup("qc_merge"),
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
