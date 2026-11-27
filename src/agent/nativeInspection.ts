import { resolve } from "node:path";
import { decide, type Decision, type PolicyContext } from "./toolPolicy.ts";

const INSPECTION: Record<string, "Read" | "Glob" | "Grep"> = {
  list_dir: "Read",
  glob: "Glob",
  grep: "Grep",
  search_files: "Grep",
};
const PATH_KEYS = ["Path", "path", "SearchPath", "DirectoryPath", "directory", "dir", "file_path"];

/**
 * Provider-native directory and search tools go through decide() like Read/Glob/Grep, so the loop detector, the
 * tool budget and the secret-path rule apply to them. Returns null for any other tool.
 */
export function decideNativeInspection(
  tool: string,
  args: Record<string, unknown>,
  policy: PolicyContext,
  sessionCwd: string,
  secretDenial: (text: string) => string | null,
): Decision | null {
  const mapped = INSPECTION[tool];
  if (!mapped) return null;
  const paths = PATH_KEYS.flatMap((key) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? [value] : [];
  });
  for (const p of paths) {
    const secret = secretDenial(p);
    if (secret) return { allow: false, reason: secret };
  }
  const input = { ...args, ...(paths.length ? { path: resolve(sessionCwd, paths[0]!) } : {}) };
  for (const p of paths.slice(1)) {
    const d = decide(mapped, { path: resolve(sessionCwd, p) }, policy, sessionCwd);
    if (!d.allow) return d;
  }
  return decide(mapped, input, policy, sessionCwd);
}
