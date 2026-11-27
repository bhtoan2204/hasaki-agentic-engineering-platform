import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config.ts";
import { taskDir } from "../git.ts";
import { DOCUMENT_TYPES, extractDocument, sniffDocument } from "../chat/documents.ts";

const READABLE = new Set<string>([DOCUMENT_TYPES.pdf, DOCUMENT_TYPES.docx, DOCUMENT_TYPES.xlsx]);

/** The agent's shell cannot unzip or parse office files: write their text next to them. */
function textCopy(path: string, bytes: Buffer): string[] {
  const type = sniffDocument(bytes, path);
  if (!type || !READABLE.has(type)) return [];
  const x = extractDocument(bytes, type);
  if (!x.sections.length)
    return [`${path} (no extractable text${x.warnings.length ? ": " + x.warnings[0] : ""})`];
  const txt = `${path}.txt`;
  writeFileSync(txt, x.sections.map((s) => `[${s.ref}]\n${s.text}`).join("\n\n"));
  return [txt];
}

/** Download Hasaki task attachments (note_files) next to the worktrees. Moved unchanged from the old agent.ts. */
export async function downloadAttachments(
  dirKey: string,
  d: { note_files?: string[] } | null | undefined,
  workspace?: string,
): Promise<string[]> {
  const files: string[] = d?.note_files ?? [];
  if (!files.length || !config.fileBaseUrl)
    return files.map((f) => `${f} (not downloaded: fileBaseUrl not configured)`);
  const dir = join(workspace ?? taskDir(dirKey), "_attachments");
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const f of files) {
    try {
      const res = await fetch(config.fileBaseUrl.replace(/\/$/, "") + "/" + f);
      if (!res.ok) throw new Error(String(res.status));
      const p = join(dir, basename(f));
      const bytes = Buffer.from(await res.arrayBuffer());
      writeFileSync(p, bytes);
      out.push(p);
      out.push(...textCopy(p, bytes));
    } catch (e) {
      out.push(`${f} (download failed: ${(e as Error).message})`);
    }
  }
  return out;
}
