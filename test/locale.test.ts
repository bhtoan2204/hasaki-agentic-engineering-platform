import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { getRun, pauseRun, resumeRun, startRun } from "../src/workflow/engine.ts";
import { languagePolicy, languageReminder, outputLocale, parseOutputLocale, resolveOutputLocale } from "../src/agent/language.ts";
import { buildResumeMessage, buildSystemAppend, buildUserPrompt } from "../src/agent/stepPrompt.ts";
import { repairPrompt } from "../src/agent/verify.ts";
import { messages, readUiLocale } from "../web/src/i18n/messages.ts";
import { buildStepMessage } from "../src/telegram.ts";

before(async () => {
  await migrate();
  await seedTemplates();
});
after(() => pool.end());

const step: any = { key: "implement", name: "Implementation", type: "coding_agent", config: { instructions: "Implement it.", independent: true } };
const ctx: any = { repositories: ["oms-api"], knowledge: [], overridden: [], disclosure: [] };

test("output locale validation and legacy fallback stay distinct", () => {
  assert.equal(resolveOutputLocale(undefined), "vi");
  assert.equal(resolveOutputLocale(""), "vi");
  assert.equal(resolveOutputLocale("en"), "en");
  assert.throws(() => resolveOutputLocale("fr"), /output_locale must be vi or en/);
  assert.equal(parseOutputLocale(null), null);
  assert.equal(outputLocale({ output_locale: null }), "vi");
  assert.equal(outputLocale({ output_locale: "en" }), "en");
});

test("UI locale preference falls back to Vietnamese", () => {
  const store = new Map<string, string>();
  assert.equal(readUiLocale((k) => store.get(k) ?? null), "vi");
  store.set("hasaki.uiLocale", "en");
  assert.equal(readUiLocale((k) => store.get(k) ?? null), "en");
  store.set("hasaki.uiLocale", "fr");
  assert.equal(readUiLocale((k) => store.get(k) ?? null), "vi");
});

test("translation dictionaries have the same keys", () => {
  assert.deepEqual(Object.keys(messages.vi).sort(), Object.keys(messages.en).sort());
  for (const key of Object.keys(messages.vi)) assert.ok(messages.en[key].length > 0 && messages.vi[key].length > 0);
});

test("prompts follow the run output locale and keep machine-readable contracts", () => {
  const en = buildSystemAppend({ id: 1, definition_key: "feature-implementation", branch: "T-1", allowed_repositories: ["oms-api"], output_locale: "en" } as any, step, ctx, "coding");
  const legacy = buildSystemAppend({ id: 2, definition_key: "feature-implementation", branch: "T-1", allowed_repositories: ["oms-api"], output_locale: null } as any, step, ctx, "coding");
  assert.match(en, /in English/);
  assert.match(en, /PASS, FAIL, BLOCKED/);
  assert.doesNotMatch(en, /in Vietnamese/);
  assert.match(legacy, /in Vietnamese/);
  assert.match(languagePolicy("en"), /JSON property names/);
  const input: any = { run: { inputs: {}, selected_repositories: [], output_locale: "en" }, work_item: null, upstream: {}, answers: [], pending: null };
  assert.match(buildUserPrompt(input, []), /Continue in English/);
  assert.match(buildResumeMessage(input, undefined, [], "vi"), /Continue in Vietnamese/);
  const repair = repairPrompt({ repos: [] } as any, 1, { command: "go test ./...", maxRepairs: 2 } as any, "en");
  assert.match(repair, /go test \.\/\.\.\./);
  assert.match(repair, /submit_result/);
  assert.match(repair, /Continue in English/);
  assert.match(languageReminder("vi"), /Vietnamese/);
  const viMsg = buildStepMessage({ runId: 1, runTitle: "T", stepKey: "ask", stepName: "Ask", status: "WAITING_INPUT", detail: "2 câu hỏi" });
  const enMsg = buildStepMessage({ runId: 1, runTitle: "T", stepKey: "ask", stepName: "Ask", status: "WAITING_INPUT", detail: "2 questions", locale: "en" });
  assert.match(viMsg.text, /CẦN BẠN TRẢ LỜI/);
  assert.match(enMsg.text, /NEEDS YOUR ANSWER/);
  assert.match(enMsg.text, /Step: <b>Ask<\/b>/);
  assert.doesNotMatch(enMsg.text, /CẦN BẠN/);
});

test("a run keeps its output locale across pause and resume", async () => {
  const en = await startRun({ definitionKey: "feature-implementation", title: "english run", start: true, outputLocale: "en" });
  assert.equal(en.output_locale, "en");
  await pauseRun(en.id);
  await resumeRun(en.id);
  assert.equal((await getRun(en.id)).output_locale, "en");
  const vi = await startRun({ definitionKey: "feature-implementation", title: "default run", start: false });
  assert.equal(vi.output_locale, "vi");
  await assert.rejects(() => startRun({ definitionKey: "feature-implementation", outputLocale: "de" as "en", start: false }), /output_locale must be vi or en/);
});
