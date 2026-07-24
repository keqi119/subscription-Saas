DO $$
DECLARE
  incomplete_vehicle_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO incomplete_vehicle_count
  FROM "vehicle" v
  WHERE
    (v."insurance_start_date" IS NOT NULL OR v."insurance_end_date" IS NOT NULL)
    AND (
      NOT EXISTS (
        SELECT 1
        FROM "vehicle_insurance_policy" p
        WHERE p."vehicle_id" = v."id"
          AND p."deleted_at" IS NULL
          AND p."policy_status" = 'ACTIVE'
          AND p."policy_type" = 'COMPULSORY_TRAFFIC'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "vehicle_insurance_policy" p
        WHERE p."vehicle_id" = v."id"
          AND p."deleted_at" IS NULL
          AND p."policy_status" = 'ACTIVE'
          AND p."policy_type" = 'COMMERCIAL'
      )
    );

  IF incomplete_vehicle_count > 0 THEN
    RAISE EXCEPTION
      'vehicle insurance source-of-truth migration blocked: % vehicles have legacy dates without both active required policy types',
      incomplete_vehicle_count;
  END IF;
END $$;

ALTER TABLE "vehicle"
  DROP COLUMN "insurance_start_date",
  DROP COLUMN "insurance_end_date";
