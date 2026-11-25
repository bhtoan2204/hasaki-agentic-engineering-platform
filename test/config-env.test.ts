import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../src/platform/childEnv.ts";

const CONFIG = join(import.meta.dirname, "..", "src", "config.ts");

/** Loads src/config.ts in a fresh process with exactly this environment and returns what `expr` evaluates to. */
function load(env: Record<string, string>, expr: string, live = false) {
  const dir = mkdtempSync(join(tmpdir(), "config-env-"));
  const file = join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({ dataDir: join(dir, "data"), reposRoot: join(dir, "repos") }),
  );
  const run = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const { config } = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify(${expr}));`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        DATABASE_URL: "postgres://u:p@localhost/db",
        PLATFORM_CONFIG: file,
        ...(live ? {} : { PLATFORM_TEST: "1" }),
        ...env,
      },
    },
  );
  return { status: run.status, out: run.stdout.trim(), err: run.stderr };
}

test("boolean flags accept 1/true/yes/on and 0/false/no/off in any case", () => {
  for (const [name, path] of [
    ["CODEACT_ENABLED", "config.codeAct.enabled"],
    ["LSP_ENABLED", "config.lsp.enabled"],
    ["RADAR_ENABLED", "config.radar.enabled"],
    ["RETRIEVAL_SEMANTIC_ENABLED", "config.retrieval.semantic.enabled"],
  ] as const) {
    for (const yes of ["1", "true", "TRUE", "Yes", "on"])
      assert.equal(load({ [name]: yes }, path).out, "true", `${name}=${yes}`);
    for (const no of ["0", "false", "No", "OFF"])
      assert.equal(load({ [name]: no }, path).out, "false", `${name}=${no}`);
  }
});

test("an unrecognised boolean keeps the default and warns", () => {
  const r = load({ CODEACT_ENABLED: "maybe" }, "config.codeAct.enabled");
  assert.equal(r.out, "false");
  assert.match(r.err, /Ignoring CODEACT_ENABLED="maybe"/);
});

test("PORT is validated at startup instead of becoming NaN", () => {
  assert.equal(load({ PORT: "4600" }, "config.port").out, "4600");
  assert.equal(load({}, "config.port").out, "4545");
  for (const bad of ["abc", "0", "70000", "45.5"]) {
    const r = load({ PORT: bad }, "config.port");
    assert.notEqual(r.status, 0, bad);
    assert.match(r.err, /PORT must be an integer from 1 to 65535/);
  }
});

test("ANALYTICS_TIMEOUT_MS must be a positive integer", () => {
  assert.equal(load({ ANALYTICS_TIMEOUT_MS: "5000" }, "config.analytics.timeoutMs").out, "5000");
  assert.notEqual(load({ ANALYTICS_TIMEOUT_MS: "soon" }, "config.analytics.timeoutMs").status, 0);
});

test("CURSOR_AGENT_TIMEOUT_MS falls back to 45 minutes with a warning when it is not a positive integer", () => {
  assert.equal(load({}, "config.agent.cursorTimeoutMs").out, String(45 * 60_000));
  assert.equal(
    load({ CURSOR_AGENT_TIMEOUT_MS: "1000" }, "config.agent.cursorTimeoutMs").out,
    "1000",
  );
  for (const bad of ["abc", "0", "-5"]) {
    const r = load({ CURSOR_AGENT_TIMEOUT_MS: bad }, "config.agent.cursorTimeoutMs");
    assert.equal(r.out, String(45 * 60_000), bad);
    assert.match(r.err, /CURSOR_AGENT_TIMEOUT_MS/);
  }
});

test("environment variables map to named config fields", () => {
  const r = load(
    {
      HOST: "0.0.0.0",
      SESSION_CACHE_MS: "0",
      COOKIE_SECURE: "1",
      HASAKI_WORK_CHROME_PROFILE: "existing",
      TRACE_MIN_LEVEL: "debug",
    },
    "[config.server.host, config.server.sessionCacheMs, config.server.cookieSecure, config.hasakiWorkBrowser.chromeProfile, config.trace.minLevel]",
  );
  assert.deepEqual(JSON.parse(r.out), ["0.0.0.0", "0", "1", "existing", "debug"]);
  assert.deepEqual(
    JSON.parse(load({}, "[config.server.host, config.hasakiWorkBrowser.chromeProfile]").out),
    [null, null],
  );
});

test("the executable overrides win over config.json, and one field holds the result", () => {
  const r = load(
    { CLAUDE_CODE_EXECUTABLE: "/opt/claude", CURSOR_AGENT_BIN: "/opt/cursor" },
    "[config.agent.claudeBin, config.agent.cursorBin]",
  );
  assert.deepEqual(JSON.parse(r.out), ["/opt/claude", "/opt/cursor"]);
});

test("company endpoints are empty without .env and come from the environment", () => {
  const empty = load(
    {},
    "[config.argocd.baseUrl, config.vault.baseUrl, config.kafka.baseUrl, config.splunk.baseUrl, config.hasakiWork.apiUrl, config.fileBaseUrl, config.bitbucket.workspace, config.qcHttp.productionDomains]",
  );
  assert.deepEqual(JSON.parse(empty.out), ["", "", "", "", "", "", "", []]);
  const set = load(
    {
      ARGOCD_BASE_URL: "https://argocd.example.test",
      PRODUCTION_DOMAINS: "Example.COM, shop.example.com",
      BITBUCKET_WORKSPACE: "team",
    },
    "[config.argocd.baseUrl, config.qcHttp.productionDomains, config.bitbucket.workspace]",
  );
  assert.deepEqual(JSON.parse(set.out), [
    "https://argocd.example.test",
    ["example.com", "shop.example.com"],
    "team",
  ]);
});

test("the generated retrieval token is a config field and is not written into process.env", () => {
  const live = load(
    {},
    "[config.retrieval.internalToken.length, process.env.RETRIEVAL_INTERNAL_TOKEN ?? null]",
    true,
  );
  assert.deepEqual(JSON.parse(live.out), [64, null]);
  const explicit = load(
    { RETRIEVAL_INTERNAL_TOKEN: "x".repeat(40) },
    "config.retrieval.internalToken",
    true,
  );
  assert.equal(JSON.parse(explicit.out), "x".repeat(40));
});

test("child processes do not inherit the platform's own secrets", () => {
  const out = childEnv({
    PATH: "/bin",
    AUTH_SECRET: "s",
    AUTH_SECRET_PREVIOUS: "p",
    AUTH_CIPHERTEXT_FORMAT: "v2",
    DATABASE_URL: "postgres://x",
    RETRIEVAL_INTERNAL_TOKEN: "t",
    PLATFORM_GIT_TOKEN: "g",
    TEST_DATABASE_URL: "postgres://t",
    OPENAI_API_KEY: "k",
  });
  assert.deepEqual(out, { PATH: "/bin", OPENAI_API_KEY: "k" });
});
