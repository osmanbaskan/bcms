#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMA_PATH="$ROOT_DIR/apps/api/prisma/schema.prisma"
BASELINE_SQL="$(mktemp)"

cleanup() {
  rm -f "$BASELINE_SQL"
}
trap cleanup EXIT

cd "$ROOT_DIR"

table_count="$(
  node -e "const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); (async()=>{const r=await p.\$queryRawUnsafe(\"select count(*)::int as count from information_schema.tables where table_schema='public' and table_type='BASE TABLE'\"); console.log(r[0].count);})().finally(()=>p.\$disconnect())"
)"

if [ "$table_count" != "0" ]; then
  echo "Refusing to bootstrap: public schema is not empty ($table_count tables found)." >&2
  echo "Use this only for a brand-new empty database." >&2
  exit 1
fi

npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel "$SCHEMA_PATH" \
  --script > "$BASELINE_SQL"

npx prisma db execute --schema "$SCHEMA_PATH" --file "$BASELINE_SQL"

for migration_dir in "$ROOT_DIR"/apps/api/prisma/migrations/*; do
  [ -d "$migration_dir" ] || continue
  migration_name="$(basename "$migration_dir")"
  npx prisma migrate resolve --schema "$SCHEMA_PATH" --applied "$migration_name"
done

npx prisma migrate status --schema "$SCHEMA_PATH"

echo "Empty database bootstrapped to current Prisma schema and migrations marked applied."
