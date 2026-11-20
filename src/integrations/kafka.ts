import { config } from "../config.ts";
import { personalSettings as settings, PersonalSession } from "./personal.ts";
import { redactSecrets } from "./redact.ts";
import { cookiePairs } from "./curl.ts";

/**
 * Kafka (QC) through kafbat Kafka UI: topics, consumer groups (lag), message search, and producing one message.
 *
 * Kafka UI logs in with Google OAuth2 and keeps a Spring session cookie (`SESSION`); the developer pastes the Cookie
 * header from their browser. Kafka UI runs with RBAC disabled, so that session could produce messages, delete topics
 * or reset offsets: this client therefore only sends GET requests (enforced in `get`), plus the single produce
 * request in `publishMessage`, which is limited to the configured QC allowlist (`kafka.publishAllow`).
 */

const SETTING = "kafka_ui_cookie";
const login = new PersonalSession<{
  cookie: string;
  user: string | null;
  checkedAt: number;
  valid: boolean;
}>();

const baseUrl = () => config.kafka.baseUrl.replace(/\/$/, "");
const MAX_CONTENT = 4000;

/** Cookie header, `Cookie:` line, `SESSION=…`, or a Copy-as-cURL command (bash or Windows cmd). */
export function parseKafkaCookie(raw: string): string {
  const { pairs } = cookiePairs(raw);
  if (!pairs.some((p) => /^SESSION=/i.test(p)))
    throw new Error(
      "không thấy cookie SESSION — copy cả header Cookie (hoặc Copy as cURL) của một request tới Kafka UI",
    );
  return pairs.join("; ");
}

/** The only HTTP verb this integration uses. */
async function get(
  path: string,
  cookie: string,
  params?: Record<string, string | number | boolean | undefined>,
  accept = "application/json",
): Promise<string> {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Cookie: cookie, Accept: accept },
    signal: AbortSignal.timeout(config.kafka.timeoutSeconds * 1000),
  });
  const text = await res.text();
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    if (login.current && cookie === login.current.cookie) login.current.valid = false;
    throw new Error(
      "phiên Kafka UI hết hạn hoặc không hợp lệ — người dùng cần dán cookie mới ở trang Integrations (hỏi qua ask_user nếu cần)",
    );
  }
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = JSON.parse(text).message ?? msg;
    } catch {
      /* ignore: non-JSON error body, keep the raw text */
    }
    throw new Error(`Kafka UI ${res.status} ${path}: ${msg}`);
  }
  return text;
}
const getJson = async <T = unknown>(
  path: string,
  cookie: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => JSON.parse((await get(path, cookie, params)) || "null");

type KafkaCluster = { name: string; status: string; brokerCount: number; topicCount: number };

function requireCookie(): string {
  if (!login.current?.valid)
    throw new Error(
      login.current
        ? "phiên Kafka UI hết hạn — người dùng cần dán cookie mới ở trang Integrations"
        : "chưa kết nối Kafka UI — người dùng dán cookie ở trang Integrations",
    );
  return login.current.cookie;
}

async function check(cookie: string) {
  const clusters = await getJson<KafkaCluster[] | null>("/api/clusters", cookie);
  if (!Array.isArray(clusters))
    throw new Error("Kafka UI không trả về danh sách cluster cho phiên này");
  let user: string | null = null;
  try {
    const a = await getJson<{ userInfo?: { username?: string } } | null>(
      "/api/authorization",
      cookie,
    );
    user = a?.userInfo?.username ?? null;
  } catch {
    /* ignore: the user name is optional */
  }
  return {
    clusters: clusters.map((c) => ({
      name: c.name,
      status: c.status,
      brokers: c.brokerCount,
      topics: c.topicCount,
    })),
    user,
  };
}

export async function loadKafkaCookie() {
  const saved = await settings.get(SETTING);
  if (!saved) {
    if (login.current) login.current = null;
    return;
  }
  try {
    const { cookie, user } = JSON.parse(saved);
    login.current = { cookie, user: user ?? null, checkedAt: 0, valid: true };
  } catch {
    /* ignore: unreadable saved cookie, stay disconnected */
  }
}

export async function kafkaStatus(force = false) {
  let clusters: Array<{ name: string; status: string; brokers: number; topics: number }> = [];
  if (login.current && (force || Date.now() - login.current.checkedAt > 60_000)) {
    try {
      clusters = (await check(login.current.cookie)).clusters;
      login.current.valid = true;
    } catch {
      login.current.valid = false;
    }
    login.current.checkedAt = Date.now();
  }
  return {
    baseUrl: baseUrl(),
    connected: !!login.current?.valid,
    expired: !!login.current && !login.current.valid,
    user: login.current?.user ?? null,
    checkedAt: login.current?.checkedAt ? new Date(login.current.checkedAt).toISOString() : null,
    ...(clusters.length ? { clusters } : {}),
  };
}

export async function setKafkaCookie(raw: string) {
  const cookie = parseKafkaCookie(raw);
  const { user } = await check(cookie);
  login.current = { cookie, user, checkedAt: Date.now(), valid: true };
  await settings.set(SETTING, JSON.stringify({ cookie, user }));
  return kafkaStatus(true);
}

export async function clearKafkaCookie() {
  login.current = null;
  await settings.set(SETTING, "");
  return kafkaStatus();
}

export const kafkaConnected = () => !!login.current?.valid;
export const kafkaExpired = () => !!login.current && !login.current.valid;

// ---------------------------------------------------------------- read-only operations used by the agent tools

async function clusterName(cluster?: string): Promise<string> {
  if (cluster) return cluster;
  if (config.kafka.cluster) return config.kafka.cluster;
  const list = await getJson<KafkaCluster[]>("/api/clusters", requireCookie());
  const online = list.filter((c) => c.status !== "offline");
  if (!online.length) throw new Error("Kafka UI không có cluster nào online");
  if (online.length > 1)
    throw new Error(
      `có nhiều cluster (${online.map((c) => c.name).join(", ")}) — truyền tham số cluster`,
    );
  return online[0].name;
}
const enc = encodeURIComponent;

const PRODUCTION = /(^|[^a-z])(prod|production|live|prd)([^a-z]|$)/i;

/** The cluster and topic a publish would target, or an error: QC allowlist only, production never. */
export async function kafkaPublishTarget(topic: string, cluster?: string) {
  const host = new URL(baseUrl()).hostname;
  if (!/(^|[.-])qc([.-]|\d|$)/i.test(host) || PRODUCTION.test(host))
    throw new Error(`publishing is refused: Kafka UI ${host} is not a QC environment`);
  const allow = config.kafka.publishAllow ?? [];
  if (!allow.length)
    throw new Error("publishing is disabled: no QC topic is allowlisted (kafka.publishAllow)");
  const c = cluster || config.kafka.cluster || (allow.length === 1 ? allow[0].cluster : "");
  if (!c) throw new Error(`pass cluster: one of ${allow.map((a) => a.cluster).join(", ")}`);
  if (PRODUCTION.test(c) || PRODUCTION.test(topic))
    throw new Error(`publishing to production (${c}/${topic}) is never allowed from chat`);
  const entry = allow.find((a) => a.cluster === c);
  const ok = entry?.topics.some((t) =>
    t.endsWith("*") ? topic.startsWith(t.slice(0, -1)) : t === topic,
  );
  if (!ok) throw new Error(`topic ${c}/${topic} is not in the QC publish allowlist`);
  return { cluster: c, topic };
}

/** An allowlisted topic whose entry is marked `preauthorized` publishes without a per-call confirmation. */
export function kafkaPreauthorized(topic: string, cluster?: string) {
  const c =
    cluster ||
    config.kafka.cluster ||
    (config.kafka.publishAllow.length === 1 ? config.kafka.publishAllow[0].cluster : "");
  const entry = config.kafka.publishAllow.find((a) => a.cluster === c);
  return (
    !!entry?.preauthorized &&
    !PRODUCTION.test(topic) &&
    entry.topics.some((t) => (t.endsWith("*") ? topic.startsWith(t.slice(0, -1)) : t === topic))
  );
}

/**
 * Produce one message (Kafka UI `sendTopicMessages`). Success means the broker accepted the event — not that any
 * consumer processed it. The idempotency key travels as a header so consumers and audits can correlate retries.
 */
export async function publishMessage(m: {
  topic: string;
  cluster?: string;
  key?: string | null;
  value: string;
  headers?: Record<string, string>;
  partition?: number;
  idempotencyKey: string;
}) {
  const target = await kafkaPublishTarget(m.topic, m.cluster);
  const cookie = requireCookie();
  const res = await fetch(
    `${baseUrl()}/api/clusters/${enc(target.cluster)}/topics/${enc(target.topic)}/messages`,
    {
      method: "POST",
      redirect: "manual",
      headers: { Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        partition: m.partition ?? 0,
        key: m.key ?? null,
        value: m.value,
        headers: { ...m.headers, "x-idempotency-key": m.idempotencyKey },
        keySerde: "String",
        valueSerde: "String",
      }),
      signal: AbortSignal.timeout(config.kafka.timeoutSeconds * 1000),
    },
  );
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    if (login.current && cookie === login.current.cookie) login.current.valid = false;
    throw new Error(
      "phiên Kafka UI hết hạn hoặc không hợp lệ — dán cookie mới ở trang Integrations",
    );
  }
  if (!res.ok)
    throw new Error(`Kafka UI ${res.status}: ${redactSecrets((await res.text()).slice(0, 300))}`);
  return {
    published: true,
    cluster: target.cluster,
    topic: target.topic,
    partition: m.partition ?? 0,
    key: m.key ?? null,
    idempotency_key: m.idempotencyKey,
    downstream_verified: false,
    note: "Kafka accepted the event. Whether the consumer processed it (e.g. the order exists) is not verified: check consumer lag, the database or logs.",
  };
}

export async function listTopics(query?: string, cluster?: string) {
  const c = await clusterName(cluster);
  const j = await getJson<{
    topics?: {
      name: string;
      partitionCount?: number;
      replicationFactor?: number;
      messagesCount?: number;
      cleanUpPolicy?: string;
    }[];
    pageCount?: number;
  } | null>(`/api/clusters/${enc(c)}/topics`, requireCookie(), {
    page: 1,
    perPage: 100,
    search: query,
    showInternal: false,
    orderBy: "NAME",
  });
  return {
    cluster: c,
    topics: (j?.topics ?? []).map((t) => ({
      topic: t.name,
      partitions: t.partitionCount,
      replication: t.replicationFactor,
      messages: t.messagesCount ?? undefined,
      cleanup: t.cleanUpPolicy,
    })),
    ...((j?.pageCount ?? 0) > 1 ? { note: "more topics exist — narrow the query" } : {}),
  };
}

export async function consumerGroups(query?: string, cluster?: string) {
  const c = await clusterName(cluster);
  const j = await getJson<{
    consumerGroups?: {
      groupId: string;
      state?: string;
      members?: number;
      topics?: number;
      consumerLag?: number;
      messagesBehind?: number;
      coordinator?: { id?: number };
    }[];
  } | null>(`/api/clusters/${enc(c)}/consumer-groups/paged`, requireCookie(), {
    page: 1,
    perPage: 50,
    search: query,
    orderBy: "NAME",
  });
  return {
    cluster: c,
    groups: (j?.consumerGroups ?? []).map((g) => ({
      group: g.groupId,
      state: g.state,
      members: g.members,
      topics: g.topics,
      lag: g.consumerLag ?? g.messagesBehind,
      coordinator: g.coordinator?.id,
    })),
  };
}

export async function consumerGroupDetail(group: string, cluster?: string) {
  const c = await clusterName(cluster);
  const g = await getJson<{
    groupId: string;
    state?: string;
    members?: number;
    consumerLag?: number;
    messagesBehind?: number;
    partitions?: {
      topic: string;
      partition: number;
      currentOffset?: number;
      endOffset?: number;
      consumerLag?: number;
      messagesBehind?: number;
      consumerId?: string;
      host?: string;
    }[];
  }>(`/api/clusters/${enc(c)}/consumer-groups/${enc(group)}`, requireCookie());
  return {
    cluster: c,
    group: g.groupId,
    state: g.state,
    members: g.members,
    lag: g.consumerLag ?? g.messagesBehind,
    partitions: (g.partitions ?? []).map((p) => ({
      topic: p.topic,
      partition: p.partition,
      offset: p.currentOffset,
      end: p.endOffset,
      lag: p.consumerLag ?? p.messagesBehind,
      consumer: p.consumerId,
      host: p.host,
    })),
  };
}

export interface MessageQuery {
  topic: string;
  cluster?: string;
  /** substring searched in key and value by Kafka UI */
  filter?: string;
  /** read from this many minutes ago (FROM_TIMESTAMP); otherwise the newest messages (LATEST) */
  since_minutes?: number;
  partition?: number;
  limit?: number;
}

type KafkaMessage = {
  partition?: number;
  offset?: number;
  timestamp?: string;
  key?: string | null;
  content?: string;
  headers?: Record<string, string>;
};
type KafkaEvent = KafkaMessage & {
  type?: string;
  message?: KafkaMessage & { message?: string };
  error?: string;
  phase?: { name?: string };
  consuming?: { messagesConsumed?: number; elapsedMs?: number };
};

/** Kafka UI streams message search results as server-sent events (TopicMessageEvent); plain JSON is accepted too. */
export function parseMessageEvents(text: string): KafkaEvent[] {
  const t = text.trim();
  if (t.startsWith("[")) return JSON.parse(t);
  return t
    .split(/\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function readMessages(q: MessageQuery) {
  const c = await clusterName(q.cluster);
  const limit = Math.min(q.limit ?? 20, config.kafka.maxMessages);
  const params: Record<string, string | number | undefined> = {
    limit,
    stringFilter: q.filter,
    partitions: q.partition,
    keySerde: "String",
    valueSerde: "String",
  };
  if (q.since_minutes)
    Object.assign(params, {
      mode: "FROM_TIMESTAMP",
      timestamp: Date.now() - Math.round(q.since_minutes * 60_000),
    });
  else params.mode = "LATEST";
  const text = await get(
    `/api/clusters/${enc(c)}/topics/${enc(q.topic)}/messages/v2`,
    requireCookie(),
    params,
    "text/event-stream",
  );
  const events = parseMessageEvents(text);
  const messages = events
    .filter((e) => (e.type ?? "MESSAGE") === "MESSAGE" && (e.message ?? e.content !== undefined))
    .map((e) => e.message ?? e)
    .slice(0, limit)
    .map((m) => {
      const content = redactSecrets(String(m.content ?? ""));
      return {
        partition: m.partition,
        offset: m.offset,
        timestamp: m.timestamp,
        key: m.key == null ? null : redactSecrets(String(m.key)),
        headers: m.headers && Object.keys(m.headers).length ? m.headers : undefined,
        value:
          content.length > MAX_CONTENT
            ? content.slice(0, MAX_CONTENT) + `… (${content.length - MAX_CONTENT} more chars)`
            : content,
      };
    });
  const errors = events
    .filter((e) => e.type === "ERROR" || e.error)
    .map((e) => e.message?.message ?? e.error ?? e.phase?.name)
    .filter(Boolean);
  const consuming = events.filter((e) => e.type === "CONSUMING").at(-1)?.consuming;
  return {
    cluster: c,
    topic: q.topic,
    mode: params.mode,
    ...(q.filter ? { filter: q.filter } : {}),
    count: messages.length,
    ...(consuming ? { scanned: consuming.messagesConsumed, elapsed_ms: consuming.elapsedMs } : {}),
    ...(errors.length ? { errors } : {}),
    messages,
  };
}
