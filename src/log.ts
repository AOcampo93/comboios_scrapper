import pino from "pino";
import { config } from "./config.js";

export const log = pino({
    level: config.logLevel,
    transport:
        config.nodeEnv === "development"
            ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
            : undefined,
});
