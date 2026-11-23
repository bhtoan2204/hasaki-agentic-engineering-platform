/**
 * Cross-repository contract extraction: deterministic, line-based recognisers over source text (fed by `git grep` at a
 * pinned commit, so nothing is parsed twice for the same commit). A contract is a key two repositories can meet on —
 * a Kafka topic, an HTTP route, a gRPC service, a database table, a shared proto enum — with the role each side plays.
 *
 * Confidence is explicit: `static` when the key is a literal at the declaration/call site, `inferred` when it is derived
 * from a naming convention (generated gRPC client names, SQL inside string literals, identifiers of a shared enum).
 * Keys computed at runtime (config, env, concatenation) are NOT guessed: such sites produce no contract.
 */

export const EXTRACTOR_VERSION = "contracts-regex-2";
/** Longest line the recognisers look at (longer ones are generated or minified). */
export const MAX_LINE = 4096;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export type ContractKind =
  "kafka_topic" | "http_route" | "grpc_service" | "db_table" | "shared_enum";
export type ContractRole = "provider" | "consumer";
export interface Contract {
  kind: ContractKind;
  role: ContractRole;
  key: string;
  /** HTTP method when known (provider routes, client calls). */
  method?: string;
  file: string;
  line: number;
  snippet: string;
  confidence: "static" | "inferred";
  /** For tables: reader or writer. */
  access?: "read" | "write";
}

const SQL_WORDS = new Set([
  "select",
  "set",
  "where",
  "values",
  "the",
  "table",
  "into",
  "from",
  "update",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "on",
  "as",
  "and",
  "or",
  "not",
  "null",
  "dual",
  "lateral",
  "unnest",
  "jsonb_array_elements",
  "generate_series",
]);

/** `/v1/orders/:id`, `/v1/orders/{id}`, `${base}/v1/orders/${id}` → `/v1/orders/{}` (host, query and params removed). */
export function normalizePath(raw: string) {
  let p = raw.trim();
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\$\{[^}]*\}/, "");
  p = p.split(/[?#]/)[0];
  p = p
    .replace(/\$\{[^}]*\}/g, "{}")
    .replace(/\{[^}/]*\}/g, "{}")
    .replace(/<[^>/]*>/g, "{}")
    .replace(/\/:[A-Za-z_]\w*/g, "/{}")
    .replace(/\/\d+(?=\/|$)/g, "/{}")
    .replace(/%[sdv]/g, "{}")
    .replace(/\/+$/, "")
    .toLowerCase();
  return p.startsWith("/") ? p || "/" : `/${p}`;
}

const isTestPath = (f: string) =>
  /(^|\/)(test|tests|__tests__|testdata|fixtures?)\/|_test\.(go|py)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|Tests?\.java$/.test(
    f,
  );
const isMigration = (f: string) => /(^|\/)(migrations?|db\/migrate|schema)\/|\.sql$/i.test(f);
const LIT = `['"\`]`;

/**
 * Contracts on one line, with up to three preceding lines as context (a Go `kafka.Writer{` opening a struct whose
 * `Topic:` field is on the next line, a `method: "POST"` before a fetch, a proto `package`).
 */
export function extractLine(
  file: string,
  line: number,
  text: string,
  context: string[] = [],
): Contract[] {
  // Generated/minified lines are not hand-written contracts, and bounding the input bounds every regex below.
  if (isTestPath(file) || text.length > MAX_LINE) return [];
  const out: Contract[] = [];
  const ctx = context.join("\n");
  const snippet = text.trim().slice(0, 200);
  const add = (c: Omit<Contract, "file" | "line" | "snippet">) =>
    out.push({ ...c, file, line, snippet });
  const proto = file.endsWith(".proto");
  const sql = file.endsWith(".sql");

  // ---- Kafka
  let m: RegExpMatchArray | null;
  // Property placeholders (`${app.topic}`) are resolved at runtime: never a static key.
  if ((m = text.match(/@KafkaListener\([^)"]{0,200}topics\s*=\s*\{?\s*"([^"$]{1,200})"/)))
    add({ kind: "kafka_topic", role: "consumer", key: m[1], confidence: "static" });
  if (
    (m = text.match(
      new RegExp(`\\bsubscribe\\(\\s*\\{\\s*topics?\\s*:\\s*\\[?\\s*${LIT}([\\w.\\-]+)${LIT}`),
    )) ||
    (m = text.match(new RegExp(`\\bsubscribe\\(\\s*\\[\\s*${LIT}([\\w.\\-]+)${LIT}`))) ||
    (m = text.match(new RegExp(`\\bKafkaConsumer\\(\\s*${LIT}([\\w.\\-]+)${LIT}`)))
  )
    add({ kind: "kafka_topic", role: "consumer", key: m[1], confidence: "static" });
  if (
    (m = text.match(new RegExp(`\\.send\\(\\s*\\{\\s*topic\\s*:\\s*${LIT}([\\w.\\-]+)${LIT}`))) ||
    (m = text.match(
      new RegExp(
        `\\b(?:kafkaTemplate|producer|kafkaProducer)\\.send\\(\\s*${LIT}([\\w.\\-]+)${LIT}`,
        "i",
      ),
    )) ||
    (m = text.match(new RegExp(`\\.produce\\(\\s*${LIT}([\\w.\\-]+)${LIT}`)))
  )
    add({ kind: "kafka_topic", role: "provider", key: m[1], confidence: "static" });
  if ((m = text.match(/\bTopic\s*:\s*"([\w.-]+)"/)) && !/\.send\(/.test(text)) {
    // Go segmentio/confluent structs: the struct type on this or the preceding lines decides the role.
    const where = `${ctx}\n${text}`;
    const writer = /Writer\s*\{|kafka\.Message\s*\{|Producer|\.Produce\(|WriteMessages/.test(where);
    const reader = /ReaderConfig\s*\{|NewReader\(|Consumer|ConsumerGroup|Subscribe/.test(where);
    if (writer !== reader)
      add({
        kind: "kafka_topic",
        role: writer ? "provider" : "consumer",
        key: m[1],
        confidence: "static",
      });
  }

  // ---- HTTP: clients first (a client call is never a route declaration)
  // Whole string literals (bounded, no overlapping quantifiers): the path inside is normalized afterwards. A literal
  // followed by `+` or formatted (Sprintf/format) is a prefix of a runtime-built URL: inferred, never static.
  const client = text.match(
    new RegExp(
      `\\b(?:axios|http|client|httpClient|\\$http|got|ky|restTemplate|request|api(?:Client)?)\\s*\\.\\s*(get|post|put|patch|delete)(?:ForObject|ForEntity)?\\s*\\(\\s*${LIT}([^'"\`]{1,300})${LIT}`,
      "i",
    ),
  );
  const fetchCall = text.match(new RegExp(`\\bfetch\\(\\s*${LIT}([^'"\`]{1,300})${LIT}`));
  const goReq = text.match(
    /http\.NewRequest(?:WithContext)?\(\s*(?:\w+\s*,\s*)?(?:http\.Method(\w+)|"(GET|POST|PUT|PATCH|DELETE)")\s*,\s*(?:\w+\s*\+\s*)?"([^"]{1,300})"/,
  );
  const goGet = text.match(/\bhttp\.(Get|Post)\(\s*(?:\w+\s*\+\s*)?"([^"]{1,300})"/);
  const pathOf = (literal: string) => (literal.includes("/") ? normalizePath(literal) : null);
  const built = (literal: string) =>
    new RegExp(`${escapeRe(literal)}["'\`]\\s*\\+`).test(text) ||
    /Sprintf|\.format\(|%[sdv]/.test(text)
      ? ("inferred" as const)
      : ("static" as const);
  const clientPath = client && pathOf(client[2]);
  const fetchPath = fetchCall && pathOf(fetchCall[1]);
  const goReqPath = goReq && pathOf(goReq[3]);
  const goGetPath = goGet && pathOf(goGet[2]);
  if (clientPath)
    add({
      kind: "http_route",
      role: "consumer",
      key: clientPath,
      method: client![1].toUpperCase(),
      confidence: built(client![2]),
    });
  else if (fetchPath) {
    const method = `${ctx}\n${text}`.match(/method\s*:\s*['"](\w+)['"]/i)?.[1]?.toUpperCase();
    add({
      kind: "http_route",
      role: "consumer",
      key: fetchPath,
      method: method ?? "GET",
      confidence: built(fetchCall![1]),
    });
  } else if (goReqPath)
    add({
      kind: "http_route",
      role: "consumer",
      key: goReqPath,
      method: (goReq![1] ?? goReq![2]).toUpperCase(),
      confidence: built(goReq![3]),
    });
  else if (goGetPath)
    add({
      kind: "http_route",
      role: "consumer",
      key: goGetPath,
      method: goGet![1].toUpperCase(),
      confidence: built(goGet![2]),
    });
  else {
    const route =
      text.match(
        new RegExp(
          `\\b(?:router|app|r|mux|e|g|group|grp|v\\d+|server|srv|routes)\\s*\\.\\s*(get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\\s*\\(\\s*${LIT}(\\/[^'"\`]*)${LIT}`,
        ),
      ) ??
      text.match(
        /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"(\/[^"]*)"/,
      ) ??
      text.match(new RegExp(`@\\w+\\.(get|post|put|patch|delete)\\(\\s*${LIT}(\\/[^'"\`]*)${LIT}`));
    const handle = text.match(
      /\b(?:HandleFunc|Handle)\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^"]*)"/,
    );
    if (route)
      add({
        kind: "http_route",
        role: "provider",
        key: normalizePath(route[2]),
        method: route[1].toUpperCase(),
        confidence: "static",
      });
    else if (handle)
      add({
        kind: "http_route",
        role: "provider",
        key: normalizePath(handle[2]),
        ...(handle[1] ? { method: handle[1] } : {}),
        confidence: "static",
      });
  }

  // ---- gRPC
  if (proto && (m = text.match(/^\s*service\s+(\w+)\s*\{?/)))
    add({ kind: "grpc_service", role: "provider", key: m[1], confidence: "static" });
  if (proto && (m = text.match(/^\s*enum\s+(\w+)\s*\{?/)))
    add({ kind: "shared_enum", role: "provider", key: m[1], confidence: "static" });
  if (!proto && (m = text.match(/\bNew(\w+?)Client\(/)) && !/func\s+New/.test(text))
    add({
      kind: "grpc_service",
      role: "consumer",
      key: m[1].endsWith("Service") ? m[1] : `${m[1]}Service`,
      confidence: "inferred",
    });
  if (!proto && (m = text.match(/\bnew\s+(\w+Service)Client\(/)))
    add({ kind: "grpc_service", role: "consumer", key: m[1], confidence: "inferred" });

  // ---- Database tables
  if (
    (sql || isMigration(file)) &&
    (m = text.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(?:\w+\.)?(\w+)/i))
  )
    add({ kind: "db_table", role: "provider", key: m[1].toLowerCase(), confidence: "static" });
  else if (
    !isMigration(file) &&
    (sql || /['"`]/.test(text)) &&
    // Error messages and log lines quote words like "delete from", they are not queries.
    !/\b(?:Error|Exception)\s*\(|\b(?:log(?:ger)?|console|fmt\.Errorf|errors\.New)\b/.test(text)
  ) {
    const seen = new Set<string>();
    for (const t of text.matchAll(
      /\b(FROM|JOIN|INTO|UPDATE)\s+["`]?(?:\w+\.)?([a-z_][a-z0-9_]{2,})\b/gi,
    )) {
      const name = t[2].toLowerCase();
      if (SQL_WORDS.has(name) || seen.has(name)) continue;
      // A statement shape, not just keywords: SELECT/DELETE … FROM|JOIN, INSERT … INTO, UPDATE … SET.
      const verb = t[1].toUpperCase();
      const shaped =
        verb === "INTO"
          ? /\bINSERT\b/i.test(text)
          : verb === "UPDATE"
            ? /\bSET\b/i.test(text.slice((t.index ?? 0) + t[0].length))
            : /\b(?:SELECT|DELETE)\b/i.test(text.slice(0, t.index ?? 0));
      if (!shaped) continue;
      seen.add(name);
      add({
        kind: "db_table",
        role: "consumer",
        key: name,
        access: /INTO|UPDATE/i.test(t[1]) ? "write" : "read",
        confidence: sql ? "static" : "inferred",
      });
    }
  }
  return out;
}

/** Grep trigger: lines that may hold a contract (the recognisers above decide). One extended regex for git grep. */
export const GREP_PATTERN = [
  "KafkaListener",
  "subscribe\\(",
  "KafkaConsumer\\(",
  "\\.send\\(",
  "\\.produce\\(",
  "Topic *:",
  "\\.(get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete) *\\(",
  "Mapping\\(",
  "HandleFunc\\(",
  "Handle\\(",
  "fetch\\(",
  "NewRequest",
  "http\\.(Get|Post)\\(",
  "^ *service ",
  "^ *enum ",
  "New[A-Za-z]+Client\\(",
  "new [A-Za-z]+ServiceClient\\(",
  "CREATE +TABLE",
  '(FROM|JOIN|INTO|UPDATE|from|join|into|update) +["`]?[a-zA-Z_]',
].join("|");
export const SOURCE_PATHSPECS = [
  "*.go",
  "*.ts",
  "*.tsx",
  "*.js",
  "*.mjs",
  "*.cjs",
  "*.py",
  "*.java",
  "*.kt",
  "*.proto",
  "*.sql",
  ":(exclude)node_modules/*",
  ":(exclude)*/node_modules/*",
  ":(exclude)vendor/*",
  ":(exclude)*.min.js",
  ":(exclude)dist/*",
];

/** Lines git grep printed as matches (context lines do not match the trigger; a context line that did would be a match). */
const GREP_RE = new RegExp(GREP_PATTERN);
/**
 * `git grep -n -z` output: `<rev>:<path>\0<n>\0<text>` per line (matches and context alike, `--` between groups). NUL
 * delimiters keep paths with `:` or `-<digits>-` (date-named migrations) intact.
 */
export function parseGrep(rev: string, output: string) {
  const matches: Array<{ file: string; line: number; text: string; context: string[] }> = [];
  let context: Array<{ file: string; text: string }> = [];
  for (const raw of output.split("\n")) {
    if (raw === "--") {
      context = [];
      continue;
    }
    if (!raw.startsWith(`${rev}:`)) continue;
    const parts = raw.slice(rev.length + 1).split("\0");
    if (parts.length < 3 || !/^\d+$/.test(parts[1])) continue;
    const [file, n] = parts;
    const text = parts.slice(2).join("\0");
    if (GREP_RE.test(text))
      matches.push({
        file,
        line: Number(n),
        text,
        context: context
          .filter((c) => c.file === file)
          .slice(-3)
          .map((c) => c.text),
      });
    context.push({ file, text });
    if (context.length > 6) context = context.slice(-6);
  }
  return matches;
}
