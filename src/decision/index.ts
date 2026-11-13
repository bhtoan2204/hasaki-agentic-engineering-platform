import { redactContextValue } from "../context/redact.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db/pool.ts";
import { config } from "../config.ts";
import { pool, one, q, json } from "../db/pool.ts";
import { runEvents } from "../workflow/events.ts";
import type { DecisionEngine, DecisionRequest, DecisionResult, DecisionStore } from "./engine.ts";
import type { DecisionType, DecisionOutput } from "./schemas.ts";

const connection = new AsyncLocalStorage<Db>();
const db = () => connection.getStore() ?? pool;

// Cross-process session locks serialize equivalent requests without holding a workflow transaction open.
export const decisionStore: DecisionStore = {
  async exclusive(key, signal, fn) {
    const client = await pool.connect();
    let locked = false;
    try {
      while (!locked) {
        signal.throwIfAborted();
        locked = !!(
          await one<{ locked: boolean }>(
            client,
            "SELECT pg_try_advisory_lock(hashtextextended($1, 727057)) AS locked",
            [key],
          )
        )?.locked;
        if (!locked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return await connection.run(client, fn);
    } finally {
      let releaseError: Error | undefined;
      try {
        if (locked)
          await q(client, "SELECT pg_advisory_unlock(hashtextextended($1, 727057))", [key]);
      } catch (error) {
        releaseError = error as Error;
      }
      client.release(releaseError);
    }
  },
  async get(key) {
    return (
      (
        await one<{ result: DecisionResult }>(
          db(),
          "SELECT result FROM ai_decisions WHERE fingerprint=$1 ORDER BY id DESC LIMIT 1",
          [key],
        )
      )?.result ?? null
    );
  },
  async put(key, result, request) {
    await q(
      db(),
      "INSERT INTO ai_decisions(fingerprint,run_id,step_id,result,input_context,decision_type) VALUES($1,$2,$3,$4,$5,$6)",
      [
        key,
        request.scope.runId,
        request.scope.stepId ?? null,
        json(result),
        json(
          redactContextValue({
            input: request.input,
            context: request.context,
            constraints: request.constraints,
          }),
        ),
        request.type,
      ],
    );
  },
  async audit(request, record) {
    await runEvents.add(
      db(),
      request.scope.runId,
      "decision",
      `${request.type}: ${record.outcome} · ${record.provider ?? "no provider"}/${record.model ?? ""} · ${record.effort ?? ""}${record.fallbackUsed ? " · fallback" : ""} · ${record.reasoningSummary ?? record.error ?? ""}`,
      request.scope.stepId ?? null,
      request.scope.attemptId ?? null,
      record,
    );
  },
};
let singleton: DecisionEngine | undefined;
export const decisionEngine = {
  async decide<K extends DecisionType>(
    request: DecisionRequest<K>,
  ): Promise<DecisionResult<DecisionOutput<K>>> {
    if (!singleton) {
      const [{ DecisionEngine }, { subscriptionTransport }] = await Promise.all([
        import("./engine.ts"),
        import("./providers.ts"),
      ]);
      singleton ??= new DecisionEngine(
        subscriptionTransport,
        decisionStore,
        () => config.decisionEngine,
      );
    }
    return singleton.decide(request);
  },
};
export { DecisionEngine } from "./engine.ts";
export type { DecisionRequest, DecisionResult };
