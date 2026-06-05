-- AlterTable
ALTER TABLE "subscription_quote" ADD COLUMN     "vehicle_id" UUID,
ADD COLUMN     "vehicle_snapshot" JSONB,
ADD COLUMN     "vehicle_sale_price_amount" BIGINT,
ADD COLUMN     "vehicle_base_fee_cap_amount" BIGINT,
ADD COLUMN     "vehicle_base_fee_amount" BIGINT,
ADD COLUMN     "mileage_package_price_amount" BIGINT,
ADD COLUMN     "energy_package_price_amount" BIGINT,
ADD COLUMN     "benefit_package_price_amount" BIGINT;

-- CreateIndex
CREATE INDEX "subscription_quote_vehicle_id_idx" ON "subscription_quote"("vehicle_id");

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
