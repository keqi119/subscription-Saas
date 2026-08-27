import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PortalRenewalService } from "../src/portal/portal-renewal.service";
import { SubscriptionChangeRepository } from "../src/subscription-change/subscription-change.repository";

describe("Portal renewal ownership", () => {
  it("returns 404 rather than exposing another customer's consideration", async () => {
    const prisma = {
      renewalConsideration: { findFirst: vi.fn(async () => null) }
    };
    const service = new PortalRenewalService(
      prisma as never,
      { write: vi.fn() } as never,
      { enabled: true, now: () => new Date(), quoteValidityHours: 72 },
      new SubscriptionChangeRepository(prisma as never)
    );

    await expect(service.get("consideration-other", customer())).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.renewalConsideration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "consideration-other",
          order: { customerId: "customer-1" }
        })
      })
    );
  });

  it("returns 404 rather than exposing another customer's change", async () => {
    const prisma = {
      subscriptionChangeOrder: { findFirst: vi.fn(async () => null) }
    };
    const service = new PortalRenewalService(
      prisma as never,
      { write: vi.fn() } as never,
      { enabled: true, now: () => new Date(), quoteValidityHours: 72 },
      new SubscriptionChangeRepository(prisma as never)
    );

    await expect(service.getChange("change-other", customer())).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

function customer() {
  return {
    accountStatus: "ACTIVE",
    customerAccountId: "account-1",
    customerId: "customer-1",
    phone: "13800138000"
  } as never;
}
