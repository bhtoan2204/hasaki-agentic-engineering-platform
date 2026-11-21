/**
 * Recovery from a stale build: pages are lazy chunks with hashed names, and a rebuild replaces them. A tab still running
 * the previous build then fails to load the next page it opens (the server answers 404). One reload fetches the current
 * build; a second failure soon after is a real problem and is shown instead of reloading in a loop.
 */
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|is not a valid JavaScript MIME type/i;

export function isChunkLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "ChunkLoadError" || CHUNK_ERROR.test(e.message);
}

const KEY = "ui.chunkReloadAt";
const WINDOW_MS = 30_000;

/** True when the page may reload now (and records it); false within the window or without usable storage. */
export function reloadOnce(
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void },
  now = Date.now(),
): boolean {
  try {
    const last = Number(storage.getItem(KEY) ?? 0);
    if (last && now - last < WINDOW_MS) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
