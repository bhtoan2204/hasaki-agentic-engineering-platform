import { z } from "zod";
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

export { buildExecutionContract, executionContractProblems } from "./executionContract.ts";
export type { MandatoryExecutionContract } from "./executionContract.ts";

const objectValue = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);

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
      return result.success
        ? { valid: true, errors: [] }
        : {
            valid: false,
            errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          };
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
      errors: [
        `expected an object for output, received ${output === null ? "null" : Array.isArray(output) ? "array" : typeof output}`,
      ],
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

function validateFieldValue(path: string, val: unknown, typeSpec: string, errors: string[]): void {
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
        errors.push(
          `${path}[${i}]: expected object, received ${item === null ? "null" : Array.isArray(item) ? "array" : typeof item}`,
        );
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
      errors.push(
        `${path}: expected object map, received ${val === null ? "null" : Array.isArray(val) ? "array" : typeof val}`,
      );
      return;
    }
    const innerSchema = dynamicMapMatch[1].trim();
    const innerBody = innerSchema.slice(1, -1).trim();
    const innerFields = parseContractFields(innerBody);
    for (const [mapKey, mapVal] of Object.entries(val as Record<string, unknown>)) {
      if (typeof mapVal !== "object" || mapVal === null || Array.isArray(mapVal)) {
        errors.push(
          `${path}["${mapKey}"]: expected object, received ${mapVal === null ? "null" : Array.isArray(mapVal) ? "array" : typeof mapVal}`,
        );
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
      errors.push(
        `${path}: expected object, received ${val === null ? "null" : Array.isArray(val) ? "array" : typeof val}`,
      );
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
