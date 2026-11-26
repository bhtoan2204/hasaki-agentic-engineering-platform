import { createHash } from "node:crypto";
import { resolveOutputLocale } from "../agent/language.ts";

/**
 * Dedup keys of shared results (docs/shared-results/PLAN.md, section 3). Pure: no I/O, no clock, no model.
 *
 * key = sha256 hex of the canonical JSON of the parts. The parts are returned too, readable, for the `key_parts` column
 * (audit and debugging). Every key carries its kind, a format version and the scope (the installation), so a key from
 * one kind, one format or one installation can never equal another. A user is never part of a key: who may read a result
 * is decided at lookup time (step 5), not by the key.
 */

/** Bump when the shape of the parts changes: old keys then stop matching instead of silently colliding. */
export const KEY_VERSION = 1;

import { SHARED_KINDS, type SharedKind } from "./types.ts";
export { SHARED_KINDS, type SharedKind };

export interface SharedKey {
  kind: SharedKind;
  /** sha256 hex (64 characters). */
  key: string;
  /** The inputs of the key, readable. Contains identifiers only (no secrets, no user data). */
  parts: Record<string, unknown>;
}

export interface WorkflowRef {
  key: string;
  /** The published definition version the analysis runs (workflow_definition_versions.version). */
  version: number;
}
export interface RepoAtCommit {
  repo: string;
  /** The full commit SHA the analysis reads (40 hex, or 64 for sha256 repositories). */
  commit: string;
}

export class KeyError extends Error {}

/** JSON with sorted object keys and no whitespace: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new KeyError("non-finite number in key parts");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  throw new KeyError(`cannot canonicalize ${typeof value}`);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const required = (name: string, v: unknown, max = 200) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new KeyError(`${name} is required`);
  if (s.length > max) throw new KeyError(`${name} is too long`);
  return s;
};

const SCOPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function scopeOf(scope: string) {
  const s = required("scope", scope, 64).toLowerCase();
  if (!SCOPE.test(s)) throw new KeyError("scope must be the installation id (a UUID)");
  return s;
}

const ERROR_KEY = /^[0-9a-f]{20}$/;
/** The group fingerprint (prod_error_groups.fingerprint): namespace + service + level + normalized message. */
export function errorKeyOf(fingerprint: string) {
  const f = required("error key", fingerprint, 20).toLowerCase();
  if (!ERROR_KEY.test(f)) throw new KeyError("error key must be a 20 character hex fingerprint");
  return f;
}

function workflowOf(w: WorkflowRef) {
  const key = required("workflow key", w?.key, 100);
  if (!Number.isInteger(w.version) || w.version < 1)
    throw new KeyError("workflow version must be a positive integer");
  return `${key}@${w.version}`;
}

/** Hash of one or more resolved texts that define an analysis. */
const HASH = /^[0-9a-f]{64}$/;
function hashOf(name: string, v: string) {
  const s = required(name, v, 64).toLowerCase();
  if (!HASH.test(s)) throw new KeyError(`${name} must be a sha256 hex string`);
  return s;
}

/** The analysing model as "provider/model". It must be the model the step resolves to, never "default". */
export function modelOf(provider: string, model: string) {
  const p = required("provider", provider, 60).toLowerCase();
  const m = required("model", model, 120);
  if (/^(default|auto)$/i.test(m))
    throw new KeyError("model must be the resolved model id, not a placeholder");
  return `${p}/${m}`;
}

const REPO = /^[A-Za-z0-9._-]+$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Repositories with the commit each is analysed at: sorted by name, one commit per repository, full SHAs only. */
export function reposOf(repos: RepoAtCommit[]) {
  if (!Array.isArray(repos) || !repos.length)
    throw new KeyError("at least one repository is required");
  const byName = new Map<string, string>();
  for (const r of repos) {
    const name = required("repository", r?.repo, 100);
    if (!REPO.test(name) || name === "." || name === "..")
      throw new KeyError(`invalid repository name "${name}"`);
    const commit = required("commit", r.commit, 64).toLowerCase();
    if (!COMMIT.test(commit)) throw new KeyError(`commit of ${name} must be a full SHA`);
    if (byName.has(name) && byName.get(name) !== commit)
      throw new KeyError(`repository ${name} is listed at two different commits`);
    byName.set(name, commit);
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([repo, commit]) => `${repo}@${commit}`);
}

/** The focus text of a code assessment: NFC, trimmed, whitespace collapsed, lower-case. Empty = the whole repository. */
export function normalizeFocus(focus: string | null | undefined) {
  return String(focus ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The project name of a code assessment: NFC, trimmed, whitespace collapsed, lower-case. Empty = no project. */
export function normalizeProject(project: string | null | undefined) {
  const p = String(project ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (p.length > 200) throw new KeyError("project is too long");
  return p;
}

function localeOf(locale: string | null | undefined) {
  try {
    return resolveOutputLocale(locale);
  } catch (e) {
    throw new KeyError((e as Error).message);
  }
}

export interface RubricInput {
  /** The step's instruction text of the workflow version (the prompt this analysis is held to). */
  instructions: string;
  /** The step's output contract text, when it has one. */
  outputContract?: string;
  /** Skills and knowledge the step is pinned to, with the versions in effect. */
  pinned?: Array<{ key: string; version: number }>;
}

/**
 * The hash that stands for "the prompt and rubric": instructions and output contract (line endings and trailing
 * whitespace normalized, nothing else touched) plus the pinned skills and knowledge with their versions. Live knowledge
 * content that is not pinned is deliberately not part of it.
 */
export function rubricHash(input: RubricInput) {
  const text = (s: string | undefined) =>
    String(s ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .trim();
  const pinned = [...new Map((input.pinned ?? []).map((p) => [`${p.key}`, p.version])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, version]) => {
      if (!Number.isInteger(version) || version < 1)
        throw new KeyError(`pinned version of ${key} must be a positive integer`);
      return `${key}@${version}`;
    });
  return sha256(
    canonicalJson({
      instructions: text(input.instructions),
      output_contract: text(input.outputContract),
      pinned,
    }),
  );
}

function build(kind: SharedKind, parts: Record<string, unknown>): SharedKey {
  const full = { v: KEY_VERSION, kind, ...parts };
  return { kind, key: sha256(canonicalJson(full)), parts: full };
}

export const SHARED_PROFILES = ["MICRO", "FAST", "STANDARD", "DEEP"] as const;
export type SharedProfile = (typeof SHARED_PROFILES)[number];
const PROFILES = new Set<string>(SHARED_PROFILES);

/** Execution profile normalized and validated for keys (default STANDARD so omitted matches default). */
export function profileOf(profile: string | null | undefined): SharedProfile {
  if (profile == null) return "STANDARD";
  const p = typeof profile === "string" ? profile.trim().toUpperCase() : "";
  if (!p) return "STANDARD";
  if (!PROFILES.has(p)) throw new KeyError(`invalid profile: ${profile}`);
  return p as SharedProfile;
}

export interface RuntimeRcaKeyInput {
  scope: string;
  /** The group fingerprint. */
  errorKey: string;
  workflow: WorkflowRef;
  /** unified.ts VERIFICATION_CONTRACT: a change to the evidence-validity rules invalidates every RCA. */
  contract: string;
  rubricHash: string;
  /** From `modelOf`. */
  model: string;
  /** Execution profile (MICRO|FAST|STANDARD|DEEP). Omitted/empty → STANDARD. */
  profile?: string | null;
}
export function runtimeRcaKey(i: RuntimeRcaKeyInput): SharedKey {
  return build("prod_error.runtime_rca", {
    scope: scopeOf(i.scope),
    error: errorKeyOf(i.errorKey),
    workflow: workflowOf(i.workflow),
    contract: required("contract", i.contract, 60),
    rubric: hashOf("rubric hash", i.rubricHash),
    model: required("model", i.model, 200),
    profile: profileOf(i.profile),
  });
}

export interface BugHuntKeyInput {
  scope: string;
  errorKey: string;
  repos: RepoAtCommit[];
  workflow: WorkflowRef;
  rubricHash: string;
  model: string;
  profile?: string | null;
}
export function bugHuntKey(i: BugHuntKeyInput): SharedKey {
  return build("prod_error.bug_hunt", {
    scope: scopeOf(i.scope),
    error: errorKeyOf(i.errorKey),
    repos: reposOf(i.repos),
    workflow: workflowOf(i.workflow),
    rubric: hashOf("rubric hash", i.rubricHash),
    model: required("model", i.model, 200),
    profile: profileOf(i.profile),
  });
}

export interface CodeAssessmentKeyInput {
  scope: string;
  repos: RepoAtCommit[];
  focus?: string | null;
  project?: string | null;
  outputLocale?: string | null;
  profile?: string | null;
  workflow: WorkflowRef;
  rubricHash: string;
  model: string;
}
export function codeAssessmentKey(i: CodeAssessmentKeyInput): SharedKey {
  return build("code_assessment", {
    scope: scopeOf(i.scope),
    repos: reposOf(i.repos),
    focus: normalizeFocus(i.focus),
    project: normalizeProject(i.project),
    locale: localeOf(i.outputLocale),
    profile: profileOf(i.profile),
    workflow: workflowOf(i.workflow),
    rubric: hashOf("rubric hash", i.rubricHash),
    model: required("model", i.model, 200),
  });
}
