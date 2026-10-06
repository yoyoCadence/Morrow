-- 0002_parse_quarantine
-- Field-level quarantine: values a parser received but would not interpret
-- without guessing, such as a ratio whose unit is undocumented. The canonical
-- record carries such a field as UNKNOWN; this table keeps the source text and
-- the reason, so a later parser version with a confirmed rule can read it.
--
-- A value that is simply absent, or a placeholder like "--", is UNKNOWN but is
-- not quarantined: there is nothing to interpret.

CREATE TABLE parse_quarantine (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raw_observation_id  bigint      NOT NULL REFERENCES raw_observations (id),
  parser_version      text        NOT NULL,
  -- What the field belongs to, for example a pool address, or '$' for the whole body.
  record_ref          text        NOT NULL,
  -- JSON path into the raw body, for example '$[0].priceChange.h1'.
  field_path          text        NOT NULL,
  -- The source text exactly as received, truncated to 1000 characters. Null when
  -- the value was not a scalar.
  raw_value           text,
  reason              text        NOT NULL,
  quarantined_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Parsing the same observation again with the same parser adds nothing.
  UNIQUE (raw_observation_id, parser_version, field_path)
);
CREATE INDEX parse_quarantine_reason_idx ON parse_quarantine (parser_version, reason);

CREATE TRIGGER parse_quarantine_append_only BEFORE UPDATE OR DELETE ON parse_quarantine
  FOR EACH ROW EXECUTE FUNCTION morrow_reject_mutation();
CREATE TRIGGER parse_quarantine_no_truncate BEFORE TRUNCATE ON parse_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION morrow_reject_mutation();
