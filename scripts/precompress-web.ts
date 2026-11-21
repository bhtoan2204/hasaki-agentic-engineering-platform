/**
 * Build step: write `<file>.br` and `<file>.gz` next to every compressible web/dist file, at maximum compression, so the
 * server never compresses the UI bundle at request time (the first page load after a restart used to pay it; see
 * docs/architecture/phase4-performance.md). The server falls back to compressing on request when a file has no
 * precompressed sibling (a dev build, or a file changed after the build).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = join(import.meta.dirname, "..", "web", "dist");
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json"]);
let files = 0,
  raw = 0,
  br = 0;
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (COMPRESSIBLE.has(extname(path))) {
      const body = readFileSync(path);
      if (body.length < 1024) continue;
      const b = brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      });
      writeFileSync(`${path}.br`, b);
      writeFileSync(`${path}.gz`, gzipSync(body, { level: 9 }));
      files++;
      raw += body.length;
      br += b.length;
    }
  }
};
walk(dist);
console.log(
  `precompressed ${files} files: ${Math.round(raw / 1024)} KB → ${Math.round(br / 1024)} KB (brotli)`,
);
