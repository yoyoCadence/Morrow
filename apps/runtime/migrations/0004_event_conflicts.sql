-- 0004_event_conflicts
-- An event whose dedupe key was already stored used to be dropped without a
-- trace, even when it said something different. Same fact twice is a no-op;
-- two different facts under one key is a contradiction, and contradictions
-- must stay visible.
--
-- events.fact_sha256 hashes what the event says happened (domain, action,
-- subject, payload with its version, source time), not how we learned it
-- (provenance, observed_at) or how it is encoded (schema_version). Rows stored
-- before this migration have no hash and, being append-only, are not given
-- one: the runtime derives it from their stored columns when it needs to
-- compare (see eventFactSha256).

ALTER TABLE events ADD COLUMN fact_sha256 text CHECK (fact_sha256 ~ '^[0-9a-f]{64}$');

CREATE TABLE event_conflicts (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id              uuid        NOT NULL REFERENCES events (event_id),
  dedupe_key            text        NOT NULL,
  stored_fact_sha256    text        NOT NULL CHECK (stored_fact_sha256 ~ '^[0-9a-f]{64}$'),
  incoming_fact_sha256  text        NOT NULL CHECK (incoming_fact_sha256 ~ '^[0-9a-f]{64}$'),
  -- The rejected event exactly as it arrived, provenance included, so the
  -- evidence behind it can be found.
  incoming_event        jsonb       NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (stored_fact_sha256 <> incoming_fact_sha256),
  -- The same contradiction arriving again (a redelivered job) is recorded once.
  UNIQUE (event_id, incoming_fact_sha256)
);
CREATE INDEX event_conflicts_detected_idx ON event_conflicts (detected_at DESC);

CREATE TRIGGER event_conflicts_append_only BEFORE UPDATE OR DELETE ON event_conflicts
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER event_conflicts_no_truncate BEFORE TRUNCATE ON event_conflicts
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();
