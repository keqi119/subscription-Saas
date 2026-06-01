-- CreateEnum
CREATE TYPE "application_action_type" AS ENUM ('CREATE', 'UPLOAD_MATERIAL', 'SUBMIT', 'REVIEW_MATERIAL', 'APPROVE', 'NEED_MORE_INFO', 'REJECT');

-- AlterEnum
ALTER TYPE "application_material_type" ADD VALUE 'RESIDENCE_PROOF';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "material_status" ADD VALUE 'APPROVED';
ALTER TYPE "material_status" ADD VALUE 'NEED_MORE_INFO';

-- AlterTable
ALTER TABLE "application_material" ADD COLUMN     "material_name" VARCHAR(128),
ADD COLUMN     "review_comment" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN     "reviewed_by" UUID;

-- CreateTable
CREATE TABLE "application_action_log" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "material_id" UUID,
    "action_type" "application_action_type" NOT NULL,
    "from_status" "application_status",
    "to_status" "application_status",
    "comment" TEXT,
    "operator_id" UUID,
    "operator_name" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "application_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_action_log_application_id_idx" ON "application_action_log"("application_id");

-- CreateIndex
CREATE INDEX "application_action_log_material_id_idx" ON "application_action_log"("material_id");

-- CreateIndex
CREATE INDEX "application_action_log_operator_id_idx" ON "application_action_log"("operator_id");

-- CreateIndex
CREATE INDEX "application_action_log_action_type_idx" ON "application_action_log"("action_type");

-- CreateIndex
CREATE INDEX "application_action_log_created_at_idx" ON "application_action_log"("created_at");

-- CreateIndex
CREATE INDEX "application_material_reviewed_by_idx" ON "application_material"("reviewed_by");

-- CreateIndex
CREATE INDEX "application_material_status_idx" ON "application_material"("status");

-- AddForeignKey
ALTER TABLE "application_material" ADD CONSTRAINT "application_material_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_action_log" ADD CONSTRAINT "application_action_log_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_action_log" ADD CONSTRAINT "application_action_log_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "application_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_action_log" ADD CONSTRAINT "application_action_log_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
