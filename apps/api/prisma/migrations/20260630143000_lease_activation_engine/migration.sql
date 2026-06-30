-- CreateEnum
CREATE TYPE "lease_status" AS ENUM ('NOT_ACTIVE', 'READY', 'ACTIVE');

-- CreateEnum
CREATE TYPE "vehicle_inspection_status" AS ENUM ('PENDING', 'PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "lease" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "lease_status" NOT NULL DEFAULT 'NOT_ACTIVE',
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspection" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "vehicle_inspection_status" NOT NULL DEFAULT 'PENDING',
    "inspected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lease_order_id_key" ON "lease"("order_id");

-- CreateIndex
CREATE INDEX "lease_status_idx" ON "lease"("status");

-- CreateIndex
CREATE INDEX "lease_activated_at_idx" ON "lease"("activated_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_inspection_order_id_key" ON "vehicle_inspection"("order_id");

-- CreateIndex
CREATE INDEX "vehicle_inspection_status_idx" ON "vehicle_inspection"("status");

-- CreateIndex
CREATE INDEX "vehicle_inspection_inspected_at_idx" ON "vehicle_inspection"("inspected_at");

-- AddForeignKey
ALTER TABLE "lease"
  ADD CONSTRAINT "lease_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspection"
  ADD CONSTRAINT "vehicle_inspection_order_id_fkey"
  FOREIGN KEY ("order_id")
  REFERENCES "subscription_order"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
