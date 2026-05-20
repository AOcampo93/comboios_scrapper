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
} as const;
