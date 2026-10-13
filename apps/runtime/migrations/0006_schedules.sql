-- 0006_schedules
-- Fixed schedules (FT-03). Each schedule divides time into slots aligned to
-- the UTC epoch, for example every 60 seconds, and enqueues one job per slot
-- with the dedupe key schedule:<name>:<slot start>. A slot it did not run is
-- recorded here as a gap, never run late in a burst: an observation is about
-- the moment it is made, so a late run cannot recover what was missed.

-- Where each schedule is. A projection the scheduler updates, like
-- source_health; the history is in jobs and schedule_gaps.
CREATE TABLE schedule_state (
  name             text        PRIMARY KEY,
  -- The slot length this row was written with. A different length in a
  -- later build starts a new series.
  every_ms         bigint      NOT NULL CHECK (every_ms > 0),
  -- The latest slot dealt with: enqueued, or skipped because of a backlog.
  last_slot_start  timestamptz NOT NULL,
  -- The job of the latest slot that was enqueued. While it is still queued,
  -- new slots are skipped rather than piled up behind it. No foreign key:
  -- finished jobs may be pruned one day, and a job that is gone is not queued.
  last_job_id      bigint,
  -- Start of the run of slots skipped because of a backlog, while it lasts.
  backlog_since    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Slots a schedule did not run, one row per stretch rather than per slot.
--
-- NOT_SCHEDULED: no tick reached the database during these slots. The worker
--   was stopped, crashed, asleep, frozen or in OFF mode (session_gaps and the
--   coverage report say which), or it could not reach the database.
-- BACKLOG: the scheduler was running, but the job of an earlier slot had not
--   started yet, so another one would only have queued behind it.
CREATE TABLE schedule_gaps (
  id                      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule                text        NOT NULL,
  reason                  text        NOT NULL CHECK (reason IN ('NOT_SCHEDULED', 'BACKLOG')),
  -- Start of the first missed slot and end of the last one.
  gap_start               timestamptz NOT NULL,
  gap_end                 timestamptz NOT NULL,
  missed_slots            bigint      NOT NULL CHECK (missed_slots >= 1),
  detected_by_session_id  bigint      REFERENCES run_sessions (id),
  detected_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (gap_end > gap_start)
);
CREATE INDEX schedule_gaps_schedule_end_idx ON schedule_gaps (schedule, gap_end DESC);

CREATE TRIGGER schedule_gaps_append_only BEFORE UPDATE OR DELETE ON schedule_gaps
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER schedule_gaps_no_truncate BEFORE TRUNCATE ON schedule_gaps
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();
