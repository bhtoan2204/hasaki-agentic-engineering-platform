import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { windowsChromeRelay } from "./windowsChromeRelay.ts";

export function existingChromeOwner(username?: string) {
  const owner = process.env.HASAKI_WORK_EXISTING_CHROME_USER?.trim().toLowerCase();
  return !!owner && username === owner;
}

/** Chrome 144+ consent flow, using only the default data directory's DevTools endpoint metadata.
 * Never reads cookies, credentials, Local State or browsing history.
 */
export async function attachExistingWindowsChrome(executable: string, active: () => boolean,
  setRelay: (relay: Awaited<ReturnType<typeof windowsChromeRelay>>) => void) {
  if (!executable.startsWith("/mnt/") || !executable.endsWith(".exe")) throw new Error("chrome_existing_platform");
  const ps = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const local = execFileSync(ps, ["-NoProfile", "-Command", "$env:LOCALAPPDATA"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const root = execFileSync("wslpath", ["-u", local], { encoding: "utf8" }).trim();
  let endpoint: string;
  try { endpoint = readFileSync(join(root, "Google", "Chrome", "User Data", "DevToolsActivePort"), "utf8"); }
  catch { throw new Error("chrome_existing_permission"); }
  const [port, socket] = endpoint.trim().split("\n");
  if (!/^\d+$/.test(port) || !socket?.startsWith("/devtools/browser/")) throw new Error("chrome_existing_permission");
  if (!active()) return;
  const relay = await windowsChromeRelay(Number(port), ps);
  setRelay(relay);
  if (!active()) { relay.close(); return; }
  try {
    // Chrome asks the owner to Allow. A larger timeout gives the owner time to respond.
    return await chromium.connectOverCDP(`ws://127.0.0.1:${relay.port}${socket}`, { timeout: 60000 });
  } catch { relay.close(); throw new Error("chrome_existing_permission"); }
}
