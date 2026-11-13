import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "../config.ts";

const HOME_CREDENTIALS = [
  ".pgpass",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".aws",
  ".ssh",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gcloud",
];
/** Fail-closed Claude sandbox for live evaluation: no network, only the throwaway database socket, no credentials. */
export function liveClaudeSandbox(databaseUrl: string) {
  const socket = new URL(databaseUrl).searchParams.get("host");
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSockets: socket ? [socket] : [],
    },
    filesystem: {
      denyRead: [
        ...HOME_CREDENTIALS.map((p) => join(homedir(), p)),
        resolve(process.env.PLATFORM_CONFIG ?? "config.json"),
        config.reposRoot,
        ...Object.values(config.repositories),
      ],
    },
  };
}
