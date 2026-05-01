-- Capture the delay (in seconds) reported by CP at the moment the train was first
-- observed at the station. Without this column the reliability score only works
-- against train_snapshots, which is dropped after 14 days — losing long-term signal.
--
-- Older rows pre-existing this migration get NULL; aggregator backfills new ones.

ALTER TABLE station_dwell_events
    ADD COLUMN IF NOT EXISTS delay_at_arrival_seconds INTEGER;

CREATE INDEX IF NOT EXISTS station_dwell_delay_idx
    ON station_dwell_events (train_number, delay_at_arrival_seconds)
    WHERE delay_at_arrival_seconds IS NOT NULL;
