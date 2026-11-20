/**
 * Types of the repository knowledge import shared by its engines (src/knowledge/importer.ts, the TypeScript
 * discovery; src/knowledge/goKnowledge.ts, platform-go) and the contract
 * go/contracts/knowledge-v1.schema.json.
 */
import type { KnowledgeInput } from "./service.ts";

/** Characters of one source document kept (JavaScript string length); longer files are truncated and reported. */
export const MAX_CHARS = 60_000;

/**
 * Bounds of one scan, the same for both engines (ADR 0007): a file larger than maxFileBytes is skipped (it is never
 * imported unscanned); a repository that exceeds maxEntries or the scan that exceeds maxTotalBytes or deadlineMs stops
 * there and is reported incomplete — its items are never retired.
 */
export const SCAN_LIMITS = {
  maxFileBytes: 1 << 20,
  maxEntries: 20_000,
  maxTotalBytes: 512 << 20,
  deadlineMs: 120_000,
};

export interface ImportCandidate extends KnowledgeInput {
  source: { repo: string; path: string; sha256: string }[];
}

export interface ImportReport {
  candidates: Array<{
    key: string;
    title: string;
    category: string;
    scope: string;
    repos: string[];
    chars: number;
    action: "create" | "update" | "unchanged" | "retire" | "registry_newer" | "conflict";
    proposal_id?: number;
  }>;
  skipped: Array<{ path: string; reason: string }>;
  created: number;
  updated: number;
  unchanged: number;
  retired: number;
  /** Evolved in the registry, repository file changed too: a proposal was opened instead of overwriting. */
  conflicts: number;
  /** Repositories whose scan stopped early (budget, deadline): nothing of theirs was retired. */
  incomplete?: string[];
}

/** Where a discovered candidate applies; resolved by assembleCandidates(). */
export type ScopeTarget =
  /** The source repository itself: REPOSITORY scope, no applicability. */
  | { kind: "repository"; repo: string }
  /** Identical skill copies: scopeForRepositories(repos). */
  | { kind: "repositories"; repos: string[] }
  /** A wiki's conventions: the code repositories it documents (scopeForRepositories). */
  | { kind: "wiki_siblings"; repo: string }
  /** A wiki's docs: the projects of its group (scopeForProjects). */
  | { kind: "wiki_projects"; repo: string }
  /** A user-level (~/.claude) skill, or a repository skill also found there: scopeForUserSkill + enable policy. */
  | { kind: "user_skill"; name: string };

export type DiscoveredCandidate = Omit<
  ImportCandidate,
  "scope_type" | "scope_ref" | "applicability" | "enabled"
> & { target: ScopeTarget };

export interface Discovery {
  candidates: DiscoveredCandidate[];
  skipped: ImportReport["skipped"];
  /** Repositories scanned completely: only these take part in retirement. */
  scanned: string[];
  /** Repositories whose scan stopped early (budget, deadline): never a reason to retire anything. */
  incomplete: string[];
}

/** A repository TypeScript selected and authorized for the scan. */
export interface DiscoveryRepository {
  name: string;
  root: string;
  /** This installation's own checkout (its docs/architecture is imported too). */
  self: boolean;
}
