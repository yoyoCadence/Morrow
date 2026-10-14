-- 0007_evidence_indexes
-- Reads for the evidence browser (FT-01). Indexes only; no data changes.

-- One subject's events, newest first, page by page (keyset on recorded_seq).
CREATE INDEX events_subject_seq_idx ON events (subject, recorded_seq DESC);

-- The events that cite a raw observation, for that observation's detail:
--   provenance -> 'evidence_refs' @> '["raw_observation:<id>"]'
-- Without it, every detail view would read the whole events table.
CREATE INDEX events_evidence_refs_idx ON events USING gin ((provenance -> 'evidence_refs') jsonb_path_ops);
