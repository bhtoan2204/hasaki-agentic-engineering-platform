-- Repositories an admin deleted from the registry. Discovery from config.json projects (group folders such as
-- payment-src/ register every git checkout inside them on boot) skips these names, on every installation sharing
-- this database. Registering the name again explicitly removes the exclusion.
CREATE TABLE repository_exclusions (
  name        TEXT PRIMARY KEY,
  deleted_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
