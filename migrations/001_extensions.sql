-- Extensions required for time-series + geographic queries.
-- The schema_migrations table is created by the migration runner before any
-- migration runs, so we don't recreate it here.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;
