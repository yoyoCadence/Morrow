-- 0001_foundation
-- Raw evidence, canonical events, the job queue, run sessions, the quota
-- ledger, provider health and probes, and the audit log.
--
-- Object names are unqualified on purpose: the runner sets search_path, which
-- lets the test suite apply the same file into throwaway schemas.

-- Append-only enforcement ---------------------------------------------------

CREATE FUNCTION morrow_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is not allowed on append-only table %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Run sessions --------------------------------------------------------------

CREATE TABLE run_sessions (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component          text        NOT NULL CHECK (component IN ('api', 'worker')),
  mode               text        NOT NULL CHECK (mode IN ('OFF', 'RESEARCH', 'PAPER')),
  status             text        NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'STOPPED', 'ABANDONED')),
  started_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at           timestamptz,
  -- Set by "morrow stop". The process notices on its next heartbeat and shuts
  -- down cleanly. Windows has no usable SIGTERM, so this is the stop channel.
  stop_requested_at  timestamptz,
  host               text        NOT NULL,
  pid                integer     NOT NULL,
  app_version        text        NOT NULL,
  CHECK ((status = 'RUNNING') = (ended_at IS NULL))
);

-- At most one live session per component. A single worker is what makes the
-- in-process provider rate limiters authoritative.
CREATE UNIQUE INDEX run_sessions_one_running_idx ON run_sessions (component) WHERE status = 'RUNNING';
CREATE INDEX run_sessions_component_started_idx ON run_sessions (component, started_at DESC);

-- Intervals during which a component was not observing. Ingestion and
-- monitoring must treat these as coverage gaps, never as "nothing happened".
CREATE TABLE session_gaps (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component               text        NOT NULL CHECK (component IN ('api', 'worker')),
  kind                    text        NOT NULL CHECK (kind IN ('UNCLEAN_SHUTDOWN', 'OFFLINE', 'HEARTBEAT_STALL')),
  gap_start               timestamptz NOT NULL,
  gap_end                 timestamptz NOT NULL,
  previous_session_id     bigint      REFERENCES run_sessions (id),
  detected_by_session_id  bigint      NOT NULL REFERENCES run_sessions (id),
  detected_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (gap_end >= gap_start)
);
CREATE INDEX session_gaps_component_end_idx ON session_gaps (component, gap_end DESC);

-- Raw evidence --------------------------------------------------------------

-- Response bodies, stored once per distinct content. The hash is over the
-- exact bytes received, so the body is bytea rather than jsonb.
CREATE TABLE raw_payloads (
  sha256           text        PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  body             bytea       NOT NULL,
  byte_length      integer     NOT NULL,
  first_stored_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (byte_length = octet_length(body))
);

-- One row per request actually sent to a provider, whatever the result.
CREATE TABLE raw_observations (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider             text        NOT NULL,
  provider_group       text        NOT NULL,
  capability           text        NOT NULL,
  request_method       text        NOT NULL CHECK (request_method IN ('GET', 'POST')),
  -- Credentials are applied at send time and are never part of this URL.
  request_url          text        NOT NULL,
  request_fingerprint  text        NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  reason               text        NOT NULL CHECK (reason IN ('scheduled', 'retry', 'manual', 'probe', 'backfill')),
  outcome              text        NOT NULL,
  http_status          integer,
  content_type         text,
  payload_sha256       text        REFERENCES raw_payloads (sha256),
  error_class          text,
  error_detail         text,
  duration_ms          integer     CHECK (duration_ms >= 0),
  -- When the response (or failure) was received by this process.
  observed_at          timestamptz NOT NULL,
  -- When this row was stored and so became usable. Replays cut off on this.
  available_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  run_session_id       bigint      REFERENCES run_sessions (id)
);
CREATE INDEX raw_observations_capability_idx ON raw_observations (provider, capability, available_at DESC);
CREATE INDEX raw_observations_payload_idx ON raw_observations (payload_sha256) WHERE payload_sha256 IS NOT NULL;

-- Canonical events ----------------------------------------------------------

CREATE TABLE events (
  event_id         uuid        PRIMARY KEY,
  -- Total order of insertion, for deterministic replay.
  recorded_seq     bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  dedupe_key       text        NOT NULL UNIQUE,
  schema_version   integer     NOT NULL CHECK (schema_version >= 1),
  domain           text        NOT NULL CHECK (domain IN (
                     'asset', 'market', 'liquidity', 'flow', 'ownership',
                     'project', 'security', 'system', 'decision')),
  action           text        NOT NULL,
  subject          text        NOT NULL,
  payload_version  integer     NOT NULL CHECK (payload_version >= 1),
  payload          jsonb       NOT NULL,
  -- Null when the source gives no time. Never filled in with the fetch time.
  event_time       timestamptz,
  observed_at      timestamptz NOT NULL,
  available_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  provenance       jsonb       NOT NULL,
  severity         text        NOT NULL CHECK (severity IN ('INFO', 'NOTICE', 'WARNING', 'CRITICAL')),
  confidence       numeric(7, 6) CHECK (confidence >= 0 AND confidence <= 1),
  causation_id     uuid,
  correlation_id   uuid
);
CREATE INDEX events_subject_available_idx ON events (subject, available_at);
CREATE INDEX events_domain_action_available_idx ON events (domain, action, available_at);

-- Jobs ----------------------------------------------------------------------

-- The queue doubles as the transactional outbox: work is enqueued in the same
-- transaction as the data that caused it, so neither exists without the other.
-- Delivery is at-least-once; consumers dedupe through consumer_inbox.
CREATE TABLE jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind              text        NOT NULL,
  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- When set, the same logical job can be enqueued only once, ever.
  dedupe_key        text        UNIQUE,
  status            text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'dead')),
  run_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      integer     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_owner       text,
  lease_expires_at  timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at       timestamptz,
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL))
);
CREATE INDEX jobs_queued_idx ON jobs (run_at, id) WHERE status = 'queued';
CREATE INDEX jobs_leased_idx ON jobs (lease_expires_at) WHERE status = 'leased';

CREATE TABLE consumer_inbox (
  consumer      text        NOT NULL,
  message_key   text        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, message_key)
);

-- Quota ledger --------------------------------------------------------------

-- Running total per provider bucket and billing period. Reservations update
-- it atomically, so concurrent callers can never push it past the hard stop.
CREATE TABLE quota_counters (
  provider      text    NOT NULL,
  bucket        text    NOT NULL,
  period_start  date    NOT NULL,
  used          bigint  NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (provider, bucket, period_start)
);

-- Every reservation attempt, allowed or denied. Retries, manual refreshes,
-- probes and backfills are all recorded here and all count.
CREATE TABLE quota_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider       text        NOT NULL,
  bucket         text        NOT NULL,
  period_start   date        NOT NULL,
  capability     text        NOT NULL,
  reason         text        NOT NULL CHECK (reason IN ('scheduled', 'retry', 'manual', 'probe', 'backfill')),
  units          integer     NOT NULL CHECK (units >= 1),
  decision       text        NOT NULL CHECK (decision IN ('ALLOW', 'ALLOW_WARN', 'DENY_HARD_STOP')),
  used_after     bigint      NOT NULL,
  warn_at        bigint      NOT NULL,
  hard_stop_at   bigint      NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX quota_events_bucket_idx ON quota_events (provider, bucket, period_start, occurred_at DESC);

-- Provider health and probes ------------------------------------------------

-- Current state per provider capability. Mutable by design: it is a
-- projection of the most recent outcomes, and raw_observations is the record.
CREATE TABLE source_health (
  provider                 text        NOT NULL,
  capability               text        NOT NULL,
  state                    text        NOT NULL CHECK (state IN (
                             'HEALTHY', 'RATE_LIMITED', 'PAYMENT_REQUIRED',
                             'UNAUTHORIZED', 'CREDENTIAL_MISSING', 'DOWN')),
  last_outcome             text        NOT NULL,
  last_http_status         integer,
  consecutive_failures     integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  blocked_until            timestamptz,
  last_success_at          timestamptz,
  last_failure_at          timestamptz,
  last_raw_observation_id  bigint      REFERENCES raw_observations (id),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, capability)
);

-- What each credential and plan actually grants, as measured.
CREATE TABLE provider_probes (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider            text        NOT NULL,
  capability          text        NOT NULL,
  outcome             text        NOT NULL,
  http_status         integer,
  -- False until the endpoint definition was checked against provider docs.
  doc_verified        boolean     NOT NULL,
  detail              text,
  raw_observation_id  bigint      REFERENCES raw_observations (id),
  job_id              bigint      REFERENCES jobs (id),
  run_session_id      bigint      REFERENCES run_sessions (id),
  probed_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX provider_probes_capability_idx ON provider_probes (provider, capability, probed_at DESC);

-- Audit log -----------------------------------------------------------------

CREATE TABLE audit_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor           text        NOT NULL,
  action          text        NOT NULL,
  subject         text,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  run_session_id  bigint      REFERENCES run_sessions (id)
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);

-- Append-only triggers ------------------------------------------------------

CREATE TRIGGER raw_payloads_append_only BEFORE UPDATE OR DELETE ON raw_payloads
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER raw_payloads_no_truncate BEFORE TRUNCATE ON raw_payloads
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER raw_observations_append_only BEFORE UPDATE OR DELETE ON raw_observations
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER raw_observations_no_truncate BEFORE TRUNCATE ON raw_observations
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER session_gaps_append_only BEFORE UPDATE OR DELETE ON session_gaps
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER session_gaps_no_truncate BEFORE TRUNCATE ON session_gaps
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER quota_events_append_only BEFORE UPDATE OR DELETE ON quota_events
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER quota_events_no_truncate BEFORE TRUNCATE ON quota_events
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER provider_probes_append_only BEFORE UPDATE OR DELETE ON provider_probes
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER provider_probes_no_truncate BEFORE TRUNCATE ON provider_probes
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();
