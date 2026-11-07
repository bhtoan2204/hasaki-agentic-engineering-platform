/** Portable identity. Never accept credentials, redirects, alternate protocols or URL path escapes. */
export function repositoryRemote(value: unknown) {
  if (typeof value !== "string" || value !== value.trim() || /[\s\\%?#\x00-\x1f]/.test(value)) throw new Error("Use an HTTPS Bitbucket repository URL without credentials, query or fragment");
  const match = /^https:\/\/bitbucket\.org\/([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?\/?$/i.exec(value);
  if (!match || match[2].includes("..")) throw new Error("Use https://bitbucket.org/<workspace>/<repository>.git");
  const workspace = match[1].toLowerCase(), slug = match[2].toLowerCase();
  return { url: `https://bitbucket.org/${workspace}/${slug}.git`, workspace, slug };
}

export function repositoryBranch(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("-") || /[\s~^:?*\[\\\x00-\x1f]/.test(value) || value.includes("..") || value.includes("@{") || value.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))) throw new Error("Invalid Git branch name");
  return value;
}

/** Translate the exact legacy SSH origin form; registration still uses the strict HTTPS validator above. */
export const legacyBitbucketHttpsUrl = (value: string) =>
  value.replace(/^git@bitbucket\.org:([^/]+)\/([^/]+)$/, "https://bitbucket.org/$1/$2");
