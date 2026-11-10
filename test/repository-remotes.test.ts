import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../src/config.ts";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate, loadMigrations } from "../src/db/migrate.ts";
import { repositoryRemote, repositoryBranch } from "../src/repos/remote.ts";
import { repositories } from "../src/repos/service.ts";
import { unsafeRelativePath, resolveRepoPath, validateCheckout, instanceDirectory } from "../src/repos/paths.ts";
import { prepareRepository, workspaceStatus, testRepositoryConnection } from "../src/repos/workspaces.ts";
import { migrateLegacyRepositories } from "../src/repos/legacy.ts";
import { resolveBitbucket } from "../src/bitbucket.ts";
import { execution } from "../src/auth/execution.ts";
import { createUser } from "../src/auth/users.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { prepareWorkspace } from "../src/git/provider.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { indexRepository, localScope } from "../src/codeIntelligence/indexer.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]) => execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
const root = mkdtempSync(join(tmpdir(), "remote-tests-"));
const origin = join(root, "origin.git"), source = join(root, "source"), audit = join(root, "audit");
const url = "https://bitbucket.org/test-team/remote-source.git";
let userA: number, userB: number;
const asA = <T>(f: () => Promise<T>) => execution.run({ userId: userA, kind: "user" }, f);
const asB = <T>(f: () => Promise<T>) => execution.run({ userId: userB, kind: "user" }, f);
let oldPath: string | undefined;

before(async () => {
  await migrate(pool, loadMigrations().slice(0, 27));
  await q(pool, `INSERT INTO repositories(name,remote_slug,projects,tags,dependencies) VALUES
    ('legacy-full','https://bitbucket.org/Other-Team/Old.git','{OMS}','{kept}','{dependency}'),
    ('legacy-unknown','unknown','{OMS}','{}','{}'),
    ('duplicate-a','https://bitbucket.org/team/duplicate.git','{}','{}','{}'),
    ('duplicate-b','https://bitbucket.org/team/duplicate','{}','{}','{}')`);
  await q(pool, `INSERT INTO knowledge_items(key,category,scope_type,scope_ref,title) VALUES ('legacy-reference','repository_convention','REPOSITORY','legacy-full','Keep reference')`);
  await q(pool, `INSERT INTO code_intelligence.snapshots(repository_id,commit_sha,index_version,identity) SELECT id,'abc123','legacy','before-migration' FROM repositories WHERE name='legacy-full'`);
  await migrate();
  await shareAllRepositoriesForTests();
  userA = (await createUser({ username: "remote-a", password: "password-a", role: "admin" })).id;
  userB = (await createUser({ username: "remote-b", password: "password-b", role: "member" })).id;
  await putUserSecret(userA, "bitbucket_user", "person@example.com");
  await putUserSecret(userA, "bitbucket_token", "private-token-a");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "source.ts"), "export function isolatedRemote() { return 42; }\n");
  git(source, "add", "."); git(source, "commit", "-qm", "initial");
  git(root, "clone", "--bare", source, origin);
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const real = ${JSON.stringify(realGit)}, origin = ${JSON.stringify(origin)};
let args = process.argv.slice(2);
const canonical = args.find(a=>a.startsWith('https://bitbucket.org/'));
const op = canonical ? args.find(a=>['clone','fetch','push','ls-remote'].includes(a)) : undefined;
if (op) {
 if (!process.env.GIT_ASKPASS || !process.env.PLATFORM_GIT_TOKEN) throw Error('missing askpass');
 const username = execFileSync(process.env.GIT_ASKPASS, ['Username for Bitbucket'], {encoding:'utf8'});
 const password = execFileSync(process.env.GIT_ASKPASS, ['Password for Bitbucket'], {encoding:'utf8'});
 if (password !== process.env.PLATFORM_GIT_TOKEN || username !== 'x-bitbucket-api-token-auth') throw Error('wrong token authentication');
 appendFileSync(${JSON.stringify(audit)}, JSON.stringify({op,helper:process.env.GIT_ASKPASS})+'\\n');
 if (process.env.REMOTE_TEST_REVOKED) { process.stderr.write(process.env.PLATFORM_GIT_TOKEN); process.exit(1); }
 if (op==='ls-remote') { process.stdout.write('123 HEAD'); process.exit(0); }
 args = args.map(a=>a.startsWith('https://bitbucket.org/') ? origin : a);
 // Test transport is a local bare Git repo; production always forbids file transport.
 args = ['-c','protocol.file.allow=always', ...args];
}
try {
 process.stdout.write(execFileSync(real,args,{encoding:'utf8',stdio:[0,'pipe','pipe']}));
 if(op==='clone') execFileSync(real,['-C',args.at(-1),'remote','set-url','origin',canonical]);
} catch(e) { process.stderr.write(e.stderr || 'mock git failed'); process.exit(1); }
`, { mode: 0o700 });
  oldPath = process.env.PATH; process.env.PATH = bin + ":" + oldPath;
  await seedTemplates();
});
after(async () => { process.env.PATH = oldPath; delete process.env.REMOTE_TEST_REVOKED; await pool.end(); });

test("canonical URLs normalize case and optional .git; malicious URL forms are rejected", () => {
  for (const raw of ["https://bitbucket.org/Team/Repo", "https://bitbucket.org/team/repo.git", "https://bitbucket.org/team/repo/"]) assert.equal(repositoryRemote(raw).url, "https://bitbucket.org/team/repo.git");
  for (const raw of ["ssh://bitbucket.org/a/b", "git@bitbucket.org:a/b", "file:///tmp/a", "https://evil.test/a/b", "https://bitbucket.org.evil.test/a/b", "https://u:token@bitbucket.org/a/b", "https://bitbucket.org:443/a/b", "https://bitbucket.org/a/../b", "https://bitbucket.org/a/%2e%2e", "https://bitbucket.org/a/b?x=1", "https://bitbucket.org/a/b#x", "https://bitbucket.org/a/b/extra", "https://bitbucket.org/a/b\\c", " https://bitbucket.org/a/b"]) assert.throws(() => repositoryRemote(raw), raw);
  for (const path of ["../escape", "..\\escape", "C:\\private", "\\\\host\\share"]) assert.equal(unsafeRelativePath(path), true);
  assert.equal(unsafeRelativePath("repository/checkout"), false);
  for (const branch of ["-x", "a..b", "a@{b", "a.lock", "a//b"]) assert.throws(() => repositoryBranch(branch));
});

test("SQL upgrade backfills only complete unique remotes and preserves IDs and metadata", async () => {
  const full = (await repositories.get("legacy-full"))!;
  assert.equal(full.repository_url, "https://bitbucket.org/other-team/old.git");
  assert.deepEqual(full.projects, ["OMS"]); assert.deepEqual(full.tags, ["kept"]); assert.deepEqual(full.dependencies, ["dependency"]);
  for (const name of ["legacy-unknown", "duplicate-a", "duplicate-b"]) assert.equal((await repositories.get(name))?.repository_url, null);
  assert.equal((await one(pool,"SELECT repository_id FROM code_intelligence.snapshots WHERE identity='before-migration'"))?.repository_id,full.id);
  assert.equal((await one(pool,"SELECT scope_ref FROM knowledge_items WHERE key='legacy-reference'"))?.scope_ref,full.name);
  const ids = (await repositories.list()).map(r=>r.id);
  assert.deepEqual(await migrate(), []);
  assert.deepEqual((await repositories.list()).map(r=>r.id), ids);
});

test("unique remote registration preserves logical identities and URL validation cannot leak credentials", async () => {
  const row = await repositories.upsert("portable", { repository_url: url, default_branch: "main", projects: ["Remote"], tags: ["preserved"] });
  const updated = await repositories.upsert("portable", { description: "portable metadata" });
  assert.equal(row?.id, updated?.id); assert.deepEqual(updated?.tags, ["preserved"]);
  await assert.rejects(repositories.upsert("alias", { repository_url: url.replace(/.git$/, "") }), /duplicate key/);
  await assert.rejects(repositories.upsert("bad", { repository_url: "https://person:secret@bitbucket.org/team/repo" }), e => !(e as Error).message.includes("secret"));
});

test("personal credentials are owner-scoped and shared fallback follows policy", async () => {
  assert.equal((await asA(resolveBitbucket))?.token, "private-token-a");
  assert.equal(await asB(resolveBitbucket), null);
  config.bitbucket.user = "shared@example.com"; config.bitbucket.token = "shared-token";
  try {
    assert.equal((await asB(resolveBitbucket))?.token, "shared-token");
    config.bitbucket.allowSharedCredentials = false;
    assert.equal(await asB(resolveBitbucket), null);
    assert.equal((await asA(resolveBitbucket))?.token, "private-token-a");
    await putUserSecret(userB, "bitbucket_user", "incomplete@example.com");
    await assert.rejects(asB(resolveBitbucket), /incomplete/);
  } finally { config.bitbucket.user = ""; config.bitbucket.token = ""; delete config.bitbucket.allowSharedCredentials; }
});

test("lazy preparation clones once under concurrent callers, reuses verified checkouts and cleans askpass", async () => {
  const repo = (await repositories.get("portable"))!;
  const status = await workspaceStatus(repo);
  assert.equal(status.status, "not_cloned"); assert.ok(!JSON.stringify(status).includes(config.dataDir));
  const paths = await asA(() => Promise.all([prepareRepository(repo), prepareRepository(repo), prepareRepository(repo)]));
  assert.equal(new Set(paths).size, 1);
  assert.equal(paths[0], resolveRepoPath(repo));
  assert.ok(existsSync(join(paths[0], "source.ts")));
  const calls = readFileSync(audit,"utf8").trim().split("\n").map(s=>JSON.parse(s));
  assert.equal(calls.filter(c=>c.op==='clone').length, 1);
  for (const c of calls) assert.equal(existsSync(dirname(c.helper)), false);
  assert.ok(!readFileSync(join(paths[0], ".git", "config"),"utf8").includes("private-token"));
  assert.notEqual(resolveRepoPath(repo, {...config,instanceId:"different-instance"}), paths[0]);
  assert.ok(paths[0].includes(instanceDirectory(config.instanceId)));
  assert.equal((await workspaceStatus(repo)).status, "ready");
});

test("revoked tokens, incomplete personal credentials and origin mismatch are actionable and redacted", async () => {
  const repo = (await repositories.get("portable"))!;
  await assert.rejects(asB(()=>prepareRepository(repo)), /incomplete/);
  process.env.REMOTE_TEST_REVOKED = "1";
  await assert.rejects(asA(()=>testRepositoryConnection(repo)), e => /permissions/.test((e as Error).message) && !(e as Error).message.includes("private-token"));
  delete process.env.REMOTE_TEST_REVOKED;
  git(resolveRepoPath(repo), "remote", "set-url", "origin", "https://bitbucket.org/team/wrong.git");
  await assert.rejects(asA(()=>prepareRepository(repo)), /remote mismatch/);
  assert.equal((await workspaceStatus(repo)).status,"remote_mismatch");
  git(resolveRepoPath(repo), "remote", "set-url", "origin", url);
});

test("interrupted clone retries safely and never removes an existing conflicting checkout", async () => {
  const repo = (await repositories.get("portable"))!;
  const retry = (await repositories.upsert("retry", { repository_url: "https://bitbucket.org/test-team/retry.git" }))!;
  const partial = join(dirname(resolveRepoPath(retry)), "clone.partial");
  mkdirSync(partial,{recursive:true}); writeFileSync(join(partial,"partial"),"interrupted");
  process.env.REMOTE_TEST_REVOKED = "1";
  await assert.rejects(asA(()=>prepareRepository(retry)), /permissions/);
  delete process.env.REMOTE_TEST_REVOKED;
  assert.equal(existsSync(resolveRepoPath(retry)),false);
  await asA(()=>prepareRepository(retry));
  assert.equal(existsSync(partial),false);
  assert.equal(existsSync(join(resolveRepoPath(retry),".git")),true);
  assert.equal(await validateCheckout(repo),resolveRepoPath(repo));
});

test("run worktrees use stable IDs, remain isolated, resume in place, and enforce ownership and worker fencing", async () => {
  const repo = (await repositories.get("portable"))!;
  const run = await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"Remote"},repositories:[repo.name],start:false});
  const ws = await asA(()=>prepareWorkspace(run,repo.name));
  assert.equal(ws.path,join(config.dataDir,"worktrees",instanceDirectory(config.instanceId),String(run.id),String(repo.id)));
  writeFileSync(join(ws.path,"private.txt"),"run-local");
  assert.equal(existsSync(join(resolveRepoPath(repo),"private.txt")),false);
  assert.equal((await asA(()=>prepareWorkspace(run,repo.name))).path,ws.path);
  await assert.rejects(asB(()=>prepareWorkspace(run,repo.name)),/owner mismatch/);
  await q(pool,"UPDATE workflow_runs SET worker_instance='other' WHERE id=$1",[run.id]);
  await assert.rejects(asA(()=>prepareWorkspace(run,repo.name)),/assigned instance/);
  await q(pool,"UPDATE workflow_runs SET worker_instance=$2 WHERE id=$1",[run.id,config.instanceId]);
  await repositories.upsert(repo.name,{allowed_actions:["read"]});
  await assert.rejects(asA(()=>prepareWorkspace(run,repo.name)),/write permission/);
  await repositories.upsert(repo.name,{allowed_actions:["read","write","pull_request"]});
});

test("explicit code indexing resolves managed sources without local mappings", async () => {
  config.codeIntelligence.enabled = true;
  try {
    const result = await asA(()=>indexRepository("portable"));
    assert.ok(result.metrics.indexed_files>0);
    assert.equal((await asA(()=>localScope("portable"))).root,resolveRepoPath((await repositories.get("portable"))!));
  } finally { config.codeIntelligence.enabled=false; }
});

test("legacy dry-run and repeatable apply preserve IDs, references, local overrides and valid remotes", async () => {
  const local = join(config.reposRoot,"legacy-discovered"); mkdirSync(local);
  git(local,"init","-q"); git(local,"remote","add","origin","git@bitbucket.org:other-team/discovered.git");
  const row = (await repositories.upsert("legacy-discovered",{projects:["Keep"],owners:["owner"],dependencies:["portable"]}))!;
  const plan = (await migrateLegacyRepositories()).find(r=>r.name===row.name)!;
  assert.equal(plan.status,"proposed"); assert.equal((await repositories.get(row.name))?.repository_url,null);
  const applied = (await migrateLegacyRepositories(true)).find(r=>r.name===row.name)!;
  assert.equal(applied.status,"applied");
  const updated = (await repositories.get(row.name))!;
  assert.equal(updated.id,row.id); assert.deepEqual(updated.projects,row.projects); assert.deepEqual(updated.owners,row.owners);
  assert.equal((await migrateLegacyRepositories(true)).find(r=>r.name===row.name)?.status,"configured");
  assert.equal(git(local,"remote","get-url","origin"),"git@bitbucket.org:other-team/discovered.git");
});

test("code search provisions a newly selected cross-repository source and indexes with the requested owner", async () => {
  const { searchCodeExact } = await import("../src/codeIntelligence/search.ts");
  const repo = (await repositories.get("portable"))!;
  const hits = await asA(()=>searchCodeExact("isolatedRemote", {repositories:[repo.name],allowed:[repo.name]}));
  assert.ok(hits.some(h=>h.repository===repo.name));
  await repositories.upsert(repo.name,{enabled:false});
  await assert.rejects(asA(()=>localScope(repo.name)),/unauthorized/);
  await repositories.upsert(repo.name,{enabled:true});
});

test("new agent working directories are per run and retained sessions resume their legitimate cwd", async () => {
  const { runWorkingDirectory } = await import("../src/repos/workspaces.ts");
  const runA = await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"Remote"},repositories:["portable"],start:false});
  const runB = await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"Remote"},repositories:["portable"],start:false});
  const a = await runWorkingDirectory(runA.id), b = await runWorkingDirectory(runB.id);
  assert.notEqual(a,b); assert.equal(await runWorkingDirectory(runA.id),a);
  assert.ok(a.endsWith(join(String(runA.id),"agent")));
  const legacy = join(config.dataDir, "worktrees", "retained-session");
  mkdirSync(legacy, { recursive: true });
  const step = await one(pool, "SELECT id,generation FROM workflow_steps WHERE run_id=$1 ORDER BY position LIMIT 1", [runB.id]);
  const attempt = await one(pool, "INSERT INTO workflow_step_attempts(run_id,step_id,number,status,generation) VALUES($1,$2,1,'COMPLETED',$3) RETURNING id", [runB.id, step.id, step.generation]);
  await q(pool, "INSERT INTO agent_sessions(attempt_id,session_id,cwd,model) VALUES($1,'retained-session',$2,'fixture')", [attempt.id, legacy]);
  const spy = mock.method(pool, "query");
  try {
    assert.equal(await runWorkingDirectory(runB.id), legacy, "persisted sessions keep their original cwd");
    assert.equal(spy.mock.calls.length, 1, "assignment and session are resolved in one query");
  } finally { spy.mock.restore(); }
  await q(pool,"UPDATE workflow_runs SET worker_instance='foreign' WHERE id=$1",[runA.id]);
  await assert.rejects(runWorkingDirectory(runA.id),/Assigned worker/);
});

test("migration retains in-progress legacy worktrees and later preparation resolves their original Git directory", async () => {
  const { checkoutForRun } = await import("../src/repos/workspaces.ts");
  const local = join(config.reposRoot,"legacy-active");
  git(root,"clone",source,local);
  git(local,"remote","set-url","origin",origin);
  const repo = (await repositories.upsert("legacy-active",{provider:"local",default_branch:"main",projects:["LegacyActive"]}))!;
  const run = await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"LegacyActive"},repositories:[repo.name],start:false});
  const ws = await asA(()=>prepareWorkspace(run,repo.name));
  writeFileSync(join(ws.path,"unfinished.txt"),"keep me");
  git(local,"remote","set-url","origin","git@bitbucket.org:test-team/legacy-active.git");
  await repositories.upsert(repo.name,{repository_url:"https://bitbucket.org/test-team/legacy-active.git"});
  const updated = (await repositories.get(repo.name))!;
  assert.equal(await checkoutForRun(updated,run.id),local);
  assert.equal((await asA(()=>prepareWorkspace(run,repo.name))).path,ws.path);
  assert.equal(readFileSync(join(ws.path,"unfinished.txt"),"utf8"),"keep me");
  assert.equal(existsSync(resolveRepoPath(updated)),false,"resume never moves or replaces legacy checkout");
});

test("local Git URL rewrites cannot redirect credentials and repository hooks cannot execute during provisioning", async () => {
  const repo = (await repositories.get("portable"))!;
  const path = resolveRepoPath(repo), marker = join(root,"hook-ran");
  writeFileSync(join(path,".git","hooks","post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  git(path,"config","url.https://evil.example/.insteadOf","https://bitbucket.org/");
  await assert.rejects(asA(()=>prepareRepository(repo,true)),/permissions/);
  git(path,"config","--remove-section","url.https://evil.example/");
  const run = await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"Remote"},repositories:[repo.name],start:false});
  await asA(()=>prepareWorkspace(run,repo.name));
  assert.equal(existsSync(marker),false);
});

test("metadata ranking with code intelligence never clones or queues an unavailable remote", async () => {
  const { hybridRank } = await import("../src/codeIntelligence/search.ts");
  const repo=(await repositories.upsert("metadata-only",{repository_url:"https://bitbucket.org/test-team/metadata-only.git",default_branch:"main",tags:["isolatedRemote"]}))!;
  const before=readFileSync(audit,"utf8");
  config.codeIntelligence.enabled=true;
  try {
    const ranked=await asA(()=>hybridRank([repo],{text:"isolatedRemote"}));
    assert.equal(ranked[0].repo,repo.name);
    assert.equal(existsSync(resolveRepoPath(repo)),false);
    assert.equal(readFileSync(audit,"utf8"),before);
    assert.equal((await one(pool,"SELECT count(*)::int n FROM code_intelligence.runs WHERE repository_id=$1",[repo.id]))?.n,0);
  } finally {config.codeIntelligence.enabled=false;}
});

test("cross-repository execution prepares independent sources and worktrees in one authorized run", async () => {
  const second=(await repositories.upsert("retry",{default_branch:"main",projects:["Remote"]}))!;
  const run=await startRun({definitionKey:"bug-investigation",ownerId:userA,inputs:{project:"Remote"},repositories:["portable",second.name],start:false});
  const workspaces=await asA(()=>Promise.all([prepareWorkspace(run,"portable"),prepareWorkspace(run,second.name)]));
  assert.notEqual(workspaces[0].path,workspaces[1].path);
  for(const ws of workspaces) {
    assert.ok(existsSync(join(ws.path,"source.ts")));
    assert.equal(ws.created_from,"origin/main");
  }
  writeFileSync(join(workspaces[0].path,"one-run-only.txt"),"isolated");
  assert.equal(existsSync(join(workspaces[1].path,"one-run-only.txt")),false);
});

test("scheduled indexing retains the requesting principal and never borrows another member's token", async () => {
  const {enqueue,runIndexOnce}=await import("../src/codeIntelligence/indexer.ts");
  config.codeIntelligence.enabled=true;
  try {
    const job=await asA(()=>enqueue("portable"));
    assert.equal((await one(pool,"SELECT requested_by FROM code_intelligence.runs WHERE id=$1",[job.id]))?.requested_by,userA);
    assert.equal(await runIndexOnce(),true);
    assert.equal((await one(pool,"SELECT status FROM code_intelligence.runs WHERE id=$1",[job.id]))?.status,"done");
    const missing=await asB(()=>enqueue("portable"));
    const before=readFileSync(audit,"utf8");
    assert.equal(await runIndexOnce(),true);
    const failed=await one(pool,"SELECT status,error,requested_by FROM code_intelligence.runs WHERE id=$1",[missing.id]);
    assert.equal(failed?.requested_by,userB);
    assert.equal(failed?.status,"queued");
    assert.ok(!JSON.stringify(failed).includes("private-token-a"));
    assert.equal(readFileSync(audit,"utf8"),before);
  } finally {config.codeIntelligence.enabled=false;}
});

test("authenticated publication uses the canonical workspace and registered default branch", async () => {
  const {bitbucketProvider,workspacesOf}=await import("../src/git/provider.ts");
  const {repositoryReference}=await import("../src/repos/service.ts");
  const {openPullRequest}=await import("../src/bitbucket.ts");
  const record=await one(pool,"SELECT run_id FROM execution_workspaces WHERE repo='portable' ORDER BY run_id LIMIT 1");
  const workspace=(await workspacesOf(record.run_id))[0];
  git(workspace.path,"add","."); git(workspace.path,"commit","-qm","portable changes");
  const pushed=await asA(()=>bitbucketProvider.push(workspace.path,workspace.branch));
  assert.match(pushed.commits,/portable changes/);
  const originalFetch=globalThis.fetch, oldWorkspace=config.bitbucket.workspace;
  const calls:string[]=[];
  config.bitbucket.workspace="unrelated-default";
  globalThis.fetch=async (input,init) => {
    const url=String(input); calls.push(url);
    assert.ok(url.startsWith("https://api.bitbucket.org/2.0/repositories/test-team/remote-source/pullrequests"));
    assert.equal((init?.headers as Record<string,string>).Authorization,"Basic "+Buffer.from("person@example.com:private-token-a").toString("base64"));
    if(init?.method==='POST') {
      const body=JSON.parse(String(init.body));
      assert.equal(body.destination.branch.name,"main");
      assert.ok(!String(init.body).includes("private-token"));
      return new Response(JSON.stringify({links:{html:{href:"https://bitbucket.org/test-team/remote-source/pull-requests/1"}}}));
    }
    return new Response(JSON.stringify({values:[]}));
  };
  try {
    const repo=(await repositories.get("portable"))!;
    const result=await asA(()=>openPullRequest(repositoryReference(repo),workspace.branch,"Changes","Description",{dest:repo.default_branch}));
    assert.equal(result.created,true); assert.equal(calls.length,2);
  } finally {globalThis.fetch=originalFetch;config.bitbucket.workspace=oldWorkspace;}
});


test("Bitbucket resolves one owner's credential pair once per operation and observes rotation on the next call", async () => {
  const { openPullRequest, listPullRequests } = await import("../src/bitbucket.ts");
  const originalFetch = globalThis.fetch;
  const authorization: string[] = [];
  globalThis.fetch = async (_url, init) => {
    authorization.push((init?.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify(init?.method === "POST"
      ? { links: { html: { href: "https://bitbucket.org/team/repo/pull-requests/1" } } }
      : { values: [] }));
  };
  const spy = mock.method(pool, "query");
  const secretReads = () => spy.mock.calls.filter((call) => String(call.arguments[0]).includes("FROM user_secrets")).length;
  try {
    await asA(() => openPullRequest("team/repo", "feature", "Title", "Body", { dest: "main" }));
    assert.equal(secretReads(), 2, "one read per secret, shared by lookup and creation requests");
    assert.equal(authorization.length, 2);
    assert.equal(authorization[0], authorization[1]);
    await putUserSecret(userA, "bitbucket_token", "rotated-fixture-token");
    spy.mock.resetCalls();
    await asA(() => listPullRequests("team/repo"));
    assert.equal(secretReads(), 2);
    assert.equal(authorization[2], "Basic " + Buffer.from("person@example.com:rotated-fixture-token").toString("base64"));
  } finally {
    spy.mock.restore();
    globalThis.fetch = originalFetch;
    await putUserSecret(userA, "bitbucket_token", "private-token-a");
  }
});
