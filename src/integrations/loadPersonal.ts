import { loadArgoToken } from "./argocd.ts";
import { loadSplunkCookie } from "./splunk.ts";
import { loadKafkaCookie } from "./kafka.ts";
import { loadVaultToken } from "./vault.ts";
import { currentUserId } from "../auth/execution.ts";

const loaded = new Map<number, number>();
const pending = new Map<number, Promise<void>>();
/** Refresh encrypted personal credentials for the current actor; bounded cost, no background credential sharing. */
export async function loadPersonalIntegrations() {
  const id = currentUserId();
  if (!id || Date.now() - (loaded.get(id) ?? 0) < 15_000) return;
  let p = pending.get(id);
  if (!p) {
    p = Promise.all([loadArgoToken(), loadSplunkCookie(), loadKafkaCookie(), loadVaultToken()]).then(() => { loaded.set(id, Date.now()); }).finally(() => pending.delete(id));
    pending.set(id, p);
  }
  await p;
}
