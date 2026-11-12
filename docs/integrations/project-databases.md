# Project QC databases

Agents can read a project's QC database (MySQL / MariaDB) during a run, with Claude, Codex, Cursor and Antigravity alike. The
databases are tools of the platform's per-run tool bridge (MCP `call_tool`), next to Splunk, Kafka, Vault and Argo CD:

| Tool | Does |
| --- | --- |
| `database.list` | Databases this run may query (key, project, database name, description, row limit) |
| `database.schema` | Tables (approximate rows, comments), or one table's columns and indexes; reads no row data |
| `database.query` | One read-only statement: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `WITH … SELECT` |

## Setup (admin)

Integrations → **Project QC databases** → Add database. One entry per database, for example:

| Key | Project | Repositories | Note |
| --- | --- | --- | --- |
| `oms-qc` | `OMS` | | every run with an OMS repository |
| `payment-qc` | `Payment` | | every run with a Payment repository |
| `warranty-qc` | | `warranty-api, warranty-worker` | the warranty repositories are mapped to project OMS, so list them explicitly |

Use a MySQL account with **SELECT only**. *Test* shows the server version and warns when the account can write. The
password is stored encrypted (`shared_secrets`, `AUTH_SECRET`), is never returned by the API, and is kept when an
update leaves the field empty. Changes are audited (`database.create` / `update` / `delete`).

## Who can query

A run may use a database when its repository scope contains one of the database's repositories, or a repository mapped
to its project. The run scope is the owner's own repository access (see `docs/architecture/repository-access.md`),
re-checked on every tool call, so revoking someone's repositories also revokes their databases. Members see only the
databases they can use, without host or account.

## Read-only, three times

1. **Statement**: one statement; first keyword must be a read; `INSERT`/`UPDATE`/`DELETE`/DDL, `SELECT … INTO`,
   `FOR UPDATE` / `LOCK`, `SET`, session variables, `SLEEP`/`BENCHMARK`/`LOAD_FILE` and MySQL executable comments
   (`/*! … */`) are refused. The check ignores literals, quoted identifiers and comments; the original statement runs.
2. **Session**: a fresh connection without multi-statements, `START TRANSACTION READ ONLY`, server-side statement
   timeout (MySQL `MAX_EXECUTION_TIME`, MariaDB `max_statement_time`) plus a client timeout, rolled back afterwards.
3. **Account**: SELECT-only credentials.

Results: at most the database's row limit (default 200, max 1000; reading stops there), values over 1,000 characters
cut, binary values summarized, columns named like passwords, tokens, keys, salts, hashes, OTPs, PINs, CVVs or card
numbers masked, secret-looking strings redacted. Tool calls and their bounded results are journaled per attempt like
every other tool call.

## Tests

`test/project-databases.test.ts`. The real-server case runs when `TEST_MYSQL_HOST` is set:

```bash
docker run -d --name ctp-mariadb -e MARIADB_ROOT_PASSWORD=root -p 127.0.0.1:53306:3306 mariadb:10.7
TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=53306 TEST_MYSQL_ROOT_PASSWORD=root \
  node --import ./test/setup.ts --test test/project-databases.test.ts
```
