/**
 * Runtime provenance at sensitive sinks (P1-C, ADR 0010).
 *
 * The model is not a taint-preserving interpreter, so nothing here pretends to follow strings through its reasoning.
 * Instead, at the boundary the platform controls — a mutating operation about to be proposed — every sensitive
 * argument value is looked up in the platform's own records of this conversation:
 *
 *   trusted    the value appears in what the authenticated owner wrote (control authority), or a *target* lies in
 *              the scope the operator pre-authorized for running without confirmation (configuration authority:
 *              an observation cannot extend it);
 *   untrusted  otherwise, it appears in an observation: a tool result, a CodeAct output, a document, a log…;
 *   unknown    neither (model-made).
 * A merely allowlisted target (callable only with confirmation) taken from an observation stays untrusted.
 *
 * Decision: a *target* (where it goes: topic, cluster, URL, method, auth profile) from an untrusted observation is
 * refused; an unknown target, or a *payload* copied from an observation, needs the owner's explicit confirmation (never
 * auto-execution); otherwise the operation may follow its normal path. Arguments cannot carry provenance: only the
 * fields declared below are classified, from records the platform wrote. Results hold record refs, never values.
 */
export type Origin = "trusted" | "untrusted" | "unknown";
export interface SinkSpec {
  targets: string[];
  payload: string[];
}
/** Every mutating registry tool (readOnly: false). A new mutating tool must be declared here (test enforces it). */
export const SINKS: Record<string, SinkSpec> = {
  "kafka.publish": {
    targets: ["cluster", "topic"],
    payload: ["value", "key", "headers", "partition"],
  },
  // `method` and `auth` are small operator-defined vocabularies, not free destinations: the method is governed by the
  // pre-authorized rules (DELETE never runs unconfirmed) and an auth profile is bound to its hosts by configuration
  // (checked by the tool). Matching them against free text would only produce noise.
  "qc_http.request": { targets: ["url"], payload: ["body", "query", "headers"] },
  // Run orchestration (chat/platformOps.ts): the owner's own runs, always confirmed; ids found by reading are payload.
  "runs.start": { targets: [], payload: ["run_id", "repositories", "step_mode"] },
  "runs.cancel": { targets: [], payload: ["run_id", "reason"] },
  "runs.pause": { targets: [], payload: ["run_id"] },
  "runs.resume": { targets: [], payload: ["run_id"] },
  "runs.retry_step": { targets: [], payload: ["run_id", "step_key"] },
  "runs.approve_step": { targets: [], payload: ["run_id", "step_key", "comment"] },
  "runs.reject_step": { targets: [], payload: ["run_id", "step_key", "comment"] },
  // Chat delegation under an autonomy policy (telegram/sync.ts): a title or repository taken from observed data (logs,
  // documents, tool results) needs the owner's tap; only the owner's own wording may start work unattended.
  "work.delegate": { targets: [], payload: ["title", "repositories"] },
};
export interface Sources {
  trusted: Array<{ ref: string; text: string }>;
  untrusted: Array<{ ref: string; text: string }>;
  /** The target value lies in the operator's pre-authorized scope (checked for target fields only). */
  configured?: (field: string, value: unknown) => boolean;
}
export interface FieldProvenance {
  field: string;
  role: "target" | "payload";
  origin: Origin;
  refs: string[];
}
export interface Classification {
  decision: "allow" | "confirm" | "deny";
  fields: FieldProvenance[];
  reasons: string[];
}

/** Values worth matching: strings and numbers inside the field (keys are structure, not data). */
function leaves(v: unknown, out: string[] = []): string[] {
  if (v == null || typeof v === "boolean") return out;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") {
    const s = String(v).trim();
    if (s) out.push(s);
    return out;
  }
  if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (typeof v === "object") for (const x of Object.values(v as object)) leaves(x, out);
  return out;
}
/** A URL is also recognised without its query string and by its path alone. */
function variants(field: string, value: string) {
  if (field !== "url") return [value];
  try {
    const u = new URL(value);
    return [value, `${u.origin}${u.pathname}`, u.pathname].filter((p) => p.length > 1);
  } catch {
    return [value];
  }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Short values must match as a whole word; longer ones as a substring. Case-insensitive. */
function appears(value: string, text: string) {
  if (value.length < 4) return new RegExp(`(^|[^\\w])${escape(value)}($|[^\\w])`, "i").test(text);
  return text.toLowerCase().includes(value.toLowerCase());
}

function originOf(
  field: string,
  value: unknown,
  sources: Sources,
  target: boolean,
): { origin: Origin; refs: string[] } {
  const values = leaves(value);
  if (!values.length) return { origin: "trusted", refs: [] };
  const refs = new Set<string>();
  let untrusted = false;
  let unknown = false;
  for (const v of values) {
    const forms = variants(field, v);
    const owner = sources.trusted.filter((s) => forms.some((f) => appears(f, s.text)));
    if (owner.length) continue;
    if (target && sources.configured?.(field, v)) continue;
    const observed = sources.untrusted.filter((s) => forms.some((f) => appears(f, s.text)));
    if (observed.length) {
      untrusted = true;
      for (const o of observed) refs.add(o.ref);
      continue;
    }
    unknown = true;
  }
  return {
    origin: untrusted ? "untrusted" : unknown ? "unknown" : "trusted",
    refs: [...refs].slice(0, 10),
  };
}

export function classifyArguments(
  tool: string,
  args: Record<string, unknown>,
  sources: Sources,
): Classification {
  const spec = SINKS[tool];
  if (!spec) return { decision: "deny", fields: [], reasons: [`${tool} is not a declared sink`] };
  const fields: FieldProvenance[] = [];
  for (const [role, names] of [
    ["target", spec.targets],
    ["payload", spec.payload],
  ] as const)
    for (const field of names)
      if (args[field] !== undefined)
        fields.push({ field, role, ...originOf(field, args[field], sources, role === "target") });
  const reasons: string[] = [];
  for (const f of fields)
    if (f.role === "target" && f.origin === "untrusted")
      reasons.push(
        `the ${f.field} comes from an untrusted observation (${f.refs.join(", ")}); only a target the user stated can be used — ask the user to confirm it in their own words`,
      );
  if (reasons.length) return { decision: "deny", fields, reasons };
  for (const f of fields) {
    if (f.role === "target" && f.origin === "unknown")
      reasons.push(`the ${f.field} was not stated by the user`);
    if (f.role === "payload" && f.origin === "untrusted")
      reasons.push(
        `the ${f.field} contains data from an untrusted observation (${f.refs.join(", ")})`,
      );
  }
  return { decision: reasons.length ? "confirm" : "allow", fields, reasons };
}
