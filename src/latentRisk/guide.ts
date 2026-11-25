import { config } from "../config.ts";
import { repositories, repositoryBaseBranch } from "../repos/service.ts";
import { checkoutForRun, prepareRepository } from "../repos/workspaces.ts";
import type { LatentRisk } from "./detectors.ts";
import { formatRisks, scanChanged, scanRef } from "./scan.ts";

export interface LatentRiskGuide {
  text: string;
  repos: Array<{ repo: string; candidates: number; error?: string }>;
}

/**
 * The probe's candidates as one prompt section. Best effort: a repository that cannot be read is reported and skipped,
 * and the step never fails because of the probe.
 *  - "repository": the Go source of each selected repository at the commit the run pinned (an assessment);
 *  - "diff": what each run worktree adds to its base branch (a review).
 */
export async function latentRiskGuide(o: {
  mode: "repository" | "diff";
  runId: number;
  repos: string[];
  pins: Record<string, string>;
  worktrees: Array<{ repo: string; path: string }>;
  signal?: AbortSignal;
}): Promise<LatentRiskGuide> {
  const sections: Array<{ repo: string; risks: LatentRisk[] }> = [];
  const repos: LatentRiskGuide["repos"] = [];
  const targets = o.mode === "diff" ? o.worktrees.map((w) => w.repo) : o.repos;
  for (const repo of targets) {
    try {
      let risks: LatentRisk[];
      if (o.mode === "diff") {
        const path = o.worktrees.find((w) => w.repo === repo)!.path;
        risks = await scanChanged(path, `origin/${await repositoryBaseBranch(repo)}`, o.signal);
      } else {
        const reg = await repositories.get(repo);
        if (!reg?.enabled || !reg.allowed_actions.includes("read")) continue;
        const path = await prepareRepository(reg, false, await checkoutForRun(reg, o.runId));
        const ref = o.pins[repo] ?? `origin/${reg.default_branch || config.baseBranch}`;
        risks = await scanRef(path, ref, o.signal);
      }
      sections.push({ repo, risks });
      repos.push({ repo, candidates: risks.length });
    } catch (e) {
      repos.push({ repo, candidates: 0, error: (e as Error).message.split("\n")[0] });
    }
  }
  return { text: formatRisks(sections, o.mode), repos };
}
