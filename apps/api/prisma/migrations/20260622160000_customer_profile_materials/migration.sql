-- CreateEnum
CREATE TYPE "customer_profile_material_type" AS ENUM ('ID_CARD_FRONT', 'ID_CARD_BACK', 'DRIVER_LICENSE_FRONT', 'DRIVER_LICENSE_BACK', 'OTHER');

-- CreateEnum
CREATE TYPE "customer_profile_material_status" AS ENUM ('ACTIVE', 'REPLACED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "customer_profile_material" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "material_type" "customer_profile_material_type" NOT NULL,
    "material_status" "customer_profile_material_status" NOT NULL DEFAULT 'ACTIVE',
    "file_name" VARCHAR(255) NOT NULL,
    "original_name" VARCHAR(255),
    "mime_type" VARCHAR(128),
    "file_size" INTEGER,
    "bucket" VARCHAR(256),
    "object_key" VARCHAR(512),
    "remark" TEXT,
    "snapshot" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customer_profile_material_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_profile_material_customer_id_idx" ON "customer_profile_material"("customer_id");

-- CreateIndex
CREATE INDEX "customer_profile_material_material_type_idx" ON "customer_profile_material"("material_type");

-- CreateIndex
CREATE INDEX "customer_profile_material_material_status_idx" ON "customer_profile_material"("material_status");

-- AddForeignKey
ALTER TABLE "customer_profile_material" ADD CONSTRAINT "customer_profile_material_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
