/**
 * Built-in workflow templates. Seeded on startup as normal versioned definitions (is_template = true):
 * editing one publishes a new version; running runs stay pinned to the version they started with.
 */

// Tests only the Go packages touched on the branch (oms-api has a known red baseline elsewhere), npm otherwise.
const TEST_COMMAND = `set -e
if [ -f go.mod ]; then
  pkgs=$(git diff --name-only "origin/$BASE_BRANCH...HEAD" -- '*.go' | xargs -r -n1 dirname | sort -u | sed 's|^|./|')
  echo "== go build ./..."
  go build ./...
  # -short lets integration tests that honour testing.Short() skip; the timeout bounds tests that hang on remote DB/ES.
  # GO_TEST_SKIP (set by the platform): tests already known to fail on the same base commit — not re-run.
  if [ -n "$pkgs" ]; then echo "== go test -short -timeout 5m \${GO_TEST_SKIP:+-skip $GO_TEST_SKIP} $pkgs"; go test -short -timeout 5m \${GO_TEST_SKIP:+-skip "$GO_TEST_SKIP"} $pkgs; else echo "no Go packages changed"; fi
elif [ -f package.json ]; then
  npm test --if-present
else
  echo "no test runner detected"
fi`;

const ANALYZE = {
  instructions:
    "Analyse the engineering request. Restate the goal, list functional requirements, acceptance criteria, " +
    "affected business areas, unknowns and risks. Read code only to understand terminology; do not design the change yet. " +
    "If business behaviour is ambiguous and cannot be settled from the code, ask the developer.",
  output_contract: "{ goal, requirements: string[], acceptance_criteria: string[], keywords: string[], unknowns: string[], risks: string[] }",
};

const DISCOVER = { action: "repository_discovery", use_ai: true, max_candidates: 5 };
const CONFIRM_REPOS = {
  message: "Xác nhận repo sẽ được sửa cho lần chạy này.",
  select_repositories: true,
  show_outputs: ["discover"],
};

const IMPLEMENT = {
  instructions:
    "Implement the approved plan. Call prepare_branch for each repository before editing and edit ONLY inside the returned " +
    "worktree paths. Make the smallest correct change, run the relevant build/tests, commit with the platform commit convention. " +
    "Do not push: a later workflow step opens the pull request. Finish by calling submit_result with " +
    "{ summary, pull_requests: { <repo>: { title, summary, decisions: [{title, detail}] } }, verification }.",
  output_contract: "{ summary, pull_requests: { [repo]: { title, summary, decisions } }, verification }",
};

const REVIEW = {
  instructions:
    "Review the diff of every workspace branch against origin/$BASE_BRANCH (git diff, read-only). Check correctness, the " +
    "approved plan, coding standards and security policies in your context. Report findings; do not modify code.",
  output_contract: "{ approved: boolean, findings: [{ severity: 'high'|'medium'|'low', file, line, issue, suggestion }], summary }",
  workspace_read: true,
};

export const TEMPLATES: Array<{ key: string; spec: Record<string, unknown> }> = [
  {
    key: "work-item-analysis",
    spec: {
      name: "Work Item Analysis",
      description: "Read-only: analyse the request and recommend repositories. Changes nothing.",
      steps: [
        { key: "analyze", type: "agent", name: "Requirement Analysis", config: ANALYZE },
        { key: "discover", type: "integration", name: "Repository Discovery", depends_on: ["analyze"], config: DISCOVER },
      ],
    },
  },
  {
    key: "feature-implementation",
    spec: {
      name: "Feature Implementation",
      description: "Requirement analysis → repository discovery → architecture plan → approval → implementation → tests → review → PR",
      feedback_step: "implement",
      steps: [
        { key: "analyze", type: "agent", name: "Requirement Analysis", config: ANALYZE },
        { key: "discover", type: "integration", name: "Repository Discovery", depends_on: ["analyze"], config: DISCOVER },
        { key: "confirm_repos", type: "human_approval", name: "Confirm Repositories", depends_on: ["discover"], config: CONFIRM_REPOS },
        {
          key: "plan",
          type: "agent",
          name: "Architecture Review & Plan",
          depends_on: ["confirm_repos"],
          config: {
            instructions:
              "Design the change for the confirmed repositories: components touched, data/contract changes, migration needs, " +
              "test strategy, rollout risks, alternatives rejected. Reference concrete files (path:line).",
            output_contract: "{ summary, changes: [{ repo, files: string[], description }], tests: string[], risks: string[], alternatives: string[] }",
          },
        },
        {
          key: "approve_plan",
          type: "human_approval",
          name: "Approve Plan",
          depends_on: ["plan"],
          config: { message: "Duyệt kế hoạch kiến trúc trước khi code.", show_outputs: ["plan"], on_reject: { reexecute: "plan" } },
        },
        { key: "implement", type: "coding_agent", name: "Implementation", depends_on: ["approve_plan"], config: IMPLEMENT, max_attempts: 2 },
        { key: "test", type: "command", name: "Testing", depends_on: ["implement"], config: { command: TEST_COMMAND, timeout_seconds: 1800, baseline_compare: "go", on_failure: "ask" } },
        { key: "review", type: "agent", name: "Code Review", depends_on: ["test"], config: REVIEW },
        { key: "pr", type: "git_pull_request", name: "Pull Request", depends_on: ["review"], config: { mode: "approval", content_from: "implement" } },
      ],
    },
  },
  {
    key: "bug-investigation",
    spec: {
      name: "Bug Investigation",
      description: "Problem analysis → repository discovery → root cause → fix proposal → approval → fix → regression tests → PR",
      feedback_step: "implement",
      steps: [
        {
          key: "analyze",
          type: "agent",
          name: "Problem Analysis",
          config: {
            instructions:
              "Analyse the reported problem: symptoms, expected vs actual behaviour, reproduction hints, affected flows. " +
              "Read attachments (screenshots often hold the actual error).",
            output_contract: "{ symptoms, expected, actual, keywords: string[], reproduction: string[], unknowns: string[] }",
          },
        },
        { key: "discover", type: "integration", name: "Repository Discovery", depends_on: ["analyze"], config: DISCOVER },
        { key: "confirm_repos", type: "human_approval", name: "Confirm Repositories", depends_on: ["discover"], config: { ...CONFIRM_REPOS, auto_approve_unambiguous: true } },
        {
          key: "root_cause",
          type: "agent",
          name: "Root Cause Investigation",
          depends_on: ["confirm_repos"],
          config: {
            instructions: "Find the root cause with evidence (file:line, logs, data flow). List competing hypotheses and how each was confirmed or ruled out.",
            output_contract: "{ root_cause, evidence: string[], hypotheses: [{ hypothesis, verdict, evidence }] }",
          },
        },
        {
          key: "fix_proposal",
          type: "agent",
          name: "Fix Proposal",
          depends_on: ["root_cause"],
          config: {
            instructions: "Propose the smallest correct fix and a regression test. State risks and what cannot be verified locally.",
            output_contract: "{ summary, changes: [{ repo, files, description }], regression_tests: string[], risks: string[] }",
          },
        },
        {
          key: "approve_fix",
          type: "human_approval",
          name: "Approve Fix",
          depends_on: ["fix_proposal"],
          config: { show_outputs: ["root_cause", "fix_proposal"], on_reject: { reexecute: "fix_proposal" } },
        },
        { key: "implement", type: "coding_agent", name: "Implementation", depends_on: ["approve_fix"], config: IMPLEMENT, max_attempts: 2 },
        { key: "regression_test", type: "command", name: "Regression Testing", depends_on: ["implement"], config: { command: TEST_COMMAND, timeout_seconds: 1800, baseline_compare: "go", on_failure: "ask" } },
        { key: "pr", type: "git_pull_request", name: "Pull Request", depends_on: ["regression_test"], config: { mode: "approval", content_from: "implement" } },
      ],
    },
  },
  {
    key: "code-review",
    spec: {
      name: "Code Review",
      description: "Repository / branch selection → code analysis → architecture validation → security review → review report (no PR)",
      inputs: {
        repositories: { description: "repositories to review", required: true },
        branch: { description: "branch to review against the base branch (empty = review the base branch itself)", required: false },
        focus: { description: "what to focus on", required: false },
      },
      steps: [
        { key: "select", type: "integration", name: "Repository / PR Selection", config: { action: "select_repositories" } },
        {
          key: "analyze",
          type: "agent",
          name: "Code Analysis",
          depends_on: ["select"],
          config: {
            instructions:
              "Review the selected repositories (read-only). If inputs.branch is set, review `git diff origin/$BASE_BRANCH...origin/<branch>`; " +
              "otherwise review the areas named in inputs.focus. Report correctness and maintainability issues.",
            output_contract: "{ findings: [{ severity, repo, file, line, issue, suggestion }], summary }",
          },
        },
        {
          key: "architecture",
          type: "agent",
          name: "Architecture Validation",
          depends_on: ["analyze"],
          config: {
            instructions: "Validate the reviewed code against the architecture guidelines and repository conventions in your context.",
            output_contract: "{ violations: [{ guideline, repo, file, detail }], summary }",
          },
        },
        {
          key: "security",
          type: "agent",
          name: "Security Review",
          depends_on: ["analyze"],
          config: {
            instructions: "Review the same code for security issues: injection, authz gaps, secrets, PII handling, unsafe deserialisation.",
            output_contract: "{ findings: [{ severity, repo, file, line, issue, suggestion }], summary }",
            skills: ["security-review"],
          },
        },
        {
          key: "report",
          type: "integration",
          name: "Review Report",
          depends_on: ["architecture", "security"],
          config: { action: "publish_report", from: ["analyze", "architecture", "security"], title: "Code review report" },
        },
      ],
    },
  },
  {
    key: "refactoring",
    spec: {
      name: "Refactoring",
      description: "Select repository → analyse code → refactoring plan → human approval → refactor → regression tests → PR",
      feedback_step: "refactor",
      inputs: { repositories: { description: "repository to refactor", required: true }, goal: { description: "refactoring goal", required: true } },
      steps: [
        { key: "select", type: "integration", name: "Select Repository", config: { action: "select_repositories" } },
        {
          key: "analyze",
          type: "agent",
          name: "Analyze Code",
          depends_on: ["select"],
          config: {
            instructions: "Analyse the code relevant to inputs.goal: structure, coupling, test coverage, risky areas.",
            output_contract: "{ summary, hotspots: [{ file, issue }], test_coverage, risks }",
          },
        },
        {
          key: "plan",
          type: "agent",
          name: "Refactoring Plan",
          depends_on: ["analyze"],
          config: {
            instructions: "Produce a behaviour-preserving refactoring plan in small verifiable steps, with the tests that prove behaviour is unchanged.",
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
        { key: "refactor", type: "coding_agent", name: "Refactor", depends_on: ["approval"], config: IMPLEMENT, max_attempts: 2 },
        { key: "regression_test", type: "command", name: "Regression Testing", depends_on: ["refactor"], config: { command: TEST_COMMAND, timeout_seconds: 1800, baseline_compare: "go", on_failure: "ask" } },
        { key: "pr", type: "git_pull_request", name: "Pull Request", depends_on: ["regression_test"], config: { mode: "approval", content_from: "refactor" } },
      ],
    },
  },
];
