import { z } from "zod";
import { hashOf } from "../workflow/definitions.ts";
/**
 * Top-level keys of a step's prose output contract, e.g. "{ goal, requirements: string[], risks }" → goal, requirements,
 * risks. Dynamic keys ("[repo]") and optional keys ("key?") are skipped. Used to refuse a step that ends without a result matching it.
 */

export type StepOutcome = "IMPLEMENTED" | "NO_CHANGE_REQUIRED" | "BLOCKED" | "FAILED";

export const VALID_STEP_OUTCOMES: readonly StepOutcome[] = [
  "IMPLEMENTED",
  "NO_CHANGE_REQUIRED",
  "BLOCKED",
  "FAILED",
] as const;

export function isStepOutcome(val: unknown): val is StepOutcome {
  return typeof val === "string" && (VALID_STEP_OUTCOMES as readonly string[]).includes(val);
}

export interface MandatoryExecutionContract {
  approved_plan: string | Record<string, unknown> | null;
  acceptance_criteria: string[];
  business_constraints: string[];
  selected_repositories: string[];
  required_tests: string[];
  provenance?: {
    plan_step: string;
    plan_attempt_id: number | null;
    approval_step: string;
    approval_attempt_id: number | null;
    approval: Record<string, unknown> | null;
    revision: string;
    source_attempts: Record<string, number | null>;
  };
}

type UpstreamContract = Record<string, { status: string; attempt_id: number | null; output: unknown }>;
const objectValue = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** Full source content and worker-owned attempt identity; approval metadata is never plan content. */
export function buildExecutionContract(upstream: UpstreamContract, selected: string[], workItem?: { payload?: unknown } | null): MandatoryExecutionContract {
  const planStep = upstream.plan ? "plan" : "fix_proposal";
  const approvalStep = planStep === "plan" ? "approve_plan" : "approve_fix";
  const plan = upstream[planStep];
  const approval = upstream[approvalStep];
  const content = objectValue(plan?.output);
  const sources = Object.fromEntries(Object.entries(upstream).filter(([key]) =>
    ["requirements", "analyze", "understand", "architecture", planStep].includes(key)));
  const outputs = [...Object.values(sources).map(u => objectValue(u.output)), objectValue(workItem?.payload)].filter(v => v !== null);
  const subtasks = Array.isArray(content?.subtasks) ? content.subtasks.map(objectValue).filter(v => v !== null) : [];
  const collect = (...keys: string[]) => [...new Set(outputs.flatMap(o => keys.flatMap(k => strings(o[k]))))];
  const identity = { source_attempts: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.attempt_id])), plan_step: planStep, plan_attempt_id: plan?.attempt_id ?? null,
    approval_step: approvalStep, approval_attempt_id: approval?.attempt_id ?? null,
    approval: approval?.status === "COMPLETED" ? objectValue(approval.output) : null };
  const payload = {
    approved_plan: plan?.status === "COMPLETED" ? (upstream.architecture ? { plan: content, architecture: upstream.architecture.output } : content) : null,
    acceptance_criteria: [...new Set([...collect("acceptance_criteria"), ...subtasks.flatMap(t => strings(t.acceptance_criteria))])],
    business_constraints: collect("business_constraints", "constraints"),
    selected_repositories: [...selected],
    required_tests: [...new Set([...strings(content?.tests), ...strings(content?.required_tests), ...strings(content?.regression_tests), ...strings(content?.verification_strategy), ...subtasks.flatMap(t => strings(t.verification))])],
  };
  return { ...payload, provenance: { ...identity, revision: hashOf({ ...payload, ...identity }) } };
}

export function executionContractProblems(contract: MandatoryExecutionContract, allowed: string[]): string[] {
  const problems: string[] = [];
  if (!contract.approved_plan || !Object.keys(contract.approved_plan).length) problems.push("Actual approved plan is missing");
  if (!contract.provenance?.plan_attempt_id || !contract.provenance.approval_attempt_id || contract.provenance.approval?.approved !== true)
    problems.push("Approval provenance is missing or incomplete");
  if (!contract.acceptance_criteria.length) problems.push("Acceptance criteria are missing");
  if (!contract.required_tests.length) problems.push("Required tests are missing");
  if (!contract.selected_repositories.length || contract.selected_repositories.some(r => !allowed.includes(r))) problems.push("Repository scope is missing or unauthorized");
  return problems;
}

export function contractKeys(contract: unknown): string[] {
  const s = typeof contract === "string" ? contract.trim() : "";
  if (!s.startsWith("{") || !s.endsWith("}")) return [];
  const body = s.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let cur = "";
  const flush = () => {
    // "key?" / "key?: type" is optional: shown to the agent, never required for the step to complete.
    const m = cur.trim().match(/^([A-Za-z_][\w]*)(\?)?\s*(:|$)/);
    if (m && !m[2]) keys.push(m[1]);
    cur = "";
  };
  for (const ch of body) {
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else cur += ch;
  }
  flush();
  return keys;
}

export function missingContractKeys(contract: unknown, output: Record<string, unknown>): string[] {
  return contractKeys(contract).filter((k) => !(k in output));
}

interface ContractField {
  key: string;
  optional: boolean;
  typeSpec: string;
}

export function parseContractFields(schemaBody: string): ContractField[] {
  const fields: ContractField[] = [];
  let depth = 0;
  let cur = "";
  let inQuote: string | null = null;

  const flush = () => {
    const trimmed = cur.trim();
    cur = "";
    if (!trimmed) return;
    const m = trimmed.match(/^([A-Za-z_][\w]*)(\?)?\s*(?::\s*([\s\S]*))?$/);
    if (m) {
      fields.push({
        key: m[1],
        optional: Boolean(m[2]),
        typeSpec: (m[3] ?? "").trim(),
      });
    }
  };

  for (let i = 0; i < schemaBody.length; i++) {
    const ch = schemaBody[i];
    if (inQuote) {
      if (ch === inQuote && schemaBody[i - 1] !== "\\") inQuote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if ("{[(<".includes(ch)) depth++;
    else if ("}])>".includes(ch)) depth--;

    if (ch === "," && depth === 0) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return fields;
}

export interface ContractValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateOutputContract(
  contract: unknown,
  output: unknown,
): ContractValidationResult {
  if (objectValue(contract)) {
    try {
      const result = z.fromJSONSchema(contract as z.core.JSONSchema.JSONSchema).safeParse(output);
      return result.success ? { valid: true, errors: [] } : { valid: false, errors: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) };
    } catch (error) {
      return { valid: false, errors: [`Unsupported output schema: ${String(error)}`] };
    }
  }
  const errors: string[] = [];
  const s = typeof contract === "string" ? contract.trim() : "";
  if (!s || !s.startsWith("{") || !s.endsWith("}")) {
    return { valid: true, errors: [] };
  }

  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return {
      valid: false,
      errors: [`expected an object for output, received ${output === null ? "null" : Array.isArray(output) ? "array" : typeof output}`],
    };
  }

  const outputObj = output as Record<string, unknown>;

  // If outcome is provided on output, validate that it's a recognized StepOutcome
  if ("outcome" in outputObj && outputObj.outcome !== undefined) {
    if (!isStepOutcome(outputObj.outcome)) {
      errors.push(
        `invalid outcome value "${String(outputObj.outcome)}"; must be one of: ${VALID_STEP_OUTCOMES.join(", ")}`,
      );
    }
  }

  const body = s.slice(1, -1).trim();
  const fields = parseContractFields(body);

  for (const field of fields) {
    const val = outputObj[field.key];
    const present = field.key in outputObj && val !== undefined && val !== null;

    if (!present) {
      if (!field.optional) {
        errors.push(`missing required field: ${field.key}`);
      }
      continue;
    }

    validateFieldValue(field.key, val, field.typeSpec, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateFieldValue(
  path: string,
  val: unknown,
  typeSpec: string,
  errors: string[],
): void {
  if (!typeSpec) {
    // No specific type required, just presence
    return;
  }

  // Primitive: string
  if (typeSpec === "string") {
    if (typeof val !== "string") {
      errors.push(`${path}: expected string, received ${typeof val}`);
    }
    return;
  }

  // Primitive: number
  if (typeSpec === "number") {
    if (typeof val !== "number") {
      errors.push(`${path}: expected number, received ${typeof val}`);
    }
    return;
  }

  // Primitive: boolean
  if (typeSpec === "boolean") {
    if (typeof val !== "boolean") {
      errors.push(`${path}: expected boolean, received ${typeof val}`);
    }
    return;
  }

  // Array of primitives: string[]
  if (typeSpec === "string[]") {
    if (!Array.isArray(val)) {
      errors.push(`${path}: expected string[], received ${typeof val}`);
      return;
    }
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== "string") {
        errors.push(`${path}[${i}]: expected string, received ${typeof val[i]}`);
      }
    }
    return;
  }

  // Array of objects: [{ ... }]
  if (typeSpec.startsWith("[{") && typeSpec.endsWith("}]")) {
    if (!Array.isArray(val)) {
      errors.push(`${path}: expected array of objects, received ${typeof val}`);
      return;
    }
    const innerBody = typeSpec.slice(2, -2).trim();
    const innerFields = parseContractFields(innerBody);
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`${path}[${i}]: expected object, received ${item === null ? "null" : Array.isArray(item) ? "array" : typeof item}`);
        continue;
      }
      for (const f of innerFields) {
        const itemVal = (item as Record<string, unknown>)[f.key];
        const present = f.key in item && itemVal !== undefined && itemVal !== null;
        if (!present) {
          if (!f.optional) {
            errors.push(`${path}[${i}]: missing required field "${f.key}"`);
          }
          continue;
        }
        validateFieldValue(`${path}[${i}].${f.key}`, itemVal, f.typeSpec, errors);
      }
    }
    return;
  }

  // Dynamic map: { [repo]: { ... } } or { [key]: { ... } }
  const dynamicMapMatch = typeSpec.match(/^\{\s*\[[\w]+\]\s*:\s*(\{[\s\S]*\})\s*\}$/);
  if (dynamicMapMatch) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      errors.push(`${path}: expected object map, received ${val === null ? "null" : Array.isArray(val) ? "array" : typeof val}`);
      return;
    }
    const innerSchema = dynamicMapMatch[1].trim();
    const innerBody = innerSchema.slice(1, -1).trim();
    const innerFields = parseContractFields(innerBody);
    for (const [mapKey, mapVal] of Object.entries(val as Record<string, unknown>)) {
      if (typeof mapVal !== "object" || mapVal === null || Array.isArray(mapVal)) {
        errors.push(`${path}["${mapKey}"]: expected object, received ${mapVal === null ? "null" : Array.isArray(mapVal) ? "array" : typeof mapVal}`);
        continue;
      }
      for (const f of innerFields) {
        const subVal = (mapVal as Record<string, unknown>)[f.key];
        const present = f.key in mapVal && subVal !== undefined && subVal !== null;
        if (!present) {
          if (!f.optional) {
            errors.push(`${path}["${mapKey}"]: missing required field "${f.key}"`);
          }
          continue;
        }
        validateFieldValue(`${path}["${mapKey}"].${f.key}`, subVal, f.typeSpec, errors);
      }
    }
    return;
  }

  // Nested object: { ... }
  if (typeSpec.startsWith("{") && typeSpec.endsWith("}")) {
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      errors.push(`${path}: expected object, received ${val === null ? "null" : Array.isArray(val) ? "array" : typeof val}`);
      return;
    }
    const innerBody = typeSpec.slice(1, -1).trim();
    const innerFields = parseContractFields(innerBody);
    for (const f of innerFields) {
      const subVal = (val as Record<string, unknown>)[f.key];
      const present = f.key in val && subVal !== undefined && subVal !== null;
      if (!present) {
        if (!f.optional) {
          errors.push(`${path}: missing required field "${f.key}"`);
        }
        continue;
      }
      validateFieldValue(`${path}.${f.key}`, subVal, f.typeSpec, errors);
    }
    return;
  }

  // Enum: e.g. "PASS" | "FAIL" | "BLOCKED" or "high"|"medium"|"low"
  if (typeSpec.includes("|")) {
    const matches = [...typeSpec.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    if (matches.length > 0) {
      if (typeof val !== "string" || !matches.includes(val)) {
        errors.push(
          `${path}: expected one of [${matches.map((m) => '"' + m + '"').join(", ")}], received ${JSON.stringify(val)}`,
        );
      }
      return;
    }
  }
}
