import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "..");
const schema = readFileSync(resolve(apiRoot, "prisma/schema.prisma"), "utf8");
const migrationPath = resolve(
  apiRoot,
  "prisma/migrations/20260820120000_stage1c_asset_work_orders_restrictions/migration.sql"
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

const enumContracts = [
  {
    prismaName: "AssetWorkOrderType",
    sqlName: "asset_work_order_type",
    values: [
      "DELIVERY_OUTBOUND",
      "RETURN_INBOUND",
      "SWAP_OUTBOUND",
      "SWAP_INBOUND",
      "RECOVERY",
      "RECONDITIONING",
      "MAINTENANCE"
    ]
  },
  {
    prismaName: "AssetWorkOrderStatus",
    sqlName: "asset_work_order_status",
    values: [
      "PENDING",
      "IN_PROGRESS",
      "WAITING_EXTERNAL",
      "PENDING_ACCEPTANCE",
      "PENDING_COST_CONFIRMATION",
      "CLOSED",
      "CANCELLED"
    ]
  },
  {
    prismaName: "AssetWorkOrderPriority",
    sqlName: "asset_work_order_priority",
    values: ["LOW", "NORMAL", "HIGH", "URGENT"]
  },
  {
    prismaName: "AssetWorkOrderEventType",
    sqlName: "asset_work_order_event_type",
    values: [
      "CREATED",
      "ASSIGNED",
      "STARTED",
      "WAITING_EXTERNAL",
      "RESUMED",
      "EVIDENCE_ATTACHED",
      "SUBMITTED_FOR_ACCEPTANCE",
      "ACCEPTED",
      "COST_CONFIRMED",
      "PHYSICAL_CONTROL_CONFIRMED",
      "INSPECTION_RECORDED",
      "RESTRICTION_CREATED",
      "RESTRICTION_RELEASED",
      "CLOSED",
      "CANCELLED",
      "NOTE_ADDED"
    ]
  },
  {
    prismaName: "AssetWorkOrderEvidenceAction",
    sqlName: "asset_work_order_evidence_action",
    values: ["ATTACH", "SUPERSEDE", "REMOVE"]
  },
  {
    prismaName: "AssetWorkOrderEvidenceType",
    sqlName: "asset_work_order_evidence_type",
    values: [
      "PHOTO",
      "VIDEO",
      "DOCUMENT",
      "SIGNATURE",
      "LOCATION_PROOF",
      "THIRD_PARTY_RECEIPT",
      "INSPECTION_REPORT",
      "OTHER"
    ]
  },
  {
    prismaName: "VehicleOperationalRestrictionType",
    sqlName: "vehicle_operational_restriction_type",
    values: [
      "RETURN_INSPECTION_PENDING",
      "REINSPECTION_PENDING",
      "RECONDITIONING_PENDING",
      "MAINTENANCE_OR_ACCIDENT",
      "RECOVERY_IN_PROGRESS",
      "LEGAL_HOLD",
      "EVIDENCE_EXCEPTION",
      "OWNERSHIP_EXCEPTION",
      "OTHER"
    ]
  },
  {
    prismaName: "VehicleOperationalRestrictionSeverity",
    sqlName: "vehicle_operational_restriction_severity",
    values: ["ADVISORY", "BLOCKING"]
  },
  {
    prismaName: "VehicleOperationalRestrictionScope",
    sqlName: "vehicle_operational_restriction_scope",
    values: ["ALLOCATION", "DELIVERY", "CUSTOMER_USE", "INVENTORY_RELEASE"]
  },
  {
    prismaName: "VehicleOperationalRestrictionStatus",
    sqlName: "vehicle_operational_restriction_status",
    values: ["ACTIVE", "RELEASED", "VOIDED"]
  }
] as const;

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

function immutableRowFields(sql: string, prefix: "NEW" | "OLD") {
  return Array.from(sql.matchAll(new RegExp(`${prefix}\\."([^"]+)"`, "g")), (match) => match[1]);
}

describe("Stage 1C-B asset operations persistence contract", () => {
  it("defines all ten approved Prisma enums exactly", () => {
    for (const contract of enumContracts) {
      expect(enumValues(contract.prismaName), contract.prismaName).toEqual(contract.values);
    }
  });

  it("ships all ten approved PostgreSQL enum definitions exactly", () => {
    for (const contract of enumContracts) {
      const sqlValues = migrationEnumValues(contract.sqlName);
      expect(sqlValues, contract.sqlName).toEqual(contract.values);
      expect(sqlValues, `${contract.sqlName} differs from Prisma`).toEqual(
        enumValues(contract.prismaName)
      );
      expect(sqlValues, `${contract.sqlName} must not expose DEAD_LETTER`).not.toContain(
        "DEAD_LETTER"
      );
    }
  });

  it("defines the four mapped fact models and their stable source identities", () => {
    const workOrder = prismaBlock("model", "AssetWorkOrder");
    const event = prismaBlock("model", "AssetWorkOrderEvent");
    const evidence = prismaBlock("model", "AssetWorkOrderEvidence");
    const restriction = prismaBlock("model", "VehicleOperationalRestriction");

    expect(workOrder).toContain('@@map("asset_work_order")');
    expect(workOrder).toContain("workOrderNo");
    expect(workOrder).toMatch(/vehicleId\s+String\s+@map\("vehicle_id"\)\s+@db\.Uuid/);
    for (const field of [
      "orderId",
      "contractId",
      "customerId",
      "assetOwnerId",
      "relatedWorkOrderId",
      "workOrderType",
      "status",
      "priority",
      "costConfirmationRequired",
      "assignedUserId",
      "scheduledAt",
      "slaDueAt",
      "startedAt",
      "acceptedAt",
      "costConfirmedAt",
      "closedAt",
      "cancelledAt",
      "description",
      "solution",
      "closeReason",
      "createSourceType",
      "createSourceId",
      "createSourceKey",
      "authoritySnapshot",
      "metadata",
      "version",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy"
    ]) {
      expect(workOrder, `missing AssetWorkOrder.${field}`).toContain(field);
    }
    expect(workOrder).toContain("@@unique([createSourceType, createSourceId, createSourceKey]");

    expect(event).toContain('@@map("asset_work_order_event")');
    expect(event).toContain("@@unique([workOrderId, sequence]");
    expect(event).toContain("@@unique([sourceType, sourceId, sourceKey]");
    for (const field of [
      "beforeStatus",
      "afterStatus",
      "actorId",
      "occurredAt",
      "recordedAt",
      "detailSnapshot"
    ]) {
      expect(event, `missing AssetWorkOrderEvent.${field}`).toContain(field);
    }

    expect(evidence).toContain('@@map("asset_work_order_evidence")');
    expect(evidence).toContain("@@unique([sourceType, sourceId, sourceKey]");
    expect(evidence).toContain("@@unique([supersedesEvidenceId]");
    for (const field of [
      "action",
      "evidenceType",
      "eventId",
      "fileId",
      "supersedesEvidenceId",
      "fileBucket",
      "fileObjectKey",
      "fileSizeBytes",
      "fileMimeType",
      "contentSha256",
      "capturedAt",
      "captureMetadata",
      "actorId",
      "recordedAt"
    ]) {
      expect(evidence, `missing AssetWorkOrderEvidence.${field}`).toContain(field);
    }

    expect(restriction).toContain('@@map("vehicle_operational_restriction")');
    expect(restriction).toContain("@@unique([startSourceType, startSourceId, startSourceKey]");
    expect(restriction).toContain(
      "@@unique([releaseSourceType, releaseSourceId, releaseSourceKey]"
    );
    for (const field of [
      "vehicleId",
      "workOrderId",
      "restrictionType",
      "severity",
      "scopes",
      "status",
      "startedAt",
      "conditionsSnapshot",
      "evidenceSnapshot",
      "releasedAt",
      "releasedBy",
      "releaseReason",
      "releaseSnapshot",
      "releaseSourceType",
      "releaseSourceId",
      "releaseSourceKey",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy"
    ]) {
      expect(restriction, `missing VehicleOperationalRestriction.${field}`).toContain(field);
    }
  });

  it("creates source, vehicle/status, assignee/SLA, timeline, and active-restriction indexes", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "asset_work_order_create_source_key" ON "asset_work_order"("create_source_type", "create_source_id", "create_source_key")'
    );
    expect(migration).toContain(
      'CREATE INDEX "asset_work_order_vehicle_status_idx" ON "asset_work_order"("vehicle_id", "status")'
    );
    expect(migration).toContain(
      'CREATE INDEX "asset_work_order_assignee_sla_idx" ON "asset_work_order"("assigned_user_id", "sla_due_at")'
    );
    expect(migration).toContain(
      'CREATE INDEX "asset_work_order_event_work_order_timeline_idx" ON "asset_work_order_event"("work_order_id", "occurred_at", "sequence")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "asset_work_order_event_source_key" ON "asset_work_order_event"("source_type", "source_id", "source_key")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "asset_work_order_evidence_source_key" ON "asset_work_order_evidence"("source_type", "source_id", "source_key")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "vehicle_operational_restriction_start_source_key" ON "vehicle_operational_restriction"("start_source_type", "start_source_id", "start_source_key")'
    );
    expect(migration).toContain(
      'CREATE INDEX "vehicle_operational_restriction_active_vehicle_idx" ON "vehicle_operational_restriction"("vehicle_id", "severity")\n    WHERE "status" = \'ACTIVE\''
    );
  });

  it("enforces append-only event/evidence and the evidence action contract", () => {
    expect(migration).toContain('CREATE TRIGGER "asset_work_order_event_append_only"');
    expect(migration).toContain('CREATE TRIGGER "asset_work_order_evidence_append_only"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "asset_work_order_event"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "asset_work_order_evidence"');
    expect(migration).toContain(
      'CONSTRAINT "asset_work_order_event_occurred_not_future_chk" CHECK ("occurred_at" <= "recorded_at")'
    );
    expect(migration).toContain(
      'CONSTRAINT "asset_work_order_evidence_sha256_chk" CHECK ("content_sha256" IS NULL OR "content_sha256" ~ \'^[0-9a-f]{64}$\')'
    );
    expect(migration).toContain('CONSTRAINT "asset_work_order_evidence_action_shape_chk"');
    expect(migration).toContain(
      '("action" = \'REMOVE\' AND "file_id" IS NULL AND "content_sha256" IS NULL AND "supersedes_evidence_id" IS NOT NULL)'
    );
    expect(migration).toContain(
      '("action" = \'ATTACH\' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NULL)'
    );
    expect(migration).toContain(
      '("action" = \'SUPERSEDE\' AND "file_id" IS NOT NULL AND "content_sha256" IS NOT NULL AND "supersedes_evidence_id" IS NOT NULL)'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "asset_work_order_evidence_supersedes_evidence_id_key" ON "asset_work_order_evidence"("supersedes_evidence_id")'
    );
  });

  it("enforces non-empty scopes and the complete restriction release tuple", () => {
    expect(migration).toContain(
      'CONSTRAINT "vehicle_operational_restriction_scopes_not_empty_chk" CHECK (cardinality("scopes") > 0)'
    );
    expect(migration).toContain(
      'CONSTRAINT "vehicle_operational_restriction_release_after_start_chk" CHECK ("released_at" IS NULL OR "released_at" >= "started_at")'
    );
    expect(migration).toContain('CONSTRAINT "vehicle_operational_restriction_release_tuple_chk"');
    expect(migration).toContain(
      '("status" = \'ACTIVE\' AND "released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL AND "release_snapshot" IS NULL AND "release_source_type" IS NULL AND "release_source_id" IS NULL AND "release_source_key" IS NULL)'
    );
    expect(migration).toContain(
      '("status" IN (\'RELEASED\', \'VOIDED\') AND "released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason" IS NOT NULL AND "release_snapshot" IS NOT NULL AND "release_source_type" IS NOT NULL AND "release_source_id" IS NOT NULL AND "release_source_key" IS NOT NULL)'
    );
  });

  it("installs the named restriction trigger and rejects deletes", () => {
    const functionSql = migrationFunction("enforce_vehicle_operational_restriction_release");
    const triggerSql = migrationTrigger("vehicle_operational_restriction_release_only");

    expect(functionSql).toContain("IF TG_OP = 'DELETE' THEN");
    expect(triggerSql).toContain('CREATE TRIGGER "vehicle_operational_restriction_release_only"');
    expect(triggerSql).toContain('BEFORE UPDATE OR DELETE ON "vehicle_operational_restriction"');
    expect(triggerSql).toContain(
      'EXECUTE FUNCTION "enforce_vehicle_operational_restriction_release"()'
    );
  });

  it("allows a restriction to close only once from ACTIVE", () => {
    const functionSql = migrationFunction("enforce_vehicle_operational_restriction_release");

    expect(functionSql).toContain(
      "IF OLD.\"status\" <> 'ACTIVE' OR NEW.\"status\" = 'ACTIVE' THEN"
    );
  });

  it("compares every immutable restriction-start field on release", () => {
    const functionSql = migrationFunction("enforce_vehicle_operational_restriction_release");
    const comparison = functionSql.match(
      /IF ROW\(([\s\S]*?)\)\s+IS DISTINCT FROM ROW\(([\s\S]*?)\)\s+THEN/
    );
    expect(comparison, "missing immutable restriction-start row comparison").not.toBeNull();
    const immutableFields = [
      "id",
      "vehicle_id",
      "work_order_id",
      "restriction_type",
      "severity",
      "scopes",
      "started_at",
      "conditions_snapshot",
      "evidence_snapshot",
      "start_source_type",
      "start_source_id",
      "start_source_key",
      "created_at",
      "created_by"
    ];
    expect(immutableRowFields(comparison?.[1] ?? "", "NEW")).toEqual(immutableFields);
    expect(immutableRowFields(comparison?.[2] ?? "", "OLD")).toEqual(immutableFields);
  });
});
