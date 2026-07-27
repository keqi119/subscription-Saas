import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql"),
  "utf8"
);
const developmentEnv = readFileSync(join(root, ".env.example"), "utf8");
const productionEnv = readFileSync(join(root, ".env.production.example"), "utf8");

const workflowJobTypes = [
  "GENERATE_SOURCE_PDF",
  "NOTIFY_FIELD_ESIGN_READY",
  "NOTIFY_CUSTOMER_ESIGN_READY",
  "RECONCILE_CUSTOMER_SIGNATURE",
  "AUTO_SEAL_PLATFORM",
  "RECONCILE_PLATFORM_SEAL",
  "ARCHIVE_SIGNED_PDF"
];

const workflowJobStatuses = ["PENDING", "PROCESSING", "COMPLETED", "DEAD_LETTER", "CANCELLED"];
const handoverNotificationValues = ["HANDOVER_ESIGN_PENDING", "HANDOVER_ESIGN_READY"];
const environmentDefaults = {
  ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "<CHANGE_ME>",
  ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "<CHANGE_ME>",
  STAGE2_HANDOVER_WORKER_CONCURRENCY: "1",
  STAGE2_HANDOVER_WORKER_ENABLED: "false",
  STAGE2_HANDOVER_WORKER_LEASE_MS: "120000",
  STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS: "5000",
  STAGE2_HANDOVER_WORKFLOW_ENABLED: "false"
};

function extractPrismaBlock(source: string, kind: "enum" | "model", name: string): string {
  const match = source.match(new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing ${kind} ${name}`).not.toBeNull();
  return match![1]!;
}

function prismaEnumValues(source: string, name: string): string[] {
  return extractPrismaBlock(source, "enum", name)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("@@"));
}

function sqlEnumValues(source: string, name: string): string[] {
  const match = source.match(
    new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([\\s\\S]*?)\\);`)
  );
  expect(match, `missing SQL enum ${name}`).not.toBeNull();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((value) => value[1]!);
}

function environmentValue(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
}

describe("Stage 2 durable workflow schema", () => {
  it("defines the complete workflow job enum contracts in Prisma and SQL", () => {
    expect(prismaEnumValues(schema, "VehicleHandoverWorkflowJobType")).toEqual(workflowJobTypes);
    expect(prismaEnumValues(schema, "VehicleHandoverWorkflowJobStatus")).toEqual(
      workflowJobStatuses
    );
    expect(sqlEnumValues(migration, "vehicle_handover_workflow_job_type")).toEqual(
      workflowJobTypes
    );
    expect(sqlEnumValues(migration, "vehicle_handover_workflow_job_status")).toEqual(
      workflowJobStatuses
    );
  });

  it("defines the durable job model with its mappings, defaults, relation, and indexes", () => {
    const job = extractPrismaBlock(schema, "model", "VehicleHandoverWorkflowJob");
    const workOrder = extractPrismaBlock(schema, "model", "VehicleHandoverWorkOrder");

    expect(job).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/);
    expect(job).toMatch(/workOrderId\s+String\s+@map\("work_order_id"\)\s+@db\.Uuid/);
    expect(job).toMatch(
      /workOrder\s+VehicleHandoverWorkOrder\s+@relation\(fields: \[workOrderId\], references: \[id\]\)/
    );
    expect(job).toMatch(/handoverId\s+String\?\s+@map\("handover_id"\)\s+@db\.Uuid/);
    expect(job).toMatch(/eSignTaskId\s+String\?\s+@map\("esign_task_id"\)\s+@db\.Uuid/);
    expect(job).toMatch(/jobType\s+VehicleHandoverWorkflowJobType\s+@map\("job_type"\)/);
    expect(job).toMatch(
      /jobStatus\s+VehicleHandoverWorkflowJobStatus\s+@default\(PENDING\)\s+@map\("job_status"\)/
    );
    expect(job).toMatch(
      /idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)\s+@db\.VarChar\(256\)/
    );
    expect(job).toMatch(
      /availableAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("available_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(job).toMatch(/attemptCount\s+Int\s+@default\(0\)\s+@map\("attempt_count"\)/);
    expect(job).toMatch(/maxAttempts\s+Int\s+@default\(5\)\s+@map\("max_attempts"\)/);
    expect(job).toMatch(/leaseToken\s+String\?\s+@map\("lease_token"\)\s+@db\.Uuid/);
    expect(job).toMatch(
      /leaseExpiresAt\s+DateTime\?\s+@map\("lease_expires_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(job).toMatch(/payload\s+Json\?/);
    expect(job).toMatch(/resultSnapshot\s+Json\?\s+@map\("result_snapshot"\)/);
    expect(job).toMatch(
      /lastErrorCode\s+String\?\s+@map\("last_error_code"\)\s+@db\.VarChar\(128\)/
    );
    expect(job).toMatch(
      /lastErrorMessage\s+String\?\s+@map\("last_error_message"\)\s+@db\.VarChar\(512\)/
    );
    expect(job).toMatch(/startedAt\s+DateTime\?\s+@map\("started_at"\)\s+@db\.Timestamptz\(6\)/);
    expect(job).toMatch(
      /completedAt\s+DateTime\?\s+@map\("completed_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(job).toMatch(
      /createdAt\s+DateTime\s+@default\(now\(\)\)\s+@map\("created_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(job).toMatch(/updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/);
    expect(job).toContain("@@index([jobStatus, availableAt])");
    expect(job).toContain("@@index([workOrderId, createdAt])");
    expect(job).toContain("@@index([leaseExpiresAt])");
    expect(job).toContain('@@map("vehicle_handover_workflow_job")');
    expect(workOrder).toContain("workflowJobs                 VehicleHandoverWorkflowJob[]");
  });

  it("adds canonical operator snapshots and backfills external and internal assignments", () => {
    const workOrder = extractPrismaBlock(schema, "model", "VehicleHandoverWorkOrder");

    expect(workOrder).toMatch(
      /fieldOperatorName\s+String\?\s+@map\("field_operator_name"\)\s+@db\.VarChar\(64\)/
    );
    expect(workOrder).toMatch(
      /fieldOperatorPhone\s+String\?\s+@map\("field_operator_phone"\)\s+@db\.VarChar\(32\)/
    );
    expect(workOrder).toContain("@@index([fieldOperatorPhone])");
    expect(migration).toMatch(
      /ALTER TABLE "vehicle_handover_work_order"[\s\S]*ADD COLUMN "field_operator_name" VARCHAR\(64\),[\s\S]*ADD COLUMN "field_operator_phone" VARCHAR\(32\);/
    );
    expect(migration).toMatch(
      /UPDATE "vehicle_handover_work_order"[\s\S]*SET "field_operator_name" = "external_operator_name",[\s\S]*"field_operator_phone" = "external_operator_phone"[\s\S]*WHERE "operator_type" = 'EXTERNAL';/
    );
    expect(migration).toMatch(
      /UPDATE "vehicle_handover_work_order" AS "work_order"[\s\S]*SET "field_operator_name" = "user"\."name",[\s\S]*"field_operator_phone" = "user"\."mobile"[\s\S]*FROM "user"[\s\S]*"work_order"\."operator_type" = 'INTERNAL'[\s\S]*"work_order"\."assigned_internal_user_id" = "user"\."id";/
    );
    expect(migration).toContain('CREATE INDEX "vehicle_handover_work_order_field_operator_phone_idx"');
  });

  it("adds SMS idempotency with a partial unique index", () => {
    const smsSendLog = extractPrismaBlock(schema, "model", "SmsSendLog");

    expect(smsSendLog).toMatch(
      /idempotencyKey\s+String\?\s+@unique\s+@map\("idempotency_key"\)\s+@db\.VarChar\(256\)/
    );
    expect(migration).toMatch(
      /ALTER TABLE "sms_send_log"[\s\S]*ADD COLUMN "idempotency_key" VARCHAR\(256\);/
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "sms_send_log_idempotency_key_key"[\s\S]*ON "sms_send_log"\("idempotency_key"\)[\s\S]*WHERE "idempotency_key" IS NOT NULL;/
    );
  });

  it("appends the Stage 2 notification and SMS purpose values", () => {
    for (const enumName of [
      "NotificationTemplateType",
      "NotificationType",
      "NotificationEventType"
    ]) {
      expect(prismaEnumValues(schema, enumName)).toEqual(
        expect.arrayContaining(handoverNotificationValues)
      );
    }
    expect(prismaEnumValues(schema, "CustomerVerificationCodePurpose")).toEqual(
      expect.arrayContaining(["FIELD_HANDOVER_ESIGN_READY", "CUSTOMER_HANDOVER_ESIGN_READY"])
    );

    for (const sqlEnumName of [
      "notification_template_type",
      "notification_type",
      "notification_event_type"
    ]) {
      for (const value of handoverNotificationValues) {
        expect(migration).toContain(`ALTER TYPE "${sqlEnumName}"\n  ADD VALUE IF NOT EXISTS '${value}';`);
      }
    }
    expect(migration).toContain(
      'ALTER TYPE "customer_verification_code_purpose"\n  ADD VALUE IF NOT EXISTS \'FIELD_HANDOVER_ESIGN_READY\';'
    );
    expect(migration).toContain(
      'ALTER TYPE "customer_verification_code_purpose"\n  ADD VALUE IF NOT EXISTS \'CUSTOMER_HANDOVER_ESIGN_READY\';'
    );
  });

  it("documents exact disabled workflow and SMS template defaults in both environments", () => {
    for (const source of [developmentEnv, productionEnv]) {
      for (const [name, expectedValue] of Object.entries(environmentDefaults)) {
        expect(environmentValue(source, name)).toBe(expectedValue);
      }
    }
  });

  it("does not drop legacy assignment or eSign columns", () => {
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
  });
});
