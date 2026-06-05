-- AlterTable
ALTER TABLE "subscription_order" ADD COLUMN     "final_plan_snapshot" JSONB,
ADD COLUMN     "review_comment" TEXT;
