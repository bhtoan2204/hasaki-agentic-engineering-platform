import { config } from "../config.ts";
import { log } from "../logging.ts";
import {
  decryptSecretIfPresent,
  getSharedSecret,
  getUserSecretCiphertexts,
} from "../auth/secrets.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import {
  hasPersonalSplunkSecret,
  SPLUNK_SHARED_SECRET_KIND,
  SPLUNK_USER_SECRET_KINDS,
} from "../integrations/splunk.ts";
import { isSignozConfigUsable, SIGNOZ_SECRET_KIND } from "../integrations/signoz.ts";
import { installationId } from "./scope.ts";
import type { SharedRow } from "./repository.ts";

async function hasLogAccess(userId: number): Promise<boolean> {
  // Fetch all personal log credential ciphertexts in one SELECT, decrypt lazily, and skip shared_secrets unless needed.
  const ciphertexts = await getUserSecretCiphertexts(userId, [
    ...SPLUNK_USER_SECRET_KINDS,
    SIGNOZ_SECRET_KIND,
  ]);
  if (hasPersonalSplunkSecret(ciphertexts)) return true;
  if (isSignozConfigUsable(decryptSecretIfPresent(ciphertexts.get(SIGNOZ_SECRET_KIND))))
    return true;
  return (
    config.splunk.allowSharedToken && !!(await getSharedSecret(SPLUNK_SHARED_SECRET_KIND))
  );
}

/**
 * Who may be served a shared analysis (docs/shared-results/PLAN.md, section 6.1), evaluated on every read and never stored:
 *  - the row belongs to this installation's scope;
 *  - code assessment, bug hunt: the actor can read EVERY repository of the row right now (the platform's repository access:
 *    grants, shared level, Bitbucket/GitHub/GitLab verification);
 *  - runtime RCA: the actor can search logs themselves (a personal Splunk or SigNoz connection, or the shared Splunk token
 *    when members may use it), since the RCA carries log evidence.
 * The creator gets no exception: losing access loses the result too. Anything unexpected denies (fail closed).
 */
export async function canReadShared(row: SharedRow, actor: { id: number }): Promise<boolean> {
  try {
    if ((row.key_parts as { scope?: unknown }).scope !== (await installationId())) return false;
    if (row.kind === "prod_error.runtime_rca") return await hasLogAccess(actor.id);
    if (!row.scope_repos?.length) return false;
    const readable = new Set(
      (await listAccessibleRepositories(actor.id)).map((r) => r.repository.name),
    );
    return row.scope_repos.every((r) => readable.has(r));
  } catch (e) {
    log.warn(`shared result access check failed: analysis=${row.id} actor=${actor.id}`, e);
    return false;
  }
}
