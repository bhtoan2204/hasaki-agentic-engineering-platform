-- QC investigations read pod logs through Argo CD (QC has no Splunk). They are stored as searches of the run like the
-- Splunk ones, so evidence refs (S<id>:<n>), correlation, timeline and report work unchanged.
ALTER TABLE splunk_searches DROP CONSTRAINT splunk_searches_mode_check;
ALTER TABLE splunk_searches ADD CONSTRAINT splunk_searches_mode_check
  CHECK (mode IN ('oneshot', 'job', 'export', 'manual', 'argocd'));
ALTER TABLE splunk_searches DROP CONSTRAINT splunk_searches_auth_check;
ALTER TABLE splunk_searches ADD CONSTRAINT splunk_searches_auth_check
  CHECK (auth IN ('session', 'token', 'shared_token', 'manual', 'argocd'));
