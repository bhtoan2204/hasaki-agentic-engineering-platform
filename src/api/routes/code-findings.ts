import { fixProofOf } from "../../workflow/proofOfFixStep.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num } from "../../http/params.ts";
import { audit, requireRun, requireWorkItem } from "../../authz/access.ts";
import { currentBaseCommits, reusableScan } from "../../workflow/codeScans.ts";
import { sharedCodeAssessment, sharedView } from "../../sharing/flows.ts";
import { config } from "../../config.ts";
import {
  DISPLAY_STATUSES,
  findingDetail,
  ingestPendingScans,
  listFindings as listCodeFindings,
  setFindingStatus as setCodeFindingStatus,
} from "../../workflow/codeFindings.ts";
import { listCodeScans, listRuns, startRun } from "../../workflow/engine.ts";
import { withCosts } from "../../report/cost.ts";
import { describeTool, listTools } from "../../agent/toolRegistry.ts";
import type { Route } from "./types.ts";
import { localeOf, mine, must, providerOf, support } from "./shared.ts";

export const codeFindingsRoutes: Route[] = [
  // Proof-of-Fix report (agent/proofOfFix.ts): the run's current verdict and its history; access follows the run.
  [
    "GET",
    /^\/api\/runs\/(\d+)\/proof-of-fix$/,
    async (c) => (await requireRun(c.actor, num(c.p[0]), support(c)), fixProofOf(num(c.p[0]))),
  ],
  [
    "GET",
    /^\/api\/tools$/,
    ({ url }) =>
      listTools(url.searchParams.get("q") ?? undefined, { mode: "coding" }).map((t) => ({
        ...t,
        ...describeTool(t.name),
      })),
  ],
  [
    "GET",
    /^\/api\/runs$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.list", "run", "*");
      const workItemId = c.url.searchParams.get("work_item_id");
      return withCosts(
        await listRuns({
          status: c.url.searchParams.get("status") ?? undefined,
          workItemId: workItemId ? num(workItemId, "work_item_id") : undefined,
          ...mine(c),
        }),
        "run",
      );
    },
  ],
  [
    "GET",
    /^\/api\/code-scans$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.list", "run", "code-scans");
      return listCodeScans(mine(c));
    },
  ],
  // Findings of every assessment, deduplicated across scans; completed assessments are ingested on read.
  [
    "GET",
    /^\/api\/code-findings$/,
    async (c) => {
      const scope = mine(c);
      if (scope.all) await audit(c.actor.id, "support.list", "code_finding", "*");
      await ingestPendingScans(scope.all ? undefined : scope.ownerId);
      const p = (k: string) => (c.url.searchParams.get(k) ?? "").trim().slice(0, 200);
      const status = p("status");
      if (status && !(DISPLAY_STATUSES as readonly string[]).includes(status))
        throw new HttpError(400, "status: unknown finding status");
      return listCodeFindings({
        ...scope,
        project: p("project"),
        repo: p("repo"),
        severity: p("severity"),
        kind: p("kind"),
        status,
        q: p("q"),
        scan: p("scan") ? num(p("scan")) : undefined,
        page: Number(p("page")) || 1,
        pageSize: Number(p("page_size")) || 25,
      });
    },
  ],
  [
    "GET",
    /^\/api\/code-findings\/(\d+)$/,
    async (c) => {
      if (support(c)) await audit(c.actor.id, "support.read", "code_finding", c.p[0]);
      return must(await findingDetail(num(c.p[0]), mine(c)), "finding");
    },
  ],
  // The owner's lifecycle decision on a finding: resolved, dismissed (with why), or open again.
  [
    "POST",
    /^\/api\/code-findings\/(\d+)\/status$/,
    async ({ p, body, actor }) => {
      const status = String(body.status ?? "");
      if (!["open", "resolved", "dismissed"].includes(status))
        throw new HttpError(400, "status: open, resolved or dismissed");
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
      if (status === "dismissed" && !note)
        throw new HttpError(400, "note: say why it is dismissed");
      const row = must(
        await setCodeFindingStatus(
          num(p[0]),
          actor,
          status as "open" | "resolved" | "dismissed",
          note,
        ),
        "finding",
      );
      await audit(actor.id, "code_finding.status", "code_finding", p[0], { status, note });
      return row;
    },
  ],
  // Start an assessment unless an equivalent one is running or already analysed every repository's current base
  // commit; `force` always starts a new one.
  [
    "POST",
    /^\/api\/code-scans$/,
    async ({ body, actor }) => {
      const repos: string[] = [
        ...new Set<string>(
          (Array.isArray(body.repositories) ? (body.repositories as unknown[]) : []).map(String),
        ),
      ].sort();
      if (!repos.length || repos.length > 30)
        throw new HttpError(400, "repositories: 1 to 30 repository names");
      const focus = typeof body.focus === "string" ? body.focus.trim().slice(0, 500) : "";
      const project = typeof body.project === "string" ? body.project.trim().slice(0, 120) : "";
      const outputLocale = localeOf(body);
      const agentProvider = providerOf(body);
      // Base commits are resolved (and fetched) at most once per request, whoever asks first.
      let commits: Promise<Record<string, string> | null> | null = null;
      const commitsNow = (r: string[]) => (commits ??= currentBaseCommits(actor.id, r));
      if (body.force !== true) {
        const reuse = await reusableScan(actor.id, repos, focus, commitsNow);
        if (reuse) return reuse;
      }
      const start = (tx?: Parameters<typeof startRun>[1]) =>
        startRun(
          {
            definitionKey: "codebase-assessment",
            repositories: repos,
            inputs: {
              repositories: repos,
              ...(project ? { project } : {}),
              ...(focus ? { focus } : {}),
            },
            title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
            outputLocale,
            agentProvider,
            ownerId: actor.id,
          },
          tx,
        );
      // Shared results (flag SHARED_RESULTS_CODE_ASSESSMENT): another member's analysis of the same commits, or the one
      // running now, instead of a second run. Off, or a key that cannot be built: exactly the path below, as before.
      if (config.sharedResults.codeAssessment) {
        const shared = await sharedCodeAssessment({
          actor,
          focus,
          project,
          outputLocale,
          provider: agentProvider,
          commits: await commitsNow(repos),
          force: body.force === true,
          start: async (tx) => Number((await start(tx)).id),
        });
        if (shared && (shared.outcome === "miss" || shared.outcome === "forced"))
          return { started: true, run_id: shared.runId, shared: await sharedView(shared, actor) };
        if (shared && shared.outcome !== "bypass")
          return { reused: "shared", shared: await sharedView(shared, actor) };
      }
      const run = await start();
      return { started: true, run_id: run.id };
    },
  ],
  [
    "POST",
    /^\/api\/runs$/,
    async ({ body, actor }) => {
      if (body.work_item_id) await requireWorkItem(actor, Number(body.work_item_id), false);
      return startRun({
        definitionKey: String(body.workflow ?? ""),
        version: body.version,
        workItemId: body.work_item_id ?? null,
        inputs: body.inputs,
        repositories: body.repositories,
        title: body.title,
        start: body.start,
        profile: body.profile,
        outputLocale: localeOf(body),
        agentProvider: providerOf(body),
        ownerId: actor.id,
        autonomy: body.autonomy,
      });
    },
  ],
];
