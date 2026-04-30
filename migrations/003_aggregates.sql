-- Aggregated derivatives, populated by the aggregator service (F3.5) on a daily cron.
-- Permanent retention — these are what survives the 14d raw-snapshot drop.

CREATE TABLE IF NOT EXISTS station_dwell_events (
    id                       BIGSERIAL    PRIMARY KEY,
    train_number             INTEGER      NOT NULL,
    run_date                 DATE         NOT NULL,
    station_code             TEXT         NOT NULL,
    arrived_at               TIMESTAMPTZ  NOT NULL,
    departed_at              TIMESTAMPTZ,
    dwell_seconds            INTEGER,
    scheduled_dwell_seconds  INTEGER,
    excess_seconds           INTEGER,
    UNIQUE (train_number, run_date, station_code, arrived_at)
);

CREATE INDEX IF NOT EXISTS station_dwell_train_idx
    ON station_dwell_events (train_number, run_date);

CREATE INDEX IF NOT EXISTS station_dwell_station_time_idx
    ON station_dwell_events (station_code, arrived_at DESC);

CREATE TABLE IF NOT EXISTS route_segments (
    id              BIGSERIAL         PRIMARY KEY,
    train_number    INTEGER           NOT NULL,
    run_date        DATE              NOT NULL,
    from_station    TEXT              NOT NULL,
    to_station      TEXT              NOT NULL,
    departed_at     TIMESTAMPTZ       NOT NULL,
    arrived_at      TIMESTAMPTZ       NOT NULL,
    travel_seconds  INTEGER           NOT NULL,
    distance_km     DOUBLE PRECISION,
    avg_speed_kmh   DOUBLE PRECISION,
    day_of_week     SMALLINT          NOT NULL,
    UNIQUE (train_number, run_date, from_station, to_station, departed_at)
);

CREATE INDEX IF NOT EXISTS route_segments_pair_idx
    ON route_segments (from_station, to_station);

CREATE INDEX IF NOT EXISTS route_segments_train_idx
    ON route_segments (train_number, run_date);
