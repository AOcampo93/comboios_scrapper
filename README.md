# comboios_scrapper

Backend B for the comboios.live history project. Polls the public CP real-time
endpoint at `https://comboios.live/api/vehicles` every 10s during CP operating
hours (~05:00–01:00 Lisbon) and persists deduplicated snapshots into a
TimescaleDB hypertable for later analytics (reliability scores, dwell times,
speed heatmaps).

## Architecture

- **Node 20 + TypeScript**, ESM, `pg` for Postgres, `pino` for logs.
- **TimescaleDB-HA** (bundles PostGIS) for time-series + geographic queries.
- **Migration runner** in `src/db.ts` applies any pending `migrations/NNN_*.sql`
  files at boot, tracked via a `schema_migrations` table. Idempotent and
  transactional per migration.
- **Dedup at ingest**: `Map<train_number, hash>` skips inserts when the tuple
  `(lat, lon, delay, status, speed, next_station)` did not change since the
  previous poll.
- **Compression** kicks in for chunks older than 2 days. **Retention** drops
  raw snapshots after 14 days; the aggregator service (separate) preserves
  long-term derivatives in `station_dwell_events` and `route_segments`.

## Local dev

```bash
cp .env.example .env
docker compose up postgres -d
npm install
npm run dev
```

## Deploy (Coolify)

1. Deploy `timescale/timescaledb-ha:pg16` as a Database resource. Note the
   internal connection string Coolify generates.
2. Deploy this repo as an Application resource using the included Dockerfile.
   Set `DATABASE_URL` to the internal connection string from step 1.
3. Coolify auto-redeploys on every push to `main` via GitHub webhook.

## Env vars

See `.env.example`. The only required one is `DATABASE_URL`.
