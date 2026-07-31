import { BadRequestException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import { validate } from "class-validator";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { BillingAutomationAdminService } from "../src/billing-automation/billing-automation.admin.service";
import { BillingAutomationController } from "../src/billing-automation/billing-automation.controller";
import { PauseBillingScheduleDto } from "../src/billing-automation/billing-automation.dto";

describe("BillingAutomationController", () => {
  it("uses billing view permission for all read endpoints", () => {
    for (const handler of [
      BillingAutomationController.prototype.summary,
      BillingAutomationController.prototype.listSchedules,
      BillingAutomationController.prototype.listJobs
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.BILLING_VIEW
      ]);
    }
  });

  it("uses billing generate permission for recovery actions", () => {
    for (const handler of [
      BillingAutomationController.prototype.reconcile,
      BillingAutomationController.prototype.pauseSchedule,
      BillingAutomationController.prototype.resumeSchedule,
      BillingAutomationController.prototype.retryJob
    ]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
        PermissionCode.BILLING_GENERATE
      ]);
    }
  });

  it("requires a non-empty pause reason", async () => {
    const dto = Object.assign(new PauseBillingScheduleDto(), {
      reason: "   "
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
  });

  it("rejects retry when the job is not in dead letter", async () => {
    const repository = {
      retryDeadLetter: vi.fn().mockResolvedValue(false)
    };
    const service = new BillingAutomationAdminService(
      {} as never,
      repository as never,
      {} as never,
      {} as never
    );

    await expect(
      service.retryJob("00000000-0000-4000-8000-000000000001", testUser(), {})
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function testUser() {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    menus: [],
    name: "Admin",
    permissions: [PermissionCode.BILLING_GENERATE],
    roles: ["ADMIN"],
    username: "admin"
  };
}
