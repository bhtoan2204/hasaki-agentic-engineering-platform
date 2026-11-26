import { log } from "../logging.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import { splunkConfiguredFor } from "../integrations/splunk.ts";
import { signozConfiguredFor } from "../integrations/signoz.ts";
import { installationId } from "./scope.ts";
import type { SharedRow } from "./repository.ts";

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
    if (row.kind === "prod_error.runtime_rca")
      return (await splunkConfiguredFor(actor.id)) || (await signozConfiguredFor(actor.id));
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
