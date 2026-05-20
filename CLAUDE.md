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

segment_paths (006)                permanent — one GPS-traced polyline per
├── from_station, to_station (PK)  (from→to) pair, for the frontend speed heatmap
├── geometry (GEOGRAPHY LINESTRING)
└── point_count                    best-sampled run wins on conflict

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
| F3.5 Aggregator | dwell events + segments + segment_paths geometry + scheduled dwell |
| F3.2 Backup | supercronic + pg_dump + rclone, 30d retention |
| GTFS ingest | `src/gtfs.ts` — feed → gtfs_* tables + train_line_map; `npm run backfill` |
| Prod backfill scripts | `src/scripts/backfill-{gtfs,aggregations}.ts` compile into `dist/` so they're runnable inside the runtime image via `docker exec ... node dist/scripts/<x>.js` |

## What's pending

- **Tracking cancellations per (train, run_date)**: needed for the
  `cancellationPercent` field in the reliability endpoint, which is currently
  hardcoded to 0. Idea: add a `train_runs` table populated by the aggregator
  that records `cancelled` and `completed` flags from snapshots' status.
- **`segment_paths` geometry only accrues forward**: it's built from
  `train_snapshots`, which drop after 14d. Historical segments get geometry as
  new runs are observed; there's no way to backfill older ones.
- **GPS noise produces impossible speeds in `route_segments.avg_speed_kmh`**:
  observed up to 558 km/h on real prod data (CP's fastest train is 220 km/h).
  Brief positional jitter creates a tiny travel_seconds with a real
  distance_km. Either filter `WHERE travel_seconds > N` in the aggregator
  or clamp `avg_speed_kmh <= 230` in the heatmap endpoint. Latent in code
  since 003.

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
`src/scripts/` so that `tsc` compiles them to `dist/scripts/`. Dev-only
scripts (`seed.ts`, `railGeometry.ts`) can stay in `scripts/` and run
through `tsx`.

| Script | Runtime command | Purpose |
|--------|-----------------|---------|
| `src/scripts/backfill-gtfs.ts` | `docker exec <scraper> node dist/scripts/backfill-gtfs.js` | Downloads the GTFS feed and fills `scheduled_dwell_seconds`/`excess_seconds` on every historical row in `station_dwell_events`. Idempotent (only touches rows where the column is NULL). |
| `src/scripts/backfill-aggregations.ts` | `docker exec <scraper> node dist/scripts/backfill-aggregations.js` | Iterates every distinct UTC date in `train_snapshots` and calls `runAggregations()` for each, in chronological order. Use on first deploy of the heatmap pipeline to populate `segment_paths`/`route_segments` from accumulated GPS history instead of waiting one day per night. Idempotent. |

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
