import { PermissionCode } from "@subscription-saas/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";
import {
  CreateSubscriptionExtensionDto,
  CreateSubscriptionExtensionQuoteDto
} from "../src/subscription-change/subscription-change.dto";
import { describe, expect, it, vi } from "vitest";

describe("SubscriptionChangeController", () => {
  it("forwards Idempotency-Key, actor and request context when creating an extension", async () => {
    const service = { createExtension: vi.fn(async () => ({ id: "change-1" })) };
    const controller = new SubscriptionChangeController(service as never);
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      user: user()
    } as never;

    await controller.createExtension(
      { extensionMonths: 6, orderId: "order-1", pricingMode: "CURRENT_VERSION" } as never,
      "idem-create-1",
      request
    );

    expect(service.createExtension).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "idem-create-1", orderId: "order-1" }),
      user(),
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );
  });

  it("protects price override approval with the dedicated permission", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SubscriptionChangeController.prototype.approvePriceOverride
      )
    ).toEqual([PermissionCode.SUBSCRIPTION_CHANGE_PRICE_OVERRIDE_APPROVE]);
  });

  it("protects extension agreement generation and forwards request context", async () => {
    const service = {};
    const contractService = { generate: vi.fn(async () => ({ id: "contract-extension" })) };
    const controller = new SubscriptionChangeController(service as never, contractService as never);
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      user: user()
    } as never;

    await controller.generateExtensionContract("change-1", request);

    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SubscriptionChangeController.prototype.generateExtensionContract
      )
    ).toEqual([PermissionCode.CONTRACT_GENERATE]);
    expect(contractService.generate).toHaveBeenCalledWith(
      "change-1",
      user(),
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );
  });

  it("serializes BigInt amounts in HTTP responses as digit strings", async () => {
    const service = {
      get: vi.fn(async () => ({ monthlyFeeAmount: 97_000n, nested: { amount: 125n } }))
    };
    const controller = new SubscriptionChangeController(service as never);

    const result = await controller.get("change-1", { user: user() } as never);

    expect(JSON.stringify(result)).toBe(
      '{"monthlyFeeAmount":"97000","nested":{"amount":"125"}}'
    );
  });

  it("accepts only digit-string money values and non-negative versions", async () => {
    const invalidMoney = plainToInstance(CreateSubscriptionExtensionDto, {
      discountedMonthlyFeeAmount: "1.5",
      extensionMonths: 6,
      orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a",
      pricingMode: "APPROVED_DISCOUNT"
    });
    const invalidVersion = plainToInstance(CreateSubscriptionExtensionQuoteDto, {
      version: -1
    });

    expect(await validate(invalidMoney)).not.toHaveLength(0);
    expect(await validate(invalidVersion)).not.toHaveLength(0);
  });
});

function user() {
  return {
    id: "op-1",
    menus: [],
    name: "Operator",
    permissions: [PermissionCode.SUBSCRIPTION_CHANGE_CREATE],
    roles: ["OP"],
    username: "op"
  };
}
