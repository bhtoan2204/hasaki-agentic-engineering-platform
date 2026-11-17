import { config, type SlopSettings } from "../config.ts";
import { settings } from "../db.ts";
import { MICRO_RULES, RULES, SUPPORTED_LANGUAGES } from "./detectors.ts";
import { SEVERITY_RANK, type Finding, type SlopReport } from "./findings.ts";

/**
 * Slop settings (config defaults ← stored global ← stored repository) and the blocking decision. Stored under the
 * existing `settings` table key `slop_detection` as `{ global?: Partial<SlopSettings>, repositories?: { [repo]: … } }`.
 */
export const SETTINGS_KEY = "slop_detection";
export type SlopLayer = Partial<SlopSettings>;
export interface StoredSlopSettings {
  global?: SlopLayer;
  repositories?: Record<string, SlopLayer>;
}

function overlay(base: SlopSettings, layer: SlopLayer | undefined): SlopSettings {
  if (!layer) return base;
  return {
    ...base,
    ...layer,
    languages: { ...base.languages, ...layer.languages },
    rules: { ...base.rules, ...layer.rules },
    thresholds: { ...base.thresholds, ...layer.thresholds },
    excludePaths: [...new Set([...base.excludePaths, ...(layer.excludePaths ?? [])])],
    suppressions: [
      ...base.suppressions,
      ...(layer.suppressions ?? []).filter((s) => !base.suppressions.some((b) => b.fingerprint === s.fingerprint)),
    ],
  };
}

/** Repository overrides global overrides config; suppressions and excluded paths accumulate across layers. */
export function mergeSlopSettings(defaults: SlopSettings, stored: StoredSlopSettings | null, repo: string): SlopSettings {
  return overlay(overlay(defaults, stored?.global), stored?.repositories?.[repo]);
}

export async function loadStoredSlopSettings(): Promise<StoredSlopSettings> {
  try {
    const parsed = JSON.parse((await settings.get(SETTINGS_KEY)) ?? "null");
    if (parsed && typeof parsed === "object") return parsed as StoredSlopSettings;
  } catch {
    /* corrupt value: fall back to config, like the other settings readers */
  }
  return {};
}

export async function resolveSlopSettings(repo: string): Promise<SlopSettings> {
  return mergeSlopSettings(config.slop, await loadStoredSlopSettings(), repo);
}

const SEVERITIES = ["low", "medium", "high"];
const enumOf = (name: string, v: unknown, values: string[]) => {
  if (!values.includes(v as string)) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return v as never;
};
const boolMap = (name: string, v: unknown, keys: string[]) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
  for (const [k, b] of Object.entries(v)) {
    if (!keys.includes(k)) throw new Error(`${name}: unknown key ${k}`);
    if (typeof b !== "boolean") throw new Error(`${name}.${k} must be true or false`);
  }
  return v as Record<string, boolean>;
};

/** Strict validation of one stored layer; unknown keys are rejected so typos never silently do nothing. */
export function validateSlopLayer(input: unknown): SlopLayer {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("slop settings must be an object");
  const out: SlopLayer = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    switch (k) {
      case "mode": out.mode = enumOf(k, v, ["disabled", "advisory", "enforcement"]); break;
      case "level": out.level = enumOf(k, v, ["auto", "micro", "standard"]); break;
      case "minSeverity":
      case "blockSeverity": out[k] = enumOf(k, v, SEVERITIES); break;
      case "languages": out.languages = boolMap(k, v, SUPPORTED_LANGUAGES); break;
      case "rules": out.rules = boolMap(k, v, Object.keys(RULES)); break;
      case "minConfidence":
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw new Error("minConfidence must be between 0 and 1");
        out.minConfidence = v;
        break;
      case "maxFiles":
      case "timeoutMs":
        if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`${k} must be a positive integer`);
        out[k] = v as number;
        break;
      case "thresholds": {
        const keys = Object.keys(config.slop.thresholds);
        if (!v || typeof v !== "object") throw new Error("thresholds must be an object");
        for (const [t, n] of Object.entries(v)) {
          if (!keys.includes(t)) throw new Error(`thresholds: unknown key ${t}`);
          if (!Number.isInteger(n) || (n as number) < 1) throw new Error(`thresholds.${t} must be a positive integer`);
        }
        out.thresholds = v as SlopSettings["thresholds"];
        break;
      }
      case "excludePaths":
        if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && p.trim() && !p.includes("..") && !p.startsWith("/")))
          throw new Error("excludePaths must be repository-relative paths");
        out.excludePaths = v.map((p: string) => p.trim());
        break;
      case "suppressions":
        if (!Array.isArray(v) || !v.every((s) => /^[a-f0-9]{64}$/.test(s?.fingerprint) && typeof s?.reason === "string" && s.reason.trim()))
          throw new Error("suppressions need a 64-hex fingerprint and a reason");
        out.suppressions = v.map((s: { fingerprint: string; reason: string }) => ({ fingerprint: s.fingerprint, reason: s.reason.trim().slice(0, 500) }));
        break;
      default:
        throw new Error(`unknown slop setting ${k}`);
    }
  }
  return out;
}

/** Replace the stored settings after validation; repository names must be registered. */
export async function saveSlopSettings(input: { global?: unknown; repositories?: unknown }, knownRepositories: string[]) {
  const out: StoredSlopSettings = {};
  if (input.global !== undefined) out.global = validateSlopLayer(input.global);
  if (input.repositories !== undefined) {
    if (!input.repositories || typeof input.repositories !== "object" || Array.isArray(input.repositories))
      throw new Error("repositories must be an object");
    out.repositories = {};
    for (const [name, layer] of Object.entries(input.repositories)) {
      if (!knownRepositories.includes(name)) throw new Error(`unknown repository ${name}`);
      out.repositories[name] = validateSlopLayer(layer);
    }
  }
  await settings.set(SETTINGS_KEY, JSON.stringify(out));
  return out;
}

/** micro for MICRO runs and small FAST diffs (≤ 3 files, ≤ 150 changed lines) under level "auto". */
export function effectiveLevel(s: SlopSettings, profile: string | null | undefined, diff: { files: number; lines: number }): "micro" | "standard" {
  if (s.level !== "auto") return s.level;
  if (profile === "MICRO" || (profile === "FAST" && diff.files <= 3 && diff.lines <= 150)) return "micro";
  return "standard";
}

/** Rules that run for this level and configuration. */
export function activeRules(s: SlopSettings, level: "micro" | "standard"): Set<string> {
  return new Set((level === "micro" ? MICRO_RULES : Object.keys(RULES)).filter((r) => s.rules[r] !== false));
}

/** Findings that fail verification: enforcement only, new/worsened, severity and confidence at the thresholds. */
export function blocking(report: SlopReport, s: SlopSettings): Finding[] {
  if (s.mode !== "enforcement") return [];
  return report.findings.filter(
    (f) =>
      (f.status === "new" || f.status === "worsened") &&
      SEVERITY_RANK[f.severity] >= SEVERITY_RANK[s.blockSeverity] &&
      f.confidence >= s.minConfidence,
  );
}
