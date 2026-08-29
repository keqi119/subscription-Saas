CREATE TYPE "subscription_closure_financial_status" AS ENUM (
  'DRAFT', 'AWAITING_CUSTOMER', 'PARTIALLY_PAID', 'DISPUTED', 'COLLECTION_PENDING', 'LEGAL_COLLECTION', 'SETTLED', 'WRITTEN_OFF'
);
CREATE TYPE "subscription_closure_receivable_disposition_type" AS ENUM (
  'OPEN', 'PAID', 'MANUAL_PAYMENT_CONFIRMED', 'WAIVED', 'WRITTEN_OFF', 'DISPUTED', 'COLLECTION_PENDING', 'LEGAL_COLLECTION'
);
CREATE TYPE "subscription_closure_legal_event_type" AS ENUM (
  'TRANSFERRED', 'NOTICE_SENT', 'CLAIM_FILED', 'JUDGMENT_RECORDED', 'SETTLEMENT_RECORDED', 'EXECUTION_RECEIVED', 'CLOSED'
);

ALTER TABLE "subscription_closure_case"
  ADD COLUMN "operational_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "financial_status" "subscription_closure_financial_status" NOT NULL DEFAULT 'DRAFT';

ALTER TABLE "subscription_closure_settlement_revision"
  ADD COLUMN "published_at" TIMESTAMPTZ(6),
  ADD COLUMN "publication_snapshot" JSONB,
  ADD CONSTRAINT "subscription_closure_settlement_publication_check" CHECK (
    ("stage" = 'FINALIZED' AND "published_at" IS NOT NULL AND "publication_snapshot" IS NOT NULL)
    OR ("stage" <> 'FINALIZED' AND "published_at" IS NULL AND "publication_snapshot" IS NULL)
  ) NOT VALID;

CREATE TABLE "subscription_closure_receivable_disposition" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "charge_line_id" UUID,
  "disposition" "subscription_closure_receivable_disposition_type" NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "owner_type" VARCHAR(32) NOT NULL,
  "owner_id" UUID,
  "proof_file_id" UUID,
  "approval_id" UUID,
  "detail_snapshot" JSONB NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "supersedes_disposition_id" UUID,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_receivable_disposition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_receivable_disposition_source_key" UNIQUE ("source_type", "source_id", "source_key"),
  CONSTRAINT "subscription_closure_receivable_disposition_supersedes_key" UNIQUE ("supersedes_disposition_id"),
  CONSTRAINT "subscription_closure_receivable_disposition_amount_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "subscription_closure_receivable_disposition_owner_check" CHECK (
    "disposition" IN ('PAID', 'MANUAL_PAYMENT_CONFIRMED', 'WAIVED', 'WRITTEN_OFF') OR "owner_type" <> ''
  )
);

CREATE TABLE "subscription_closure_legal_collection_case" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "bill_id" UUID NOT NULL,
  "transferred_amount_cents" BIGINT NOT NULL,
  "evidence_package_hash" VARCHAR(64) NOT NULL,
  "owner_type" VARCHAR(32) NOT NULL,
  "owner_id" UUID,
  "external_reference" VARCHAR(255),
  "opened_at" TIMESTAMPTZ(6) NOT NULL,
  "closed_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_legal_collection_case_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_legal_case_bill_key" UNIQUE ("closure_case_id", "bill_id"),
  CONSTRAINT "subscription_closure_legal_case_amount_check" CHECK ("transferred_amount_cents" > 0),
  CONSTRAINT "subscription_closure_legal_case_hash_check" CHECK ("evidence_package_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "subscription_closure_legal_collection_event" (
  "id" UUID NOT NULL,
  "legal_case_id" UUID NOT NULL,
  "event_type" "subscription_closure_legal_event_type" NOT NULL,
  "amount_cents" BIGINT,
  "event_snapshot" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_by" UUID NOT NULL,
  "source_type" VARCHAR(64) NOT NULL,
  "source_id" UUID NOT NULL,
  "source_key" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_legal_collection_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_legal_event_source_key" UNIQUE ("source_type", "source_id", "source_key")
);

CREATE TABLE "subscription_closure_evidence_package_export" (
  "id" UUID NOT NULL,
  "closure_case_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "manifest_snapshot" JSONB NOT NULL,
  "manifest_hash" VARCHAR(64) NOT NULL,
  "file_sha256" VARCHAR(64),
  "file_id" UUID,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_closure_evidence_package_export_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_closure_evidence_export_case_version_key" UNIQUE ("closure_case_id", "version"),
  CONSTRAINT "subscription_closure_evidence_export_case_hash_key" UNIQUE ("closure_case_id", "manifest_hash"),
  CONSTRAINT "subscription_closure_evidence_export_hash_check" CHECK ("manifest_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_closure_evidence_export_file_hash_check" CHECK ("file_sha256" IS NULL OR "file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_closure_evidence_export_file_integrity_check" CHECK (("file_id" IS NULL) = ("file_sha256" IS NULL))
);

ALTER TABLE "subscription_closure_receivable_disposition"
  ADD CONSTRAINT "subscription_closure_receivable_disposition_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_bill_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_line_fkey" FOREIGN KEY ("charge_line_id") REFERENCES "subscription_closure_charge_line"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_proof_fkey" FOREIGN KEY ("proof_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_approval_fkey" FOREIGN KEY ("approval_id") REFERENCES "business_exception_approval"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_supersedes_fkey" FOREIGN KEY ("supersedes_disposition_id") REFERENCES "subscription_closure_receivable_disposition"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_receivable_disposition_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_legal_collection_case"
  ADD CONSTRAINT "subscription_closure_legal_case_closure_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_legal_case_bill_fkey" FOREIGN KEY ("bill_id") REFERENCES "receivable_bill"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_legal_case_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_legal_collection_event"
  ADD CONSTRAINT "subscription_closure_legal_event_case_fkey" FOREIGN KEY ("legal_case_id") REFERENCES "subscription_closure_legal_collection_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_legal_event_actor_fkey" FOREIGN KEY ("recorded_by") REFERENCES "user"("id") ON DELETE RESTRICT;
ALTER TABLE "subscription_closure_evidence_package_export"
  ADD CONSTRAINT "subscription_closure_evidence_export_case_fkey" FOREIGN KEY ("closure_case_id") REFERENCES "subscription_closure_case"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_evidence_export_file_fkey" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "subscription_closure_evidence_export_actor_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;

CREATE INDEX "subscription_closure_receivable_disposition_case_bill_idx" ON "subscription_closure_receivable_disposition"("closure_case_id", "bill_id");
CREATE INDEX "subscription_closure_receivable_disposition_approval_idx" ON "subscription_closure_receivable_disposition"("approval_id");
CREATE INDEX "subscription_closure_legal_event_case_time_idx" ON "subscription_closure_legal_collection_event"("legal_case_id", "occurred_at");
CREATE TRIGGER "subscription_closure_receivable_disposition_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_receivable_disposition"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE TRIGGER "subscription_closure_legal_collection_event_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_legal_collection_event"
  FOR EACH ROW EXECUTE FUNCTION "stage1_return_append_only_guard"();
CREATE FUNCTION "stage1_evidence_export_immutability_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."file_id" IS NULL AND OLD."file_sha256" IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'completed evidence exports are append-only';
  END IF;
  IF OLD."file_id" IS NULL
     AND OLD."file_sha256" IS NULL
     AND NEW."file_id" IS NOT NULL
     AND NEW."file_sha256" IS NOT NULL
     AND (to_jsonb(NEW) - 'file_id' - 'file_sha256')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - 'file_id' - 'file_sha256') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'completed evidence exports are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subscription_closure_evidence_package_export_append_only"
  BEFORE UPDATE OR DELETE ON "subscription_closure_evidence_package_export"
  FOR EACH ROW EXECUTE FUNCTION "stage1_evidence_export_immutability_guard"();

ALTER TABLE "vehicle_return_checklist_revision"
  ADD CONSTRAINT "vehicle_return_checklist_revision_number_positive_check"
  CHECK ("revision_number" > 0);

ALTER TABLE "vehicle_condition_delta_revision"
  ADD CONSTRAINT "vehicle_condition_delta_revision_number_positive_check"
  CHECK ("revision_number" > 0);

CREATE FUNCTION "stage1_closure_lineage_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'subscription_closure_case' THEN
    IF NEW."current_checklist_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_checklist_revision" r
      WHERE r."id" = NEW."current_checklist_revision_id" AND r."closure_case_id" = NEW."id"
    ) THEN RAISE EXCEPTION 'current checklist revision belongs to another closure case'; END IF;
    IF NEW."current_checklist_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_checklist_revision" r
      WHERE r."id" = NEW."current_checklist_revision_id"
        AND r."closure_case_id" = NEW."id"
        AND r."revision_number" = (
          SELECT MAX(head."revision_number")
          FROM "vehicle_return_checklist_revision" head
          WHERE head."closure_case_id" = NEW."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "vehicle_return_checklist_revision" child
          WHERE child."supersedes_revision_id" = r."id"
        )
    ) THEN RAISE EXCEPTION 'current checklist revision is not the chain head'; END IF;
    IF NEW."current_delta_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_condition_delta_revision" r
      WHERE r."id" = NEW."current_delta_revision_id" AND r."closure_case_id" = NEW."id"
    ) THEN RAISE EXCEPTION 'current delta revision belongs to another closure case'; END IF;
    IF NEW."current_delta_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_condition_delta_revision" r
      WHERE r."id" = NEW."current_delta_revision_id"
        AND r."closure_case_id" = NEW."id"
        AND r."revision_number" = (
          SELECT MAX(head."revision_number")
          FROM "vehicle_condition_delta_revision" head
          WHERE head."closure_case_id" = NEW."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "vehicle_condition_delta_revision" child
          WHERE child."supersedes_revision_id" = r."id"
        )
    ) THEN RAISE EXCEPTION 'current delta revision is not the chain head'; END IF;
    IF NEW."current_settlement_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_settlement_revision" r
      WHERE r."id" = NEW."current_settlement_revision_id" AND r."closure_case_id" = NEW."id"
    ) THEN RAISE EXCEPTION 'current settlement revision belongs to another closure case'; END IF;
    IF NEW."current_settlement_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_settlement_revision" r
      WHERE r."id" = NEW."current_settlement_revision_id"
        AND r."closure_case_id" = NEW."id"
        AND r."revision_number" = (
          SELECT MAX(head."revision_number")
          FROM "subscription_closure_settlement_revision" head
          WHERE head."closure_case_id" = NEW."id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "subscription_closure_settlement_revision" child
          WHERE child."supersedes_revision_id" = r."id"
        )
    ) THEN RAISE EXCEPTION 'current settlement revision is not the chain head'; END IF;

  ELSIF TG_TABLE_NAME = 'vehicle_return_checklist_revision' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "subscription_closure_case" c
      WHERE c."id" = NEW."closure_case_id" AND c."vehicle_return_id" = NEW."vehicle_return_id"
    ) THEN RAISE EXCEPTION 'return checklist lineage mismatch'; END IF;
    IF NEW."supersedes_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_checklist_revision" r
      WHERE r."id" = NEW."supersedes_revision_id"
        AND r."closure_case_id" = NEW."closure_case_id"
        AND r."vehicle_return_id" = NEW."vehicle_return_id"
    ) THEN RAISE EXCEPTION 'return checklist predecessor lineage mismatch'; END IF;
    IF (
      NEW."revision_number" = 1 AND (
        NEW."supersedes_revision_id" IS NOT NULL OR EXISTS (
          SELECT 1 FROM "vehicle_return_checklist_revision" r
          WHERE r."closure_case_id" = NEW."closure_case_id"
        )
      )
    ) OR (
      NEW."revision_number" > 1 AND (
        NEW."supersedes_revision_id" IS NULL OR NOT EXISTS (
          SELECT 1
          FROM "vehicle_return_checklist_revision" r
          JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
          WHERE r."id" = NEW."supersedes_revision_id"
            AND r."closure_case_id" = NEW."closure_case_id"
            AND r."vehicle_return_id" = NEW."vehicle_return_id"
            AND r."revision_number" = NEW."revision_number" - 1
            AND c."current_checklist_revision_id" = r."id"
        )
      )
    ) THEN RAISE EXCEPTION 'return checklist revision chain mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'vehicle_return_evidence_link' THEN
    IF NEW."checklist_item_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_checklist_item" i
      JOIN "vehicle_return_checklist_revision" r ON r."id" = i."revision_id"
      WHERE i."id" = NEW."checklist_item_id" AND r."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'return evidence checklist owner mismatch'; END IF;
    IF NEW."damage_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_damage" d
      JOIN "subscription_closure_case" c ON c."vehicle_return_id" = d."return_id"
      WHERE d."id" = NEW."damage_id" AND c."id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'return evidence damage owner mismatch'; END IF;
    IF NEW."evidence_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "asset_work_order_evidence" e
      JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
      WHERE e."id" = NEW."evidence_id"
        AND e."work_order_id" IN (c."return_asset_work_order_id", c."recovery_asset_work_order_id", c."reconditioning_asset_work_order_id")
    ) THEN RAISE EXCEPTION 'return evidence file owner mismatch'; END IF;
    IF NEW."supersedes_link_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_return_evidence_link" l
      WHERE l."id" = NEW."supersedes_link_id" AND l."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'return evidence predecessor lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'vehicle_condition_delta_revision' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "subscription_closure_case" c
      JOIN "vehicle_return_checklist_revision" r ON r."id" = NEW."return_checklist_revision_id"
      JOIN "vehicle_delivery_handover" d ON d."id" = NEW."delivery_document_revision_id"
      JOIN "file_object" f ON f."id" = d."signed_document_file_id"
      WHERE c."id" = NEW."closure_case_id"
        AND r."closure_case_id" = c."id"
        AND r."manifest_hash" = NEW."return_manifest_hash"
        AND d."order_id" = c."order_id"
        AND d."status" = 'ARCHIVED'
        AND d."archive_status" = 'ARCHIVED'
        AND d."archived_at" IS NOT NULL
        AND d."signed_document_file_id" IS NOT NULL
        AND d."signed_pdf_hash" ~ '^[0-9a-f]{64}$'
        AND d."signed_pdf_hash" = NEW."delivery_document_hash"
    ) THEN RAISE EXCEPTION 'condition delta authority lineage mismatch'; END IF;
    IF NEW."supersedes_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_condition_delta_revision" r
      WHERE r."id" = NEW."supersedes_revision_id" AND r."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'condition delta predecessor lineage mismatch'; END IF;
    IF (
      NEW."revision_number" = 1 AND (
        NEW."supersedes_revision_id" IS NOT NULL OR EXISTS (
          SELECT 1 FROM "vehicle_condition_delta_revision" r
          WHERE r."closure_case_id" = NEW."closure_case_id"
        )
      )
    ) OR (
      NEW."revision_number" > 1 AND (
        NEW."supersedes_revision_id" IS NULL OR NOT EXISTS (
          SELECT 1
          FROM "vehicle_condition_delta_revision" r
          JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
          WHERE r."id" = NEW."supersedes_revision_id"
            AND r."closure_case_id" = NEW."closure_case_id"
            AND r."revision_number" = NEW."revision_number" - 1
            AND c."current_delta_revision_id" = r."id"
        )
      )
    ) THEN RAISE EXCEPTION 'condition delta revision chain mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_settlement_revision' THEN
    IF NEW."supersedes_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_settlement_revision" r
      WHERE r."id" = NEW."supersedes_revision_id" AND r."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'settlement predecessor lineage mismatch'; END IF;
    IF (
      NEW."revision_number" = 1 AND (
        NEW."supersedes_revision_id" IS NOT NULL OR EXISTS (
          SELECT 1 FROM "subscription_closure_settlement_revision" r
          WHERE r."closure_case_id" = NEW."closure_case_id"
        )
      )
    ) OR (
      NEW."revision_number" > 1 AND (
        NEW."supersedes_revision_id" IS NULL OR NOT EXISTS (
          SELECT 1
          FROM "subscription_closure_settlement_revision" r
          JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
          WHERE r."id" = NEW."supersedes_revision_id"
            AND r."closure_case_id" = NEW."closure_case_id"
            AND r."revision_number" = NEW."revision_number" - 1
            AND c."current_settlement_revision_id" = r."id"
        )
      )
    ) THEN RAISE EXCEPTION 'settlement revision chain mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_charge_line' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "subscription_closure_case" c
      JOIN "subscription_closure_settlement_revision" s ON s."id" = NEW."settlement_revision_id"
      WHERE c."id" = NEW."closure_case_id"
        AND s."closure_case_id" = c."id"
        AND c."contract_id" = NEW."contract_id"
    ) THEN RAISE EXCEPTION 'closure charge settlement or contract lineage mismatch'; END IF;
    IF NEW."delta_revision_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_condition_delta_revision" r
      WHERE r."id" = NEW."delta_revision_id" AND r."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'closure charge delta lineage mismatch'; END IF;
    IF NEW."delta_item_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "vehicle_condition_delta_item" i
      JOIN "vehicle_condition_delta_revision" r ON r."id" = i."revision_id"
      WHERE i."id" = NEW."delta_item_id"
        AND r."closure_case_id" = NEW."closure_case_id"
        AND (NEW."delta_revision_id" IS NULL OR r."id" = NEW."delta_revision_id")
    ) THEN RAISE EXCEPTION 'closure charge delta item lineage mismatch'; END IF;
    IF NEW."clause_snapshot_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "contract_charge_clause_snapshot" s
      WHERE s."id" = NEW."clause_snapshot_id" AND s."contract_id" = NEW."contract_id"
    ) THEN RAISE EXCEPTION 'closure charge clause lineage mismatch'; END IF;
    IF NEW."bill_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "receivable_bill" b
      JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
      WHERE b."id" = NEW."bill_id" AND b."order_id" = c."order_id"
    ) THEN RAISE EXCEPTION 'closure charge bill lineage mismatch'; END IF;
    IF NEW."supersedes_line_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_charge_line" l
      WHERE l."id" = NEW."supersedes_line_id" AND l."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'closure charge predecessor lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_customer_response' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "subscription_closure_settlement_revision" s
      WHERE s."id" = NEW."settlement_revision_id"
        AND s."closure_case_id" = NEW."closure_case_id"
        AND s."result_hash" = NEW."settlement_hash"
    ) THEN RAISE EXCEPTION 'customer response settlement lineage mismatch'; END IF;
    IF NEW."supersedes_response_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_customer_response" r
      WHERE r."id" = NEW."supersedes_response_id" AND r."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'customer response predecessor lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_charge_dispute' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "subscription_closure_customer_response" r
      JOIN "subscription_closure_settlement_revision" s ON s."id" = r."settlement_revision_id"
      JOIN "subscription_closure_charge_line" l ON l."id" = NEW."charge_line_id"
      WHERE r."id" = NEW."customer_response_id"
        AND r."closure_case_id" = NEW."closure_case_id"
        AND l."closure_case_id" = NEW."closure_case_id"
        AND (l."settlement_revision_id" = s."id" OR l."settlement_revision_id" = s."supersedes_revision_id")
    ) THEN RAISE EXCEPTION 'closure dispute response or charge lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_charge_dispute_decision' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "subscription_closure_charge_dispute" d
      WHERE d."id" = NEW."dispute_id" AND d."closure_case_id" = NEW."closure_case_id"
    ) THEN RAISE EXCEPTION 'closure dispute decision lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_receivable_disposition' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "receivable_bill" b
      JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
      WHERE b."id" = NEW."bill_id" AND b."order_id" = c."order_id"
    ) THEN RAISE EXCEPTION 'closure disposition bill lineage mismatch'; END IF;
    IF NEW."charge_line_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_charge_line" l
      WHERE l."id" = NEW."charge_line_id"
        AND l."closure_case_id" = NEW."closure_case_id"
        AND l."bill_id" = NEW."bill_id"
    ) THEN RAISE EXCEPTION 'closure disposition charge lineage mismatch'; END IF;
    IF NEW."approval_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "business_exception_approval" a
      WHERE a."id" = NEW."approval_id"
        AND a."subject_type" = 'SETTLEMENT_CASE'
        AND a."subject_id" = NEW."closure_case_id"
        AND a."status" = 'APPROVED'
    ) THEN RAISE EXCEPTION 'closure disposition approval lineage mismatch'; END IF;
    IF NEW."supersedes_disposition_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "subscription_closure_receivable_disposition" d
      WHERE d."id" = NEW."supersedes_disposition_id"
        AND d."closure_case_id" = NEW."closure_case_id"
        AND d."bill_id" = NEW."bill_id"
    ) THEN RAISE EXCEPTION 'closure disposition predecessor lineage mismatch'; END IF;

  ELSIF TG_TABLE_NAME = 'subscription_closure_legal_collection_case' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "receivable_bill" b
      JOIN "subscription_closure_case" c ON c."id" = NEW."closure_case_id"
      WHERE b."id" = NEW."bill_id" AND b."order_id" = c."order_id"
    ) THEN RAISE EXCEPTION 'legal collection bill lineage mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subscription_closure_case_stage1_lineage"
  BEFORE INSERT OR UPDATE ON "subscription_closure_case"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "vehicle_return_checklist_revision_lineage"
  BEFORE INSERT ON "vehicle_return_checklist_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "vehicle_return_evidence_link_lineage"
  BEFORE INSERT ON "vehicle_return_evidence_link"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "vehicle_condition_delta_revision_lineage"
  BEFORE INSERT ON "vehicle_condition_delta_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_settlement_revision_lineage"
  BEFORE INSERT ON "subscription_closure_settlement_revision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_charge_line_lineage"
  BEFORE INSERT ON "subscription_closure_charge_line"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_customer_response_lineage"
  BEFORE INSERT ON "subscription_closure_customer_response"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_charge_dispute_lineage"
  BEFORE INSERT ON "subscription_closure_charge_dispute"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_charge_dispute_decision_lineage"
  BEFORE INSERT ON "subscription_closure_charge_dispute_decision"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_receivable_disposition_lineage"
  BEFORE INSERT ON "subscription_closure_receivable_disposition"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
CREATE TRIGGER "subscription_closure_legal_collection_case_lineage"
  BEFORE INSERT ON "subscription_closure_legal_collection_case"
  FOR EACH ROW EXECUTE FUNCTION "stage1_closure_lineage_guard"();
