-- Task memory aging (docs/architecture/memory-aging.md). Additive: nothing here changes how items resolve.

-- Aging state of a task_memory item. No row = active and never examined. 'dormant' ranks last, 'archived' and 'superseded'
-- are disabled by the job (reversible), 'restored' marks an item a person or an automatic rule brought back.
CREATE TABLE knowledge_aging (
  item_id         BIGINT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'dormant', 'archived', 'superseded', 'restored')),
  policy          TEXT,
  reason          TEXT,
  replaced_by_key TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A person restored it: automatic aging leaves it alone until it is unpinned.
  pinned          BOOLEAN NOT NULL DEFAULT false,
  -- First time a reason that cannot recover was seen for this item (policy "unknown").
  unknown_since   TIMESTAMPTZ,
  unknown_code    TEXT,
  checked_at      TIMESTAMPTZ
);
CREATE INDEX knowledge_aging_state ON knowledge_aging (state, at) WHERE state IN ('dormant', 'archived', 'superseded');
CREATE INDEX knowledge_aging_checked ON knowledge_aging (checked_at NULLS FIRST);

-- When a task_memory item was last offered to a prompt. Best-effort (written after the step transaction commits);
-- a separate table so it never touches knowledge_items (that would fire the retrieval trigger and the cache invalidation).
CREATE TABLE knowledge_usage (
  item_id        BIGINT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  last_loaded_at TIMESTAMPTZ NOT NULL,
  loads          BIGINT NOT NULL DEFAULT 0
);

-- The audit trail survives the item: the row stays (item_id becomes NULL) and keeps the key and owner.
ALTER TABLE knowledge_audit ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE knowledge_audit DROP CONSTRAINT knowledge_audit_item_id_fkey;
ALTER TABLE knowledge_audit ADD CONSTRAINT knowledge_audit_item_id_fkey
  FOREIGN KEY (item_id) REFERENCES knowledge_items(id) ON DELETE SET NULL;
ALTER TABLE knowledge_audit ADD COLUMN item_key TEXT;
ALTER TABLE knowledge_audit ADD COLUMN owner_id BIGINT;
UPDATE knowledge_audit a SET item_key = i.key, owner_id = i.owner_id FROM knowledge_items i WHERE i.id = a.item_id;
CREATE INDEX knowledge_audit_key ON knowledge_audit (item_key, id DESC);

-- Every writer (service, importers, aging) gets the key and owner without changing its INSERT.
CREATE FUNCTION knowledge_audit_identify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_key IS NULL AND NEW.item_id IS NOT NULL THEN
    SELECT key, owner_id INTO NEW.item_key, NEW.owner_id FROM knowledge_items WHERE id = NEW.item_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_audit_identify BEFORE INSERT ON knowledge_audit
  FOR EACH ROW EXECUTE FUNCTION knowledge_audit_identify();
