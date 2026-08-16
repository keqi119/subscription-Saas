import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "prisma/migrations/20260817010000_stage2_handover_contract_archive_convergence/migration.sql"
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

describe("Stage 2 handover contract archive convergence migration", () => {
  it("converges only complete archived handover contracts onto the signed file", () => {
    expect(migration).toContain('UPDATE "contract" AS c');
    expect(migration).toContain('FROM "vehicle_delivery_handover" AS h');
    expect(migration).toContain('h."signed_document_file_id"');
    expect(migration).toContain('h."archive_status" = \'ARCHIVED\'');
    expect(migration).toContain('h."status" = \'ARCHIVED\'');
    expect(migration).toContain('c."deleted_at" IS NULL');
    expect(migration).toContain('h."deleted_at" IS NULL');
    expect(migration).toContain('c."status" IN (\'SIGNED\', \'ARCHIVED\')');
    expect(migration).toContain('EXISTS (');
    expect(migration).toContain('FROM "file_object" AS f');
    expect(migration).toContain('c."file_id" IS DISTINCT FROM h."signed_document_file_id"');
  });

  it("does not mutate workflow, e-sign task, or file rows", () => {
    expect(migration).not.toMatch(/UPDATE\s+"subscription_journey"/i);
    expect(migration).not.toMatch(/UPDATE\s+"vehicle_handover_work_order"/i);
    expect(migration).not.toMatch(/UPDATE\s+"contract_esign_task"/i);
    expect(migration).not.toMatch(/UPDATE\s+"file_object"/i);
  });
});
