CREATE TYPE "vehicle_return_checklist_item_state" AS ENUM (
  'NORMAL', 'MISSING', 'DAMAGED', 'NOT_APPLICABLE', 'PENDING_VERIFICATION'
);
CREATE TYPE "vehicle_return_attestation_mode" AS ENUM (
  'CUSTOMER_SIGNED', 'CUSTOMER_REFUSED', 'CUSTOMER_ABSENT'
);
CREATE TYPE "vehicle_return_evidence_visibility" AS ENUM (
  'CUSTOMER_VISIBLE', 'INTERNAL_ONLY'
);

ALTER TABLE "subscription_closure_case"
  ADD COLUMN "current_checklist_revision_id" UUID;

ALTER TABLE "subscription_closure_document_revision"
  ADD COLUMN "attestation_mode" "vehicle_return_attestation_mode",
  ADD COLUMN "attestation_snapshot" JSONB,
  ADD COLUMN "attestation_snapshot_hash" VARCHAR(64);

CREATE TABLE "vehicle_return_checklist_revision" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "vehicle_return_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "manifest_hash" VARCHAR(64) NOT NULL,
  "attestation_mode" "vehicle_return_attestation_mode" NOT NULL,
  "attestation_snapshot" JSONB,
  "customer_comments" TEXT,
  "captured_at" TIMESTAMPTZ(6) NOT NULL,
  "captured_by" UUID NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "supersedes_revision_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_return_checklist_revision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_return_checklist_revision_case_revision_key" UNIQUE ("closure_case_id", "revision_number"),
  CONSTRAINT "vehicle_return_checklist_revision_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "vehicle_return_checklist_revision_supersedes_key" UNIQUE ("supersedes_revision_id"),
  CONSTRAINT "vehicle_return_checklist_revision_hash_check" CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vehicle_return_checklist_revision_attestation_check" CHECK (
    ("attestation_mode" = 'CUSTOMER_SIGNED' AND "attestation_snapshot" IS NULL)
    OR
    ("attestation_mode" IN ('CUSTOMER_REFUSED', 'CUSTOMER_ABSENT') AND "attestation_snapshot" IS NOT NULL)
  )
);

CREATE TABLE "vehicle_return_checklist_item" (
  "id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "item_code" VARCHAR(64) NOT NULL,
  "state" "vehicle_return_checklist_item_state" NOT NULL,
  "expected_quantity" INTEGER,
  "returned_quantity" INTEGER,
  "remark" TEXT,
  "captured_at" TIMESTAMPTZ(6) NOT NULL,
  "captured_by" UUID NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_return_checklist_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_return_checklist_item_revision_code_key" UNIQUE ("revision_id", "item_code"),
  CONSTRAINT "vehicle_return_checklist_item_quantity_check" CHECK (
    ("expected_quantity" IS NULL OR "expected_quantity" >= 0)
    AND ("returned_quantity" IS NULL OR "returned_quantity" >= 0)
  )
);

CREATE TABLE "vehicle_return_evidence_link" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "checklist_item_id" UUID,
  "damage_id" UUID,
  "evidence_id" UUID,
  "legacy_external_reference" TEXT,
  "evidence_purpose" VARCHAR(64) NOT NULL,
  "visibility" "vehicle_return_evidence_visibility" NOT NULL DEFAULT 'CUSTOMER_VISIBLE',
  "supersedes_link_id" UUID,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "recorded_by" UUID,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_return_evidence_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vehicle_return_evidence_link_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "vehicle_return_evidence_link_supersedes_key" UNIQUE ("supersedes_link_id"),
  CONSTRAINT "vehicle_return_evidence_link_owner_check" CHECK (
    (("checklist_item_id" IS NOT NULL)::integer + ("damage_id" IS NOT NULL)::integer) = 1
  ),
  CONSTRAINT "vehicle_return_evidence_link_authority_check" CHECK (
    (("evidence_id" IS NOT NULL)::integer + ("legacy_external_reference" IS NOT NULL)::integer) = 1
  )
);

CREATE INDEX "vehicle_return_checklist_revision_return_idx" ON "vehicle_return_checklist_revision"("vehicle_return_id");
CREATE INDEX "vehicle_return_checklist_item_code_state_idx" ON "vehicle_return_checklist_item"("item_code", "state");
CREATE INDEX "vehicle_return_evidence_link_case_idx" ON "vehicle_return_evidence_link"("closure_case_id", "recorded_at");
CREATE INDEX "vehicle_return_evidence_link_item_idx" ON "vehicle_return_evidence_link"("checklist_item_id");
CREATE INDEX "vehicle_return_evidence_link_damage_idx" ON "vehicle_return_evidence_link"("damage_id");
CREATE INDEX "vehicle_return_evidence_link_evidence_idx" ON "vehicle_return_evidence_link"("evidence_id");

ALTER TABLE "vehicle_return_checklist_revision"
  ADD CONSTRAINT "vehicle_return_checklist_revision_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_checklist_revision_return_fkey" FOREIGN KEY ("vehicle_return_id") REFERENCES "vehicle_return"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_checklist_revision_actor_fkey" FOREIGN KEY ("captured_by") REFERENCES "user"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_checklist_revision_supersedes_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "vehicle_return_checklist_revision"("id") ON DELETE RESTRICT;
ALTER TABLE "vehicle_return_checklist_item"
  ADD CONSTRAINT "vehicle_return_checklist_item_revision_fkey" FOREIGN KEY ("revision_id") REFERENCES "vehicle_return_checklist_revision"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_checklist_item_actor_fkey" FOREIGN KEY ("captured_by") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "vehicle_return_evidence_link"
  ADD CONSTRAINT "vehicle_return_evidence_link_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_evidence_link_item_fkey" FOREIGN KEY ("checklist_item_id") REFERENCES "vehicle_return_checklist_item"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_evidence_link_damage_fkey" FOREIGN KEY ("damage_id") REFERENCES "vehicle_return_damage"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_evidence_link_evidence_fkey" FOREIGN KEY ("evidence_id") REFERENCES "asset_work_order_evidence"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_evidence_link_supersedes_fkey" FOREIGN KEY ("supersedes_link_id") REFERENCES "vehicle_return_evidence_link"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "vehicle_return_evidence_link_actor_fkey" FOREIGN KEY ("recorded_by") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_case"
  ADD CONSTRAINT "subscription_closure_case_current_checklist_revision_fkey" FOREIGN KEY ("current_checklist_revision_id") REFERENCES "vehicle_return_checklist_revision"("id") ON DELETE RESTRICT;

CREATE FUNCTION "stage1_return_append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stage1 return evidence facts are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "vehicle_return_checklist_revision_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_return_checklist_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE TRIGGER "vehicle_return_checklist_item_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_return_checklist_item"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE TRIGGER "vehicle_return_evidence_link_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_return_evidence_link"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();

CREATE FUNCTION "stage1_return_document_attestation_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."document_type" = 'RETURN_MANIFEST' AND NEW."stage" IN ('SIGNED', 'ARCHIVED') THEN
    IF NEW."attestation_mode" IS NULL THEN
      IF NEW."signed_by" IS NULL OR NEW."signed_file_id" IS NULL THEN
        RAISE EXCEPTION 'return manifest attestation mode is required';
      END IF;
      NEW."attestation_mode" := 'CUSTOMER_SIGNED';
    END IF;
    IF NEW."attestation_mode" IN ('CUSTOMER_REFUSED', 'CUSTOMER_ABSENT')
       AND (NEW."attestation_snapshot" IS NULL OR NEW."attestation_snapshot_hash" IS NULL) THEN
      RAISE EXCEPTION 'unilateral return manifest attestation evidence is required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subscription_closure_document_attestation_guard"
  BEFORE INSERT OR UPDATE ON "subscription_closure_document_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_document_attestation_guard"();
