import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import type pg from "pg";
import { pool } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * GTFS static-feed ingestion. Downloads CP's published timetable zip, parses the
 * CSVs and loads them into the gtfs_* tables (full-snapshot: TRUNCATE + reload).
 *
 * The feed changes infrequently, so importGtfs() hashes the zip and skips the
 * import when nothing changed. startGtfsSync() runs it on boot, then daily.
 *
 * Once loaded, the aggregator joins these tables to fill scheduled_dwell_seconds
 * and the frontend reads train_line_map for line-level stats.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal RFC4180 CSV parser: quoted fields, embedded commas/quotes, CRLF, BOM. */
function parseCsv(text: string): Record<string, string>[] {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const rows: string[][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            row.push(field);
            field = "";
        } else if (c === "\n") {
            row.push(field);
            rows.push(row);
            field = "";
            row = [];
        } else if (c !== "\r") {
            field += c;
        }
    }
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    if (rows.length === 0) return [];
    const header = rows[0];
    const out: Record<string, string>[] = [];
    for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        if (cells.length === 1 && cells[0] === "") continue; // trailing blank line
        const obj: Record<string, string> = {};
        for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] ?? "";
        out.push(obj);
    }
    return out;
}

const txt = (s: string): string | null => (s == null || s === "" ? null : s);
const int = (s: string): number | null =>
    s == null || s === "" ? null : Number.parseInt(s, 10);
const num = (s: string): number | null =>
    s == null || s === "" ? null : Number.parseFloat(s);

/** Insert rows in chunks small enough to stay under Postgres' parameter limit. */
async function batchInsert(
    client: pg.PoolClient,
    table: string,
    columns: string[],
    rows: (string | number | null)[][],
): Promise<void> {
    if (rows.length === 0) return;
    const chunkSize = Math.max(1, Math.floor(60_000 / columns.length));
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const placeholders = chunk
            .map((_, ri) => {
                const o = ri * columns.length;
                return (
                    "(" +
                    columns.map((_, ci) => `$${o + ci + 1}`).join(",") +
                    ")"
                );
            })
            .join(",");
        await client.query(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`,
            chunk.flat(),
        );
    }
}

export async function importGtfs(): Promise<void> {
    const t0 = Date.now();
    log.info({ url: config.gtfsUrl }, "gtfs: downloading feed");

    let buf: Buffer;
    try {
        const res = await fetch(config.gtfsUrl, {
            headers: { "User-Agent": config.userAgent },
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            log.error({ status: res.status }, "gtfs: download returned non-ok");
            return;
        }
        buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        log.error({ err: (err as Error).message }, "gtfs: download failed");
        return;
    }

    const hash = createHash("sha256").update(buf).digest("hex");

    const { rows: metaRows } = await pool.query<{ feed_hash: string }>(
        "SELECT feed_hash FROM gtfs_meta WHERE only_row = TRUE",
    );
    if (metaRows[0]?.feed_hash === hash) {
        log.info("gtfs: feed unchanged since last import, skipping");
        return;
    }

    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(new Uint8Array(buf));
    } catch (err) {
        log.error({ err: (err as Error).message }, "gtfs: unzip failed");
        return;
    }

    const csv = (name: string): Record<string, string>[] => {
        const f = files[name];
        if (!f) throw new Error(`missing ${name} in feed`);
        return parseCsv(Buffer.from(f).toString("utf8"));
    };

    let routes: Record<string, string>[];
    let trips: Record<string, string>[];
    let stops: Record<string, string>[];
    let stopTimes: Record<string, string>[];
    let calendar: Record<string, string>[];
    let calendarDates: Record<string, string>[];
    try {
        routes = csv("routes.txt");
        trips = csv("trips.txt");
        stops = csv("stops.txt");
        stopTimes = csv("stop_times.txt");
        calendar = csv("calendar.txt");
        calendarDates = csv("calendar_dates.txt");
    } catch (err) {
        log.error({ err: (err as Error).message }, "gtfs: parse failed");
        return;
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `TRUNCATE gtfs_routes, gtfs_trips, gtfs_stops, gtfs_stop_times,
                      gtfs_calendar, gtfs_calendar_dates, train_line_map`,
        );

        await batchInsert(
            client,
            "gtfs_routes",
            ["route_id", "route_short_name", "route_long_name", "route_type"],
            routes.map((r) => [
                r.route_id,
                txt(r.route_short_name),
                txt(r.route_long_name),
                int(r.route_type),
            ]),
        );

        await batchInsert(
            client,
            "gtfs_trips",
            [
                "trip_id",
                "route_id",
                "service_id",
                "trip_headsign",
                "trip_short_name",
                "direction_id",
            ],
            trips.map((r) => [
                r.trip_id,
                txt(r.route_id),
                txt(r.service_id),
                txt(r.trip_headsign),
                txt(r.trip_short_name),
                int(r.direction_id),
            ]),
        );

        await batchInsert(
            client,
            "gtfs_stops",
            ["stop_id", "stop_name", "stop_lat", "stop_lon"],
            stops.map((r) => [
                r.stop_id,
                txt(r.stop_name),
                num(r.stop_lat),
                num(r.stop_lon),
            ]),
        );

        await batchInsert(
            client,
            "gtfs_stop_times",
            ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"],
            stopTimes.map((r) => [
                r.trip_id,
                r.stop_id,
                int(r.stop_sequence),
                txt(r.arrival_time),
                txt(r.departure_time),
            ]),
        );

        await batchInsert(
            client,
            "gtfs_calendar",
            [
                "service_id",
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
                "start_date",
                "end_date",
            ],
            calendar.map((r) => [
                r.service_id,
                int(r.monday),
                int(r.tuesday),
                int(r.wednesday),
                int(r.thursday),
                int(r.friday),
                int(r.saturday),
                int(r.sunday),
                txt(r.start_date),
                txt(r.end_date),
            ]),
        );

        await batchInsert(
            client,
            "gtfs_calendar_dates",
            ["service_id", "date", "exception_type"],
            calendarDates.map((r) => [
                r.service_id,
                r.date,
                int(r.exception_type),
            ]),
        );

        // Derived train -> route map. trip_short_name is the train number; the
        // regex guard makes the ::int cast safe, DISTINCT ON collapses any number
        // that appears on more than one trip.
        await client.query(`
            INSERT INTO train_line_map (train_number, route_id, route_short_name, trip_headsign)
            SELECT DISTINCT ON (t.trip_short_name::int)
                   t.trip_short_name::int,
                   t.route_id,
                   r.route_short_name,
                   t.trip_headsign
            FROM gtfs_trips t
            LEFT JOIN gtfs_routes r ON r.route_id = t.route_id
            WHERE t.trip_short_name ~ '^[0-9]+$'
            ORDER BY t.trip_short_name::int, t.trip_id
        `);

        await client.query(
            `INSERT INTO gtfs_meta (only_row, feed_hash, trip_count, imported_at)
             VALUES (TRUE, $1, $2, NOW())
             ON CONFLICT (only_row) DO UPDATE
                SET feed_hash   = EXCLUDED.feed_hash,
                    trip_count  = EXCLUDED.trip_count,
                    imported_at = NOW()`,
            [hash, trips.length],
        );

        await client.query("COMMIT");
        log.info(
            {
                routes: routes.length,
                trips: trips.length,
                stops: stops.length,
                stopTimes: stopTimes.length,
                ms: Date.now() - t0,
            },
            "gtfs: import complete",
        );
    } catch (err) {
        await client.query("ROLLBACK");
        log.error(
            { err: (err as Error).message },
            "gtfs: import failed, rolled back",
        );
    } finally {
        client.release();
    }
}

export async function startGtfsSync(): Promise<never> {
    log.info("gtfs sync starting (import on boot, then every 24h)");
    while (true) {
        try {
            await importGtfs();
        } catch (err) {
            log.error(
                { err: (err as Error).message },
                "gtfs: sync iteration failed",
            );
        }
        await sleep(24 * 3600_000);
    }
}
