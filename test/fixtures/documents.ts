/** Small real document files built in memory for extraction tests (no binary fixtures in the repository). */
import { crc32, deflateSync } from "node:zlib";

/** A two-page PDF: page 1 with a plain content stream, page 2 Flate-compressed. Standard Helvetica (single-byte text). */
export function tinyPdf(page1: string, page2: string) {
  const stream1 = `BT /F1 12 Tf 72 720 Td (${page1}) Tj ET`;
  const stream2 = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td [(${page2})] TJ ET`, "latin1"));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const obj = (n: number, body: string | Buffer, dict?: string) =>
    parts.push(
      typeof body === "string"
        ? Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, "latin1")
        : Buffer.concat([
            Buffer.from(`${n} 0 obj\n${dict} /Length ${body.length} >>\nstream\n`, "latin1"),
            body,
            Buffer.from("\nendstream\nendobj\n", "latin1"),
          ]),
    );
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>");
  obj(4, "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>");
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  obj(6, Buffer.from(stream1, "latin1"), "<<");
  obj(7, stream2, "<< /Filter /FlateDecode");
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/** A stored (uncompressed) ZIP of the given files. */
export function storedZip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function tinyDocx(heading: string, paragraph: string, table: string[][]) {
  const p = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const tbl = `<w:tbl>${table.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  return storedZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<w:document><w:body>${p(heading, "Heading1")}${p(paragraph)}${tbl}</w:body></w:document>`,
  });
}
