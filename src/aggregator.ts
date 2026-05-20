import { pool } from "./db.js";
import { log } from "./log.js";

/**
 * Daily batch job that materializes train_snapshots into permanent aggregate tables.
 * Idempotent: re-runs over the same date are safe due to UNIQUE constraints + ON CONFLICT.
 *
 * Two passes:
 *   1. station_dwell_events — when did each train arrive/leave each station, and was
 *      that dwell longer than scheduled?
 *   2. route_segments — for each consecutive station pair, how long did the train take
 *      and what GPS-tracked distance did it cover?
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function localDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/**
 * Detect station entry/exit moments from raw snapshots and write one event per visit.
 *
 * Algorithm: walk all snapshots for the day grouped by train, in time order.
 * - When status enters AT_STATION/AT_ORIGIN with a new last_station → arrived_at = ts
 * - When status leaves AT_STATION/AT_ORIGIN (or last_station changes) → departed_at = ts
 */
async function aggregateDwellEvents(runDate: string): Promise<number> {
    const { rows } = await pool.query<{
        train_number: number;
        run_date: string;
        ts: string;
        status: string;
        last_station: string | null;
        delay_seconds: number | null;
    }>(
        `
        SELECT train_number, run_date, ts, status, last_station, delay_seconds
        FROM train_snapshots
        WHERE run_date = $1::date
        ORDER BY train_number, ts ASC
        `,
        [runDate],
    );

    type Open = {
        train_number: number;
        run_date: string;
        station_code: string;
        arrived_at: string;
        delay_at_arrival: number | null;
    };

    const events: Array<Open & { departed_at: string }> = [];
    let open: Open | null = null;
    let currentTrain = -1;

    const closeOpen = (departed_at: string) => {
        if (open) {
            events.push({ ...open, departed_at });
            open = null;
        }
    };

    for (const r of rows) {
        if (r.train_number !== currentTrain) {
            closeOpen(r.ts);
            currentTrain = r.train_number;
        }

        const atStation = r.status === "AT_STATION" || r.status === "AT_ORIGIN";

        if (atStation && r.last_station) {
            if (!open || open.station_code !== r.last_station) {
                if (open) closeOpen(r.ts);
                open = {
                    train_number: r.train_number,
                    run_date: r.run_date,
                    station_code: r.last_station,
                    arrived_at: r.ts,
                    delay_at_arrival: r.delay_seconds,
                };
            }
        } else {
            if (open) closeOpen(r.ts);
        }
    }
    closeOpen(rows.at(-1)?.ts ?? new Date().toISOString());

    if (events.length === 0) return 0;

    let inserted = 0;
    for (const e of events) {
        const res = await pool.query(
            `
            INSERT INTO station_dwell_events
                (train_number, run_date, station_code, arrived_at, departed_at,
                 dwell_seconds, delay_at_arrival_seconds)
            VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz,
                    EXTRACT(EPOCH FROM ($5::timestamptz - $4::timestamptz))::int,
                    $6)
            ON CONFLICT (train_number, run_date, station_code, arrived_at) DO NOTHING
            `,
            [
                e.train_number,
                e.run_date,
                e.station_code,
                e.arrived_at,
                e.departed_at,
                e.delay_at_arrival,
            ],
        );
        inserted += res.rowCount ?? 0;
    }
    return inserted;
}

/**
 * Build (from_station → to_station) segments from consecutive dwell events of the same
 * train. Distance is summed from intermediate snapshot positions for accuracy.
 */
async function aggregateRouteSegments(runDate: string): Promise<number> {
    const { rows: events } = await pool.query<{
        train_number: number;
        run_date: string;
        station_code: string;
        arrived_at: string;
        departed_at: string;
    }>(
        `
        SELECT train_number, run_date, station_code, arrived_at, departed_at
        FROM station_dwell_events
        WHERE run_date = $1::date AND departed_at IS NOT NULL
        ORDER BY train_number, arrived_at ASC
        `,
        [runDate],
    );

    if (events.length === 0) return 0;

    let inserted = 0;
    for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        if (prev.train_number !== curr.train_number) continue;
        if (prev.station_code === curr.station_code) continue;

        const departed_at = prev.departed_at;
        const arrived_at = curr.arrived_at;

        // Walk the GPS positions between the two timestamps: sum the distance and,
        // in the same pass, stitch them into a polyline for segment_paths (used by
        // the speed heatmap). LAG runs in the CTE; SUM and ST_MakeLine aggregate it.
        const { rows: geo } = await pool.query<{
            km: number | null;
            point_count: number | null;
            line_ewkt: string | null;
        }>(
            `
            WITH pts AS (
                SELECT ts,
                       position::geometry AS g,
                       LAG(position::geometry) OVER (ORDER BY ts) AS prev_g
                FROM train_snapshots
                WHERE train_number = $1
                  AND ts BETWEEN $2::timestamptz AND $3::timestamptz
            )
            SELECT
                COALESCE(SUM(ST_DistanceSphere(g, prev_g)) / 1000.0, 0)::float AS km,
                COUNT(g)::int                                                  AS point_count,
                ST_AsEWKT(ST_MakeLine(g ORDER BY ts))                          AS line_ewkt
            FROM pts
            `,
            [curr.train_number, departed_at, arrived_at],
        );

        const distanceKm = geo[0]?.km ?? 0;
        const pointCount = geo[0]?.point_count ?? 0;
        const lineEwkt = geo[0]?.line_ewkt ?? null;
        const travelSeconds =
            (new Date(arrived_at).getTime() - new Date(departed_at).getTime()) /
            1000;
        const avgSpeedKmh =
            travelSeconds > 0 ? (distanceKm / travelSeconds) * 3600 : 0;
        const dayOfWeek = new Date(curr.run_date).getDay(); // 0 = Sunday

        const res = await pool.query(
            `
            INSERT INTO route_segments
                (train_number, run_date, from_station, to_station, departed_at, arrived_at,
                 travel_seconds, distance_km, avg_speed_kmh, day_of_week)
            VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10)
            ON CONFLICT (train_number, run_date, from_station, to_station, departed_at)
            DO NOTHING
            `,
            [
                curr.train_number,
                curr.run_date,
                prev.station_code,
                curr.station_code,
                departed_at,
                arrived_at,
                Math.round(travelSeconds),
                distanceKm,
                avgSpeedKmh,
                dayOfWeek,
            ],
        );
        inserted += res.rowCount ?? 0;

        // Upsert the canonical polyline for this station pair, keeping whichever
        // run traced it with the most GPS points. ST_MakeLine yields a LINESTRING
        // only with >= 2 points — degenerate runs are skipped.
        if (lineEwkt && pointCount >= 2 && lineEwkt.includes("LINESTRING")) {
            await pool.query(
                `
                INSERT INTO segment_paths
                    (from_station, to_station, geometry, point_count, updated_at)
                VALUES ($1, $2, $3::geography, $4, NOW())
                ON CONFLICT (from_station, to_station) DO UPDATE
                    SET geometry    = EXCLUDED.geometry,
                        point_count = EXCLUDED.point_count,
                        updated_at  = NOW()
                    WHERE EXCLUDED.point_count >= segment_paths.point_count
                `,
                [prev.station_code, curr.station_code, lineEwkt, pointCount],
            );
        }
    }
    return inserted;
}

/**
 * Fill scheduled_dwell_seconds / excess_seconds on the day's dwell events by
 * joining the GTFS timetable. Train number -> trip via trip_short_name; live
 * station codes ("94-NNNNN") -> GTFS stop_id ("94_NNNNN") via REPLACE.
 * Only touches rows still NULL, so it's safe to re-run.
 */
async function populateScheduledDwell(runDate: string): Promise<number> {
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
        WHERE sde.run_date = $1::date
          AND sde.scheduled_dwell_seconds IS NULL
          AND sde.dwell_seconds IS NOT NULL
          AND sde.train_number = g.train_number
          AND REPLACE(sde.station_code, '-', '_') = g.stop_id
          AND g.sched IS NOT NULL
        `,
        [runDate],
    );
    return res.rowCount ?? 0;
}

export async function runAggregations(targetDate: Date): Promise<void> {
    const runDate = localDateString(targetDate);
    const t0 = Date.now();
    log.info({ runDate }, "aggregation: begin");

    const dwell = await aggregateDwellEvents(runDate);
    log.info({ runDate, inserted: dwell }, "aggregation: dwell events done");

    const segments = await aggregateRouteSegments(runDate);
    log.info({ runDate, inserted: segments }, "aggregation: route segments done");

    const scheduled = await populateScheduledDwell(runDate);
    log.info({ runDate, updated: scheduled }, "aggregation: scheduled dwell done");

    log.info(
        { runDate, dwell, segments, scheduled, ms: Date.now() - t0 },
        "aggregation: complete",
    );
}

function msUntilNext3AM(): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}

export async function startAggregator(): Promise<never> {
    log.info("aggregator loop starting (daily 03:00 local)");
    while (true) {
        const ms = msUntilNext3AM();
        log.info({ wakeInHours: (ms / 3600_000).toFixed(2) }, "aggregator: sleeping");
        await sleep(ms);
        try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            await runAggregations(yesterday);
        } catch (err) {
            log.error(
                { err: (err as Error).message },
                "aggregator run failed; will retry tomorrow",
            );
        }
    }
}
