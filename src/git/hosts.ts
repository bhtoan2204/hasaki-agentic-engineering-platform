import { config } from "../config.ts";
import { resolveBitbucket } from "../bitbucket.ts";
import { resolveGithub } from "../github.ts";
import { resolveGitlab } from "../gitlab.ts";
import type { CanonicalRemote, GitHost } from "../repos/remote.ts";

/**
 * Host-adapter half of the Git provider seam: everything Git transport and access control need to know about a
 * hosting service. The REST half (pull/merge requests, CI) is the GitProvider in ./provider.ts. Adding a host is one
 * entry here, one URL rule in repos/remote.ts and one GitProvider registration.
 */
export interface GitHostAdapter {
  /** Human label used in messages ("GitHub authentication required"). */
  label: string;
  /** Per-host accessVerification policy (strict | personal | trusted). */
  policy(): "strict" | "personal" | "trusted";
  /** User name / token for HTTPS Git transport. Throws an actionable message when no credentials are available. */
  gitCredentials(remote: CanonicalRemote): Promise<{ user: string; token: string }>;
  /** Extra `-c key=value` Git options for this remote (e.g. an internal CA bundle). Never secrets. */
  gitOptions?(remote: CanonicalRemote): string[];
}

export const gitHosts: Record<GitHost, GitHostAdapter> = {
  bitbucket: {
    label: "Bitbucket",
    policy: () => config.bitbucket.accessVerification ?? "strict",
    async gitCredentials() {
      const creds = await resolveBitbucket();
      if (!creds)
        throw new Error(
          "Bitbucket authentication required: save personal credentials in Integrations or configure the authorized service account",
        );
      return {
        user: creds.user.includes("@") ? "x-bitbucket-api-token-auth" : creds.user,
        token: creds.token,
      };
    },
  },
  github: {
    label: "GitHub",
    policy: () => config.github.accessVerification ?? "strict",
    async gitCredentials() {
      const creds = await resolveGithub();
      if (!creds)
        throw new Error(
          "GitHub authentication required: save a personal access token in Integrations. A shared token is used only when github.allowSharedCredentials is true, and it is not a permission grant.",
        );
      return { user: "x-access-token", token: creds.token };
    },
  },
  gitlab: {
    label: "GitLab",
    policy: () => config.gitlab.accessVerification ?? "strict",
    async gitCredentials(remote) {
      const creds = await resolveGitlab(remote.host);
      if (!creds)
        throw new Error(
          `GitLab authentication required: save a personal or project access token for ${remote.host} in Integrations. A shared token is used only when gitlab.allowSharedCredentials is true, and it is not a permission grant.`,
        );
      // GitLab accepts any user name with a token; oauth2 is the documented one for access tokens.
      return { user: "oauth2", token: creds.token };
    },
    gitOptions(remote) {
      const ca = config.gitlab.instances.find((i) => i.host === remote.host)?.caFile;
      return ca ? ["-c", `http.https://${remote.host}/.sslCAInfo=${ca}`] : [];
    },
  },
};

export const isGitHost = (provider: unknown): provider is GitHost =>
  typeof provider === "string" && Object.hasOwn(gitHosts, provider);

export function gitHost(provider: GitHost): GitHostAdapter {
  const h = gitHosts[provider];
  if (!h) throw new Error(`Unknown Git host ${provider}`);
  return h;
}
