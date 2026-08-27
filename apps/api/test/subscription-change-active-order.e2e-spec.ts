import { OrderChangeType, OrderStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";
import { SubscriptionChangeController } from "../src/subscription-change/subscription-change.controller";

describe("ACTIVE order contract-change entry boundary", () => {
  it.each([
    "EXTENSION",
    "VEHICLE_SWAP",
    "EARLY_TERMINATION",
    "MANAGED_OTHER"
  ] as const)("accepts %s from an ACTIVE order through the unified endpoint", async (changeType) => {
    const service = {
      create: vi.fn(async (input: { changeType: string; orderId: string }) => ({
        changeType: input.changeType,
        orderId: input.orderId,
        sourceOrderStatus: OrderStatus.ACTIVE,
        status: "DRAFT"
      }))
    };
    const controller = new SubscriptionChangeController(service as never);
    const create = Reflect.get(controller, "create") as
      | ((dto: unknown, idempotencyKey: string, request: unknown) => Promise<unknown>)
      | undefined;

    expect(create, "ACTIVE orders need the V2 unified creation endpoint").toBeTypeOf("function");
    if (!create) return;

    await expect(
      create.call(
        controller,
        { changeType, detail: {}, orderId: "2afc7002-7f35-4c7e-93be-2d4c87efa51a" },
        `active-order-${changeType}`,
        {
          headers: { "user-agent": "vitest-e2e" },
          ip: "127.0.0.1",
          user: adminUser()
        }
      )
    ).resolves.toMatchObject({
      changeType,
      sourceOrderStatus: OrderStatus.ACTIVE,
      status: "DRAFT"
    });
  });

  it("keeps the legacy pre-delivery redesign endpoint closed for ACTIVE orders", async () => {
    const legacyBoundary = {
      findOrderOrThrow: vi.fn(async () => ({
        deletedAt: null,
        id: "2afc7002-7f35-4c7e-93be-2d4c87efa51a",
        orderStatus: OrderStatus.ACTIVE
      }))
    };

    await expect(
      OrderService.prototype.createOrderChange.call(
        legacyBoundary as never,
        "2afc7002-7f35-4c7e-93be-2d4c87efa51a",
        { changeType: OrderChangeType.PLAN_CHANGE, reason: "redesign before delivery" },
        adminUser() as never,
        { ipAddress: "127.0.0.1", userAgent: "vitest-e2e" }
      )
    ).rejects.toThrow("当前订单已进入履约阶段，请走履约变更或合同变更流程。");
  });
});

function adminUser() {
  return {
    id: "admin-1",
    menus: [],
    name: "Administrator",
    permissions: ["order_change:create", "subscription_change:create"],
    roles: ["ADMIN"],
    username: "admin"
  };
}
