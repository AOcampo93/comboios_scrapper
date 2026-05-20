-- One canonical GPS-traced polyline per physical (from_station -> to_station) pair.
-- route_segments holds one row per train-run; this collapses them to a single
-- best-sampled geometry for the frontend speed heatmap (/api/heatmap/speed).
-- Populated by the aggregator from train_snapshots positions.

CREATE TABLE IF NOT EXISTS segment_paths (
    from_station  TEXT                         NOT NULL,
    to_station    TEXT                         NOT NULL,
    geometry      GEOGRAPHY(LINESTRING, 4326)  NOT NULL,
    point_count   INTEGER                      NOT NULL,
    updated_at    TIMESTAMPTZ                  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (from_station, to_station)
);
