import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright-core";
import { windowsChromeRelay } from "./windowsChromeRelay.ts";
import { config } from "./config.ts";

export type ConnectionState = "idle" | "waiting" | "connected" | "cancelled" | "timeout" | "error";
type Session = { state: ConnectionState; error?: string; browser?: Browser; stop?: () => void; timer?: NodeJS.Timeout; busy?: boolean; releaseProfile?: () => void; relay?: Awaited<ReturnType<typeof windowsChromeRelay>> };
const sessions = new Map<number, Session>();
export const localChromeEnabled = () => process.env.HASAKI_WORK_BROWSER_MODE === "local" && (!process.env.HOST || ["localhost", "127.0.0.1", "::1"].includes(process.env.HOST));
export function chromePath() {
  if (process.env.HASAKI_WORK_CHROME_PATH) { if (!existsSync(process.env.HASAKI_WORK_CHROME_PATH)) throw new Error("chrome_missing"); return process.env.HASAKI_WORK_CHROME_PATH; }
  const candidates = [ "/opt/google/chrome/google-chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"), "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe", "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"];
  const path = candidates.find((p) => p && existsSync(p));
  if (!path) throw new Error("chrome_missing");
  return path;
}
/** A stable installation identity prevents two platform installs sharing Windows profiles. */
function installationId() {
  const root = join(config.dataDir, "work-chrome");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "installation-id");
  try { writeFileSync(file, randomUUID(), { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const id = readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("chrome_profile");
  return id;
}
export function chromeProfilePath(root: string, installation: string, userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("chrome_profile");
  return join(root, installation, String(userId), "profile");
}
export function connectionStatus(id: number) {
  const s = sessions.get(id);
  return { browserMode: localChromeEnabled() ? "local" : "hosted", connectionState: s?.state ?? "idle", connectionError: s?.error ?? null, browserReady: !!s?.browser && s.state === "waiting", windowOpen: s?.state === "waiting" };
}
async function finish(s: Session, state: ConnectionState, error?: string) {
  s.state = state; s.error = error;
  clearTimeout(s.timer);
  const stop = s.stop; s.stop = undefined;
  await Promise.race([s.browser?.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000).unref())]);
  s.relay?.close();
  stop?.();
  s.releaseProfile?.(); s.releaseProfile = undefined;
}
export async function cancelChrome(id: number) { const s = sessions.get(id); if (s?.state === "waiting") await finish(s, "cancelled"); }
export async function openChrome(id: number, accept: (token: string, valid: () => boolean) => Promise<void>, timeoutMs = 300000) {
  if (!localChromeEnabled()) throw new Error("chrome_hosted");
  if (sessions.get(id)?.state === "waiting") return;
  const s: Session = { state: "waiting" }; sessions.set(id, s);
  s.timer = setTimeout(() => { void finish(s, "timeout"); }, timeoutMs);
  void (async () => {
    try {
      const executable = chromePath();
      const installation = installationId();
      let profile = chromeProfilePath(join(config.dataDir, "work-chrome"), installation, id);
      let nativeProfile = profile;
      const windows = executable.startsWith("/mnt/") && executable.endsWith(".exe");
      const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
      if (windows) {
        const temp = execFileSync(powershell, ["-NoProfile", "-Command", "$env:LOCALAPPDATA"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
        nativeProfile = `${temp}\\HasakiWorkChrome\\${installation}\\${id}\\profile`;
        profile = execFileSync("wslpath", ["-u", nativeProfile], { encoding: "utf8" }).trim();
      }
      if (s.state !== "waiting") return;
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const lock = join(profile, ".platform-connection-lock");
      try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("chrome_profile_busy"); }
      s.releaseProfile = () => { try { rmdirSync(lock); } catch {} };
      let previousEndpoint = "";
      try { previousEndpoint = readFileSync(join(profile, "DevToolsActivePort"), "utf8"); } catch {}
      const args = [`--user-data-dir=${nativeProfile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "https://work.hasaki.vn/auth/login"];
      if (windows) {
        const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
        const script = `$p=Start-Process -FilePath ${quote(executable.replace(/^\/mnt\/([a-z])\//, (_, d) => d.toUpperCase()+":/").replaceAll("/", "\\"))} -ArgumentList @(${args.map((a) => quote('"'+a+'"')).join(",")}) -PassThru; $p.Id`;
        const pid = Number(execFileSync(powershell, ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim());
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("chrome_start");
        s.stop = () => { try { execFileSync(powershell, ["-NoProfile", "-Command", `taskkill /PID ${pid} /T /F 2>$null | Out-Null`], { stdio: "ignore", timeout: 5000 }); } catch {} };
      } else {
        const child = spawn(executable, args, { stdio: "ignore" });
        s.stop = () => { child.kill(); };
        child.on("error", () => { if (s.state === "waiting") void finish(s, "error", "chrome_start"); });
        child.on("exit", () => { if (s.state === "waiting") void finish(s, "cancelled"); });
      }
      for (let i = 0; i < 60 && s.state === "waiting" && !s.browser; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const endpoint = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
          if (endpoint === previousEndpoint) continue;
          const [port, socket] = endpoint.trim().split("\n");
          if (!/^\d+$/.test(port) || !socket?.startsWith("/devtools/browser/")) continue;
          if (windows && !s.relay) s.relay = await windowsChromeRelay(Number(port), powershell);
          if (s.state !== "waiting") { s.relay?.close(); break; }
          s.browser = await chromium.connectOverCDP(`ws://127.0.0.1:${s.relay?.port ?? port}${socket}`, { timeout: windows ? 5000 : 700 });
        } catch {}
      }
      if (s.state !== "waiting") { await s.browser?.close().catch(() => {}); s.relay?.close(); s.stop?.(); return; }
      if (!s.browser) throw new Error(windows ? "chrome_wsl_loopback" : "chrome_debugging");
      const context = s.browser.contexts()[0];
      const api = new URL(config.hasakiWork.apiUrl);
      context.on("request", async (req) => {
        const url = new URL(req.url());
        if (url.origin !== api.origin || !url.pathname.startsWith(api.pathname.replace(/\/$/, "") + "/") || s.state !== "waiting" || s.busy) return;
        const auth = (await req.allHeaders().catch(() => ({} as Record<string, string>)))["authorization"];
        if (!auth?.startsWith("Bearer ")) return;
        s.busy = true;
        try { await accept(auth, () => s.state === "waiting"); if (s.state === "waiting") await finish(s, "connected"); }
        catch { if (s.state === "waiting") s.error = "chrome_verification"; }
        finally { s.busy = false; }
      });
      s.browser.on("disconnected", () => { if (s.state === "waiting") void finish(s, "cancelled"); });
      const page = context.pages()[0] ?? await context.newPage();
      // Reopen Work after listeners attach so a remembered login also emits its API request.
      await page.goto("https://work.hasaki.vn/auth/login", { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      if (s.state === "waiting") await finish(s, "error", ["chrome_missing", "chrome_wsl_loopback", "chrome_debugging", "chrome_profile_busy", "chrome_profile"].includes((e as Error).message) ? (e as Error).message : "chrome_start");
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { for (const s of sessions.values()) { s.relay?.close(); s.stop?.(); s.releaseProfile?.(); } });
