/**
 * Retrieval evaluation over the seeded knowledge (KNOWLEDGE_SEEDS + skills/external) with the labelled queries in
 * test/fixtures/retrieval-eval.json: Recall@5, Recall@10 and MRR of the search ranking, lexical-only and hybrid
 * (RRF with the Go semantic service), plus the average inline tokens planKnowledge gives each query.
 * Hybrid needs retrieval.semantic enabled, RETRIEVAL_INTERNAL_TOKEN, the seeded items in the current database and a
 * reachable service; otherwise it is reported as unavailable.
 *   npm run eval:retrieval [-- --owner <user id>] [--json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import {
  estimateTokens,
  fusedSearchOrder,
  planKnowledge,
  scoreKnowledge,
  type KnowledgeLike,
} from "../context/plan.ts";
import { KNOWLEDGE_SEEDS } from "../knowledge/service.ts";
import { planExternalSkills } from "../knowledge/externalImport.ts";
import { semanticRanksByKey, type SemanticHit } from "../retrieval/semantic.ts";

interface Labelled {
  query: string;
  lang: string;
  kind: string;
  expected: string[];
}
const root = resolve(import.meta.dirname, "../..");
const { queries } = JSON.parse(
  readFileSync(resolve(root, "test/fixtures/retrieval-eval.json"), "utf8"),
) as { queries: Labelled[] };
const corpus: Array<KnowledgeLike & { id?: number; version: number }> = [
  ...KNOWLEDGE_SEEDS,
  ...planExternalSkills(resolve(root, "skills/external")).candidates,
].map((k) => ({
  key: k.key,
  title: k.title,
  category: k.category,
  content: k.content,
  scope_type: k.scope_type,
  metadata: k.metadata,
  enforced: k.enforced,
  reason: "applies",
  version: 1,
}));

const missing = queries.flatMap((x) => x.expected).filter((k) => !corpus.some((c) => c.key === k));
if (missing.length)
  throw new Error(`labelled keys not in the seeded corpus: ${missing.join(", ")}`);

async function semanticSetup(): Promise<{ owner: number } | string> {
  if (!config.retrieval.semantic.enabled) return "retrieval.semantic.enabled is false";
  if (!process.env.RETRIEVAL_INTERNAL_TOKEN) return "RETRIEVAL_INTERNAL_TOKEN is not set";
  try {
    const rows = await q<{ id: number; key: string; version: number }>(
      pool,
      "SELECT id, key, current_version AS version FROM knowledge_items WHERE owner_id IS NULL AND enabled AND key = ANY($1)",
      [corpus.map((k) => k.key)],
    );
    for (const r of rows)
      Object.assign(
        corpus.find((k) => k.key === r.key)!,
        r,
      );
    if (!rows.length) return "seeded knowledge is not in the database";
    const ownerArg = process.argv.indexOf("--owner");
    const owner =
      ownerArg > 0
        ? Number(process.argv[ownerArg + 1])
        : Number(
            (await q(pool, "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"))[0]?.id,
          );
    return owner > 0 ? { owner } : "no owner: pass --owner <user id>";
  } catch (e) {
    return `database unavailable: ${(e as Error).message}`;
  }
}

const lexicalOrder = (query: string) => {
  const scored = corpus.map((k) => ({ k, ...scoreKnowledge(k, query, "agent") }));
  const ranked = scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k.key.localeCompare(b.k.key));
  return { scored, ranked };
};
const inlineTokens = (query: string, semantic?: Map<string, SemanticHit>) =>
  planKnowledge(corpus, {
    requestText: query,
    stepType: "agent",
    inlineTokens: config.agent.inlineKnowledgeTokens,
    indexSize: config.agent.knowledgeIndexSize,
    semantic: semantic && new Map([...semantic].map(([key, h]) => [key, h.rank])),
  })
    .filter((d) => d.disclosure === "inline")
    .reduce((a, d) => a + d.tokens, 0);

function metrics(rankings: string[][]) {
  const recall = (n: number) =>
    rankings.reduce(
      (a, keys, i) =>
        a +
        queries[i].expected.filter((k) => keys.slice(0, n).includes(k)).length /
          queries[i].expected.length,
      0,
    ) / rankings.length;
  const mrr =
    rankings.reduce((a, keys, i) => {
      const first = keys.findIndex((k) => queries[i].expected.includes(k));
      return a + (first < 0 ? 0 : 1 / (first + 1));
    }, 0) / rankings.length;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { recall_at_5: r(recall(5)), recall_at_10: r(recall(10)), mrr: r(mrr) };
}

const setup = await semanticSetup();
const lexical: string[][] = [];
const hybrid: string[][] = [];
const tokens = { lexical: 0, hybrid: 0 };
let unavailable = typeof setup === "string" ? setup : "";
for (const x of queries) {
  const { scored, ranked } = lexicalOrder(x.query);
  lexical.push(ranked.map((y) => y.k.key));
  tokens.lexical += inlineTokens(x.query);
  if (unavailable || typeof setup === "string") continue;
  const semantic = await semanticRanksByKey(setup.owner, x.query, corpus);
  if (!semantic) {
    unavailable = "semantic service unreachable or failed (see the logged fallback reason)";
    continue;
  }
  hybrid.push(fusedSearchOrder(scored, ranked, semantic).map((y) => y.k.key));
  tokens.hybrid += inlineTokens(x.query, semantic);
}
await pool.end().catch(() => {});

const avg = (n: number) => Math.round(n / queries.length);
const report = {
  queries: queries.length,
  corpus: corpus.length,
  corpus_tokens: corpus.reduce((a, k) => a + estimateTokens(k.content), 0),
  lexical: { ...metrics(lexical), avg_inline_tokens: avg(tokens.lexical) },
  hybrid: unavailable
    ? { unavailable }
    : { ...metrics(hybrid), avg_inline_tokens: avg(tokens.hybrid) },
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  const row = (name: string, m: Record<string, unknown>) =>
    "recall_at_5" in m
      ? `| ${name} | ${m.recall_at_5} | ${m.recall_at_10} | ${m.mrr} | ${m.avg_inline_tokens} |`
      : `| ${name} | unavailable | | | ${m.unavailable} |`;
  console.log(
    [
      `Retrieval evaluation: ${report.queries} queries over ${report.corpus} seeded items`,
      "",
      "| mode | Recall@5 | Recall@10 | MRR | avg inline tokens |",
      "| --- | --- | --- | --- | --- |",
      row("lexical", report.lexical),
      row("hybrid", report.hybrid),
      "",
      JSON.stringify(report),
    ].join("\n"),
  );
}
