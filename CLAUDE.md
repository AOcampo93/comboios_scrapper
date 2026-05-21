# CLAUDE.md — comboios_scrapper (Backend B)

Read this first when resuming work on this repo.

## What this repo is

Node services + a database, deployed together as one Coolify Service in
production. The first three loops all run inside one Node process (`src/index.ts`):
1. **Scraper** — polls comboios.live every 10s during operating hours.
2. **Aggregator** — daily 03:00 batch job that materializes raw snapshots into
   permanent aggregate tables.
3. **GTFS sync** — `src/gtfs.ts`, imports CP's static GTFS feed on boot then
   every 24h (hash-gated, skips an unchanged feed).
4. **Backup** — daily 03:30 UTC pg_dump → S3-compatible upload via rclone.

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

## Schema overview (after migrations 001-006)

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
└── scheduled_dwell_seconds, excess_seconds  populated by the aggregator from GTFS (005)

route_segments                     permanent
├── train_number, run_date, from_station, to_station, departed_at  (UNIQUE)
├── arrived_at, travel_seconds
├── distance_km                    summed from GPS positions, NOT haversine
├── avg_speed_kmh
└── day_of_week (0=Sunday)

segment_paths (006)                permanent — one OSM-routed polyline per
├── from_station, to_station (PK)  (from→to) pair, for the frontend speed heatmap
├── geometry (GEOGRAPHY LINESTRING) populated by seed-osm-geometry.ts (one-shot),
└── point_count                    NOT by the aggregator. See "Static heatmap
                                   geometry". point_count = 100_000 + vertex
                                   count on OSM-seeded rows.

gtfs_* (005)                       full-snapshot, TRUNCATE+reload each import:
                                   gtfs_routes / trips / stops / stop_times /
                                   calendar / calendar_dates / gtfs_meta
train_line_map (005)               derived: train_number → route_id. Built from
                                   gtfs_trips.trip_short_name (= the train number).
```

`gtfs_time_to_seconds(text)` (005) converts GTFS clock strings (may exceed
24:00:00) to seconds-since-midnight, used for scheduled-dwell math.

## What's done

| Task | Notes |
|------|-------|
| F3.3 Schema | 6 migrations, idempotent runner |
| F3.4 Scraper | polling + dedup + backoff + structured logs |
| F3.5 Aggregator | dwell events + segments + scheduled dwell (geometry NOT written here anymore — see "Static heatmap geometry") |
| F3.2 Backup | supercronic + pg_dump + rclone, 30d retention |
| GTFS ingest | `src/gtfs.ts` — feed → gtfs_* tables + train_line_map; `npm run backfill` |
| Prod backfill scripts | `src/scripts/backfill-{gtfs,aggregations}.ts` compile into `dist/` so they're runnable inside the runtime image via `docker exec ... node dist/scripts/<x>.js` |
| OSM geometry seeder | `src/scripts/seed-osm-geometry.ts` — one-shot. Replaces aggregator's GPS-derived `segment_paths` with OSM-routed paths. See "Static heatmap geometry". |

## What's pending

- **Tracking cancellations per (train, run_date)**: needed for the
  `cancellationPercent` field in the reliability endpoint, which is currently
  hardcoded to 0. Idea: add a `train_runs` table populated by the aggregator
  that records `cancelled` and `completed` flags from snapshots' status.
- **`seed-osm-geometry.ts` writes its OSM cache under `__dirname`** which
  resolves to `/app/dist/scripts/` at runtime — read-only for the `node` user.
  Workaround today is `docker exec -u 0`. Cleaner: read a `OSM_CACHE_DIR` env
  var (default `__dirname` for dev) and set it to `/tmp` in the prod
  container. Cache is only consulted on re-runs, so it's not blocking.
- **GPS noise still produces impossible speeds in `route_segments.avg_speed_kmh`**
  (up to 558 km/h observed). The heatmap endpoint clamps `avg_speed_kmh <= 220`
  on read so the visible colour is honest, but the raw column still holds
  outliers and would skew any future analytics. Filter at insert time when
  someone needs the raw data clean.

## Static heatmap geometry

The rail network is static — OSM has it traced. Computing `segment_paths.geometry`
from raw GPS pings was the original design (`aggregator.ts` had a
`ST_MakeLine` block) and it was wrong: sparse polling produced 2–5 vertex
polylines that drew as long straight diagonals across the country, forcing
the app endpoint to filter them out with progressively complex heuristics
(comboios_app PRs #2–#5, all reverted in #6).

Since 2026-05-21:

- **`src/scripts/seed-osm-geometry.ts`** is the only writer to
  `segment_paths.geometry`. It runs once per deploy (or whenever the GTFS
  feed introduces new stops), enumerating every consecutive `(stop, next stop)`
  pair from `gtfs_stop_times` and routing each through Portugal's OSM rail
  graph (`railGeometry.ts → buildRailRouter`). It also deletes orphan rows
  — pairs not in GTFS, left over from express services skipping intermediate
  stations.
- **`aggregator.ts` no longer touches geometry.** Its job is to populate
  `route_segments` (speed/time/distance per run) and `station_dwell_events`
  scheduled-dwell. The aggregator's old upsert had a
  `WHERE EXCLUDED.point_count >= segment_paths.point_count` guard; the seed
  writes `point_count = 100_000 + vertices` so that guard can never overwrite
  OSM with GPS even if the aggregator's writer is reintroduced by accident.

Run order on first deploy of a fresh DB:
1. `node dist/scripts/backfill-gtfs.js` — populates scheduled-dwell + GTFS tables
2. `node dist/scripts/backfill-aggregations.js` — populates `route_segments`
3. `node dist/scripts/seed-osm-geometry.js` — populates `segment_paths` from OSM

The seed-osm-geometry step takes 1–3 min (downloads ~50 MB OSM data on first
run, cached on disk thereafter).

## GTFS ingestion

`src/gtfs.ts` downloads `GTFS_URL` (default `https://publico.cp.pt/gtfs/gtfs.zip`),
unzips with `fflate`, parses the CSVs and TRUNCATE+reloads the `gtfs_*` tables.
A SHA-256 of the zip in `gtfs_meta` skips re-import of an unchanged feed.
`train_short_name` in CP's GTFS **is the train number** — that's the join key
for `train_line_map` and for scheduled-dwell. Run `npm run backfill` once to
fill `scheduled_dwell_seconds`/`excess_seconds` on all historical dwell events.

## Backfill scripts and the `src/scripts/` directory

`src/scripts/` exists because the Dockerfile's runtime stage copies only
`dist/` and `migrations/` — anything in `scripts/` at the repo root is
**invisible at runtime**. Scripts that must run in production live in
`src/scripts/` so that `tsc` compiles them to `dist/scripts/`. `railGeometry.ts`
also lives under `src/scripts/` because both `seed.ts` (dev-only) and
`seed-osm-geometry.ts` (prod-runnable) import it; only `seed.ts` itself stays
at the repo root since it's never run in prod.

| Script | Runtime command | Purpose |
|--------|-----------------|---------|
| `src/scripts/backfill-gtfs.ts` | `docker exec <scraper> node dist/scripts/backfill-gtfs.js` | Downloads the GTFS feed and fills `scheduled_dwell_seconds`/`excess_seconds` on every historical row in `station_dwell_events`. Idempotent (only touches rows where the column is NULL). |
| `src/scripts/backfill-aggregations.ts` | `docker exec <scraper> node dist/scripts/backfill-aggregations.js` | Iterates every distinct UTC date in `train_snapshots` and calls `runAggregations()` for each, in chronological order. Use on first deploy of the heatmap pipeline to populate `route_segments` from accumulated GPS history instead of waiting one day per night. Idempotent. |
| `src/scripts/seed-osm-geometry.ts` | `docker exec -u 0 <scraper> node dist/scripts/seed-osm-geometry.js` | Routes every GTFS consecutive station pair through OSM and upserts `segment_paths` with the canonical curved geometry; deletes orphan rows (pairs not in GTFS). Needs `-u 0` today because the OSM cache file writes to `/app/dist/scripts/` — see "What's pending". |

Local dev uses `tsx`:
```bash
DATABASE_URL=... npm run backfill        # → tsx src/scripts/backfill-gtfs.ts
DATABASE_URL=... npm run backfill-all    # → tsx src/scripts/backfill-aggregations.ts
```

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

**2026-05-21 — OSM-only `segment_paths` deployed (PR #1 + PR #2).**

The aggregator stopped writing geometry. `seed-osm-geometry.ts` was added
and run once against prod via Coolify's internal
`queue_application_deployment(...)` helper (its REST API is disabled by
default). Output:

```
{"msg":"seed-osm-geometry complete","gtfsPairs":1220,"routedViaOsm":1218,
 "straightFallback":2,"upserted":1220,"orphansDeleted":950}
```

950 GPS-derived orphan rows (express-service artefacts: chord 50–174 km
straight diagonals) gone. The 2 straight-line fallbacks are stations OSM
couldn't snap to a track within 4 km — terminal or non-rail-connected stops.

`/api/heatmap/speed` now returns 1014 features in prod (down from 1793 with
the old GPS-derived data + heuristic filters). Every visible segment follows
OSM track curves end-to-end — same as the local seed.

**2026-05-20 — first end-to-end production validation of the heatmap
pipeline.** Three redeploys were needed:
1. Pre-existing commits did not include migrations 005/006 or `src/gtfs.ts`
   (uncommitted on disk). After committing (`9519098`) and redeploying,
   scraper crashed in `runMigrations()` with `connect ETIMEDOUT
   172.18.0.2:5432` — the band-aided `docker network connect` was lost.
2. Fix: switched the scraper's `DATABASE_URL` env var in Coolify from
   `postgres://...@172.18.0.2:5432/...` to the hostname form
   `postgres://...@db-x11j2gf0du0mz56h52zvbuhb:5432/...`. (The hostname
   was already in `/etc/hosts` via Coolify's predefined-network feature
   — see `--add-host` in the build log.) Redeployed; migrations 005/006
   applied cleanly; GTFS sync ran on boot.
3. Ran prod backfill (commit `c8ae05f`):
   - `node dist/scripts/backfill-gtfs.js` updated 269,045 dwell events
     with `scheduled_dwell_seconds`+`excess_seconds` in ~16s.
   - `node dist/scripts/backfill-aggregations.js` processed 15 days of
     `train_snapshots` (2026-05-06 → 2026-05-20) in ~13 min.

After backfill: `/api/heatmap/speed` returns 1961 segments (median 65.8
km/h, median 20 samples). `/api/heatmap/dwell` has `avgExcessSeconds`
populated on 407/413 stations (median +72 s vs scheduled). Frontend
heatmap visible in production.

**Outstanding from this validation**:
- Frontend resource in Coolify still uses `DATABASE_URL=...172.18.0.2:5432...`.
  Works today only because it has not been redeployed since that IP was
  valid. Next redeploy of the frontend will ETIMEDOUT until its
  `DATABASE_URL` is updated to `db-x11j2gf0du0mz56h52zvbuhb` too.
- The 558 km/h outlier in `avg_speed_kmh` (see "What's pending") needs
  filtering before the heatmap looks honest.

**2026-05-17**: migrations 001-006 apply clean locally; `npm run seed` +
`npm run backfill` import the live CP GTFS (185 routes / 1756 trips /
27870 stop_times) and fill `scheduled_dwell_seconds`+`excess_seconds` on
all dwell events. `train_line_map` populated (1600 trains).
