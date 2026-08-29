ALTER TABLE "vehicle_return_evidence_link"
  DROP CONSTRAINT "vehicle_return_evidence_link_owner_check";

ALTER TABLE "vehicle_return_evidence_link"
  ADD CONSTRAINT "vehicle_return_evidence_link_owner_check" CHECK (
    (
      "evidence_purpose" = 'ATTESTATION_PROOF'
      AND "checklist_item_id" IS NULL
      AND "damage_id" IS NULL
    )
    OR
    (
      "evidence_purpose" <> 'ATTESTATION_PROOF'
      AND (("checklist_item_id" IS NOT NULL)::integer + ("damage_id" IS NOT NULL)::integer) = 1
    )
  );
