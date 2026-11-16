import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBitbucket } from "../bitbucket.ts";
import { resolveGithub } from "../github.ts";
import { repositoryRemote, type GitHost } from "./remote.ts";

const exec = promisify(execFile);
/** Secrets exist only in the short-lived child environment, never arguments, config, or error objects. */
async function credentialsFor(
  url: string,
): Promise<{ user: string; token: string; provider: GitHost }> {
  const remote = repositoryRemote(url);
  if (remote.provider === "github") {
    const creds = await resolveGithub();
    if (!creds)
      throw new Error(
        "GitHub authentication required: save a personal access token in Integrations. A shared token is used only when github.allowSharedCredentials is true, and it is not a permission grant.",
      );
    return { user: "x-access-token", token: creds.token, provider: "github" };
  }
  const creds = await resolveBitbucket();
  if (!creds)
    throw new Error(
      "Bitbucket authentication required: save personal credentials in Integrations or configure the authorized service account",
    );
  return {
    user: creds.user.includes("@") ? "x-bitbucket-api-token-auth" : creds.user,
    token: creds.token,
    provider: "bitbucket",
  };
}

export async function remoteGit(url: string, args: string[], cwd?: string): Promise<string> {
  const creds = await credentialsFor(url);
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
          .some((key) => /^(?:include\.|includeif\.|url\.|http\.|credential\.|filter\.)/i.test(key))
      )
        throw new Error("Unsafe local Git network configuration");
    }
    const script = join(dir, "askpass.cjs");
    await writeFile(
      script,
      `const prompt = process.argv[2] || ''; process.stdout.write(/username/i.test(prompt) ? process.env.PLATFORM_GIT_USER : process.env.PLATFORM_GIT_TOKEN);`,
      { mode: 0o600 },
    );
    const helper = join(dir, "askpass");
    // Git executes askpass through its shell on Windows too. Quote executable paths without interpolating secrets.
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, {
      mode: 0o700,
    });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GIT_|PLATFORM_GIT_|SSH_)/.test(key)) delete env[key];
    Object.assign(env, {
      GIT_ASKPASS: helper,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      PLATFORM_GIT_USER: creds.user,
      PLATFORM_GIT_TOKEN: creds.token,
    });
    const result = await exec(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        `core.hooksPath=${dir}`,
        "-c",
        "http.followRedirects=false",
        "-c",
        "http.sslVerify=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        ...args,
      ],
      { cwd: cwd ?? dir, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return result.stdout.trim();
  } catch (e) {
    const host = creds.provider === "github" ? "GitHub" : "Bitbucket";
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
    if (/Unsafe local Git network configuration/.test((e as Error).message)) throw e;
    // Never propagate a child_process error: it includes command/output and potentially server-echoed credentials.
    throw new Error(
      `${host} Git operation failed: verify repository URL, repository permissions and network connectivity in Integrations`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
