#!/usr/bin/env bash
# A throwaway Postgres for `npm test` on the dev machine.
set -euo pipefail
name=deizmem-test-pg
if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p 127.0.0.1:55432:5432 \
    -e POSTGRES_USER=deizmem -e POSTGRES_PASSWORD=deizmem -e POSTGRES_DB=deizmem \
    pgvector/pgvector:0.8.1-pg17 >/dev/null
fi
until docker exec "$name" pg_isready -U deizmem -d deizmem >/dev/null 2>&1; do sleep 1; done
echo "postgres://deizmem:deizmem@127.0.0.1:55432/deizmem"
