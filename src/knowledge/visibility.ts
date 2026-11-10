import { listAccessibleRepositories } from "../repos/access.ts";

/**
 * Knowledge derived from a repository follows that repository's access, whatever its applicability scope:
 *  - REPOSITORY-scoped items need read access to the scoped repository;
 *  - items imported from repository files (metadata.imported_from_repository) need read access to at least one
 *    source repository — a GLOBAL skill imported from a private repository is still that repository's content.
 * Hidden items are filtered out of lists, previews, agent context and learning, and answer 404 on direct reads.
 */
type Item = { scope_type?: string; scope_ref?: string; metadata?: any; versions?: Array<{ metadata?: any }> };

export function knowledgeRestricted(item: Item, readable: Set<string>): boolean {
  if (item.scope_type === "REPOSITORY" && !readable.has(String(item.scope_ref ?? "").toLowerCase())) return true;
  const meta = item.metadata ?? item.versions?.[0]?.metadata;
  if (meta?.imported_from_repository) {
    const repos: string[] = (Array.isArray(meta.source) ? meta.source : []).map((s: any) => String(s?.repo ?? "").toLowerCase()).filter(Boolean);
    if (repos.length && !repos.some((r) => readable.has(r))) return true;
  }
  return false;
}

/** Lower-cased names of the repositories `userId` can read right now. */
export async function readableRepositoryNames(userId: number | null | undefined): Promise<Set<string>> {
  if (userId == null) return new Set();
  return new Set((await listAccessibleRepositories(Number(userId))).map((m) => m.repository.name.toLowerCase()));
}

export async function visibleKnowledge<T extends Item>(userId: number | null | undefined, items: T[]): Promise<T[]> {
  const readable = await readableRepositoryNames(userId);
  return items.filter((k) => !knowledgeRestricted(k, readable));
}
