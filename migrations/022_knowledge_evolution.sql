-- Continuous learning: reviewable knowledge-change proposals, supersession and effective dates.
-- Additive only: existing items keep resolving exactly as before (no effective date = effective since creation,
-- no superseded_by = never superseded, no expires_at = no end).

-- A version may take effect later than it was approved (a BA rule "from 2026-12-01"). The resolver serves, per item,
-- the newest version up to current_version whose effective_from has passed.
ALTER TABLE knowledge_versions ADD COLUMN effective_from TIMESTAMPTZ;

-- A1 superseded by A2: A1 stops applying wherever A2 applies (A2's scope + applicability + effective date); it still
-- applies outside A2's scope and stays readable with its full history.
ALTER TABLE knowledge_items ADD COLUMN superseded_by BIGINT REFERENCES knowledge_items(id) ON DELETE SET NULL;
ALTER TABLE knowledge_items ADD COLUMN superseded_at TIMESTAMPTZ;
-- DEPRECATE with an end date: the item stops applying at expires_at (NULL = no end).
ALTER TABLE knowledge_items ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_not_self_superseded CHECK (superseded_by IS NULL OR superseded_by <> id);

-- A proposed change to the registry. Nothing here is authoritative until a human approves it; approval applies the
-- change through the normal versioned registry writes and records what it did (`applied`) so it can be rolled back.
CREATE TABLE knowledge_proposals (
  id              BIGSERIAL PRIMARY KEY,
  owner_id        BIGINT REFERENCES users(id),             -- visibility: the source run's owner; NULL = shared
  parent_id       BIGINT REFERENCES knowledge_proposals(id) ON DELETE CASCADE, -- skill update derived from a rule change
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'rolled_back', 'obsolete')),
  change_type     TEXT NOT NULL CHECK (change_type IN ('CREATE', 'UPDATE', 'SUPERSEDE', 'DEPRECATE')),
  target_item_id  BIGINT REFERENCES knowledge_items(id) ON DELETE SET NULL,
  target_key      TEXT,
  target_version  INT,                                     -- the version the proposal was made against
  existing_rule   TEXT NOT NULL DEFAULT '',                -- text of the target at proposal time
  proposed        JSONB NOT NULL DEFAULT '{}',             -- {key,title,category,scope_type,scope_ref,conflict_key,content,applicability,effective_from}
  domain          TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  uncertainty     TEXT NOT NULL DEFAULT '',
  evidence        JSONB NOT NULL DEFAULT '[]',             -- [{source, ref, author, trust, quote}]
  impacts         JSONB NOT NULL DEFAULT '{}',             -- {skills, repositories, workflows, conflicts}
  validation      JSONB,                                   -- skill updates: {passed, checks}
  source_kind     TEXT NOT NULL DEFAULT 'workflow' CHECK (source_kind IN ('workflow', 'skill_evolution', 'repository_import', 'manual')),
  source_run_id   BIGINT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  dedupe_key      TEXT NOT NULL,                           -- same target + scope + substance → one open proposal
  created_by      TEXT NOT NULL DEFAULT '',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_comment  TEXT,
  applied         JSONB,                                   -- what approval changed (rollback input)
  rolled_back_by  TEXT,
  rolled_back_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX knowledge_proposals_open_dedupe ON knowledge_proposals(dedupe_key) WHERE status = 'pending';
CREATE INDEX knowledge_proposals_status ON knowledge_proposals(status, created_at DESC);
CREATE INDEX knowledge_proposals_target ON knowledge_proposals(target_item_id);
CREATE INDEX knowledge_proposals_run ON knowledge_proposals(source_run_id);
CREATE INDEX knowledge_proposals_parent ON knowledge_proposals(parent_id);

-- Per-run learning record: what was scanned (input hash → idempotent re-scans), what was proposed or why it was skipped.
ALTER TABLE workflow_runs ADD COLUMN learning JSONB;
