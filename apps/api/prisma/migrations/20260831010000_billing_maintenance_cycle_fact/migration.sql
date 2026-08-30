CREATE TYPE "billing_maintenance_cycle_fact_status" AS ENUM ('COMPLETED');

CREATE TABLE "billing_maintenance_cycle_fact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "status" "billing_maintenance_cycle_fact_status" NOT NULL DEFAULT 'COMPLETED',
  "evidence_run_id" VARCHAR(64) NOT NULL,
  "sequence" SMALLINT NOT NULL,
  "release_sha" VARCHAR(40) NOT NULL,
  "image_digest" VARCHAR(71) NOT NULL,
  "database_identity_sha256" VARCHAR(64) NOT NULL,
  "forbidden_domain_set_version" VARCHAR(96) NOT NULL,
  "forbidden_domain_set_sha256" VARCHAR(64) NOT NULL,
  "cycle_started_at" TIMESTAMPTZ(6) NOT NULL,
  "reconciliation_completed_at" TIMESTAMPTZ(6) NOT NULL,
  "enqueue_completed_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL,
  "blocked_count" INTEGER NOT NULL,
  "reconciliation_summary" JSONB NOT NULL,
  "enqueue_summary" JSONB NOT NULL,
  "before_counts" JSONB NOT NULL,
  "before_counts_sha256" VARCHAR(64) NOT NULL,
  "after_counts" JSONB NOT NULL,
  "after_counts_sha256" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT "billing_maintenance_cycle_fact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_maintenance_cycle_fact_evidence_run_id_sequence_key"
    UNIQUE ("evidence_run_id", "sequence"),
  CONSTRAINT "billing_maintenance_cycle_fact_sequence_chk"
    CHECK ("sequence" IN (1, 2)),
  CONSTRAINT "billing_maintenance_cycle_fact_blocked_count_chk"
    CHECK ("blocked_count" >= 0),
  CONSTRAINT "billing_maintenance_cycle_fact_source_format_chk"
    CHECK (
      "evidence_run_id" ~ '^[0-9a-f]{64}$'
      AND "release_sha" ~ '^[0-9a-f]{40}$'
      AND "image_digest" ~ '^sha256:[0-9a-f]{64}$'
      AND "database_identity_sha256" ~ '^[0-9a-f]{64}$'
      AND "forbidden_domain_set_version" ~ '^stage1-acceptance-forbidden-domains/v[1-9][0-9]*$'
      AND "forbidden_domain_set_sha256" ~ '^[0-9a-f]{64}$'
      AND "before_counts_sha256" ~ '^[0-9a-f]{64}$'
      AND "after_counts_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "billing_maintenance_cycle_fact_time_order_chk"
    CHECK (
      "cycle_started_at" <= "reconciliation_completed_at"
      AND "reconciliation_completed_at" <= "enqueue_completed_at"
      AND "enqueue_completed_at" <= "completed_at"
      AND "completed_at" <= "created_at"
    )
);

COMMENT ON TABLE "billing_maintenance_cycle_fact" IS
  'Append-only governance fact; intentionally excluded from the Stage 1 acceptance forbidden-domain set.';

CREATE INDEX "billing_maintenance_cycle_fact_evidence_run_id_completed_at_idx"
  ON "billing_maintenance_cycle_fact"("evidence_run_id", "completed_at");
CREATE INDEX "billing_maintenance_cycle_fact_completed_at_idx"
  ON "billing_maintenance_cycle_fact"("completed_at");

CREATE FUNCTION "billing_maintenance_json_nonnegative_integer"("value" JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof("value") = 'number'
    AND "value"::TEXT ~ '^(0|[1-9][0-9]*)$';
$$;

CREATE FUNCTION "billing_maintenance_count_map_is_valid"("value" JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  "entry" RECORD;
BEGIN
  IF jsonb_typeof("value") <> 'object' OR "value" = '{}'::JSONB THEN
    RETURN FALSE;
  END IF;
  FOR "entry" IN SELECT * FROM jsonb_each("value") LOOP
    IF "entry"."key" !~ '^[A-Za-z][A-Za-z0-9]*$'
      OR NOT "billing_maintenance_json_nonnegative_integer"("entry"."value") THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION "billing_maintenance_reconciliation_summary_is_valid"(
  "value" JSONB,
  "expected_blocked_count" INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  "blocker_code_value" JSONB;
  "current_blocker_code" TEXT;
  "normalized_codes" JSONB;
BEGIN
  IF jsonb_typeof("value") <> 'object'
    OR NOT ("value" ?& ARRAY[
      'blockedCount',
      'blockerCodes',
      'createdCount',
      'eligibleCount',
      'existingCount',
      'leaseActivationCount'
    ])
    OR ("value" - ARRAY[
      'blockedCount',
      'blockerCodes',
      'createdCount',
      'eligibleCount',
      'existingCount',
      'leaseActivationCount'
    ]) <> '{}'::JSONB
    OR NOT "billing_maintenance_json_nonnegative_integer"("value" -> 'blockedCount')
    OR NOT "billing_maintenance_json_nonnegative_integer"("value" -> 'createdCount')
    OR NOT "billing_maintenance_json_nonnegative_integer"("value" -> 'eligibleCount')
    OR NOT "billing_maintenance_json_nonnegative_integer"("value" -> 'existingCount')
    OR NOT "billing_maintenance_json_nonnegative_integer"("value" -> 'leaseActivationCount')
    OR ("value" ->> 'blockedCount')::INTEGER <> "expected_blocked_count"
    OR jsonb_typeof("value" -> 'blockerCodes') <> 'array' THEN
    RETURN FALSE;
  END IF;

  FOR "blocker_code_value" IN
    SELECT jsonb_array_elements("value" -> 'blockerCodes')
  LOOP
    IF jsonb_typeof("blocker_code_value") <> 'string' THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  FOR "current_blocker_code" IN
    SELECT jsonb_array_elements_text("value" -> 'blockerCodes')
  LOOP
    IF "current_blocker_code" IS NULL
      OR "current_blocker_code" !~ '^[A-Z][A-Z0-9_]{0,127}$' THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  SELECT COALESCE(
    jsonb_agg(to_jsonb("candidate_code") ORDER BY "candidate_code"),
    '[]'::JSONB
  )
  INTO "normalized_codes"
  FROM (
    SELECT DISTINCT
      jsonb_array_elements_text("value" -> 'blockerCodes') AS "candidate_code"
  ) AS "codes";

  RETURN "normalized_codes" = "value" -> 'blockerCodes'
    AND jsonb_array_length("normalized_codes") <= "expected_blocked_count";
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

CREATE FUNCTION "billing_maintenance_enqueue_summary_is_valid"("value" JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof("value") = 'object'
    AND "value" ?& ARRAY['dueCount', 'enqueuedCount']
    AND ("value" - ARRAY['dueCount', 'enqueuedCount']) = '{}'::JSONB
    AND "billing_maintenance_json_nonnegative_integer"("value" -> 'dueCount')
    AND "billing_maintenance_json_nonnegative_integer"("value" -> 'enqueuedCount');
$$;

ALTER TABLE "billing_maintenance_cycle_fact"
  ADD CONSTRAINT "billing_maintenance_cycle_fact_count_maps_chk"
  CHECK (
    "billing_maintenance_count_map_is_valid"("before_counts")
    AND "billing_maintenance_count_map_is_valid"("after_counts")
  ),
  ADD CONSTRAINT "billing_maintenance_cycle_fact_summaries_chk"
  CHECK (
    "billing_maintenance_reconciliation_summary_is_valid"(
      "reconciliation_summary",
      "blocked_count"
    )
    AND "billing_maintenance_enqueue_summary_is_valid"("enqueue_summary")
  );

CREATE FUNCTION "reject_billing_maintenance_cycle_fact_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing_maintenance_cycle_fact is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "billing_maintenance_cycle_fact_append_only_trg"
BEFORE UPDATE OR DELETE ON "billing_maintenance_cycle_fact"
FOR EACH ROW
EXECUTE FUNCTION "reject_billing_maintenance_cycle_fact_mutation"();
