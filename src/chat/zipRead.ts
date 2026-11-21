import { inflateRawSync } from "node:zlib";

/**
 * Read named entries of a ZIP container (DOCX, XLSX) from memory. Nothing is extracted to disk and only the entries asked
 * for are inflated. Refused: encrypted entries, ZIP64, more than MAX_ENTRIES entries, an entry above MAX_ENTRY_BYTES, a
 * compression ratio above MAX_RATIO (zip bombs), and entry names with `..` or an absolute path.
 */
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_RATIO = 200;

export class ZipError extends Error {}

interface Entry {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  offset: number;
}

function entries(buf: Buffer): Map<string, Entry> {
  // End of central directory: last 22 bytes + up to 64 KiB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff)
    throw new ZipError("ZIP64 archives are not supported");
  if (count > MAX_ENTRIES) throw new ZipError("too many entries");
  if (cdOffset + cdSize > buf.length) throw new ZipError("truncated archive");
  const out = new Map<string, Entry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt central directory");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) continue;
    out.set(name, { name, method, flags, compressed, size, offset });
  }
  return out;
}

export function zipNames(buf: Buffer): string[] {
  return [...entries(buf).keys()];
}

/** The named entries that exist, as UTF-8 text. */
export function readZipText(buf: Buffer, names: string[]): Map<string, string> {
  const all = entries(buf);
  const out = new Map<string, string>();
  for (const name of names) {
    const e = all.get(name);
    if (!e) continue;
    if (e.flags & 1) throw new ZipError("encrypted documents are not supported");
    if (e.size > MAX_ENTRY_BYTES) throw new ZipError(`${name} is too large`);
    if (e.compressed > 0 && e.size / e.compressed > MAX_RATIO)
      throw new ZipError("suspicious compression ratio");
    if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError("corrupt local header");
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const data = buf.subarray(start, start + e.compressed);
    const bytes =
      e.method === 0
        ? data
        : e.method === 8
          ? inflateRawSync(data, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, e.size + 1024) })
          : (() => {
              throw new ZipError(`unsupported compression method ${e.method}`);
            })();
    out.set(name, bytes.toString("utf8"));
  }
  return out;
}
