-- Time-series of raw train positions. One row per (train, ts) tuple that differs from
-- the previous one (dedup is applied at the application layer before insert).
--
-- Columns are kept compact: SMALLINT/INTEGER instead of BIGINT, speed × 10 to avoid
-- a real/double, position as geography(Point,4326) so distance queries use meters.

CREATE TABLE IF NOT EXISTS train_snapshots (
    ts            TIMESTAMPTZ           NOT NULL,
    train_number  INTEGER               NOT NULL,
    run_date      DATE                  NOT NULL,
    status        TEXT                  NOT NULL,
    delay_seconds INTEGER,
    speed_decikmh SMALLINT,
    position      GEOGRAPHY(POINT,4326),
    last_station  TEXT,
    next_station  TEXT,
    stop_sequence SMALLINT,
    trip_id       TEXT
);

SELECT create_hypertable(
    'train_snapshots',
    'ts',
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists       => TRUE
);

CREATE INDEX IF NOT EXISTS train_snapshots_train_ts_idx
    ON train_snapshots (train_number, ts DESC);

CREATE INDEX IF NOT EXISTS train_snapshots_run_date_idx
    ON train_snapshots (run_date);

CREATE INDEX IF NOT EXISTS train_snapshots_position_gix
    ON train_snapshots USING GIST (position);

-- Compress chunks older than 2 days (typical 10-20x ratio for time-series).
ALTER TABLE train_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'train_number',
    timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('train_snapshots', INTERVAL '2 days', if_not_exists => TRUE);

-- Drop raw chunks after 14 days; aggregated tables (003) hold the long-term value.
SELECT add_retention_policy('train_snapshots', INTERVAL '14 days', if_not_exists => TRUE);
