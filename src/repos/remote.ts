import { config } from "../config.ts";

/** Portable identity. Never accept credentials, redirects, alternate protocols or URL path escapes. */
export type GitHost = "bitbucket" | "github" | "gitlab";

export interface CanonicalRemote {
  url: string;
  /** Bitbucket workspace, GitHub owner or GitLab namespace path ("group/subgroup"). */
  workspace: string;
  slug: string;
  provider: GitHost;
  /** Host name of the remote (GitLab instances differ per repository). */
  host: string;
}

/** Most namespace levels accepted in a GitLab path (GitLab itself allows 20 levels of subgroups). */
const GITLAB_MAX_NAMESPACE = 20;
const GITLAB_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/** Allow-listed GitLab hosts (config.gitlab.instances). Exact, case-insensitive host match; no ports. */
export function gitlabHosts(): string[] {
  return (config.gitlab?.instances ?? []).map((i) => i.host.toLowerCase());
}

function gitlabRemote(value: string): CanonicalRemote | null {
  const m = /^https:\/\/([^/@:]+)\/(.+?)(?:\.git)?\/?$/i.exec(value);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!gitlabHosts().includes(host)) return null;
  const parts = m[2].toLowerCase().split("/");
  if (parts.length < 2 || parts.length > GITLAB_MAX_NAMESPACE + 1) return null;
  if (parts.some((p) => !GITLAB_SEGMENT.test(p) || p.includes("..") || p.endsWith(".")))
    return null;
  const slug = parts.pop()!;
  const workspace = parts.join("/");
  return { url: `https://${host}/${workspace}/${slug}.git`, workspace, slug, provider: "gitlab", host };
}

export function repositoryRemote(value: unknown): CanonicalRemote {
  if (typeof value !== "string" || value !== value.trim() || /[\s\\%?#\p{Cc}]/u.test(value))
    throw new Error("Use an HTTPS Git repository URL without credentials, query or fragment");
  const bitbucket =
    /^https:\/\/bitbucket\.org\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (bitbucket && !bitbucket[2].includes("..")) {
    const workspace = bitbucket[1].toLowerCase();
    const slug = bitbucket[2].toLowerCase();
    return {
      url: `https://bitbucket.org/${workspace}/${slug}.git`,
      workspace,
      slug,
      provider: "bitbucket",
      host: "bitbucket.org",
    };
  }
  const github =
    /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (github && !github[2].includes("..")) {
    const workspace = github[1].toLowerCase();
    const slug = github[2].toLowerCase();
    return {
      url: `https://github.com/${workspace}/${slug}.git`,
      workspace,
      slug,
      provider: "github",
      host: "github.com",
    };
  }
  const gitlab = gitlabRemote(value);
  if (gitlab) return gitlab;
  throw new Error(
    "Use https://bitbucket.org/<workspace>/<repository>.git, https://github.com/<owner>/<repository>.git or https://<allowed GitLab host>/<group>[/<subgroup>...]/<project>.git",
  );
}

export function repositoryBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    /[\s~^:?*[\\\p{Cc}]/u.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))
  )
    throw new Error("Invalid Git branch name");
  return value;
}

/** Translate the exact legacy SSH origin form; registration still uses the strict HTTPS validator above. */
export const legacyBitbucketHttpsUrl = (value: string) =>
  value.replace(/^git@bitbucket\.org:([^/]+)\/([^/]+)$/, "https://bitbucket.org/$1/$2");

/** Normalize a detected origin (HTTPS or the legacy SSH forms) for comparison. Registration stays strict. */
export function canonicalizeDetectedUrl(value: string): string | null {
  const ssh = gitlabSshToHttps(value.trim())
    .replace(
      /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
      "https://github.com/$1/$2.git",
    )
    .replace(/^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/, "https://bitbucket.org/$1/$2.git");
  const https = legacyBitbucketHttpsUrl(ssh);
  try {
    return repositoryRemote(https).url;
  } catch {
    return null;
  }
}

/** `git@<allowed host>:ns/project.git` and `ssh://git@<allowed host>[:port]/ns/project.git` → HTTPS identity. */
function gitlabSshToHttps(value: string): string {
  const m =
    /^git@([^:/]+):([^\s]+?)(?:\.git)?$/.exec(value) ??
    /^ssh:\/\/git@([^:/]+)(?::\d{1,5})?\/([^\s]+?)(?:\.git)?$/.exec(value);
  if (!m || !gitlabHosts().includes(m[1].toLowerCase())) return value;
  return `https://${m[1].toLowerCase()}/${m[2]}.git`;
}
