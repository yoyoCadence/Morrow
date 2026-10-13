-- 0005_raw_server_date
-- The provider's own clock, from the Date header of its response. Compared
-- with observed_at it estimates how far this machine's clock is off, which
-- matters twice: signed requests (OKX) are rejected outside a short time
-- window, and every freshness judgement assumes our clock is right.
--
-- Null when there was no response or no parseable Date header. Rows stored
-- before this migration have none; that is unknown, not zero skew.

ALTER TABLE raw_observations ADD COLUMN server_date timestamptz;
CREATE INDEX raw_observations_server_date_idx ON raw_observations (available_at DESC) WHERE server_date IS NOT NULL;
