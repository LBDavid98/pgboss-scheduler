#!/usr/bin/env bash
# Create the scheduler's role and database on your fleet's shared Postgres.
#
#   bash scripts/provision-db.sh                 # generates a password, prints the URL
#   SCHEDULER_DB_PASSWORD=... bash scripts/...   # uses one you already have
#
# WHY THIS EXISTS AS A SCRIPT rather than a line in the data stack's init SQL.
# stacks/data/postgres/init/01-extensions-and-databases.sql runs ONCE, at initdb,
# on an empty data directory — the file says so itself. That volume has existed
# since August, so editing it does nothing at all. The line is added there too so
# a future rebuild is correct, but THIS is what takes effect on the live server.
#
# Idempotent: safe to run again. It will not reset a password that already works.

set -euo pipefail

DB_NAME="${SCHEDULER_DB_NAME:-scheduler}"
DB_USER="${SCHEDULER_DB_USER:-scheduler_app}"
CONTAINER="${POSTGRES_CONTAINER:-postgres}"
SUPERUSER="${POSTGRES_SUPERUSER:-app}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "fail: no running container named '$CONTAINER'." >&2
    echo "      The data stack owns it: cd ~/server/stacks/data && docker compose up -d" >&2
    exit 1
fi

psql() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$SUPERUSER" "$@"; }

exists() {
    [[ "$(psql -d postgres -tAc "$1" 2>/dev/null || echo)" == "1" ]]
}

if exists "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER'"; then
    echo "ok   role $DB_USER already exists — leaving its password alone"
    PASSWORD="${SCHEDULER_DB_PASSWORD:-}"
else
    PASSWORD="${SCHEDULER_DB_PASSWORD:-$(openssl rand -hex 24)}"
    # Password interpolated into DDL, so it is generated here rather than taken
    # from anywhere a quote could arrive from. openssl rand -hex is [0-9a-f] only.
    psql -d postgres -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$PASSWORD'"
    echo "ok   created role $DB_USER"
fi

if exists "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'"; then
    echo "ok   database $DB_NAME already exists"
else
    # OWNED BY the app role, matching app-three/foreman_app and cc/cc_app on this
    # box: one application's migration or restore cannot touch another's tables.
    psql -d postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"
    echo "ok   created database $DB_NAME owned by $DB_USER"
fi

# pg-boss creates its own schema on first start, and the scheduler creates its
# own beside it — both need CREATE on the database, which ownership already gives.
psql -d "$DB_NAME" -c "GRANT ALL ON DATABASE $DB_NAME TO $DB_USER" >/dev/null
echo "ok   granted $DB_USER on $DB_NAME"

echo
if [[ -n "$PASSWORD" ]]; then
    echo "Put this in <deploy path>/.env (chmod 600):"
    echo
    echo "  DATABASE_URL=postgres://$DB_USER:$PASSWORD@postgres:5432/$DB_NAME"
else
    echo "The role already existed, so its password is not known here."
    echo "Reuse the DATABASE_URL already in .env, or reset it with:"
    echo "  docker exec -it $CONTAINER psql -U $SUPERUSER -c \"ALTER ROLE $DB_USER PASSWORD '...'\""
fi
