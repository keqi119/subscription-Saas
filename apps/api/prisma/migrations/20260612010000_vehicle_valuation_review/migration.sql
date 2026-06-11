ALTER TYPE "vehicle_sale_price_review_type" ADD VALUE 'RESIDUAL_FORECAST_ADOPTION';

CREATE TYPE "vehicle_valuation_review_source" AS ENUM (
    'RESIDUAL_FORECAST',
    'MANUAL',
    'QUARTERLY_REVIEW',
    'RETURN_REINIT',
    'OTHER'
);

CREATE TYPE "vehicle_valuation_review_status" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'CANCELLED'
);

CREATE TABLE "vehicle_valuation_review" (
    "id" UUID NOT NULL,
    "review_no" VARCHAR(64) NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "forecast_id" UUID,
    "forecast_point_id" UUID,
    "review_source" "vehicle_valuation_review_source" NOT NULL,
    "review_status" "vehicle_valuation_review_status" NOT NULL DEFAULT 'PENDING',
    "original_sale_price_amount" BIGINT,
    "forecast_residual_amount" BIGINT,
    "adopted_residual_amount" BIGINT,
    "requested_sale_price_amount" BIGINT NOT NULL,
    "approved_sale_price_amount" BIGINT,
    "forecast_horizon_month" INTEGER,
    "forecast_target_date" DATE,
    "forecast_confidence_score" INTEGER,
    "forecast_amount_source" VARCHAR(64),
    "reason" TEXT,
    "review_remark" TEXT,
    "reject_reason" TEXT,
    "cancel_reason" TEXT,
    "requested_by" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "before_snapshot" JSONB,
    "forecast_snapshot" JSONB,
    "approval_snapshot" JSONB,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_valuation_review_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_valuation_review_review_no_key" ON "vehicle_valuation_review"("review_no");

CREATE INDEX "vehicle_valuation_review_vehicle_id_idx" ON "vehicle_valuation_review"("vehicle_id");

CREATE INDEX "vehicle_valuation_review_forecast_id_idx" ON "vehicle_valuation_review"("forecast_id");

CREATE INDEX "vehicle_valuation_review_forecast_point_id_idx" ON "vehicle_valuation_review"("forecast_point_id");

CREATE INDEX "vehicle_valuation_review_review_status_idx" ON "vehicle_valuation_review"("review_status");

CREATE INDEX "vehicle_valuation_review_review_source_idx" ON "vehicle_valuation_review"("review_source");

CREATE INDEX "vehicle_valuation_review_requested_at_idx" ON "vehicle_valuation_review"("requested_at");

ALTER TABLE "vehicle_valuation_review" ADD CONSTRAINT "vehicle_valuation_review_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_valuation_review" ADD CONSTRAINT "vehicle_valuation_review_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "vehicle_residual_forecast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_valuation_review" ADD CONSTRAINT "vehicle_valuation_review_forecast_point_id_fkey" FOREIGN KEY ("forecast_point_id") REFERENCES "vehicle_residual_forecast_point"("id") ON DELETE SET NULL ON UPDATE CASCADE;
