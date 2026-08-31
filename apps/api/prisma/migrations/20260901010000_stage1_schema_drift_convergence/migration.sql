BEGIN;

-- DropForeignKey
ALTER TABLE "product_price_rule" DROP CONSTRAINT "product_price_rule_model_definition_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle" DROP CONSTRAINT "vehicle_model_definition_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_package" DROP CONSTRAINT "vehicle_package_model_definition_id_fkey";

-- AlterTable
ALTER TABLE "customer_profile_material" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "insurance_claim" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "order_mileage_review" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "order_mileage_review_evidence" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscription_change_command" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_baas_contract" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_baas_contract_attachment" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_baas_cost_record" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_condition_report" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_condition_report_item" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_depreciation_policy" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_depreciation_record" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_depreciation_schedule" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_document" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_handover_event" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_insurance_coverage" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_insurance_policy" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_listing_media" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_listing_plan" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_listing_profile" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_mileage_reading" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_model_definition" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "vehicle_package_model_member" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "vehicle_package" ADD CONSTRAINT "vehicle_package_model_definition_id_fkey" FOREIGN KEY ("model_definition_id") REFERENCES "vehicle_model_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_price_rule" ADD CONSTRAINT "product_price_rule_model_definition_id_fkey" FOREIGN KEY ("model_definition_id") REFERENCES "vehicle_model_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_model_definition_id_fkey" FOREIGN KEY ("model_definition_id") REFERENCES "vehicle_model_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
-- PostgreSQL permits this index and its sibling foreign-key constraint to share
-- a name, while Prisma requires unique mapped names within the model namespace.
ALTER INDEX "vehicle_handover_review_attempt_sent_back_to_customer_review_by" RENAME TO "vehicle_handover_review_attempt_sent_back_to_customer_revie_idx";

COMMIT;
