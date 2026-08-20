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
const hardeningMigrationPath = resolve(
  apiRoot,
  "prisma/migrations/20260821000100_stage1c_cost_ledger_exception_approval_hardening/migration.sql"
);
const hardeningMigration = existsSync(hardeningMigrationPath)
  ? readFileSync(hardeningMigrationPath, "utf8")
  : "";
const reversalPeriodMigrationPath = resolve(
  apiRoot,
  "prisma/migrations/20260821000200_stage1c_reversal_period_integrity/migration.sql"
);
const reversalPeriodMigration = existsSync(reversalPeriodMigrationPath)
  ? readFileSync(reversalPeriodMigrationPath, "utf8")
  : "";
const migrationPrefix = `${migration}\n${hardeningMigration}`;
const finalMigration = `${migrationPrefix}\n${reversalPeriodMigration}`;

function prismaBlockFrom(source: string, kind: "enum" | "model", name: string) {
  return source.match(new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
}

function prismaBlock(kind: "enum" | "model", name: string) {
  return prismaBlockFrom(schema, kind, name);
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

function latestMigrationFunction(source: string, name: string) {
  return (
    Array.from(
      source.matchAll(
        new RegExp(`CREATE OR REPLACE FUNCTION "public"\\."${name}"\\(\\)[\\s\\S]*?\\n\\$\\$;`, "g")
      )
    ).at(-1)?.[0] ?? ""
  );
}

function latestMigrationTrigger(source: string, name: string) {
  return (
    Array.from(source.matchAll(new RegExp(`CREATE TRIGGER "${name}"[\\s\\S]*?;`, "g"))).at(
      -1
    )?.[0] ?? ""
  );
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function prismaFieldLine(source: string, model: string, field: string) {
  return (
    prismaBlockFrom(source, "model", model)
      .split("\n")
      .find((line) => line.trimStart().startsWith(`${field} `))
      ?.trim() ?? ""
  );
}

const restrictivePrismaRelations = [
  {
    model: "VehicleCostLedgerEntry",
    field: "order",
    definition:
      "order SubscriptionOrder? @relation(fields: [orderId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "contract",
    definition:
      "contract Contract? @relation(fields: [contractId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "customer",
    definition:
      "customer Customer? @relation(fields: [customerId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "assetOwner",
    definition:
      "assetOwner AssetOwner? @relation(fields: [assetOwnerId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "workOrder",
    definition:
      "workOrder AssetWorkOrder? @relation(fields: [workOrderId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "evidence",
    definition:
      "evidence AssetWorkOrderEvidence? @relation(fields: [evidenceId], references: [id], onDelete: Restrict)"
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "confirmer",
    definition:
      'confirmer User @relation("VehicleCostLedgerEntryConfirmedBy", fields: [confirmedBy], references: [id], onDelete: Restrict)'
  },
  {
    model: "VehicleCostLedgerEntry",
    field: "reversalOfEntry",
    definition:
      'reversalOfEntry VehicleCostLedgerEntry? @relation("VehicleCostLedgerEntryReversal", fields: [reversalOfEntryId], references: [id], onDelete: Restrict)'
  },
  {
    model: "BusinessExceptionApproval",
    field: "decider",
    definition:
      'decider User? @relation("BusinessExceptionApprovalDecidedBy", fields: [decidedBy], references: [id], onDelete: Restrict)'
  },
  {
    model: "BusinessExceptionApproval",
    field: "expirer",
    definition:
      'expirer User? @relation("BusinessExceptionApprovalExpiredBy", fields: [expiredBy], references: [id], onDelete: Restrict)'
  },
  {
    model: "AssetAccountingCommandReceipt",
    field: "costEntry",
    definition:
      "costEntry VehicleCostLedgerEntry? @relation(fields: [costEntryId], references: [id], onDelete: Restrict)"
  },
  {
    model: "AssetAccountingCommandReceipt",
    field: "approval",
    definition:
      "approval BusinessExceptionApproval? @relation(fields: [approvalId], references: [id], onDelete: Restrict)"
  }
] as const;

const finalForeignKeyContracts = [
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_vehicle_id_fkey",
    "vehicle_id",
    "vehicle"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_order_id_fkey",
    "order_id",
    "subscription_order"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_contract_id_fkey",
    "contract_id",
    "contract"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_customer_id_fkey",
    "customer_id",
    "customer"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_asset_owner_id_fkey",
    "asset_owner_id",
    "asset_owner"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_work_order_id_fkey",
    "work_order_id",
    "asset_work_order"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_evidence_id_fkey",
    "evidence_id",
    "asset_work_order_evidence"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_confirmed_by_fkey",
    "confirmed_by",
    "user"
  ],
  [
    "vehicle_cost_ledger_entry",
    "vehicle_cost_ledger_entry_reversal_of_entry_id_fkey",
    "reversal_of_entry_id",
    "vehicle_cost_ledger_entry"
  ],
  [
    "business_exception_approval",
    "business_exception_approval_requested_by_fkey",
    "requested_by",
    "user"
  ],
  [
    "business_exception_approval",
    "business_exception_approval_decided_by_fkey",
    "decided_by",
    "user"
  ],
  [
    "business_exception_approval",
    "business_exception_approval_expired_by_fkey",
    "expired_by",
    "user"
  ],
  [
    "asset_accounting_command_receipt",
    "asset_accounting_command_receipt_cost_entry_id_fkey",
    "cost_entry_id",
    "vehicle_cost_ledger_entry"
  ],
  [
    "asset_accounting_command_receipt",
    "asset_accounting_command_receipt_approval_id_fkey",
    "approval_id",
    "business_exception_approval"
  ],
  [
    "asset_accounting_command_receipt",
    "asset_accounting_command_receipt_actor_id_fkey",
    "actor_id",
    "user"
  ]
] as const;

type ForeignKeyContract = (typeof finalForeignKeyContracts)[number];

function expectedForeignKeyStatement([table, name, column, referencedTable]: ForeignKeyContract) {
  return `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "${referencedTable}"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;
}

function finalForeignKeyStatement(
  source: string,
  [table, name, column, referencedTable]: ForeignKeyContract
) {
  const statement = new RegExp(
    `ALTER TABLE (?:"public"\\.)?"${table}" ADD CONSTRAINT "${name}" FOREIGN KEY \\("${column}"\\) REFERENCES "${referencedTable}"\\("id"\\) ON DELETE (?:RESTRICT|CASCADE|SET NULL) ON UPDATE CASCADE;`,
    "g"
  );
  return Array.from(source.matchAll(statement)).at(-1)?.[0] ?? "";
}

const reversalDimensionFields = [
  "vehicle_id",
  "order_id",
  "contract_id",
  "customer_id",
  "asset_owner_id",
  "work_order_id",
  "occurred_on",
  "accounting_period",
  "action_type",
  "cost_category",
  "responsible_party_type",
  "responsible_party_id",
  "asset_owner_snapshot",
  "evidence_id",
  "evidence_snapshot",
  "responsibility_snapshot"
] as const;

function reversalDimensionRows(functionSql: string) {
  const comparison = functionSql.match(
    /IF ROW\(\s*([\s\S]*?)\s*\) IS DISTINCT FROM ROW\(\s*([\s\S]*?)\s*\) THEN/
  );
  const fields = (row: string, alias: "NEW" | "original") =>
    Array.from(row.matchAll(new RegExp(`${alias}\\."([^"]+)"`, "g")), (match) => match[1]);
  return {
    newFields: fields(comparison?.[1] ?? "", "NEW"),
    originalFields: fields(comparison?.[2] ?? "", "original")
  };
}

function mutateReversalOriginalDimensionFields(
  source: string,
  mutation: (fields: string[]) => string[]
) {
  const functionSql = latestMigrationFunction(source, "enforce_vehicle_cost_ledger_reversal");
  const comparison = functionSql.match(
    /(IF ROW\([\s\S]*?\) IS DISTINCT FROM ROW\(\s*)([\s\S]*?)(\s*\) THEN)/
  );
  if (!comparison || comparison[2] === undefined) {
    return source;
  }

  const originalFields = Array.from(comparison[2].matchAll(/original\."([^"]+)"/g), (match) => {
    const field = match[1];
    if (field === undefined) {
      throw new Error("reversal original dimension capture is missing");
    }
    return field;
  });
  const replacement = `\n        ${mutation(originalFields)
    .map((field) => `original."${field}"`)
    .join(", ")}\n    `;
  const mutatedFunction = functionSql.replace(
    comparison[0],
    `${comparison[1]}${replacement}${comparison[3]}`
  );
  return source.replace(functionSql, () => mutatedFunction);
}

const finalTriggerContracts = [
  [
    "vehicle_cost_ledger_entry_reversal_integrity",
    "INSERT",
    "vehicle_cost_ledger_entry",
    "enforce_vehicle_cost_ledger_reversal"
  ],
  [
    "vehicle_cost_ledger_entry_append_only",
    "UPDATE OR DELETE",
    "vehicle_cost_ledger_entry",
    "reject_asset_accounting_append_only_mutation"
  ],
  [
    "asset_accounting_command_receipt_append_only",
    "UPDATE OR DELETE",
    "asset_accounting_command_receipt",
    "reject_asset_accounting_append_only_mutation"
  ],
  [
    "business_exception_approval_transition_only",
    "INSERT OR UPDATE OR DELETE",
    "business_exception_approval",
    "enforce_business_exception_approval_transition"
  ]
] as const;

type TriggerContract = (typeof finalTriggerContracts)[number];

function expectedTriggerStatement([name, events, table, functionName]: TriggerContract) {
  return `CREATE TRIGGER "${name}" BEFORE ${events} ON "public"."${table}" FOR EACH ROW EXECUTE FUNCTION "public"."${functionName}"();`;
}

const approvalUpdateTransitionPredicate = `
  IF NOT (
      (OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'EXPIRED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'EXPIRED')
  ) THEN`;

function expectFinalPersistenceContract(source: string, prismaSchema: string) {
  expect(
    normalizeWhitespace(prismaFieldLine(prismaSchema, "VehicleCostLedgerEntry", "confirmedBy")),
    "VehicleCostLedgerEntry.confirmedBy"
  ).toBe('confirmedBy String @map("confirmed_by") @db.Uuid');
  for (const relation of restrictivePrismaRelations) {
    expect(
      normalizeWhitespace(prismaFieldLine(prismaSchema, relation.model, relation.field)),
      `${relation.model}.${relation.field}`
    ).toBe(relation.definition);
  }

  for (const name of [
    "enforce_vehicle_cost_ledger_reversal",
    "reject_asset_accounting_append_only_mutation",
    "enforce_business_exception_approval_transition"
  ]) {
    expect(latestMigrationFunction(source, name), `${name} safe search path`).toContain(
      "SET search_path = pg_catalog, public, pg_temp"
    );
  }

  const reversal = latestMigrationFunction(source, "enforce_vehicle_cost_ledger_reversal");
  expect(reversal).toContain('original "public"."vehicle_cost_ledger_entry"%ROWTYPE');
  expect(reversal).toContain('FROM "public"."vehicle_cost_ledger_entry"');
  expect(reversal, "reversal amount comparator").toContain(
    'NEW."amount_cents" <> -original."amount_cents"'
  );
  const reversalRows = reversalDimensionRows(reversal);
  expect(reversalRows.newFields, "reversal new dimension pairing").toEqual(reversalDimensionFields);
  expect(reversalRows.originalFields, "reversal original dimension pairing").toEqual(
    reversalDimensionFields
  );
  expect(
    reversalRows.newFields.map((field, index) => `${field}:${reversalRows.originalFields[index]}`),
    "reversal dimension pairs"
  ).toEqual(reversalDimensionFields.map((field) => `${field}:${field}`));

  const approval = latestMigrationFunction(
    source,
    "enforce_business_exception_approval_transition"
  );
  expect(approval, "approval insert guard").toContain("IF TG_OP = 'INSERT' THEN");
  expect(approval).toContain("NEW.\"status\" = 'PENDING'");
  expect(approval).toContain('NEW."version" = 0');
  for (const column of [
    "decision",
    "decision_comment",
    "decided_by",
    "decided_at",
    "expiry_reason",
    "expired_by",
    "expired_at"
  ]) {
    expect(approval).toContain(`NEW."${column}" IS NULL`);
  }
  expect(approval, "approval version increment").toContain('NEW."version" <> OLD."version" + 1');
  expect(normalizeWhitespace(approval), "approval update transition predicate").toContain(
    normalizeWhitespace(approvalUpdateTransitionPredicate)
  );

  expect(source).toMatch(
    /ALTER TABLE "public"\."vehicle_cost_ledger_entry"\s+ALTER COLUMN "confirmed_by" SET NOT NULL;/
  );
  expect(source, "pending decision comment").toContain(
    '("status" = \'PENDING\' AND "decision" IS NULL AND "decision_comment" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "expiry_reason" IS NULL AND "expired_by" IS NULL AND "expired_at" IS NULL)'
  );
  expect(source).toContain(
    '("status" = \'EXPIRED\' AND "expiry_reason" IS NOT NULL AND "expired_by" IS NOT NULL AND "expired_at" IS NOT NULL AND ('
  );

  for (const trigger of finalTriggerContracts) {
    expect(normalizeWhitespace(latestMigrationTrigger(source, trigger[0])), trigger[0]).toBe(
      expectedTriggerStatement(trigger)
    );
  }

  for (const foreignKey of finalForeignKeyContracts) {
    expect(finalForeignKeyStatement(source, foreignKey), foreignKey[1]).toBe(
      expectedForeignKeyStatement(foreignKey)
    );
  }
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
  it("adds reversal date and period equality through one forward correction", () => {
    expect(reversalPeriodMigration).not.toBe("");
    expect(
      reversalPeriodMigration.match(
        /CREATE OR REPLACE FUNCTION "public"\."enforce_vehicle_cost_ledger_reversal"\(\)/g
      )
    ).toHaveLength(1);
    expect(reversalPeriodMigration).not.toMatch(/ALTER TABLE|DROP (?:FUNCTION|TRIGGER|TABLE)/);
    expectFinalPersistenceContract(finalMigration, schema);
  });

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
    for (const foreignKey of finalForeignKeyContracts) {
      expect(finalForeignKeyStatement(migration, foreignKey), foreignKey[1]).toBe(
        expectedForeignKeyStatement(foreignKey)
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

  it("rejects mutation of every final persistence authority definition", () => {
    expectFinalPersistenceContract(finalMigration, schema);

    const expectMigrationMutationToFail = (label: string, mutatedMigration: string) => {
      expect(mutatedMigration, `${label} mutation applied`).not.toBe(finalMigration);
      expect(() => expectFinalPersistenceContract(mutatedMigration, schema)).toThrow(label);
    };
    const expectSchemaMutationToFail = (label: string, mutatedSchema: string) => {
      expect(mutatedSchema, `${label} mutation applied`).not.toBe(schema);
      expect(() => expectFinalPersistenceContract(finalMigration, mutatedSchema)).toThrow(label);
    };
    const replaceHardening = (before: string, after: string) =>
      `${migration}\n${hardeningMigration.replace(before, after)}\n${reversalPeriodMigration}`;

    for (const relation of restrictivePrismaRelations) {
      const field = prismaFieldLine(schema, relation.model, relation.field);
      expectSchemaMutationToFail(
        `${relation.model}.${relation.field}`,
        schema.replace(field, field.replace("onDelete: Restrict", "onDelete: SetNull"))
      );
      if (relation.definition.includes("?")) {
        expectSchemaMutationToFail(
          `${relation.model}.${relation.field}`,
          schema.replace(field, field.replace("?", ""))
        );
      }
    }

    for (const foreignKey of finalForeignKeyContracts) {
      const statement = expectedForeignKeyStatement(foreignKey);
      expectMigrationMutationToFail(
        foreignKey[1],
        finalMigration.replace(
          statement,
          statement.replace("ON DELETE RESTRICT", "ON DELETE CASCADE")
        )
      );
      expectMigrationMutationToFail(foreignKey[1], finalMigration.replace(statement, ""));
    }

    const reversalComparatorMutation = reversalPeriodMigration.replace(
      'NEW."amount_cents" <> -original."amount_cents"',
      'NEW."amount_cents" = -original."amount_cents"'
    );
    expectMigrationMutationToFail(
      "reversal amount comparator",
      `${migrationPrefix}\n${reversalComparatorMutation}`
    );

    for (const [index, field] of reversalDimensionFields.entries()) {
      expectMigrationMutationToFail(
        "reversal original dimension pairing",
        `${migrationPrefix}\n${mutateReversalOriginalDimensionFields(
          reversalPeriodMigration,
          (fields) => fields.filter((_, fieldIndex) => fieldIndex !== index)
        )}`
      );

      const nextIndex = (index + 1) % reversalDimensionFields.length;
      expectMigrationMutationToFail(
        "reversal original dimension pairing",
        `${migrationPrefix}\n${mutateReversalOriginalDimensionFields(
          reversalPeriodMigration,
          (fields) => {
            const swapped = [...fields];
            const currentField = swapped[index];
            const nextField = swapped[nextIndex];
            if (currentField === undefined || nextField === undefined) {
              throw new Error("reversal dimension swap index is out of bounds");
            }
            [swapped[index], swapped[nextIndex]] = [nextField, currentField];
            return swapped;
          }
        )}`
      );
      expect(field).toBe(reversalDimensionFields[index]);
    }

    const versionMutation = replaceHardening(
      'NEW."version" <> OLD."version" + 1',
      'NEW."version" <> OLD."version" + 2'
    );
    expectMigrationMutationToFail("approval version increment", versionMutation);

    const pendingCommentMutation = replaceHardening(' AND "decision_comment" IS NULL', "");
    expectMigrationMutationToFail("pending decision comment", pendingCommentMutation);

    const insertGuardMutation = replaceHardening(
      "IF TG_OP = 'INSERT' THEN",
      "IF TG_OP = 'CREATE' THEN"
    );
    expectMigrationMutationToFail("approval insert guard", insertGuardMutation);

    for (const [label, before, after] of [
      [
        "approval update transition predicate",
        `NEW."status" IN ('APPROVED', 'REJECTED', 'EXPIRED')`,
        `NEW."status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')`
      ],
      [
        "approval update transition predicate",
        `NEW."status" = 'EXPIRED'`,
        `NEW."status" IN ('APPROVED', 'EXPIRED')`
      ],
      ["approval update transition predicate", ")\n        OR (OLD.", ")\n        AND (OLD."],
      ["approval update transition predicate", "IF NOT (\n        (OLD.", "IF (\n        (OLD."]
    ] as const) {
      expectMigrationMutationToFail(label, replaceHardening(before, after));
    }

    const appendOnlyWiringMutation = replaceHardening(
      'EXECUTE FUNCTION "public"."reject_asset_accounting_append_only_mutation"()',
      'EXECUTE FUNCTION "public"."enforce_vehicle_cost_ledger_reversal"()'
    );
    expectMigrationMutationToFail(
      "vehicle_cost_ledger_entry_append_only",
      appendOnlyWiringMutation
    );

    const finalReversalTrigger = latestMigrationTrigger(
      finalMigration,
      "vehicle_cost_ledger_entry_reversal_integrity"
    );
    expectMigrationMutationToFail(
      "vehicle_cost_ledger_entry_reversal_integrity",
      finalMigration.replace(
        finalReversalTrigger,
        finalReversalTrigger.replace(
          'EXECUTE FUNCTION "public"."enforce_vehicle_cost_ledger_reversal"()',
          'EXECUTE FUNCTION "public"."reject_asset_accounting_append_only_mutation"()'
        )
      )
    );
    expectMigrationMutationToFail(
      "vehicle_cost_ledger_entry_reversal_integrity",
      finalMigration.replace(finalReversalTrigger, "")
    );
  });
});
