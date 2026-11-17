-- SigNoz queries (logs, traces, metrics) are recorded as searches of the run like Splunk and Argo CD ones, so raw rows get
-- evidence refs (S<id>:<n>) and every call counts against the run and per-step budgets.
ALTER TABLE splunk_searches DROP CONSTRAINT splunk_searches_mode_check;
ALTER TABLE splunk_searches ADD CONSTRAINT splunk_searches_mode_check
  CHECK (mode IN ('oneshot', 'job', 'export', 'manual', 'argocd', 'signoz'));
ALTER TABLE splunk_searches DROP CONSTRAINT splunk_searches_auth_check;
ALTER TABLE splunk_searches ADD CONSTRAINT splunk_searches_auth_check
  CHECK (auth IN ('session', 'token', 'shared_token', 'manual', 'argocd', 'signoz'));
