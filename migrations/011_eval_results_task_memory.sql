-- Agent evaluation results (bench / candidates) — kept apart from execution status.
CREATE TABLE eval_results (
  id          BIGSERIAL PRIMARY KEY,
  suite       TEXT NOT NULL,                 -- fixture suite + version, e.g. 'bench-v2'
  scenario    TEXT NOT NULL,
  candidate   TEXT NOT NULL,                 -- 'platform' | 'claude-cli' | …
  profile     TEXT,                          -- FAST / STANDARD / DEEP (platform), NULL otherwise
  status      TEXT NOT NULL,                 -- execution outcome (COMPLETED, FAILED, TIMEOUT, ERROR…)
  correct     BOOLEAN,                       -- hidden acceptance tests passed (NULL = scenario not graded)
  regression  BOOLEAN,                       -- the fixture's own tests broke (NULL = not checked)
  verdict     TEXT,                          -- independent verification verdict, when one ran
  repairs     INT NOT NULL DEFAULT 0,
  human_gates INT NOT NULL DEFAULT 0,
  wall_s      INT,
  cost_usd    NUMERIC(10, 4),
  tokens      BIGINT,
  run_id      BIGINT,                        -- platform run in the bench database (not this one)
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eval_results_suite ON eval_results (suite, created_at DESC);

-- Cross-task memory: knowledge extracted from completed runs (provenance + trust live in the version metadata).
ALTER TABLE knowledge_items DROP CONSTRAINT IF EXISTS knowledge_items_category_check;
ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_category_check
  CHECK (category IN ('business_rule', 'architecture_guideline', 'coding_standard', 'domain_knowledge', 'security_policy', 'agent_skill', 'repository_convention', 'task_memory'));
