-- Semantic retrieval (ADR 0001). Schema `retrieval` is owned by the Go retrieval module; TypeScript never writes it.
-- pgvector is enabled when the server ships it; otherwise semantic retrieval reports `vector_extension: false`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector is not installed on this server; semantic retrieval stays unavailable';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'not allowed to create extension vector; semantic retrieval stays unavailable';
END $$;

CREATE SCHEMA retrieval;

-- What may be embedded: the current version of enabled, live items. Unverified task memory and disputed lessons
-- (trust unverified) are never embedded. Chat memory stays private to its owner through owner_id.
CREATE VIEW retrieval.eligible_sources AS
SELECT i.id AS source_id,
       i.key,
       i.owner_id,
       CASE
         WHEN i.key LIKE 'memory.chat.%' THEN 'chat_memory'
         WHEN i.key LIKE 'memory.lesson.%' THEN 'lesson'
         WHEN i.category = 'task_memory' THEN 'task_memory'
         WHEN i.category = 'agent_skill' THEN 'skill'
         ELSE 'knowledge'
       END AS source_kind,
       v.version AS source_version,
       i.title,
       coalesce(v.metadata->>'description', '') AS description,
       v.content
  FROM knowledge_items i
  JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
 WHERE i.enabled
   AND i.superseded_by IS NULL
   AND (i.expires_at IS NULL OR i.expires_at > now())
   AND (i.category <> 'task_memory'
        OR i.key LIKE 'memory.chat.%'
        OR v.metadata->'memory'->>'trust' IN ('verified', 'approved'));

-- Indexing state per source and embedding model ("provider/model@dims").
CREATE TABLE retrieval.sources (
  source_id      BIGINT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  source_version INT NOT NULL,
  content_hash   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('indexed', 'skipped_sensitive', 'empty', 'failed')),
  chunks         INT NOT NULL DEFAULT 0,
  error          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, model)
);

-- real[] so the schema is valid without pgvector and several models can coexist during a re-index;
-- search casts to vector. Exact search scans by model.
CREATE TABLE retrieval.chunks (
  source_id BIGINT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  chunk     INT NOT NULL,
  dims      INT NOT NULL,
  embedding REAL[] NOT NULL CHECK (cardinality(embedding) = dims),
  PRIMARY KEY (model, source_id, chunk)
);

-- One row per source: bounded by the number of knowledge items, deduplicated by the primary key.
CREATE TABLE retrieval.queue (
  source_id       BIGINT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_until   TIMESTAMPTZ
);
CREATE INDEX retrieval_queue_due ON retrieval.queue (next_attempt_at);

-- Every knowledge write path (service, proposals, importers, rollback, raw SQL) lands here.
CREATE FUNCTION retrieval.enqueue(id BIGINT, why TEXT) RETURNS void LANGUAGE sql AS $$
  INSERT INTO retrieval.queue (source_id, reason) VALUES (id, why)
  ON CONFLICT (source_id) DO UPDATE
     SET reason = excluded.reason, attempts = 0, enqueued_at = now(), next_attempt_at = now(), claimed_until = NULL;
  SELECT pg_notify('retrieval_queue', '');
$$;

CREATE FUNCTION retrieval.on_item_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM retrieval.enqueue(NEW.id, lower(TG_OP));
  RETURN NULL;
END $$;

CREATE FUNCTION retrieval.on_version_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM retrieval.enqueue(NEW.item_id, 'version');
  RETURN NULL;
END $$;

CREATE TRIGGER knowledge_items_retrieval AFTER INSERT OR UPDATE ON knowledge_items
  FOR EACH ROW EXECUTE FUNCTION retrieval.on_item_change();
CREATE TRIGGER knowledge_versions_retrieval AFTER INSERT ON knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION retrieval.on_version_insert();

INSERT INTO retrieval.queue (source_id, reason) SELECT id, 'backfill' FROM knowledge_items;
