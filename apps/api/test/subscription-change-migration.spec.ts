import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readMigration(migration: string) {
  try {
    return readFileSync(
      join(process.cwd(), "prisma", "migrations", migration, "migration.sql"),
      "utf8"
    );
  } catch {
    return "";
  }
}

describe("subscription change migrations", () => {
  it.each([
    "20260805120000_stage1b_contract_extension_renewal",
    "20260805143000_subscription_change_command_idempotency",
    "20260805150000_renewal_sms_purposes",
    "20260805170000_lease_completed_status",
    "20260805180000_contract_esign_active_task_unique",
    "20260805181000_subscription_change_command_updated_at",
    "20260826020000_stage1_active_term_change_center"
  ])("lets Prisma own the transaction boundary for %s", (migration) => {
    const sql = readMigration(migration);

    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });

  it("enforces one active e-sign task per contract at the database boundary", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma",
        "migrations",
        "20260805180000_contract_esign_active_task_unique",
        "migration.sql"
      ),
      "utf8"
    );

    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(sql).toContain('ON "contract_esign_task"("contract_id")');
    expect(sql).toContain('"deleted_at" IS NULL');
    for (const status of ["CREATED", "WAITING_CUSTOMER", "SIGNING", "COMPLETED"]) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it("migrates extension roots into typed details without weakening active-order uniqueness", () => {
    const migration = "20260826020000_stage1_active_term_change_center";
    const sql = readMigration(migration);

    expect(sql).toContain('ALTER COLUMN "extension_months" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "pricing_mode" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "source_segment_id" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "target_start_date" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "target_end_date" DROP NOT NULL');
    expect(sql).toContain('INSERT INTO "subscription_extension_change_detail"');
    expect(sql).toContain('FROM "subscription_change_order"');
    expect(sql).toContain("subscription_change_order_one_active_per_order");
    for (const status of [
      "DRAFT",
      "QUOTED",
      "CUSTOMER_CONFIRMED",
      "SIGNING_OR_PAYMENT",
      "SCHEDULED",
      "EXECUTING",
      "MANUAL_TAKEOVER"
    ]) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});
