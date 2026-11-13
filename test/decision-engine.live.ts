import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { config } from "../src/config.ts";
import { subscriptionTransport } from "../src/decision/providers.ts";

test(
  "optional Google Account Flash structured decision smoke (consumes subscription quota)",
  { skip: process.env.DECISION_LIVE_SMOKE !== "1" },
  async () => {
    const signal = AbortSignal.timeout(config.decisionEngine.timeoutMs);
    const target = await subscriptionTransport.resolve(
      {
        provider: "antigravity",
        model: config.decisionEngine.primary.model || "gemini-flash",
        effort: "medium",
      },
      signal,
    );
    const schema = z
      .object({ decision: z.enum(["STANDARD"]), reasoningSummary: z.string().min(1) })
      .strict();
    const result = await subscriptionTransport.execute(
      target,
      'Choose STANDARD. Return JSON {"decision":"STANDARD","reasoningSummary":"small smoke test"}. Do not use tools.',
      JSON.stringify(z.toJSONSchema(schema)),
      signal,
    );
    assert.equal(schema.parse(JSON.parse(result.text)).decision, "STANDARD");
    console.log(
      JSON.stringify({
        provider: target.provider,
        model: target.model,
        effort: target.effort,
        tokens: result.tokens,
      }),
    );
  },
);
