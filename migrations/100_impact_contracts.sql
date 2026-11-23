-- Cross-repository contracts (src/impact): what each repository provides or consumes (Kafka topics, HTTP routes, gRPC
-- services, database tables, shared enums), extracted at one pinned base commit per repository. Re-extraction happens
-- only when the base commit or the extractor changes; impact analysis joins providers and consumers across repositories.
CREATE TABLE impact_contracts (
 id bigserial PRIMARY KEY,
 repo text NOT NULL,
 commit text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('kafka_topic','http_route','grpc_service','db_table','shared_enum')),
 role text NOT NULL CHECK (role IN ('provider','consumer')),
 key text NOT NULL,
 method text,
 access text CHECK (access IN ('read','write')),
 file text NOT NULL,
 line integer NOT NULL,
 snippet text NOT NULL DEFAULT '',
 confidence text NOT NULL CHECK (confidence IN ('static','inferred')),
 extractor text NOT NULL
);
CREATE INDEX impact_contracts_key ON impact_contracts (kind, key, role);
CREATE INDEX impact_contracts_repo ON impact_contracts (repo, file);

CREATE TABLE impact_index_state (
 repo text PRIMARY KEY,
 commit text NOT NULL,
 extractor text NOT NULL,
 contracts integer NOT NULL DEFAULT 0,
 files integer NOT NULL DEFAULT 0,
 duration_ms integer NOT NULL DEFAULT 0,
 indexed_at timestamptz NOT NULL DEFAULT now()
);
