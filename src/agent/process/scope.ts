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

/**
 * systemd-run expands `$VAR` and `$$` in the command line it runs (like a unit's ExecStart): an argument such as a
 * shell script would be silently rewritten with the worker's environment. `$` is escaped as `$$`, which every
 * systemd version turns back into `$`.
 */
export const systemdLiteral = (args: string[]) => args.map((a) => a.replaceAll("$", "$$$$"));
