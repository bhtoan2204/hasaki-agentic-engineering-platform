import type { Profile } from "./profiles.ts";
export interface ProfileSample {
  fixture: string;
  repetition: number;
  base: string;
  provider: string;
  model: string;
  cache: string;
  checks: string[];
  requestedProfile?: Profile;
  initialProfile: Profile;
  finalProfile: Profile;
  wallMs: number | null;
  queueMs: number | null;
  activeMs?: number | null;
  invocations: number | null;
  tokens: number | null;
  contextTokens: number | null;
  verificationMs: number | null;
  correct: boolean | null;
  expectedProfile: Profile | null;
}
const distribution = (values: Array<number | null | undefined>) => {
  const present = values
    .filter((v): v is number => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    present.length ? present[Math.max(0, Math.ceil(p * present.length) - 1)] : null;
  return {
    median: percentile(0.5),
    p95: percentile(0.95),
    observed: present.length,
    total: values.length,
  };
};
/** Missing telemetry stays unknown; escalation is measured separately from independently adjudicated accuracy. */
export function summarizeProfiles(samples: ProfileSample[]) {
  return [...new Set(samples.map((s) => s.requestedProfile ?? s.initialProfile))].map((profile) => {
    const rows = samples.filter((s) => (s.requestedProfile ?? s.initialProfile) === profile);
    const labeled = rows.filter((s) => s.expectedProfile != null);
    const admitted = labeled.filter((s) => s.initialProfile === "MICRO");
    return {
      profile,
      runs: rows.length,
      finalProfiles: [...new Set(rows.map((s) => s.finalProfile))],
      escalationRate: rows.filter((s) => s.finalProfile !== s.initialProfile).length / rows.length,
      classificationAccuracy: labeled.length
        ? labeled.filter((s) => s.expectedProfile === s.initialProfile).length / labeled.length
        : null,
      falseAdmissionRate: admitted.length
        ? admitted.filter((s) => s.expectedProfile !== "MICRO").length / admitted.length
        : null,
      fallbackRate:
        rows.filter((s) => s.requestedProfile && s.requestedProfile !== s.initialProfile).length /
        rows.length,
      correct: rows.filter((s) => s.correct === true).length,
      incorrect: rows.filter((s) => s.correct === false).length,
      wallMs: distribution(rows.map((s) => s.wallMs)),
      queueMs: distribution(rows.map((s) => s.queueMs)),
      activeMs: distribution(rows.map((s) => s.activeMs)),
      invocations: distribution(rows.map((s) => s.invocations)),
      tokens: distribution(rows.map((s) => s.tokens)),
      contextTokens: distribution(rows.map((s) => s.contextTokens)),
      verificationMs: distribution(rows.map((s) => s.verificationMs)),
    };
  });
}
/** Same fixture/repetition/revision/provider/model/cache/checks across all three profiles, including failures and escalations. */
export function matchedBenchmark(samples: ProfileSample[]) {
  const groups = new Map<string, ProfileSample[]>();
  for (const sample of samples) {
    if (!["MICRO", "FAST", "STANDARD"].includes(sample.requestedProfile ?? sample.initialProfile))
      throw new Error("matched benchmark supports MICRO, FAST and STANDARD");
    const key = JSON.stringify([
      sample.fixture,
      sample.repetition,
      sample.base,
      sample.provider,
      sample.model,
      sample.cache,
      [...sample.checks].sort(),
    ]);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  if (
    new Set(samples.map((s) => s.fixture)).size < 20 ||
    [...groups.values()].some(
      (rows) =>
        rows.length !== 3 ||
        new Set(rows.map((s) => s.requestedProfile ?? s.initialProfile)).size !== 3,
    )
  )
    throw new Error(
      "matched benchmark requires at least 20 fixtures and complete MICRO/FAST/STANDARD comparisons",
    );
  for (const fixture of new Set(samples.map((s) => s.fixture)))
    if (new Set(samples.filter((s) => s.fixture === fixture).map((s) => s.repetition)).size < 3)
      throw new Error("matched benchmark requires three repetitions per fixture");
  const profiles = summarizeProfiles(samples);
  const micro = profiles.find((p) => p.profile === "MICRO")!;
  const improvements = profiles
    .filter((p) => p.profile !== "MICRO")
    .map((p) => ({
      against: p.profile,
      wall:
        p.wallMs.median && micro.wallMs.median != null
          ? 1 - micro.wallMs.median / p.wallMs.median
          : null,
      invocations:
        p.invocations.median && micro.invocations.median != null
          ? 1 - micro.invocations.median / p.invocations.median
          : null,
      tokens:
        p.tokens.median && micro.tokens.median != null
          ? 1 - micro.tokens.median / p.tokens.median
          : null,
    }));
  return { profiles, improvements, raw: samples };
}
