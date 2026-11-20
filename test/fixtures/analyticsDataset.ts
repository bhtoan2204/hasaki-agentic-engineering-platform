/**
 * A deterministic, production-shaped analytics dataset for benchmarks (test/analytics-engines.bench.ts), written with
 * set-based SQL into the isolated test database. Shape per run: a planning agent step, a coding step (verification,
 * context snapshot, one or two provider sessions) and a human approval; every fifth step is retried, every
 * thirteenth retry is invalidated. Production errors: hourly scans with overlapping daily rescans, so the
 * deduplication path does real work.
 */
import { pool, one } from "../../src/db/pool.ts";
import { definitions } from "../../src/workflow/definitions.ts";

export interface DatasetSize {
  users: number;
  runs: number;
  days: number;
  groups: number;
}

export const DEFAULT_SIZE: DatasetSize = { users: 6, runs: 20000, days: 60, groups: 1500 };

export async function seedAnalyticsDataset(size: DatasetSize = DEFAULT_SIZE) {
  const existing = await one<{ n: number }>(
    pool,
    "SELECT count(*)::int AS n FROM workflow_runs WHERE definition_key LIKE 'bench-%'",
  );
  if (existing!.n >= size.runs) return;
  for (const key of ["bench-feature", "bench-bugfix", "bench-review"])
    await definitions.create({
      key,
      spec: {
        name: key,
        steps: [
          { key: "plan", type: "agent", config: { instructions: "plan" } },
          { key: "implement", type: "coding_agent", config: { instructions: "code" } },
        ],
      },
    });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT setseed(0.42)");
    await c.query(
      `INSERT INTO users(username,password_hash,role)
       SELECT 'bench-user-'||i,'x',CASE WHEN i=1 THEN 'admin' ELSE 'member' END FROM generate_series(1,$1) i`,
      [size.users],
    );
    await c.query(
      `CREATE TEMP TABLE bench_users ON COMMIT DROP AS
       SELECT row_number() OVER(ORDER BY id) AS n, id FROM users WHERE username LIKE 'bench-user-%'`,
    );
    await c.query(
      `CREATE TEMP TABLE bench_defs ON COMMIT DROP AS
       SELECT row_number() OVER(ORDER BY d.key) AS n, d.key, max(v.id) AS version_id
       FROM workflow_definitions d JOIN workflow_definition_versions v ON v.definition_id=d.id
       WHERE d.key LIKE 'bench-%' GROUP BY d.key`,
    );
    await c.query(
      `INSERT INTO work_items(code,source,title,project,owner_id,created_at)
       SELECT 'BENCH-'||i,'manual','bench item '||i,(ARRAY['OMS','WMS','POS',''])[1+i%4],
         (SELECT id FROM bench_users WHERE n=1+i%$2), now()
       FROM generate_series(1,$1) i`,
      [size.runs, size.users],
    );
    await c.query(
      `INSERT INTO workflow_runs(definition_version_id,definition_key,work_item_id,title,status,inputs,graph,
         selected_repositories,allowed_repositories,branch,created_at,started_at,finished_at,agent_provider,owner_id,summary)
       SELECT d.version_id,d.key,w.id,'bench run '||g.i,
         (ARRAY['COMPLETED','COMPLETED','COMPLETED','FAILED','CANCELED','RUNNING'])[1+g.i%6],
         jsonb_build_object('project',(ARRAY['OMS','WMS','POS'])[1+g.i%3],'blob',repeat('x',400)),
         '{}'::jsonb,
         CASE g.i%5 WHEN 0 THEN ARRAY['oms-api','oms-background'] WHEN 1 THEN ARRAY[]::text[]
           ELSE ARRAY[(ARRAY['oms-api','wms-api','pos-web','oms-background','shared-lib'])[1+g.i%5]] END,
         ARRAY['oms-api','wms-api','pos-web','oms-background','shared-lib'],
         'bench/'||g.i, g.at, g.at, CASE WHEN g.i%6<>5 THEN g.at+(g.i%40+1)*interval '1 minute' END,
         (ARRAY['claude','codex','cursor','claude','copilot'])[1+g.i%5],
         (SELECT id FROM bench_users WHERE n=1+g.i%$2),
         jsonb_build_object('changes',jsonb_build_array('src/a.ts','src/b.ts'))
       FROM (SELECT i, now()-interval '1 second'*floor(random()*$3*86400) AS at FROM generate_series(1,$1) i) g
       JOIN work_items w ON w.code='BENCH-'||g.i
       JOIN bench_defs d ON d.n=1+g.i%3`,
      [size.runs, size.users, size.days],
    );
    await c.query(
      `INSERT INTO workflow_steps(run_id,key,type,name,position,status,attempt_count)
       SELECT r.id,s.key,s.type,s.key,s.pos,CASE WHEN r.status='RUNNING' AND s.pos=3 THEN 'WAITING_APPROVAL' ELSE 'COMPLETED' END,1
       FROM workflow_runs r CROSS JOIN (VALUES('plan','agent',1),('implement','coding_agent',2),('approve','human_approval',3)) s(key,type,pos)
       WHERE r.definition_key LIKE 'bench-%'`,
    );
    await c.query(
      `INSERT INTO context_snapshots(run_id,step_id,hash,content)
       SELECT s.run_id,s.id,'bench',jsonb_build_object('preparation_duration_ms',20+s.id%300)
       FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE r.definition_key LIKE 'bench-%' AND s.type='coding_agent'`,
    );
    // Attempt n of a step; provider sessions only on agent steps; a resumed human answer on some retries.
    await c.query(
      `INSERT INTO workflow_step_attempts(step_id,run_id,number,generation,status,started_at,finished_at,metrics,input,
         context_snapshot_id,invalidated_at,telemetry_queue_duration_ms,telemetry_wait_started_at,telemetry_wait_ended_at,
         agent_provider,agent_model,effective_agent)
       SELECT s.id,s.run_id,n.n,1,
         CASE WHEN n.n<n.total THEN 'FAILED' WHEN s.status='WAITING_APPROVAL' THEN 'WAITING_APPROVAL' ELSE 'COMPLETED' END,
         r.started_at+(s.position*5+n.n)*interval '1 minute', r.started_at+(s.position*5+n.n+2)*interval '1 minute',
         CASE WHEN s.type='human_approval' THEN '{}'::jsonb ELSE jsonb_build_object(
           'provider',r.agent_provider,'model',r.agent_provider||'-model-'||(s.id%3),
           'provider_sessions',jsonb_build_object('main',jsonb_build_object(
               'provider',r.agent_provider,'model',r.agent_provider||'-model-'||(s.id%3),
               'tokens',CASE WHEN s.id%17=0 THEN NULL ELSE jsonb_build_object('input',1000+s.id%9000,'output',200+s.id%800,
                 'cache_read',s.id%5000,'cache_creation',CASE WHEN r.agent_provider='claude' THEN s.id%300 END,
                 'reasoning_output',CASE WHEN r.agent_provider='codex' THEN s.id%400 END) END,
               'reported_cost_usd',CASE WHEN r.agent_provider IN ('claude','codex') THEN round((s.id%1000)/1000.0,4) WHEN s.id%11=0 THEN 0 END,
               'provider_execution_ms',5000+s.id%60000,'complete',true,'start_time',r.started_at+(s.position*5+n.n)*interval '1 minute')
             ) || CASE WHEN s.id%4=0 THEN jsonb_build_object('review',jsonb_build_object(
               'provider','codex','model','codex-review','tokens',jsonb_build_object('input',300,'output',50),
               'reported_cost_usd',0.01,'provider_execution_ms',3000,'complete',s.id%8=0,
               'start_time',r.started_at+(s.position*5+n.n+1)*interval '1 minute')) ELSE '{}'::jsonb END,
           'tool_calls',jsonb_build_object('shell',s.id%7,'edit',s.id%5),'tool_errors',s.id%3,
           'context_preparation_ms',CASE WHEN s.id%2=0 THEN 10+s.id%90 END,
           'normalized_failure_category',CASE WHEN n.n<n.total THEN (ARRAY['RATE_LIMIT','TIMEOUT','TOOL_ERROR'])[1+s.id%3] END,
           'verification',CASE WHEN s.type='coding_agent' THEN jsonb_build_object('passed',(s.id%4<>0),'duration_ms',1000+s.id%500,
             'evidence',jsonb_build_object('hits',s.id%3,'misses',1,'reused',s.id%2,'duplicates_avoided',0,'saved_ms',s.id%900,
               'invalidations',CASE WHEN s.id%9=0 THEN '["lockfile_changed"]'::jsonb ELSE '[]'::jsonb END)) END
         ) END,
         CASE WHEN n.n>1 AND s.id%10=0 THEN '{"pending":{"resume":true}}'::jsonb ELSE '{}'::jsonb END,
         cs.id, CASE WHEN n.n<n.total AND s.id%13=0 THEN r.started_at+interval '1 hour' END,
         s.id%2000, CASE WHEN s.type='human_approval' THEN r.started_at END,
         CASE WHEN s.type='human_approval' AND s.status<>'WAITING_APPROVAL' THEN r.started_at+(s.id%600)*interval '1 second' END,
         r.agent_provider, CASE WHEN s.id%2=0 THEN r.agent_provider||'-requested' END,
         jsonb_build_object('model',r.agent_provider||'-configured')
       FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id
       LEFT JOIN context_snapshots cs ON cs.step_id=s.id
       CROSS JOIN LATERAL (SELECT CASE WHEN s.id%5=0 THEN 2 ELSE 1 END AS total) t
       CROSS JOIN LATERAL (SELECT generate_series(1,t.total) AS n, t.total) n
       WHERE r.definition_key LIKE 'bench-%'`,
    );
    await c.query(
      `UPDATE workflow_steps s SET current_attempt_id=a.id,attempt_count=a.number FROM (
         SELECT DISTINCT ON(step_id) step_id,id,number FROM workflow_step_attempts ORDER BY step_id,id DESC) a
       WHERE a.step_id=s.id AND s.current_attempt_id IS NULL`,
    );
    await c.query(
      `INSERT INTO pull_requests(provider,repo,source_branch,target_branch,url,title,created,work_item_id,run_id)
       SELECT 'bitbucket','oms-api',r.branch,'main','https://example.invalid/pr/'||r.id,'bench '||r.id,r.id%3<>0,r.work_item_id,r.id
       FROM workflow_runs r WHERE r.definition_key LIKE 'bench-%' AND r.status='COMPLETED' AND r.id%4=0`,
    );
    // Production errors: groups over services, hourly scans, and a daily rescan overlapping 24 hourly scans.
    await c.query(
      `INSERT INTO prod_error_groups(fingerprint,namespace,service,level,signature,day,today_count,yesterday_count,
         severity,work_item_id,first_seen_at,lifecycle_status,acknowledged_at,resolved_at,status)
       SELECT lpad(to_hex(i),20,'0'),(ARRAY['oms','wms','pos',''])[1+i%4],
         CASE WHEN i%23=0 THEN '' ELSE (ARRAY['api','worker','web','cron','gateway','auth'])[1+i%6] END,
         'ERROR','signature '||i,(now()-(i%$2)*interval '1 day')::date,i%50,i%20,
         (ARRAY['critical','high','medium','low',''])[1+i%5],
         CASE WHEN i%7=0 THEN (SELECT id FROM work_items WHERE code='BENCH-'||(1+i*13%$3)) END,
         now()-(i%$2)*interval '1 day',(ARRAY['open','acknowledged','resolved','open'])[1+i%4],
         CASE WHEN i%4 IN (1,2) THEN now()-(i%$2)*interval '1 day'+interval '2 hours' END,
         CASE WHEN i%4=2 THEN now()-(i%$2)*interval '1 day'+interval '1 day' END,'open'
       FROM generate_series(1,$1) i`,
      [size.groups, size.days, size.runs],
    );
    await c.query(
      `INSERT INTO prod_error_scans(trigger,started_at,finished_at,ok,window_start,window_end,groups,events)
       SELECT CASE WHEN h.daily THEN 'daily' ELSE 'hourly' END,h.ws,h.ws+interval '5 minutes',h.n%97<>0,h.ws,
         h.ws+CASE WHEN h.daily THEN interval '1 day' ELSE interval '1 hour' END,0,0
       FROM (
         SELECT n,false AS daily,date_trunc('hour',now())-n*interval '1 hour' AS ws FROM generate_series(1,$1*24) n
         UNION ALL SELECT n,true,date_trunc('day',now())-n*interval '1 day' FROM generate_series(1,$1) n
       ) h`,
      [size.days],
    );
    await c.query(
      `INSERT INTO prod_error_observations(scan_id,fingerprint,event_count,baseline_count,first_at,last_at,severity,hourly)
       SELECT s.id,g.fingerprint,1+(s.id+g.n)%40,(s.id+g.n)%3,s.window_start,s.window_end-interval '1 minute',
         COALESCE(NULLIF(g.severity,''),'unknown'),
         CASE WHEN s.trigger='daily' THEN (SELECT jsonb_agg(jsonb_build_object('hour',s.window_start+k*interval '1 hour','count',1+(s.id+g.n+k)%40))
                                          FROM generate_series(0,23) k)
              WHEN (s.id+g.n)%31=0 THEN '[]'::jsonb
              ELSE jsonb_build_array(jsonb_build_object('hour',s.window_start,'count',1+(s.id+g.n)%40)) END
       FROM prod_error_scans s
       CROSS JOIN LATERAL (SELECT row_number() OVER() AS n, fingerprint, severity FROM prod_error_groups
                           WHERE signature LIKE 'signature %' ORDER BY fingerprint OFFSET (s.id*37)%$1 LIMIT CASE WHEN s.trigger='daily' THEN 25 ELSE 12 END) g
       WHERE s.ok AND s.trigger IN ('daily','hourly')`,
      [size.groups],
    );
    await c.query(
      `INSERT INTO prod_error_lifecycle_events(fingerprint,action,actor_id,evidence)
       SELECT fingerprint,(ARRAY['acknowledge','resolve','reopen'])[1+i%3],(SELECT id FROM bench_users WHERE n=1),'bench evidence'
       FROM (SELECT fingerprint,row_number() OVER(ORDER BY fingerprint) AS i FROM prod_error_groups
             WHERE signature LIKE 'signature %') g WHERE i%3=0`,
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  await pool.query("ANALYZE");
}
