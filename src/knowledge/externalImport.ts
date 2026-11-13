import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { one, pool, q, withTx, json } from "../db/pool.ts";
import { hashOf } from "../workflow/definitions.ts";
import { looksSecret, skillCandidates, type ImportCandidate } from "./importer.ts";
import { scanSkillText } from "./external.ts";
import { knowledge } from "./service.ts";

/** skills/external/manifest.json (see skills/external/NOTICE.md). */
export interface ExternalManifestSkill {
  key: string;
  name: string;
  conflict_key?: string;
  pilot?: string;
  origin: Record<string, unknown> & { repo: string; commit: string; path: string; license: string };
  status: "active" | "blocked";
  block_reason?: string;
  runtime: { binaries: string[]; network: boolean; scripts: boolean };
  providers: Record<string, string>;
  applicability: Record<string, unknown>;
  supersedes: string[];
  files: Array<{ file: string; sha256: string | null; upstream_sha256: string; modified: boolean }>;
}

export interface ExternalPlan {
  candidates: ImportCandidate[];
  supersedes: Array<{ key: string; by: string }>;
  rejected: Array<{ key: string; file: string; reason: string }>;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export const readManifest = (root: string): ExternalManifestSkill[] =>
  JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).skills;

/**
 * Registry items for every manifest skill (no DB). A skill is rejected as a whole when a file is missing, differs from
 * the hash recorded in the manifest (edited without review) or fails the content scan. Only Markdown is imported;
 * blocked skills become a stub that states why (their upstream text never enters the registry).
 */
export function planExternalSkills(root: string, only?: string): ExternalPlan {
  const plan: ExternalPlan = { candidates: [], supersedes: [], rejected: [] };
  for (const s of readManifest(root)) {
    if (only && s.name !== only && s.key !== only) continue;
    const meta = {
      origin: { type: "external", ...s.origin },
      status: s.status,
      ...(s.pilot ? { pilot: s.pilot } : {}),
      ...(s.block_reason ? { block_reason: s.block_reason } : {}),
      runtime: s.runtime,
      providers: s.providers,
    };
    if (s.status !== "active") {
      plan.candidates.push({
        key: s.key,
        category: "agent_skill",
        scope_type: "GLOBAL",
        title: `Skill: ${s.name} (third-party, blocked)`,
        content:
          `This third-party skill (${s.origin.repo} ${s.origin.path}) is registered but blocked on this platform: ` +
          `${s.block_reason}. It is never given to an agent; a step that assigns it fails with this reason.`,
        applicability: s.applicability,
        metadata: {
          ...meta,
          load: "on_demand",
          description: `Blocked: ${s.block_reason}`.slice(0, 600),
        },
        source: [
          {
            repo: s.origin.repo,
            path: `${s.origin.path}/SKILL.md`,
            sha256: s.files[0]?.upstream_sha256 ?? "",
          },
        ],
      });
      continue;
    }
    const dir = join(root, s.name);
    const texts = new Map<string, string>();
    const errors: Array<{ file: string; reason: string }> = [];
    for (const f of s.files) {
      const path = join(dir, f.file);
      if (!f.file.endsWith(".md"))
        errors.push({ file: f.file, reason: "only Markdown files are imported" });
      else if (!existsSync(path)) errors.push({ file: f.file, reason: "missing" });
      else {
        const text = readFileSync(path, "utf8");
        if (sha(text) !== f.sha256)
          errors.push({
            file: f.file,
            reason: "content differs from the manifest hash (update the manifest after review)",
          });
        for (const finding of scanSkillText(text))
          errors.push({ file: f.file, reason: `security scan: ${finding}` });
        if (looksSecret(text))
          errors.push({ file: f.file, reason: "security scan: contains what looks like a secret" });
        texts.set(f.file, text);
      }
    }
    if (!texts.has("SKILL.md") && !errors.length)
      errors.push({ file: "SKILL.md", reason: "missing" });
    if (errors.length) {
      plan.rejected.push(...errors.map((e) => ({ key: s.key, ...e })));
      continue;
    }
    const items = skillCandidates({
      key: s.key,
      name: s.name,
      text: texts.get("SKILL.md")!,
      companions: [...texts]
        .filter(([f]) => f !== "SKILL.md")
        .map(([rel, text]) => ({ rel, text })),
      titleSuffix: " (third-party)",
      scope: { scope_type: "GLOBAL" },
      applicability: s.applicability,
      sources: [{ repo: s.origin.repo, dir: s.origin.path, mainFile: "SKILL.md" }],
    });
    for (const c of items) {
      if (s.conflict_key) c.conflict_key = s.conflict_key;
      if (s.pilot === "ponytail") c.priority = 10;
      const file = (c.metadata as any)?.skill_file ?? "SKILL.md";
      const f = s.files.find((x) => x.file === file);
      c.source = c.source.map((x) => ({ ...x, sha256: f?.upstream_sha256 ?? x.sha256 }));
      c.metadata = {
        ...c.metadata,
        ...meta,
        origin: { ...meta.origin, file, modified: !!f?.modified },
      };
    }
    plan.candidates.push(...items);
    for (const old of s.supersedes) plan.supersedes.push({ key: old, by: s.key });
  }
  return plan;
}

/** Upstream integrity: each manifest upstream_sha256 against a directory of upstream clones (clone dir per repo name). */
export function verifyUpstream(root: string, clones: Record<string, string>) {
  const out: Array<{ key: string; file: string; ok: boolean; detail: string }> = [];
  for (const s of readManifest(root)) {
    const base = clones[s.origin.repo];
    for (const f of s.files) {
      const path = base ? join(base, s.origin.path, f.file) : "";
      if (!base || !existsSync(path)) {
        out.push({ key: s.key, file: f.file, ok: false, detail: "upstream file not found" });
        continue;
      }
      const ok = sha(readFileSync(path)) === f.upstream_sha256;
      out.push({
        key: s.key,
        file: f.file,
        ok,
        detail: ok ? "matches upstream" : "upstream hash differs",
      });
    }
  }
  return out;
}

export interface ExternalApplyReport {
  rows: Array<{
    key: string;
    action: "create" | "update" | "unchanged" | "skipped";
    note?: string;
  }>;
  superseded: Array<{ key: string; by: string; action: "set" | "unchanged" | "missing" }>;
}

/** Create/update the shared items (new version only on change) and record supersession of replaced skills. */
export async function applyExternalSkills(
  plan: ExternalPlan,
  opts: { dryRun?: boolean; by?: string } = {},
): Promise<ExternalApplyReport> {
  const by = opts.by ?? "external skill import";
  const report: ExternalApplyReport = { rows: [], superseded: [] };
  const deleted = await knowledge.deletedKeys();
  for (const c of plan.candidates) {
    const parent = (c.metadata as any)?.parent_skill as string | undefined;
    if (deleted.has(c.key) || (parent && deleted.has(parent))) {
      report.rows.push({ key: c.key, action: "skipped", note: "deleted from the registry" });
      continue;
    }
    const { source, ...item } = c;
    const metadata = { ...item.metadata, source };
    const existing = await knowledge.get(c.key);
    const v = existing?.versions[0];
    const same =
      !!v &&
      v.content === c.content &&
      hashOf(v.applicability ?? {}) === hashOf(c.applicability ?? {}) &&
      hashOf(v.metadata ?? {}) === hashOf(metadata) &&
      existing.scope_type === c.scope_type &&
      existing.title === c.title &&
      (existing.conflict_key ?? null) === (c.conflict_key ?? null);
    const action = !existing ? "create" : same ? "unchanged" : "update";
    report.rows.push({ key: c.key, action });
    if (opts.dryRun || action === "unchanged") continue;
    const note = `third-party skill ${(metadata as any).origin.repo}@${String((metadata as any).origin.commit).slice(0, 7)}`;
    if (action === "create")
      await knowledge.create({
        ...item,
        metadata,
        created_by: by,
        change_note: `imported ${note}`,
      });
    else
      await knowledge.update(c.key, {
        title: c.title,
        conflict_key: c.conflict_key,
        priority: c.priority,
        content: c.content,
        applicability: c.applicability ?? {},
        metadata,
        scope_type: c.scope_type,
        scope_ref: "",
        change_note: `re-imported ${note}`,
        created_by: by,
      });
  }
  for (const s of plan.supersedes) {
    const old = await one(
      pool,
      "SELECT id, superseded_by FROM knowledge_items WHERE key = $1 AND owner_id IS NULL",
      [s.key],
    );
    const succ = await one(
      pool,
      "SELECT id FROM knowledge_items WHERE key = $1 AND owner_id IS NULL",
      [s.by],
    );
    if (!old || (!succ && !opts.dryRun)) {
      report.superseded.push({ ...s, action: "missing" });
      continue;
    }
    if (succ && Number(old.superseded_by) === Number(succ.id)) {
      report.superseded.push({ ...s, action: "unchanged" });
      continue;
    }
    report.superseded.push({ ...s, action: "set" });
    if (opts.dryRun) continue;
    await withTx(async (c) => {
      await q(
        c,
        "UPDATE knowledge_items SET superseded_by = $2, superseded_at = now(), updated_at = now() WHERE id = $1",
        [old.id, succ.id],
      );
      await q(
        c,
        "INSERT INTO knowledge_audit (item_id, action, detail) VALUES ($1, 'superseded', $2)",
        [old.id, json({ by: s.by, source: by })],
      );
    });
  }
  return report;
}
