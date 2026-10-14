-- 0008_market_snapshot_index
-- Reads for the market snapshot page (FT-02). Index only; no data changes.

-- The latest snapshot of each pool. The page walks the distinct pools in
-- this index one at a time (a loose index scan) and reads the newest entry
-- of each, so its cost follows the number of pools, not the length of their
-- history. Latest is the most recently observed; of snapshots observed at
-- the same moment (a reparse of the same response), the last recorded.
CREATE INDEX events_pair_snapshot_pool_idx
  ON events ((payload ->> 'pool_address'), observed_at DESC, recorded_seq DESC)
  WHERE domain = 'market' AND action = 'pair.snapshot';
