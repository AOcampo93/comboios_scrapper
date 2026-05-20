-- CP static GTFS feed (the published timetable). These are full-snapshot tables:
-- src/gtfs.ts TRUNCATEs and reloads them on every import. They unlock:
--   * scheduled_dwell_seconds / excess_seconds in station_dwell_events (006 + aggregator)
--   * train_line_map — which route each train number belongs to, for line-level stats

CREATE TABLE IF NOT EXISTS gtfs_routes (
    route_id          TEXT PRIMARY KEY,
    route_short_name  TEXT,
    route_long_name   TEXT,
    route_type        INTEGER
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
    trip_id          TEXT PRIMARY KEY,
    route_id         TEXT,
    service_id       TEXT,
    trip_headsign    TEXT,
    trip_short_name  TEXT,        -- in CP's GTFS this is the train number
    direction_id     SMALLINT
);

CREATE INDEX IF NOT EXISTS gtfs_trips_short_name_idx ON gtfs_trips (trip_short_name);
CREATE INDEX IF NOT EXISTS gtfs_trips_route_idx      ON gtfs_trips (route_id);

CREATE TABLE IF NOT EXISTS gtfs_stops (
    stop_id    TEXT PRIMARY KEY,
    stop_name  TEXT,
    stop_lat   DOUBLE PRECISION,
    stop_lon   DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
    trip_id         TEXT     NOT NULL,
    stop_id         TEXT     NOT NULL,
    stop_sequence   INTEGER  NOT NULL,
    arrival_time    TEXT,    -- GTFS clock string, may exceed 24:00:00
    departure_time  TEXT
);

CREATE INDEX IF NOT EXISTS gtfs_stop_times_trip_idx ON gtfs_stop_times (trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS gtfs_stop_times_stop_idx ON gtfs_stop_times (stop_id);

CREATE TABLE IF NOT EXISTS gtfs_calendar (
    service_id  TEXT PRIMARY KEY,
    monday      SMALLINT,
    tuesday     SMALLINT,
    wednesday   SMALLINT,
    thursday    SMALLINT,
    friday      SMALLINT,
    saturday    SMALLINT,
    sunday      SMALLINT,
    start_date  DATE,
    end_date    DATE
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
    service_id      TEXT      NOT NULL,
    date            DATE      NOT NULL,
    exception_type  SMALLINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS gtfs_calendar_dates_idx ON gtfs_calendar_dates (service_id, date);

-- Single-row table: lets gtfs.ts skip re-importing a byte-identical feed.
-- The CHECK + PK on a constant boolean enforce "exactly one row".
CREATE TABLE IF NOT EXISTS gtfs_meta (
    only_row     BOOLEAN      PRIMARY KEY DEFAULT TRUE CHECK (only_row),
    feed_hash    TEXT         NOT NULL,
    trip_count   INTEGER,
    imported_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Derived after each import: train number -> route. trip_short_name carries the
-- train number; one row per number (DISTINCT ON resolves rare duplicates).
CREATE TABLE IF NOT EXISTS train_line_map (
    train_number      INTEGER PRIMARY KEY,
    route_id          TEXT,
    route_short_name  TEXT,
    trip_headsign     TEXT
);

-- GTFS clock string ("HH:MM:SS", possibly >= 24:00:00) -> seconds since midnight.
CREATE OR REPLACE FUNCTION gtfs_time_to_seconds(t TEXT)
RETURNS INTEGER
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN t IS NULL OR t = '' THEN NULL
        ELSE split_part(t, ':', 1)::int * 3600
           + split_part(t, ':', 2)::int * 60
           + split_part(t, ':', 3)::int
    END
$$;
