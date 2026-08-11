ALTER TABLE "customer_profile"
  ADD COLUMN "residence_province" VARCHAR(64),
  ADD COLUMN "residence_city" VARCHAR(64),
  ADD COLUMN "residence_district" VARCHAR(64),
  ADD COLUMN "residence_detail" VARCHAR(255);

ALTER TABLE "application"
  ADD COLUMN "customer_profile_snapshot" JSONB;
