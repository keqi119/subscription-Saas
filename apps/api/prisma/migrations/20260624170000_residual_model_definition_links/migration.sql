ALTER TABLE "vehicle_market_price_observation" ADD COLUMN "model_definition_id" UUID;

ALTER TABLE "vehicle_residual_curve" ADD COLUMN "model_definition_id" UUID;

ALTER TABLE "vehicle_residual_forecast" ADD COLUMN "model_definition_id" UUID;

ALTER TABLE "residual_model_run" ADD COLUMN "target_model_definition_id" UUID;

CREATE INDEX "vehicle_market_price_observation_model_definition_id_idx" ON "vehicle_market_price_observation"("model_definition_id");

CREATE INDEX "vehicle_residual_curve_model_definition_id_idx" ON "vehicle_residual_curve"("model_definition_id");

CREATE INDEX "vehicle_residual_forecast_model_definition_id_idx" ON "vehicle_residual_forecast"("model_definition_id");

CREATE INDEX "residual_model_run_target_model_definition_id_idx" ON "residual_model_run"("target_model_definition_id");

ALTER TABLE "vehicle_market_price_observation"
  ADD CONSTRAINT "vehicle_market_price_observation_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "vehicle_residual_curve"
  ADD CONSTRAINT "vehicle_residual_curve_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "vehicle_residual_forecast"
  ADD CONSTRAINT "vehicle_residual_forecast_model_definition_id_fkey"
  FOREIGN KEY ("model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "residual_model_run"
  ADD CONSTRAINT "residual_model_run_target_model_definition_id_fkey"
  FOREIGN KEY ("target_model_definition_id")
  REFERENCES "vehicle_model_definition"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
