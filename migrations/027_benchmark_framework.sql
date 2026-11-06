-- Versioned datasets/configurations; execution stays in the existing workflow DAG/queue.
CREATE TABLE benchmark_suites (
 id BIGSERIAL PRIMARY KEY,
 suite_key TEXT NOT NULL,
 version INT NOT NULL CHECK(version>0),
 content_hash TEXT NOT NULL,
 title TEXT NOT NULL,
 manifest JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(suite_key,version)
);
CREATE TABLE benchmark_cases (
 id BIGSERIAL PRIMARY KEY,
 suite_id BIGINT NOT NULL REFERENCES benchmark_suites ON DELETE RESTRICT,
 task_id TEXT NOT NULL,
 category TEXT NOT NULL,
 difficulty TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
 origin TEXT NOT NULL CHECK(origin IN ('synthetic','real_derived')),
 repository TEXT NOT NULL,
 base_commit TEXT NOT NULL CHECK(base_commit ~ '^[a-f0-9]{40}$'),
 definition JSONB NOT NULL,
 UNIQUE(suite_id,task_id)
);
CREATE TABLE evaluation_runs (
 id BIGSERIAL PRIMARY KEY,
 suite_id BIGINT NOT NULL REFERENCES benchmark_suites ON DELETE RESTRICT,
 owner_id BIGINT NOT NULL REFERENCES users ON DELETE RESTRICT,
 workflow_run_id BIGINT UNIQUE REFERENCES workflow_runs ON DELETE RESTRICT,
 configuration JSONB NOT NULL,
 configuration_hash TEXT NOT NULL,
 scoring JSONB NOT NULL,
 constraints_hash TEXT NOT NULL,
 request_key TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key)
);
CREATE INDEX evaluation_runs_owner ON evaluation_runs(owner_id,id DESC);
CREATE TABLE evaluation_case_runs (
 id BIGSERIAL PRIMARY KEY,
 evaluation_id BIGINT NOT NULL REFERENCES evaluation_runs ON DELETE RESTRICT,
 case_id BIGINT NOT NULL REFERENCES benchmark_cases ON DELETE RESTRICT,
 repetition INT NOT NULL CHECK(repetition>0),
 workflow_step_key TEXT NOT NULL,
 UNIQUE(evaluation_id,case_id,repetition)
);
ALTER TABLE eval_results ADD COLUMN case_run_id BIGINT UNIQUE REFERENCES evaluation_case_runs ON DELETE RESTRICT;
ALTER TABLE eval_results ADD COLUMN owner_id BIGINT REFERENCES users ON DELETE RESTRICT;
ALTER TABLE eval_results ADD COLUMN quality_score NUMERIC CHECK(quality_score BETWEEN 0 AND 100);
ALTER TABLE eval_results ADD COLUMN hard_gates_passed BOOLEAN;
ALTER TABLE eval_results ADD COLUMN failure_class TEXT;
CREATE INDEX eval_results_owner ON eval_results(owner_id,id DESC) WHERE owner_id IS NOT NULL;
CREATE TABLE evaluation_comparisons (
 id BIGSERIAL PRIMARY KEY,
 owner_id BIGINT NOT NULL REFERENCES users ON DELETE RESTRICT,
 baseline_id BIGINT NOT NULL REFERENCES evaluation_runs ON DELETE RESTRICT,
 candidate_id BIGINT NOT NULL REFERENCES evaluation_runs ON DELETE RESTRICT,
 policy JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(baseline_id<>candidate_id)
);
CREATE INDEX evaluation_comparisons_owner ON evaluation_comparisons(owner_id,id DESC);
CREATE FUNCTION benchmark_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'benchmark definitions and execution configurations are immutable; publish a new version'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER benchmark_suites_immutable BEFORE UPDATE OR DELETE ON benchmark_suites FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
CREATE TRIGGER benchmark_cases_immutable BEFORE UPDATE OR DELETE ON benchmark_cases FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
CREATE TRIGGER evaluation_configuration_immutable BEFORE UPDATE OF suite_id,owner_id,configuration,configuration_hash,scoring,constraints_hash,request_key ON evaluation_runs FOR EACH ROW EXECUTE FUNCTION benchmark_immutable();
