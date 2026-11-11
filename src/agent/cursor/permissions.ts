import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Environment files that hold real values. Templates (.env.example, .env.sample, .env.template, .env.dist) stay
 * readable and editable: they document the configuration keys a change may need to add. Deny rules win over allow
 * rules in Cursor, so the secret names are listed instead of denying `.env*` and carving out exceptions.
 */
export const SECRET_ENV_FILES = [
  ".env",
  ".envrc",
  ".env.local",
  ".env.*.local",
  ".env.prod*",
  ".env.live*",
  ".env.stag*",
  ".env.uat*",
  ".env.qc*",
  ".env.dev*",
  ".env.test*",
];

/**
 * Project permission file the installed CLI actually reads: `<workspace>/.cursor/cli.json`.
 * Deny rules win over allow rules, including when --force is set (Cursor docs: --force allows commands unless explicitly denied).
 * --force is NOT the policy. Print mode will not apply file edits without it (headless docs), so coding mode passes --force
 * only together with this file and the stream watcher. Analysis mode does not pass --force and uses --mode ask.
 */
export function writeCursorPolicy(
  workspace: string,
  opts: { reposRoot: string; protectedRoots?: string[]; workspaces: string[] },
): string {
  const dir = join(workspace, ".cursor");
  mkdirSync(dir, { recursive: true });
  const deny = [
    "Shell(git:push*)",
    "Shell(git:reset*)",
    "Shell(git:clean*)",
    "Shell(sudo)",
    "Shell(rm)",
    ...SECRET_ENV_FILES.map((g) => `Read(**/${g})`),
    "Read(**/mcp.json)",
    "Read(**/cli.json)",
    ...SECRET_ENV_FILES.map((g) => `Write(**/${g})`),
    "Write(**/*.key)",
    "Write(**/mcp.json)",
    "Write(**/cli.json)",
    "Write(**/.git/**)",
  ];
  for (const root of new Set([opts.reposRoot, ...(opts.protectedRoots ?? [])]))
    if (root) deny.push(`Write(${root}/**)`);
  const allow = ["Mcp(platform:*)", ...opts.workspaces.map((w) => `Write(${w}/**)`)];
  const file = join(dir, "cli.json");
  writeFileSync(file, JSON.stringify({ permissions: { allow, deny } }, null, 2));
  return file;
}

export function writeMcpConfig(
  workspace: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): string {
  const dir = join(workspace, ".cursor");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcp.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        mcpServers: {
          platform: { type: "stdio", command, args, env },
        },
      },
      null,
      2,
    ),
  );
  return file;
}

export function excludeFromGit(gitDir: string) {
  const exclude = join(gitDir, "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  let cur = "";
  try {
    cur = readFileSync(exclude, "utf8");
  } catch {}
  const line = ".cursor/mcp.json\n.cursor/cli.json\n";
  if (!cur.includes(".cursor/mcp.json"))
    writeFileSync(exclude, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + line);
}
