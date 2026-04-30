import { runMigrations, pool } from "./db.js";
import { startScraper } from "./scraper.js";
import { log } from "./log.js";

async function shutdown(signal: string, code = 0): Promise<never> {
    log.info({ signal }, "shutting down");
    try {
        await pool.end();
    } catch (err) {
        log.error({ err: (err as Error).message }, "pool.end failed");
    }
    process.exit(code);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
    log.info("comboios scraper boot");
    await runMigrations();
    await startScraper();
}

main().catch(async (err) => {
    log.fatal({ err: (err as Error).message, stack: (err as Error).stack }, "fatal");
    await shutdown("FATAL", 1);
});
