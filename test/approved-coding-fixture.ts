import { FEATURE_TARGETED_COMMAND } from "../src/workflow/templates.ts";
/** Persisted upstream fixtures for provider tests, which exercise transport rather than plan generation. */
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { config } from "../src/config.ts";
import { resolveRepoPath } from "../src/repos/paths.ts";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pool, one, q } from "../src/db/pool.ts";
import { workspacesOf, recordWorkspace } from "../src/git/provider.ts";
import { validateSpec } from "../src/workflow/graph.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { repositories, repositoryBaseBranch } from "../src/repos/service.ts";
import type { RunRow } from "../src/workflow/types.ts";

export async function approvedCodingFixture(runId: number, key: string, maxRepairs = 0) {
  const run = (await one<RunRow>(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]))!;
  const repo = run.selected_repositories[0] ?? run.allowed_repositories[0] ?? "oms-api";
  if (!run.allowed_repositories.length) {
    await repositories.upsert(repo, { shared_access: "write" });
    run.allowed_repositories = [repo];
  }
  await shareAllRepositoriesForTests();
  if (!run.owner_id) {
    const owner = (await one<{ id: number }>(pool, "INSERT INTO users(username,password_hash,role) VALUES('transport-fixture','invalid-fixture-hash','member') ON CONFLICT(username) DO UPDATE SET active=true RETURNING id"))!;
    await q(pool, "UPDATE workflow_runs SET owner_id=$2 WHERE id=$1", [runId, owner.id]);
  }
  const planKey = key === "plan" ? "fix_proposal" : "plan";
  const approvalKey = key === "plan" ? "approve_fix" : "approve_plan";
  const plan = { summary: "Exercise the provider transport", acceptance_criteria: ["Preserve provider session and tool policy"], tests: ["fixture/TestTransport"] };
  for (const [position, stepKey, type, output] of [
    [-2, planKey, "agent", plan], [-1, approvalKey, "human_approval", { approved: true, by: "fixture" }],
  ] as const) {
    const step = (await one<{ id: number }>(pool,
      "INSERT INTO workflow_steps(run_id,key,type,name,position,status,output) VALUES($1,$2,$3,$2,$4,'COMPLETED',$5) RETURNING id",
      [runId, stepKey, type, position, JSON.stringify(output)]))!;
    const ancestors = await q<{ key: string; current_attempt_id: number; output: unknown }>(pool,
      "SELECT key,current_attempt_id,output FROM workflow_steps WHERE run_id=$1 AND status='COMPLETED' AND current_attempt_id IS NOT NULL", [runId]);
    const input = stepKey === approvalKey ? { upstream: Object.fromEntries(ancestors.map(source => [source.key, { attempt_id: source.current_attempt_id, output: source.output, status: "COMPLETED" }])) } : {};
    const attempt = (await one<{ id: number }>(pool,
      "INSERT INTO workflow_step_attempts(run_id,step_id,number,generation,status,input,output) VALUES($1,$2,1,1,'COMPLETED',$3,$4) RETURNING id",
      [runId, step.id, JSON.stringify(input), JSON.stringify(output)]))!;
    await q(pool, "UPDATE workflow_steps SET current_attempt_id=$2 WHERE id=$1", [step.id, attempt.id]);
  }
  const command = FEATURE_TARGETED_COMMAND;
  run.graph.steps.push(...validateSpec({ name: "fixture", steps: [{ key: planKey, type: "agent" }, { key: approvalKey, type: "human_approval", depends_on: [planKey] }] }).steps);
  const coding = run.graph.steps.find(s => s.key === key)!;
  coding.depends_on = [...(coding.depends_on ?? []), approvalKey];
  coding.config = { ...coding.config, verify: { command, baseline: null, max_repairs: maxRepairs } };
  await q(pool, "UPDATE workflow_runs SET graph=$2,selected_repositories=$3,allowed_repositories=$4 WHERE id=$1", [runId, JSON.stringify(run.graph), run.selected_repositories.length ? [repo] : [], run.allowed_repositories]);
  await q(pool, "UPDATE workflow_steps SET depends_on=$3,config=$4 WHERE run_id=$1 AND key=$2", [runId, key, coding.depends_on, JSON.stringify(coding.config)]);
  if (!(await workspacesOf(runId)).length) {
    mkdirSync(config.dataDir, { recursive: true });
    const path = mkdtempSync(join(config.dataDir, "approved-transport-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
    const registered = await repositories.get(repo);
    const primary = registered ? resolveRepoPath(registered) : "";
    if (primary && existsSync(join(primary, ".git")))
      execFileSync("git", ["-C", primary, "worktree", "add", "--detach", path, "HEAD"], { stdio: "pipe" });
    else git("init", "-q");
    writeFileSync(join(path, "fixture.txt"), "transport fixture");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    await recordWorkspace(runId, { repo, path, branch: run.branch, created_from: "test" });
  }
  for (const workspace of await workspacesOf(runId)) {
    execFileSync("git", ["-C", workspace.path, "update-ref", `refs/remotes/origin/${await repositoryBaseBranch(workspace.repo)}`, "HEAD"], { stdio: "pipe" });
    writeFileSync(join(workspace.path, "implementation-evidence.txt"), "Prior implementation work for the transport fixture\n");
    writeFileSync(join(workspace.path, "go.mod"), "module fixture\n\ngo 1.20\n");
    const packageName = existsSync(join(workspace.path, "refund.go")) ? "payment" : "fixture";
    writeFileSync(join(workspace.path, "transport_test.go"), `package ${packageName}\nimport "testing"\nfunc TestTransport(t *testing.T) { if 2 + 2 != 4 { t.Fatal("fixture verification failed") } }\n`);
  }
}
