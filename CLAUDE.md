# CLAUDE.md — comboios_scrapper (Backend B)

Read this first when resuming work on this repo.

## What this repo is

Three Node services + a database, deployed together as one Coolify Service in
production:
1. **Scraper** — polls comboios.live every 10s during operating hours.
2. **Aggregator** — daily 03:00 batch job that materializes raw snapshots into
   permanent aggregate tables.
3. **Backup** — daily 03:30 UTC pg_dump → S3-compatible upload via rclone.

All three live in the same git repo, deployed from the same compose. The
frontend (`comboios_app`) reads the BD directly for historical endpoints.

## Critical operational notes

### Operating hours

The scraper sleeps from 01:00 to 05:00 Lisbon time. **`train_snapshots` will
appear empty during this window**, that's by design (`src/schedule.ts`). Don't
debug the scraper if you check it at 03:00 and see no recent inserts.

### Migrations are idempotent at boot

Every container restart runs `runMigrations()` from `src/db.ts`. It reads
`migrations/NNN_*.sql`, checks `schema_migrations`, applies what's missing in
a transaction. Adding a new migration is just dropping a new file
`005_thing.sql` — next deploy applies it.

### Coolify networking gotcha (PROD)

If running with separate Coolify resources (BD as Service, scraper as
Application), they end up on different Docker networks. Symptoms:
`connect ETIMEDOUT 172.18.0.2:5432`. The persistent fix is one of:

- **Recommended (Path B)**: combine into a single Coolify Service with
  Docker Compose containing all containers. Networking is then automatic.
  See README.md compose example.
- **Alternative (Path C)**: in the BD Service, enable "Connect To Predefined
  Network" so it joins the `coolify` shared network. Then in the scraper's
  `DATABASE_URL`, use the BD container's hostname on that network (e.g.
  `db-x11j2gf0du0mz56h52zvbuhb:5432`). Verify with `docker inspect <bd> --format '{{...Aliases...}}'`.
- **Avoid**: `docker network connect` from the host. It's a band-aid that
  caducates on every redeploy.

## Schema overview (after migrations 001-004)

```
train_snapshots                    14d retention, hypertable
├── ts (TIMESTAMPTZ)               partition key
├── train_number (INTEGER)
├── run_date (DATE)
├── status (TEXT)
├── delay_seconds (INTEGER)
├── speed_decikmh (SMALLINT)       speed × 10 to fit SMALLINT
├── position (GEOGRAPHY POINT)     PostGIS, GIST index
└── ...

station_dwell_events               permanent
├── train_number, run_date, station_code, arrived_at  (UNIQUE)
├── departed_at, dwell_seconds
├── delay_at_arrival_seconds       added in 004 — needed for scoring after retention drops snapshots
└── scheduled_dwell_seconds, excess_seconds  (TODO: populate from GTFS schedule)

route_segments                     permanent
├── train_number, run_date, from_station, to_station, departed_at  (UNIQUE)
├── arrived_at, travel_seconds
├── distance_km                    summed from GPS positions, NOT haversine
├── avg_speed_kmh
└── day_of_week (0=Sunday)
```

## What's done

| Task | Notes |
|------|-------|
| F3.3 Schema | 4 migrations, idempotent runner |
| F3.4 Scraper | polling + dedup + backoff + structured logs |
| F3.5 Aggregator | dwell events + segments, runs 03:00 local |
| F3.2 Backup | supercronic + pg_dump + rclone, 30d retention |

## What's pending

- **Tracking cancellations per (train, run_date)**: needed for the
  `cancellationPercent` field in the reliability endpoint, which is currently
  hardcoded to 0. Idea: add a `train_runs` table populated by the aggregator
  that records `cancelled` and `completed` flags from snapshots' status.
- **Populating `scheduled_dwell_seconds` and `excess_seconds`** in
  `station_dwell_events`: requires ingesting CP's GTFS `stop_times.txt`. Until
  then those columns stay NULL.
- **Line-level aggregations**: need GTFS `routes.txt` to map train numbers to
  lines. Once available, add a daily job that aggregates `station_dwell_events`
  by line.

## Local dev

```bash
docker compose up postgres -d
DATABASE_URL='postgres://postgres:postgres@localhost:5432/comboios' npm run seed   # bootstraps schema + seed
# or for the real scraper loop:
DATABASE_URL='postgres://postgres:postgres@localhost:5432/comboios' npm run dev
```

## Validating

```bash
# tables exist
psql $DATABASE_URL -c "\dt"

# seed populated
psql $DATABASE_URL -c "SELECT train_number, count(*), round(avg(delay_at_arrival_seconds))::int FROM station_dwell_events GROUP BY train_number ORDER BY train_number;"

# during operating hours, snapshots flowing
psql $DATABASE_URL -c "SELECT count(*), max(ts) FROM train_snapshots;"

# size sanity
psql $DATABASE_URL -c "SELECT pg_size_pretty(pg_database_size('comboios'));"
```

## Last validated state

**2026-05-01**: end-to-end chain working locally. Postgres + migrations +
seed + frontend reading via `/api/reliability/train/528` returns
`samples: 240, onTimePercent: 98.33%, source: "dwell"`. Visual badge confirmed
in popup of train 4401 (live data + historical badge merged).

**Production status**: Coolify deployed with manual `docker network connect`
band-aid (loses on redeploy). User needs to apply persistent fix
(combined compose OR predefined network with hostname). `train_snapshots`
empty until 05:00 Lisbon when scraper exits quiet period.
