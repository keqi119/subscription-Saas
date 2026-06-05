-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "application_action_type" ADD VALUE 'UPLOAD_MATERIAL_FILE';
ALTER TYPE "application_action_type" ADD VALUE 'REVIEW_MATERIAL_GROUP';
ALTER TYPE "application_action_type" ADD VALUE 'DELETE_MATERIAL_FILE';

-- AlterTable
ALTER TABLE "application_action_log" ADD COLUMN     "material_file_id" UUID,
ADD COLUMN     "material_group_id" UUID;

-- CreateTable
CREATE TABLE "application_material_group" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "material_type" "application_material_type" NOT NULL,
    "material_name" VARCHAR(128),
    "required" BOOLEAN NOT NULL DEFAULT false,
    "review_status" "material_status" NOT NULL DEFAULT 'PENDING',
    "review_comment" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "application_material_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_material_file" (
    "id" UUID NOT NULL,
    "material_group_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "material_type" "application_material_type" NOT NULL,
    "file_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(128),
    "size_bytes" BIGINT NOT NULL,
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "delete_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "application_material_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "application_material_group_application_id_idx" ON "application_material_group"("application_id");

-- CreateIndex
CREATE INDEX "application_material_group_material_type_idx" ON "application_material_group"("material_type");

-- CreateIndex
CREATE INDEX "application_material_group_review_status_idx" ON "application_material_group"("review_status");

-- CreateIndex
CREATE INDEX "application_material_group_reviewed_by_idx" ON "application_material_group"("reviewed_by");

-- CreateIndex
CREATE UNIQUE INDEX "application_material_group_application_id_material_type_key" ON "application_material_group"("application_id", "material_type");

-- CreateIndex
CREATE INDEX "application_material_file_material_group_id_idx" ON "application_material_file"("material_group_id");

-- CreateIndex
CREATE INDEX "application_material_file_application_id_idx" ON "application_material_file"("application_id");

-- CreateIndex
CREATE INDEX "application_material_file_material_type_idx" ON "application_material_file"("material_type");

-- CreateIndex
CREATE INDEX "application_material_file_file_id_idx" ON "application_material_file"("file_id");

-- CreateIndex
CREATE INDEX "application_material_file_uploaded_by_idx" ON "application_material_file"("uploaded_by");

-- CreateIndex
CREATE INDEX "application_material_file_deleted_by_idx" ON "application_material_file"("deleted_by");

-- CreateIndex
CREATE INDEX "application_material_file_is_deleted_idx" ON "application_material_file"("is_deleted");

-- CreateIndex
CREATE INDEX "application_action_log_material_group_id_idx" ON "application_action_log"("material_group_id");

-- CreateIndex
CREATE INDEX "application_action_log_material_file_id_idx" ON "application_action_log"("material_file_id");

-- AddForeignKey
ALTER TABLE "application_material_group" ADD CONSTRAINT "application_material_group_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_group" ADD CONSTRAINT "application_material_group_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_file" ADD CONSTRAINT "application_material_file_material_group_id_fkey" FOREIGN KEY ("material_group_id") REFERENCES "application_material_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_file" ADD CONSTRAINT "application_material_file_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_file" ADD CONSTRAINT "application_material_file_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_file" ADD CONSTRAINT "application_material_file_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_material_file" ADD CONSTRAINT "application_material_file_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_action_log" ADD CONSTRAINT "application_action_log_material_group_id_fkey" FOREIGN KEY ("material_group_id") REFERENCES "application_material_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_action_log" ADD CONSTRAINT "application_action_log_material_file_id_fkey" FOREIGN KEY ("material_file_id") REFERENCES "application_material_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;
