-- 0005_raw_server_date
-- The provider's own clock, from the Date header of its response. Compared
-- with observed_at it estimates how far this machine's clock is off, which
-- matters twice: signed requests (OKX) are rejected outside a short time
-- window, and every freshness judgement assumes our clock is right.
--
-- clock_offset_ms is the estimate itself: (server_date + 500 ms) minus the
-- midpoint between sending the request and receiving the response headers.
-- The response headers, not the end of the body: a slow body would otherwise
-- count as skew. The 500 ms centres the Date header, which is truncated to
-- the second. Positive means this machine's clock is behind.
--
-- Both are null when there was no response or no parseable Date header. Rows
-- stored before this migration have neither; that is unknown, not zero skew.

ALTER TABLE raw_observations ADD COLUMN server_date timestamptz;
-- bigint: a clock that is years off (a reset battery) must still be recorded, not overflow.
ALTER TABLE raw_observations ADD COLUMN clock_offset_ms bigint;
CREATE INDEX raw_observations_clock_offset_idx ON raw_observations (available_at DESC) WHERE clock_offset_ms IS NOT NULL;
