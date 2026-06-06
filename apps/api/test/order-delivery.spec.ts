import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  DeliveryStatus,
  DepositStatus,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  SalePriceStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { OrderService } from "../src/order/order.service";

describe("vehicle delivery handover workflow", () => {
  it("rejects prepare and confirm when the contract is not signed", async () => {
    const harness = createDeliveryHarness();
    harness.state.contractStatus = ContractStatus.GENERATED;
    harness.state.delivery = buildReadyDelivery(harness);

    await expect(
      harness.service.prepareDelivery(harness.orderId, validPrepareDto(), harness.user, harness.context)
    ).rejects.toThrow("合同尚未签署");

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("合同尚未签署");
  });

  it("rejects confirm when the vehicle is not reserved", async () => {
    const harness = createDeliveryHarness();
    harness.state.vehicleStatus = VehicleStatus.AVAILABLE;
    harness.state.delivery = buildReadyDelivery(harness);

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("交付前车辆必须处于“签约锁定（RESERVED）”状态。");
  });

  it("rejects confirm when deposit or first monthly fee is not confirmed", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { depositReceivedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("押金尚未确认收取");

    harness.state.delivery = buildReadyDelivery(harness, { firstMonthlyFeeReceivedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("首期月费尚未确认收取");
  });

  it("rejects confirm when insurance is not confirmed or expired", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { insuranceValidConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("保险有效性尚未确认");

    harness.state.delivery = buildReadyDelivery(harness);
    harness.state.insuranceEndDate = new Date("2026-06-09T00:00:00.000Z");

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("车辆保险未生效或已过期，不能交付。");
  });

  it("rejects confirm when the vehicle is not prepared", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness, { vehiclePreparedConfirmed: false });

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("车辆尚未整备");
  });

  it("prepare-delivery creates a READY delivery record", async () => {
    const harness = createDeliveryHarness();

    const delivery = (await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "静安旺旺大厦" }),
      harness.user,
      harness.context
    )) as { deliveryLocation: string; deliveryStatus: DeliveryStatus };

    expect(delivery.deliveryStatus).toBe(DeliveryStatus.READY);
    expect(delivery.deliveryLocation).toBe("静安旺旺大厦");
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_DELIVERY);
    expect(harness.tx.vehicleDelivery.create).toHaveBeenCalledTimes(1);
  });

  it("prepare-delivery updates the existing delivery record instead of creating another one", async () => {
    const harness = createDeliveryHarness();

    await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "静安旺旺大厦" }),
      harness.user,
      harness.context
    );
    await harness.service.prepareDelivery(
      harness.orderId,
      validPrepareDto({ deliveryLocation: "徐汇交付中心", remark: "改约" }),
      harness.user,
      harness.context
    );

    expect(harness.tx.vehicleDelivery.create).toHaveBeenCalledTimes(1);
    expect(harness.tx.vehicleDelivery.update).toHaveBeenCalledTimes(1);
    expect(harness.state.delivery?.deliveryLocation).toBe("徐汇交付中心");
    expect(harness.state.delivery?.remark).toBe("改约");
  });

  it("confirm-delivery completes delivery, activates the order, leases the vehicle, and writes audit logs", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    const delivery = (await harness.service.confirmDelivery(
      harness.orderId,
      validConfirmDto(),
      harness.user,
      harness.context
    )) as {
      deliveredAt: string;
      deliveryStatus: DeliveryStatus;
      handoverMileageKm: number;
    };

    expect(delivery.deliveryStatus).toBe(DeliveryStatus.DELIVERED);
    expect(delivery.handoverMileageKm).toBe(28500);
    expect(delivery.deliveredAt).toBe("2026-06-10T03:00:00.000Z");
    expect(harness.state.orderStatus).toBe(OrderStatus.ACTIVE);
    expect(harness.state.actualDeliveryAt?.toISOString()).toBe("2026-06-10T03:00:00.000Z");
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.LEASED);

    const auditEntityTypes = harness.auditService.write.mock.calls.map(([entry]) => entry.entityType);
    expect(auditEntityTypes).toEqual(expect.arrayContaining(["subscription_order", "vehicle_delivery", "vehicle"]));
  });

  it("rejects repeated confirm-delivery", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    await harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context);

    await expect(
      harness.service.confirmDelivery(harness.orderId, validConfirmDto(), harness.user, harness.context)
    ).rejects.toThrow("该订单已完成交付，不能重复确认。");
  });

  it("delivery-check treats delivered orders as completed instead of pre-delivery blocked", async () => {
    const harness = createDeliveryHarness();
    harness.state.actualDeliveryAt = new Date("2026-06-10T03:00:00.000Z");
    harness.state.orderStatus = OrderStatus.ACTIVE;
    harness.state.vehicleStatus = VehicleStatus.LEASED;
    harness.state.delivery = buildReadyDelivery(harness, {
      deliveredAt: new Date("2026-06-10T03:00:00.000Z"),
      deliveryStatus: DeliveryStatus.DELIVERED,
      handoverMileageKm: 28500
    });

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      alreadyDelivered: boolean;
      blockingReasons: string[];
      canConfirmDelivery: boolean;
      canPrepareDelivery: boolean;
      deliveryStatus: DeliveryStatus;
      vehicleStatus: VehicleStatus;
    };

    expect(check.alreadyDelivered).toBe(true);
    expect(check.deliveryStatus).toBe(DeliveryStatus.DELIVERED);
    expect(check.vehicleStatus).toBe(VehicleStatus.LEASED);
    expect(check.canPrepareDelivery).toBe(false);
    expect(check.canConfirmDelivery).toBe(false);
    expect(check.blockingReasons).toEqual([]);
  });

  it("delivery-check still returns normal blockers when delivery has not been prepared", async () => {
    const harness = createDeliveryHarness();

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      alreadyDelivered: boolean;
      blockingReasons: string[];
      canConfirmDelivery: boolean;
      canPrepareDelivery: boolean;
      deliveryStatus: DeliveryStatus | null;
    };

    expect(check.alreadyDelivered).toBe(false);
    expect(check.deliveryStatus).toBeNull();
    expect(check.canPrepareDelivery).toBe(true);
    expect(check.canConfirmDelivery).toBe(false);
    expect(check.blockingReasons).toEqual(expect.arrayContaining(["请先准备交付", "押金尚未确认收取"]));
  });

  it("delivery-check keeps READY orders confirmable", async () => {
    const harness = createDeliveryHarness();
    harness.state.delivery = buildReadyDelivery(harness);

    const check = (await harness.service.getDeliveryCheck(harness.orderId, harness.user)) as {
      alreadyDelivered: boolean;
      blockingReasons: string[];
      canConfirmDelivery: boolean;
      deliveryStatus: DeliveryStatus;
    };

    expect(check.alreadyDelivered).toBe(false);
    expect(check.deliveryStatus).toBe(DeliveryStatus.READY);
    expect(check.canConfirmDelivery).toBe(true);
    expect(check.blockingReasons).toEqual([]);
  });
});

function validPrepareDto(overrides: Record<string, unknown> = {}) {
  return {
    customerIdentityConfirmed: true,
    deliveryLocation: "静安旺旺大厦",
    depositReceivedConfirmed: true,
    firstMonthlyFeeReceivedConfirmed: true,
    handoverDocumentsConfirmed: true,
    insuranceValidConfirmed: true,
    remark: "线下交付预约",
    scheduledAt: "2026-06-10T10:00:00+08:00",
    vehiclePhotosConfirmed: true,
    vehiclePreparedConfirmed: true,
    ...overrides
  };
}

function validConfirmDto() {
  return {
    deliveredAt: "2026-06-10T11:00:00+08:00",
    handoverMileageKm: 28500,
    remark: "客户已签收"
  };
}

function createDeliveryHarness() {
  const now = new Date("2026-06-06T08:00:00.000Z");
  const orderId = "order-1";
  const vehicleId = "vehicle-1";
  const customerId = "customer-1";
  const user = {
    id: "user-1",
    menus: [],
    name: "Admin",
    permissions: [],
    roles: ["ADMIN"],
    username: "admin"
  };
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const state: {
    actualDeliveryAt: Date | null;
    contractStatus: ContractStatus;
    delivery: Record<string, unknown> | null;
    depositStatus: DepositStatus;
    insuranceEndDate: Date | null;
    insuranceStartDate: Date | null;
    orderStatus: OrderStatus;
    vehicleStatus: VehicleStatus;
  } = {
    actualDeliveryAt: null,
    contractStatus: ContractStatus.SIGNED,
    delivery: null,
    depositStatus: DepositStatus.CONFIRMED,
    insuranceEndDate: new Date("2026-06-30T00:00:00.000Z"),
    insuranceStartDate: new Date("2026-06-01T00:00:00.000Z"),
    orderStatus: OrderStatus.PENDING_PAYMENT,
    vehicleStatus: VehicleStatus.RESERVED
  };

  function buildVehicle() {
    return {
      brand: "NIO",
      createdAt: now,
      currentSalePriceAmount: 10000000n,
      deletedAt: null,
      id: vehicleId,
      insuranceEndDate: state.insuranceEndDate,
      insuranceStartDate: state.insuranceStartDate,
      model: "ET5",
      purchasePriceAmount: 12000000n,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleNo: "VEH2026060600001",
      vin: "VIN202606060000001"
    };
  }

  function buildContract() {
    return {
      archivedAt: null,
      businessType: BusinessType.SUBSCRIPTION,
      contractNo: "CON2026060600001",
      contractSnapshot: {},
      contractTitle: "订阅合同",
      contractVersionId: "contract-version-1",
      createdAt: now,
      customerId,
      deletedAt: null,
      fileId: null,
      id: "contract-1",
      orderId,
      signedAt: state.contractStatus === ContractStatus.SIGNED ? new Date("2026-06-09T02:00:00.000Z") : null,
      status: state.contractStatus,
      updatedAt: now
    };
  }

  function buildOrder() {
    const contract = buildContract();
    return {
      actualDeliveryAt: state.actualDeliveryAt,
      application: {
        applicationNo: "APP202606060001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract,
      contractId: contract.id,
      contracts: [contract],
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: customerId, mobile: "13800000000", name: "测试客户" },
      customerId,
      deletedAt: null,
      depositAmount: 500000n,
      depositStatus: state.depositStatus,
      endDate: null,
      energyLimitCount: null,
      energyLimitKwh: null,
      finalDepositAmount: 500000n,
      id: orderId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD2026060600001",
      orderSource: "SALES_ASSISTED",
      orderStatus: state.orderStatus,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quote: { id: "quote-1", quoteNo: "QUO2026060600001", status: QuoteStatus.CONFIRMED },
      quoteId: "quote-1",
      quoteSnapshot: {},
      riskResult: null,
      riskResultId: null,
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n
    };
  }

  function buildDelivery() {
    return state.delivery ? { ...state.delivery, customer: { id: customerId, mobile: "13800000000", name: "测试客户" }, vehicle: buildVehicle() } : null;
  }

  const tx = {
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      update: vi.fn(async ({ data }) => {
        applyDefined(state, {
          actualDeliveryAt: data.actualDeliveryAt,
          orderStatus: data.orderStatus
        });
        return buildOrder();
      })
    },
    vehicle: {
      findUnique: vi.fn(async () => buildVehicle()),
      update: vi.fn(async ({ data }) => {
        applyDefined(state, { vehicleStatus: data.status });
        return buildVehicle();
      })
    },
    vehicleDelivery: {
      create: vi.fn(async ({ data }) => {
        state.delivery = {
          ...data,
          createdAt: now,
          deletedAt: null,
          deliveredAt: null,
          handoverMileageKm: null,
          id: "delivery-1",
          updatedAt: now
        };
        return buildDelivery();
      }),
      findUnique: vi.fn(async () => buildDelivery()),
      update: vi.fn(async ({ data }) => {
        if (!state.delivery) {
          throw new Error("Delivery not found");
        }
        applyDefined(state.delivery, data);
        state.delivery.updatedAt = now;
        return buildDelivery();
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    },
    vehicleDelivery: {
      findUnique: vi.fn(async () => buildDelivery())
    }
  };
  const auditService = {
    write: vi.fn(async (entry: Record<string, unknown>) => {
      void entry;
    })
  };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, context, customerId, orderId, prisma, service, state, tx, user, vehicleId };
}

function buildReadyDelivery(
  harness: ReturnType<typeof createDeliveryHarness>,
  overrides: Record<string, unknown> = {}
) {
  const now = new Date("2026-06-06T08:00:00.000Z");
  return {
    checklistSnapshot: {},
    contractSignedConfirmed: true,
    createdAt: now,
    createdBy: harness.user.id,
    customerId: harness.customerId,
    deletedAt: null,
    deliveredAt: null,
    deliveryLocation: "静安旺旺大厦",
    deliveryNo: "DLV2026060600001",
    deliveryStatus: DeliveryStatus.READY,
    depositReceivedConfirmed: true,
    firstMonthlyFeeReceivedConfirmed: true,
    handoverDocumentsConfirmed: true,
    handoverMileageKm: null,
    id: "delivery-1",
    insuranceValidConfirmed: true,
    orderId: harness.orderId,
    remark: "线下交付预约",
    scheduledAt: new Date("2026-06-10T02:00:00.000Z"),
    updatedAt: now,
    updatedBy: harness.user.id,
    vehicleId: harness.vehicleId,
    vehiclePhotosConfirmed: true,
    vehiclePreparedConfirmed: true,
    customerIdentityConfirmed: true,
    ...overrides
  };
}

function applyDefined(target: object, data: Record<string, unknown>) {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
}
