import { readFileSync } from "node:fs";
import { z } from "zod";
import { matchedBenchmark } from "../workflow/profileMetrics.ts";
const arg = process.argv.find((a) => a.startsWith("--samples="))?.slice("--samples=".length);
if (!arg)
  throw new Error(
    "Use --suite=adaptive-v1 --samples=<sanitized-export.json>. Live execution requires the existing isolated evaluation connector; this command never starts runs against the application database.",
  );
const profile = z.enum(["MICRO", "FAST", "STANDARD", "DEEP"]);
const measurement = z.number().finite().nonnegative().nullable();
const samples = z.array(
  z
    .object({
      fixture: z.string().min(1),
      repetition: z.number().int().positive(),
      base: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().min(1),
      cache: z.enum(["cold", "warm"]),
      checks: z.array(z.string()).min(1),
      requestedProfile: profile.optional(),
      initialProfile: profile,
      finalProfile: profile,
      wallMs: measurement,
      queueMs: measurement,
      activeMs: measurement.optional(),
      invocations: measurement,
      tokens: measurement,
      contextTokens: measurement,
      verificationMs: measurement,
      correct: z.boolean().nullable(),
      expectedProfile: profile.nullable(),
    })
    .strict(),
);
const input = z
  .object({
    evidence: z.enum(["live", "fixture"]),
    samples: samples.optional(),
    raw: samples.optional(),
    candidate_source_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (value) => !!value.samples !== !!value.raw,
    "Provide samples or raw measurements, not both",
  )
  .parse(JSON.parse(readFileSync(arg, "utf8")));
console.log(
  JSON.stringify(
    {
      evidence: input.evidence,
      candidate_source_sha256: input.candidate_source_sha256,
      live_acceptance:
        input.evidence === "live"
          ? "requires independent evidence review"
          : "not established by fixture measurements",
      ...matchedBenchmark(input.samples ?? input.raw!),
    },
    null,
    2,
  ),
);
