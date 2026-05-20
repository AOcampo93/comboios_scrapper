/**
 * One-shot OSM geometry seeder for production.
 *
 * The aggregator used to build `segment_paths.geometry` from raw GPS pings,
 * which is wrong by design: the rail network is static and OSM already has it
 * traced. Sparse GPS reporting produced straight-chord artefacts that needed
 * elaborate heuristics in the heatmap endpoint to hide.
 *
 * This script rebuilds `segment_paths` from OSM truth:
 *   1. enumerates every consecutive (stop, next stop) pair across all GTFS trips
 *   2. routes each through Portugal's OSM rail graph
 *   3. upserts with a huge point_count so the aggregator's
 *      "WHERE EXCLUDED.point_count >= …" guard can never overwrite OSM with GPS
 *   4. deletes orphan rows — pairs that aren't consecutive in any GTFS trip
 *      (these came from express services skipping intermediate stations and
 *      now exist only as long straight diagonals)
 *
 * Run once after deploying the aggregator change that stops writing geometry.
 * Subsequent GTFS feed refreshes can re-run it cheaply (OSM data is cached on
 * disk by railGeometry.ts).
 *
 * Usage:
 *   Dev:   npm run seed:osm-geometry
 *   Prod:  docker exec <scraper-container> node dist/scripts/seed-osm-geometry.js
 */
import { pool, runMigrations } from "../db.js";
import { importGtfs } from "../gtfs.js";
import { buildRailRouter, type LonLat } from "./railGeometry.js";

interface Pair {
    from: string;
    to: string;
    fromLonLat: LonLat;
    toLonLat: LonLat;
}

/** Every directed (stop, next stop) pair across every GTFS trip. */
async function gtfsConsecutivePairs(): Promise<Pair[]> {
    const { rows } = await pool.query<{
        from_code: string;
        to_code: string;
        from_lat: number;
        from_lon: number;
        to_lat: number;
        to_lon: number;
    }>(`
        SELECT DISTINCT
            REPLACE(st1.stop_id, '_', '-') AS from_code,
            REPLACE(st2.stop_id, '_', '-') AS to_code,
            s1.stop_lat::float AS from_lat,
            s1.stop_lon::float AS from_lon,
            s2.stop_lat::float AS to_lat,
            s2.stop_lon::float AS to_lon
        FROM gtfs_stop_times st1
        JOIN gtfs_stop_times st2
          ON st1.trip_id = st2.trip_id
         AND st2.stop_sequence = st1.stop_sequence + 1
        JOIN gtfs_stops s1 ON s1.stop_id = st1.stop_id
        JOIN gtfs_stops s2 ON s2.stop_id = st2.stop_id
        WHERE s1.stop_lat IS NOT NULL
          AND s1.stop_lon IS NOT NULL
          AND s2.stop_lat IS NOT NULL
          AND s2.stop_lon IS NOT NULL
    `);
    return rows.map((r) => ({
        from: r.from_code,
        to: r.to_code,
        fromLonLat: [Number(r.from_lon), Number(r.from_lat)],
        toLonLat: [Number(r.to_lon), Number(r.to_lat)],
    }));
}

async function main(): Promise<void> {
    await runMigrations();
    await importGtfs();

    const pairs = await gtfsConsecutivePairs();
    console.log(
        JSON.stringify({ msg: "gtfs consecutive pairs", count: pairs.length }),
    );

    console.log(JSON.stringify({ msg: "loading rail network from OSM" }));
    const router = await buildRailRouter();
    if (!router) {
        console.error(
            JSON.stringify({
                msg: "OSM router unavailable — aborting; segment_paths untouched",
            }),
        );
        process.exit(1);
    }

    // point_count starts at 100_000 so OSM-routed paths beat any GPS-derived
    // upsert from the aggregator (whose paths typically have 5–200 points).
    // The aggregator change in this rollout stops writing geometry anyway,
    // but the high count is a belt-and-suspenders guard.
    const HIGH_POINT_BASE = 100_000;

    let routed = 0;
    let upserted = 0;
    for (const p of pairs) {
        let coords = router.route(p.fromLonLat, p.toLonLat);
        if (coords && coords.length >= 2) {
            routed++;
        } else {
            coords = [p.fromLonLat, p.toLonLat]; // straight-line fallback
        }
        const wkt =
            "SRID=4326;LINESTRING(" +
            coords.map((c) => `${c[0]} ${c[1]}`).join(",") +
            ")";
        await pool.query(
            `
            INSERT INTO segment_paths
                (from_station, to_station, geometry, point_count, updated_at)
            VALUES ($1, $2, $3::geography, $4, NOW())
            ON CONFLICT (from_station, to_station) DO UPDATE
                SET geometry    = EXCLUDED.geometry,
                    point_count = EXCLUDED.point_count,
                    updated_at  = NOW()
            `,
            [p.from, p.to, wkt, HIGH_POINT_BASE + coords.length],
        );
        upserted++;
        if (upserted % 250 === 0) {
            console.log(
                JSON.stringify({ msg: "progress", upserted, routed }),
            );
        }
    }

    // Drop orphan rows: any (from, to) in segment_paths that isn't a
    // consecutive GTFS pair. These were created by the aggregator when an
    // express service skipped intermediate stations — the resulting pair has
    // no real rail segment between them, so it draws as a long diagonal.
    const validKeys = new Set(pairs.map((p) => `${p.from}|${p.to}`));
    const { rows: existing } = await pool.query<{
        from_station: string;
        to_station: string;
    }>(`SELECT from_station, to_station FROM segment_paths`);
    const orphans = existing.filter(
        (r) => !validKeys.has(`${r.from_station}|${r.to_station}`),
    );
    if (orphans.length > 0) {
        // Pair-tuple delete via a VALUES list — works for any orphan count.
        const placeholders = orphans
            .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
            .join(",");
        await pool.query(
            `
            DELETE FROM segment_paths
            WHERE (from_station, to_station) IN (${placeholders})
            `,
            orphans.flatMap((o) => [o.from_station, o.to_station]),
        );
    }

    console.log(
        JSON.stringify({
            msg: "seed-osm-geometry complete",
            gtfsPairs: pairs.length,
            routedViaOsm: routed,
            straightFallback: pairs.length - routed,
            upserted,
            orphansDeleted: orphans.length,
        }),
    );

    await pool.end();
}

main().catch((err) => {
    console.error(JSON.stringify({ msg: "fatal", err: String(err) }));
    process.exit(1);
});
