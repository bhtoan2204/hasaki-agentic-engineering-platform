import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LifecycleIncompleteError,
  STAGE_ORDER,
  runLifecycle,
  type StageTrace,
  type Stages,
} from "../src/agent/harness/lifecycle.ts";

const stagesThat = (stopAt: string | null, seen: string[], fail?: string) =>
  Object.fromEntries(
    STAGE_ORDER.map((name) => [
      name,
      async () => {
        seen.push(name);
        if (name === fail) throw new Error("boom");
        if (name === stopAt) return { kind: "completed" as const, output: { stage: name } };
      },
    ]),
  ) as unknown as Stages<object>;

test("stages run in the fixed order and the first result stops the attempt", async () => {
  const seen: string[] = [];
  const trace: StageTrace[] = [];
  const result = await runLifecycle({}, stagesThat("execute", seen), trace);
  assert.deepEqual(result, { kind: "completed", output: { stage: "execute" } });
  assert.deepEqual(seen, ["preflight", "context", "authorize", "budget", "checkpoint", "execute"]);
  assert.deepEqual(
    trace.map((t) => [t.stage, t.outcome]),
    seen.map((s) => [s, s === "execute" ? "completed" : "continue"]),
  );
});

test("a throwing stage is traced and rethrown; a lifecycle without a result is an error", async () => {
  const trace: StageTrace[] = [];
  await assert.rejects(() => runLifecycle({}, stagesThat(null, [], "verify"), trace), /boom/);
  assert.deepEqual(trace.at(-1)?.outcome, "error");
  await assert.rejects(() => runLifecycle({}, stagesThat(null, [])), LifecycleIncompleteError);
});
