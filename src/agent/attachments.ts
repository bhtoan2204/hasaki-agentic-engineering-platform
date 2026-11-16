import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.ts";
import { taskDir } from "../git.ts";

/** Download Hasaki task attachments (note_files) next to the worktrees. Moved unchanged from the old agent.ts. */
export async function downloadAttachments(dirKey: string, d: any, workspace?: string): Promise<string[]> {
  const files: string[] = d?.note_files ?? [];
  if (!files.length || !config.fileBaseUrl) return files.map((f) => `${f} (not downloaded: fileBaseUrl not configured)`);
  const dir = join(workspace ?? taskDir(dirKey), "_attachments");
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    try {
      const res = await fetch(config.fileBaseUrl.replace(/\/$/, "") + "/" + f);
      if (!res.ok) throw new Error(String(res.status));
      const p = join(dir, basename(f));
      writeFileSync(p, Buffer.from(await res.arrayBuffer()));
      out.push(p);
    } catch (e) {
      out.push(`${f} (download failed: ${(e as Error).message})`);
    }
  }
  return out;
}
