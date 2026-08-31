import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationName = "20260901010000_stage1_schema_drift_convergence";
const migrationsRoot = join(process.cwd(), "prisma", "migrations");
const migrationPath = join(migrationsRoot, migrationName, "migration.sql");
const ciWorkflowPath = join(process.cwd(), "..", "..", ".github", "workflows", "ci.yml");

describe("Stage 1 schema drift convergence migration", () => {
  it("is the 126th append-only migration", () => {
    const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(migrations).toHaveLength(126);
    expect(migrations.at(-1)).toBe(migrationName);
  });

  it("converges defaults and constraints without deleting business structures or data", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
    expect(sql.match(/ALTER COLUMN "(?:updated_at|id)" DROP DEFAULT/g)).toHaveLength(23);
    expect(sql.match(/ DROP CONSTRAINT /g)).toHaveLength(3);
    expect(sql.match(/ ADD CONSTRAINT /g)).toHaveLength(3);
    expect(sql).not.toMatch(/ RENAME CONSTRAINT /);
    expect(sql.match(/ALTER INDEX .* RENAME TO /g)).toHaveLength(1);
    expect(sql).toContain(
      'ALTER INDEX "vehicle_handover_review_attempt_sent_back_to_customer_review_by" RENAME TO "vehicle_handover_review_attempt_sent_back_to_customer_revie_idx"'
    );
    expect(sql).toContain(
      'FOREIGN KEY ("model_definition_id") REFERENCES "vehicle_model_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE'
    );
    expect(sql).not.toMatch(/subscription_journey_(?:exception|job|manual_task).*DROP CONSTRAINT/);
    expect(sql).not.toMatch(/vehicle_mileage_reading.*(?:DROP|ADD) CONSTRAINT/);
    expect(sql).not.toMatch(/^\s*(?:DELETE|INSERT|TRUNCATE|UPDATE)\b/im);
    expect(sql).not.toMatch(/DROP\s+(?:COLUMN|TABLE|TYPE)\b/i);
  });

  it("keeps a fresh PostgreSQL schema drift gate in CI", () => {
    const workflow = readFileSync(ciWorkflowPath, "utf8");
    const migrationStatus = workflow.indexOf("- name: Migration status");
    const driftGate = workflow.indexOf("- name: Schema drift check");
    const apiTests = workflow.indexOf("- name: API tests");

    expect(migrationStatus).toBeGreaterThan(-1);
    expect(driftGate).toBeGreaterThan(migrationStatus);
    expect(apiTests).toBeGreaterThan(driftGate);
    expect(workflow).toContain(
      "pnpm --filter @subscription-saas/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code"
    );
  });
});
