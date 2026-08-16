-- Converge previously archived Stage 2 handovers onto their authoritative
-- signed contract artifact. The strict predicates keep the repair idempotent
-- and avoid reviving cancelled, deleted, or incomplete records.
UPDATE "contract" AS c
SET
  "status" = 'ARCHIVED',
  "signed_at" = COALESCE(c."signed_at", h."completed_at", h."archived_at"),
  "archived_at" = h."archived_at",
  "file_id" = h."signed_document_file_id",
  "updated_at" = CURRENT_TIMESTAMP
FROM "vehicle_delivery_handover" AS h
WHERE c."id" = h."handover_contract_id"
  AND c."deleted_at" IS NULL
  AND h."deleted_at" IS NULL
  AND c."status" IN ('SIGNED', 'ARCHIVED')
  AND h."status" = 'ARCHIVED'
  AND h."archive_status" = 'ARCHIVED'
  AND h."archived_at" IS NOT NULL
  AND h."signed_document_file_id" IS NOT NULL
  AND h."signed_object_key" IS NOT NULL
  AND h."signed_pdf_hash" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "file_object" AS f
    WHERE f."id" = h."signed_document_file_id"
  )
  AND (
    c."status" <> 'ARCHIVED'
    OR c."archived_at" IS DISTINCT FROM h."archived_at"
    OR c."file_id" IS DISTINCT FROM h."signed_document_file_id"
  );
