-- CreateEnum
CREATE TYPE "benefit_type" AS ENUM ('WASH_CAR', 'CAR_SWAP', 'POINTS', 'DRIVER_SERVICE', 'OTHER');

-- AlterTable
ALTER TABLE "subscription_quote" ADD COLUMN     "benefit_package_id" UUID,
ADD COLUMN     "energy_package_id" UUID,
ADD COLUMN     "mileage_package_id" UUID,
ADD COLUMN     "package_snapshot" JSONB,
ADD COLUMN     "vehicle_package_id" UUID;

-- CreateTable
CREATE TABLE "vehicle_package" (
    "id" UUID NOT NULL,
    "package_no" VARCHAR(64) NOT NULL,
    "package_name" VARCHAR(128) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "vehicle_model" "vehicle_model" NOT NULL,
    "vehicle_model_name" VARCHAR(128),
    "brand" VARCHAR(64),
    "series" VARCHAR(64),
    "config_name" VARCHAR(128),
    "min_purchase_price_amount" BIGINT,
    "max_purchase_price_amount" BIGINT,
    "monthly_fee_rate" DECIMAL(8,6) NOT NULL DEFAULT 0.035000,
    "min_period_months" INTEGER NOT NULL,
    "max_period_months" INTEGER NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "vehicle_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mileage_package" (
    "id" UUID NOT NULL,
    "package_no" VARCHAR(64) NOT NULL,
    "package_name" VARCHAR(128) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "monthly_mileage_km" INTEGER NOT NULL,
    "over_mileage_fee_amount" BIGINT NOT NULL,
    "price_amount" BIGINT NOT NULL DEFAULT 0,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "mileage_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "energy_package" (
    "id" UUID NOT NULL,
    "package_no" VARCHAR(64) NOT NULL,
    "package_name" VARCHAR(128) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "monthly_energy_kwh" INTEGER,
    "monthly_energy_count" INTEGER,
    "price_amount" BIGINT NOT NULL DEFAULT 0,
    "station_scope" TEXT,
    "service_description" TEXT,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "energy_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_package" (
    "id" UUID NOT NULL,
    "package_no" VARCHAR(64) NOT NULL,
    "package_name" VARCHAR(128) NOT NULL,
    "product_id" UUID NOT NULL,
    "product_version_id" UUID NOT NULL,
    "benefit_type" "benefit_type" NOT NULL,
    "benefit_count" INTEGER,
    "price_amount" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "benefit_package_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_package_package_no_key" ON "vehicle_package"("package_no");

-- CreateIndex
CREATE INDEX "vehicle_package_product_id_idx" ON "vehicle_package"("product_id");

-- CreateIndex
CREATE INDEX "vehicle_package_product_version_id_idx" ON "vehicle_package"("product_version_id");

-- CreateIndex
CREATE INDEX "vehicle_package_vehicle_model_idx" ON "vehicle_package"("vehicle_model");

-- CreateIndex
CREATE INDEX "vehicle_package_status_idx" ON "vehicle_package"("status");

-- CreateIndex
CREATE UNIQUE INDEX "mileage_package_package_no_key" ON "mileage_package"("package_no");

-- CreateIndex
CREATE INDEX "mileage_package_product_id_idx" ON "mileage_package"("product_id");

-- CreateIndex
CREATE INDEX "mileage_package_product_version_id_idx" ON "mileage_package"("product_version_id");

-- CreateIndex
CREATE INDEX "mileage_package_status_idx" ON "mileage_package"("status");

-- CreateIndex
CREATE UNIQUE INDEX "energy_package_package_no_key" ON "energy_package"("package_no");

-- CreateIndex
CREATE INDEX "energy_package_product_id_idx" ON "energy_package"("product_id");

-- CreateIndex
CREATE INDEX "energy_package_product_version_id_idx" ON "energy_package"("product_version_id");

-- CreateIndex
CREATE INDEX "energy_package_status_idx" ON "energy_package"("status");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_package_package_no_key" ON "benefit_package"("package_no");

-- CreateIndex
CREATE INDEX "benefit_package_product_id_idx" ON "benefit_package"("product_id");

-- CreateIndex
CREATE INDEX "benefit_package_product_version_id_idx" ON "benefit_package"("product_version_id");

-- CreateIndex
CREATE INDEX "benefit_package_benefit_type_idx" ON "benefit_package"("benefit_type");

-- CreateIndex
CREATE INDEX "benefit_package_status_idx" ON "benefit_package"("status");

-- CreateIndex
CREATE INDEX "subscription_quote_vehicle_package_id_idx" ON "subscription_quote"("vehicle_package_id");

-- CreateIndex
CREATE INDEX "subscription_quote_mileage_package_id_idx" ON "subscription_quote"("mileage_package_id");

-- CreateIndex
CREATE INDEX "subscription_quote_energy_package_id_idx" ON "subscription_quote"("energy_package_id");

-- CreateIndex
CREATE INDEX "subscription_quote_benefit_package_id_idx" ON "subscription_quote"("benefit_package_id");

-- AddForeignKey
ALTER TABLE "vehicle_package" ADD CONSTRAINT "vehicle_package_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_package" ADD CONSTRAINT "vehicle_package_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mileage_package" ADD CONSTRAINT "mileage_package_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mileage_package" ADD CONSTRAINT "mileage_package_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_package" ADD CONSTRAINT "energy_package_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "energy_package" ADD CONSTRAINT "energy_package_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_package" ADD CONSTRAINT "benefit_package_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_package" ADD CONSTRAINT "benefit_package_product_version_id_fkey" FOREIGN KEY ("product_version_id") REFERENCES "product_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_vehicle_package_id_fkey" FOREIGN KEY ("vehicle_package_id") REFERENCES "vehicle_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_mileage_package_id_fkey" FOREIGN KEY ("mileage_package_id") REFERENCES "mileage_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_energy_package_id_fkey" FOREIGN KEY ("energy_package_id") REFERENCES "energy_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_benefit_package_id_fkey" FOREIGN KEY ("benefit_package_id") REFERENCES "benefit_package"("id") ON DELETE SET NULL ON UPDATE CASCADE;
