# comboios_scrapper

Backend B for the comboios.live history project. Three responsibilities, one
container each, sharing a single Postgres + TimescaleDB + PostGIS database:

1. **Scraper** (`src/`) — polls `https://comboios.live/api/vehicles` every 10s
   during CP operating hours (~05:00–01:00 Lisbon), dedups consecutive identical
   tuples, writes to `train_snapshots` (hypertable, 14-day retention).
2. **Aggregator** (`src/aggregator.ts`) — daily 03:00 local job that materializes
   raw snapshots into `station_dwell_events` and `route_segments` (permanent).
   Runs in the same container as the scraper.
3. **Backup** (`backup/`) — separate container. Daily 03:30 UTC `pg_dump` →
   gzip → rclone upload to S3-compatible storage (R2 / B2 / S3) → retention
   prune. Uses supercronic.

## Stack

- **Node 20 + TypeScript**, ESM, `pg` for Postgres, `pino` for logs.
- **TimescaleDB-HA** image bundles PostGIS — one image, both extensions.
- **Migration runner** (`src/db.ts`) applies pending `migrations/NNN_*.sql` at
  boot. Idempotent and transactional per migration. Tracked via the
  `schema_migrations` table.
- **Dedup at ingest**: `Map<train_number, hash>` skips inserts when the tuple
  `(lat, lon, delay, status, speed, next_station)` did not change.
- **Compression** kicks in for chunks older than 2 days (~10-20× ratio).
  **Retention** drops raw snapshots after 14 days; aggregates persist forever.

## Schema

| Table | Purpose | Retention |
|-------|---------|-----------|
| `train_snapshots` | hypertable, raw position+delay+status snapshots | 14 days, compressed after 2 |
| `station_dwell_events` | one row per train×station visit (arrived_at, departed_at, delay_at_arrival, dwell_seconds) | permanent |
| `route_segments` | one row per consecutive (from→to) pair (travel_seconds, distance_km, avg_speed_kmh) | permanent |
| `schema_migrations` | applied migration versions | permanent |

Migration list:

- `001_extensions.sql` — `timescaledb` + `postgis`
- `002_train_snapshots.sql` — hypertable, indexes, compression + retention policies
- `003_aggregates.sql` — `station_dwell_events`, `route_segments`
- `004_dwell_delay.sql` — adds `delay_at_arrival_seconds` to `station_dwell_events`
  so reliability scoring works after the 14-day raw retention drops

## Local dev

```bash
docker compose up postgres -d
npm install

# Apply migrations + insert seed data in one shot:
DATABASE_URL='postgres://postgres:postgres@localhost:5432/comboios' npm run seed

# OR run the scraper for real:
DATABASE_URL='postgres://postgres:postgres@localhost:5432/comboios' npm run dev
```

## Deploy (Coolify)

The recommended setup is a **single Coolify Service / Docker Compose** that
contains all three roles. This avoids cross-resource Docker network issues. See
the parent project's instructions, or use this skeleton:

```yaml
services:
  db:
    image: timescale/timescaledb-ha:pg16
    environment:
      POSTGRES_DB: comboios
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${SERVICE_PASSWORD_DB}
      PGDATA: /home/postgres/pgdata/data
    volumes:
      - comboios-pgdata:/home/postgres/pgdata
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d comboios"]
      interval: 10s
      retries: 10
    restart: unless-stopped

  scraper:
    build:
      context: https://github.com/AOcampo93/comboios_scrapper.git#main
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://postgres:${SERVICE_PASSWORD_DB}@db:5432/comboios
      UPSTREAM_BASE: https://comboios.live/api
      LOG_LEVEL: info
      NODE_ENV: production
    restart: unless-stopped

  backup:
    build:
      context: https://github.com/AOcampo93/comboios_scrapper.git#main
      dockerfile: backup/Dockerfile
    depends_on: { db: { condition: service_healthy } }
    environment:
      DATABASE_URL: postgres://postgres:${SERVICE_PASSWORD_DB}@db:5432/comboios
      RCLONE_REMOTE: ${RCLONE_REMOTE}
      RETENTION_DAYS: "30"
      RCLONE_CONFIG_R2_TYPE: s3
      RCLONE_CONFIG_R2_PROVIDER: Cloudflare
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: ${R2_KEY_ID}
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: ${R2_SECRET}
      RCLONE_CONFIG_R2_ENDPOINT: ${R2_ENDPOINT}
      RCLONE_CONFIG_R2_REGION: auto
    restart: unless-stopped

volumes:
  comboios-pgdata:
```

## Env vars

| Variable | Required by | Notes |
|----------|-------------|-------|
| `DATABASE_URL` | scraper, backup | Postgres connection string |
| `UPSTREAM_BASE` | scraper | default `https://comboios.live/api` |
| `LOG_LEVEL` | scraper | default `info` |
| `SCRAPER_USER_AGENT` | scraper | identifying UA for politeness |
| `POLL_INTERVAL_MS` | scraper | default `10000` |
| `IDLE_INTERVAL_MS` | scraper | default `300000` (used during quiet period) |
| `RCLONE_REMOTE` | backup | e.g. `r2:comboios-backups` |
| `RETENTION_DAYS` | backup | default `30` |
| `RCLONE_CONFIG_R2_*` | backup | rclone config via env vars (see `backup/README.md`) |

## Seed data for development / pre-launch demos

Before 30 days of real data have accumulated, populate the aggregate tables
with synthetic but realistic data so the frontend's reliability badges show
varied colors immediately.

```bash
DATABASE_URL=postgres://... npm run seed       # ~870 dwell events + ~730 segments
DATABASE_URL=postgres://... npm run seed:clean # remove all rows with run_date < today
```

Seed uses real CP train numbers (528, 529, 4401, 4437, 3401), each with a
distinct punctuality profile (chronically punctual, chronically late, erratic,
etc.), and `run_date` strictly before today. Re-runs are idempotent
(`ON CONFLICT DO NOTHING`). Once real data accumulates for 30 days, seed rows
fall out of the reliability query window naturally.

## Useful commands

```bash
npm run dev               # tsx watch with auto-reload
npm run build             # tsc to dist/
npm run start             # node dist/index.js (production)
npm run typecheck         # main project
npx tsc --noEmit -p tsconfig.scripts.json   # typecheck scripts/ + src/
npm run seed              # apply migrations + insert seed data
npm run seed:clean        # remove all rows with run_date < today
```
