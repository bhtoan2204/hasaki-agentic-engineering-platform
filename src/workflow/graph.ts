import { WorkflowSpec, type StepSpec } from "./types.ts";

export class SpecError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super("invalid workflow definition: " + errors.join("; "));
    this.errors = errors;
  }
}

/** Parse + validate a definition: schema, unique keys, known dependencies, acyclic, run_if references. */
export function validateSpec(raw: unknown): WorkflowSpec {
  const parsed = WorkflowSpec.safeParse(raw);
  if (!parsed.success) throw new SpecError(parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`));
  const spec = parsed.data;
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const s of spec.steps) {
    if (keys.has(s.key)) errors.push(`duplicate step key "${s.key}"`);
    keys.add(s.key);
  }
  for (const s of spec.steps) {
    for (const d of s.depends_on) {
      if (!keys.has(d)) errors.push(`step "${s.key}" depends on unknown step "${d}"`);
      if (d === s.key) errors.push(`step "${s.key}" depends on itself`);
    }
    if (s.run_if && !ancestors(spec.steps, s.key).has(s.run_if.step))
      errors.push(`step "${s.key}" run_if references "${s.run_if.step}", which is not one of its ancestors`);
    if (s.type === "condition" && typeof s.config.path !== "string") errors.push(`condition step "${s.key}" needs config.path`);
    if (s.type === "command" && typeof s.config.command !== "string") errors.push(`command step "${s.key}" needs config.command`);
  }
  if (spec.feedback_step && !keys.has(spec.feedback_step)) errors.push(`feedback_step "${spec.feedback_step}" is not a step`);
  if (spec.execution_mode === "read_only")
    for (const s of spec.steps)
      if (["coding_agent", "command", "git_pull_request"].includes(s.type)) errors.push(`read-only workflow: step "${s.key}" of type ${s.type} could change code or external state`);
  if (!errors.length) {
    try {
      topoOrder(spec.steps);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new SpecError(errors);
  return spec;
}

/** Kahn's algorithm, stable with respect to declaration order. Throws on cycles. */
export function topoOrder(steps: Pick<StepSpec, "key" | "depends_on">[]): string[] {
  const indeg = new Map(steps.map((s) => [s.key, s.depends_on.length]));
  const out: string[] = [];
  const ready = steps.filter((s) => s.depends_on.length === 0).map((s) => s.key);
  while (ready.length) {
    const k = ready.shift()!;
    out.push(k);
    for (const s of steps) {
      if (!s.depends_on.includes(k)) continue;
      const n = indeg.get(s.key)! - 1;
      indeg.set(s.key, n);
      if (n === 0) ready.push(s.key);
    }
  }
  if (out.length !== steps.length) {
    const stuck = steps.filter((s) => !out.includes(s.key)).map((s) => s.key);
    throw new Error(`dependency cycle among steps: ${stuck.join(", ")}`);
  }
  return out;
}

/** Every step that transitively depends on `key` (excluding `key`). */
export function downstream(steps: Pick<StepSpec, "key" | "depends_on">[], key: string): Set<string> {
  const out = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const k = stack.pop()!;
    for (const s of steps) {
      if (s.depends_on.includes(k) && !out.has(s.key)) {
        out.add(s.key);
        stack.push(s.key);
      }
    }
  }
  return out;
}

/** Every step `key` transitively depends on. */
export function ancestors(steps: Pick<StepSpec, "key" | "depends_on">[], key: string): Set<string> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const out = new Set<string>();
  const stack = [...(byKey.get(key)?.depends_on ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    out.add(k);
    stack.push(...(byKey.get(k)?.depends_on ?? []));
  }
  return out;
}

/** Read a dot path ("output.exit_code", "items.0.name") from a value. */
export function getPath(value: unknown, path: string): unknown {
  let cur: any = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}
