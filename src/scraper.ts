import { config } from "./config.js";
import { log } from "./log.js";
import { pool } from "./db.js";
import { isOperatingHours } from "./schedule.js";

type Vehicle = {
    trainNumber: number;
    runDate: string;
    delay: number;
    speed?: number;
    latitude: string;
    longitude: string;
    status: string;
    lastStation?: string;
    timestamp?: string | number;
    gtfs?: {
        tripId?: string | null;
        stopId?: string | null;
        stopSequence?: number | null;
    };
};

const lastByTrain = new Map<number, string>();

function tupleHash(v: Vehicle): string {
    return [
        v.latitude,
        v.longitude,
        v.delay,
        v.status,
        v.speed ?? "",
        v.gtfs?.stopId ?? "",
    ].join("|");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Bound a promise that might never settle. This does NOT cancel the underlying
 * work — it just lets the caller move on, which is the whole point: a wedged
 * await must never be able to stop the next tick.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${label} exceeded ${ms}ms`)),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e as Error);
            },
        );
    });
}

async function fetchVehicles(): Promise<Vehicle[]> {
    const url = `${config.upstreamBase}/vehicles`;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": config.userAgent,
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
        });

        if (res.status === 429 || res.status === 503) {
            const parsed = Number.parseInt(
                res.headers.get("retry-after") ?? "60",
                10,
            );
            // A missing/garbage header must not turn into sleep(NaN) (fires
            // immediately, hammering upstream) nor an absurd multi-hour stall.
            const retryAfter = Number.isFinite(parsed)
                ? Math.min(Math.max(parsed, 1), 300)
                : 60;
            log.warn({ status: res.status, retryAfter }, "rate-limited; backing off");
            await sleep(retryAfter * 1000);
            return [];
        }

        if (!res.ok) {
            log.error({ status: res.status }, "upstream returned non-ok");
            return [];
        }

        // The body read MUST stay inside this try. AbortSignal.timeout firing
        // mid-stream rejects here, not at the fetch above — letting that escape
        // is what wedged the poller for 66 days from 2026-05-29.
        const json = (await res.json()) as { vehicles?: Vehicle[] };
        return json.vehicles ?? [];
    } catch (err) {
        log.error({ err: (err as Error).message, url }, "upstream fetch failed");
        return [];
    }
}

async function insertSnapshots(vehicles: Vehicle[]): Promise<number> {
    if (vehicles.length === 0) return 0;

    const seenNow = new Set<number>();
    const rows: (string | number | null)[][] = [];

    for (const v of vehicles) {
        const lon = Number.parseFloat(v.longitude);
        const lat = Number.parseFloat(v.latitude);
        if (Number.isNaN(lon) || Number.isNaN(lat)) continue;

        seenNow.add(v.trainNumber);

        const h = tupleHash(v);
        if (lastByTrain.get(v.trainNumber) === h) continue;
        lastByTrain.set(v.trainNumber, h);

        const ts = v.timestamp
            ? new Date(Number(v.timestamp))
            : new Date();

        rows.push([
            ts.toISOString(),
            v.trainNumber,
            v.runDate,
            v.status,
            v.delay,
            v.speed != null ? Math.round(v.speed * 10) : null,
            `SRID=4326;POINT(${lon} ${lat})`,
            v.lastStation ?? null,
            v.gtfs?.stopId ?? null,
            v.gtfs?.stopSequence ?? null,
            v.gtfs?.tripId ?? null,
        ]);
    }

    // Forget trains that disappeared (cancelled, completed, etc.) so memory stays bounded.
    for (const tn of lastByTrain.keys()) {
        if (!seenNow.has(tn)) lastByTrain.delete(tn);
    }

    if (rows.length === 0) return 0;

    const cols = 11;
    const placeholders = rows
        .map((_, i) => {
            const o = i * cols;
            return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
        })
        .join(",");

    const sql = `
        INSERT INTO train_snapshots (
            ts, train_number, run_date, status, delay_seconds, speed_decikmh,
            position, last_station, next_station, stop_sequence, trip_id
        ) VALUES ${placeholders}
    `;

    await pool.query(sql, rows.flat());
    return rows.length;
}

export async function startScraper(): Promise<never> {
    log.info(
        {
            upstream: config.upstreamBase,
            poll: config.pollIntervalMs,
            idle: config.idleIntervalMs,
            tickTimeout: config.tickTimeoutMs,
            watchdogStall: config.watchdogStallMs,
        },
        "scraper loop starting",
    );

    // Liveness backstop. index.ts starts the aggregator and GTFS loops with
    // `void`, so their timers keep the process (and the container) alive even
    // when this loop is dead — which is exactly how the 2026-05-29 hang went
    // unnoticed for 66 days. Nothing recovers a wedged loop except a restart,
    // so exit non-zero and let the container's restart policy do it.
    let lastLoopAt = Date.now();
    // Deliberately NOT unref'd: this timer must be able to hold the process up
    // on its own, so a stall always ends in a fatal log + exit(1) rather than a
    // silent exit(0) that leaves no trace of why ingestion stopped.
    setInterval(() => {
        const stalledMs = Date.now() - lastLoopAt;
        if (stalledMs > config.watchdogStallMs) {
            log.fatal(
                { stalledMs, limit: config.watchdogStallMs },
                "poller loop stalled; exiting so the container restarts",
            );
            process.exit(1);
        }
    }, Math.min(60_000, config.watchdogStallMs / 2));

    while (true) {
        // Advances on every iteration, idle ones included: what we're detecting
        // is a loop that stopped turning, not an absence of trains.
        lastLoopAt = Date.now();
        try {
            if (!isOperatingHours()) {
                log.debug("outside operating hours; idling");
                await sleep(config.idleIntervalMs);
                continue;
            }

            const t0 = Date.now();
            const vehicles = await withTimeout(
                fetchVehicles(),
                config.tickTimeoutMs,
                "fetchVehicles",
            );
            const inserted = await withTimeout(
                insertSnapshots(vehicles),
                config.tickTimeoutMs,
                "insertSnapshots",
            );
            log.info(
                { fetched: vehicles.length, inserted, ms: Date.now() - t0 },
                "tick",
            );
        } catch (err) {
            log.error({ err: (err as Error).message }, "tick failed");
        }
        await sleep(config.pollIntervalMs);
    }
}
