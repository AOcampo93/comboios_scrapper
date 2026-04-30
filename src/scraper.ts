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

async function fetchVehicles(): Promise<Vehicle[]> {
    const url = `${config.upstreamBase}/vehicles`;
    let res: Response;
    try {
        res = await fetch(url, {
            headers: {
                "User-Agent": config.userAgent,
                Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        log.error({ err: (err as Error).message, url }, "upstream fetch failed");
        return [];
    }

    if (res.status === 429 || res.status === 503) {
        const retryAfter = Number.parseInt(
            res.headers.get("retry-after") ?? "60",
            10,
        );
        log.warn({ status: res.status, retryAfter }, "rate-limited; backing off");
        await sleep(retryAfter * 1000);
        return [];
    }

    if (!res.ok) {
        log.error({ status: res.status }, "upstream returned non-ok");
        return [];
    }

    const json = (await res.json()) as { vehicles?: Vehicle[] };
    return json.vehicles ?? [];
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
        },
        "scraper loop starting",
    );

    while (true) {
        try {
            if (!isOperatingHours()) {
                log.debug("outside operating hours; idling");
                await sleep(config.idleIntervalMs);
                continue;
            }

            const t0 = Date.now();
            const vehicles = await fetchVehicles();
            const inserted = await insertSnapshots(vehicles);
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
