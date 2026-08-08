BEGIN;

ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_REGISTRATION_CERTIFICATE';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_INSPECTION_REPORT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_PURCHASE_AGREEMENT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'MOTOR_VEHICLE_INVOICE';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'OWNER_IDENTITY_DOCUMENT';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'VEHICLE_CONFIGURATION_SHEET';
ALTER TYPE "vehicle_document_type" ADD VALUE IF NOT EXISTS 'PURCHASE_PAYMENT_VOUCHER';

CREATE TYPE "vehicle_listing_source_section" AS ENUM ('CONFIGURATION_SHEET', 'CONDITION_REPORT');

CREATE TABLE "vehicle_document_batch" (
  "id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "document_type" "vehicle_document_type" NOT NULL,
  "version_no" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploaded_by" UUID,

  CONSTRAINT "vehicle_document_batch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "vehicle_document"
ADD COLUMN "batch_id" UUID;

WITH ranked AS (
  SELECT
    "id",
    "vehicle_id",
    "document_type",
    "created_at",
    "uploaded_by",
    ROW_NUMBER() OVER (
      PARTITION BY "vehicle_id", "document_type"
      ORDER BY "created_at", "id"
    )::INTEGER AS "version_no"
  FROM "vehicle_document"
  WHERE "deleted_at" IS NULL
)
INSERT INTO "vehicle_document_batch" (
  "id",
  "vehicle_id",
  "document_type",
  "version_no",
  "created_at",
  "uploaded_by"
)
SELECT
  "id",
  "vehicle_id",
  "document_type",
  "version_no",
  "created_at",
  "uploaded_by"
FROM ranked;

UPDATE "vehicle_document"
SET "batch_id" = id
WHERE "batch_id" IS NULL AND "deleted_at" IS NULL;

CREATE TABLE "vehicle_listing_source_binding" (
  "id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "section" "vehicle_listing_source_section" NOT NULL,
  "document_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "updated_by" UUID,

  CONSTRAINT "vehicle_listing_source_binding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_document_batch_vehicle_id_document_type_version_no_key"
ON "vehicle_document_batch"("vehicle_id", "document_type", "version_no");

CREATE INDEX "vehicle_document_batch_vehicle_id_created_at_idx"
ON "vehicle_document_batch"("vehicle_id", "created_at");

CREATE INDEX "vehicle_document_batch_id_idx"
ON "vehicle_document"("batch_id");

CREATE UNIQUE INDEX "vehicle_listing_source_binding_vehicle_id_section_key"
ON "vehicle_listing_source_binding"("vehicle_id", "section");

CREATE INDEX "vehicle_listing_source_binding_document_id_idx"
ON "vehicle_listing_source_binding"("document_id");

ALTER TABLE "vehicle_document_batch"
ADD CONSTRAINT "vehicle_document_batch_vehicle_id_fkey"
FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_document"
ADD CONSTRAINT "vehicle_document_batch_id_fkey"
FOREIGN KEY ("batch_id") REFERENCES "vehicle_document_batch"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "vehicle_listing_source_binding"
ADD CONSTRAINT "vehicle_listing_source_binding_vehicle_id_fkey"
FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicle_listing_source_binding"
ADD CONSTRAINT "vehicle_listing_source_binding_document_id_fkey"
FOREIGN KEY ("document_id") REFERENCES "vehicle_document"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
