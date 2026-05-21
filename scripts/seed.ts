/**
 * Synthetic seed data for development and PR-quality demos.
 *
 * Generates ~3 weeks of realistic dwell events, route segments and segment
 * geometry for EVERY train in CP's GTFS feed, each train following its real
 * station sequence. The frontend's heatmap is per-train — it filters history to
 * the selected train's GTFS trip — so seeding every train means whatever live
 * train you click on the map has data behind it.
 *
 * Each train gets a deterministic "punctuality personality" (derived from its
 * number) so reliability badges and heatmaps show varied colours.
 *
 * Re-runs append (timestamps differ each run); use `--clean` to reset first.
 *
 * Usage:
 *   npm run seed             # insert seed data
 *   npm run seed -- --clean  # delete every historical (run_date < today) row
 */
import { pool, runMigrations } from "../src/db.js";
import { importGtfs } from "../src/gtfs.js";
import { buildRailRouter, type LonLat } from "../src/scripts/railGeometry.js";

const SEED_DAYS = 21;

interface Station {
    code: string;
    lat: number;
    lon: number;
}

/** A distinct (from → to) station pair, kept so its geometry is built once. */
interface PairMeta {
    from: string;
    to: string;
    fromLonLat: LonLat;
    toLonLat: LonLat;
}

// ---------- math helpers ----------

function gauss(mean: number, std: number): number {
    // Box-Muller. Good enough for seed data.
    const u = 1 - Math.random();
    const v = Math.random();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Haversine distance in km between two lat/lon points. */
function distanceKm(a: Station, b: Station): number {
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const aa =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(aa));
}

/**
 * A stable speed character for a physical segment, ~0.55 (chronically slow) …
 * ~1.5 (fast stretch). Derived from the station pair so it's identical for every
 * train and every day — meaning it survives the per-pair averaging in
 * /api/heatmap/speed and gives the heatmap a real green/yellow/red spread.
 */
function pairSpeedFactor(a: string, b: string): number {
    const s = a < b ? a + b : b + a;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return 0.55 + ((Math.abs(h) % 1000) / 1000) * 0.95;
}

/** Deterministic punctuality personality derived from the train number. */
function personality(n: number): { baseDelay: number; delayStd: number; cancelProb: number } {
    return {
        baseDelay: 20 + ((n * 37) % 520), // ~20s … ~9min typical starting delay
        delayStd: 25 + ((n * 53) % 200),
        cancelProb: ((n * 17) % 45) / 1500, // 0 … 0.03 per day
    };
}

// ---------- GTFS lookups ----------

/** Every numeric train number present in the loaded GTFS feed. */
async function allGtfsTrainNumbers(): Promise<number[]> {
    const { rows } = await pool.query<{ trip_short_name: string }>(
        `SELECT DISTINCT trip_short_name FROM gtfs_trips
         WHERE trip_short_name ~ '^[0-9]+$'`,
    );
    return rows.map((r) => Number(r.trip_short_name)).sort((a, b) => a - b);
}

/** Real ordered station sequence for a train, from the loaded GTFS feed. */
async function stationsForTrain(trainNumber: number): Promise<Station[]> {
    const { rows } = await pool.query<{
        stop_id: string;
        stop_lat: number | null;
        stop_lon: number | null;
    }>(
        `
        SELECT s.stop_id, s.stop_lat, s.stop_lon
        FROM gtfs_stop_times st
        JOIN gtfs_stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = (
            SELECT trip_id FROM gtfs_trips
            WHERE trip_short_name = $1 ORDER BY trip_id LIMIT 1
        )
        ORDER BY st.stop_sequence
        `,
        [String(trainNumber)],
    );
    return rows
        .filter((r) => r.stop_lat != null && r.stop_lon != null)
        .map((r) => ({
            // live/seed station codes use a hyphen; GTFS stop_id uses an underscore
            code: r.stop_id.replace("_", "-"),
            lat: Number(r.stop_lat),
            lon: Number(r.stop_lon),
        }));
}

// ---------- batched insert ----------

type Row = (string | number | null)[];

/** Plain `($1,$2,…,$n)` placeholder builder for an n-column table. */
const plain = (n: number) => (offset: number) =>
    "(" + Array.from({ length: n }, (_, k) => `$${offset + k + 1}`).join(",") + ")";

async function batchInsert(
    table: string,
    columns: string[],
    rows: Row[],
    placeholderRow: (offset: number) => string,
    conflict: string,
): Promise<void> {
    if (rows.length === 0) return;
    const perRow = columns.length;
    const chunkSize = Math.max(1, Math.floor(60000 / perRow));
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = chunk.map((_, ri) => placeholderRow(ri * perRow)).join(",");
        await pool.query(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES ${values} ${conflict}`,
            chunk.flat(),
        );
    }
}

// ---------- generation ----------

/** Build all dwell + segment rows for one train across SEED_DAYS days. */
function generateTrain(
    trainNumber: number,
    stations: Station[],
    today: Date,
    pairsByKey: Map<string, PairMeta>,
): { dwellRows: Row[]; segRows: Row[]; cancelledDays: number } {
    const p = personality(trainNumber);
    // Trip starts somewhere between 06:00 and 21:00, deterministic per train.
    const startHour = 6 + ((trainNumber * 13) % 16);

    const dwellRows: Row[] = [];
    const segRows: Row[] = [];
    let cancelledDays = 0;

    for (let d = SEED_DAYS; d > 0; d--) {
        const date = new Date(today);
        date.setDate(today.getDate() - d);
        if (Math.random() < p.cancelProb) {
            cancelledDays++;
            continue;
        }

        const runDate = date.toISOString().slice(0, 10);
        const dayOfWeek = date.getDay();
        const start = new Date(date);
        start.setHours(startHour, 0, 0, 0);

        let sched = start.getTime(); // scheduled arrival at the current station
        let delay = Math.max(0, gauss(p.baseDelay, p.delayStd));

        const events: {
            st: Station;
            arrivedAt: Date;
            departedAt: Date;
            dwellSec: number;
            delay: number;
        }[] = [];

        for (let i = 0; i < stations.length; i++) {
            const st = stations[i];
            const arrivedAt = new Date(sched + delay * 1000);
            const dwellSec = Math.round(25 + Math.random() * 50); // 25–75s
            const departedAt = new Date(arrivedAt.getTime() + dwellSec * 1000);
            events.push({ st, arrivedAt, departedAt, dwellSec, delay: Math.round(delay) });

            if (i < stations.length - 1) {
                const next = stations[i + 1];
                const km = distanceKm(st, next);
                // Cruising speed = a distance baseline (long hops faster) scaled
                // by the segment's stable speed character, so the heatmap shows
                // a real green / yellow / red spread instead of one flat colour.
                const factor = pairSpeedFactor(st.code, next.code);
                const nominalKmh = Math.min(
                    130,
                    Math.max(
                        20,
                        (34 + Math.min(km, 45) * 1.45) * factor + gauss(0, 8),
                    ),
                );
                const travelSec = (km / nominalKmh) * 3600;
                // Advance the SCHEDULED clock. Delay shifts arrival times but
                // not segment travel time — only the change in delay does — so
                // avg speed stays realistic instead of being dragged to zero.
                sched += (dwellSec + travelSec) * 1000;
                delay = Math.max(0, delay + gauss(0, 30));
            }
        }

        for (const e of events) {
            dwellRows.push([
                trainNumber,
                runDate,
                e.st.code,
                e.arrivedAt.toISOString(),
                e.departedAt.toISOString(),
                e.dwellSec,
                e.delay,
            ]);
        }

        for (let i = 1; i < events.length; i++) {
            const prev = events[i - 1];
            const curr = events[i];
            if (prev.st.code === curr.st.code) continue;
            const travelSec = Math.round(
                (curr.arrivedAt.getTime() - prev.departedAt.getTime()) / 1000,
            );
            const km = distanceKm(prev.st, curr.st);
            const avg = travelSec > 0 ? (km / travelSec) * 3600 : 0;
            segRows.push([
                trainNumber,
                runDate,
                prev.st.code,
                curr.st.code,
                prev.departedAt.toISOString(),
                curr.arrivedAt.toISOString(),
                travelSec,
                km,
                avg,
                dayOfWeek,
            ]);

            // Record each distinct pair once; geometry is traced after the loop.
            const key = `${prev.st.code}|${curr.st.code}`;
            if (!pairsByKey.has(key)) {
                pairsByKey.set(key, {
                    from: prev.st.code,
                    to: curr.st.code,
                    fromLonLat: [prev.st.lon, prev.st.lat],
                    toLonLat: [curr.st.lon, curr.st.lat],
                });
            }
        }
    }

    return { dwellRows, segRows, cancelledDays };
}

// ---------- entry points ----------

async function seed(): Promise<void> {
    await runMigrations();
    await importGtfs();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const trains = await allGtfsTrainNumbers();
    console.log(
        JSON.stringify({ msg: "seeding all GTFS trains", trains: trains.length, days: SEED_DAYS }),
    );

    const pairsByKey = new Map<string, PairMeta>();
    let totalDwell = 0;
    let totalSegs = 0;
    let cancelledDays = 0;
    let seeded = 0;

    for (const train of trains) {
        const stations = await stationsForTrain(train);
        if (stations.length < 2) continue;

        const r = generateTrain(train, stations, today, pairsByKey);
        await batchInsert(
            "station_dwell_events",
            [
                "train_number",
                "run_date",
                "station_code",
                "arrived_at",
                "departed_at",
                "dwell_seconds",
                "delay_at_arrival_seconds",
            ],
            r.dwellRows,
            plain(7),
            "ON CONFLICT (train_number, run_date, station_code, arrived_at) DO NOTHING",
        );
        await batchInsert(
            "route_segments",
            [
                "train_number",
                "run_date",
                "from_station",
                "to_station",
                "departed_at",
                "arrived_at",
                "travel_seconds",
                "distance_km",
                "avg_speed_kmh",
                "day_of_week",
            ],
            r.segRows,
            plain(10),
            "ON CONFLICT (train_number, run_date, from_station, to_station, departed_at) DO NOTHING",
        );

        totalDwell += r.dwellRows.length;
        totalSegs += r.segRows.length;
        cancelledDays += r.cancelledDays;
        seeded++;
        if (seeded % 250 === 0) {
            console.log(JSON.stringify({ msg: "progress", trainsSeeded: seeded }));
        }
    }

    // Trace each distinct segment along the real OSM rail network. Falls back to
    // a straight line per pair if OSM is unavailable or a pair isn't routable.
    console.log(JSON.stringify({ msg: "loading rail network from OSM" }));
    const router = await buildRailRouter();
    let railRouted = 0;
    const pathRows: Row[] = [];
    for (const m of pairsByKey.values()) {
        let coords = router?.route(m.fromLonLat, m.toLonLat) ?? null;
        if (coords && coords.length >= 2) {
            railRouted++;
        } else {
            coords = [m.fromLonLat, m.toLonLat]; // straight-line fallback
        }
        const wkt =
            "SRID=4326;LINESTRING(" +
            coords.map((c) => `${c[0]} ${c[1]}`).join(",") +
            ")";
        pathRows.push([m.from, m.to, wkt, coords.length, new Date().toISOString()]);
    }
    console.log(
        JSON.stringify({
            msg: "segment geometry built",
            pairs: pathRows.length,
            railRouted,
        }),
    );
    await batchInsert(
        "segment_paths",
        ["from_station", "to_station", "geometry", "point_count", "updated_at"],
        pathRows,
        (o) => `($${o + 1},$${o + 2},$${o + 3}::geography,$${o + 4},$${o + 5})`,
        "ON CONFLICT (from_station, to_station) DO NOTHING",
    );

    console.log(
        JSON.stringify({
            msg: "seed complete",
            trainsSeeded: seeded,
            dwell: totalDwell,
            segs: totalSegs,
            paths: pathRows.length,
            cancelledDays,
        }),
    );
}

async function clean(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    // The seed only ever writes run_date < today, so this removes seed data
    // without needing the train list. segment_paths has no run_date — wipe it
    // wholesale (it's seed/aggregator-derived; real deploys rebuild it nightly).
    const r1 = await pool.query(
        `DELETE FROM station_dwell_events WHERE run_date < $1::date`,
        [today],
    );
    const r2 = await pool.query(
        `DELETE FROM route_segments WHERE run_date < $1::date`,
        [today],
    );
    const r3 = await pool.query(`DELETE FROM segment_paths`);
    console.log(
        JSON.stringify({
            msg: "cleanup complete",
            dwellRemoved: r1.rowCount ?? 0,
            segsRemoved: r2.rowCount ?? 0,
            pathsRemoved: r3.rowCount ?? 0,
        }),
    );
}

const args = process.argv.slice(2);
const mode = args.includes("--clean") ? clean : seed;

mode()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error("seed/clean failed:", err);
        await pool.end().catch(() => {});
        process.exit(1);
    });
