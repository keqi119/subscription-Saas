import { describe, expect, it, vi } from "vitest";

import { PortalAutoDebitController } from "../src/auto-debit/portal-auto-debit.controller";

describe("PortalAutoDebitController", () => {
  it("exposes availability without leaking Staging mock controls", async () => {
    const service = {
      getPortalAvailability: vi.fn().mockReturnValue({
        enabled: false,
        mode: "DISABLED",
        provider: null
      })
    };
    const controller = new PortalAutoDebitController(service as never);

    const result = controller.availability();

    expect(result).toEqual({ enabled: false, mode: "DISABLED", provider: null });
    expect(result).not.toHaveProperty("mockEnabled");
    expect(result).not.toHaveProperty("environment");
  });

  it("delegates mandate creation with the authenticated customer", async () => {
    const service = {
      createPortalMandate: vi.fn().mockResolvedValue({ id: "mandate-1" })
    };
    const controller = new PortalAutoDebitController(service as never);
    const currentCustomer = {
      accountStatus: "ACTIVE" as const,
      customerAccountId: "account-1",
      customerId: "customer-1",
      phone: "13800000000"
    };

    await expect(
      controller.createMandate(
        { orderId: "00000000-0000-4000-8000-000000000001" },
        currentCustomer,
        { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" } as never
      )
    ).resolves.toEqual({ id: "mandate-1" });
    expect(service.createPortalMandate).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      currentCustomer,
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );
  });
});
