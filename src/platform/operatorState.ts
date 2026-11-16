/** Keys the Settings page currently owns. While owned, process env does not override them. */
const owned = new Set<string>();

export function own(key: string, on: boolean) {
  if (on) owned.add(key);
  else owned.delete(key);
}

export function isOwned(key: string) {
  return owned.has(key);
}

export function clearOwned() {
  owned.clear();
}
