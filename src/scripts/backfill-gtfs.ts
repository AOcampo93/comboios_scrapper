/**
 * One-shot backfill for the GTFS-derived columns.
 *
 * The daily aggregator only fills scheduled_dwell_seconds / excess_seconds for the
 * day it processes, and only after GTFS is loaded. This script (a) ensures the
 * GTFS feed is imported, then (b) fills those columns for every historical dwell
 * event still missing them — across all run_dates at once.
 *
 * Idempotent: only touches rows where scheduled_dwell_seconds IS NULL.
 *
 * Usage (production, inside the running scraper container):
 *   docker exec <scraper-container> node dist/scripts/backfill-gtfs.js
 *
 * Usage (local dev, from repo root):
 *   DATABASE_URL=... npx tsx src/scripts/backfill-gtfs.ts
 */
import { pool, runMigrations } from "../db.js";
import { importGtfs } from "../gtfs.js";

async function main(): Promise<void> {
    await runMigrations();
    await importGtfs();

    const t0 = Date.now();
    const res = await pool.query(
        `
        UPDATE station_dwell_events sde
        SET scheduled_dwell_seconds = g.sched,
            excess_seconds          = sde.dwell_seconds - g.sched
        FROM (
            SELECT DISTINCT ON (t.trip_short_name::int, st.stop_id)
                   t.trip_short_name::int AS train_number,
                   st.stop_id,
                   gtfs_time_to_seconds(st.departure_time)
                       - gtfs_time_to_seconds(st.arrival_time) AS sched
            FROM gtfs_trips t
            JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
            WHERE t.trip_short_name ~ '^[0-9]+$'
            ORDER BY t.trip_short_name::int, st.stop_id, t.trip_id
        ) g
        WHERE sde.scheduled_dwell_seconds IS NULL
          AND sde.dwell_seconds IS NOT NULL
          AND sde.train_number = g.train_number
          AND REPLACE(sde.station_code, '-', '_') = g.stop_id
          AND g.sched IS NOT NULL
        `,
    );

    console.log(
        JSON.stringify({
            msg: "backfill complete",
            scheduledDwellUpdated: res.rowCount ?? 0,
            ms: Date.now() - t0,
        }),
    );
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error("backfill failed:", err);
        await pool.end().catch(() => {});
        process.exit(1);
    });
