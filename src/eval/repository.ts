import { pool, q, one, type Db } from "../db/pool.ts";

export const evalRepository = {
  async lockSuitePublish(db: Db): Promise<void> {
    await q(db, "SELECT pg_advisory_xact_lock($1)", [727_027]);
  },

  findSuiteByKeyAndVersion(suiteKey: string, version: string | number, db: Db = pool) {
    return one<any>(db, "SELECT * FROM benchmark_suites WHERE suite_key=$1 AND version=$2", [
      suiteKey,
      version,
    ]);
  },

  insertSuite(
    suiteKey: string,
    version: string | number,
    contentHash: string,
    title: string,
    manifest: string,
    db: Db = pool,
  ) {
    return one<any>(
      db,
      "INSERT INTO benchmark_suites(suite_key,version,content_hash,title,manifest) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [suiteKey, version, contentHash, title, manifest],
    );
  },

  insertCase(
    suiteId: number,
    taskId: string,
    category: string,
    difficulty: string,
    origin: string,
    repository: string,
    baseCommit: string,
    definition: string,
    db: Db = pool,
  ) {
    return q(
      db,
      "INSERT INTO benchmark_cases(suite_id,task_id,category,difficulty,origin,repository,base_commit,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [suiteId, taskId, category, difficulty, origin, repository, baseCommit, definition],
    );
  },

  listSuitesWithCaseCount(db: Db = pool) {
    return q(
      db,
      `SELECT s.id,s.suite_key,s.version,s.title,s.content_hash,count(c.id)::int AS cases,array_agg(DISTINCT c.category) AS categories FROM benchmark_suites s JOIN benchmark_cases c ON c.suite_id=s.id GROUP BY s.id ORDER BY s.suite_key,s.version DESC`,
    );
  },

  findSuiteById(id: number, db: Db = pool) {
    return one<any>(db, "SELECT * FROM benchmark_suites WHERE id=$1", [id]);
  },

  async lockEvaluationRequest(lockKey: string, db: Db): Promise<void> {
    await q(db, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockKey]);
  },

  findEvaluationRunByRequestKey(ownerId: number, requestKey: string, db: Db = pool) {
    return one<any>(db, "SELECT * FROM evaluation_runs WHERE owner_id=$1 AND request_key=$2", [
      ownerId,
      requestKey,
    ]);
  },

  insertEvaluationRun(
    suiteId: number,
    ownerId: number,
    configuration: string,
    configHash: string,
    scoring: string,
    constraintsHash: string,
    requestKey: string,
    db: Db = pool,
  ) {
    return one<any>(
      db,
      `INSERT INTO evaluation_runs(suite_id,owner_id,configuration,configuration_hash,scoring,constraints_hash,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [suiteId, ownerId, configuration, configHash, scoring, constraintsHash, requestKey],
    );
  },

  listCasesBySuiteId(suiteId: number, db: Db = pool) {
    return q<{ id: number; task_id: string }>(
      db,
      "SELECT id,task_id FROM benchmark_cases WHERE suite_id=$1",
      [suiteId],
    );
  },

  insertCaseRun(
    evaluationId: number,
    caseId: number,
    repetition: number,
    stepKey: string,
    db: Db = pool,
  ) {
    return one<{ id: number }>(
      db,
      "INSERT INTO evaluation_case_runs(evaluation_id,case_id,repetition,workflow_step_key) VALUES($1,$2,$3,$4) RETURNING id",
      [evaluationId, caseId, repetition, stepKey],
    );
  },

  insertProviderPhase(
    caseRunId: number,
    ordinal: number,
    stepKey: string,
    provider: string,
    model: string | null,
    role: string,
    db: Db,
  ) {
    return q(
      db,
      "INSERT INTO evaluation_provider_phases(case_run_id,ordinal,step_key,provider,model,role) VALUES($1,$2,$3,$4,$5,$6)",
      [caseRunId, ordinal, stepKey, provider, model, role],
    );
  },

  updateEvaluationWorkflowRunId(evaluationId: number, workflowRunId: number, db: Db = pool) {
    return q(db, "UPDATE evaluation_runs SET workflow_run_id=$2 WHERE id=$1", [
      evaluationId,
      workflowRunId,
    ]);
  },

  findEvaluationById(id: number, ownerId: number, db: Db = pool) {
    return one<any>(
      db,
      `SELECT e.*,r.status,r.created_at AS workflow_created_at,r.started_at,r.finished_at,r.definition_version_id FROM evaluation_runs e JOIN workflow_runs r ON r.id=e.workflow_run_id WHERE e.id=$1 AND e.owner_id=$2`,
      [id, ownerId],
    );
  },

  findEvaluationCases(evaluationId: number, workflowRunId: number, db: Db = pool) {
    return q<any>(
      db,
      `SELECT cr.id,cr.repetition,cr.workflow_step_key,c.task_id,c.category,c.difficulty,c.origin,c.definition,c.base_commit,s.status AS step_status,s.current_attempt_id,er.*,sample.completion_duration_ms
       FROM evaluation_case_runs cr JOIN benchmark_cases c ON c.id=cr.case_id LEFT JOIN workflow_steps s ON s.run_id=$2 AND s.key=cr.workflow_step_key LEFT JOIN eval_results er ON er.case_run_id=cr.id LEFT JOIN evaluation_analytics_samples sample ON sample.case_run_id=cr.id WHERE cr.evaluation_id=$1 ORDER BY cr.repetition,c.task_id`,
      [evaluationId, workflowRunId],
    );
  },

  listEvaluationsByOwner(ownerId: number, db: Db = pool) {
    return q<any>(
      db,
      `SELECT e.id,e.suite_id,e.configuration,e.created_at,e.workflow_run_id,r.status,count(cr.id)::int AS tasks,count(er.id)::int AS finished,count(er.id) FILTER(WHERE er.correct)::int AS successes,round(avg(er.quality_score),2) AS average_score FROM evaluation_runs e JOIN workflow_runs r ON r.id=e.workflow_run_id JOIN evaluation_case_runs cr ON cr.evaluation_id=e.id LEFT JOIN eval_results er ON er.case_run_id=cr.id WHERE e.owner_id=$1 GROUP BY e.id,r.status ORDER BY e.id DESC LIMIT 100`,
      [ownerId],
    );
  },

  insertComparison(
    ownerId: number,
    baselineId: number,
    candidateId: number,
    policy: string,
    db: Db = pool,
  ) {
    return one<any>(
      db,
      "INSERT INTO evaluation_comparisons(owner_id,baseline_id,candidate_id,policy) VALUES($1,$2,$3,$4) RETURNING *",
      [ownerId, baselineId, candidateId, policy],
    );
  },

  findComparisonById(id: number, ownerId: number, db: Db = pool) {
    return one<any>(db, "SELECT * FROM evaluation_comparisons WHERE id=$1 AND owner_id=$2", [
      id,
      ownerId,
    ]);
  },
};
