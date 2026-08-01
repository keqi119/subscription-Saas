import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql"),
  "utf8"
);
const executableMigrationStatements = splitSqlStatements(migration);
const executableMigration = `${executableMigrationStatements.join(";\n")};`;
const developmentEnv = readFileSync(join(root, ".env.example"), "utf8");
const productionEnv = readFileSync(join(root, ".env.production.example"), "utf8");
const runtimeSourceArtifactContract = readFileSync(
  join(root, "src/handover-work-order/stage2-handover-source-artifact.ts"),
  "utf8"
);
const offlineSourceArtifactContract = readFileSync(
  join(root, "../../scripts/stage2-handover-workflow-contract.mjs"),
  "utf8"
);

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
const smsSendStatuses = ["SENT", "FAILED", "SKIPPED", "SENDING", "UNCERTAIN"];
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
  '"max_attempts" INTEGER NOT NULL DEFAULT 6,',
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
const workflowJobPrimaryKeyDefinition =
  'CONSTRAINT "vehicle_handover_workflow_job_pkey" PRIMARY KEY ("id")';
const workflowJobTableStatement = `CREATE TABLE "vehicle_handover_workflow_job" (
  ${workflowJobColumnDefinitions.join("\n  ")}
  ${workflowJobPrimaryKeyDefinition}
);`;
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
  ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_510795093",
  ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE: "SMS_510815118",
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
  const match = source.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([\\s\\S]*?)\\);`));
  expect(match, `missing SQL enum ${name}`).not.toBeNull();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((value) => value[1]!);
}

function normalizeSql(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let index = 0;

  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];

    if (current === "'" || current === '"') {
      const quote = current;
      statement += current;
      index += 1;
      while (index < source.length) {
        const quoted = source[index]!;
        const afterQuoted = source[index + 1];

        statement += quoted;
        index += 1;
        if (quoted === "\\" && afterQuoted !== undefined) {
          statement += afterQuoted;
          index += 1;
        } else if (quoted === quote && afterQuoted === quote) {
          statement += afterQuoted;
          index += 1;
        } else if (quoted === quote) {
          break;
        }
      }
      continue;
    }

    if (current === "$") {
      const dollarQuote = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (dollarQuote !== undefined) {
        statement += dollarQuote;
        index += dollarQuote.length;
        while (index < source.length) {
          if (source.startsWith(dollarQuote, index)) {
            statement += dollarQuote;
            index += dollarQuote.length;
            break;
          }
          statement += source[index]!;
          index += 1;
        }
        continue;
      }
    }

    if (current === "-" && next === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      statement += "\n";
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
            statement += source[index];
          }
          index += 1;
        }
      }
      statement += " ";
      continue;
    }
    if (current === ";") {
      if (statement.trim().length > 0) {
        statements.push(statement.trim());
      }
      statement = "";
      index += 1;
      continue;
    }

    statement += current;
    index += 1;
  }

  if (statement.trim().length > 0) {
    statements.push(statement.trim());
  }

  return statements;
}

function extractSqlTable(source: string, name: string): string {
  const match = source.match(new RegExp(`^CREATE\\s+TABLE\\s+"${name}"\\s*\\(([\\s\\S]*)\\)$`));
  expect(match, `missing SQL table ${name}`).not.toBeNull();
  return normalizeSql(match![1]!);
}

function expectSingleSqlStatement(statements: readonly string[], expected: string): string {
  const normalizedExpected = normalizeSql(expected).replace(/;$/, "");
  const matches = statements.filter((statement) => normalizeSql(statement) === normalizedExpected);

  expect(matches, `expected one executable instance of ${normalizedExpected}`).toHaveLength(1);
  return matches[0]!;
}

function environmentValue(source: string, name: string): string | undefined {
  return source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
}

function sourceArtifactVersion(source: string): number | undefined {
  const value = source.match(/STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION\s*=\s*(\d+)/)?.[1];
  return value === undefined ? undefined : Number(value);
}

describe("Stage 2 durable workflow schema", () => {
  it("keeps runtime and offline source artifact contracts on version 2", () => {
    expect(sourceArtifactVersion(runtimeSourceArtifactContract)).toBe(2);
    expect(sourceArtifactVersion(offlineSourceArtifactContract)).toBe(2);
  });

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
    expect(job).toMatch(/maxAttempts\s+Int\s+@default\(6\)\s+@map\("max_attempts"\)/);
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
    expect(job).toMatch(
      /updatedAt\s+DateTime\s+@updatedAt\s+@map\("updated_at"\)\s+@db\.Timestamptz\(6\)/
    );
    expect(job).toContain("@@index([jobStatus, availableAt])");
    expect(job).toContain("@@index([workOrderId, createdAt])");
    expect(job).toContain("@@index([leaseExpiresAt])");
    expect(job).toContain('@@map("vehicle_handover_workflow_job")');
    expect(workOrder).toContain("workflowJobs                 VehicleHandoverWorkflowJob[]");
  });

  it("creates the durable job table, foreign key, unique key, and claim indexes", () => {
    const jobTableStatement = expectSingleSqlStatement(
      executableMigrationStatements,
      workflowJobTableStatement
    );
    const jobTable = extractSqlTable(jobTableStatement, "vehicle_handover_workflow_job");

    for (const definition of workflowJobColumnDefinitions) {
      expect(jobTable).toContain(definition);
    }
    expect(jobTable).toContain(workflowJobPrimaryKeyDefinition);
    for (const statement of requiredWorkflowMigrationStatements.slice(1)) {
      expectSingleSqlStatement(executableMigrationStatements, statement);
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
      /UPDATE "vehicle_handover_work_order" AS "work_order"[\s\S]*SET "field_operator_name" = "user"\."name",[\s\S]*"field_operator_phone" = "user"\."mobile"[\s\S]*FROM "user"[\s\S]*"work_order"\."operator_type" = 'INTERNAL'[\s\S]*"work_order"\."assigned_internal_user_id" = "user"\."id"[\s\S]*"user"\."status" = 'ACTIVE'::"user_status"[\s\S]*"user"\."deleted_at" IS NULL;/
    );
    expect(executableMigration).toContain(
      'CREATE INDEX "vehicle_handover_work_order_field_operator_phone_idx"'
    );
  });

  it("adds SMS idempotency with a partial unique index", () => {
    const smsSendLog = extractPrismaBlock(schema, "model", "SmsSendLog");

    expect(prismaEnumValues(schema, "SmsSendStatus")).toEqual(smsSendStatuses);
    for (const status of ["SENDING", "UNCERTAIN"]) {
      expect(executableMigration).toContain(
        `ALTER TYPE "sms_send_status"\n  ADD VALUE IF NOT EXISTS '${status}';`
      );
    }
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
      "ALTER TYPE \"customer_verification_code_purpose\"\n  ADD VALUE IF NOT EXISTS 'FIELD_HANDOVER_ESIGN_READY';"
    );
    expect(executableMigration).toContain(
      "ALTER TYPE \"customer_verification_code_purpose\"\n  ADD VALUE IF NOT EXISTS 'CUSTOMER_HANDOVER_ESIGN_READY';"
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
    const uncommented = splitSqlStatements(quotedComments).join(";\n");

    expect(uncommented).toContain("'-- literal'");
    expect(uncommented).toContain('"/* identifier */"');
    expect(uncommented).toContain("'/* literal */'");
    expect(uncommented).not.toContain("outer");

    for (const statement of requiredWorkflowMigrationStatements) {
      expect(() =>
        expectSingleSqlStatement(splitSqlStatements(`-- ${statement}`), statement)
      ).toThrow();
      expect(() =>
        expectSingleSqlStatement(splitSqlStatements(`/* ${statement} */`), statement)
      ).toThrow();
      expect(() =>
        expectSingleSqlStatement(splitSqlStatements(`${migration}\n${statement}`), statement)
      ).toThrow();
    }
  });

  it("rejects required workflow statements embedded in quoted literals", () => {
    for (const statement of requiredWorkflowMigrationStatements) {
      const quotedDecoys = [
        `SELECT '${statement.replaceAll("'", "''")}';`,
        `SELECT "${statement.replaceAll('"', '""')}";`,
        `SELECT $$${statement}$$;`,
        `SELECT $decoy$${statement}$decoy$;`
      ];

      for (const quotedDecoy of quotedDecoys) {
        expect(() =>
          expectSingleSqlStatement(splitSqlStatements(quotedDecoy), statement)
        ).toThrow();
      }
    }
  });

  it("preserves quoted identifiers, defaults, and semicolons inside quoted regions", () => {
    const jobTableStatement = expectSingleSqlStatement(
      executableMigrationStatements,
      workflowJobTableStatement
    );
    const quotedFixture = `CREATE TABLE "workflow""job" (
      "status" TEXT DEFAULT 'PEND''ING',
      "backslash" TEXT DEFAULT E'it\\'s pending',
      "body" TEXT DEFAULT $value$semi; -- literal$value$
    );
    SELECT 1;`;

    expect(jobTableStatement).toContain('"job_status"');
    expect(jobTableStatement).toContain("DEFAULT 'PENDING'");
    expect(splitSqlStatements(quotedFixture)).toEqual([
      `CREATE TABLE "workflow""job" (
      "status" TEXT DEFAULT 'PEND''ING',
      "backslash" TEXT DEFAULT E'it\\'s pending',
      "body" TEXT DEFAULT $value$semi; -- literal$value$
    )`,
      "SELECT 1"
    ]);
  });
});
