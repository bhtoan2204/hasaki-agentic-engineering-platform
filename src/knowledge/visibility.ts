import { listAccessibleRepositories } from "../repos/access.ts";

/**
 * Knowledge derived from a repository follows that repository's access, whatever its applicability scope:
 *  - REPOSITORY-scoped items need read access to the scoped repository;
 *  - items imported from repository files (metadata.imported_from_repository, or imported_from_local_skill for a skill
 *    imported from a local directory on behalf of a repository) need read access to at least one source repository —
 *    a GLOBAL skill imported from a private repository is still that repository's content.
 * Sources that are not repositories (`~/.claude` user-level skills) carry no repository access requirement.
 * Hidden items are filtered out of lists, previews, agent context and learning, and answer 404 on direct reads.
 */
type Item = {
  scope_type?: string;
  scope_ref?: string;
  metadata?: any;
  versions?: Array<{ metadata?: any }>;
};

/** `~/.claude` and similar pseudo sources: user-level files, not repository content. */
const isPseudoRepo = (name: string) => name.startsWith("~");

export function knowledgeRestricted(item: Item, readable: Set<string>): boolean {
  if (item.scope_type === "REPOSITORY" && !readable.has(String(item.scope_ref ?? "").toLowerCase()))
    return true;
  const meta = item.metadata ?? item.versions?.[0]?.metadata;
  if (meta?.imported_from_repository || meta?.imported_from_local_skill) {
    const repos: string[] = (Array.isArray(meta.source) ? meta.source : [])
      .map((s: any) => String(s?.repo ?? "").toLowerCase())
      .filter((r: string) => r && !isPseudoRepo(r));
    if (repos.length && !repos.some((r) => readable.has(r))) return true;
  }
  return false;
}

/** Lower-cased names of the repositories `userId` can read right now. */
export async function readableRepositoryNames(
  userId: number | null | undefined,
): Promise<Set<string>> {
  if (userId == null) return new Set();
  return new Set(
    (await listAccessibleRepositories(Number(userId))).map((m) => m.repository.name.toLowerCase()),
  );
}

export async function visibleKnowledge<T extends Item>(
  userId: number | null | undefined,
  items: T[],
): Promise<T[]> {
  const readable = await readableRepositoryNames(userId);
  return items.filter((k) => !knowledgeRestricted(k, readable));
}
