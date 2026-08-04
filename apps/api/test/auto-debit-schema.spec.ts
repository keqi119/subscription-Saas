import * as PrismaClient from "@prisma/client";
import { Prisma } from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("auto debit persistence contract", () => {
  it("exposes mandate and debit attempt relations", () => {
    const mandate = model("PaymentMandate");
    const attempt = model("DebitAttempt");

    expect(field(mandate, "customerId")).toMatchObject({ type: "String" });
    expect(field(mandate, "orderId")).toMatchObject({ type: "String" });
    expect(field(mandate, "providerMandateId")).toMatchObject({
      type: "String"
    });
    expect(field(mandate, "status")).toMatchObject({
      type: "PaymentMandateStatus"
    });

    expect(field(attempt, "mandateId")).toMatchObject({ type: "String" });
    expect(field(attempt, "billId")).toMatchObject({ type: "String" });
    expect(field(attempt, "paymentOrderId")).toMatchObject({
      type: "String"
    });
    expect(field(attempt, "requestedAmount")).toMatchObject({ type: "BigInt" });
    expect(field(attempt, "confirmedAmount")).toMatchObject({ type: "BigInt" });
  });

  it("publishes the approved domain enum values", () => {
    expect(enumValues("PaymentMandateStatus")).toEqual([
      "PENDING",
      "ACTIVE",
      "SUSPENDED",
      "REVOKED",
      "EXPIRED",
      "FAILED"
    ]);
    expect(enumValues("DebitAttemptStatus")).toEqual([
      "CREATED",
      "SUBMITTING",
      "PROCESSING",
      "UNKNOWN",
      "SUCCEEDED",
      "FAILED_RETRYABLE",
      "FAILED_FINAL",
      "CANCELLED"
    ]);
    expect(enumValues("DebitRetrySlot")).toEqual([
      "DUE",
      "D1",
      "D3",
      "MANUAL"
    ]);
  });

  it("extends automation, payment, and notification enums", () => {
    expect(enumValues("SubscriptionAutomationJobType")).toEqual(
      expect.arrayContaining([
        "SUBMIT_BILL_DEBIT",
        "QUERY_DEBIT_ATTEMPT",
        "SEND_DEBIT_FAILURE_NOTICE",
        "SYNC_PAYMENT_MANDATE"
      ])
    );
    expect(enumValues("PaymentChannel")).toContain("WECHAT_AUTO_DEBIT");
    expect(enumValues("NotificationTemplateType")).toContain(
      "AUTO_DEBIT_FAILURE"
    );
    expect(enumValues("NotificationType")).toContain("AUTO_DEBIT_FAILURE");
    expect(enumValues("NotificationEventType")).toContain(
      "AUTO_DEBIT_FAILED"
    );
  });

  it("publishes independent auto debit permissions", () => {
    expect(PermissionCode.AUTO_DEBIT_VIEW).toBe("auto_debit:view");
    expect(PermissionCode.AUTO_DEBIT_MANAGE).toBe("auto_debit:manage");
    expect(PermissionCode.AUTO_DEBIT_EXECUTE).toBe("auto_debit:execute");
  });

  it("enforces open-mandate, provider, amount, and idempotency constraints", () => {
    const sql = migrationSql();

    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "payment_mandate_one_open_per_order_key"'
    );
    expect(sql).toContain(
      "WHERE \"status\" IN ('PENDING', 'ACTIVE', 'SUSPENDED')"
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "payment_mandate_provider_mandate_id_key"'
    );
    expect(sql).toContain('WHERE "provider_mandate_id" IS NOT NULL');
    expect(sql).toContain('CHECK ("requested_amount" > 0)');
    expect(sql).toContain('CHECK ("confirmed_amount" >= 0)');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "debit_attempt_payment_order_id_key"'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "debit_attempt_idempotency_key_key"'
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "debit_attempt_provider_out_trade_no_key"'
    );
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("claims each provider transaction for only one payment order", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260804190000_provider_transaction_uniqueness/migration.sql"
      ),
      "utf8"
    );

    expect(sql).toContain(
      'CREATE UNIQUE INDEX "payment_order_provider_transaction_id_key"'
    );
    expect(sql).toContain(
      'ON "payment_order"("provider", "provider_transaction_id")'
    );
    expect(sql).toContain('WHERE "provider_transaction_id" IS NOT NULL');
  });
});

function model(name: string) {
  const value = Prisma.dmmf.datamodel.models.find(
    (candidate) => candidate.name === name
  );
  expect(value, `Prisma model ${name} is missing`).toBeDefined();
  return value!;
}

function field(source: ReturnType<typeof model>, name: string) {
  const value = source.fields.find((candidate) => candidate.name === name);
  expect(value, `Prisma field ${source.name}.${name} is missing`).toBeDefined();
  return value!;
}

function enumValues(name: string) {
  const value = (PrismaClient as Record<string, unknown>)[name];
  expect(value, `Prisma enum ${name} is missing`).toBeDefined();
  return Object.values(value as Record<string, string>);
}

function migrationSql() {
  return readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260804163000_stage1b_auto_debit_foundation/migration.sql"
    ),
    "utf8"
  );
}
