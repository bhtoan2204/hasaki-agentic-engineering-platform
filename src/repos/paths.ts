import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";

const exec = promisify(execFile);
export interface LocalRepository { name: string; path?: string; remote_slug?: string }

/** Shared path is a legacy relative layout hint only. Explicit LOCAL overrides always win. */
export function resolveRepoPath(repo: LocalRepository, local = config): string {
  if (!/^[A-Za-z0-9._-]+$/.test(repo.name) || [".", ".."].includes(repo.name)) throw new Error("Invalid repository name");
  const override = local.repositories?.[repo.name];
  if (override !== undefined) {
    if (typeof override !== "string" || !override.trim() || !isAbsolute(override)) throw new Error(`repositories.${repo.name} must be an absolute local checkout path`);
    return resolve(override);
  }
  const hint = repo.path || repo.name;
  const path = resolve(local.reposRoot, hint);
  const rel = relative(resolve(local.reposRoot), path);
  if (isAbsolute(hint) || rel === ".." || rel.startsWith("../")) throw new Error(`Unsafe shared path for ${repo.name}; set a local repositories override`);
  return path;
}

const slugOf = (remote: string) => remote.replace(/\.git\/?$/, "").replace(/\/$/, "").replace(/^.*(?:[:/])([^/:]+\/[^/]+)$/, "$1").toLowerCase();
export async function validateCheckout(repo: LocalRepository): Promise<string> {
  const path = resolveRepoPath(repo);
  if (!existsSync(join(path, ".git"))) throw new Error(`Repository ${repo.name} unavailable locally; configure repositories.${repo.name} in PLATFORM_CONFIG`);
  await exec("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  let remote = "";
  try { remote = (await exec("git", ["-C", path, "remote", "get-url", "origin"])).stdout.trim(); } catch { /* No origin: local-only fixture/checkout. */ }
  if (remote && repo.remote_slug) {
    const actual = slugOf(remote), expected = slugOf(repo.remote_slug);
    if (expected.includes("/") ? actual !== expected : actual.split("/").pop() !== expected) throw new Error(`Repository ${repo.name} origin does not match shared remote_slug; fix the local mapping or remote`);
  }
  return realpathSync(path);
}
