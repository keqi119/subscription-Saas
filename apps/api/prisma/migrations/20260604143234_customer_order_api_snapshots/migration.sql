-- DropForeignKey
ALTER TABLE "subscription_order" DROP CONSTRAINT "subscription_order_risk_result_id_fkey";

-- DropForeignKey
ALTER TABLE "subscription_quote" DROP CONSTRAINT "subscription_quote_risk_result_id_fkey";

-- AlterTable
ALTER TABLE "subscription_order" ALTER COLUMN "risk_result_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "subscription_quote" ADD COLUMN     "customer_selected_snapshot" JSONB,
ALTER COLUMN "risk_result_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "subscription_quote" ADD CONSTRAINT "subscription_quote_risk_result_id_fkey" FOREIGN KEY ("risk_result_id") REFERENCES "risk_result"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_order" ADD CONSTRAINT "subscription_order_risk_result_id_fkey" FOREIGN KEY ("risk_result_id") REFERENCES "risk_result"("id") ON DELETE SET NULL ON UPDATE CASCADE;
