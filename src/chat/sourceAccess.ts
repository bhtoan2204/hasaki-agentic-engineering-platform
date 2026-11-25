import { localScope } from "../codeIntelligence/indexer.ts";
import { repositories } from "../repos/service.ts";
import { git } from "../git.ts";
import { isSecretPath } from "../agent/toolPolicy.ts";
import { config } from "../config.ts";

/**
 * How chat reaches a repository's source, cheapest first:
 *   1. a valid local or managed checkout (no clone, no fetch);
 *   2. for a registered remote (`repository_url` in the registry, never a URL from a prompt or tool output), the
 *      existing managed checkout path: `prepareRepository()` through `localScope(…, provision)`, under its per-repository
 *      lock and the caller's own credentials (the chat tool runs inside execution.run for the owner);
 *   3. otherwise a precise error naming the missing configuration.
 * Materialization is bounded: at most CHAT_CHECKOUTS at once, and a tool call waits at most CHECKOUT_WAIT_MS (the clone
 * keeps going under its lock; the next call finds it ready). Nothing is cloned eagerly: only a repository a tool reads.
 */
export class SourceUnavailable extends Error {}

const CHAT_CHECKOUTS = 2;
const CHECKOUT_WAIT_MS = 60_000;
let running = 0;
const queue: Array<() => void> = [];
const inflight = new Map<string, Promise<string>>();

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CHAT_CHECKOUTS) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/** Test seam: replaces how a missing checkout is materialized (PLATFORM_TEST only). */
let materializer: ((name: string) => Promise<string>) | null = null;
export function setChatMaterializerForTests(fn: ((name: string) => Promise<string>) | null) {
  if (config.test.platformTest !== "1") throw new Error("test seam disabled");
  materializer = fn;
}

/** The readable checkout root of `name` (authorization is the caller's: the chat tool checks readable repositories). */
export async function checkoutRoot(name: string, waitMs = CHECKOUT_WAIT_MS): Promise<string> {
  try {
    return (await localScope(name, undefined, false)).root;
  } catch (local) {
    const repo = await repositories.get(name);
    if (!repo?.enabled || !repo.allowed_actions.includes("read"))
      throw new SourceUnavailable(`Repository ${name} is disabled or not readable in the registry`);
    if (!repo.repository_url)
      throw new SourceUnavailable(
        `Repository ${name} has no local checkout (${(local as Error).message}) and no registered remote: an admin sets its repository URL on the Repositories page`,
      );
    let work = inflight.get(name);
    if (!work) {
      work = slot(() =>
        materializer ? materializer(name) : localScope(name, undefined, true).then((s) => s.root),
      ).finally(() => inflight.delete(name));
      inflight.set(name, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SourceUnavailable(
              `Preparing a checkout of ${name} from its registered remote is still running; retry this read shortly`,
            ),
          ),
        waitMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([work, late]);
    } catch (e) {
      if (e instanceof SourceUnavailable) throw e;
      throw new SourceUnavailable(
        `Repository ${name} could not be prepared from its registered remote: ${(e as Error).message}. Check the Git hosting integration of your account`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build, dependency, container, CI, deployment and architecture files: where a tech stack is stated. */
const MANIFEST =
  /(^|\/)(go\.mod|package\.json|pnpm-workspace\.yaml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Cargo\.toml|composer\.json|Gemfile|[^/]*\.csproj|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|bitbucket-pipelines\.yml|Chart\.yaml|values[^/]*\.ya?ml|skaffold\.ya?ml|Makefile|README[^/]*|ARCHITECTURE[^/]*|\.env\.example)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)(docs?|architecture|adr)\/[^/]+\.md$|(^|\/)(deploy|k8s|kubernetes|helm|charts|infra|terraform)\/.+\.(ya?ml|tf)$/i;

/** Tracked files of the checkout (never `.git`, never secret paths), optionally filtered; manifests when no filter. */
export async function listRepositoryFiles(name: string, pattern?: string, limit = 200) {
  const root = await checkoutRoot(name);
  const out = await git(root, "ls-files", "-z");
  const files = out.split("\0").filter((f) => f && !isSecretPath(f));
  const needle = pattern?.trim().toLowerCase();
  const matched = needle
    ? files.filter((f) => f.toLowerCase().includes(needle))
    : files.filter((f) => MANIFEST.test(f));
  // Shallow first: root manifests say more about the stack than vendored or fixture copies.
  matched.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return {
    repository: name,
    filter: needle ?? "manifests",
    total_tracked: files.length,
    matched: matched.length,
    files: matched.slice(0, limit),
  };
}
