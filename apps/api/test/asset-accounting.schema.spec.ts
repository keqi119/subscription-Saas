import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "..");
const schema = readFileSync(resolve(apiRoot, "prisma/schema.prisma"), "utf8");
const migrationPath = resolve(
  apiRoot,
  "prisma/migrations/20260821000000_stage1c_cost_ledger_exception_approval/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function prismaBlock(kind: "enum" | "model", name: string) {
  return schema.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

function enumValues(name: string) {
  return prismaBlock("enum", name)
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("@@"));
}

function migrationEnumValues(name: string) {
  const body = migration.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^;]+)\\);`))?.[1];
  return body ? Array.from(body.matchAll(/'([^']+)'/g), (match) => match[1]) : [];
}

function migrationFunction(name: string) {
  return (
    migration.match(new RegExp(`CREATE FUNCTION "${name}"\\(\\)[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? ""
  );
}

function migrationTrigger(name: string) {
  return migration.match(new RegExp(`CREATE TRIGGER "${name}"[\\s\\S]*?;`))?.[0] ?? "";
}

const enumContracts = [
  {
    prismaName: "VehicleCostEntryKind",
    sqlName: "vehicle_cost_entry_kind",
    values: ["ORIGINAL", "REVERSAL"]
  },
  {
    prismaName: "VehicleCostActionType",
    sqlName: "vehicle_cost_action_type",
    values: [
      "ACTUAL_COST",
      "RESPONSIBILITY_CONFIRMED",
      "RECOVERY_EXPOSURE",
      "RECOVERY_RECEIVED",
      "WAIVER",
      "WRITE_OFF"
    ]
  },
  {
    prismaName: "VehicleCostCategory",
    sqlName: "vehicle_cost_category",
    values: [
      "DAMAGE",
      "CLEANING",
      "REPAIR",
      "MAINTENANCE",
      "EXCESS_MILEAGE",
      "VIOLATION",
      "TOWING",
      "INSURANCE",
      "BAAS",
      "DEPRECIATION",
      "OTHER"
    ]
  },
  {
    prismaName: "VehicleCostResponsiblePartyType",
    sqlName: "vehicle_cost_responsible_party_type",
    values: ["CUSTOMER", "INSURER", "SUPPLIER", "ASSET_OWNER", "PLATFORM", "OTHER"]
  },
  {
    prismaName: "BusinessExceptionType",
    sqlName: "business_exception_type",
    values: [
      "VEHICLE_REGISTRATION_DOCUMENT_MISSING",
      "HANDOVER_EVIDENCE_EXCEPTION",
      "SETTLEMENT_WAIVER",
      "SETTLEMENT_WRITE_OFF",
      "RECOVERY_EXECUTION_APPROVAL"
    ]
  },
  {
    prismaName: "BusinessExceptionSubjectType",
    sqlName: "business_exception_subject_type",
    values: [
      "VEHICLE",
      "ORDER",
      "CONTRACT",
      "ASSET_WORK_ORDER",
      "HANDOVER_WORK_ORDER",
      "SETTLEMENT_CASE",
      "RECOVERY_CASE"
    ]
  },
  {
    prismaName: "BusinessExceptionApprovalStatus",
    sqlName: "business_exception_approval_status",
    values: ["PENDING", "APPROVED", "REJECTED", "EXPIRED"]
  },
  {
    prismaName: "BusinessExceptionDecision",
    sqlName: "business_exception_decision",
    values: ["APPROVED", "REJECTED"]
  },
  {
    prismaName: "AssetAccountingCommandType",
    sqlName: "asset_accounting_command_type",
    values: [
      "COST_APPEND",
      "COST_REVERSE",
      "EXCEPTION_REQUEST",
      "EXCEPTION_DECIDE",
      "EXCEPTION_EXPIRE"
    ]
  }
] as const;

describe("Stage 1C-C asset accounting persistence contract", () => {
  it("defines the exact approved Prisma and PostgreSQL enums", () => {
    for (const contract of enumContracts) {
      expect(enumValues(contract.prismaName), contract.prismaName).toEqual(contract.values);
      expect(migrationEnumValues(contract.sqlName), contract.sqlName).toEqual(contract.values);
    }
  });

  it("maps the immutable ledger, approval, and receipt facts with their reverse relations", () => {
    const ledger = prismaBlock("model", "VehicleCostLedgerEntry");
    const approval = prismaBlock("model", "BusinessExceptionApproval");
    const receipt = prismaBlock("model", "AssetAccountingCommandReceipt");

    expect(ledger).toContain('@@map("vehicle_cost_ledger_entry")');
    expect(approval).toContain('@@map("business_exception_approval")');
    expect(receipt).toContain('@@map("asset_accounting_command_receipt")');

    for (const field of [
      "vehicleId",
      "orderId",
      "contractId",
      "customerId",
      "assetOwnerId",
      "workOrderId",
      "evidenceId",
      "assetOwnerSnapshot",
      "evidenceSnapshot",
      "responsibilitySnapshot",
      "entryKind",
      "actionType",
      "costCategory",
      "amountCents",
      "responsiblePartyType",
      "responsiblePartyId",
      "occurredOn",
      "accountingPeriod",
      "confirmedAt",
      "confirmedBy",
      "reversalOfEntryId",
      "sourceType",
      "sourceId",
      "sourceKey",
      "createdAt"
    ]) {
      expect(ledger, `missing VehicleCostLedgerEntry.${field}`).toContain(field);
    }
    expect(ledger).not.toContain("updatedAt");
    expect(ledger).not.toContain("deletedAt");
    expect(ledger).toContain("@@index([sourceType, sourceId, sourceKey]");

    for (const field of [
      "approvalNo",
      "exceptionType",
      "subjectType",
      "subjectId",
      "subjectField",
      "subjectSnapshot",
      "subjectSnapshotHash",
      "requestReason",
      "requestEvidenceSnapshot",
      "requestedBy",
      "requestedAt",
      "requestSourceType",
      "requestSourceId",
      "requestSourceKey",
      "status",
      "version",
      "decision",
      "decisionComment",
      "decidedBy",
      "decidedAt",
      "expiryReason",
      "expiredBy",
      "expiredAt",
      "createdAt"
    ]) {
      expect(approval, `missing BusinessExceptionApproval.${field}`).toContain(field);
    }
    expect(approval).toContain("@@unique([approvalNo]");
    expect(approval).toContain("@@index([subjectType, subjectId, subjectField]");

    for (const field of [
      "sourceType",
      "sourceId",
      "sourceKey",
      "commandType",
      "payloadHash",
      "payloadSnapshot",
      "outcomeSnapshot",
      "costEntryId",
      "approvalId",
      "actorId",
      "createdAt"
    ]) {
      expect(receipt, `missing AssetAccountingCommandReceipt.${field}`).toContain(field);
    }
    expect(receipt).not.toContain("updatedAt");
    expect(receipt).not.toContain("deletedAt");
    expect(receipt).toContain("@@unique([sourceType, sourceId, sourceKey]");

    for (const [model, relation] of [
      ["Vehicle", "costLedgerEntries"],
      ["SubscriptionOrder", "costLedgerEntries"],
      ["Contract", "costLedgerEntries"],
      ["Customer", "costLedgerEntries"],
      ["AssetOwner", "costLedgerEntries"],
      ["AssetWorkOrder", "costLedgerEntries"],
      ["AssetWorkOrderEvidence", "costLedgerEntries"]
    ] as const) {
      expect(prismaBlock("model", model), `${model}.${relation}`).toContain(relation);
    }
    expect(ledger).toContain("reversalOfEntry");
    expect(ledger).toContain("reversals");
    expect(ledger).toContain("receipts");
    expect(approval).toContain("receipts");

    for (const relation of [
      "order",
      "contract",
      "customer",
      "assetOwner",
      "workOrder",
      "evidence",
      "confirmer",
      "reversalOfEntry"
    ]) {
      expect(ledger, `${relation} must preserve ledger history on delete`).toMatch(
        new RegExp(`${relation}[\\s\\S]*?onDelete: Restrict`)
      );
    }
    for (const relation of ["decider", "expirer"]) {
      expect(approval, `${relation} must preserve approval history on delete`).toMatch(
        new RegExp(`${relation}[\\s\\S]*?onDelete: Restrict`)
      );
    }
    for (const relation of ["costEntry", "approval"]) {
      expect(receipt, `${relation} must preserve the command target on delete`).toMatch(
        new RegExp(`${relation}[\\s\\S]*?onDelete: Restrict`)
      );
    }
  });

  it("declares the source, target, date/hash, amount, and approval status shapes", () => {
    for (const constraint of [
      'CONSTRAINT "vehicle_cost_ledger_entry_amount_nonzero_chk" CHECK ("amount_cents" <> 0)',
      'CONSTRAINT "vehicle_cost_ledger_entry_kind_amount_shape_chk"',
      'CONSTRAINT "vehicle_cost_ledger_entry_accounting_period_chk" CHECK ("accounting_period" ~ \'^[0-9]{4}-(0[1-9]|1[0-2])$\')',
      'CONSTRAINT "vehicle_cost_ledger_entry_source_key_not_blank_chk"',
      'CONSTRAINT "business_exception_approval_snapshot_hash_chk" CHECK ("subject_snapshot_hash" ~ \'^[0-9a-f]{64}$\')',
      'CONSTRAINT "business_exception_approval_request_source_key_not_blank_chk"',
      'CONSTRAINT "business_exception_approval_status_shape_chk"',
      'CONSTRAINT "business_exception_approval_version_nonnegative_chk" CHECK ("version" >= 0)',
      'CONSTRAINT "asset_accounting_command_receipt_payload_hash_chk" CHECK ("payload_hash" ~ \'^[0-9a-f]{64}$\')',
      'CONSTRAINT "asset_accounting_command_receipt_target_shape_chk"',
      'CONSTRAINT "asset_accounting_command_receipt_source_key_not_blank_chk"'
    ]) {
      expect(migration, constraint).toContain(constraint);
    }

    expect(migration).toContain(
      '("entry_kind" = \'ORIGINAL\' AND "amount_cents" > 0 AND "reversal_of_entry_id" IS NULL)'
    );
    expect(migration).toContain(
      '("entry_kind" = \'REVERSAL\' AND "amount_cents" < 0 AND "reversal_of_entry_id" IS NOT NULL)'
    );
    expect(migration).toContain(
      '("cost_entry_id" IS NOT NULL AND "approval_id" IS NULL)\n        OR ("cost_entry_id" IS NULL AND "approval_id" IS NOT NULL)'
    );
    expect(migration).toContain(
      '("status" = \'PENDING\' AND "decision" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)'
    );
    expect(migration).toContain(
      '("status" = \'APPROVED\' AND "decision" = \'APPROVED\' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)'
    );
    expect(migration).toContain(
      '("status" = \'REJECTED\' AND "decision" = \'REJECTED\' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)'
    );
  });

  it("creates the one-to-one reversal and live approval uniqueness authorities", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "vehicle_cost_ledger_entry_reversal_of_entry_id_key" ON "vehicle_cost_ledger_entry"("reversal_of_entry_id")\n    WHERE "reversal_of_entry_id" IS NOT NULL'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "business_exception_approval_live_subject_field_snapshot_key" ON "business_exception_approval"("subject_type", "subject_id", "subject_field", "subject_snapshot_hash")\n    WHERE "status" IN (\'PENDING\', \'APPROVED\')'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "asset_accounting_command_receipt_source_key" ON "asset_accounting_command_receipt"("source_type", "source_id", "source_key")'
    );
  });

  it("uses restrictive authority foreign keys and named immutable/reversal/approval guards", () => {
    for (const foreignKey of [
      "vehicle_cost_ledger_entry_vehicle_id_fkey",
      "vehicle_cost_ledger_entry_order_id_fkey",
      "vehicle_cost_ledger_entry_contract_id_fkey",
      "vehicle_cost_ledger_entry_customer_id_fkey",
      "vehicle_cost_ledger_entry_asset_owner_id_fkey",
      "vehicle_cost_ledger_entry_work_order_id_fkey",
      "vehicle_cost_ledger_entry_evidence_id_fkey",
      "vehicle_cost_ledger_entry_reversal_of_entry_id_fkey",
      "asset_accounting_command_receipt_cost_entry_id_fkey",
      "asset_accounting_command_receipt_approval_id_fkey"
    ]) {
      expect(migration).toContain(`CONSTRAINT "${foreignKey}"`);
      expect(migration).toMatch(
        new RegExp(`CONSTRAINT "${foreignKey}"[\\s\\S]*?ON DELETE RESTRICT`)
      );
    }

    const reversal = migrationFunction("enforce_vehicle_cost_ledger_reversal");
    const approval = migrationFunction("enforce_business_exception_approval_transition");
    const appendOnly = migrationFunction("reject_asset_accounting_append_only_mutation");

    expect(reversal).toContain("vehicle_cost_ledger_entry_reverse_of_reversal_chk");
    expect(reversal).toContain("vehicle_cost_ledger_entry_reversal_amount_chk");
    expect(reversal).toContain("vehicle_cost_ledger_entry_reversal_reference_chk");
    for (const column of [
      "vehicle_id",
      "order_id",
      "contract_id",
      "customer_id",
      "asset_owner_id",
      "work_order_id",
      "action_type",
      "cost_category",
      "responsible_party_type",
      "responsible_party_id",
      "asset_owner_snapshot",
      "evidence_id",
      "evidence_snapshot",
      "responsibility_snapshot"
    ]) {
      expect(reversal, column).toContain(`NEW."${column}"`);
      expect(reversal, column).toContain(`original."${column}"`);
    }
    expect(reversal).toContain("original.\"entry_kind\" = 'REVERSAL'");
    expect(reversal).toContain('NEW."amount_cents" <> -original."amount_cents"');

    expect(appendOnly).toContain("ERRCODE = '55000'");
    expect(approval).toContain("OLD.\"status\" = 'PENDING'");
    expect(approval).toContain("NEW.\"status\" IN ('APPROVED', 'REJECTED', 'EXPIRED')");
    expect(approval).toContain("OLD.\"status\" = 'APPROVED'");
    expect(approval).toContain("NEW.\"status\" = 'EXPIRED'");
    expect(approval).toContain("request facts are immutable");
    expect(approval).toContain("decision facts are immutable");
    expect(approval).toContain("ERRCODE = '55000'");

    expect(migrationTrigger("vehicle_cost_ledger_entry_reversal_integrity")).toContain(
      'EXECUTE FUNCTION "enforce_vehicle_cost_ledger_reversal"()'
    );
    expect(migrationTrigger("vehicle_cost_ledger_entry_append_only")).toContain(
      'BEFORE UPDATE OR DELETE ON "vehicle_cost_ledger_entry"'
    );
    expect(migrationTrigger("asset_accounting_command_receipt_append_only")).toContain(
      'BEFORE UPDATE OR DELETE ON "asset_accounting_command_receipt"'
    );
    expect(migrationTrigger("business_exception_approval_transition_only")).toContain(
      'BEFORE UPDATE OR DELETE ON "business_exception_approval"'
    );
  });
});
