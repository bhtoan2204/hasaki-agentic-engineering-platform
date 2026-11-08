/** Extend the existing paired-comparison report; fixture controls cannot establish model/context value. */
export function compareContextEffect(a: any, b: any) {
  if (
    !a.configuration.provider_sequence ||
    !b.configuration.provider_sequence ||
    a.configuration.context_variant === b.configuration.context_variant
  )
    return null;
  const left = new Map<string, any>(
    a.cases.map((r: any) => [`${r.task_id}:${r.repetition}`, r]),
  );
  const tasks = new Map<string, Array<{ a: any; b: any }>>();
  for (const r of b.cases) {
    const previous = left.get(`${r.task_id}:${r.repetition}`);
    if (previous) {
      const group = tasks.get(r.task_id) ?? [];
      group.push({ a: previous, b: r });
      tasks.set(r.task_id, group);
    }
  }
  const genuine =
    a.configuration.mode === "live" &&
    b.configuration.mode === "live" &&
    !a.configuration.blocked &&
    !b.configuration.blocked &&
    [...a.cases, ...b.cases].every(
      (r) => r.data?.evidence?.details?.evidence_kind === "live_provider",
    );
  const valid = [...tasks.values()].filter(
    (p) =>
      p.length >= 2 &&
      p.every(
        (x) =>
          x.a.correct != null &&
          x.b.correct != null &&
          x.a.status !== "BLOCKED" &&
          x.b.status !== "BLOCKED",
      ),
  );
  let improved = 0,
    regressed = 0,
    faster = 0,
    slower = 0,
    verifiedTimingTasks = 0;
  const times: Array<{ baseline: number; candidate: number }> = [];
  for (const group of valid) {
    const passed = (key: "a" | "b") =>
      group.every(
        (p) => p[key].correct === true && p[key].hard_gates_passed === true,
      );
    if (!passed("a") && passed("b")) improved++;
    if (passed("a") && !passed("b")) regressed++;
    const values = (key: "a" | "b") =>
      group
        .map(
          (p) =>
            p[key].completion_duration_ms ?? p[key].data?.evidence?.duration_ms,
        )
        .filter(
          (v: any): v is number => typeof v === "number" && Number.isFinite(v),
        );
    const av = values("a"),
      bv = values("b");
    if (av.length === group.length && bv.length === group.length) {
      const baseline = av.reduce((x, y) => x + y, 0) / av.length,
        candidate = bv.reduce((x, y) => x + y, 0) / bv.length;
      times.push({ baseline, candidate });
      if (passed("a") && passed("b")) {
        verifiedTimingTasks++;
        if (candidate < baseline) faster++;
        if (candidate > baseline) slower++;
      }
    }
  }
  const qualityP = exactSign(improved, regressed),
    latencyP = exactSign(faster, slower);
  let status = "INSUFFICIENT_EVIDENCE";
  if (!genuine) status = "HARNESS_CONTROL_ONLY";
  else if (
    a.status === "COMPLETED" &&
    b.status === "COMPLETED" &&
    valid.length >= 10 &&
    valid.length === tasks.size &&
    a.cases.length === b.cases.length &&
    [...tasks.values()].reduce((n, p) => n + p.length, 0) === a.cases.length
  ) {
    status =
      improved > regressed && qualityP != null && qualityP < 0.025
        ? "MEASURABLE_QUALITY_GAIN"
        : regressed === 0 &&
            verifiedTimingTasks >= 10 &&
            faster > slower &&
            latencyP != null &&
            latencyP < 0.025
          ? "MEASURABLE_LATENCY_GAIN"
          : "NO_MEASURABLE_BENEFIT";
  }
  return {
    status,
    baseline_variant: a.configuration.context_variant,
    candidate_variant: b.configuration.context_variant,
    distinct_paired_tasks: valid.length,
    verified_timing_tasks: verifiedTimingTasks,
    improved,
    regressed,
    faster,
    slower,
    quality_p: qualityP,
    latency_p: latencyP,
    paired_duration_delta_ms: times.length
      ? times.reduce((s, t) => s + t.candidate - t.baseline, 0) / times.length
      : null,
    method:
      "Two-sided exact sign tests over distinct task outcomes/mean task durations; threshold 0.025 for two tests; at least two repetitions and ten paired tasks. Conditional on this fixed cohort, not a general model superiority claim.",
    usage_tradeoff:
      "Inspect reported token/cost coverage separately; unknown usage is not zero.",
  };
}
export function exactSign(positive: number, negative: number) {
  const n = positive + negative;
  if (!n) return null;
  const k = Math.min(positive, negative);
  let coefficient = 1,
    sum = 1;
  for (let i = 1; i <= k; i++) {
    coefficient = (coefficient * (n - i + 1)) / i;
    sum += coefficient;
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}
