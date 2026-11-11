import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { legacyBitbucketHttpsUrl, repositoryRemote } from "./remote.ts";
import { config } from "../config.ts";

const exec = promisify(execFile);
/** Containment checks accept either OS separator; drive/UNC paths must never become relative hints. */
export const unsafeRelativePath = (path: string) =>
  isAbsolute(path) || /^(?:[A-Za-z]:|[\\/]|\.\.(?:[\\/]|$))/.test(path);
export interface LocalRepository {
  id?: number;
  name: string;
  path?: string;
  remote_slug?: string;
  repository_url?: string | null;
  default_branch?: string;
  provider?: string;
}

/** Canonical remotes resolve by instance/repository ID; local overrides apply only to legacy entries. */
export function resolveRepoPath(repo: LocalRepository, local = config): string {
  if (!/^[A-Za-z0-9._-]+$/.test(repo.name) || [".", ".."].includes(repo.name))
    throw new Error("Invalid repository name");
  if (repo.provider === "benchmark" && /^bench-[a-f0-9]{12}-fixture-[a-z-]+$/.test(repo.name))
    return resolve(local.dataDir, "evaluation-fixtures", repo.name);
  // Canonical remotes always use worker-managed storage; legacy local overrides remain transitional.
  if (repo.repository_url) {
    repositoryRemote(repo.repository_url);
    if (!/^\d+$/.test(String(repo.id)) || Number(repo.id) < 1)
      throw new Error("Repository ID required");
    return resolve(
      local.dataDir,
      "repositories",
      instanceDirectory(local.instanceId),
      String(repo.id),
      "checkout",
    );
  }
  const override = local.repositories?.[repo.name];
  if (override !== undefined) {
    if (typeof override !== "string" || !override.trim() || !isAbsolute(override))
      throw new Error(`repositories.${repo.name} must be an absolute local checkout path`);
    return resolve(override);
  }
  const hint = repo.path || repo.name;
  const path = resolve(local.reposRoot, hint);
  const rel = relative(resolve(local.reposRoot), path);
  if (unsafeRelativePath(hint) || unsafeRelativePath(rel))
    throw new Error(`Unsafe shared path for ${repo.name}; set a local repositories override`);
  // A shared legacy layout may describe another developer's machine. Prefer the conventional
  // local checkout only when that legacy location is absent; explicit overrides always win.
  const conventional = resolve(local.reposRoot, repo.name);
  if (hint !== repo.name && !existsSync(path) && existsSync(join(conventional, ".git")))
    return conventional;
  return path;
}

export const instanceDirectory = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 32);

const slugOf = (remote: string) =>
  remote
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
    .replace(/^.*(?:[:/])([^/:]+\/[^/]+)$/, "$1")
    .toLowerCase();
export async function validateCheckout(
  repo: LocalRepository,
  persistedPath?: string,
): Promise<string> {
  const path = persistedPath ?? resolveRepoPath(repo);
  if (!existsSync(join(path, ".git")))
    throw new Error(
      `Repository ${repo.name} unavailable locally; configure repositories.${repo.name} in PLATFORM_CONFIG`,
    );
  const top = (
    await exec("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      path,
      "rev-parse",
      "--show-toplevel",
    ])
  ).stdout.trim();
  if (realpathSync(top) !== realpathSync(path)) throw new Error("Checkout ownership mismatch");
  let remote = "";
  try {
    remote = (
      await exec("git", ["-C", path, "config", "--no-includes", "--get", "remote.origin.url"])
    ).stdout.trim();
  } catch {
    /* No origin: local-only fixture/checkout. */
  }
  if (repo.repository_url) {
    let actual: string;
    try {
      actual = repositoryRemote(persistedPath ? legacyBitbucketHttpsUrl(remote) : remote).url;
    } catch {
      throw new Error(`Repository ${repo.name} remote mismatch`);
    }
    if (actual !== repositoryRemote(repo.repository_url).url)
      throw new Error(`Repository ${repo.name} remote mismatch`);
    const root = realpathSync(
      persistedPath ? config.repositories?.[repo.name] || config.reposRoot : config.dataDir,
    );
    const rel = relative(root, realpathSync(path));
    const common = (
      await exec("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    const allowed = [root, realpathSync(config.dataDir)];
    if (
      !allowed.some((r) => {
        const p = relative(r, realpathSync(common));
        return !unsafeRelativePath(p);
      })
    )
      throw new Error("Checkout Git directory escapes authorized local roots");
    const managed = relative(realpathSync(config.dataDir), realpathSync(path));
    if (unsafeRelativePath(rel) && unsafeRelativePath(managed))
      throw new Error("Checkout escapes authorized local roots");
  }
  if (!repo.repository_url && remote && repo.remote_slug) {
    const actual = slugOf(remote),
      expected = slugOf(repo.remote_slug);
    if (expected.includes("/") ? actual !== expected : actual.split("/").pop() !== expected)
      throw new Error(
        `Repository ${repo.name} origin does not match shared remote_slug; fix the local mapping or remote`,
      );
  }
  return realpathSync(path);
}
