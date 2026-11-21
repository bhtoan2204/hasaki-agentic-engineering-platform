import { createHash } from "node:crypto";
import { pdfPages, PdfError } from "./pdfText.ts";
import { readZipText, zipNames, ZipError } from "./zipRead.ts";

/**
 * Chat documents: what a file really is (from its bytes, never its name or the browser's claim), its text split into
 * located sections (page, heading, row, JSON path), and candidate knowledge units built from those sections.
 * Extraction is bounded (characters, rows, columns, depth) and never executes anything: no macros, scripts, formulas,
 * embedded files or OCR. A failure is reported per file.
 */
export const DOCUMENT_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  markdown: "text/markdown",
  text: "text/plain",
  json: "application/json",
  csv: "text/csv",
} as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];

const LIMITS = {
  chars: 400_000,
  rows: 2000,
  columns: 50,
  sheets: 10,
  jsonLeaves: 4000,
  jsonDepth: 24,
};

export interface Section {
  /** Where it is in the source: "page 3", "§ Refund rules", "Sheet1 rows 2-40", "$.paths./refund". */
  ref: string;
  heading?: string;
  text: string;
}
export interface Extraction {
  media_type: DocumentType;
  sections: Section[];
  chars: number;
  truncated: boolean;
  warnings: string[];
}

const isUtf8Text = (b: Buffer) => {
  if (b.includes(0)) return false;
  const s = b.toString("utf8");
  // More than 1% replacement characters: binary, not text.
  return (s.match(/�/g)?.length ?? 0) <= s.length / 100;
};

/** The document type the bytes are; the file name only picks between text renderings (all of them are plain text). */
export function sniffDocument(b: Buffer, filename = ""): DocumentType | null {
  if (b.subarray(0, 1024).toString("latin1").includes("%PDF-")) return DOCUMENT_TYPES.pdf;
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) {
    try {
      const names = new Set(zipNames(b));
      if (names.has("word/document.xml")) return DOCUMENT_TYPES.docx;
      if (names.has("xl/workbook.xml")) return DOCUMENT_TYPES.xlsx;
    } catch {
      /* not a readable archive */
    }
    return null;
  }
  if (!isUtf8Text(b)) return null;
  const text = b.toString("utf8").replace(/^\uFEFF/, "");
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  try {
    if (/^\s*[[{]/.test(text)) {
      JSON.parse(text);
      return DOCUMENT_TYPES.json;
    }
  } catch {
    /* not JSON */
  }
  if (
    ext === "csv" &&
    parseCsv(text, 5).every((r, _, all) => r.length > 1 && r.length === all[0].length)
  )
    return DOCUMENT_TYPES.csv;
  if (ext === "md" || ext === "markdown" || /^#{1,6}\s+\S/m.test(text))
    return DOCUMENT_TYPES.markdown;
  return DOCUMENT_TYPES.text;
}

// ---------------------------------------------------------------- formats

function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if ((cell || row.length) && rows.length < maxRows) rows.push([...row, cell]);
  return rows;
}

/** Sections at headings; a fenced code block is never split. */
function markdownSections(text: string, plain: boolean): Section[] {
  const lines = text.split(/\r?\n/);
  const out: Section[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) out.push({ ref: heading ? `§ ${heading}` : `lines`, heading, text: body });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && !plain ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush();
      heading = h[2];
    }
    buf.push(line);
  }
  flush();
  return out;
}

const xmlText = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function docxSections(b: Buffer): Section[] {
  const xml = readZipText(b, ["word/document.xml"]).get("word/document.xml") ?? "";
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const lines: Array<{ heading?: string; text: string }> = [];
  // Paragraphs and tables in document order.
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith("<w:tbl>")) {
      const rows = [...block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(
        (r) =>
          "| " +
          [...r[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)]
            .map((c) =>
              [...c[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
                .map((t) => xmlText(t[1]))
                .join("")
                .trim(),
            )
            .join(" | ") +
          " |",
      );
      if (rows.length) lines.push({ text: rows.join("\n") });
      continue;
    }
    const text = [...block.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
      .map((t) => xmlText(t[1]))
      .join("");
    if (!text.trim()) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? "";
    lines.push(
      /^(Heading|Title|Tieude|Ti)/i.test(style) ? { heading: text.trim(), text } : { text },
    );
  }
  const out: Section[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (buf.join("").trim())
      out.push({ ref: heading ? `§ ${heading}` : "document start", heading, text: buf.join("\n") });
    buf = [];
  };
  for (const l of lines) {
    if (l.heading) {
      flush();
      heading = l.heading;
    }
    buf.push(l.text);
  }
  flush();
  return out;
}

function xlsxSections(b: Buffer, warnings: string[]): Section[] {
  const files = readZipText(b, [
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/sharedStrings.xml",
  ]);
  const shared = [
    ...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map((m) => [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => xmlText(t[1])).join(""));
  const rels = new Map(
    [
      ...(files.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(
        /Id="([^"]+)"[^>]*Target="([^"]+)"/g,
      ),
    ].map((m) => [m[1], m[2].replace(/^\/?(xl\/)?/, "xl/")]),
  );
  const sheets = [
    ...(files.get("xl/workbook.xml") ?? "").matchAll(
      /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g,
    ),
  ];
  if (sheets.length > LIMITS.sheets)
    warnings.push(`only the first ${LIMITS.sheets} sheets are read`);
  const out: Section[] = [];
  for (const [, name, rid] of sheets.slice(0, LIMITS.sheets)) {
    const path = rels.get(rid);
    const xml = path ? readZipText(b, [path]).get(path) : undefined;
    if (!xml) continue;
    const rows: string[] = [];
    for (const r of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= LIMITS.rows) {
        warnings.push(`${name}: only the first ${LIMITS.rows} rows are read`);
        break;
      }
      // Cached values only: formulas are never evaluated.
      const cells = [...r[2].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
        .slice(0, LIMITS.columns)
        .map((c) => {
          const v =
            /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1] ??
            /<t[^>]*>([^<]*)<\/t>/.exec(c[2] ?? "")?.[1] ??
            "";
          return /t="s"/.test(c[1]) ? (shared[Number(v)] ?? "") : xmlText(v);
        });
      if (cells.some((c) => c !== "")) rows.push(`row ${r[1]}: ${cells.join(" | ")}`);
    }
    if (rows.length) out.push({ ref: `sheet ${name}`, heading: name, text: rows.join("\n") });
  }
  return out;
}

function jsonSections(text: string, warnings: string[]): Section[] {
  const value = JSON.parse(text) as unknown;
  const leaves: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (leaves.length >= LIMITS.jsonLeaves) return;
    if (depth > LIMITS.jsonDepth) return void leaves.push(`${path}: …`);
    if (v && typeof v === "object")
      for (const [k, child] of Object.entries(v as Record<string, unknown>))
        walk(child, Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`, depth + 1);
    else leaves.push(`${path}: ${JSON.stringify(v)}`);
  };
  walk(value, "$", 0);
  if (leaves.length >= LIMITS.jsonLeaves)
    warnings.push(`only the first ${LIMITS.jsonLeaves} values are read`);
  // One section per top-level key (an OpenAPI document: info, paths, components…).
  const groups = new Map<string, string[]>();
  for (const l of leaves) {
    const top = /^\$(\.[^.[:]+|\[\d+\])?/.exec(l)?.[0] ?? "$";
    (groups.get(top) ?? groups.set(top, []).get(top)!).push(l);
  }
  return [...groups].map(([ref, ls]) => ({ ref, heading: ref, text: ls.join("\n") }));
}

function csvSections(text: string, warnings: string[]): Section[] {
  const rows = parseCsv(text, LIMITS.rows + 1);
  if (rows.length > LIMITS.rows) warnings.push(`only the first ${LIMITS.rows} rows are read`);
  const header = (rows[0] ?? []).slice(0, LIMITS.columns);
  const body = rows.slice(1, LIMITS.rows + 1).map(
    (r, i) =>
      `row ${i + 2}: ${r
        .slice(0, LIMITS.columns)
        .map((c, j) => `${header[j] ?? `col${j + 1}`}=${c}`)
        .join("; ")}`,
  );
  const out: Section[] = [];
  for (let i = 0; i < body.length; i += 200)
    out.push({
      ref: `rows ${i + 2}-${Math.min(i + 201, body.length + 1)}`,
      heading: header.join(", "),
      text: body.slice(i, i + 200).join("\n"),
    });
  return out;
}

export function extractDocument(
  b: Buffer,
  mediaType: DocumentType,
  signal?: AbortSignal,
): Extraction {
  const warnings: string[] = [];
  let sections: Section[];
  try {
    if (mediaType === DOCUMENT_TYPES.pdf) {
      const pages = pdfPages(b, signal);
      sections = pages
        .map((text, i) => ({ ref: `page ${i + 1}`, text }))
        .filter((s) => s.text.trim());
      const chars = sections.reduce((n, s) => n + s.text.length, 0);
      if (pages.length && chars < 20 * pages.length)
        warnings.push(
          "little or no extractable text: the PDF looks scanned or image-only; OCR is not performed, so its content is not available",
        );
    } else if (mediaType === DOCUMENT_TYPES.docx) sections = docxSections(b);
    else if (mediaType === DOCUMENT_TYPES.xlsx) sections = xlsxSections(b, warnings);
    else {
      const text = b.toString("utf8").replace(/^\uFEFF/, "");
      sections =
        mediaType === DOCUMENT_TYPES.json
          ? jsonSections(text, warnings)
          : mediaType === DOCUMENT_TYPES.csv
            ? csvSections(text, warnings)
            : markdownSections(text, mediaType === DOCUMENT_TYPES.text);
    }
  } catch (e) {
    if (e instanceof PdfError || e instanceof ZipError || e instanceof SyntaxError)
      return {
        media_type: mediaType,
        sections: [],
        chars: 0,
        truncated: false,
        warnings: [`could not read the document: ${e.message}`],
      };
    throw e;
  }
  let total = 0,
    truncated = false;
  const bounded: Section[] = [];
  for (const s of sections) {
    if (total + s.text.length > LIMITS.chars) {
      truncated = true;
      warnings.push(`only the first ${LIMITS.chars} characters are kept`);
      break;
    }
    total += s.text.length;
    bounded.push(s);
  }
  return { media_type: mediaType, sections: bounded, chars: total, truncated, warnings };
}

// ---------------------------------------------------------------- knowledge candidates

/** Categories a document import may propose (security policies and run memories are never imported from chat). */
export const IMPORT_CATEGORIES = [
  "business_rule",
  "architecture_guideline",
  "domain_knowledge",
  "coding_standard",
  "repository_convention",
  "agent_skill",
] as const;
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number];

const CATEGORY_HINTS: Array<[ImportCategory, RegExp]> = [
  [
    "business_rule",
    /\b(rule|policy|must|must not|shall|quy (định|tắc)|bắt buộc|không được|điều kiện|refund|hoàn tiền|limit|hạn mức)\b/i,
  ],
  [
    "architecture_guideline",
    /\b(architecture|kiến trúc|component|service|topic|queue|kafka|database|sequence|flow|adr|decision)\b/i,
  ],
  ["coding_standard", /\b(convention|naming|lint|code style|quy ước|coding)\b/i],
  ["agent_skill", /\b(runbook|step \d|bước \d|how to|hướng dẫn|troubleshoot|playbook)\b/i],
];

export interface Candidate {
  /** `<attachment id>:<n>`: stable for the same file content. */
  id: string;
  attachment_id: number;
  filename: string;
  title: string;
  category: ImportCategory;
  refs: string[];
  content: string;
  /** sha256 of the normalized content: equal units of different files (or a re-upload) are one candidate. */
  content_hash: string;
}

const normalized = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
export const contentHash = (s: string) => createHash("sha256").update(normalized(s)).digest("hex");

/**
 * Cohesive units from one extraction: a section with a heading is a unit; small neighbouring sections are merged (up to
 * TARGET chars) so a page break or a one-line section does not become its own knowledge item; empty ones are dropped.
 * The text is the source's own words; a title and category are only suggestions for the reviewer.
 */
const TARGET = 6000;
const MIN = 300;
export function documentCandidates(
  attachmentId: number,
  filename: string,
  ex: Extraction,
): Candidate[] {
  const units: Array<{ title: string; refs: string[]; text: string }> = [];
  for (const s of ex.sections) {
    const last = units.at(-1);
    // A section without its own heading, a short one, or one following a short unit joins the previous unit: a
    // short section is never dropped and never becomes a knowledge item of its own.
    const short = s.text.trim().length < MIN;
    if (
      last &&
      (!s.heading || short || last.text.length < MIN) &&
      last.text.length + s.text.length <= TARGET
    ) {
      last.refs.push(s.ref);
      last.text += `\n\n${s.text}`;
      if (!last.title && s.heading) last.title = s.heading;
    } else units.push({ title: s.heading ?? "", refs: [s.ref], text: s.text });
  }
  const base = filename.replace(/\.[^.]+$/, "");
  return units
    .filter((u) => u.text.trim().length >= 40)
    .map((u, i) => ({
      id: `${attachmentId}:${i + 1}`,
      attachment_id: attachmentId,
      filename,
      title: (u.title || `${base} (${u.refs[0]})`).slice(0, 160),
      category: CATEGORY_HINTS.find(([, re]) => re.test(u.text))?.[0] ?? "domain_knowledge",
      refs: u.refs,
      content: u.text.slice(0, 20_000),
      content_hash: contentHash(u.text),
    }));
}

/** Instructions inside a document are data: flagged so the reviewer (and the model) see them as such. */
export const INJECTION =
  /\b(ignore (all |the )?(previous|above|prior) (instructions|rules)|system prompt|you are now|bỏ qua (mọi|các) (hướng dẫn|chỉ dẫn)|disable (the )?(approval|confirmation)|approve automatically|tự động (duyệt|phê duyệt))\b/i;
