import {
  ApplicationStatus,
  BusinessType,
  OrderChangeStatus,
  OrderChangeType,
  OrderSource,
  OrderStatus,
  ProductType,
  QuoteStatus,
  SalePriceStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleAvailabilityPurpose } from "../src/asset-operations/vehicle-availability";
import { OrderService } from "../src/order/order.service";

const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "Operator",
  permissions: ["order_change:execute"],
  roles: ["ADMIN"],
  username: "operator"
};

describe("OrderService operational availability boundaries", () => {
  it.each([
    {
      expectedPurpose: VehicleAvailabilityPurpose.ALLOCATION,
      expectedOverride: VehicleStatus.AVAILABLE,
      invoke: (harness: ReturnType<typeof createHarness>) =>
        harness.service.confirmCustomerOrder(harness.order.id, user, context),
      label: "review-reserved confirmation",
      vehicleStatus: VehicleStatus.REVIEW_RESERVED
    },
    {
      expectedPurpose: VehicleAvailabilityPurpose.MARK_AVAILABLE,
      expectedOverride: VehicleStatus.AVAILABLE,
      invoke: (harness: ReturnType<typeof createHarness>) =>
        harness.service.rejectCustomerOrder(harness.order.id, { comment: "reject" }, user, context),
      label: "review rejection release",
      vehicleStatus: VehicleStatus.REVIEW_RESERVED
    },
    {
      expectedPurpose: VehicleAvailabilityPurpose.MARK_AVAILABLE,
      expectedOverride: VehicleStatus.AVAILABLE,
      invoke: (harness: ReturnType<typeof createHarness>) =>
        harness.service.cancelOrder(harness.order.id, { reason: "cancel" }, user, context),
      label: "order cancellation release",
      vehicleStatus: VehicleStatus.RESERVED
    },
    {
      expectedPurpose: VehicleAvailabilityPurpose.MARK_AVAILABLE,
      expectedOverride: VehicleStatus.AVAILABLE,
      invoke: (harness: ReturnType<typeof createHarness>) =>
        harness.service.returnOrderChangeToPlan(harness.change.id, user, context),
      label: "plan rollback release",
      vehicleStatus: VehicleStatus.RESERVED
    }
  ])(
    "locks and rejects $label before its vehicle status write",
    async ({ expectedOverride, expectedPurpose, invoke, vehicleStatus }) => {
      const harness = createHarness(vehicleStatus);
      harness.assetOperationsService.assertVehicleAvailable.mockImplementationOnce(async () => {
        harness.sequence.push("availability-guard");
        throw new Error("VEHICLE_OPERATIONALLY_RESTRICTED");
      });

      await expect(invoke(harness)).rejects.toThrow("VEHICLE_OPERATIONALLY_RESTRICTED");

      expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
        harness.tx,
        harness.vehicle.id,
        expectedPurpose,
        expect.any(Date),
        expectedOverride
      );
      expect(harness.sequence.slice(0, 2)).toEqual(["vehicle-lock", "availability-guard"]);
      expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
    }
  );

  it("checks DELIVERY after the delivery authority locks and before lease activation writes", async () => {
    const harness = createHarness(VehicleStatus.RESERVED);
    harness.assetOperationsService.assertVehicleAvailable.mockImplementationOnce(async () => {
      harness.sequence.push("availability-guard");
      throw new Error("VEHICLE_OPERATIONALLY_RESTRICTED");
    });

    await expect(
      harness.service.confirmDelivery(
        harness.order.id,
        { deliveredAt: "2026-08-20T08:00:00.000Z", handoverMileageKm: 100 },
        user,
        context
      )
    ).rejects.toThrow("VEHICLE_OPERATIONALLY_RESTRICTED");

    expect(harness.assetOperationsService.assertVehicleAvailable).toHaveBeenCalledWith(
      harness.tx,
      harness.vehicle.id,
      VehicleAvailabilityPurpose.DELIVERY,
      expect.any(Date)
    );
    expect(harness.sequence).toEqual(["delivery-locks", "availability-guard"]);
    expect(harness.leaseActivationEngine.activateFromAuthoritativeHandover).not.toHaveBeenCalled();
  });

  it("lets the unchanged boundary proceed when the authoritative guard allows it", async () => {
    const harness = createHarness(VehicleStatus.REVIEW_RESERVED);
    harness.tx.vehicle.update.mockRejectedValueOnce(new Error("NEXT_STATUS_WRITE"));

    await expect(
      harness.service.confirmCustomerOrder(harness.order.id, user, context)
    ).rejects.toThrow("NEXT_STATUS_WRITE");

    expect(harness.sequence).toEqual(["vehicle-lock", "availability-guard"]);
    expect(harness.tx.vehicle.update).toHaveBeenCalledTimes(1);
  });
});

function createHarness(vehicleStatus: VehicleStatus) {
  const sequence: string[] = [];
  const vehicle = {
    currentSalePriceAmount: 100n,
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000010",
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    status: vehicleStatus
  };
  const order = {
    application: {
      applicationNo: "APP-1",
      id: "00000000-0000-4000-8000-000000000030",
      salesUserId: user.id,
      status: ApplicationStatus.APPROVED
    },
    businessType: BusinessType.SUBSCRIPTION,
    changes: [],
    contract: null,
    contractId: null,
    contracts: [],
    customerId: "00000000-0000-4000-8000-000000000040",
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000050",
    orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
    orderStatus:
      vehicleStatus === VehicleStatus.REVIEW_RESERVED
        ? OrderStatus.PENDING_CUSTOMER_CONFIRMATION
        : OrderStatus.PENDING_CONTRACT,
    productVersion: { product: { productType: ProductType.SUBSCRIPTION } },
    quoteId: "00000000-0000-4000-8000-000000000060",
    vehicle,
    vehicleId: vehicle.id
  };
  const change = {
    afterSnapshot: {},
    changeType: OrderChangeType.PLAN_CHANGE,
    createdBy: user.id,
    deletedAt: null,
    id: "00000000-0000-4000-8000-000000000070",
    order,
    orderId: order.id,
    status: OrderChangeStatus.APPROVED
  };
  const tx = {
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join(" ") ?? "";
      if (!sequence.includes("delivery-locks") && sql.includes("delivery-gate-lock")) {
        sequence.push("delivery-locks");
      } else if (!sequence.includes("vehicle-lock") && !sql.includes("delivery-gate-lock")) {
        sequence.push("vehicle-lock");
      }
      return [{ id: vehicle.id }];
    }),
    contract: { update: vi.fn(async () => null) },
    orderChange: {
      findUnique: vi.fn(async () => change),
      update: vi.fn(async () => change)
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => order),
      update: vi.fn(async () => order)
    },
    subscriptionQuote: {
      update: vi.fn(async () => ({ id: order.quoteId, status: QuoteStatus.CONFIRMED }))
    },
    vehicle: {
      findUnique: vi.fn(async () => vehicle),
      update: vi.fn(async ({ data }: { data: { status: VehicleStatus } }) => ({
        ...vehicle,
        ...data
      }))
    },
    vehicleDelivery: { findUnique: vi.fn(async () => null) }
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    orderChange: { findUnique: vi.fn(async () => change) },
    subscriptionJourney: { findUnique: vi.fn(async () => null) },
    subscriptionOrder: { findUnique: vi.fn(async () => order) }
  };
  const assetOperationsService = {
    assertVehicleAvailable: vi.fn(async () => {
      sequence.push("availability-guard");
    })
  };
  const leaseActivationEngine = {
    activateFromAuthoritativeHandover: vi.fn(async () => {
      sequence.push("lease-write");
    })
  };
  const service = new OrderService(
    { write: vi.fn(async () => undefined) } as never,
    prisma as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    leaseActivationEngine as never,
    assetOperationsService as never
  );
  return {
    assetOperationsService,
    change,
    leaseActivationEngine,
    order,
    prisma,
    sequence,
    service,
    tx,
    vehicle
  };
}
