import { config } from "../config.ts";
import { personalSettings as settings, PersonalSession } from "./personal.ts";
import { redactSecrets } from "./redact.ts";

/**
 * Argo CD (QC) — read-only access for bug investigation: applications, their pods, and pod/workload logs.
 *
 * Argo CD logs in through Keycloak SSO and keeps the session in the `argocd.token` cookie; the same JWT is accepted by the
 * REST API as `Authorization: Bearer`. The platform cannot run that SSO flow itself (the Keycloak client is confidential
 * and only redirects back to Argo CD), so a developer pastes the cookie from their own browser. Large tokens are split by
 * Argo CD into `argocd.token`, `argocd.token-1`, … — pasting the whole Cookie header joins them.
 */

const SETTING = "argocd_token";
const login = new PersonalSession<{ value: string; exp: number; user: string }>();

const baseUrl = () => config.argocd.baseUrl.replace(/\/$/, "");

function jwtClaims(t: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

/** Raw token, `argocd.token=…`, `Bearer …`, or a whole Cookie header (split chunks argocd.token-1… are joined). */
export function parseArgoToken(raw: string): string {
  const s = raw.trim().replace(/^cookie:\s*/i, "").replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "");
  if (!/argocd\.token(-\d+)?=/.test(s)) return s.replace(/^["']|["']$/g, "");
  const parts = new Map<number, string>();
  for (const m of s.matchAll(/(?:^|[;\s])argocd\.token(?:-(\d+))?=([^;\s]*)/g)) parts.set(m[1] ? Number(m[1]) : 0, decodeURIComponent(m[2]));
  return [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("");
}

export async function loadArgoToken() {
  const saved = await settings.get(SETTING);
  if (!saved) { if (login.current) login.current = null; return; }
  if (saved) {
    const c = jwtClaims(saved);
    login.current = { value: saved, exp: Number(c.exp) || 0, user: String(c.email ?? c.preferred_username ?? c.sub ?? "") };
  }
}

export function argoStatus() {
  const now = Date.now() / 1000;
  const valid = !!login.current && (login.current.exp === 0 || login.current.exp - 30 > now);
  return { baseUrl: baseUrl(), loggedIn: valid, user: login.current?.user || null, expiresAt: login.current?.exp ? new Date(login.current.exp * 1000).toISOString() : null, expired: !!login.current && !valid };
}

/** Validate against Argo CD (session/userinfo) before saving, so a wrong or expired paste is reported immediately. */
export async function setArgoToken(raw: string) {
  const value = parseArgoToken(raw);
  if (value.split(".").length !== 3) throw new Error("token không đúng dạng JWT — dán giá trị cookie argocd.token (hoặc cả header Cookie)");
  const c = jwtClaims(value);
  if (c.exp && c.exp * 1000 < Date.now()) throw new Error(`token đã hết hạn lúc ${new Date(c.exp * 1000).toLocaleString("vi-VN")} — đăng nhập lại Argo CD rồi copy cookie mới`);
  const info: any = await rawGet("/api/v1/session/userinfo", value);
  if (!info?.loggedIn) throw new Error("Argo CD không chấp nhận token này (session/userinfo: loggedIn=false)");
  login.current = { value, exp: Number(c.exp) || 0, user: String(info.username ?? c.email ?? c.sub ?? "") };
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

async function rawGet(path: string, bearer: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    if (login.current && bearer === login.current.value && res.status === 401) login.current = { ...login.current, exp: 1 }; // mark expired: the UI shows it
    throw new Error(`Argo CD ${res.status} ${path}: ${res.status === 401 ? "token hết hạn hoặc không hợp lệ" : "không có quyền (RBAC)"}`);
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

const get = (path: string, params?: Record<string, string | number | boolean | undefined>) => rawGet(path, requireToken(), params);

// ---------------------------------------------------------------- read-only operations used by the agent tools

/** Log lines can carry credentials; mask the common shapes before they reach the agent (QC: no PII masking). */
export const redact = redactSecrets;

export async function listApps(query?: string) {
  const j: any = await get("/api/v1/applications", {
    fields: "items.metadata.name,items.metadata.namespace,items.spec.project,items.spec.destination,items.status.health.status,items.status.sync.status",
  });
  const words = (query ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return (j?.items ?? [])
    .map((a: any) => ({
      app: a.metadata?.name,
      app_namespace: a.metadata?.namespace,
      project: a.spec?.project,
      namespace: a.spec?.destination?.namespace,
      health: a.status?.health?.status,
      sync: a.status?.sync?.status,
    }))
    .filter((a: any) => !words.length || words.every((w) => `${a.app} ${a.namespace} ${a.project}`.toLowerCase().includes(w)))
    .slice(0, 100);
}

export async function appPods(app: string, appNamespace?: string) {
  const j: any = await get(`/api/v1/applications/${encodeURIComponent(app)}/resource-tree`, { appNamespace });
  const nodes: any[] = j?.nodes ?? [];
  const info = (n: any, name: string) => n.info?.find((i: any) => i.name === name)?.value;
  const workloads = nodes
    .filter((n) => ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Rollout"].includes(n.kind))
    .map((n) => ({ kind: n.kind, group: n.group, name: n.name, namespace: n.namespace, health: n.health?.status, images: n.images }));
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
    namespace = (q.pod ? tree.pods.find((p) => p.pod === q.pod)?.namespace : tree.workloads.find((w) => w.name === q.workload!.name)?.namespace) ?? tree.pods[0]?.namespace;
    if (!namespace) throw new Error(`không tìm thấy namespace của ${q.pod ?? q.workload!.name} trong app ${q.app}`);
  }
  const tail = Math.min(q.tail_lines ?? 300, 2000);
  const rows: any = await get(`/api/v1/applications/${encodeURIComponent(q.app)}/logs`, {
    appNamespace: q.app_namespace,
    namespace,
    container: q.container,
    sinceSeconds: q.since_minutes ? Math.round(q.since_minutes * 60) : undefined,
    tailLines: tail,
    filter: q.filter,
    previous: q.previous || undefined,
    follow: false,
    ...(q.pod ? { podName: q.pod } : { kind: q.workload!.kind, resourceName: q.workload!.name, group: q.workload!.group ?? "apps" }),
  });
  const list: any[] = Array.isArray(rows) ? rows : rows ? [rows] : [];
  const lines = list
    .map((r) => r?.result ?? r)
    .filter((r) => r && (r.content !== undefined || r.raw !== undefined) && !(r.last && !r.content))
    .map((r) => ({ ts: r.timeStampStr ?? r.timeStamp, pod: r.podName, line: redact(String(r.content ?? r.raw ?? "")) }));
  const err = list.find((r) => r?.error)?.error;
  return { app: q.app, namespace, target: q.pod ?? `${q.workload!.kind}/${q.workload!.name}`, count: lines.length, ...(err ? { error: err.message ?? err } : {}), lines };
}
