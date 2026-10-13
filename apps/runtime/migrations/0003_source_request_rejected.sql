-- 0003_source_request_rejected
-- A capability whose last request the provider answered with an error about
-- the request (a 404, another 4xx, or an error inside a 2xx body) was shown
-- as HEALTHY. It now has its own state, REQUEST_REJECTED: reachable, not
-- backed off, and not healthy.
--
-- source_health is a mutable projection of the latest outcome, so the rows it
-- already holds are converted to what the new rule says about that same
-- outcome. updated_at is when that outcome was written, so it is also exactly
-- when that failure happened. How many rejections preceded it was not kept;
-- at least this one did.

ALTER TABLE source_health DROP CONSTRAINT source_health_state_check;
ALTER TABLE source_health ADD CONSTRAINT source_health_state_check CHECK (state IN (
  'HEALTHY', 'RATE_LIMITED', 'PAYMENT_REQUIRED', 'UNAUTHORIZED', 'CREDENTIAL_MISSING', 'DOWN',
  'REQUEST_REJECTED'));

UPDATE source_health
   SET state = 'REQUEST_REJECTED',
       consecutive_failures = GREATEST(consecutive_failures, 1),
       last_failure_at = updated_at
 WHERE state = 'HEALTHY' AND last_outcome IN ('NOT_FOUND', 'CLIENT_ERROR');
