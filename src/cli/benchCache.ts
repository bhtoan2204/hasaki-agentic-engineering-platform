/**
 * In-process cache benchmark (no database): `npm run bench:cache`.
 * Compares the previous FIFO eviction with the bounded LRU on a Zipf workload, then checks that high-cardinality
 * traffic keeps CacheAside / StaleWhileRevalidate bounded and heap stable, and measures singleflight sharing.
 */
import { CacheAside, StaleWhileRevalidate, singleflight, singleflightInflight } from "../cache/index.ts";

const N_KEYS = 5000;
const CAP = 500;
const OPS = 200_000;
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const cdf: number[] = [];
let sum = 0;
for (let i = 1; i <= N_KEYS; i++) cdf.push((sum += 1 / i));
const zipf = () => {
  const t = rnd() * sum;
  let lo = 0;
  let hi = N_KEYS - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (cdf[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
};
const workload = Array.from({ length: OPS }, zipf);

function sim(lru: boolean) {
  const m = new Map<number, number>();
  let hits = 0;
  const t0 = performance.now();
  for (const k of workload) {
    if (m.has(k)) {
      hits++;
      if (lru) {
        const v = m.get(k)!;
        m.delete(k);
        m.set(k, v);
      }
    } else {
      if (m.size >= CAP) m.delete(m.keys().next().value!);
      m.set(k, 1);
    }
  }
  return { hitRate: hits / OPS, ms: performance.now() - t0 };
}
const fifo = sim(false);
const lru = sim(true);
console.log("policy  hitRate  ms");
console.log(`FIFO    ${fifo.hitRate.toFixed(4)}   ${fifo.ms.toFixed(1)}`);
console.log(`LRU     ${lru.hitRate.toFixed(4)}   ${lru.ms.toFixed(1)}`);

const aside = new CacheAside<{ n: number }>("bench.aside", ["bench"], 60_000, 1000);
const swr = new StaleWhileRevalidate<number>("bench.swr", 1000, 60_000, 500);
const heap0 = (global.gc?.(), process.memoryUsage().heapUsed);
let maxAside = 0;
let maxSwr = 0;
for (let i = 0; i < 100_000; i++) {
  await aside.get(`k${i}`, async () => ({ n: i }));
  await swr.get(`k${i}`, async () => i);
  maxAside = Math.max(maxAside, aside.size);
  maxSwr = Math.max(maxSwr, swr.size);
}
const heap1 = (global.gc?.(), process.memoryUsage().heapUsed);
console.log(`high cardinality (100k keys): max entries aside=${maxAside}/1000 swr=${maxSwr}/500`);
console.log(`heap delta ${((heap1 - heap0) / 1e6).toFixed(1)} MB (run with --expose-gc for a stable figure)`);

let loads = 0;
await Promise.all(
  Array.from({ length: 1000 }, () =>
    singleflight("same", async () => (loads++, await new Promise((r) => setTimeout(r, 10)))),
  ),
);
console.log(`singleflight: 1000 concurrent identical calls → ${loads} load(s), pending left ${singleflightInflight()}`);
if (maxAside > 1000 || maxSwr > 500 || loads !== 1 || singleflightInflight() !== 0) process.exit(1);
