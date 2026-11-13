import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

export interface NativeKnowledgeSource {
  repo: string;
  path: string;
  sha256: string;
}

export async function detectNativeKnowledgeSources(
  roots: Array<{ repo: string; path: string }>,
): Promise<NativeKnowledgeSource[]> {
  const sources: NativeKnowledgeSource[] = [];
  for (const root of roots) {
    const canonical = await realpath(root.path).catch(() => null);
    if (!canonical) continue;
    const rules = await readdir(join(canonical, ".cursor/rules"), { withFileTypes: true }).catch(
      () => [],
    );
    const paths = [
      "AGENTS.md",
      ...rules
        .filter((e) => e.isFile())
        .slice(0, 100)
        .map((e) => `.cursor/rules/${e.name}`),
    ];
    for (const path of paths) {
      const full = join(canonical, path);
      const stat = await lstat(full).catch(() => null);
      const target = await realpath(full).catch(() => null);
      if (
        !stat?.isFile() ||
        stat.size > 1000000 ||
        !target ||
        relative(canonical, target).startsWith("..")
      )
        continue;
      const content = await readFile(full).catch(() => null);
      if (content)
        sources.push({
          repo: root.repo,
          path,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
    }
  }
  return sources;
}
