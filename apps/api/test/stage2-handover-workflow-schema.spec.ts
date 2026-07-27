import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql"),
  "utf8"
);
const executableMigration = stripSqlComments(migration);
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
const workflowJobColumnDefinitions = [
  '"id" UUID NOT NULL,',
  '"work_order_id" UUID NOT NULL,',
  '"handover_id" UUID,',
  '"esign_task_id" UUID,',
  '"job_type" "vehicle_handover_workflow_job_type" NOT NULL,',
  '"job_status" "vehicle_handover_workflow_job_status" NOT NULL DEFAULT \'PENDING\',',
  '"idempotency_key" VARCHAR(256) NOT NULL,',
  '"available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  '"attempt_count" INTEGER NOT NULL DEFAULT 0,',
  '"max_attempts" INTEGER NOT NULL DEFAULT 5,',
  '"lease_token" UUID,',
  '"lease_expires_at" TIMESTAMPTZ(6),',
  '"payload" JSONB,',
  '"result_snapshot" JSONB,',
  '"last_error_code" VARCHAR(128),',
  '"last_error_message" VARCHAR(512),',
  '"started_at" TIMESTAMPTZ(6),',
  '"completed_at" TIMESTAMPTZ(6),',
  '"created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
  '"updated_at" TIMESTAMPTZ(6) NOT NULL,'
];
const workflowJobTableStatement = 'CREATE TABLE "vehicle_handover_workflow_job" (';
const workflowJobForeignKeyStatement =
  'ALTER TABLE "vehicle_handover_workflow_job" ADD CONSTRAINT "vehicle_handover_workflow_job_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "vehicle_handover_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;';
const workflowJobIndexStatements = [
  'CREATE UNIQUE INDEX "vehicle_handover_workflow_job_idempotency_key_key" ON "vehicle_handover_workflow_job"("idempotency_key");',
  'CREATE INDEX "vehicle_handover_workflow_job_job_status_available_at_idx" ON "vehicle_handover_workflow_job"("job_status", "available_at");',
  'CREATE INDEX "vehicle_handover_workflow_job_work_order_id_created_at_idx" ON "vehicle_handover_workflow_job"("work_order_id", "created_at");',
  'CREATE INDEX "vehicle_handover_workflow_job_lease_expires_at_idx" ON "vehicle_handover_workflow_job"("lease_expires_at");'
];
const requiredWorkflowMigrationStatements = [
  workflowJobTableStatement,
  workflowJobForeignKeyStatement,
  ...workflowJobIndexStatements
];
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

function normalizeSql(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function stripSqlComments(source: string): string {
  let output = "";
  let index = 0;
  let insideDoubleQuote = false;
  let insideSingleQuote = false;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];

    if (insideSingleQuote) {
      output += current;
      index += 1;
      if (current === "'" && next === "'") {
        output += next;
        index += 1;
      } else if (current === "'") {
        insideSingleQuote = false;
      }
      continue;
    }

    if (insideDoubleQuote) {
      output += current;
      index += 1;
      if (current === '"' && next === '"') {
        output += next;
        index += 1;
      } else if (current === '"') {
        insideDoubleQuote = false;
      }
      continue;
    }

    if (current === "'") {
      insideSingleQuote = true;
      output += current;
      index += 1;
      continue;
    }
    if (current === '"') {
      insideDoubleQuote = true;
      output += current;
      index += 1;
      continue;
    }
    if (current === "-" && next === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          if (source[index] === "\n" || source[index] === "\r") {
            output += source[index];
          }
          index += 1;
        }
      }
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function extractSqlTable(source: string, name: string): string {
  const match = source.match(
    new RegExp(`CREATE\\s+TABLE\\s+"${name}"\\s*\\(([\\s\\S]*?)\\);`)
  );
  expect(match, `missing SQL table ${name}`).not.toBeNull();
  return normalizeSql(match![1]!);
}

function expectSingleSqlStatement(source: string, statement: string): void {
  const normalizedSource = normalizeSql(source);
  const normalizedStatement = normalizeSql(statement);
  const count = normalizedSource.split(normalizedStatement).length - 1;

  expect(count, `expected one executable instance of ${normalizedStatement}`).toBe(1);
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
    expect(sqlEnumValues(executableMigration, "vehicle_handover_workflow_job_type")).toEqual(
      workflowJobTypes
    );
    expect(sqlEnumValues(executableMigration, "vehicle_handover_workflow_job_status")).toEqual(
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

  it("creates the durable job table, foreign key, unique key, and claim indexes", () => {
    const jobTable = extractSqlTable(executableMigration, "vehicle_handover_workflow_job");

    for (const definition of workflowJobColumnDefinitions) {
      expect(jobTable).toContain(definition);
    }
    expect(jobTable).toContain(
      'CONSTRAINT "vehicle_handover_workflow_job_pkey" PRIMARY KEY ("id")'
    );
    for (const statement of requiredWorkflowMigrationStatements) {
      expectSingleSqlStatement(executableMigration, statement);
    }
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
    expect(executableMigration).toMatch(
      /ALTER TABLE "vehicle_handover_work_order"[\s\S]*ADD COLUMN "field_operator_name" VARCHAR\(64\),[\s\S]*ADD COLUMN "field_operator_phone" VARCHAR\(32\);/
    );
    expect(executableMigration).toMatch(
      /UPDATE "vehicle_handover_work_order"[\s\S]*SET "field_operator_name" = "external_operator_name",[\s\S]*"field_operator_phone" = "external_operator_phone"[\s\S]*WHERE "operator_type" = 'EXTERNAL';/
    );
    expect(executableMigration).toMatch(
      /UPDATE "vehicle_handover_work_order" AS "work_order"[\s\S]*SET "field_operator_name" = "user"\."name",[\s\S]*"field_operator_phone" = "user"\."mobile"[\s\S]*FROM "user"[\s\S]*"work_order"\."operator_type" = 'INTERNAL'[\s\S]*"work_order"\."assigned_internal_user_id" = "user"\."id";/
    );
    expect(executableMigration).toContain(
      'CREATE INDEX "vehicle_handover_work_order_field_operator_phone_idx"'
    );
  });

  it("adds SMS idempotency with a partial unique index", () => {
    const smsSendLog = extractPrismaBlock(schema, "model", "SmsSendLog");

    expect(smsSendLog).toMatch(
      /idempotencyKey\s+String\?\s+@unique\s+@map\("idempotency_key"\)\s+@db\.VarChar\(256\)/
    );
    expect(executableMigration).toMatch(
      /ALTER TABLE "sms_send_log"[\s\S]*ADD COLUMN "idempotency_key" VARCHAR\(256\);/
    );
    expect(executableMigration).toMatch(
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
        expect(executableMigration).toContain(
          `ALTER TYPE "${sqlEnumName}"\n  ADD VALUE IF NOT EXISTS '${value}';`
        );
      }
    }
    expect(executableMigration).toContain(
      'ALTER TYPE "customer_verification_code_purpose"\n  ADD VALUE IF NOT EXISTS \'FIELD_HANDOVER_ESIGN_READY\';'
    );
    expect(executableMigration).toContain(
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
    expect(executableMigration).not.toMatch(/DROP\s+COLUMN/i);
  });

  it("rejects commented-out and duplicate workflow migration statements", () => {
    const quotedComments = `SELECT '-- literal', "/* identifier */"; -- comment\n/* outer /* nested */ comment */ SELECT '/* literal */';`;
    const uncommented = stripSqlComments(quotedComments);

    expect(uncommented).toContain("'-- literal'");
    expect(uncommented).toContain('"/* identifier */"');
    expect(uncommented).toContain("'/* literal */'");
    expect(uncommented).not.toContain("outer");

    for (const statement of requiredWorkflowMigrationStatements) {
      expect(() => expectSingleSqlStatement(stripSqlComments(`-- ${statement}`), statement)).toThrow();
      expect(() => expectSingleSqlStatement(`${executableMigration}\n${statement}`, statement)).toThrow();
    }
  });
});
