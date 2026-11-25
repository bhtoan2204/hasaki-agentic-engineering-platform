/**
 * Process supervision (ADR 0005) through the TypeScript adapter, on both engines: the same commands must behave the
 * same for providers (streams, stdin, exit codes, signals) and be cleaned up completely; the Go engine adds the
 * delegated cgroup, limits and host-wide admission. Linux only. A missing Go toolchain fails this file
 * (PLATFORM_ALLOW_MISSING_GO=1 skips it explicitly outside CI).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { goToolchain, requireGoToolchain } from "./fixtures/platformGo.ts";
import { config as appConfig } from "../src/config.ts";

if (!goToolchain()) {
  requireGoToolchain("process supervision engines");
} else {
  const { config } = await import("../src/config.ts");
  const sup = await import("../src/agent/process/supervisor.ts");
  const { bwrapArguments } = await import("../src/platform/selfDevelopment.ts");
  const engines = ["typescript", "go"] as const;
  const root = process.env.TEST_ROOT!;

  before(() => {
    const out = join(root, "supervise-bin");
    const r = spawnSync("go", ["build", "-o", `${out}/`, "./cmd/platform-supervise"], {
      cwd: resolve(import.meta.dirname, "../go"),
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("platform-supervise build failed");
    appConfig.binaries.superviseBin = join(out, "platform-supervise");
  });

  const withEngine = async <T>(engine: (typeof engines)[number], fn: () => Promise<T>) => {
    const old = config.supervision.engine;
    config.supervision.engine = engine;
    try {
      return await fn();
    } finally {
      config.supervision.engine = old;
    }
  };
  const run = (
    command: string,
    args: string[],
    extra: Partial<Parameters<typeof sup.superviseSpawn>[0]> = {},
  ) =>
    sup.superviseSpawn({
      command,
      args,
      cwd: root,
      env: { PATH: appConfig.system.path },
      class: "agent",
      graceMs: 0,
      ...extra,
    });
  const collect = (p: ReturnType<typeof run>) => {
    let out = "";
    let err = "";
    p.child.stdout.on("data", (b: Buffer) => (out += b));
    p.child.stderr.on("data", (b: Buffer) => (err += b));
    return async () => ({ report: await p.done, out, err });
  };
  const alive = (marker: string) =>
    readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .filter((d) => {
        try {
          const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8");
          return cmd.includes("python3\0-c\0import time") && cmd.includes(marker); // the sleeper only
        } catch {
          return false;
        }
      });
  const sleeper = (m: string) => `python3 -c "import time; time.sleep(300)" ${m}`;

  for (const engine of engines)
    test(`${engine}: a JSONL protocol over stdin/stdout, exit codes and signals are the command's own`, () =>
      withEngine(engine, async () => {
        const echo = `process.stdin.setEncoding("utf8"); let b="";
          process.stdin.on("data", d => { b += d; let i; while ((i = b.indexOf("\\n")) >= 0) {
            const l = b.slice(0, i); b = b.slice(i + 1); process.stdout.write(JSON.stringify({ echo: JSON.parse(l) }) + "\\n"); } });
          process.stdin.on("end", () => { process.stderr.write("bye\\n"); process.exit(3); });`;
        const p = run(process.execPath, ["-e", echo]);
        const done = collect(p);
        p.child.stdin!.write('{"a":1}\n');
        p.child.stdin!.write('{"b":"$HOME $$"}\n');
        p.child.stdin!.end();
        const r = await done();
        assert.deepEqual(
          r.out
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l)),
          [{ echo: { a: 1 } }, { echo: { b: "$HOME $$" } }],
        );
        assert.equal(r.err, "bye\n");
        assert.equal(r.report.exit_code, 3);
        assert.equal(r.report.engine, engine);
        const s = run("sh", ["-c", "kill -TERM $$"]);
        const sr = await collect(s)();
        assert.equal(sr.report.exit_code, null);
        assert.equal(s.child.signalCode, "SIGTERM");
        // Arguments reach the command literally (systemd-run would otherwise expand `$`).
        const lit = await collect(run("printf", ["%s|", "$HOME", "$$", "${X:-y}"]))();
        assert.equal(lit.out, "$HOME|$$|${X:-y}|");
      }));

  for (const engine of engines)
    test(`${engine}: stop() ends a SIGTERM-ignoring command and the descendants it detached`, () =>
      withEngine(engine, async () => {
        const m = `ctp-sup-${engine}-${Date.now()}`;
        const p = run(
          "bash",
          ["-c", `trap '' TERM; setsid bash -c '${sleeper(m)}' & ${sleeper(m)} & wait`],
          {
            graceMs: 300,
          },
        );
        const done = collect(p);
        for (let i = 0; i < 100 && alive(m).length < 2; i++)
          await new Promise((r) => setTimeout(r, 50));
        assert.equal(alive(m).length, 2, "both sleepers run");
        const t = Date.now();
        p.stop();
        const r = await done();
        assert.ok(Date.now() - t < 6000);
        for (let i = 0; i < 50 && alive(m).length; i++) await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(alive(m), [], "no descendant survives");
        if (engine === "go") {
          assert.equal(r.report.outcome, "canceled");
          assert.equal(r.report.survived, 0);
        }
      }));

  for (const engine of engines)
    test(`${engine}: helpers left behind by a command that exited are cleaned up`, () =>
      withEngine(engine, async () => {
        const m = `ctp-orphan-${engine}-${Date.now()}`;
        const r = await collect(
          run("bash", ["-c", `${sleeper(m)} >/dev/null 2>&1 & sleep 0.3; exit 0`]),
        )();
        assert.equal(r.report.exit_code, 0);
        for (let i = 0; i < 50 && alive(m).length; i++) await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(alive(m), []);
      }));

  test("go: the command's environment carries neither launcher nor systemd bus variables it did not have", () =>
    withEngine("go", async () => {
      appConfig.system.otelEndpoint = "http://127.0.0.1:9";
      try {
        const r = await collect(run("env", []))();
        assert.doesNotMatch(r.out, /CTP_SUPERVISE_|OTEL_|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/);
        assert.match(r.out, /^PATH=/m);
      } finally {
        appConfig.system.otelEndpoint = undefined;
      }
    }));

  test(
    "go: memory and process limits, OOM reported to the caller",
    { skip: !sup.delegatedScopeAvailable() && "no delegated cgroup" },
    () =>
      withEngine("go", async () => {
        const oom = await collect(
          run("python3", ["-c", "a = bytearray(512 * 1024 * 1024)"], { limits: { memoryMb: 64 } }),
        )();
        assert.equal(oom.report.outcome, "oom");
        assert.match(sup.supervisionNote(oom.report)!, /memory limit/);
        const pids = await collect(
          run("bash", ["-c", "for i in $(seq 100); do sleep 2 & done 2>/dev/null; wait"], {
            limits: { pids: 20 },
          }),
        )();
        assert.ok(pids.report.usage!.pids_max_events > 0);
        assert.equal(pids.report.isolation, "cgroup");
      }),
  );

  test("go: the verification sandbox keeps hiding credentials and the network inside the launcher", () =>
    withEngine("go", async () => {
      const cwd = mkdtempSync(join(root, "sandbox-"));
      const secret = join(homedir(), ".ssh");
      const masked = existsSync(secret);
      const r = await collect(
        run(
          "bwrap",
          [
            "--unshare-net",
            ...bwrapArguments(cwd, null),
            "bash",
            "-c",
            `ls -A ${secret} 2>/dev/null | wc -l; grep -c : /proc/net/dev; echo ok > ${cwd}/w`,
          ],
          { class: "verification", cwd },
        ),
      )();
      const [entries, ifaces] = r.out.trim().split("\n");
      if (masked) assert.equal(entries, "0", "~/.ssh is empty inside");
      assert.equal(ifaces, "1", "only lo in the network namespace");
      assert.equal(readFileSync(join(cwd, "w"), "utf8"), "ok\n", "the worktree stays writable");
    }));

  test("go: fails closed before anything runs (missing launcher; missing cgroup while isolation is enforced)", () =>
    withEngine("go", async () => {
      const marker = join(root, "never-ran");
      const bin = appConfig.binaries.superviseBin;
      appConfig.binaries.superviseBin = join(root, "missing-launcher");
      try {
        assert.throws(() => run("touch", [marker]), /launcher .* is missing/);
      } finally {
        appConfig.binaries.superviseBin = bin;
      }
      const path = appConfig.system.path;
      const mode = config.isolation.mode;
      appConfig.system.path = "/nonexistent";
      config.isolation.mode = "enforce";
      try {
        sup.delegatedScopeAvailable(true);
        assert.throws(() => run("/usr/bin/touch", [marker]), /delegated cgroup/);
      } finally {
        appConfig.system.path = path;
        config.isolation.mode = mode;
        sup.delegatedScopeAvailable(true);
      }
      assert.equal(existsSync(marker), false);
    }));

  test("go: host-wide admission bounds concurrent verification commands and reports the wait", () =>
    withEngine("go", async () => {
      const slots = config.supervision.slots.verification;
      config.supervision.slots.verification = 1;
      const dir = mkdtempSync(join(root, "admission-"));
      try {
        const script = `echo s $(date +%s%N) >> ${dir}/log; sleep 0.3; echo e $(date +%s%N) >> ${dir}/log`;
        const reports = await Promise.all(
          [1, 2, 3].map(() => collect(run("sh", ["-c", script], { class: "verification" }))()),
        );
        const events = readFileSync(join(dir, "log"), "utf8")
          .trim()
          .split("\n")
          .map((l) => l.split(" "))
          .sort((a, b) => Number(BigInt(a[1]) - BigInt(b[1])));
        let running = 0;
        let peak = 0;
        for (const [kind] of events) peak = Math.max(peak, (running += kind === "s" ? 1 : -1));
        assert.equal(peak, 1);
        assert.ok(reports.reduce((a, r) => a + (r.report.admission_wait_ms ?? 0), 0) >= 300);
      } finally {
        config.supervision.slots.verification = slots;
      }
    }));

  test("rollback: the engine is chosen per process and recorded; diagnostics show both", async () => {
    const ts = await withEngine("typescript", () => collect(run("true", []))());
    const go = await withEngine("go", () => collect(run("true", []))());
    assert.equal(ts.report.engine, "typescript");
    assert.equal(go.report.engine, "go");
    assert.ok(sup.supervisionStats.started.typescript > 0 && sup.supervisionStats.started.go > 0);
    assert.equal(sup.supervisionStats.active, 0);
    const rt = sup.supervisionRuntime();
    assert.ok(rt.launcher);
    mkdirSync(join(root, "x"), { recursive: true });
    writeFileSync(join(root, "x", "y"), "");
  });
}
