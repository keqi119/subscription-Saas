import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "..");
const schema = readFileSync(resolve(apiRoot, "prisma/schema.prisma"), "utf8");
const migrationPath = resolve(
  apiRoot,
  "prisma/migrations/20260821120000_stage1_p0_subscription_closure/migration.sql"
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

const enumContracts = [
  {
    prismaName: "SubscriptionClosureType",
    sqlName: "subscription_closure_type",
    values: ["NORMAL_COMPLETION", "EARLY_TERMINATION"]
  },
  {
    prismaName: "SubscriptionClosurePhysicalControlMode",
    sqlName: "subscription_closure_physical_control_mode",
    values: ["VOLUNTARY_RETURN", "RECOVERY"]
  },
  {
    prismaName: "SubscriptionClosureFinalDisposition",
    sqlName: "subscription_closure_final_disposition",
    values: ["COMPLETE", "TERMINATE"]
  },
  {
    prismaName: "SubscriptionClosureStatus",
    sqlName: "subscription_closure_status",
    values: [
      "PREPARING_RETURN",
      "RECOVERY_ASSESSMENT_PENDING",
      "RECOVERY_APPROVAL_PENDING",
      "RECOVERY_APPROVED",
      "RECOVERY_IN_PROGRESS",
      "VEHICLE_SECURED",
      "RETURN_INSPECTION",
      "RECONDITIONING",
      "PENDING_SETTLEMENT",
      "COMPLETED",
      "TERMINATED",
      "REJECTED",
      "PAUSED",
      "CANCELLED",
      "MANUAL_TAKEOVER"
    ]
  },
  {
    prismaName: "SubscriptionClosureEventType",
    sqlName: "subscription_closure_event_type",
    values: [
      "CASE_CREATED",
      "STATUS_TRANSITIONED",
      "RECOVERY_ESCALATED",
      "DOCUMENT_REVISION_CREATED",
      "SETTLEMENT_REVISION_CREATED",
      "PHYSICAL_CONTROL_CONFIRMED",
      "INSPECTION_RECORDED",
      "INVENTORY_RELEASED",
      "NOTE_ADDED"
    ]
  },
  {
    prismaName: "SubscriptionClosureDocumentType",
    sqlName: "subscription_closure_document_type",
    values: ["RETURN_MANIFEST", "EARLY_TERMINATION_AGREEMENT", "RECOVERY_AUTHORITY"]
  },
  {
    prismaName: "SubscriptionClosureDocumentStage",
    sqlName: "subscription_closure_document_stage",
    values: ["GENERATED", "SIGNED", "ARCHIVED"]
  },
  {
    prismaName: "SubscriptionClosureSettlementType",
    sqlName: "subscription_closure_settlement_type",
    values: ["ESTIMATE", "FINAL"]
  },
  {
    prismaName: "SubscriptionClosureSettlementStage",
    sqlName: "subscription_closure_settlement_stage",
    values: ["PROPOSED", "FINALIZED", "SETTLED"]
  },
  {
    prismaName: "SubscriptionClosureCommandType",
    sqlName: "subscription_closure_command_type",
    values: [
      "CREATE_CASE",
      "PREPARE_RETURN",
      "CREATE_DOCUMENT_REVISION",
      "TRANSITION_CASE",
      "ESCALATE_RECOVERY",
      "CONFIRM_PHYSICAL_CONTROL",
      "RECORD_INSPECTION",
      "CREATE_SETTLEMENT_REVISION",
      "COMPLETE_CLOSURE"
    ]
  }
] as const;

describe("Stage 1 P0 subscription closure persistence contract", () => {
  it("declares the exact closure, document, settlement, event, and command enums", () => {
    for (const contract of enumContracts) {
      expect(enumValues(contract.prismaName), contract.prismaName).toEqual(contract.values);
      expect(migrationEnumValues(contract.sqlName), contract.sqlName).toEqual(contract.values);
    }

    expect(enumValues("OrderStatus")).toEqual([
      "PENDING_REVIEW",
      "PENDING_CUSTOMER_CONFIRMATION",
      "PENDING_CONTRACT",
      "PENDING_SIGN",
      "PENDING_PAYMENT",
      "PENDING_VEHICLE",
      "PENDING_DELIVERY",
      "ACTIVE",
      "SUSPENDED",
      "PENDING_RETURN",
      "RETURNED_PENDING_SETTLEMENT",
      "TERMINATED",
      "COMPLETED",
      "CANCELLED",
      "REJECTED"
    ]);
    expect(enumValues("ContractStatus")).toEqual([
      "DRAFT",
      "GENERATED",
      "SIGNING",
      "SIGNED",
      "ARCHIVED",
      "COMPLETED",
      "TERMINATED",
      "CANCELLED"
    ]);
    expect(enumValues("SubscriptionAutomationJobType").at(-1)).toBe(
      "CLOSURE_RECOVERY_ASSESSMENT_D7"
    );
    expect(migration).toContain(
      `ALTER TYPE "order_status" ADD VALUE 'RETURNED_PENDING_SETTLEMENT' AFTER 'PENDING_RETURN'`
    );
    expect(migration).toContain(
      `ALTER TYPE "contract_status" ADD VALUE 'COMPLETED' AFTER 'ARCHIVED'`
    );
    expect(migration).toContain(
      `ALTER TYPE "subscription_automation_job_type" ADD VALUE 'CLOSURE_RECOVERY_ASSESSMENT_D7'`
    );
  });

  it("maps the five closure facts with one-case, source, revision, and pointer authorities", () => {
    const closureCase = prismaBlock("model", "SubscriptionClosureCase");
    const event = prismaBlock("model", "SubscriptionClosureEvent");
    const document = prismaBlock("model", "SubscriptionClosureDocumentRevision");
    const settlement = prismaBlock("model", "SubscriptionClosureSettlementRevision");
    const receipt = prismaBlock("model", "SubscriptionClosureCommandReceipt");

    expect(closureCase).toContain('@@map("subscription_closure_case")');
    expect(closureCase).toContain("orderId");
    expect(closureCase).toContain("@unique");
    for (const field of [
      "caseNo",
      "orderId",
      "vehicleId",
      "customerId",
      "contractId",
      "vehicleReturnId",
      "returnHandoverWorkOrderId",
      "returnAssetWorkOrderId",
      "recoveryAssetWorkOrderId",
      "reconditioningAssetWorkOrderId",
      "closureType",
      "physicalControlMode",
      "finalDisposition",
      "status",
      "authoritySnapshot",
      "authoritySnapshotHash",
      "effectiveAt",
      "physicalControlledAt",
      "settledAt",
      "closedAt",
      "currentDocumentRevisionId",
      "currentSettlementRevisionId",
      "version",
      "createSourceType",
      "createSourceId",
      "createSourceKey"
    ]) {
      expect(closureCase, `SubscriptionClosureCase.${field}`).toContain(field);
    }
    expect(closureCase).toContain(
      "@@unique([createSourceType, createSourceId, createSourceKey]"
    );

    for (const [block, table] of [
      [event, "subscription_closure_event"],
      [document, "subscription_closure_document_revision"],
      [settlement, "subscription_closure_settlement_revision"],
      [receipt, "subscription_closure_command_receipt"]
    ] as const) {
      expect(block).toContain(`@@map("${table}")`);
      expect(block).toContain("sourceType");
      expect(block).toContain("sourceId");
      expect(block).toContain("sourceKey");
      expect(block).toContain("@@unique([sourceType, sourceId, sourceKey]");
      expect(block).not.toContain("deletedAt");
    }

    expect(event).toContain("@@unique([closureCaseId, sequence]");
    expect(document).toContain("@@unique([closureCaseId, revisionNumber]");
    expect(document).toContain("@@unique([supersedesRevisionId]");
    expect(settlement).toContain("@@unique([closureCaseId, revisionNumber]");
    expect(settlement).toContain("@@unique([supersedesRevisionId]");
    expect(receipt).not.toContain("updatedAt");
  });

  it("declares strong document, settlement approval, current-pointer, and reverse relations", () => {
    const closureCase = prismaBlock("model", "SubscriptionClosureCase");
    const document = prismaBlock("model", "SubscriptionClosureDocumentRevision");
    const settlement = prismaBlock("model", "SubscriptionClosureSettlementRevision");

    for (const field of [
      "closureCase",
      "vehicleReturn",
      "handoverWorkOrder",
      "contractESignTask",
      "sourceFile",
      "signedFile",
      "supersedesRevision"
    ]) {
      expect(document, `SubscriptionClosureDocumentRevision.${field}`).toContain(field);
    }
    for (const field of [
      "ledgerInputSnapshot",
      "billInputSnapshot",
      "depositInputSnapshot",
      "responsibilitySnapshot",
      "waiverApproval",
      "writeOffApproval",
      "resultSnapshot",
      "inputSnapshotHash",
      "resultHash",
      "supersedesRevision"
    ]) {
      expect(settlement, `SubscriptionClosureSettlementRevision.${field}`).toContain(field);
    }
    expect(closureCase).toContain("currentDocumentRevision");
    expect(closureCase).toContain("currentSettlementRevision");

    for (const [model, relation] of [
      ["SubscriptionOrder", "closureCase"],
      ["Vehicle", "closureCases"],
      ["Customer", "closureCases"],
      ["Contract", "closureCases"],
      ["VehicleReturn", "closureCase"],
      ["VehicleReturn", "closureDocumentRevisions"],
      ["VehicleHandoverWorkOrder", "closureCase"],
      ["VehicleHandoverWorkOrder", "closureDocumentRevisions"],
      ["ContractESignTask", "closureDocumentRevisions"],
      ["FileObject", "sourceClosureDocumentRevisions"],
      ["FileObject", "signedClosureDocumentRevisions"],
      ["BusinessExceptionApproval", "waiverSettlementRevisions"],
      ["BusinessExceptionApproval", "writeOffSettlementRevisions"]
    ] as const) {
      expect(prismaBlock("model", model), `${model}.${relation}`).toContain(relation);
    }
    for (const relation of [
      "returnClosureCases",
      "recoveryClosureCases",
      "reconditioningClosureCases"
    ]) {
      expect(prismaBlock("model", "AssetWorkOrder"), relation).toContain(relation);
    }
  });

  it("ships named state, hash, document-shape, settlement-shape, chain, and append-only guards", () => {
    for (const constraint of [
      "subscription_closure_case_intent_shape_chk",
      "subscription_closure_case_recovery_status_shape_chk",
      "subscription_closure_case_terminal_shape_chk",
      "subscription_closure_case_physical_control_shape_chk",
      "subscription_closure_case_authority_hash_chk",
      "subscription_closure_event_sequence_positive_chk",
      "subscription_closure_event_source_key_not_blank_chk",
      "subscription_closure_document_revision_number_positive_chk",
      "subscription_closure_document_hashes_chk",
      "subscription_closure_document_stage_shape_chk",
      "subscription_closure_document_type_shape_chk",
      "subscription_closure_settlement_revision_number_positive_chk",
      "subscription_closure_settlement_hashes_chk",
      "subscription_closure_settlement_stage_shape_chk",
      "subscription_closure_settlement_amounts_nonnegative_chk",
      "subscription_closure_command_receipt_hash_chk",
      "subscription_closure_command_receipt_target_shape_chk"
    ]) {
      expect(migration, constraint).toContain(`CONSTRAINT "${constraint}"`);
    }
    for (const trigger of [
      "subscription_closure_event_append_only",
      "subscription_closure_document_revision_append_only",
      "subscription_closure_settlement_revision_append_only",
      "subscription_closure_command_receipt_append_only",
      "subscription_closure_document_revision_chain",
      "subscription_closure_settlement_revision_chain",
      "subscription_closure_case_current_revision_integrity"
    ]) {
      expect(migration, trigger).toContain(`CREATE TRIGGER "${trigger}"`);
    }
    expect(migration).toContain("reject_subscription_closure_append_only_mutation");
    expect(migration).toContain("enforce_subscription_closure_document_revision_chain");
    expect(migration).toContain("enforce_subscription_closure_settlement_revision_chain");
    expect(migration).toContain("enforce_subscription_closure_current_revision_integrity");
  });

  it("uses restrictive foreign keys and database uniqueness for every authority link", () => {
    for (const foreignKey of [
      "subscription_closure_case_order_id_fkey",
      "subscription_closure_case_vehicle_id_fkey",
      "subscription_closure_case_customer_id_fkey",
      "subscription_closure_case_contract_id_fkey",
      "subscription_closure_case_vehicle_return_id_fkey",
      "subscription_closure_case_return_handover_work_order_id_fkey",
      "subscription_closure_case_return_asset_work_order_id_fkey",
      "subscription_closure_case_recovery_asset_work_order_id_fkey",
      "subscription_closure_case_reconditioning_asset_work_order_id_fkey",
      "subscription_closure_document_revision_vehicle_return_id_fkey",
      "subscription_closure_document_revision_handover_work_order_id_fkey",
      "subscription_closure_document_revision_contract_esign_task_id_fkey",
      "subscription_closure_document_revision_source_file_id_fkey",
      "subscription_closure_document_revision_signed_file_id_fkey",
      "subscription_closure_settlement_revision_waiver_approval_id_fkey",
      "subscription_closure_settlement_revision_write_off_approval_id_fkey"
    ]) {
      expect(migration, foreignKey).toMatch(
        new RegExp(`CONSTRAINT "${foreignKey}"[\\s\\S]*?ON DELETE RESTRICT`)
      );
    }
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "subscription_closure_case_order_id_key" ON "subscription_closure_case"("order_id")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "subscription_closure_case_create_source_key" ON "subscription_closure_case"("create_source_type", "create_source_id", "create_source_key")'
    );
  });
});

describe("Stage 1 P0 subscription closure PostgreSQL constraint proofs", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: requiredTestDatabaseUrl() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("rejects invalid shapes, wrong current pointers, nonlinear successors, and mutations in rollback-only fixtures", async () => {
    const actorId = randomUUID();
    const caseId = randomUUID();
    const otherCaseId = randomUUID();
    const orderId = randomUUID();
    const eventId = randomUUID();
    const documentId = randomUUID();
    const otherDocumentId = randomUUID();
    const settlementId = randomUUID();
    const receiptId = randomUUID();
    const hash = "a".repeat(64);

    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`
        ALTER TABLE "subscription_closure_case" ENABLE ALWAYS TRIGGER "subscription_closure_case_immutable_initiation";
        ALTER TABLE "subscription_closure_case" ENABLE ALWAYS TRIGGER "subscription_closure_case_current_revision_integrity";
        ALTER TABLE "subscription_closure_event" ENABLE ALWAYS TRIGGER "subscription_closure_event_append_only";
        ALTER TABLE "subscription_closure_document_revision" ENABLE ALWAYS TRIGGER "subscription_closure_document_revision_append_only";
        ALTER TABLE "subscription_closure_document_revision" ENABLE ALWAYS TRIGGER "subscription_closure_document_revision_chain";
        ALTER TABLE "subscription_closure_settlement_revision" ENABLE ALWAYS TRIGGER "subscription_closure_settlement_revision_append_only";
        ALTER TABLE "subscription_closure_settlement_revision" ENABLE ALWAYS TRIGGER "subscription_closure_settlement_revision_chain";
        ALTER TABLE "subscription_closure_command_receipt" ENABLE ALWAYS TRIGGER "subscription_closure_command_receipt_append_only";
      `);
      await client.query(
        `INSERT INTO "user" ("id", "username", "name", "password_hash", "status", "created_at", "updated_at")
         VALUES ($1::uuid, $2, 'P0 schema actor', 'not-used', 'ACTIVE', clock_timestamp(), clock_timestamp())`,
        [actorId, `p0-schema-${actorId}`]
      );
      await insertCase(client, {
        actorId,
        caseId,
        caseNo: `P0-${caseId}`,
        orderId,
        sourceKey: `p0-schema:${caseId}`
      });
      await insertCase(client, {
        actorId,
        caseId: otherCaseId,
        caseNo: `P0-${otherCaseId}`,
        orderId: randomUUID(),
        sourceKey: `p0-schema:${otherCaseId}`
      });

      await expectPgError(
        client,
        `INSERT INTO "subscription_closure_case" (
          "id", "case_no", "order_id", "vehicle_id", "customer_id", "contract_id",
          "closure_type", "physical_control_mode", "final_disposition", "status",
          "authority_snapshot", "authority_snapshot_hash", "effective_at", "version",
          "create_source_type", "create_source_id", "create_source_key", "created_by", "updated_by",
          "created_at", "updated_at"
        ) VALUES (
          $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
          'EARLY_TERMINATION', 'VOLUNTARY_RETURN', 'COMPLETE', 'PREPARING_RETURN',
          '{}'::jsonb, $7, clock_timestamp(), 0,
          'P0_SCHEMA_TEST', $8::uuid, $9, $10::uuid, $10::uuid, clock_timestamp(), clock_timestamp()
        )`,
        [
          randomUUID(),
          `P0-invalid-${randomUUID()}`,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          hash,
          randomUUID(),
          `p0-schema:invalid:${randomUUID()}`,
          actorId
        ],
        "23514",
        "subscription_closure_case_intent_shape_chk"
      );
      await expectPgError(
        client,
        `INSERT INTO "subscription_closure_case" (
          "id", "case_no", "order_id", "vehicle_id", "customer_id", "contract_id",
          "closure_type", "physical_control_mode", "final_disposition", "status",
          "authority_snapshot", "authority_snapshot_hash", "effective_at", "version",
          "create_source_type", "create_source_id", "create_source_key", "created_by", "updated_by",
          "created_at", "updated_at"
        ) VALUES (
          $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
          'NORMAL_COMPLETION', 'VOLUNTARY_RETURN', 'COMPLETE', 'PREPARING_RETURN',
          '{}'::jsonb, $7, clock_timestamp(), 0,
          'P0_SCHEMA_TEST', $8::uuid, $9, $10::uuid, $10::uuid, clock_timestamp(), clock_timestamp()
        )`,
        [
          randomUUID(),
          `P0-duplicate-${randomUUID()}`,
          orderId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          hash,
          randomUUID(),
          `p0-schema:duplicate:${randomUUID()}`,
          actorId
        ],
        "23505",
        "subscription_closure_case_order_id_key"
      );

      await expectPgError(
        client,
        `UPDATE "subscription_closure_case"
         SET "closure_type" = 'EARLY_TERMINATION', "version" = "version" + 1
         WHERE "id" = $1::uuid`,
        [caseId],
        "55000"
      );
      await client.query(
        `UPDATE "subscription_closure_case"
         SET "physical_control_mode" = 'RECOVERY',
             "final_disposition" = 'TERMINATE',
             "status" = 'RECOVERY_ASSESSMENT_PENDING',
             "version" = "version" + 1,
             "updated_by" = $1::uuid,
             "updated_at" = clock_timestamp()
         WHERE "id" = $2::uuid`,
        [actorId, caseId]
      );

      await client.query(
        `INSERT INTO "subscription_closure_event" (
          "id", "closure_case_id", "sequence", "event_type", "before_status", "after_status",
          "actor_id", "occurred_at", "recorded_at", "source_type", "source_id", "source_key", "detail_snapshot"
        ) VALUES (
          $1::uuid, $2::uuid, 1, 'CASE_CREATED', NULL, 'PREPARING_RETURN',
          $3::uuid, clock_timestamp(), clock_timestamp(), 'P0_SCHEMA_TEST', $4::uuid, $5, '{}'::jsonb
        )`,
        [eventId, caseId, actorId, randomUUID(), `p0-schema:event:${eventId}`]
      );
      await insertDocument(client, {
        actorId,
        caseId,
        documentId,
        sourceKey: `p0-schema:document:${documentId}`
      });
      await insertDocument(client, {
        actorId,
        caseId: otherCaseId,
        documentId: otherDocumentId,
        sourceKey: `p0-schema:document:${otherDocumentId}`
      });
      await insertSettlement(client, {
        actorId,
        caseId,
        settlementId,
        sourceKey: `p0-schema:settlement:${settlementId}`
      });
      await client.query(
        `INSERT INTO "subscription_closure_command_receipt" (
          "id", "closure_case_id", "event_id", "source_type", "source_id", "source_key",
          "command_type", "payload_hash", "payload_snapshot", "outcome_snapshot", "actor_id", "created_at"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, 'P0_SCHEMA_TEST', $4::uuid, $5,
          'CREATE_CASE', $6, '{}'::jsonb, '{}'::jsonb, $7::uuid, clock_timestamp()
        )`,
        [
          receiptId,
          caseId,
          eventId,
          randomUUID(),
          `p0-schema:receipt:${receiptId}`,
          hash,
          actorId
        ]
      );

      await expectPgError(
        client,
        `UPDATE "subscription_closure_case" SET "current_document_revision_id" = $1::uuid WHERE "id" = $2::uuid`,
        [otherDocumentId, caseId],
        "23514",
        "subscription_closure_case_current_document_case_chk"
      );
      await client.query(
        `UPDATE "subscription_closure_case"
         SET "current_document_revision_id" = $1::uuid,
             "current_settlement_revision_id" = $2::uuid,
             "version" = "version" + 1,
             "updated_by" = $4::uuid,
             "updated_at" = clock_timestamp()
         WHERE "id" = $3::uuid`,
        [documentId, settlementId, caseId, actorId]
      );
      await expectPgError(
        client,
        `INSERT INTO "subscription_closure_settlement_revision" (
          "id", "closure_case_id", "revision_number", "settlement_type", "stage",
          "ledger_input_snapshot", "bill_input_snapshot", "deposit_input_snapshot", "responsibility_snapshot",
          "input_snapshot_hash", "cost_total_cents", "receivable_total_cents", "paid_total_cents",
          "write_off_total_cents", "waiver_total_cents", "deposit_applied_cents", "deposit_refund_cents",
          "amount_due_cents", "amount_refundable_cents", "result_snapshot", "result_hash",
          "supersedes_revision_id", "source_type", "source_id", "source_key", "created_by", "created_at"
        ) VALUES (
          $1::uuid, $2::uuid, 3, 'FINAL', 'PROPOSED', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, $3, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, $3,
          $4::uuid, 'P0_SCHEMA_TEST', $5::uuid, $6, $7::uuid, clock_timestamp()
        )`,
        [
          randomUUID(),
          caseId,
          hash,
          settlementId,
          randomUUID(),
          `p0-schema:settlement:nonlinear:${randomUUID()}`,
          actorId
        ],
        "23514",
        "subscription_closure_settlement_revision_chain_chk"
      );

      for (const [table, id] of [
        ["subscription_closure_event", eventId],
        ["subscription_closure_document_revision", documentId],
        ["subscription_closure_settlement_revision", settlementId],
        ["subscription_closure_command_receipt", receiptId]
      ] as const) {
        await expectPgError(
          client,
          `UPDATE "${table}" SET "source_key" = "source_key" || ':mutated' WHERE "id" = $1::uuid`,
          [id],
          "55000"
        );
        await expectPgError(
          client,
          `DELETE FROM "${table}" WHERE "id" = $1::uuid`,
          [id],
          "55000"
        );
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function insertCase(
  client: Client,
  input: { actorId: string; caseId: string; caseNo: string; orderId: string; sourceKey: string }
) {
  const hash = "a".repeat(64);
  await client.query(
    `INSERT INTO "subscription_closure_case" (
      "id", "case_no", "order_id", "vehicle_id", "customer_id", "contract_id",
      "closure_type", "physical_control_mode", "final_disposition", "status",
      "authority_snapshot", "authority_snapshot_hash", "effective_at", "version",
      "create_source_type", "create_source_id", "create_source_key", "created_by", "updated_by",
      "created_at", "updated_at"
    ) VALUES (
      $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
      'NORMAL_COMPLETION', 'VOLUNTARY_RETURN', 'COMPLETE', 'PREPARING_RETURN',
      '{}'::jsonb, $7, clock_timestamp(), 0,
      'P0_SCHEMA_TEST', $8::uuid, $9, $10::uuid, $10::uuid, clock_timestamp(), clock_timestamp()
    )`,
    [
      input.caseId,
      input.caseNo,
      input.orderId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      hash,
      randomUUID(),
      input.sourceKey,
      input.actorId
    ]
  );
}

async function insertDocument(
  client: Client,
  input: { actorId: string; caseId: string; documentId: string; sourceKey: string }
) {
  const hash = "b".repeat(64);
  await client.query(
    `INSERT INTO "subscription_closure_document_revision" (
      "id", "closure_case_id", "revision_number", "document_type", "stage",
      "document_snapshot", "document_snapshot_hash", "contract_esign_task_id",
      "source_file_id", "source_file_hash", "source_type", "source_id", "source_key",
      "generated_by", "generated_at", "created_at"
    ) VALUES (
      $1::uuid, $2::uuid, 1, 'EARLY_TERMINATION_AGREEMENT', 'GENERATED',
      '{}'::jsonb, $3, $4::uuid, $5::uuid, $3,
      'P0_SCHEMA_TEST', $6::uuid, $7, $8::uuid, clock_timestamp(), clock_timestamp()
    )`,
    [
      input.documentId,
      input.caseId,
      hash,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      input.sourceKey,
      input.actorId
    ]
  );
}

async function insertSettlement(
  client: Client,
  input: { actorId: string; caseId: string; settlementId: string; sourceKey: string }
) {
  const hash = "c".repeat(64);
  await client.query(
    `INSERT INTO "subscription_closure_settlement_revision" (
      "id", "closure_case_id", "revision_number", "settlement_type", "stage",
      "ledger_input_snapshot", "bill_input_snapshot", "deposit_input_snapshot", "responsibility_snapshot",
      "input_snapshot_hash", "cost_total_cents", "receivable_total_cents", "paid_total_cents",
      "write_off_total_cents", "waiver_total_cents", "deposit_applied_cents", "deposit_refund_cents",
      "amount_due_cents", "amount_refundable_cents", "result_snapshot", "result_hash",
      "source_type", "source_id", "source_key", "created_by", "created_at"
    ) VALUES (
      $1::uuid, $2::uuid, 1, 'FINAL', 'PROPOSED', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, $3, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, $3,
      'P0_SCHEMA_TEST', $4::uuid, $5, $6::uuid, clock_timestamp()
    )`,
    [input.settlementId, input.caseId, hash, randomUUID(), input.sourceKey, input.actorId]
  );
}

async function expectPgError(
  client: Client,
  sql: string,
  values: unknown[],
  code: string,
  constraint?: string
) {
  const savepoint = `proof_${randomUUID().replaceAll("-", "")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let error: unknown;
  try {
    await client.query(sql, values);
  } catch (caught) {
    error = caught;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  expect(error, `expected PostgreSQL error ${code}`).toBeDefined();
  expect((error as { code?: string }).code).toBe(code);
  if (constraint) {
    expect((error as { constraint?: string }).constraint).toBe(constraint);
  }
}

function requiredTestDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) throw new Error("DATABASE_URL is required for closure schema tests");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Closure schema tests require PostgreSQL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Closure schema tests require a loopback PostgreSQL host");
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*_(test|codex)$/.test(databaseName)) {
    throw new Error("Closure schema tests require a test-only database");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
