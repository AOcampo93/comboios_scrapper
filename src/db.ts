import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./log.js";

export const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx) we resolve from src/; in build we resolve from dist/. Migrations live
// at the project root either way, so go up one level from this file.
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

export async function runMigrations(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER     PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

        const files = (await readdir(MIGRATIONS_DIR))
            .filter((f) => f.endsWith(".sql"))
            .sort();

        const { rows } = await client.query<{ version: number }>(
            "SELECT version FROM schema_migrations",
        );
        const applied = new Set(rows.map((r) => r.version));

        for (const file of files) {
            const match = file.match(/^(\d+)_/);
            if (!match) {
                log.warn({ file }, "migration file has no version prefix; skipping");
                continue;
            }
            const version = Number.parseInt(match[1], 10);
            if (applied.has(version)) continue;

            const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
            log.info({ file, version }, "applying migration");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (version) VALUES ($1)",
                    [version],
                );
                await client.query("COMMIT");
                log.info({ file, version }, "migration applied");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        }
    } finally {
        client.release();
    }
}
