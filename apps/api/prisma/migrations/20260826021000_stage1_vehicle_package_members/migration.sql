CREATE TABLE "vehicle_package_model_member" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "vehicle_package_id" UUID NOT NULL,
  "model_definition_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,

  CONSTRAINT "vehicle_package_model_member_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_package_model_member_package_model_key"
ON "vehicle_package_model_member"("vehicle_package_id", "model_definition_id");

CREATE INDEX "vehicle_package_model_member_vehicle_package_id_idx"
ON "vehicle_package_model_member"("vehicle_package_id");

CREATE INDEX "vehicle_package_model_member_model_definition_id_idx"
ON "vehicle_package_model_member"("model_definition_id");

ALTER TABLE "vehicle_package_model_member"
ADD CONSTRAINT "vehicle_package_model_member_vehicle_package_id_fkey"
FOREIGN KEY ("vehicle_package_id") REFERENCES "vehicle_package"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_package_model_member"
ADD CONSTRAINT "vehicle_package_model_member_model_definition_id_fkey"
FOREIGN KEY ("model_definition_id") REFERENCES "vehicle_model_definition"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "vehicle_package_model_member" (
  "id",
  "vehicle_package_id",
  "model_definition_id",
  "created_at",
  "created_by"
)
SELECT
  gen_random_uuid(),
  "id",
  "model_definition_id",
  "created_at",
  "created_by"
FROM "vehicle_package"
ON CONFLICT ("vehicle_package_id", "model_definition_id") DO NOTHING;

CREATE FUNCTION "prevent_vehicle_package_model_member_reassignment"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'vehicle package model membership rows are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "vehicle_package_model_member_no_update"
BEFORE UPDATE ON "vehicle_package_model_member"
FOR EACH ROW EXECUTE FUNCTION "prevent_vehicle_package_model_member_reassignment"();
