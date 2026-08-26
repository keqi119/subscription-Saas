CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "application"
  ADD COLUMN "final_plan_commercial_hash" VARCHAR(71),
  ADD COLUMN "journey_fact_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "subscription_journey"
  ADD COLUMN "last_application_fact_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "subscription_journey_step"
  ADD COLUMN "waiting_reason_snapshot" JSONB;

ALTER TABLE "application"
  ADD CONSTRAINT "application_journey_fact_version_nonnegative"
    CHECK ("journey_fact_version" >= 0) NOT VALID,
  ADD CONSTRAINT "application_final_plan_commercial_hash_format"
    CHECK (
      "final_plan_commercial_hash" IS NULL
      OR "final_plan_commercial_hash" ~ '^sha256:[0-9a-f]{64}$'
    ) NOT VALID;

ALTER TABLE "subscription_journey"
  ADD CONSTRAINT "subscription_journey_last_application_fact_version_nonnegative"
    CHECK ("last_application_fact_version" >= 0) NOT VALID;

ALTER TABLE "application"
  VALIDATE CONSTRAINT "application_journey_fact_version_nonnegative";

ALTER TABLE "application"
  VALIDATE CONSTRAINT "application_final_plan_commercial_hash_format";

ALTER TABLE "subscription_journey"
  VALIDATE CONSTRAINT "subscription_journey_last_application_fact_version_nonnegative";

CREATE OR REPLACE FUNCTION pg_temp.stage1_canonical_jsonb(value JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN COALESCE(
      (
        SELECT '{' || string_agg(
          to_jsonb(entry.key)::text || ':' || pg_temp.stage1_canonical_jsonb(entry.value),
          ',' ORDER BY entry.key COLLATE "C"
        ) || '}'
        FROM jsonb_each(value) AS entry
      ),
      '{}'
    )
    WHEN 'array' THEN COALESCE(
      (
        SELECT '[' || string_agg(
          pg_temp.stage1_canonical_jsonb(item.value),
          ',' ORDER BY item.ordinality
        ) || ']'
        FROM jsonb_array_elements(value) WITH ORDINALITY AS item(value, ordinality)
      ),
      '[]'
    )
    ELSE value::text
  END
$$;

UPDATE "application"
SET "final_plan_commercial_hash" = 'sha256:' || encode(
  public.digest(
    convert_to(
      pg_temp.stage1_canonical_jsonb(
        jsonb_build_object(
          'contractTermsVersion', "final_plan_snapshot" -> 'contractTermsVersion',
          'contractVersionId', "final_plan_snapshot" -> 'contractVersionId',
          'contractVersionNo', "final_plan_snapshot" -> 'contractVersionNo',
          'depositAmount', "final_plan_snapshot" -> 'depositAmount',
          'depositRuleSnapshot', "final_plan_snapshot" -> 'depositRuleSnapshot',
          'effectiveDate', "final_plan_snapshot" -> 'effectiveDate',
          'effectiveFrom', "final_plan_snapshot" -> 'effectiveFrom',
          'entitlementSnapshot', "final_plan_snapshot" -> 'entitlementSnapshot',
          'entitlements', "final_plan_snapshot" -> 'entitlements',
          'mileageLimitKm', "final_plan_snapshot" -> 'mileageLimitKm',
          'overMileageFeeAmount', "final_plan_snapshot" -> 'overMileageFeeAmount',
          'packageSnapshot', "final_plan_snapshot" -> 'packageSnapshot',
          'periodMonths', "final_plan_snapshot" -> 'periodMonths',
          'pricing', "final_plan_snapshot" -> 'pricing',
          'subscriptionPlan', "final_plan_snapshot" -> 'subscriptionPlan',
          'subscriptionPlanId', "final_plan_snapshot" -> 'subscriptionPlanId',
          'vehicleId', "final_plan_snapshot" -> 'vehicleId',
          'vehicleSnapshot', "final_plan_snapshot" -> 'vehicleSnapshot'
        )
      ),
      'UTF8'
    ),
    'sha256'
  ),
  'hex'
)
WHERE "final_plan_commercial_hash" IS NULL
  AND jsonb_typeof("final_plan_snapshot") = 'object';

DROP FUNCTION pg_temp.stage1_canonical_jsonb(JSONB);
