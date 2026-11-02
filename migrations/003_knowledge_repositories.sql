-- Repository registry and knowledge management (business rules, architecture, skills, ...).

CREATE TABLE repositories (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,                   -- directory name under reposRoot
  provider        TEXT NOT NULL DEFAULT 'bitbucket',
  remote_slug     TEXT NOT NULL DEFAULT '',               -- defaults to name
  description     TEXT NOT NULL DEFAULT '',
  projects        TEXT[] NOT NULL DEFAULT '{}',           -- project mappings (from config.projects + edits)
  services        TEXT[] NOT NULL DEFAULT '{}',
  owners          TEXT[] NOT NULL DEFAULT '{}',
  tags            TEXT[] NOT NULL DEFAULT '{}',
  dependencies    TEXT[] NOT NULL DEFAULT '{}',
  architecture    TEXT NOT NULL DEFAULT '',
  allowed_actions TEXT[] NOT NULL DEFAULT '{read,write,pull_request}'
                  CHECK (allowed_actions <@ '{read,write,pull_request}'::text[]),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_items (
  id              BIGSERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_.-]*$'),
  category        TEXT NOT NULL CHECK (category IN ('business_rule', 'architecture_guideline', 'coding_standard', 'domain_knowledge', 'security_policy', 'agent_skill', 'repository_convention')),
  scope_type      TEXT NOT NULL CHECK (scope_type IN ('GLOBAL', 'ORGANIZATION', 'PROJECT', 'REPOSITORY', 'WORKFLOW', 'STEP')),
  scope_ref       TEXT NOT NULL DEFAULT '',               -- '' for GLOBAL; org / project / repo / workflow key / workflow:step
  title           TEXT NOT NULL,
  conflict_key    TEXT,                                   -- items sharing it compete; precedence decides
  priority        INT NOT NULL DEFAULT 0,
  enforced        BOOLEAN NOT NULL DEFAULT false,         -- cannot be overridden by a more specific scope
  enabled         BOOLEAN NOT NULL DEFAULT true,
  current_version INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'GLOBAL') = (scope_ref = ''))
);
CREATE INDEX knowledge_items_scope ON knowledge_items(scope_type, scope_ref) WHERE enabled;

CREATE TABLE knowledge_versions (
  id            BIGSERIAL PRIMARY KEY,
  item_id       BIGINT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  version       INT NOT NULL CHECK (version > 0),
  content       TEXT NOT NULL,                            -- the rule / guideline / skill instructions
  applicability JSONB NOT NULL DEFAULT '{}',              -- {step_types, step_keys, repos, projects, keywords}
  metadata      JSONB NOT NULL DEFAULT '{}',              -- skills: {required_tools, output_contract, tags}
  change_note   TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, version)
);

CREATE TABLE knowledge_audit (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,                               -- created | version | enabled | disabled | updated
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
