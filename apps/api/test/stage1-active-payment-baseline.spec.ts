import { MODULE_METADATA } from "@nestjs/common/constants";
import { SubscriptionAutomationJobType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AutoDebitConfig } from "../src/auto-debit/auto-debit.config";
import { AutoDebitController } from "../src/auto-debit/auto-debit.controller";
import { STAGE1_AUTO_DEBIT_JOB_TYPES } from "../src/auto-debit/auto-debit.policy";
import { AutoDebitScheduler } from "../src/auto-debit/auto-debit.scheduler";
import { BillingAutomationHandlers } from "../src/billing-automation/billing-automation.handlers";
import { PortalModule } from "../src/portal/portal.module";

describe("Stage 1 active-payment-only runtime boundary", () => {
  it("never schedules delegated debit jobs even with a legacy enabled fixture", async () => {
    const Scheduler = AutoDebitScheduler as unknown as new (
      config: AutoDebitConfig
    ) => AutoDebitScheduler;
    const scheduler = new Scheduler({
      enabled: true,
      environment: "staging",
      mockEnabled: true,
      provider: "mock",
      runTime: "09:00",
      wechatTemplateId: null
    });
    const transaction = {
      subscriptionAutomationJob: { upsert: vi.fn() }
    };

    await expect(
      scheduler.enqueueForBill(transaction as never, {
        dueDate: new Date("2026-09-01T00:00:00.000Z"),
        id: "bill-1",
        orderId: "order-1"
      })
    ).resolves.toEqual([]);
    expect(transaction.subscriptionAutomationJob.upsert).not.toHaveBeenCalled();
  });

  it("does not advertise retired job types to the billing worker", () => {
    const Handler = BillingAutomationHandlers as unknown as new (
      ...dependencies: unknown[]
    ) => BillingAutomationHandlers;
    const handlers = new Handler({}, {}, {}, {});

    expect(handlers.supportedJobTypes).not.toEqual(
      expect.arrayContaining([...STAGE1_AUTO_DEBIT_JOB_TYPES])
    );
    expect(handlers.supportedJobTypes).toEqual([
      SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.MARK_BILL_OVERDUE,
      SubscriptionAutomationJobType.SEND_BILL_OVERDUE_NOTICE
    ]);
  });

  it("exposes no auto-debit mutation methods", () => {
    for (const method of [
      "queryAttempt",
      "requestManualDebit",
      "cancelJob",
      "setMockNextResult",
      "syncMandate",
      "revokeMandate"
    ]) {
      expect(AutoDebitController.prototype).not.toHaveProperty(method);
    }
  });

  it("registers no customer auto-debit controller", () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PortalModule) as Array<{
      name: string;
    }>;

    expect(controllers.map(({ name }) => name)).not.toContain("PortalAutoDebitController");
  });
});
