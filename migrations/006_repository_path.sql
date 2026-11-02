-- Repositories may live in sub-folders of reposRoot (e.g. oms-src/oms-api). `path` is relative to reposRoot;
-- empty means "same as name".
ALTER TABLE repositories ADD COLUMN path TEXT NOT NULL DEFAULT '';
