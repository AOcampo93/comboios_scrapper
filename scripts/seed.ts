/**
 * Synthetic seed data for development and PR-quality demos.
 *
 * Generates 30 days of realistic dwell events + route segments for a handful of
 * real CP train numbers, each with a distinct "punctuality personality" so the
 * reliability badges and future heatmaps show varied colors immediately.
 *
 * Insertion uses ON CONFLICT DO NOTHING so re-runs are idempotent. All seeded
 * rows have run_date strictly before today, so once real data accumulates for
 * 30 days the synthetic rows fall out of the reliability query window naturally.
 *
 * Usage:
 *   npm run seed             # insert seed data
 *   npm run seed -- --clean  # delete all rows with run_date before today
 */
import { pool, runMigrations } from "../src/db.js";

interface TrainProfile {
    number: number;
    line: string;
    /** Mean delay in seconds at the start of the trip. */
    baseDelay: number;
    /** Standard deviation of delay across runs. */
    delayStd: number;
    /** Probability of cancellation per day (0..1). */
    cancelProb: number;
    /** Stations the train serves, in order. */
    stations: Array<{ code: string; lat: number; lon: number; designation: string }>;
}

// Real station coords sampled from CP (Linha do Norte + Cascais snippets).
const STATIONS = {
    PORTO: { code: "94-2006", lat: 41.1487, lon: -8.5848, designation: "Porto Campanhã" },
    GAIA: { code: "94-39164", lat: 41.1297, lon: -8.6204, designation: "Vila Nova de Gaia - Devesas" },
    ESPINHO: { code: "94-39008", lat: 41.0065, lon: -8.6443, designation: "Espinho" },
    OVAR: { code: "94-38299", lat: 40.864, lon: -8.6166, designation: "Ovar" },
    AVEIRO: { code: "94-38000", lat: 40.6434, lon: -8.6407, designation: "Aveiro" },
    COIMBRA_B: { code: "94-36004", lat: 40.2079, lon: -8.4569, designation: "Coimbra-B" },
    ENTRONCAMENTO: { code: "94-34009", lat: 39.4644, lon: -8.4747, designation: "Entroncamento" },
    SANTAREM: { code: "94-32185", lat: 39.2349, lon: -8.685, designation: "Santarém" },
    ORIENTE: { code: "94-31278", lat: 38.7686, lon: -9.0939, designation: "Lisboa Oriente" },
    LISBOA_SA: { code: "94-30007", lat: 38.7167, lon: -9.1167, designation: "Lisboa Santa Apolónia" },
} as const;

const PROFILES: TrainProfile[] = [
    {
        number: 528, line: "Norte", baseDelay: 90, delayStd: 60, cancelProb: 0.02,
        stations: [STATIONS.PORTO, STATIONS.GAIA, STATIONS.ESPINHO, STATIONS.OVAR, STATIONS.AVEIRO, STATIONS.COIMBRA_B, STATIONS.ENTRONCAMENTO, STATIONS.LISBOA_SA],
    },
    {
        number: 529, line: "Norte", baseDelay: 480, delayStd: 180, cancelProb: 0.05,
        stations: [STATIONS.LISBOA_SA, STATIONS.ENTRONCAMENTO, STATIONS.COIMBRA_B, STATIONS.AVEIRO, STATIONS.OVAR, STATIONS.ESPINHO, STATIONS.GAIA, STATIONS.PORTO],
    },
    {
        number: 4401, line: "Cintura", baseDelay: 30, delayStd: 30, cancelProb: 0.01,
        stations: [STATIONS.LISBOA_SA, STATIONS.ORIENTE, STATIONS.SANTAREM, STATIONS.ENTRONCAMENTO],
    },
    {
        number: 4437, line: "Cintura", baseDelay: 180, delayStd: 90, cancelProb: 0.03,
        stations: [STATIONS.LISBOA_SA, STATIONS.ORIENTE, STATIONS.SANTAREM, STATIONS.ENTRONCAMENTO],
    },
    {
        number: 3401, line: "Norte", baseDelay: 120, delayStd: 240, cancelProb: 0.04,
        stations: [STATIONS.ENTRONCAMENTO, STATIONS.COIMBRA_B, STATIONS.AVEIRO, STATIONS.OVAR, STATIONS.ESPINHO, STATIONS.PORTO],
    },
];

// ---------- math helpers ----------

function gauss(mean: number, std: number): number {
    // Box-Muller. Good enough for seed data.
    const u = 1 - Math.random();
    const v = Math.random();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Haversine distance in km between two lat/lon points. */
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const aa =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(aa));
}

// ---------- seed logic ----------

async function seedDay(date: Date, profile: TrainProfile): Promise<{ dwell: number; segs: number; cancelled: boolean }> {
    if (Math.random() < profile.cancelProb) {
        return { dwell: 0, segs: 0, cancelled: true };
    }

    const runDate = date.toISOString().slice(0, 10);
    const dayOfWeek = date.getDay();

    // Trip starts somewhere between 06:00 and 21:00 deterministically per train.
    const startHour = 6 + ((profile.number * 13) % 16);
    let cursor = new Date(date);
    cursor.setHours(startHour, 0, 0, 0);

    let currentDelay = Math.max(0, gauss(profile.baseDelay, profile.delayStd));

    type Event = {
        station_code: string;
        arrived_at: Date;
        departed_at: Date;
        delay_at_arrival: number;
        from_lat: number;
        from_lon: number;
        to_lat: number;
        to_lon: number;
    };
    const events: Event[] = [];

    for (let i = 0; i < profile.stations.length; i++) {
        const station = profile.stations[i];
        const arrivedAt = new Date(cursor.getTime() + currentDelay * 1000);
        const dwellSec = 25 + Math.random() * 50; // 25–75s
        const departedAt = new Date(arrivedAt.getTime() + dwellSec * 1000);

        events.push({
            station_code: station.code,
            arrived_at: arrivedAt,
            departed_at: departedAt,
            delay_at_arrival: Math.round(currentDelay),
            from_lat: i === 0 ? station.lat : profile.stations[i - 1].lat,
            from_lon: i === 0 ? station.lon : profile.stations[i - 1].lon,
            to_lat: station.lat,
            to_lon: station.lon,
        });

        // Travel time to next station: ~1.2 min/km at 50 km/h average. Add small drift.
        if (i < profile.stations.length - 1) {
            const next = profile.stations[i + 1];
            const km = distanceKm(station, next);
            const travelSec = (km / 50) * 3600;
            cursor = new Date(departedAt.getTime() + travelSec * 1000);
            currentDelay = Math.max(0, currentDelay + gauss(0, 30));
        }
    }

    // Insert dwell events.
    let dwellInserted = 0;
    for (const e of events) {
        const res = await pool.query(
            `
            INSERT INTO station_dwell_events
                (train_number, run_date, station_code, arrived_at, departed_at,
                 dwell_seconds, delay_at_arrival_seconds)
            VALUES ($1, $2, $3, $4, $5,
                    EXTRACT(EPOCH FROM ($5::timestamptz - $4::timestamptz))::int, $6)
            ON CONFLICT (train_number, run_date, station_code, arrived_at) DO NOTHING
            `,
            [
                profile.number,
                runDate,
                e.station_code,
                e.arrived_at.toISOString(),
                e.departed_at.toISOString(),
                e.delay_at_arrival,
            ],
        );
        dwellInserted += res.rowCount ?? 0;
    }

    // Insert route segments between consecutive events.
    let segsInserted = 0;
    for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        const departed_at = prev.departed_at;
        const arrived_at = curr.arrived_at;
        const travelSec = (arrived_at.getTime() - departed_at.getTime()) / 1000;
        const km = distanceKm(
            { lat: prev.to_lat, lon: prev.to_lon },
            { lat: curr.to_lat, lon: curr.to_lon },
        );
        const avg = travelSec > 0 ? (km / travelSec) * 3600 : 0;
        const res = await pool.query(
            `
            INSERT INTO route_segments
                (train_number, run_date, from_station, to_station, departed_at, arrived_at,
                 travel_seconds, distance_km, avg_speed_kmh, day_of_week)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (train_number, run_date, from_station, to_station, departed_at)
            DO NOTHING
            `,
            [
                profile.number,
                runDate,
                prev.station_code,
                curr.station_code,
                departed_at.toISOString(),
                arrived_at.toISOString(),
                Math.round(travelSec),
                km,
                avg,
                dayOfWeek,
            ],
        );
        segsInserted += res.rowCount ?? 0;
    }

    return { dwell: dwellInserted, segs: segsInserted, cancelled: false };
}

async function seed(): Promise<void> {
    await runMigrations();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totals = { dwell: 0, segs: 0, cancelled: 0 };
    for (let d = 30; d > 0; d--) {
        const date = new Date(today);
        date.setDate(today.getDate() - d);
        for (const profile of PROFILES) {
            const r = await seedDay(date, profile);
            totals.dwell += r.dwell;
            totals.segs += r.segs;
            if (r.cancelled) totals.cancelled += 1;
        }
    }
    console.log(JSON.stringify({ msg: "seed complete", ...totals }));
}

async function clean(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const trainNumbers = PROFILES.map((p) => p.number);
    const r1 = await pool.query(
        `DELETE FROM station_dwell_events WHERE train_number = ANY($1::int[]) AND run_date < $2::date`,
        [trainNumbers, today],
    );
    const r2 = await pool.query(
        `DELETE FROM route_segments WHERE train_number = ANY($1::int[]) AND run_date < $2::date`,
        [trainNumbers, today],
    );
    console.log(
        JSON.stringify({
            msg: "cleanup complete",
            dwellRemoved: r1.rowCount ?? 0,
            segsRemoved: r2.rowCount ?? 0,
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
