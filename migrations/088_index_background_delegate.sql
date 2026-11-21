-- An index job that runs as a user who consented to background Git sync (src/repos/backgroundGit.ts), not as the user
-- who asked for it: its consent and read access are checked again when it is claimed.
ALTER TABLE code_intelligence.runs ADD COLUMN delegated BOOLEAN NOT NULL DEFAULT false;
