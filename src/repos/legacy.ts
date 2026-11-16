import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repositories } from "./service.ts";
import { resolveRepoPath } from "./paths.ts";
import { legacyBitbucketHttpsUrl, repositoryRemote } from "./remote.ts";
import { pool, q } from "../db/pool.ts";

const exec = promisify(execFile);
/** Explicit operator action only. Discovery at startup never rewrites shared identity. */
export async function migrateLegacyRepositories(apply = false) {
  const all = await repositories.list();
  const report = await Promise.all(all.map(async (repo) => {
    const result = { id: repo.id, name: repo.name, existing_local_path: "", detected_remote_url: null as string | null, proposed_canonical_url: repo.repository_url ?? null, status: repo.repository_url ? "configured" : "unresolved", warnings: [] as string[] };
    if (["benchmark", "local"].includes(repo.provider)) { result.status = "local_fixture"; return result; }
    if (repo.repository_url) return result;
    try {
      const path = resolveRepoPath(repo);
      result.existing_local_path = path;
      const raw = (await exec("git", ["-C", path, "config", "--no-includes", "--get", "remote.origin.url"], { timeout: 5000 })).stdout.trim();
      // Migration may translate the exact Bitbucket SSH syntax; new registration remains HTTPS only.
      const candidate = legacyBitbucketHttpsUrl(raw);
      const remote = repositoryRemote(candidate);
      result.detected_remote_url = remote.url;
      result.proposed_canonical_url = remote.url;
      result.status = "proposed";
    } catch { result.warnings.push("No accessible validated Bitbucket origin; configure explicitly. Nothing was inferred from the name."); }
    return result;
  }));
  for (const item of report.filter((r) => r.status === "proposed")) {
    if (report.some((r) => r.id !== item.id && r.proposed_canonical_url === item.proposed_canonical_url)) {
      item.status = "ambiguous";
      item.warnings.push("Duplicate canonical remote; existing rows are preserved for administrator review");
    }
  }
  if (apply) for (const item of report.filter((r) => r.status === "proposed")) {
    try {
      const remote = repositoryRemote(item.proposed_canonical_url);
      const rows = await q(pool, "UPDATE repositories SET repository_url=$2,remote_slug=$3,updated_at=now() WHERE id=$1 AND repository_url IS NULL RETURNING id", [item.id, remote.url, `${remote.workspace}/${remote.slug}`]);
      item.status = rows.length ? "applied" : "changed_since_scan";
    } catch { item.status = "conflict"; item.warnings.push("Concurrent registration or update; rescan before applying"); }
  }
  return report;
}
