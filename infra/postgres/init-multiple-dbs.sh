#!/bin/bash
# Creates additional databases listed in POSTGRES_MULTIPLE_DATABASES (comma-separated).
# First DB is already created by POSTGRES_DB env var.
#
# HIGH-INF-009 fix (2026-05-05): SQL identifier injection koruması.
# Eski hâlinde `$database` SQL heredoc içinde direkt interpolasyon ile
# embedded — env-controlled input olduğu için saldırı yüzeyi düşük ama
# hatalı karakterler (boşluk, ', ;) crash + log gürültüsü yaratabiliyordu.
# Yeni: psql -v + format('%I') ile parametreli, identifier doğru quote'lanır.
set -e

create_user_and_database() {
    local database=$1
    # Whitelist: yalnızca alfanumerik + _ izinli identifier — ekstra savunma.
    if ! [[ "$database" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
        echo "  ERROR: invalid database identifier '$database' (allowed: ^[A-Za-z_][A-Za-z0-9_]*$)"
        exit 1
    fi
    echo "  Creating database '$database'"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -v dbname="$database" <<-'EOSQL'
        SELECT format('CREATE DATABASE %I', :'dbname')
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname')\gexec
EOSQL
}

if [ -n "$POSTGRES_MULTIPLE_DATABASES" ]; then
    echo "Multiple database creation requested: $POSTGRES_MULTIPLE_DATABASES"
    for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
        create_user_and_database "$db"
    done
    echo "Multiple databases created"
fi
