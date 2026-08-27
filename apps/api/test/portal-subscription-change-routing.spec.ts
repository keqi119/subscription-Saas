import { CustomerAccountStatus, SubscriptionChangeType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PortalSubscriptionChangeService } from "../src/portal/portal-subscription-change.service";

describe("PortalSubscriptionChangeService early-termination routing", () => {
  it("returns the owned early-termination projection", async () => {
    const harness = portalHarness();

    await expect(harness.service.getChange("change-early", harness.customer)).resolves.toEqual({
      id: "change-early",
      type: "EARLY_TERMINATION"
    });
    expect(harness.early.getPortalChange).toHaveBeenCalledWith(
      "change-early",
      harness.customer
    );
    expect(harness.renewal.getChange).not.toHaveBeenCalled();
  });

  it("routes quote confirmation as an ACCEPT decision", async () => {
    const harness = portalHarness();
    const input = {
      quoteId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a",
      revision: 2,
      version: 5
    };

    await harness.service.confirmQuote(
      "change-early",
      input,
      harness.customer,
      harness.context
    );

    expect(harness.early.decide).toHaveBeenCalledWith(
      "change-early",
      expect.objectContaining({
        decision: "ACCEPT",
        revision: 2,
        version: 5
      }),
      harness.customer,
      harness.context
    );
    expect(harness.swaps.confirmQuote).not.toHaveBeenCalled();
    expect(harness.renewal.confirmQuote).not.toHaveBeenCalled();
  });

  it("routes quote rejection as a REJECT decision", async () => {
    const harness = portalHarness();
    const input = {
      quoteId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a",
      reason: "Customer declined",
      revision: 2,
      version: 5
    };

    await harness.service.rejectQuote(
      "change-early",
      input,
      harness.customer,
      harness.context
    );

    expect(harness.early.decide).toHaveBeenCalledWith(
      "change-early",
      expect.objectContaining({
        decision: "REJECT",
        reason: "Customer declined",
        revision: 2,
        version: 5
      }),
      harness.customer,
      harness.context
    );
    expect(harness.swaps.rejectQuote).not.toHaveBeenCalled();
    expect(harness.renewal.rejectQuote).not.toHaveBeenCalled();
  });
});

function portalHarness() {
  const customer = {
    accountStatus: CustomerAccountStatus.ACTIVE,
    customerAccountId: "customer-account-1",
    customerId: "customer-1",
    phone: "13900000000"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const prisma = {
    subscriptionChangeOrder: {
      findFirst: vi.fn(async () => ({ changeType: SubscriptionChangeType.EARLY_TERMINATION }))
    }
  };
  const renewal = {
    confirmQuote: vi.fn(),
    getChange: vi.fn(),
    rejectQuote: vi.fn()
  };
  const swaps = {
    confirmQuote: vi.fn(),
    getPortalChange: vi.fn(),
    rejectQuote: vi.fn()
  };
  const early = {
    decide: vi.fn(async () => ({ status: "CUSTOMER_CONFIRMED" })),
    getPortalChange: vi.fn(async () => ({ id: "change-early", type: "EARLY_TERMINATION" }))
  };
  const service = new PortalSubscriptionChangeService(
    prisma as never,
    renewal as never,
    swaps as never,
    early as never
  );
  return { context, customer, early, prisma, renewal, service, swaps };
}
