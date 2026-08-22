import "reflect-metadata";

import { GUARDS_METADATA, MODULE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { PortalBillingController } from "../src/portal/portal-billing.controller";
import { CustomerAuthGuard } from "../src/portal/portal-auth.guard";
import { PortalModule } from "../src/portal/portal.module";
import { SubscriptionClosureModule } from "../src/subscription-closure/subscription-closure.module";

describe("portal subscription closure boundary", () => {
  it("owns the customer-safe projection dependency and guards the route", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, PortalModule)).toContain(
      SubscriptionClosureModule
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, PortalBillingController)).toContain(
      CustomerAuthGuard
    );
    expect(
      Reflect.getMetadata(PATH_METADATA, PortalBillingController.prototype.getSubscriptionClosure)
    ).toBe("orders/:id/subscription-closure");
  });

  it("derives customer ownership from the authenticated portal identity", async () => {
    const projection = {
      getCustomerByOrder: vi.fn(async () => ({ status: "PENDING_SETTLEMENT" }))
    };
    const controller = new PortalBillingController({} as never, projection as never);

    await expect(
      controller.getSubscriptionClosure("order-1", {
        accountStatus: "ACTIVE",
        customerAccountId: "account-1",
        customerId: "customer-1",
        phone: "13800000000"
      } as never)
    ).resolves.toEqual({ status: "PENDING_SETTLEMENT" });
    expect(projection.getCustomerByOrder).toHaveBeenCalledWith("order-1", "customer-1");
  });
});
