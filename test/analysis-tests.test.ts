import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGoSource, inspectGoTests } from "../src/agent/testSafety.ts";
import {
  runAnalysisTests,
  type IsolatedResult,
  type IsolatedRunner,
} from "../src/agent/analysisTests.ts";
import { decide, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { runIsolatedCommand } from "../src/workflow/executors/builtin.ts";
import { bwrapAvailable } from "../src/platform/selfDevelopment.ts";

const AWS_EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE";
const never = new AbortController().signal;
const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const stub = (r: Partial<IsolatedResult> = {}) => {
  const calls: string[] = [];
  const fn: IsolatedRunner = async (command) => {
    calls.push(command);
    return { code: 0, output: "ok  \texample/safe\t0.2s\n", timedOut: false, ...r };
  };
  return Object.assign(fn, { calls });
};

test("classification: hardcoded credentials, external endpoints and cloud SDKs are signals; their values are never reported", () => {
  const found = classifyGoSource(
    [
      "package x",
      "import (",
      '\t"github.com/aws/aws-sdk-go/service/sns"',
      '\t"github.com/aws/aws-sdk-go/service/s3/s3iface"',
      ")",
      `const key = "${AWS_EXAMPLE_KEY}"`,
      'var apiKey = "d41d8cd98f00b204e9800998ecf8427e"',
      'var url = "https://rest.esms.vn/MainService.svc/json/SendMultipleMessage"',
      'var ok = "http://127.0.0.1:8080/x"',
      'var fixture = "https://example.com/a"',
      'var password = "test-password-123"',
      '// const commented = "AKIAIOSFODNN7EXAMPLE"',
    ].join("\n"),
  );
  assert.deepEqual(
    found.map((f) => [f.line, f.kind]),
    [
      [3, "cloud_sdk"],
      [6, "hardcoded_credential"],
      [7, "hardcoded_credential"],
      [8, "external_endpoint"],
    ],
  );
  const text = JSON.stringify(found);
  assert.ok(
    !text.includes(AWS_EXAMPLE_KEY) && !text.includes("d41d8cd9") && !text.includes("esms"),
  );
});

test("classification: a testing.Short() guard does not make a package safe", () => {
  const found = classifyGoSource(
    'func TestSend(t *testing.T) {\n\tif testing.Short() {\n\t\tt.Skip()\n\t}\n\thttp.Post("https://api.twilio.com/send", "", nil)\n}',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "external_endpoint");
});

test("inspection: packages are listed per module; unsafe ones carry file, line and kind; vendor and testdata are ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspect-"));
  try {
    write(root, "go.mod", "module example.com/m\n\ngo 1.21\n");
    write(root, "safe/a_test.go", "package safe\n");
    write(root, "leaky/a_test.go", `package leaky\nconst k = "${AWS_EXAMPLE_KEY}"\n`);
    write(root, "vendor/x/y_test.go", `package y\nconst k = "${AWS_EXAMPLE_KEY}"\n`);
    write(root, "testdata/z_test.go", "package z\n");
    write(root, "tools/go.mod", "module example.com/tools\n\ngo 1.21\n");
    write(root, "tools/t_test.go", "package tools\n");
    const r = await inspectGoTests(root);
    assert.deepEqual(
      r.modules.map((m) => [m.dir, m.packages]),
      [
        [".", ["leaky", "safe"]],
        ["tools", ["."]],
      ],
    );
    assert.deepEqual(r.modules[0].unsafe, [
      {
        package: "leaky",
        findings: [{ file: "leaky/a_test.go", line: 2, kind: "hardcoded_credential" }],
      },
    ]);
    assert.equal(r.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const analysis = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
  mode: "analysis",
  workspaces: [],
  baseBranch: "main",
  protectedRoots: [],
  ...extra,
});
const bash = (command: string, ctx = analysis()) => decide("Bash", { command }, ctx, "/repo");

test("policy: a read-only step cannot run go test itself, however it is spelled", () => {
  for (const command of [
    "go test ./...",
    "go test -short ./...",
    "cd /repo && go test ./pkg",
    "go -C /repo test ./...",
    "GOFLAGS=-mod=mod timeout 60 go test ./...",
    "(go test ./... | tail -5)",
    "echo $(go test ./...)",
  ]) {
    const d = bash(command);
    assert.equal(d.allow, false, command);
    assert.match(d.allow ? "" : d.reason, /run_tests/, command);
  }
  for (const command of [
    "go vet -vettool=/tmp/evil ./...",
    "golangci-lint run -exec /tmp/x",
    "go list -toolexec /tmp/x ./...",
  ])
    assert.equal(bash(command).allow, false, command);
});

test("policy: legitimate read-only analysis stays allowed, including a scratch log in /tmp", () => {
  for (const command of [
    "go vet ./...",
    "go list ./...",
    'echo "run go test later" | wc -c',
    "grep -rn 'go test' README.md",
    "git log --oneline | head -5",
    "go vet ./... 2>&1 > /tmp/vet.log",
    "staticcheck ./... > /tmp/static-1.log",
  ])
    assert.equal(bash(command).allow, true, command);
  assert.equal(
    bash("go test ./...", analysis({ mode: "coding", workspaces: ["/repo"] })).allow,
    true,
  );
});

test("policy: only a plain file directly in /tmp is an allowed redirect target", () => {
  for (const command of [
    "go vet ./... > /tmp/sub/vet.log",
    "go vet ./... > /tmp/../repo/vet.log",
    "go vet ./... > /tmp/..",
    "go vet ./... > /repo/vet.log",
    "go vet ./... > ~/vet.log",
    "go vet ./... > /tmp/$X.log",
  ])
    assert.equal(bash(command).allow, false, command);
});

test("run_tests: tests run only after inspection, unsafe packages are skipped and reported, nothing is called safe when partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "analysis-"));
  try {
    write(root, "go.mod", "module example.com/m\n\ngo 1.21\n");
    write(root, "safe/a_test.go", "package safe\n");
    write(root, "leaky/a_test.go", `package leaky\nconst k = "${AWS_EXAMPLE_KEY}"\n`);
    const runner = stub();
    const r = await runAnalysisTests({
      repository: "svc",
      path: root,
      timeoutMs: 1000,
      signal: never,
      sandboxAvailable: true,
      runner,
    });
    assert.equal(runner.calls.length, 1);
    assert.ok(runner.calls[0].includes("'./safe'") && !runner.calls[0].includes("leaky"));
    assert.ok(!runner.calls[0].includes("-short"));
    assert.equal(r.report.status, "incomplete");
    assert.deepEqual(
      r.report.unsafe_packages.map((u) => [u.package, u.findings[0].kind]),
      [["leaky", "hardcoded_credential"]],
    );
    assert.match(r.report.incomplete.join("\n"), /1 package\(s\) in module \. were NOT run/);
    assert.match(r.report.incomplete.join("\n"), /-short. is not a safeguard/);
    assert.ok(!JSON.stringify(r.report).includes(AWS_EXAMPLE_KEY));

    const onlyUnsafe = await runAnalysisTests({
      repository: "svc",
      path: root,
      packages: ["leaky", "missing/..."],
      timeoutMs: 1000,
      signal: never,
      sandboxAvailable: true,
      runner,
    });
    assert.equal(
      runner.calls.length,
      1,
      "an unsafe package is never run, even when asked for by name",
    );
    assert.equal(onlyUnsafe.report.status, "skipped");
    assert.match(
      onlyUnsafe.report.incomplete.join("\n"),
      /no test package matches "missing\/\.\.\."/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_tests: without the sandbox nothing runs; the report says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "analysis-"));
  try {
    write(root, "go.mod", "module example.com/m\n");
    write(root, "a/a_test.go", "package a\n");
    const runner = stub();
    const r = await runAnalysisTests({
      repository: "svc",
      path: root,
      timeoutMs: 1000,
      signal: never,
      sandboxAvailable: false,
      runner,
    });
    assert.equal(runner.calls.length, 0);
    assert.equal(r.report.status, "skipped");
    assert.match(r.report.incomplete[0], /never run unsandboxed/);
    const noGo = await runAnalysisTests({
      repository: "docs",
      path: mkdtempSync(join(tmpdir(), "analysis-empty-")),
      timeoutMs: 1000,
      signal: never,
      sandboxAvailable: true,
      runner,
    });
    assert.equal(noGo.report.status, "skipped");
    assert.match(noGo.report.incomplete[0], /not test-verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_tests: exact exit codes, timeouts and unconfirmed runs are reported; the agent receives a bounded excerpt, the artifact the full log", async () => {
  const root = mkdtempSync(join(tmpdir(), "analysis-"));
  try {
    write(root, "go.mod", "module example.com/m\n");
    write(root, "a/a_test.go", "package a\n");
    const run = (r: Partial<IsolatedResult>) =>
      runAnalysisTests({
        repository: "svc",
        path: root,
        timeoutMs: 1000,
        signal: never,
        sandboxAvailable: true,
        runner: stub(r),
      });
    const flood = "line of noise\n".repeat(60000);
    const failed = await run({
      code: 7,
      output: `${flood}--- FAIL: TestX (0.00s)\n    x_test.go:12: got 1 want 2\nAuthorization: Bearer abcdef0123456789abcdef0123\nFAIL\n`,
    });
    assert.equal(failed.report.status, "failed");
    assert.equal(failed.report.exit_code, 7);
    assert.equal(failed.report.modules[0].exit_code, 7);
    assert.ok(JSON.stringify(failed.report).length < 8000);
    assert.match(failed.report.modules[0].excerpt, /got 1 want 2/);
    assert.ok(failed.logs[0].log.includes("exit 7") && failed.logs[0].log.length > 500000);
    assert.ok(!failed.logs[0].log.includes("abcdef0123456789abcdef0123"));

    const timedOut = await run({ code: null, timedOut: true, output: "" });
    assert.equal(timedOut.report.status, "incomplete");
    assert.equal(timedOut.report.exit_code, null);
    assert.match(timedOut.report.incomplete.join(), /timed out/);

    const unconfirmed = await run({ code: 0, output: "?   \texample/a\t[no test files]\n" });
    assert.equal(unconfirmed.report.status, "incomplete");
    assert.equal(unconfirmed.report.exit_code, 0);
    assert.match(unconfirmed.report.incomplete.join(), /no executed test could be confirmed/);

    const passed = await run({});
    assert.equal(passed.report.status, "passed");
    assert.deepEqual(passed.report.incomplete, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_tests: pattern and filter injection is refused before anything runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "analysis-"));
  try {
    write(root, "go.mod", "module example.com/m\n");
    write(root, "a/a_test.go", "package a\n");
    const runner = stub();
    for (const extra of [
      { packages: ["-exec=/tmp/x"] },
      { packages: ["a; curl x"] },
      { packages: ["../outside"] },
      { run: "x'; touch /tmp/pwned; '" },
    ]) {
      const r = await runAnalysisTests({
        repository: "svc",
        path: root,
        timeoutMs: 1000,
        signal: never,
        sandboxAvailable: true,
        runner,
        ...extra,
      });
      assert.equal(r.report.status, "skipped", JSON.stringify(extra));
    }
    assert.equal(runner.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

let listener: Server;
let accepted = 0;
let port = 0;
const home = mkdtempSync(join(tmpdir(), "analysis-home-"));
const savedHome = process.env.HOME;
before(async () => {
  listener = createServer((s) => {
    accepted++;
    s.destroy();
  });
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  port = (listener.address() as { port: number }).port;
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(
    join(home, ".aws", "credentials"),
    "[default]\naws_secret_access_key=not-a-real-secret\n",
  );
  process.env.HOME = home;
  process.env.ORBIT_FAKE_API_KEY = "must-not-reach-the-test-process";
});
after(async () => {
  process.env.HOME = savedHome;
  delete process.env.ORBIT_FAKE_API_KEY;
  rmSync(home, { recursive: true, force: true });
  await new Promise<void>((r) => listener.close(() => r()));
});

test("sandbox: unsafe subprocess side effects are blocked while legitimate tests run with their real exit codes", async (t) => {
  if (!hasGo || !(await bwrapAvailable())) return t.skip("needs go and bubblewrap");
  const root = mkdtempSync(join(tmpdir(), "analysis-sandbox-"));
  try {
    write(root, "go.mod", "module example.com/m\n\ngo 1.21\n");
    write(
      root,
      "safe/safe_test.go",
      'package safe\nimport "testing"\nfunc TestAdds(t *testing.T) { if 1+1 != 2 { t.Fatal("math") } }\n',
    );
    write(
      root,
      "failing/failing_test.go",
      'package failing\nimport "testing"\nfunc TestFails(t *testing.T) { t.Fatal("expected failure") }\n',
    );
    write(
      root,
      "boundary/boundary_test.go",
      `package boundary
import ("net"; "os"; "path/filepath"; "testing"; "time")
func TestHostLoopbackIsUnreachable(t *testing.T) {
	c, err := net.DialTimeout("tcp", "127.0.0.1:${port}", 2*time.Second)
	if err == nil { c.Close(); t.Fatal("reached a listener on the host network") }
}
func TestRepositoryIsReadOnly(t *testing.T) {
	if err := os.WriteFile("written.txt", []byte("x"), 0o644); err == nil { t.Fatal("wrote into the repository") }
}
func TestCredentialsAreHidden(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(os.Getenv("HOME"), ".aws", "credentials"))
	if err == nil && len(b) > 0 { t.Fatal("read a credentials file") }
}
func TestWorkerSecretsAreNotInherited(t *testing.T) {
	if os.Getenv("ORBIT_FAKE_API_KEY") != "" { t.Fatal("secret environment variable reached the test") }
}
`,
    );
    write(
      root,
      "leaky/leaky_test.go",
      `package leaky\nimport "testing"\nconst k = "${AWS_EXAMPLE_KEY}"\nfunc TestMustNeverRun(t *testing.T) { t.Fatal("unsafe package executed") }\n`,
    );
    write(root, "tools/go.mod", "module example.com/tools\n\ngo 1.21\n");
    write(
      root,
      "tools/t_test.go",
      'package tools\nimport "testing"\nfunc TestTools(t *testing.T) {}\n',
    );

    const before = accepted;
    const base = {
      repository: "svc",
      path: root,
      timeoutMs: 120_000,
      signal: never,
      sandboxAvailable: true,
      runner: runIsolatedCommand as IsolatedRunner,
    };
    const boundary = await runAnalysisTests({ ...base, packages: ["boundary", "safe", "tools"] });
    assert.equal(
      boundary.report.status,
      "passed",
      JSON.stringify(boundary.report) + boundary.logs.map((l) => l.log).join(),
    );
    assert.deepEqual(
      boundary.report.modules.map((m) => [m.module, m.exit_code]),
      [
        [".", 0],
        ["tools", 0],
      ],
    );
    assert.equal(accepted, before, "the test process reached a listener on the host network");
    assert.ok(!existsSync(join(root, "boundary", "written.txt")));
    assert.ok(!readdirSync(join(root, "boundary")).includes("written.txt"));

    const all = await runAnalysisTests(base);
    assert.equal(all.report.status, "failed");
    assert.equal(all.report.exit_code, 1, "go test's own exit code is preserved");
    assert.deepEqual(
      all.report.unsafe_packages.map((u) => u.package),
      ["leaky"],
    );
    const output = all.logs.map((l) => l.log).join("\n");
    assert.match(output, /expected failure/);
    assert.doesNotMatch(output, /unsafe package executed/);
    assert.match(all.report.incomplete.join(), /were NOT run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
