import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const schema = fs.readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
const migrationPath = path.resolve(
  __dirname,
  "../prisma/migrations/20260725120000_stage2_esign_provider_mapping/migration.sql"
);
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

function extractBlock(source: string, kind: "enum" | "model", name: string): string {
  const match = source.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`));
  return match?.[0] ?? "";
}

describe("Stage 2 eSign schema migration", () => {
  it("defines the persisted signing stage, document, slot, and provider action enums", () => {
    expect(extractBlock(schema, "enum", "ESignSigningStage")).toContain(
      "STAGE1_SUBSCRIPTION_CONTRACT"
    );
    expect(extractBlock(schema, "enum", "ESignSigningStage")).toContain(
      "STAGE2_DELIVERY_HANDOVER"
    );
    expect(extractBlock(schema, "enum", "ESignDocumentType")).toContain(
      "SUBSCRIPTION_CONTRACT"
    );
    expect(extractBlock(schema, "enum", "ESignDocumentType")).toContain("DELIVERY_HANDOVER");
    expect(extractBlock(schema, "enum", "ESignSlotId")).toMatch(
      /STAGE1_MAIN_CUSTOMER[\s\S]*STAGE1_MAIN_PLATFORM[\s\S]*STAGE1_ATTACHMENT1_CUSTOMER[\s\S]*STAGE1_ATTACHMENT1_PLATFORM[\s\S]*STAGE2_HANDOVER_CUSTOMER[\s\S]*STAGE2_HANDOVER_PLATFORM/
    );
    expect(extractBlock(schema, "enum", "ESignProviderActionType")).toMatch(
      /CUSTOMER_MANUAL_SIGN[\s\S]*PLATFORM_AUTO_SEAL/
    );
  });

  it("adds required typed task fields after a Stage 1 backfill", () => {
    const taskModel = extractBlock(schema, "model", "ContractESignTask");
    const addColumnsAt = migration.indexOf('ADD COLUMN "signing_stage" "esign_signing_stage"');
    const backfillAt = migration.indexOf('UPDATE "contract_esign_task"');
    const notNullAt = migration.indexOf(
      'ALTER COLUMN "signing_stage" SET NOT NULL'
    );

    expect(taskModel).toMatch(
      /signingStage\s+ESignSigningStage\s+@default\(STAGE1_SUBSCRIPTION_CONTRACT\)\s+@map\("signing_stage"\)/
    );
    expect(taskModel).toMatch(
      /documentType\s+ESignDocumentType\s+@default\(SUBSCRIPTION_CONTRACT\)\s+@map\("document_type"\)/
    );
    expect(taskModel).toContain("@@index([signingStage, taskStatus])");
    expect(migration).toContain(
      'ADD COLUMN "signing_stage" "esign_signing_stage" DEFAULT \'STAGE1_SUBSCRIPTION_CONTRACT\','
    );
    expect(migration).toContain(
      'ADD COLUMN "document_type" "esign_document_type" DEFAULT \'SUBSCRIPTION_CONTRACT\''
    );
    expect(addColumnsAt).toBeGreaterThanOrEqual(0);
    expect(backfillAt).toBeGreaterThan(addColumnsAt);
    expect(notNullAt).toBeGreaterThan(backfillAt);
    expect(migration).toContain(
      `SET "signing_stage" = 'STAGE1_SUBSCRIPTION_CONTRACT',\n    "document_type" = 'SUBSCRIPTION_CONTRACT'`
    );
  });

  it("adds nullable typed signer fields and retry state without unsafe legacy backfill", () => {
    const signerModel = extractBlock(schema, "model", "ContractESignSigner");

    expect(signerModel).toMatch(/slotId\s+ESignSlotId\?\s+@map\("slot_id"\)/);
    expect(signerModel).toMatch(
      /documentType\s+ESignDocumentType\?\s+@map\("document_type"\)/
    );
    expect(signerModel).toMatch(
      /providerActionType\s+ESignProviderActionType\?\s+@map\("provider_action_type"\)/
    );
    expect(signerModel).toMatch(/required\s+Boolean\s+@default\(true\)/);
    expect(signerModel).toMatch(
      /providerTransactionId\s+String\?\s+@unique\s+@map\("provider_transaction_id"\)\s+@db\.VarChar\(32\)/
    );
    expect(signerModel).toMatch(
      /attemptCount\s+Int\s+@default\(0\)\s+@map\("attempt_count"\)/
    );
    expect(signerModel).toMatch(
      /lastAttemptAt\s+DateTime\?\s+@map\("last_attempt_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(signerModel).toMatch(
      /nextRetryAt\s+DateTime\?\s+@map\("next_retry_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(signerModel).toMatch(
      /lastErrorCode\s+String\?\s+@map\("last_error_code"\)\s+@db\.VarChar\(128\)/
    );
    expect(signerModel).toMatch(
      /lastErrorMessage\s+String\?\s+@map\("last_error_message"\)\s+@db\.Text/
    );
    expect(signerModel).toMatch(
      /claimExpiresAt\s+DateTime\?\s+@map\("claim_expires_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(signerModel).toContain("@@unique([taskId, slotId])");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "contract_esign_signer_task_id_slot_id_key"'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "contract_esign_signer_provider_transaction_id_key"'
    );
    expect(migration).not.toMatch(/UPDATE\s+"contract_esign_signer"/);
  });

  it("adds callback correlation and provider-scoped payload deduplication", () => {
    const callbackModel = extractBlock(schema, "model", "ContractESignCallbackLog");

    expect(callbackModel).toMatch(
      /providerTransactionId\s+String\?\s+@map\("provider_transaction_id"\)\s+@db\.VarChar\(32\)/
    );
    expect(callbackModel).toMatch(
      /payloadHash\s+String\?\s+@map\("payload_hash"\)\s+@db\.Char\(64\)/
    );
    expect(callbackModel).toContain("@@unique([provider, payloadHash])");
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "contract_esign_callback_log_provider_payload_hash_key"'
    );
  });

  it("adds Stage 2 PDF integrity and retryable archive metadata while preserving file links", () => {
    const handoverModel = extractBlock(schema, "model", "VehicleDeliveryHandover");

    expect(handoverModel).toMatch(/sourceDocumentFileId\s+String\?/);
    expect(handoverModel).toMatch(/signedDocumentFileId\s+String\?/);
    expect(handoverModel).toMatch(/archiveStatus\s+DeliveryHandoverArchiveStatus/);
    expect(handoverModel).toMatch(
      /sourcePdfHash\s+String\?\s+@map\("source_pdf_hash"\)\s+@db\.Char\(64\)/
    );
    expect(handoverModel).toMatch(
      /signedPdfHash\s+String\?\s+@map\("signed_pdf_hash"\)\s+@db\.Char\(64\)/
    );
    expect(handoverModel).toMatch(
      /manifestHash\s+String\?\s+@map\("manifest_hash"\)\s+@db\.Char\(64\)/
    );
    expect(handoverModel).toMatch(
      /artifactVersion\s+Int\s+@default\(1\)\s+@map\("artifact_version"\)/
    );
    expect(handoverModel).toMatch(
      /archiveRetryCount\s+Int\s+@default\(0\)\s+@map\("archive_retry_count"\)/
    );
    expect(handoverModel).toMatch(
      /archiveLastAttemptAt\s+DateTime\?\s+@map\("archive_last_attempt_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(handoverModel).toMatch(
      /archiveLastError\s+String\?\s+@map\("archive_last_error"\)\s+@db\.Text/
    );
  });
});
