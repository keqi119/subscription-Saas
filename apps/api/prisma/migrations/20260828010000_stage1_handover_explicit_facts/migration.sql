ALTER TABLE "vehicle_handover_work_order"
  ADD COLUMN "vehicle_condition_confirmed" BOOLEAN,
  ADD COLUMN "vehicle_condition_remarks" TEXT,
  ADD COLUMN "primary_key_count" INTEGER,
  ADD COLUMN "spare_key_count" INTEGER,
  ADD COLUMN "key_state" VARCHAR(32),
  ADD COLUMN "registration_document_state" VARCHAR(32),
  ADD COLUMN "registration_document_remarks" TEXT,
  ADD COLUMN "accessory_items" JSONB,
  ADD COLUMN "handover_fact_snapshot" JSONB,
  ADD COLUMN "handover_fact_hash" VARCHAR(71),
  ADD COLUMN "handover_fact_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "vehicle_handover_work_order"
  ADD CONSTRAINT "vehicle_handover_work_order_primary_key_count_check"
    CHECK ("primary_key_count" IS NULL OR "primary_key_count" >= 0),
  ADD CONSTRAINT "vehicle_handover_work_order_spare_key_count_check"
    CHECK ("spare_key_count" IS NULL OR "spare_key_count" >= 0),
  ADD CONSTRAINT "vehicle_handover_work_order_key_state_check"
    CHECK (
      "key_state" IS NULL OR
      "key_state" IN ('COMPLETE', 'PARTIAL', 'MISSING', 'DAMAGED')
    ),
  ADD CONSTRAINT "vehicle_handover_work_order_registration_document_state_check"
    CHECK (
      "registration_document_state" IS NULL OR
      "registration_document_state" IN ('HANDED_OVER', 'NOT_AVAILABLE', 'DAMAGED')
    ),
  ADD CONSTRAINT "vehicle_handover_work_order_fact_hash_check"
    CHECK (
      "handover_fact_hash" IS NULL OR
      "handover_fact_hash" ~ '^sha256:[0-9a-f]{64}$'
    );
