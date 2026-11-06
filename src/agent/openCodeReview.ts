import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Alibaba OpenCodeReview (github.com/alibaba/open-code-review) in DELEGATION mode: `ocr delegate` picks the files worth
 * reviewing in a branch (skipping generated code such as *.pb.go, templates, fixtures) and resolves its curated,
 * precision-first, per-language review rules — with no LLM call and no API key. The platform's own review agent (the
 * run's provider) then performs the review with that scope and those rules, so there is no second model bill.
 *
 * Optional: when the `ocr` binary is not installed, review steps run as before.
 */

const exec = promisify(execFile);
const MAX_FILES = 80;
const MAX_CHARS = 45_000;

/** The native binary: OCR_BIN, else the platform package installed with @alibaba-group/open-code-review. */
export function ocrBinary(): string | null {
  if (process.env.OCR_BIN) return existsSync(process.env.OCR_BIN) ? process.env.OCR_BIN : null;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  try {
    const req = createRequire(import.meta.url);
    const pkg = dirname(req.resolve(`@alibaba-group/ocr-${os}-${arch}/package.json`));
    const bin = join(pkg, "bin", os === "win32" ? "opencodereview.exe" : "opencodereview");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

async function ocr(bin: string, cwd: string, args: string[]) {
  const { stdout } = await exec(bin, ["--color", "never", ...args], { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
  return stdout;
}

/** Reviewable files from `ocr delegate preview` (lines struck through with ~~ are excluded by OCR). */
export function parsePreview(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s+- `/.test(l) && !l.trimStart().startsWith("~~"))
    .map((l) => l.match(/`([^`]+)`/)?.[1] ?? "")
    .filter(Boolean);
}

export interface OcrGuide {
  available: boolean;
  text: string;
  repos: Array<{ repo: string; files: number; error?: string }>;
}

/** Scope + rules for each workspace branch vs `origin/<base>`, as one prompt section (bounded in size). */
export async function openCodeReviewGuide(workspaces: Array<{ repo: string; path: string }>, baseBranch: string): Promise<OcrGuide> {
  const bin = ocrBinary();
  if (!bin) return { available: false, text: "", repos: [] };
  const parts: string[] = [];
  const repos: OcrGuide["repos"] = [];
  for (const w of workspaces) {
    try {
      const preview = await ocr(bin, w.path, ["delegate", "preview", "--from", `origin/${baseBranch}`, "--to", "HEAD"]);
      const files = parsePreview(preview).slice(0, MAX_FILES);
      repos.push({ repo: w.repo, files: files.length });
      parts.push(`### ${w.repo}\n\n${preview.trim()}`);
      if (files.length) parts.push((await ocr(bin, w.path, ["delegate", "rule", ...files])).trim());
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0].slice(0, 300);
      repos.push({ repo: w.repo, files: 0, error: msg });
    }
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + "\n\n… (rules truncated)";
  return { available: true, text, repos };
}

/** How the review agent must use the OCR material (kept next to the material it governs). */
export const OCR_REVIEW_INSTRUCTIONS = [
  "Review exactly the files OpenCodeReview lists as reviewable (struck-through files are generated/excluded: skip them unless",
  "a listed change depends on them). Apply the rule groups that match each file. Favor precision over recall: report only",
  "defects that are likely real in the changed code and its reachable context, verified by reading the code (file:line);",
  "correctness and security findings are blocking, style-only remarks are low severity. Do not report what the compiler,",
  "go vet, linters or the test step already enforce.",
].join(" ");
