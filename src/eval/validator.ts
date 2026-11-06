import { readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { extract } from "../codeIntelligence/parser.ts";
import type { BenchmarkCase } from "./dataset.ts";
import { containerRun, IsolationUnavailable } from "./isolation.ts";

/** Validation code is held outside the agent workspace and mounted read-only only after implementation. */
export function validationProgram(c: BenchmarkCase) {
  const modulePath = `/workspace/${c.repository}/${c.validation.path}`;
  return `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nconst equal=assert.deepStrictEqual.bind(assert),ok=assert.ok.bind(assert);\nlet passed=0,failed=0;const checks=[];\nfunction check(name,f){try{f();passed++;checks.push({name,passed:true});}catch{failed++;checks.push({name,passed:false});}}\nconst m=${["behavior", "freshness"].includes(c.validation.type) ? `await import(${JSON.stringify(modulePath)})` : "{}"};\nconst checksData=${JSON.stringify([...c.validation.public_checks.map((x) => ({ ...x, group: "required" })), ...c.validation.hidden_checks.map((x, i) => ({ ...x, group: c.category === "regression" && i > 0 ? "hidden:regression" : "hidden" }))])};\nfor (const [i,t] of checksData.entries()) check(t.group+':'+i,()=>equal(m[${JSON.stringify(c.validation.export_name ?? "")}](...t.args),t.expected));\n${c.category === "avoid_n_plus_one" ? `check('hidden:batch',()=>{let calls=0;const result=m.hydrateOrders([{id:1,customerId:'a'},{id:2,customerId:'a'},{id:3,customerId:'b'}],ids=>{calls++;return ids.map(id=>({id}));});equal(calls,1);equal(result.map(o=>o.customer.id),['a','a','b']);});` : ""}
${c.category === "transaction_consistency" ? `check('hidden:closed',()=>{const a={balance:100},b={balance:0,closed:true};equal(m.transfer(a,b,20),false);equal([a.balance,b.balance],[100,0]);});check('hidden:insufficient',()=>{const a={balance:10},b={balance:0};equal(m.transfer(a,b,20),false);equal([a.balance,b.balance],[10,0]);});check('required:valid',()=>{const a={balance:100},b={balance:0};equal(m.transfer(a,b,20),true);equal([a.balance,b.balance],[80,20]);});` : ""}
${c.validation.type === "proto" || c.category === "cross_repository" ? `check('hidden:proto',()=>{const s=readFileSync('/workspace/fixture-shared-proto/payment.proto','utf8');ok(/string\\s+currency\\s*=\\s*2\\s*;/.test(s));ok(/string\\s+id\\s*=\\s*1\\s*;/.test(s));ok(/rpc\\s+Charge\\s*\\(Request\\)\\s+returns\\s*\\(Reply\\)/.test(s));});` : ""}
${c.validation.type === "sql" ? `check('hidden:keyset',()=>{const s=readFileSync(${JSON.stringify(modulePath)},'utf8');ok(/^\\s*SELECT\\s+id\\s+FROM\\s+payments\\s+WHERE\\s+id\\s*>\\s*\\$1\\s+ORDER\\s+BY\\s+id\\s+LIMIT\\s+\\$2;?\\s*$/i.test(s));ok(!/\\bOFFSET\\b|;\\s*\\S|\\|\\|/.test(s.trim().replace(/;$/,'')));});` : ""}
console.log(JSON.stringify({passed,failed,checks}));\nprocess.exitCode=failed?1:0;`;
}
export async function validateSource(
  c: BenchmarkCase,
  workspace: string,
  validatorRoot: string,
  image: string,
  signal?: AbortSignal,
) {
  const sources: string[] = [];
  let syntax = true,
    security = true;
  for (const logical of c.repositories) {
    const root = join(workspace, logical);
    for (const path of await readdir(root)) {
      if (!/\.(ts|proto|sql)$/.test(path)) continue;
      const file = join(root, path),
        stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
        security = false;
        continue;
      }
      const text = await readFile(file, "utf8");
      if (
        path.endsWith(".ts") &&
        /\b(?:import|require|eval|Function|process|globalThis|constructor|__proto__|fetch|WebSocket)\b/.test(
          text,
        )
      )
        security = false;
      const parsed = await extract(
        path,
        path.endsWith(".sql") ? text.replace(/\$\d+/g, "0") : text,
        signal,
      );
      syntax = syntax && !!parsed && parsed.parse_errors === 0;
      if (
        path.endsWith(".ts") &&
        (path === c.validation.path ||
          c.allowed_changes.some(
            (a) => a.repository === logical && a.path === path,
          ))
      )
        sources.push(`/workspace/${logical}/${path}`);
    }
  }
  const checks: Array<{ name: string; passed: boolean }> = [];
  if (!syntax || !security)
    return {
      syntax,
      security,
      checks,
      diagnostic: "Source syntax or forbidden capability check failed",
    };
  // Build/typecheck precedes required and hidden behavior checks. No project plugins/configuration are loaded.
  if (sources.length) {
    await writeFile(
      join(validatorRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: false,
          types: [],
          skipLibCheck: true,
          noEmit: true,
        },
        files: sources,
      }),
    );
    try {
      await containerRun(
        image,
        [
          { source: workspace, target: "/workspace" },
          { source: validatorRoot, target: "/validator" },
          {
            source: join(
              import.meta.dirname,
              "..",
              "..",
              "node_modules",
              "typescript",
            ),
            target: "/compiler/node_modules/typescript",
          },
          {
            source: join(
              import.meta.dirname,
              "..",
              "..",
              "node_modules",
              "@typescript",
            ),
            target: "/compiler/node_modules/@typescript",
          },
        ],
        [
          "/compiler/node_modules/typescript/lib/tsc.js",
          "--project",
          "/validator/tsconfig.json",
        ],
        c.validation.timeout_seconds * 1000,
        signal,
      );
    } catch (error) {
      if (error instanceof IsolationUnavailable || signal?.aborted) throw error;
      return {
        syntax: false,
        security,
        checks,
        diagnostic: "Isolated TypeScript build/typecheck failed",
      };
    }
  }
  const script = join(validatorRoot, "validate.mjs");
  await writeFile(script, validationProgram(c));
  try {
    const result = await containerRun(
      image,
      [
        { source: workspace, target: "/workspace" },
        { source: validatorRoot, target: "/validator" },
      ],
      ["/validator/validate.mjs"],
      c.validation.timeout_seconds * 1000,
      signal,
    );
    const parsed = JSON.parse(result.stdout.trim());
    if (!Array.isArray(parsed.checks))
      throw new Error("Invalid validation result");
    return {
      syntax,
      security,
      checks: parsed.checks as typeof checks,
      diagnostic: null,
    };
  } catch (e) {
    if (e instanceof IsolationUnavailable || signal?.aborted) throw e;
    if ((e as any).killed)
      throw Object.assign(new Error("Validation timeout"), {
        name: "EvaluationTimeout",
      });
    const stdout = String((e as any).stdout ?? "").trim();
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed.checks))
        return {
          syntax,
          security,
          checks: parsed.checks as typeof checks,
          diagnostic: "Required or hidden assertions failed",
        };
    } catch {}
    return {
      syntax,
      security,
      checks: [{ name: "hidden:validator", passed: false }],
      diagnostic: (e as any).killed
        ? "Validation timeout"
        : "Validation process failed",
    };
  }
}
