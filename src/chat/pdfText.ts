import { inflateSync } from "node:zlib";

/**
 * Text of a PDF, page by page, without a third-party parser: objects (also inside object streams), the page tree, Flate
 * content streams and the text operators (Tj, TJ, ', "), decoded through each font's ToUnicode map when it has one,
 * else as single-byte text. Nothing is rendered or executed (no JavaScript, forms or embedded files are read).
 * Not supported, and reported instead of guessed: encrypted PDFs, text drawn as images (scans: no OCR), fonts without a
 * ToUnicode map in a multi-byte encoding (their text comes out empty or garbled and the caller is told).
 */
export class PdfError extends Error {}

const MAX_STREAM = 16 * 1024 * 1024;
type Obj = { dict: string; stream?: Buffer };

function inflate(raw: Buffer, dict: string): Buffer | undefined {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
  if (!filter) return raw;
  if (filter.replace(/[[\]\s]/g, "") !== "/FlateDecode") return undefined; // images and other filters: not text
  try {
    return inflateSync(raw, { maxOutputLength: MAX_STREAM });
  } catch {
    return undefined;
  }
}

function objects(buf: Buffer): Map<number, Obj> {
  const text = buf.toString("latin1");
  const out = new Map<number, Obj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const s = body.search(/stream\r?\n/);
    if (s >= 0) {
      const dict = body.slice(0, s);
      const dataStart = start + s + (body[s + 6] === "\r" ? 8 : 7);
      const len = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1]);
      const dataEnd =
        Number.isFinite(len) && len > 0 ? dataStart + len : text.indexOf("endstream", dataStart);
      const stream = inflate(buf.subarray(dataStart, dataEnd), dict);
      out.set(Number(m[1]), { dict, stream });
      if (stream && /\/Type\s*\/ObjStm/.test(dict)) {
        // Objects compressed inside an object stream: "num offset" pairs, then the objects from /First.
        const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? 0);
        const inner = stream.toString("latin1");
        const pairs = inner.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          const from = first + pairs[i + 1];
          const to = i + 3 < pairs.length ? first + pairs[i + 3] : inner.length;
          if (!out.has(pairs[i])) out.set(pairs[i], { dict: inner.slice(from, to) });
        }
      }
    } else out.set(Number(m[1]), { dict: body });
    re.lastIndex = end;
  }
  return out;
}

const ref = (dict: string, key: string) => {
  const r = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return r ? Number(r[1]) : undefined;
};
const refs = (s: string) => [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));

/** Inline `<< … >>` value of `key`, or the dictionary it refers to. */
function dictValue(objs: Map<number, Obj>, dict: string, key: string): string {
  const i = dict.indexOf(`/${key}`);
  if (i < 0) return "";
  const rest = dict.slice(i + key.length + 1).trimStart();
  if (rest.startsWith("<<")) {
    let depth = 0;
    for (let j = 0; j < rest.length - 1; j++) {
      if (rest.startsWith("<<", j)) {
        depth++;
        j++;
      } else if (rest.startsWith(">>", j)) {
        depth--;
        j++;
        if (!depth) return rest.slice(0, j + 1);
      }
    }
    return rest;
  }
  const r = /^(\d+)\s+\d+\s+R/.exec(rest);
  return r ? (objs.get(Number(r[1]))?.dict ?? "") : "";
}

type CMap = { bytes: number; map: Map<number, string> };
const hexToString = (h: string) => {
  let s = "";
  for (let i = 0; i + 3 < h.length + 1; i += 4)
    s += String.fromCharCode(parseInt(h.slice(i, i + 4).padEnd(4, "0"), 16));
  return s;
};
function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  const space = /<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]+>\s*endcodespacerange/.exec(src);
  const bytes = space ? Math.max(1, space[1].length / 2) : 2;
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g))
      map.set(parseInt(m[1], 16), hexToString(m[2]));
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g,
    )) {
      const lo = parseInt(m[1], 16),
        hi = Math.min(parseInt(m[2], 16), lo + 65_535);
      if (m[3].startsWith("[")) {
        const list = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hexToString(x[1]));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]);
      } else {
        const base = m[3].slice(1, -1);
        const head = hexToString(base.slice(0, -4)),
          last = parseInt(base.slice(-4), 16);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
      }
    }
  return { bytes, map };
}

function decode(bytes: number[], cmap: CMap | undefined) {
  if (!cmap) return String.fromCharCode(...bytes);
  let s = "";
  for (let i = 0; i + cmap.bytes <= bytes.length; i += cmap.bytes) {
    let code = 0;
    for (let k = 0; k < cmap.bytes; k++) code = code * 256 + bytes[i + k];
    s += cmap.map.get(code) ?? "";
  }
  return s;
}

/** Bytes of a literal `( … )` or hex `< … >` string starting at `i`; returns the bytes and the index after it. */
function readString(c: string, i: number): [number[], number] {
  const out: number[] = [];
  if (c[i] === "<") {
    const end = c.indexOf(">", i);
    const hex = c.slice(i + 1, end).replace(/\s/g, "");
    for (let k = 0; k < hex.length; k += 2)
      out.push(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
    return [out, end + 1];
  }
  let depth = 0;
  for (let j = i; j < c.length; j++) {
    const ch = c[j];
    if (ch === "\\") {
      const n = c[++j];
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      if (n in esc) out.push(esc[n]);
      else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(c.slice(j))![0];
        out.push(parseInt(oct, 8) & 255);
        j += oct.length - 1;
      } else if (n === "\r" || n === "\n") {
        /* line continuation */
      } else out.push(n.charCodeAt(0));
    } else if (ch === "(") {
      if (depth++ > 0) out.push(40);
    } else if (ch === ")") {
      if (--depth === 0) return [out, j + 1];
      out.push(41);
    } else out.push(ch.charCodeAt(0) & 255);
  }
  return [out, c.length];
}

function pageText(content: string, fonts: Map<string, CMap | undefined>): string {
  let out = "";
  let font: CMap | undefined;
  const operands: Array<number[] | Array<number[] | number> | number | string> = [];
  for (let i = 0; i < content.length;) {
    const ch = content[i];
    if (ch === "(" || (ch === "<" && content[i + 1] !== "<")) {
      const [bytes, next] = readString(content, i);
      operands.push(bytes);
      i = next;
    } else if (ch === "[") {
      const arr: Array<number[] | number> = [];
      i++;
      while (i < content.length && content[i] !== "]") {
        if (content[i] === "(" || content[i] === "<") {
          const [bytes, next] = readString(content, i);
          arr.push(bytes);
          i = next;
        } else {
          const n = /^-?\d*\.?\d+/.exec(content.slice(i, i + 32));
          if (n) {
            arr.push(Number(n[0]));
            i += n[0].length;
          } else i++;
        }
      }
      operands.push(arr);
      i++;
    } else if (ch === "/") {
      const n = /^\/[^\s/<>[\]()]+/.exec(content.slice(i, i + 128))![0];
      operands.push(n);
      i += n.length;
    } else if (/[A-Za-z'"*]/.test(ch)) {
      const op = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 8))![0];
      i += op.length;
      if (op === "Tf")
        font = fonts.get(String(operands.find((o) => typeof o === "string") ?? "").slice(1));
      else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") out += "\n";
        const s = operands.findLast((o) => Array.isArray(o)) as number[] | undefined;
        if (s) out += decode(s, font);
      } else if (op === "TJ") {
        const arr = operands.findLast((o) => Array.isArray(o)) as
          Array<number[] | number> | undefined;
        for (const part of arr ?? [])
          if (typeof part === "number") {
            if (part < -200) out += " ";
          } else out += decode(part, font);
      } else if (op === "T*" || op === "ET") out += "\n";
      else if ((op === "Td" || op === "TD") && Number(operands.at(-1)) !== 0) out += "\n";
      operands.length = 0;
    } else if (/[-\d.]/.test(ch)) {
      const n = /^-?\d*\.?\d+/.exec(content.slice(i, i + 32));
      if (n) {
        operands.push(Number(n[0]));
        i += n[0].length;
      } else i++;
    } else i++;
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pdfPages(buf: Buffer, signal?: AbortSignal): string[] {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 1024));
  if (!head.includes("%PDF-")) throw new PdfError("not a PDF");
  const objs = objects(buf);
  const all = buf.toString("latin1");
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(all)) throw new PdfError("encrypted PDFs are not supported");
  const rootRefs = [...all.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const root = rootRefs.length ? objs.get(Number(rootRefs.at(-1)![1])) : undefined;
  const pagesRoot = root ? ref(root.dict, "Pages") : undefined;
  if (pagesRoot == null) throw new PdfError("no page tree");
  const pages: string[] = [];
  const visit = (id: number, inherited: string, depth: number) => {
    signal?.throwIfAborted();
    const node = objs.get(id);
    if (!node || depth > 32 || pages.length >= 2000) return;
    const resources = dictValue(objs, node.dict, "Resources") || inherited;
    if (/\/Type\s*\/Pages\b/.test(node.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(node.dict)?.[1] ?? "";
      for (const k of refs(kids)) visit(k, resources, depth + 1);
      return;
    }
    const fonts = new Map<string, CMap | undefined>();
    const fontDict = dictValue(objs, resources, "Font");
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const fontObj = objs.get(Number(f[2]));
      const tu = fontObj ? ref(fontObj.dict, "ToUnicode") : undefined;
      const cmapSrc = tu != null ? objs.get(tu)?.stream?.toString("latin1") : undefined;
      fonts.set(f[1], cmapSrc ? parseCMap(cmapSrc) : undefined);
    }
    const contentsRaw = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(node.dict)?.[1] ?? "";
    const content = refs(contentsRaw)
      .map((r) => objs.get(r)?.stream?.toString("latin1") ?? "")
      .join("\n");
    pages.push(pageText(content, fonts));
  };
  visit(pagesRoot, "", 0);
  return pages;
}
