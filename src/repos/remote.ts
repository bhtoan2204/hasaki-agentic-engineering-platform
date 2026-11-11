/** Portable identity. Never accept credentials, redirects, alternate protocols or URL path escapes. */
export type GitHost = "bitbucket" | "github";

export interface CanonicalRemote {
  url: string;
  /** Bitbucket workspace or GitHub owner. */
  workspace: string;
  slug: string;
  provider: GitHost;
}

export function repositoryRemote(value: unknown): CanonicalRemote {
  if (typeof value !== "string" || value !== value.trim() || /[\s\\%?#\x00-\x1f]/.test(value))
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
    };
  }
  throw new Error(
    "Use https://bitbucket.org/<workspace>/<repository>.git or https://github.com/<owner>/<repository>.git",
  );
}

export function repositoryBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    /[\s~^:?*\[\\\x00-\x1f]/.test(value) ||
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

/** Normalize a detected origin (HTTPS or the two legacy SSH forms) for comparison. Registration stays strict. */
export function canonicalizeDetectedUrl(value: string): string | null {
  const ssh = value
    .trim()
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
