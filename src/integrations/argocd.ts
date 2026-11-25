import { config } from "../config.ts";
import { personalSettings as settings, PersonalSession } from "./personal.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Argo CD (QC) — read access for bug investigation: applications, their pods, and pod/workload logs. The single write
 * is `argocd.restart` (QC only, user-confirmed).
 *
 * Argo CD logs in through Keycloak SSO and keeps the session in the `argocd.token` cookie; the same JWT is accepted by the
 * REST API as `Authorization: Bearer`. The platform cannot run that SSO flow itself (the Keycloak client is confidential
 * and only redirects back to Argo CD), so a developer pastes the cookie from their own browser. Large tokens are split by
 * Argo CD into `argocd.token`, `argocd.token-1`, … — pasting the whole Cookie header joins them.
 */

const SETTING = "argocd_token";
const login = new PersonalSession<{ value: string; exp: number; user: string }>();

const baseUrl = () => config.argocd.baseUrl.replace(/\/$/, "");

function jwtClaims(t: string): {
  exp?: number;
  email?: string;
  sub?: string;
  preferred_username?: string;
} {
  try {
    return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

/** Raw token, `argocd.token=…`, `Bearer …`, or a whole Cookie header (split chunks argocd.token-1… are joined). */
export function parseArgoToken(raw: string): string {
  const s = raw
    .trim()
    .replace(/^cookie:\s*/i, "")
    .replace(/^authorization:\s*/i, "")
    .replace(/^bearer\s+/i, "");
  if (!/argocd\.token(-\d+)?=/.test(s)) return s.replace(/^["']|["']$/g, "");
  const parts = new Map<number, string>();
  for (const m of s.matchAll(/(?:^|[;\s])argocd\.token(?:-(\d+))?=([^;\s]*)/g))
    parts.set(m[1] ? Number(m[1]) : 0, decodeURIComponent(m[2]));
  return [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .join("");
}

export async function loadArgoToken() {
  const saved = await settings.get(SETTING);
  if (!saved) {
    if (login.current) login.current = null;
    return;
  }
  if (saved) {
    const c = jwtClaims(saved);
    login.current = {
      value: saved,
      exp: Number(c.exp) || 0,
      user: String(c.email ?? c.preferred_username ?? c.sub ?? ""),
    };
  }
}

export function argoStatus() {
  const now = Date.now() / 1000;
  const valid = !!login.current && (login.current.exp === 0 || login.current.exp - 30 > now);
  return {
    baseUrl: baseUrl(),
    loggedIn: valid,
    user: login.current?.user || null,
    expiresAt: login.current?.exp ? new Date(login.current.exp * 1000).toISOString() : null,
    expired: !!login.current && !valid,
  };
}

/** Validate against Argo CD (session/userinfo) before saving, so a wrong or expired paste is reported immediately. */
export async function setArgoToken(raw: string) {
  const value = parseArgoToken(raw);
  if (value.split(".").length !== 3)
    throw new Error(
      "token không đúng dạng JWT — dán giá trị cookie argocd.token (hoặc cả header Cookie)",
    );
  const c = jwtClaims(value);
  if (c.exp && c.exp * 1000 < Date.now())
    throw new Error(
      `token đã hết hạn lúc ${new Date(c.exp * 1000).toLocaleString("vi-VN")} — đăng nhập lại Argo CD rồi copy cookie mới`,
    );
  const info = (await rawGet("/api/v1/session/userinfo", value)) as {
    loggedIn?: boolean;
    username?: string;
  } | null;
  if (!info?.loggedIn)
    throw new Error("Argo CD không chấp nhận token này (session/userinfo: loggedIn=false)");
  login.current = {
    value,
    exp: Number(c.exp) || 0,
    user: String(info.username ?? c.email ?? c.sub ?? ""),
  };
  await settings.set(SETTING, value);
  return argoStatus();
}

export async function clearArgoToken() {
  login.current = null;
  await settings.set(SETTING, "");
  return argoStatus();
}

function requireToken(): string {
  const st = argoStatus();
  if (!st.loggedIn)
    throw new Error(
      st.expired
        ? "Token Argo CD đã hết hạn — người dùng cần dán token mới ở trang Integrations của platform (hỏi họ qua ask_user nếu cần log QC)."
        : "Chưa kết nối Argo CD — người dùng cần dán token argocd.token ở trang Integrations của platform.",
    );
  return login.current!.value;
}

async function rawGet(
  path: string,
  bearer: string,
  params?: Record<string, string | number | boolean | undefined>,
  post?: { body: unknown },
): Promise<unknown> {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      ...(post ? { "Content-Type": "application/json" } : {}),
    },
    body: post ? JSON.stringify(post.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    if (login.current && bearer === login.current.value && res.status === 401)
      login.current = { ...login.current, exp: 1 }; // mark expired: the UI shows it
    throw new Error(
      `Argo CD ${res.status} ${path}: ${res.status === 401 ? "token hết hạn hoặc không hợp lệ" : "không có quyền (RBAC)"}`,
    );
  }
  if (!res.ok) throw new Error(`Argo CD ${res.status} ${path}: ${text.slice(0, 300)}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // logs: newline-delimited JSON objects
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
  }
}

const get = (path: string, params?: Record<string, string | number | boolean | undefined>) =>
  rawGet(path, requireToken(), params);

// ---------------------------------------------------------------- read-only operations used by the agent tools

/** Log lines can carry credentials; mask the common shapes before they reach the agent (QC: no PII masking). */
export const redact = redactSecrets;

type ArgoApp = {
  metadata?: { name?: string; namespace?: string };
  spec?: { project?: string; destination?: { namespace?: string } };
  status?: { health?: { status?: string }; sync?: { status?: string } };
};
type ArgoNode = {
  kind: string;
  group?: string;
  name: string;
  namespace?: string;
  health?: { status?: string; message?: string };
  images?: string[];
  info?: { name: string; value: string }[];
  createdAt?: string;
  version?: string;
  parentRefs?: { kind: string; name: string }[];
};
type ArgoLogEntry = {
  content?: string;
  raw?: string;
  last?: boolean;
  timeStampStr?: string;
  timeStamp?: string;
  podName?: string;
  error?: { message?: string };
  result?: ArgoLogEntry;
};

export async function listApps(query?: string) {
  const j = (await get("/api/v1/applications", {
    fields:
      "items.metadata.name,items.metadata.namespace,items.spec.project,items.spec.destination,items.status.health.status,items.status.sync.status",
  })) as { items?: ArgoApp[] } | null;
  const words = (query ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  return (j?.items ?? [])
    .map((a) => ({
      app: a.metadata?.name,
      app_namespace: a.metadata?.namespace,
      project: a.spec?.project,
      namespace: a.spec?.destination?.namespace,
      health: a.status?.health?.status,
      sync: a.status?.sync?.status,
    }))
    .filter(
      (a) =>
        !words.length ||
        words.every((w) => `${a.app} ${a.namespace} ${a.project}`.toLowerCase().includes(w)),
    )
    .slice(0, 100);
}

export async function appPods(app: string, appNamespace?: string) {
  const j = (await get(`/api/v1/applications/${encodeURIComponent(app)}/resource-tree`, {
    appNamespace,
  })) as { nodes?: ArgoNode[] } | null;
  const nodes = j?.nodes ?? [];
  const info = (n: ArgoNode, name: string) => n.info?.find((i) => i.name === name)?.value;
  const workloads = nodes
    .filter((n) =>
      ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Rollout"].includes(n.kind),
    )
    .map((n) => ({
      kind: n.kind,
      group: n.group,
      name: n.name,
      namespace: n.namespace,
      health: n.health?.status,
      images: n.images,
    }));
  const pods = nodes
    .filter((n) => n.kind === "Pod")
    .map((n) => ({
      pod: n.name,
      namespace: n.namespace,
      health: n.health?.status,
      health_message: n.health?.message,
      status: info(n, "Status Reason"),
      containers: info(n, "Containers"),
      restarts: info(n, "Restart Count"),
      node: info(n, "Node"),
      images: n.images,
      created_at: n.createdAt,
      owner: n.parentRefs?.[0] ? `${n.parentRefs[0].kind}/${n.parentRefs[0].name}` : undefined,
    }));
  return { app, workloads, pods };
}

export interface LogQuery {
  app: string;
  app_namespace?: string;
  namespace?: string;
  pod?: string;
  workload?: { kind: string; name: string; group?: string };
  container?: string;
  since_minutes?: number;
  tail_lines?: number;
  filter?: string;
  previous?: boolean;
}

export async function podLogs(q: LogQuery) {
  if (!q.pod && !q.workload) throw new Error("cần pod hoặc workload (lấy từ argocd.app_pods)");
  let namespace = q.namespace;
  if (!namespace) {
    const tree = await appPods(q.app, q.app_namespace);
    namespace =
      (q.pod
        ? tree.pods.find((p) => p.pod === q.pod)?.namespace
        : tree.workloads.find((w) => w.name === q.workload!.name)?.namespace) ??
      tree.pods[0]?.namespace;
    if (!namespace)
      throw new Error(
        `không tìm thấy namespace của ${q.pod ?? q.workload!.name} trong app ${q.app}`,
      );
  }
  const tail = Math.min(q.tail_lines ?? 300, 2000);
  const rows = (await get(`/api/v1/applications/${encodeURIComponent(q.app)}/logs`, {
    appNamespace: q.app_namespace,
    namespace,
    container: q.container,
    sinceSeconds: q.since_minutes ? Math.round(q.since_minutes * 60) : undefined,
    tailLines: tail,
    filter: q.filter,
    previous: q.previous || undefined,
    follow: false,
    ...(q.pod
      ? { podName: q.pod }
      : {
          kind: q.workload!.kind,
          resourceName: q.workload!.name,
          group: q.workload!.group ?? "apps",
        }),
  })) as ArgoLogEntry | ArgoLogEntry[] | null;
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const lines = list
    .map((r) => r?.result ?? r)
    .filter((r) => r && (r.content !== undefined || r.raw !== undefined) && !(r.last && !r.content))
    .map((r) => ({
      ts: r.timeStampStr ?? r.timeStamp,
      pod: r.podName,
      line: redact(String(r.content ?? r.raw ?? "")),
    }));
  const err = list.find((r) => r?.error)?.error;
  return {
    app: q.app,
    namespace,
    target: q.pod ?? `${q.workload!.kind}/${q.workload!.name}`,
    count: lines.length,
    ...(err ? { error: err.message ?? err } : {}),
    lines,
  };
}

// ---------------------------------------------------------------- service discovery (read-only)

const ROUTE_KINDS = ["Ingress", "Gateway", "HTTPRoute", "GRPCRoute"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Argo CD and Kubernetes JSON have no schema here
type K8s = any;

/** Endpoints of an application from its Argo CD metadata, resource tree and route/service manifests. Pure. */
export function endpointsFromArgo(
  app: K8s,
  tree: K8s,
  manifests: Array<{ kind: string; name: string; manifest: K8s }>,
) {
  const nodes: K8s[] = tree?.nodes ?? [];
  const manifest = (kind: string, name: string) =>
    manifests.find((m) => m.kind === kind && m.name === name)?.manifest;
  const routes = nodes
    .filter((n) => ROUTE_KINDS.includes(n.kind))
    .map((n) => {
      const m = manifest(n.kind, n.name);
      const spec = m?.spec ?? {};
      const hosts = new Set<string>([
        ...(n.networkingInfo?.ingress ?? []).map((i: K8s) => i.hostname).filter(Boolean),
        ...(spec.hostnames ?? []),
        ...(spec.rules ?? []).map((r: K8s) => r.host).filter(Boolean),
        ...(spec.tls ?? []).flatMap((t: K8s) => t.hosts ?? []),
        ...(spec.listeners ?? []).map((l: K8s) => l.hostname).filter(Boolean),
      ]);
      const paths: string[] =
        n.kind === "Ingress"
          ? (spec.rules ?? []).flatMap((r: K8s) =>
              (r.http?.paths ?? []).map((p: K8s) => p.path ?? "/"),
            )
          : (spec.rules ?? []).flatMap((r: K8s) =>
              (r.matches ?? []).map((x: K8s) => x.path?.value).filter(Boolean),
            );
      const backends: string[] =
        n.kind === "Ingress"
          ? (spec.rules ?? []).flatMap((r: K8s) =>
              (r.http?.paths ?? []).map(
                (p: K8s) =>
                  `${p.backend?.service?.name}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ""}`,
              ),
            )
          : (spec.rules ?? []).flatMap((r: K8s) =>
              (r.backendRefs ?? []).map((b: K8s) => `${b.name}:${b.port ?? ""}`),
            );
      return {
        kind: n.kind,
        name: n.name,
        namespace: n.namespace,
        hosts: [...hosts],
        paths: [...new Set(paths)].slice(0, 50),
        backends: [...new Set(backends)].slice(0, 20),
        ...(n.kind === "HTTPRoute" || n.kind === "GRPCRoute"
          ? { gateways: (spec.parentRefs ?? []).map((p: K8s) => p.name) }
          : {}),
      };
    });
  const services = nodes
    .filter((n) => n.kind === "Service")
    .map((n) => {
      const spec = manifest("Service", n.name)?.spec ?? {};
      return {
        name: n.name,
        namespace: n.namespace,
        type: spec.type,
        ports: (spec.ports ?? []).map((p: K8s) => ({
          name: p.name,
          port: p.port,
          target: p.targetPort,
        })),
        cluster_dns: `${n.name}.${n.namespace}.svc`,
      };
    });
  const source = app?.spec?.source ?? app?.spec?.sources?.[0] ?? {};
  return {
    app: app?.metadata?.name,
    project: app?.spec?.project,
    namespace: app?.spec?.destination?.namespace,
    source: { repo_url: source.repoURL, path: source.path, revision: source.targetRevision },
    labels: app?.metadata?.labels ?? {},
    external_urls: app?.status?.summary?.externalURLs ?? [],
    images: app?.status?.summary?.images ?? [],
    routes,
    services,
  };
}

/** Service discovery for one application: what it exposes (hosts, paths, backends, ports) and where its code lives. */
export async function serviceEndpoints(appName: string, appNamespace?: string) {
  const app: K8s = await get(`/api/v1/applications/${encodeURIComponent(appName)}`, {
    appNamespace,
  });
  const tree: K8s = await get(`/api/v1/applications/${encodeURIComponent(appName)}/resource-tree`, {
    appNamespace,
  });
  const wanted = (tree?.nodes ?? [])
    .filter((n: K8s) => [...ROUTE_KINDS, "Service"].includes(n.kind))
    .slice(0, 20);
  const manifests = [];
  for (const n of wanted) {
    try {
      const r: K8s = await get(`/api/v1/applications/${encodeURIComponent(appName)}/resource`, {
        appNamespace,
        namespace: n.namespace,
        resourceName: n.name,
        version: n.version,
        kind: n.kind,
        group: n.group ?? "",
      });
      manifests.push({ kind: n.kind, name: n.name, manifest: JSON.parse(r?.manifest ?? "null") });
    } catch {
      // RBAC may hide one resource; the tree's networking info still describes it.
    }
  }
  return endpointsFromArgo(app, tree, manifests);
}

const PRODUCTION = /(^|[^a-z])(prod|production|live|prd)([^a-z]|$)/i;
const RESTARTABLE = ["Deployment", "StatefulSet", "DaemonSet"];

/**
 * The workload a restart would target, or an error: QC only, production never. `version` is the newest child
 * (ReplicaSet/Pod) creation time, so a later restart of the same workload is a new operation.
 */
export async function restartTarget(a: { app: string; workload?: string; app_namespace?: string }) {
  const host = new URL(baseUrl()).hostname;
  if (!/(^|[.-])qc([.-]|\d|$)/i.test(host) || PRODUCTION.test(host))
    throw new Error(`restart is refused: Argo CD ${host} is not a QC environment`);
  if (PRODUCTION.test(a.app))
    throw new Error(`restarting production (${a.app}) is never allowed from chat`);
  const appNamespace = a.app_namespace || "argocd";
  const j = (await get(`/api/v1/applications/${encodeURIComponent(a.app)}/resource-tree`, {
    appNamespace,
  })) as { nodes?: ArgoNode[] } | null;
  const nodes = j?.nodes ?? [];
  const found = nodes.filter(
    (n) => RESTARTABLE.includes(n.kind) && (!a.workload || n.name === a.workload),
  );
  if (found.length !== 1)
    throw new Error(
      found.length
        ? `${a.app} has several workloads (${found.map((n) => n.name).join(", ")}); pass workload`
        : `no restartable workload${a.workload ? ` named ${a.workload}` : ""} in ${a.app}`,
    );
  const w = found[0];
  if (PRODUCTION.test(w.namespace ?? ""))
    throw new Error(`restarting production (${w.namespace}) is never allowed from chat`);
  const version =
    nodes
      .filter((n) => n.parentRefs?.some((p) => p.kind === w.kind && p.name === w.name))
      .map((n) => n.createdAt ?? "")
      .sort()
      .at(-1) || "none";
  return {
    app: a.app,
    app_namespace: appNamespace,
    kind: w.kind,
    group: w.group ?? "apps",
    api_version: w.version ?? "v1",
    name: w.name,
    namespace: w.namespace ?? "",
    version,
  };
}

/** Restart one workload (Argo CD resource action `restart`). Success means the action was accepted, not that new pods are ready. */
export async function restartWorkload(a: {
  app: string;
  workload?: string;
  app_namespace?: string;
}) {
  const t = await restartTarget(a);
  await rawGet(
    `/api/v1/applications/${encodeURIComponent(t.app)}/resource/actions/v2`,
    requireToken(),
    undefined,
    {
      body: {
        appNamespace: t.app_namespace,
        namespace: t.namespace,
        resourceName: t.name,
        version: t.api_version,
        kind: t.kind,
        group: t.group,
        resourceActionParameters: [],
        action: "restart",
      },
    },
  );
  return {
    restarted: true as const,
    app: t.app,
    kind: t.kind,
    name: t.name,
    namespace: t.namespace,
    downstream_verified: false as const,
  };
}
