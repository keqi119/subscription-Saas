CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'READY', 'DELIVERED', 'CANCELLED');

CREATE TABLE "vehicle_delivery" (
    "id" UUID NOT NULL,
    "delivery_no" VARCHAR(64) NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "scheduled_at" TIMESTAMPTZ(6),
    "delivery_location" VARCHAR(255),
    "delivered_at" TIMESTAMPTZ(6),
    "handover_mileage_km" INTEGER,
    "contract_signed_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "deposit_received_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "first_monthly_fee_received_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "insurance_valid_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_prepared_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_photos_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "customer_identity_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "handover_documents_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "checklist_snapshot" JSONB,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_delivery_delivery_no_key" ON "vehicle_delivery"("delivery_no");
CREATE UNIQUE INDEX "vehicle_delivery_order_id_key" ON "vehicle_delivery"("order_id");
CREATE INDEX "vehicle_delivery_vehicle_id_idx" ON "vehicle_delivery"("vehicle_id");
CREATE INDEX "vehicle_delivery_customer_id_idx" ON "vehicle_delivery"("customer_id");
CREATE INDEX "vehicle_delivery_delivery_status_idx" ON "vehicle_delivery"("delivery_status");
CREATE INDEX "vehicle_delivery_scheduled_at_idx" ON "vehicle_delivery"("scheduled_at");
CREATE INDEX "vehicle_delivery_delivered_at_idx" ON "vehicle_delivery"("delivered_at");

ALTER TABLE "vehicle_delivery" ADD CONSTRAINT "vehicle_delivery_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "subscription_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_delivery" ADD CONSTRAINT "vehicle_delivery_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_delivery" ADD CONSTRAINT "vehicle_delivery_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
