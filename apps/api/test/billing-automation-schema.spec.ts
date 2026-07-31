import {
  BillingScheduleStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("billing automation persistence contract", () => {
  it("exposes one schedule per order and durable leased jobs", () => {
    const schedule = model("BillingSchedule");
    const job = model("SubscriptionAutomationJob");

    expect(field(schedule, "orderId")).toMatchObject({
      type: "String"
    });
    expect(field(schedule, "nextGenerateAt")).toMatchObject({
      type: "DateTime"
    });
    expect(field(schedule, "version")).toMatchObject({
      type: "Int"
    });
    expect(field(job, "idempotencyKey")).toMatchObject({
      type: "String"
    });
    expect(field(job, "leaseToken")).toMatchObject({
      type: "String"
    });
    expect(field(job, "leaseExpiresAt")).toMatchObject({
      type: "DateTime"
    });

    expect(migrationSql()).toContain(
      'CREATE UNIQUE INDEX "billing_schedule_order_id_key"'
    );
    expect(migrationSql()).toContain(
      'CREATE UNIQUE INDEX "subscription_automation_job_idempotency_key_key"'
    );
    expect(migrationSql()).toContain(
      '"next_generate_at" TIMESTAMPTZ(6) NOT NULL'
    );
    expect(migrationSql()).toContain(
      '"version" INTEGER NOT NULL DEFAULT 0'
    );
  });

  it("gives receivable bills a database-enforced optional source key", () => {
    expect(field(model("ReceivableBill"), "sourceKey")).toMatchObject({
      type: "String"
    });
    expect(migrationSql()).toContain(
      'CREATE UNIQUE INDEX "receivable_bill_source_key_key"'
    );
  });

  it("defines only the approved first-batch statuses and job types", () => {
    expect(Object.values(BillingScheduleStatus)).toEqual([
      "ACTIVE",
      "PAUSED",
      "COMPLETED",
      "CANCELLED"
    ]);
    expect(Object.values(SubscriptionAutomationJobStatus)).toEqual([
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "DEAD_LETTER",
      "CANCELLED"
    ]);
    expect(Object.values(SubscriptionAutomationJobType)).toEqual([
      "GENERATE_MONTHLY_RENT_BILL",
      "SEND_BILL_DUE_NOTICE",
      "MARK_BILL_OVERDUE",
      "SEND_BILL_OVERDUE_NOTICE"
    ]);
  });
});

function model(name: string) {
  const value = Prisma.dmmf.datamodel.models.find(
    (candidate) => candidate.name === name
  );
  expect(value, `Prisma model ${name} is missing`).toBeDefined();
  return value!;
}

function field(
  source: ReturnType<typeof model>,
  name: string
) {
  const value = source.fields.find((candidate) => candidate.name === name);
  expect(
    value,
    `Prisma field ${source.name}.${name} is missing`
  ).toBeDefined();
  return value!;
}

function migrationSql() {
  return readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260731120000_stage1b_billing_automation/migration.sql"
    ),
    "utf8"
  );
}
