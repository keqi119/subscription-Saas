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
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        PortalBillingController.prototype.uploadSubscriptionClosureDisputeEvidence
      )
    ).toBe("orders/:id/subscription-closure/dispute-evidence");
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

  it("binds portal dispute evidence to the authenticated customer's closure and charge line", async () => {
    const projection = {
      getCustomerByOrder: vi.fn(async () => ({ closureCaseId: "closure-1" }))
    };
    const governance = { uploadEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })) };
    const controller = new PortalBillingController(
      {} as never,
      projection as never,
      governance as never
    );
    const customer = {
      accountStatus: "ACTIVE",
      customerAccountId: "account-1",
      customerId: "customer-1",
      phone: "13800000000"
    };
    const file = {
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      mimetype: "image/jpeg",
      originalname: "proof.jpg",
      size: 4
    };

    await controller.uploadSubscriptionClosureDisputeEvidence(
      "order-1",
      {
        capturedAt: "2026-08-29T00:00:00.000Z",
        chargeLineId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "portal-dispute-1"
      },
      [file] as never,
      customer as never
    );

    expect(projection.getCustomerByOrder).toHaveBeenCalledWith("order-1", "customer-1");
    expect(governance.uploadEvidence).toHaveBeenCalledWith(
      "closure-1",
      expect.objectContaining({
        targetId: "00000000-0000-4000-8000-000000000001",
        targetType: "CUSTOMER_DISPUTE",
        visibility: "CUSTOMER_VISIBLE"
      }),
      file,
      null,
      "customer-1"
    );
  });
});
