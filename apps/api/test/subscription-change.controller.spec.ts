import { PermissionCode } from "@subscription-saas/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { REQUIRED_PERMISSIONS_KEY } from "../src/auth/auth.decorators";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";
import {
  CreateSubscriptionChangeDto,
  CreateSubscriptionExtensionDto,
  CreateSubscriptionExtensionQuoteDto
} from "../src/subscription-change/subscription-change.dto";
import { describe, expect, it, vi } from "vitest";

describe("SubscriptionChangeController", () => {
  it.each([
    ["EXTENSION", { extensionMonths: 6, pricingMode: "CURRENT_VERSION" }],
    [
      "VEHICLE_SWAP",
      {
        plannedSwapAt: "2026-09-15T02:00:00.000Z",
        targetSubscriptionPlanId: "4eb90e2b-8fd5-44e4-9f06-04f60dff6df0",
        targetVehicleId: "e84fbcb0-8cb8-4913-99f7-bc00c545bb5e"
      }
    ],
    ["EARLY_TERMINATION", { effectiveDate: "2026-09-30", reason: "Customer relocation" }],
    [
      "MANAGED_OTHER",
      {
        beforeSnapshot: { preferredChannel: "SMS" },
        effectiveDate: "2026-09-30",
        evidence: [{ fileId: "76fe601a-1d4c-45de-b6ba-4a4d1ba518d8" }],
        operation: "UPDATE_CONTACT_PREFERENCE",
        operationPayload: { preferredChannel: "WECHAT" },
        reason: "Customer requests a governed contact-channel change"
      }
    ]
  ] as const)(
    "creates a %s change through the unified controller boundary",
    async (changeType, detail) => {
      const service = {
        create: vi.fn(async () => ({ changeType, id: `change-${changeType}`, status: "DRAFT" }))
      };
      const controller = new SubscriptionChangeController(service as never);
      const create = Reflect.get(controller, "create") as
        | ((
            dto: { changeType: string; detail: unknown; orderId: string },
            idempotencyKey: string,
            request: unknown
          ) => Promise<unknown>)
        | undefined;

      expect(create, "POST /subscription-changes must expose a unified create handler").toBeTypeOf(
        "function"
      );
      if (!create) return;

      const result = await create.call(
        controller,
        {
          changeType,
          detail,
          orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a"
        },
        `idem-${changeType}`,
        {
          headers: { "user-agent": "vitest" },
          ip: "127.0.0.1",
          user: user()
        }
      );

      expect(result).toEqual({ changeType, id: `change-${changeType}`, status: "DRAFT" });
    }
  );

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

    await controller.generateExtensionContract(
      "change-1",
      { version: 3 },
      "contract-command-1",
      request
    );

    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        SubscriptionChangeController.prototype.generateExtensionContract
      )
    ).toEqual([PermissionCode.CONTRACT_GENERATE]);
    expect(contractService.generate).toHaveBeenCalledWith(
      "change-1",
      { idempotencyKey: "contract-command-1", version: 3 },
      user(),
      { ipAddress: "127.0.0.1", userAgent: "vitest" }
    );
  });

  it("routes early-termination agreement generation through the Closure-backed adapter", async () => {
    const earlyTermination = {
      generate: vi.fn(async () => ({ id: "contract-early", status: "ARCHIVED" }))
    };
    const changeService = {
      getWorkflowChangeType: vi.fn(async () => "EARLY_TERMINATION")
    };
    const controller = new SubscriptionChangeController(
      {} as never,
      undefined,
      undefined,
      changeService as never,
      undefined,
      earlyTermination as never
    );
    const request = {
      headers: { "user-agent": "vitest" },
      ip: "127.0.0.1",
      user: user()
    } as never;

    await expect(
      controller.generateExtensionContract(
        "change-early",
        { version: 4 },
        "early-agreement-1",
        request
      )
    ).resolves.toEqual({ id: "contract-early", status: "ARCHIVED" });
    expect(earlyTermination.generate).toHaveBeenCalledWith(
      "change-early",
      { idempotencyKey: "early-agreement-1", version: 4 },
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

    expect(JSON.stringify(result)).toBe('{"monthlyFeeAmount":"97000","nested":{"amount":"125"}}');
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

  it.each([
    ["EXTENSION", { extensionMonths: 6, pricingMode: "CURRENT_VERSION" }],
    [
      "VEHICLE_SWAP",
      {
        plannedSwapAt: "2026-09-15T02:00:00.000Z",
        targetSubscriptionPlanId: "4eb90e2b-8fd5-44e4-9f06-04f60dff6df0",
        targetVehicleId: "e84fbcb0-8cb8-4913-99f7-bc00c545bb5e"
      }
    ],
    ["EARLY_TERMINATION", { effectiveDate: "2026-09-30", reason: "relocation" }],
    [
      "MANAGED_OTHER",
      {
        beforeSnapshot: { preferredChannel: "SMS" },
        effectiveDate: "2026-09-30",
        evidence: [{ fileId: "76fe601a-1d4c-45de-b6ba-4a4d1ba518d8" }],
        operation: "UPDATE_CONTACT_PREFERENCE",
        operationPayload: { preferredChannel: "WECHAT" },
        reason: "governed update"
      }
    ]
  ])("validates the %s discriminated detail shape", async (changeType, detail) => {
    const dto = plainToInstance(CreateSubscriptionChangeDto, {
      changeType,
      detail,
      orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a"
    });
    const mismatched = plainToInstance(CreateSubscriptionChangeDto, {
      changeType,
      detail: { effectiveDate: "not-a-date" },
      orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a"
    });

    expect(await validate(dto)).toEqual([]);
    expect(await validate(mismatched)).not.toHaveLength(0);
  });

  it("requires a typed detail payload", async () => {
    const dto = plainToInstance(CreateSubscriptionChangeDto, {
      changeType: "EARLY_TERMINATION",
      orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a"
    });

    expect((await validate(dto)).map((error) => error.property)).toContain("detail");
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
