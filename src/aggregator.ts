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

        // Compute distance from GPS positions between the two timestamps.
        const { rows: dist } = await pool.query<{ km: number | null }>(
            `
            WITH path AS (
                SELECT position,
                       LAG(position) OVER (ORDER BY ts) AS prev_position
                FROM train_snapshots
                WHERE train_number = $1
                  AND ts BETWEEN $2::timestamptz AND $3::timestamptz
                ORDER BY ts ASC
            )
            SELECT COALESCE(
                SUM(ST_DistanceSphere(position::geometry, prev_position::geometry)) / 1000.0,
                0
            )::float AS km
            FROM path
            WHERE prev_position IS NOT NULL
            `,
            [curr.train_number, departed_at, arrived_at],
        );

        const distanceKm = dist[0]?.km ?? 0;
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
    }
    return inserted;
}

export async function runAggregations(targetDate: Date): Promise<void> {
    const runDate = localDateString(targetDate);
    const t0 = Date.now();
    log.info({ runDate }, "aggregation: begin");

    const dwell = await aggregateDwellEvents(runDate);
    log.info({ runDate, inserted: dwell }, "aggregation: dwell events done");

    const segments = await aggregateRouteSegments(runDate);
    log.info({ runDate, inserted: segments }, "aggregation: route segments done");

    log.info(
        { runDate, dwell, segments, ms: Date.now() - t0 },
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
