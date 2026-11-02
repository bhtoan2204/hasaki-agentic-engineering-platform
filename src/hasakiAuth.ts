import { chromium, type Browser } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";
import { settings } from "./db.ts";

/**
 * Hasaki Work login = email + password + Google Authenticator OTP behind Cloudflare Turnstile, so the platform
 * never logs in by itself. A human logs in, and the platform only picks up the Bearer JWT the web app sends to
 * the wshr API. Two ways to hand it over:
 *  1. openLoginWindow(): a plain Chromium (NOT automation-controlled) with a persistent profile and a loopback
 *     DevTools port; the developer logs in there, we read the Authorization header of the app's own API calls.
 *  2. setToken(): paste the token copied from DevTools of any browser.
 */
const WORK_URL = "https://work.hasaki.vn";
const CDP_PORT = 9333;
const profileDir = () => join(config.dataDir, "chrome-profile");
const apiLog = () => join(config.dataDir, "work-api.log");

let token: { value: string; exp: number } | null = null;
let windowProc: ChildProcess | null = null;
let cdp: Browser | null = null;

function jwtExp(t: string) {
  try {
    return Number(JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp) || 0;
  } catch {
    return 0;
  }
}

export async function loadToken() {
  const saved = await settings.get("work_token");
  if (saved) token = { value: saved, exp: jwtExp(saved) };
}

export async function setToken(raw: string) {
  const value = raw.trim().replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "");
  if (value.split(".").length !== 3) throw new Error("token không đúng dạng JWT (xxx.yyy.zzz)");
  token = { value, exp: jwtExp(value) };
  await settings.set("work_token", value);
}

export function authStatus() {
  const now = Date.now() / 1000;
  const valid = !!token && (token.exp === 0 || token.exp - 30 > now);
  return {
    loggedIn: valid,
    expiresAt: token?.exp ? new Date(token.exp * 1000).toISOString() : null,
    windowOpen: !!windowProc,
  };
}

export async function getToken(): Promise<string> {
  if (!authStatus().loggedIn) throw new Error("Chưa đăng nhập Hasaki Work (hoặc token hết hạn) — đăng nhập trên platform.");
  return token!.value;
}

function chromiumPath() {
  if (config.hasakiWork.chromiumPath) return config.hasakiWork.chromiumPath;
  const base = join(homedir(), ".cache", "ms-playwright");
  const dir = existsSync(base) ? readdirSync(base).find((d) => /^chromium-\d+$/.test(d)) : undefined;
  if (!dir) throw new Error("Không tìm thấy Chromium, đặt hasakiWork.chromiumPath trong config.json");
  return join(base, dir, "chrome-linux", "chrome");
}

/** Open a normal browser window on Hasaki Work; resolves when the window is up. Token is captured in background. */
export async function openLoginWindow() {
  if (windowProc) return;
  windowProc = spawn(
    chromiumPath(),
    [
      `--user-data-dir=${profileDir()}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      `${WORK_URL}/tasks`,
    ],
    { stdio: "ignore" },
  );
  windowProc.on("exit", () => {
    windowProc = null;
    cdp = null;
  });

  for (let i = 0; i < 40 && !cdp; i++) {
    await new Promise((r) => setTimeout(r, 250));
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null);
  }
  if (!cdp) throw new Error("Không kết nối được tới cửa sổ Chromium");

  const ctx = cdp.contexts()[0];
  ctx.on("request", (req) => {
    if (!req.url().startsWith(config.hasakiWork.apiUrl)) return;
    const auth = req.headers()["authorization"];
    if (auth?.startsWith("Bearer ") && auth.slice(7) !== token?.value) {
      setToken(auth).catch(console.error);
    }
  });
  // Keep a log of the app's API calls: used to map list/detail endpoints and to debug when Hasaki changes them.
  ctx.on("response", async (res) => {
    const req = res.request();
    if (!req.url().startsWith(config.hasakiWork.apiUrl)) return;
    const body = await res.text().catch(() => "");
    appendFileSync(apiLog(), JSON.stringify({ at: new Date().toISOString(), method: req.method(), url: req.url(), post: req.postData(), status: res.status(), body: body.slice(0, 4000) }) + "\n");
  });
}

export async function closeLoginWindow() {
  await cdp?.close().catch(() => {});
  windowProc?.kill();
}

/** Call the wshr API the way the web app does. */
export async function workApi(method: string, path: string, params?: Record<string, string | number>, body?: unknown) {
  const url = new URL(config.hasakiWork.apiUrl + "/" + path.replace(/^\//, ""));
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      Accept: "application/json",
      "X-Locale": "vi",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    token = null;
    await settings.set("work_token", "");
    throw new Error("Token Hasaki Work hết hạn — đăng nhập lại trên platform.");
  }
  const json: any = await res.json().catch(() => null);
  if (res.status === 404)
    throw new Error(
      `Hasaki Work ${method} ${url.pathname}: HTTP 404 — endpoint không tồn tại. Mở work.hasaki.vn/tasks, DevTools > Network, ` +
        `tìm request lấy danh sách task tới ${config.hasakiWork.apiUrl} rồi sửa hasakiWork.listPath / detailPath / listQuery trong config.json.`,
    );
  if (!res.ok || !json) throw new Error(`Hasaki Work ${method} ${path}: HTTP ${res.status}`);
  return json;
}
