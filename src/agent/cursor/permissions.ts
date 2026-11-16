import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Project permission file the installed CLI actually reads: `<workspace>/.cursor/cli.json`.
 * Deny rules win over allow rules, including when --force is set (Cursor docs: --force allows commands unless explicitly denied).
 * --force is NOT the policy. Print mode will not apply file edits without it (headless docs), so coding mode passes --force
 * only together with this file and the stream watcher. Analysis mode does not pass --force and uses --mode ask.
 */
export function writeCursorPolicy(workspace: string, opts: { reposRoot: string; protectedRoots?: string[]; workspaces: string[] }): string {
  const dir = join(workspace, ".cursor");
  mkdirSync(dir, { recursive: true });
  const deny = [
    "Shell(git:push*)",
    "Shell(git:reset*)",
    "Shell(git:clean*)",
    "Shell(sudo)",
    "Shell(rm)",
    "Read(**/.env*)",
    "Read(**/mcp.json)",
    "Read(**/cli.json)",
    "Write(**/.env*)",
    "Write(**/*.key)",
    "Write(**/mcp.json)",
    "Write(**/cli.json)",
    "Write(**/.git/**)",
  ];
  for (const root of new Set([opts.reposRoot, ...(opts.protectedRoots ?? [])])) if (root) deny.push(`Write(${root}/**)`);
  const allow = ["Mcp(platform:*)", ...opts.workspaces.map((w) => `Write(${w}/**)`)];
  const file = join(dir, "cli.json");
  writeFileSync(file, JSON.stringify({ permissions: { allow, deny } }, null, 2));
  return file;
}

export function writeMcpConfig(workspace: string, command: string, args: string[], env: Record<string, string>): string {
  const dir = join(workspace, ".cursor");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        platform: { type: "stdio", command, args, env },
      },
    }, null, 2),
  );
  return file;
}

export function excludeFromGit(gitDir: string) {
  const exclude = join(gitDir, "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(exclude, "utf8");
  } catch { }
  const line = ".cursor/mcp.json\n.cursor/cli.json\n";
  if (!cur.includes(".cursor/mcp.json")) writeFileSync(exclude, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + line);
}
