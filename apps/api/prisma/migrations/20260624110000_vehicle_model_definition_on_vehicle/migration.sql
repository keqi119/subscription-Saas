ALTER TABLE "vehicle" ADD COLUMN "model_definition_id" UUID;

CREATE INDEX "vehicle_model_definition_id_idx" ON "vehicle"("model_definition_id");

ALTER TABLE "vehicle"
  ADD CONSTRAINT "vehicle_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
