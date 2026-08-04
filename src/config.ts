function required(name: string): string {
    const v = process.env[name];
    if (!v || v.length === 0) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

export const config = {
    nodeEnv: process.env.NODE_ENV ?? "production",
    databaseUrl: required("DATABASE_URL"),
    upstreamBase: process.env.UPSTREAM_BASE ?? "https://comboios.live/api",
    gtfsUrl: process.env.GTFS_URL ?? "https://publico.cp.pt/gtfs/gtfs.zip",
    userAgent:
        process.env.SCRAPER_USER_AGENT ??
        "comboios-history-scraper/0.1 (research, non-commercial)",
    logLevel: process.env.LOG_LEVEL ?? "info",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 10_000),
    idleIntervalMs: Number(process.env.IDLE_INTERVAL_MS ?? 5 * 60_000),
    // Upper bound on a single tick's awaits, so one that never settles can't
    // stop the loop. Generous: a healthy tick is well under 3 s.
    tickTimeoutMs: Number(process.env.TICK_TIMEOUT_MS ?? 60_000),
    // If the loop stops iterating for this long the process is wedged. Must stay
    // comfortably above idleIntervalMs — idle iterations are the slowest ones.
    watchdogStallMs: Number(process.env.WATCHDOG_STALL_MS ?? 15 * 60_000),
} as const;
