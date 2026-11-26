/**
 * Offline benchmark for dependency readiness validation: legacy synchronous full hash vs the signed, async, incremental path.
 * Synthetic node_modules trees only; no network, no npm. Run: npm run bench:dependencies
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependencyStats,
  recordDependencies,
  resetDependencyMetrics,
  validateDependencies,
} from "../git/nodeDependencies.ts";

const SIZES = { small: 50, medium: 1500, large: 20000 } as const;

/** The previous implementation: recursive readdirSync/readFileSync on the main thread. */
function legacy(root: string) {
  const hash = createHash("sha256");
  const stats = { files: 0, bytes: 0 };
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        key = `${prefix}/${name}`,
        st = lstatSync(path);
      hash.update(key).update(String(st.mode));
      if (st.isDirectory()) walk(path, key);
      else if (st.isFile()) {
        const data = readFileSync(path);
        stats.files++;
        stats.bytes += data.length;
        hash.update(data);
      }
    }
  };
  walk(root);
  hash.digest("hex");
  return stats;
}

async function measure<T>(fn: () => Promise<T> | T) {
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  const began = performance.now();
  const value = await fn();
  const ms = performance.now() - began;
  lag.disable();
  return { value, ms, lagMax: Number.isFinite(lag.max) ? lag.max / 1e6 : 0 };
}

/** Median of several runs (after one warm-up) so one cold or noisy sample does not decide the comparison. */
async function median<T>(fn: () => Promise<T> | T, runs = 7) {
  await fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    resetDependencyMetrics();
    samples.push(await measure(fn));
  }
  samples.sort((a, b) => a.ms - b.ms);
  return samples[Math.floor(runs / 2)];
}

async function build(workspace: string, files: number) {
  const perPackage = 25,
    packages = Math.ceil(files / perPackage);
  await writeFile(join(workspace, "package.json"), "{}");
  for (let p = 0; p < packages; p++) {
    const dir = join(workspace, "node_modules", `pkg-${p}`, "lib");
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(perPackage, files - p * perPackage) }, (_, i) =>
        writeFile(join(dir, `f${i}.js`), `module.exports = ${p * i};\n`.repeat(40)),
      ),
    );
  }
}

const rows: string[][] = [
  ["tree", "files", "path", "ms", "max loop lag ms", "stat'd", "read", "bytes hashed"],
];
const root = await mkdtemp(join(tmpdir(), "bench-deps-"));
const evidenceDir = join(root, "evidence");
try {
  for (const [name, files] of Object.entries(SIZES)) {
    const workspace = join(root, name);
    await mkdir(workspace);
    await build(workspace, files);
    const row = (
      label: string,
      ms: number,
      lag: number,
      stat: number,
      read: number,
      bytes: number,
    ) =>
      rows.push([
        name,
        String(files),
        label,
        ms.toFixed(1),
        lag.toFixed(1),
        String(stat),
        String(read),
        String(bytes),
      ]);
    const old = await median(() => legacy(join(workspace, "node_modules")));
    // A synchronous walk blocks the loop for its whole duration; a timer histogram cannot observe that, so report the block itself.
    row("legacy sync full hash", old.ms, old.ms, old.value.files, old.value.files, old.value.bytes);
    await recordDependencies(workspace, { evidenceDir });
    for (const [label, strict] of [
      ["new incremental (unchanged)", false],
      ["new strict (trust boundary)", true],
    ] as const) {
      if (strict) resetDependencyMetrics();
      const r = await (strict ? measure : median)(() =>
        validateDependencies(workspace, { evidenceDir, strict }),
      );
      if (!r.value.ready) throw new Error(`${name}: ${label} unexpectedly not ready`);
      if (!strict && dependencyStats.bytesHashed !== 0)
        throw new Error(`${name}: the fast path hashed ${dependencyStats.bytesHashed} bytes`);
      row(
        label,
        r.ms,
        r.lagMax,
        dependencyStats.filesStatted,
        dependencyStats.filesRead,
        dependencyStats.bytesHashed,
      );
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const r of rows) console.log(r.map((cell, c) => cell.padEnd(widths[c])).join("  "));
