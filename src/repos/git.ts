import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHost, type SshTransport } from "../git/hosts.ts";
import { repositoryRemote, type CanonicalRemote } from "./remote.ts";

const exec = promisify(execFile);
/** Secrets exist only in the short-lived child environment or a 0600 temp file, never arguments, config or errors. */
async function transportFor(url: string): Promise<{
  remote: CanonicalRemote;
  ssh: SshTransport | null;
  creds: { user: string; token: string } | null;
}> {
  const remote = repositoryRemote(url);
  const adapter = gitHost(remote.provider);
  const ssh = (await adapter.sshTransport?.(remote)) ?? null;
  return { remote, ssh, creds: ssh ? null : await adapter.gitCredentials(remote) };
}

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/**
 * SSH transport: the user's key and the pinned host keys are written to 0600 files in the per-call temp dir
 * (removed afterwards). Host keys are checked strictly and unknown hosts are refused. The canonical HTTPS URL stays
 * what Git stores; a command-line `insteadOf` rewrites it to SSH for this one invocation only.
 */
export async function sshGitSetup(dir: string, ssh: SshTransport, canonicalUrl: string) {
  const key = join(dir, "id_key");
  const knownHosts = join(dir, "known_hosts");
  await writeFile(key, ssh.privateKey.replace(/\r\n/g, "\n").trimEnd() + "\n", { mode: 0o600 });
  await writeFile(knownHosts, ssh.knownHosts, { mode: 0o600 });
  const command = [
    "ssh",
    "-F",
    "/dev/null",
    "-i",
    quote(key),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${quote(knownHosts)}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "UpdateHostKeys=no",
  ].join(" ");
  return {
    env: { GIT_SSH_COMMAND: command, GIT_SSH_VARIANT: "ssh" },
    config: [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      `url.${ssh.url}.insteadOf=${canonicalUrl}`,
    ],
  };
}

export async function remoteGit(url: string, args: string[], cwd?: string): Promise<string> {
  const { remote, ssh, creds } = await transportFor(url);
  const dir = await mkdtemp(join(tmpdir(), "platform-git-"));
  try {
    if (cwd) {
      const local = await exec(
        "git",
        ["-C", cwd, "config", "--local", "--no-includes", "--name-only", "--list"],
        { timeout: 5000 },
      );
      if (
        local.stdout
          .split("\n")
          .some((key) =>
            /^(?:include\.|includeif\.|url\.|http\.|credential\.|filter\.|core\.sshcommand)/i.test(
              key,
            ),
          )
      )
        throw new Error("Unsafe local Git network configuration");
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GIT_|PLATFORM_GIT_|SSH_)/.test(key)) delete env[key];
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    });
    let transport: string[];
    if (ssh) {
      const setup = await sshGitSetup(dir, ssh, remote.url);
      Object.assign(env, setup.env);
      transport = setup.config;
    } else {
      const script = join(dir, "askpass.cjs");
      await writeFile(
        script,
        `const prompt = process.argv[2] || ''; process.stdout.write(/username/i.test(prompt) ? process.env.PLATFORM_GIT_USER : process.env.PLATFORM_GIT_TOKEN);`,
        { mode: 0o600 },
      );
      const helper = join(dir, "askpass");
      // Git executes askpass through its shell on Windows too. Quote executable paths without interpolating secrets.
      await writeFile(
        helper,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
        {
          mode: 0o700,
        },
      );
      Object.assign(env, {
        GIT_ASKPASS: helper,
        PLATFORM_GIT_USER: creds!.user,
        PLATFORM_GIT_TOKEN: creds!.token,
      });
      transport = [
        "-c",
        "http.followRedirects=false",
        "-c",
        "http.sslVerify=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...(gitHost(remote.provider).gitOptions?.(remote) ?? []),
      ];
    }
    const result = await exec(
      "git",
      ["-c", "credential.helper=", "-c", `core.hooksPath=${dir}`, ...transport, ...args],
      { cwd: cwd ?? dir, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return result.stdout.trim();
  } catch (e) {
    const host = gitHost(remote.provider).label;
    if (
      ssh &&
      /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
        String((e as { stderr?: string }).stderr ?? ""),
      )
    )
      throw new Error(
        `${host} SSH host key verification failed: the server key does not match the pinned sshHostKeys for ${remote.host}`,
      );
    // Preserve the existing lease-protected recovery signal without exposing server output.
    if (
      /non-fast-forward|fetch first|\[rejected\]/i.test(
        String((e as { stderr?: string }).stderr ?? ""),
      )
    )
      throw new Error(`${host} push rejected: non-fast-forward`);
    if (
      /authentication failed|access denied|permission denied|\b40[13]\b/i.test(
        String((e as { stderr?: string }).stderr ?? ""),
      )
    )
      throw new Error(
        `${host} authentication required: update personal credentials and check repository permissions in Integrations`,
      );
    // GitHub refuses workflow-file changes from tokens without the workflow permission; say so instead of "failed".
    if (
      /refusing to allow .*(?:workflow|\.github\/workflows)/i.test(
        String((e as { stderr?: string }).stderr ?? ""),
      )
    )
      throw new Error(
        `${host} rejected the push: the token may not change .github/workflows files. Give your token the Workflows (read and write) permission, or the "workflow" scope for a classic token, and save it again in Integrations`,
      );
    if (/Unsafe local Git network configuration/.test((e as Error).message)) throw e;
    // Never propagate a child_process error: it includes command/output and potentially server-echoed credentials.
    throw new Error(
      `${host} Git operation failed: verify repository URL, repository permissions and network connectivity in Integrations`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
