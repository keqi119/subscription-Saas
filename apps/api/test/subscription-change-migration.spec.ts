import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("subscription change migrations", () => {
  it.each([
    "20260805120000_stage1b_contract_extension_renewal",
    "20260805143000_subscription_change_command_idempotency"
  ])("lets Prisma own the transaction boundary for %s", (migration) => {
    const sql = readFileSync(
      join(process.cwd(), "prisma", "migrations", migration, "migration.sql"),
      "utf8"
    );

    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
