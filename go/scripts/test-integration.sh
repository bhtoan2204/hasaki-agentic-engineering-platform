#!/usr/bin/env bash
# Runs the Go tests against throwaway PostgreSQL 17 clusters migrated by the TypeScript runner:
# one with pgvector (PLATFORM_GO_TEST_DATABASE_URL) and one without (PLATFORM_GO_TEST_NOVECTOR_DATABASE_URL).
# Usage: go/scripts/test-integration.sh [go test args...]   (default: ./...)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
pg_vector_bin=${PG_VECTOR_BIN:-/nix/store/nz9vqy3hbpmyi9icgjmhm02yrn62rmdz-postgresql-and-plugins-17.11/bin}
pg_plain_bin=${PG_PLAIN_BIN:-/nix/store/vync24csmxy5saql5ah77vkn59yg2x5h-postgresql-17.11/bin}
go_bin=${GO:-go}

# Unix socket paths must stay under 107 bytes, so the clusters live in a short /tmp directory.
tmp=$(mktemp -d /tmp/ctp-go-XXXX)
started=()
cleanup() {
  for c in "${started[@]}"; do
    "${c%%|*}/pg_ctl" -D "${c##*|}" -m immediate stop >/dev/null 2>&1 || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

start_cluster() { # name bin -> prints the database URL
  local name=$1 bin=$2 dir=$tmp/$1
  mkdir -p "$dir"
  "$bin/initdb" -D "$dir/data" -U postgres -A trust >/dev/null
  "$bin/pg_ctl" -D "$dir/data" -l "$dir/log" -w \
    -o "-k $dir -c listen_addresses='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null
  started+=("$bin|$dir/data")
  "$bin/createdb" -h "$dir" -U postgres platform
  local url="postgresql://postgres@localhost/platform?host=$dir"
  (cd "$root" && DATABASE_URL=$url node --disable-warning=ExperimentalWarning --input-type=module \
    -e 'const {migrate}=await import("./src/db/migrate.ts"); await migrate(); process.exit(0)')
  echo "$url"
}

vector_url=$(start_cluster vector "$pg_vector_bin" | tail -n1)
plain_url=$(start_cluster plain "$pg_plain_bin" | tail -n1)

args=("$@")
[ ${#args[@]} -eq 0 ] && args=(./...)
cd "$root/go"
PLATFORM_GO_TEST_DATABASE_URL=$vector_url PLATFORM_GO_TEST_NOVECTOR_DATABASE_URL=$plain_url \
  "$go_bin" test -p 1 "${args[@]}"
