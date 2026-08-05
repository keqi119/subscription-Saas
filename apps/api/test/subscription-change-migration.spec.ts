import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("subscription change migrations", () => {
  it.each([
    "20260805120000_stage1b_contract_extension_renewal",
    "20260805143000_subscription_change_command_idempotency",
    "20260805150000_renewal_sms_purposes",
    "20260805170000_lease_completed_status",
    "20260805180000_contract_esign_active_task_unique",
    "20260805181000_subscription_change_command_updated_at"
  ])("lets Prisma own the transaction boundary for %s", (migration) => {
    const sql = readFileSync(
      join(process.cwd(), "prisma", "migrations", migration, "migration.sql"),
      "utf8"
    );

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
});
