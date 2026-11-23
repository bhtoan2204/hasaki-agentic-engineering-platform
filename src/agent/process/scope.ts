import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

/** What systemd-run itself needs from the worker environment (bus addresses only); bwrap unsets both. */
export function scopeEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const uid = userInfo().uid;
  const runtimeDir = base.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
  };
}

let expandsDollar: boolean | undefined;
/** systemd-run --scope expands `$` on newer systemd but passes it through on older ones (249); probed once. */
function systemdExpandsDollar() {
  if (expandsDollar !== undefined) return expandsDollar;
  const r = spawnSync(
    "systemd-run",
    ["--user", "--scope", "-q", "--collect", "--", "/bin/sh", "-c", "printf %s '$$'"],
    { env: { PATH: process.env.PATH, ...scopeEnvironment() }, timeout: 5000, encoding: "utf8" },
  );
  if (r.status !== 0) return true;
  expandsDollar = r.stdout === "$";
  return expandsDollar;
}

/**
 * systemd-run may expand `$VAR` and `$$` in the command line it runs (like a unit's ExecStart): an argument such as a
 * shell script would be silently rewritten with the worker's environment. Where it does, `$` is escaped as `$$`.
 */
export const systemdLiteral = (args: string[]) =>
  systemdExpandsDollar() ? args.map((a) => a.replaceAll("$", "$$$$")) : args;
