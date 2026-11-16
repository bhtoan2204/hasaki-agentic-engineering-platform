-- Shared knowledge items an admin deleted. The repository importer and the boot-time seeds skip these keys, so a
-- deleted skill or document does not come back on the next import while its source file still exists. `snapshot`
-- keeps the deleted item with every version (and its deleted supporting files) so a deletion can be reviewed or
-- restored by hand. Creating the key again explicitly removes the tombstone.
CREATE TABLE knowledge_deletions (
  key         TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  snapshot    JSONB NOT NULL DEFAULT '{}',
  deleted_by  TEXT NOT NULL DEFAULT '',
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
