import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repositories } from "../repos/service.ts";
import { prepareRepository } from "../repos/workspaces.ts";

const exec = promisify(execFile);

/**
 * Is `commit` a descendant of `ancestor` in the registered repository `repo`? true / false from git, null when it cannot
 * be told (unknown repository, no checkout, a commit the checkout does not have, git failing or timing out). Callers treat
 * null as "keep": nothing is marked stale on a guess.
 */
export async function isDescendant(
  repo: string,
  ancestor: string,
  commit: string,
): Promise<boolean | null> {
  try {
    const repository = await repositories.get(repo);
    if (!repository) return null;
    const path = await prepareRepository(repository);
    await exec("git", ["-C", path, "merge-base", "--is-ancestor", ancestor, commit], {
      timeout: 30_000,
    });
    return true;
  } catch (e) {
    // git merge-base --is-ancestor: exit 1 is "not an ancestor"; any other failure (128: unknown commit) is unknown.
    return (e as { code?: unknown }).code === 1 ? false : null;
  }
}
