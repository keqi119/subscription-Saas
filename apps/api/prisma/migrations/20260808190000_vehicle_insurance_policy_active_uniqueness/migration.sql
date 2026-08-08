DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "vehicle_insurance_policy"
    WHERE "deleted_at" IS NULL
    GROUP BY "vehicle_id", "policy_no"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active vehicle insurance policy numbers block partial unique index';
  END IF;
END $$;

DROP INDEX IF EXISTS "vehicle_insurance_policy_vehicle_id_policy_no_key";

CREATE UNIQUE INDEX "vehicle_insurance_policy_active_vehicle_policy_no_key"
  ON "vehicle_insurance_policy" ("vehicle_id", "policy_no")
  WHERE "deleted_at" IS NULL;
