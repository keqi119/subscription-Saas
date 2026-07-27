import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260727120000_stage2_field_orchestrated_workflow/migration.sql"),
  "utf8"
);

describe("Stage 2 durable workflow schema", () => {
  it("defines canonical operator snapshots and the workflow job contract", () => {
    expect(schema).toContain("fieldOperatorName");
    expect(schema).toContain("fieldOperatorPhone");
    expect(schema).toContain("model VehicleHandoverWorkflowJob");
    expect(schema).toContain("idempotencyKey");
    expect(schema).toContain("leaseExpiresAt");
    expect(schema).toContain("DEAD_LETTER");
  });

  it("migrates without dropping legacy assignment or eSign columns", () => {
    expect(migration).toContain("vehicle_handover_workflow_job");
    expect(migration).toContain("field_operator_phone");
    expect(migration).toContain("sms_send_log");
    expect(migration).not.toMatch(/DROP COLUMN/i);
  });
});
