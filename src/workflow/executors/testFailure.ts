import { config } from "../../config.ts";
import { ancestors } from "../graph.ts";
import { parseGoTest } from "./baseline.ts";
import type { ExecutionContext } from "./registry.ts";
import type { ExecResult } from "../types.ts";
import { languagePolicy, outputLocale, type OutputLocale } from "../../agent/language.ts";
import { agentProvider, type AgentProvider } from "../../agent/provider.ts";
import { completeForRun } from "../../agent/complete.ts";
import { TEST_POLICY } from "../templates.ts";

/**
 * Human-in-the-loop handling of a failed test step (after automatic retries are exhausted):
 *   diagnose (deterministic, from the real output + baseline) → optional short AI explanation → WAITING_INPUT with a
 *   question in the Step Inspector → the answer resumes the SAME step, which interprets the decision:
 *     rerun                → run the tests again in this new attempt (old attempt + log kept)
 *     fix                  → re-execute the upstream coding step with the instructions (tests and dependants rerun)
 *     accept_baseline      → only with explicit confirmation and when EVERY failure is proven on the baseline;
 *                            step completes with test_status FAILED + a recorded exception
 *     stop                 → the step fails (existing failure semantics)
 *     unclear              → ask again (AI clarification when available)
 * Everything lives in attempts, questions and checkpoints in PostgreSQL: restart-safe, no worker held while waiting.
 */

export type Category = "pre_existing" | "new" | "environment" | "insufficient";
export interface Failure {
  repo: string;
  package: string | null;
  test: string | null;
  build_error: string | null;
  category: Category;
  reason: string;
  env_signal: boolean;
  log: string;
}
export interface Diagnosis {
  command: string;
  base_sha: string | null;
  baseline_available: boolean;
  results: Array<{ repo: string; exit_code: number | null; timed_out: boolean; artifact_id: number }>;
  failures: Failure[];
  counts: Record<Category, number>;
  all_pre_existing: boolean;
  summary: string;
  explanation?: { text: string; suggestion: string; by: AgentProvider | "rules" };
}

const ENV = /dial tcp|connection refused|connection (setup )?timed out|no such host|i\/o timeout|tls handshake|network is unreachable|failed to initialize database|context deadline exceeded|could not connect|ECONNREFUSED|ETIMEDOUT/i;

/** The log lines that belong to one failing test (=== RUN … --- FAIL) or a compile error, capped. */
export function extractLog(output: string, test: string | null, buildError: string | null, max = 2000): string {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  let picked: string[] = [];
  if (test) {
    const start = lines.findIndex((l) => l.includes(`=== RUN   ${test}`) || l.trim() === `=== RUN ${test}`);
    const end = lines.findIndex((l) => l.includes(`--- FAIL: ${test} `) || l.includes(`--- FAIL: ${test}(`) || l.trim().startsWith(`--- FAIL: ${test}`));
    if (end >= 0) picked = lines.slice(Math.max(start >= 0 && start < end ? start : end - 25, 0), end + 4);
  } else if (buildError) {
    const file = buildError.split(":")[0];
    picked = lines.filter((l) => l.includes(file)).slice(0, 15);
  }
  if (!picked.length) picked = lines.filter((l) => l.trim()).slice(-40);
  const s = picked.join("\n");
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

/**
 * Classify every failure. A failure is `pre_existing` ONLY when the baseline run of the same packages shows the same
 * failure; `new` when the baseline ran and did not fail that way; without baseline evidence it is `environment` (network /
 * infrastructure signature in its log) or `insufficient`.
 */
export function diagnose(input: {
  command: string;
  outputs: Record<string, string>;
  results: Array<{ repo: string; exit_code: number | null; timed_out: boolean; artifact_id: number; passed?: boolean; baseline?: any }>;
}): Diagnosis {
  const failures: Failure[] = [];
  let baseSha: string | null = null;
  let baselineAvailable = false;
  for (const r of input.results) {
    if (r.passed !== false && r.exit_code === 0) continue;
    const out = input.outputs[r.repo] ?? "";
    const b = r.baseline;
    if (b?.base_sha) {
      baseSha = b.base_sha;
      baselineAvailable = true;
    }
    const parsed = parseGoTest(out);
    const failing = Object.entries(parsed).filter(([, p]) => p.status === "fail");
    if (!failing.length || r.timed_out) {
      const log = extractLog(out, null, null);
      const env = ENV.test(log);
      failures.push({ repo: r.repo, package: null, test: null, build_error: r.timed_out ? "timed out" : null, category: env ? "environment" : "insufficient", reason: r.timed_out ? "the command timed out; no per-test result" : "no per-test failure could be parsed (build/script error?)", env_signal: env, log });
      continue;
    }
    const pre = new Map<string, { tests: Set<string>; errs: Set<string> }>();
    for (const x of b?.pre_existing ?? []) pre.set(x.package, { tests: new Set(x.tests), errs: new Set(x.build_errors) });
    const reg = new Map<string, { reason: string }>();
    for (const x of b?.regressions ?? []) reg.set(x.package, { reason: x.reason });
    for (const [pkg, p] of failing) {
      const items: Array<{ test: string | null; err: string | null }> = [...p.tests.map((t) => ({ test: t, err: null })), ...p.buildErrors.map((e) => ({ test: null, err: e }))];
      if (!items.length) items.push({ test: null, err: null });
      for (const it of items) {
        const log = extractLog(out, it.test, it.err);
        const env = ENV.test(log);
        const onBase = pre.get(pkg);
        const matched = onBase && ((it.test && onBase.tests.has(it.test)) || (it.err && onBase.errs.has(it.err)) || (!it.test && !it.err && !reg.has(pkg)));
        const baseTested = b?.base_sha && !(reg.get(pkg)?.reason ?? "").includes("not tested on the base");
        let category: Category;
        let reason: string;
        if (matched) (category = "pre_existing"), (reason = `the same failure occurs on ${config.baseBranch}@${String(b.base_sha).slice(0, 9)}`);
        else if (baseTested) (category = "new"), (reason = `does not fail on ${config.baseBranch}@${String(b.base_sha).slice(0, 9)}`);
        else if (env) (category = "environment"), (reason = "network/infrastructure error in the log; no baseline evidence");
        else (category = "insufficient"), (reason = b?.note ? `no baseline evidence (${b.note})` : "no baseline evidence for this failure");
        failures.push({ repo: r.repo, package: pkg, test: it.test, build_error: it.err, category, reason, env_signal: env, log });
      }
    }
  }
  const counts: Record<Category, number> = { pre_existing: 0, new: 0, environment: 0, insufficient: 0 };
  for (const f of failures) counts[f.category]++;
  const all_pre_existing = failures.length > 0 && failures.every((f) => f.category === "pre_existing");
  const parts = [counts.new && `${counts.new} lỗi mới`, counts.pre_existing && `${counts.pre_existing} lỗi đã có trên baseline`, counts.environment && `${counts.environment} lỗi môi trường`, counts.insufficient && `${counts.insufficient} lỗi chưa đủ bằng chứng`].filter(Boolean);
  return { command: input.command, base_sha: baseSha, baseline_available: baselineAvailable, results: input.results.map(({ repo, exit_code, timed_out, artifact_id }) => ({ repo, exit_code, timed_out, artifact_id })), failures, counts, all_pre_existing, summary: `Test fail: ${parts.join(", ") || "không phân tích được"}` };
}

// ---------------------------------------------------------------- decisions

export type DecisionKind = "rerun" | "fix" | "accept_baseline" | "stop" | "unclear";
export const OPTIONS = {
  rerun: "Chạy lại test",
  fix: "Sửa rồi test lại",
  accept: "Tiếp tục với lỗi baseline (tôi xác nhận ngoại lệ)",
  stop: "Dừng",
};

const OPTIONS_EN = {
  rerun: "Rerun tests",
  fix: "Fix then retest",
  accept: "Continue with baseline failures (I confirm the exception)",
  stop: "Stop",
};

export function failureOptions(locale: OutputLocale = "vi") {
  return locale === "en" ? OPTIONS_EN : OPTIONS;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

/** Deterministic parse of the answer (buttons or clear free text). `unclear` → AI or a follow-up question. */
export function parseDecision(answer: string): { kind: DecisionKind; confirmed: boolean; instructions: string } {
  const a = norm(answer.trim());
  const confirmed = /(xac nhan|dong y|confirm|i accept|chap nhan ngoai le)/.test(a);
  const rest = answer.replace(/^(chạy lại test|chạy lại|sửa rồi test lại|sửa|fix|rerun|retry)\s*[:\-–]?\s*/i, "").trim();
  if (/^(dung|stop|huy|abort|cancel)\b/.test(a)) return { kind: "stop", confirmed, instructions: "" };
  if (/^(chay lai|rerun|retry|run again)/.test(a)) return { kind: "rerun", confirmed, instructions: rest };
  if (/^(sua|fix)\b|sua roi test lai/.test(a)) return { kind: "fix", confirmed, instructions: rest };
  if (/^(tiep tuc|continue|accept|chap nhan)|ngoai le|loi baseline/.test(a)) return { kind: "accept_baseline", confirmed, instructions: "" };
  return { kind: "unclear", confirmed, instructions: answer.trim() };
}

export interface TestFailureAdvisor {
  explain(d: Diagnosis, locale?: OutputLocale, provider?: AgentProvider): Promise<{ text: string; suggestion: string }>;
  interpret(d: Diagnosis, history: Array<{ question: string; answer: string }>, answer: string, locale?: OutputLocale, provider?: AgentProvider): Promise<{ kind: DecisionKind; instructions?: string; question?: string; confirmed?: boolean }>;
}
let advisor: TestFailureAdvisor | null = null;
export function setTestFailureAdvisor(a: TestFailureAdvisor | null) {
  advisor = a;
}

/** The run's provider answers (completeForRun): a Codex or Cursor run never asks Claude here. */
async function askClaude(prompt: string, ctx?: ExecutionContext, provider: AgentProvider = "claude"): Promise<any> {
  const done = await completeForRun({ agent_provider: provider }, prompt, ctx?.signal);
  if (ctx) await ctx.recordMetrics({ advisor: done.metrics, advisor_cost_usd: done.metrics.cost_usd }).catch(() => { });
  const out = done.text;
  const j = out.match(/\{[\s\S]*\}/)?.[0];
  if (!j) throw new Error("no JSON from advisor");
  return JSON.parse(j);
}

const compact = (d: Diagnosis) =>
  JSON.stringify({ command: d.command, base: d.base_sha, failures: d.failures.map((f) => ({ repo: f.repo, package: f.package, test: f.test, build_error: f.build_error, category: f.category, reason: f.reason, log: f.log.slice(0, 1200) })) }, null, 1).slice(0, 40_000);

export const claudeTestFailureAdvisor: TestFailureAdvisor = {
  async explain(d, locale = "vi", provider: AgentProvider = "claude") {
    return askClaude(
      [
        languagePolicy(locale),
        "Explain this test failure to a developer briefly (max 5 sentences): what failed, based on which evidence",
        "(cite test names / log lines), and the suggested next action. Respect the given categories: never call a failure",
        "pre-existing unless its category is pre_existing. When a failure comes from a test reaching a real DB, Elasticsearch or other",
        "remote infrastructure, suggest “Fix then retest” so the test is rewritten with mocks or deleted, not a plain rerun.",
        "Reply JSON only: {\"text\": \"...\", \"suggestion\": \"...\"}.",
        "<untrusted_input source=\"test_output\">",
        compact(d),
        "</untrusted_input>",
      ].join("\n"),
      undefined,
      provider,
    );
  },
  async interpret(d, history, answer, locale = "vi", provider: AgentProvider = "claude") {
    return askClaude(
      [
        languagePolicy(locale),
        "A developer answered how to proceed with a failed test step. Map the answer to ONE decision:",
        '"rerun" (run tests again), "fix" (send instructions to the coding step, then retest), "accept_baseline" (continue with',
        'failures that already fail on the base branch — only if the developer explicitly confirms), "stop", or "unclear".',
        "If unclear or a needed detail is missing, return a short clarifying question in the output language.",
        'Reply JSON only: {"kind": "...", "instructions": "for fix: what to change", "confirmed": true|false, "question": "if unclear"}',
        `Allowed to accept baseline: ${d.all_pre_existing}`,
        "History:",
        JSON.stringify(history.slice(-6)),
        "<untrusted_input source=\"developer_answer\">",
        answer,
        "</untrusted_input>",
        "Failure summary: " + d.summary,
      ].join("\n"),
      undefined,
      provider,
    );
  },
};

export function buildQuestion(d: Diagnosis, prefix = "", replace = false, locale: OutputLocale = "vi"): { question: string; context: string; options: string[] } {
  const opt = failureOptions(locale);
  const options = [opt.rerun, opt.fix, ...(d.all_pre_existing ? [opt.accept] : []), opt.stop];
  const head = locale === "en"
    ? d.all_pre_existing
      ? "Every failure already fails on the baseline. Rerun, fix more, or continue with an exception?"
      : d.counts.new
        ? "There are new failures compared with the baseline. Rerun, fix and retest, or stop?"
        : "Tests failed, but there is not enough evidence to treat them as pre-existing. Rerun, investigate, or stop?"
    : d.all_pre_existing
      ? "Tất cả lỗi đều đã fail trên baseline. Chạy lại, sửa thêm, hay tiếp tục với ngoại lệ?"
      : d.counts.new
        ? "Có lỗi mới so với baseline. Chạy lại, sửa rồi test lại, hay dừng?"
        : "Test fail nhưng chưa đủ bằng chứng để coi là lỗi có sẵn. Chạy lại, điều tra/sửa, hay dừng?";
  const unavailable = locale === "en"
    ? "Continuing with baseline failures is not available: some failures are not proven to exist on the baseline."
    : "“Tiếp tục với lỗi baseline” không khả dụng: còn lỗi chưa được chứng minh là có trên baseline.";
  const ctx = [
    d.summary,
    d.explanation ? `AI: ${d.explanation.text}\n${locale === "en" ? "Suggestion" : "Đề xuất"}: ${d.explanation.suggestion}` : "",
    ...d.failures.slice(0, 8).map((f) => `• [${f.category}] ${f.repo} ${f.package ?? ""} ${f.test ?? f.build_error ?? ""} — ${f.reason}`),
    d.all_pre_existing ? "" : unavailable,
  ]
    .filter(Boolean)
    .join("\n");
  return { question: replace && prefix ? prefix.trim() : prefix + head, context: ctx, options };
}

/** First failure of an attempt: diagnose, explain, ask. */
export async function askAboutFailure(ctx: ExecutionContext, input: Parameters<typeof diagnose>[0], decision: unknown = null): Promise<ExecResult> {
  const locale = outputLocale(ctx.run);
  const d = diagnose(input);
  try {
    // Every failure also fails on the baseline: the deterministic diagnosis is conclusive — no model call to restate it.
    const conclusive = d.all_pre_existing === true && d.failures.length > 0;
    d.explanation = advisor && !conclusive ? { ...(await advisor.explain(d, locale, agentProvider(ctx.run))), by: agentProvider(ctx.run) } : undefined;
  } catch (e) {
    await ctx.log("system", `test failure explanation unavailable: ${(e as Error).message}`);
  }
  if (!d.explanation)
    d.explanation = {
      by: "rules",
      text: d.summary,
      suggestion: locale === "en"
        ? d.counts.new ? "Read the logs of the new failures, then choose “Fix then retest” with specific instructions." : d.all_pre_existing ? "Every failure exists on the baseline; you can continue with an exception if you confirm it." : "These tests reach real DB/ES/network. Choose “Fix then retest” so the coding step rewrites them with mocks or deletes them — unit tests must not depend on remote infrastructure."
        : d.counts.new ? "Xem log các lỗi mới, rồi chọn “Sửa rồi test lại” với chỉ dẫn cụ thể." : d.all_pre_existing ? "Các lỗi đều có trên baseline; có thể tiếp tục với ngoại lệ nếu bạn xác nhận." : "Các test này gọi thẳng DB/ES/network thật. Chọn “Sửa rồi test lại” để bước code viết lại bằng mock hoặc xóa chúng — unit test không được phụ thuộc infra từ xa.",
    };
  await ctx.log("system", d.summary, { diagnosis: d.counts });
  return {
    kind: "waiting_input",
    questions: [buildQuestion(d, "", false, locale)],
    output: { test_status: "FAILED", passed: false, diagnosis: d, results: input.results, ...(decision ? { decision } : {}) },
    checkpoint: { test_failure: d },
  };
}

/** Resumed after an answer: interpret and act. Returns null for "rerun" (caller runs the tests again). */
export async function handleDecision(ctx: ExecutionContext, d: Diagnosis, fromAttempt: number): Promise<{ result: ExecResult | null; decision: any }> {
  const mine = ctx.input.answers.filter((a) => a.attempt_id === fromAttempt);
  const answer = mine.at(-1)?.answer ?? "";
  const history = ctx.input.answers.map((a) => ({ question: a.question, answer: a.answer }));
  const locale = outputLocale(ctx.run);
  let p: { kind: DecisionKind; confirmed: boolean; instructions: string; question?: string } = { ...parseDecision(answer), question: undefined };
  if (answer === failureOptions(locale).accept || answer === OPTIONS.accept) p.confirmed = true;
  if (p.kind === "unclear" && advisor) {
    try {
      const ai = await advisor.interpret(d, history, answer, locale, agentProvider(ctx.run));
      p = { kind: ai.kind, confirmed: !!ai.confirmed, instructions: ai.instructions ?? answer, question: ai.question };
    } catch (e) {
      await ctx.log("system", `answer interpretation unavailable: ${(e as Error).message}`);
    }
  }
  const decision = { kind: p.kind, answer, instructions: p.instructions || null, confirmed: p.confirmed, from_attempt: fromAttempt, at: new Date().toISOString() };
  await ctx.log("system", `test failure decision: ${p.kind}${p.instructions ? ` — ${p.instructions.slice(0, 200)}` : ""}`, { decision });
  const reask = (prefix: string, replace = false) => ({
    result: { kind: "waiting_input", questions: [buildQuestion(d, prefix, replace, locale)], output: { test_status: "FAILED", passed: false, diagnosis: d, decision }, checkpoint: { test_failure: d } } as ExecResult,
    decision,
  });
  switch (p.kind) {
    case "rerun":
      return { result: null, decision };
    case "stop":
      return { result: { kind: "failed", error: `stopped after test failure (${d.summary})`, retryable: false, details: { diagnosis: d, decision, test_status: "FAILED" } }, decision };
    case "accept_baseline":
      if (!d.all_pre_existing) return reask("Không thể tiếp tục: còn lỗi chưa được chứng minh là có trên baseline. ");
      if (!p.confirmed) return reask(`Bạn xác nhận tiếp tục với ${d.failures.length} lỗi đã có trên baseline (ghi ngoại lệ, kết quả test vẫn FAILED)? Chọn “${OPTIONS.accept}”. `);
      return {
        result: {
          kind: "completed",
          output: {
            test_status: "FAILED",
            passed: false,
            diagnosis: d,
            decision,
            results: d.results,
            accepted_exception: {
              by: ctx.input.answers.at(-1) ? "developer" : "",
              at: decision.at,
              base_sha: d.base_sha,
              failures: d.failures.map((f) => ({ repo: f.repo, package: f.package, test: f.test, build_error: f.build_error })),
              note: answer,
            },
          },
        },
        decision,
      };
    case "fix": {
      const run = ctx.run;
      const anc = ancestors(run.graph.steps, ctx.step.key);
      const coding = run.graph.steps.filter((s) => anc.has(s.key) && s.type === "coding_agent").map((s) => s.key);
      const target = coding.at(-1);
      if (!target) return reask("Workflow này không có bước code phía trước để sửa. ");
      if (!p.instructions) return reask("Bạn muốn sửa gì? Mô tả ngắn chỉ dẫn cho bước code. ");
      const feedback = [
        `Tests failed in "${ctx.step.name}". Developer instructions: ${p.instructions}`,
        `Failure diagnosis: ${d.summary}`,
        ...d.failures.filter((f) => f.category !== "pre_existing").slice(0, 10).map((f) => `- [${f.category}] ${f.repo} ${f.package ?? ""} ${f.test ?? f.build_error ?? ""}: ${f.log.split("\n").slice(-6).join(" | ").slice(0, 400)}`),
        TEST_POLICY,
      ].join("\n");
      return { result: { kind: "reexecute", target, feedback, output: { test_status: "FAILED", passed: false, diagnosis: d, decision: { ...decision, target } } }, decision };
    }
    default:
      return p.question ? reask(p.question, true) : reask("Chưa rõ hướng xử lý. ");
  }
}
