import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionEffectiveBoundaryOwner } from "../src/subscription-change/subscription-effective-boundary";

describe("SubscriptionEffectiveBoundaryOwner", () => {
  it("plans one exact caller-owned command that preserves earned rent and stops only future automation", async () => {
    const orderId = "00000000-0000-4000-8000-000000000001";
    const scheduleId = "00000000-0000-4000-8000-000000000002";
    const entitlementId = "00000000-0000-4000-8000-000000000003";
    const earnedJobId = "00000000-0000-4000-8000-000000000004";
    const futureJobId = "00000000-0000-4000-8000-000000000005";
    const renewalJobId = "00000000-0000-4000-8000-000000000006";
    const billedJobId = "00000000-0000-4000-8000-000000000007";
    const tx = {
      billingSchedule: {
        findUnique: vi.fn(async () => ({
          completedAt: null,
          id: scheduleId,
          nextPeriodStart: new Date("2026-08-03T00:00:00.000Z"),
          orderId,
          pauseReason: null,
          status: "ACTIVE",
          version: 4
        }))
      },
      orderEntitlementAccount: {
        findMany: vi.fn(async () => [
          {
            accountStatus: "ACTIVE",
            deletedAt: null,
            id: entitlementId,
            orderId
          }
        ])
      },
      subscriptionAutomationJob: {
        findMany: vi.fn(async () => [
          job(earnedJobId, orderId, "GENERATE_MONTHLY_RENT_BILL", {
            periodStart: "2026-08-03"
          }),
          job(futureJobId, orderId, "GENERATE_MONTHLY_RENT_BILL", {
            periodStart: "2026-10-03"
          }),
          job(renewalJobId, orderId, "RENEWAL_REMINDER_D30", {}),
          { ...job(billedJobId, orderId, "RENEWAL_REMINDER_D14", {}), billId: billedJobId }
        ])
      }
    } as unknown as Prisma.TransactionClient;
    const repository = new SubscriptionClosureRepository();
    const session = repository.createAuthoritySessionInTransaction(tx);
    const owner = new SubscriptionEffectiveBoundaryOwner();

    const prepared = await owner.prepareInTransaction(tx, session, {
      boundaryAt: new Date("2026-09-01T08:00:00.000Z"),
      occurredAt: new Date("2026-09-01T08:00:01.000Z"),
      orderId
    });

    expect(prepared.requirement.command).toMatchObject({
      automationJobs: expect.arrayContaining([
        expect.objectContaining({ id: earnedJobId }),
        expect.objectContaining({ id: futureJobId }),
        expect.objectContaining({ id: renewalJobId }),
        expect.objectContaining({ id: billedJobId })
      ]),
      boundaryAt: new Date("2026-09-01T08:00:00.000Z"),
      cancelAutomationJobIds: [futureJobId, renewalJobId],
      closeEntitlementAccountIds: [entitlementId],
      orderId,
      scheduleAction: "PRESERVE_EARNED"
    });
    expect(prepared.requirement.command.schedule).toMatchObject({
      serviceEndDate: new Date("2026-09-01T00:00:00.000Z")
    });
    expect(prepared.requirement.locks).toEqual(
      expect.arrayContaining([
        { id: orderId, mode: "UPDATE", table: "subscription_order" },
        { id: scheduleId, mode: "UPDATE", table: "billing_schedule" },
        { id: entitlementId, mode: "UPDATE", table: "order_entitlement_account" },
        { id: earnedJobId, mode: "UPDATE", table: "subscription_automation_job" },
        { id: futureJobId, mode: "UPDATE", table: "subscription_automation_job" },
        { id: renewalJobId, mode: "UPDATE", table: "subscription_automation_job" },
        { id: billedJobId, mode: "UPDATE", table: "subscription_automation_job" }
      ])
    );
  });
});

function job(id: string, orderId: string, jobType: string, payload: Prisma.JsonObject) {
  return {
    billId: null,
    cancelledAt: null,
    completedAt: null,
    id,
    jobStatus: "PENDING",
    jobType,
    leaseExpiresAt: null,
    leaseToken: null,
    orderId,
    payload
  };
}
