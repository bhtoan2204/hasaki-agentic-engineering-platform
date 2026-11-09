-- Additive, optional index. No extensions or source text persisted.
CREATE SCHEMA code_intelligence;
CREATE TABLE code_intelligence.extractions (
 id BIGSERIAL PRIMARY KEY,
 language TEXT NOT NULL,
 parser_version TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 parse_errors INT NOT NULL DEFAULT 0,
 UNIQUE(language, parser_version, content_hash)
);
CREATE TABLE code_intelligence.symbols (
 id BIGSERIAL PRIMARY KEY,
 extraction_id BIGINT NOT NULL REFERENCES code_intelligence.extractions ON DELETE CASCADE,
 symbol_name TEXT NOT NULL,
 qualified_name TEXT NOT NULL,
 symbol_kind TEXT NOT NULL,
 start_line INT NOT NULL,
 end_line INT NOT NULL,
 start_byte INT NOT NULL,
 end_byte INT NOT NULL,
 parent_symbol TEXT,
 signature TEXT NOT NULL
);
CREATE INDEX ci_symbol_name ON code_intelligence.symbols(symbol_name, extraction_id);
CREATE INDEX ci_symbol_qualified ON code_intelligence.symbols(qualified_name, extraction_id);
CREATE INDEX ci_symbol_extraction ON code_intelligence.symbols(extraction_id, start_byte);
CREATE TABLE code_intelligence.relations (
 id BIGSERIAL PRIMARY KEY,
 extraction_id BIGINT NOT NULL REFERENCES code_intelligence.extractions ON DELETE CASCADE,
 source_name TEXT NOT NULL,
 target_name TEXT NOT NULL,
 relation_type TEXT NOT NULL CHECK (relation_type IN ('IMPORTS','DEFINES','CALLS','REFERENCES','IMPLEMENTS','RPC_REQUEST','RPC_RESPONSE')),
 resolution TEXT NOT NULL CHECK (resolution IN ('resolved','candidate','unresolved')),
 line INT NOT NULL
);
CREATE INDEX ci_relation_target ON code_intelligence.relations(target_name, extraction_id);
CREATE INDEX ci_relation_source ON code_intelligence.relations(extraction_id, source_name);
CREATE TABLE code_intelligence.snapshots (
 id BIGSERIAL PRIMARY KEY,
 repository_id BIGINT NOT NULL REFERENCES repositories ON DELETE CASCADE,
 commit_sha TEXT NOT NULL,
 index_version TEXT NOT NULL,
 identity TEXT NOT NULL,
 base_snapshot_id BIGINT REFERENCES code_intelligence.snapshots,
 instance_id TEXT NOT NULL DEFAULT '',
 run_id BIGINT REFERENCES workflow_runs ON DELETE CASCADE,
 generation TEXT NOT NULL DEFAULT '',
 indexed_files INT NOT NULL DEFAULT 0,
 symbol_count INT NOT NULL DEFAULT 0,
 relation_count INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(repository_id, identity, index_version)
);
CREATE INDEX ci_snapshot_repo ON code_intelligence.snapshots(repository_id, created_at DESC);
CREATE INDEX ci_snapshot_overlay ON code_intelligence.snapshots(run_id, repository_id, created_at DESC) WHERE run_id IS NOT NULL;
CREATE TABLE code_intelligence.files (
 snapshot_id BIGINT NOT NULL REFERENCES code_intelligence.snapshots ON DELETE CASCADE,
 file_path TEXT NOT NULL,
 blob_hash TEXT NOT NULL DEFAULT '',
 extraction_id BIGINT REFERENCES code_intelligence.extractions,
 deleted BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(snapshot_id,file_path),
 CHECK (NOT deleted OR extraction_id IS NULL)
);
CREATE INDEX ci_file_extraction ON code_intelligence.files(extraction_id,snapshot_id);
-- Minimal durable coordination serviced by the EXISTING scheduler (not a separate worker).
CREATE TABLE code_intelligence.runs (
 id BIGSERIAL PRIMARY KEY,
 repository_id BIGINT NOT NULL REFERENCES repositories ON DELETE CASCADE,
 instance_id TEXT NOT NULL,
 run_id BIGINT REFERENCES workflow_runs ON DELETE CASCADE,
 scope_key TEXT NOT NULL,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','canceled')),
 attempts INT NOT NULL DEFAULT 0,
 fencing_token INT NOT NULL DEFAULT 0,
 lease_expires_at TIMESTAMPTZ,
 available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 snapshot_id BIGINT REFERENCES code_intelligence.snapshots ON DELETE SET NULL,
 metrics JSONB NOT NULL DEFAULT '{}',
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ci_run_live ON code_intelligence.runs(repository_id,instance_id,scope_key) WHERE status IN ('queued','running');
CREATE INDEX ci_run_claim ON code_intelligence.runs(instance_id,available_at,id) WHERE status IN ('queued','running');
