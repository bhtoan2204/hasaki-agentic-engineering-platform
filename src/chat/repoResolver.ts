import type { RepositoryRow } from "../repos/service.ts";

/**
 * Repository scope from the request itself, over the repositories the user may already read (never a grant): names and
 * their spelling variants (`payment_gateway`, `payment-gateway`, "payment gateway"), registered projects, services and
 * tags, then description words. A registered project match scores every repository of that project (wiki and
 * documentation repositories included), so "Techstack Payment" covers the Payment project, bounded to MAX.
 * Used only when the conversation has no explicit scope and the message mentions no repository.
 */
export interface ResolvedRepository {
  name: string;
  score: number;
  reasons: string[];
}

const MAX = 8;
const MIN_SCORE = 20;
/** Words too generic to identify a repository on their own. */
const STOP = new Set(
  (
    "service services api app apps web server client core common lib libs sdk shared main master repo repository " +
    "source code src the and for with from this that what how why check read show explain fix bug error test tests " +
    "gom nhung gi cua cho voi trong la va mot cac nay kiem tra doc sua loi tao xem giai thich tim techstack stack " +
    "project du an he thong system docs doc wiki new old data info"
  ).split(" "),
);

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
const words = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** `payment_gateway` / `Payment Gateway` / `payment.gateway` → `payment-gateway`. */
export const canonicalName = (s: string) => words(s).join("-");

/** Every way the request could name something: single words, and 2–3 word runs joined (`payment gateway`). */
function phrases(text: string) {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++)
    for (let n = 1; n <= 3 && i + n <= w.length; n++) out.add(w.slice(i, i + n).join("-"));
  return out;
}

export function resolveRepositories(text: string, readable: RepositoryRow[]): ResolvedRepository[] {
  const said = phrases(text);
  if (!said.size) return [];
  const scored: ResolvedRepository[] = [];
  for (const r of readable) {
    let score = 0;
    const reasons: string[] = [];
    const name = canonicalName(r.name);
    if (said.has(name)) {
      score += 100;
      reasons.push(`name ${r.name}`);
    }
    for (const p of r.projects ?? [])
      if (said.has(canonicalName(p))) {
        score += 60;
        reasons.push(`project ${p}`);
      }
    for (const s of r.services ?? [])
      if (canonicalName(s) !== name && said.has(canonicalName(s))) {
        score += 50;
        reasons.push(`service ${s}`);
      }
    const segments = name.split("-").filter((x) => x.length >= 3 && !STOP.has(x));
    const hits = segments.filter((x) => said.has(x));
    if (hits.length && score < 100) {
      score += 20 * hits.length;
      reasons.push(`name part ${hits.join(", ")}`);
    }
    for (const t of r.tags ?? [])
      if (!STOP.has(canonicalName(t)) && said.has(canonicalName(t))) {
        score += 10;
        reasons.push(`tag ${t}`);
      }
    const desc = new Set(words(r.description ?? "").filter((x) => x.length >= 4 && !STOP.has(x)));
    const overlap = [...said].filter((x) => !x.includes("-") && desc.has(x)).length;
    if (overlap) score += Math.min(10, 2 * overlap);
    if (score >= MIN_SCORE) scored.push({ name: r.name, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, MAX);
}
