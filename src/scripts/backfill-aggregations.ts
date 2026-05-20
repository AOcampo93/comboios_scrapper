/**
 * One-shot multi-day backfill of the daily aggregator.
 *
 * The nightly aggregator only processes "yesterday". To populate segment_paths
 * + route_segments from the full GPS history at once (e.g. on first deploy of
 * the heatmap pipeline), this script iterates every distinct UTC date in
 * train_snapshots and calls runAggregations() for each, in order.
 *
 * Per-day errors are logged and skipped so a single bad day doesn't abort
 * the whole run.
 *
 * Idempotent: aggregator inserts are ON CONFLICT-guarded; segment_paths upserts
 * only overwrite when the new run traced more GPS points than the stored one.
 *
 * Usage (production, inside the running scraper container):
 *   docker exec <scraper-container> node dist/scripts/backfill-aggregations.js
 *
 * Usage (local dev, from repo root):
 *   DATABASE_URL=... npx tsx src/scripts/backfill-aggregations.ts
 */
import { pool, runMigrations } from "../db.js";
import { runAggregations } from "../aggregator.js";
import { log } from "../log.js";

async function main(): Promise<void> {
    await runMigrations();

    const { rows } = await pool.query<{ d: string }>(
        `SELECT DISTINCT (ts AT TIME ZONE 'UTC')::date::text AS d
         FROM train_snapshots
         ORDER BY d`,
    );

    log.info(
        { days: rows.length, first: rows[0]?.d, last: rows.at(-1)?.d },
        "backfill-all: plan",
    );

    let ok = 0;
    let fail = 0;
    for (const { d } of rows) {
        try {
            // 12:00 UTC anchor: lands on the same calendar date in any
            // local TZ the aggregator's localDateString() may use.
            await runAggregations(new Date(`${d}T12:00:00Z`));
            ok++;
        } catch (err) {
            log.error(
                { d, err: (err as Error).message },
                "backfill-all: day failed",
            );
            fail++;
        }
    }

    log.info({ ok, fail }, "backfill-all: complete");
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        log.fatal({ err: (err as Error).message }, "backfill-all: fatal");
        await pool.end().catch(() => {});
        process.exit(1);
    });
