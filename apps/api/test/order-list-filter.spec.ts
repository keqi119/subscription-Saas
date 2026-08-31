import { OrderStatus, SubscriptionJourneyStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

const adminUser = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "Administrator",
  permissions: [],
  roles: ["ADMIN"],
  username: "administrator"
};

describe("OrderService list filters", () => {
  it("applies the active order status filter together with the journey filter", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({} as never, { subscriptionOrder: { findMany } } as never);

    await service.listOrders(adminUser, {
      journeyStatus: SubscriptionJourneyStatus.EXCEPTION,
      orderStatus: OrderStatus.ACTIVE
    });

    expect(findMany).toHaveBeenCalledWith({
      include: expect.any(Object),
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderStatus: OrderStatus.ACTIVE,
        subscriptionJourney: {
          is: { status: SubscriptionJourneyStatus.EXCEPTION }
        }
      }
    });
  });
});
