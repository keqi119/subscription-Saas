import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  ContractVersionStatus,
  OrderChangeType,
  OrderStatus,
  ProductStatus,
  QuoteStatus,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAllowedChangeType,
  ensureSubscriptionBusinessType,
  OrderService
} from "../src/order/order.service";

describe("subscription order and contract rules", () => {
  it("defaults order business type to subscription", () => {
    expect(ensureSubscriptionBusinessType()).toBe(BusinessType.SUBSCRIPTION);
    expect(ensureSubscriptionBusinessType(BusinessType.SUBSCRIPTION)).toBe(BusinessType.SUBSCRIPTION);
  });

  it("rejects rent-to-own order creation during the current phase", () => {
    expect(() => ensureSubscriptionBusinessType(BusinessType.RENT_TO_OWN)).toThrow("当前阶段暂未开放以租代购订单");
  });

  it("allows current-stage subscription order change types", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.PLAN_CHANGE)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.VEHICLE_SWAP)).not.toThrow();
    expect(() => ensureAllowedChangeType(OrderChangeType.TERMINATION)).not.toThrow();
  });

  it("rejects rent-to-own only order change types during the current phase", () => {
    expect(() => ensureAllowedChangeType(OrderChangeType.BUYOUT)).toThrow("当前阶段暂未开放以租代购订单变更");
    expect(() => ensureAllowedChangeType(OrderChangeType.EARLY_SETTLEMENT)).toThrow("当前阶段暂未开放以租代购订单变更");
    expect(() => ensureAllowedChangeType(OrderChangeType.OWNERSHIP_TRANSFER)).toThrow("当前阶段暂未开放以租代购订单变更");
  });

  it("cancels the generated contract and rolls the order back for regeneration", async () => {
    const harness = createOrderServiceHarness();

    const firstContract = (await harness.service.generateContract(harness.orderId, harness.user, harness.context)) as Record<
      string,
      unknown
    >;

    expect(harness.state.contractId).toBe(firstContract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);

    const cancelled = (await harness.service.cancelContract(firstContract.id as string, harness.user, harness.context)) as {
      order: { contractId: string | null; orderStatus: OrderStatus };
      status: ContractStatus;
    };

    expect(cancelled.status).toBe(ContractStatus.CANCELLED);
    expect(cancelled.order.contractId).toBeNull();
    expect(cancelled.order.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_CONTRACT);

    const secondContract = (await harness.service.generateContract(harness.orderId, harness.user, harness.context)) as Record<
      string,
      unknown
    >;

    expect(secondContract.id).not.toBe(firstContract.id);
    expect(harness.state.contractId).toBe(secondContract.id);
    expect(harness.state.orderStatus).toBe(OrderStatus.PENDING_SIGN);
  });

  it("rejects cancelling an archived contract", async () => {
    const harness = createOrderServiceHarness();
    const contract = (await harness.service.generateContract(harness.orderId, harness.user, harness.context)) as Record<
      string,
      unknown
    >;

    harness.state.contracts[0]!.status = ContractStatus.ARCHIVED;

    await expect(harness.service.cancelContract(contract.id as string, harness.user, harness.context)).rejects.toThrow(
      "已归档合同不能取消"
    );
  });

  it("creates an order from a confirmed quote only after the vehicle is reserved", async () => {
    const harness = createOrderServiceHarness();
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    const order = (await harness.service.createOrderFromQuote(
      harness.quoteId,
      { businessType: BusinessType.SUBSCRIPTION },
      harness.user,
      harness.context
    )) as { quoteSnapshot: { vehicleSnapshot?: { vehicleNo?: string } }; vehicleId: string | null };

    expect(order.vehicleId).toBe(harness.vehicleId);
    expect(order.quoteSnapshot.vehicleSnapshot?.vehicleNo).toBe("VEH2026060200001");
  });

  it("rejects creating an order when the quote vehicle is not locked", async () => {
    const harness = createOrderServiceHarness();
    harness.state.vehicleStatus = VehicleStatus.AVAILABLE;

    await expect(
      harness.service.createOrderFromQuote(
        harness.quoteId,
        { businessType: BusinessType.SUBSCRIPTION },
        harness.user,
        harness.context
      )
    ).rejects.toThrow("已确认报价绑定车辆未锁定");
  });

  it("releases the reserved vehicle when cancelling a pre-delivery order", async () => {
    const harness = createOrderServiceHarness();
    harness.state.orderStatus = OrderStatus.PENDING_CONTRACT;
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await harness.service.cancelOrder(harness.orderId, { reason: "customer withdrew" }, harness.user, harness.context);

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: { status: VehicleStatus.AVAILABLE, updatedBy: harness.user.id },
      where: { id: harness.vehicleId }
    });
  });

  it("does not release a vehicle when cancelling is rejected for an active order", async () => {
    const harness = createOrderServiceHarness();
    harness.state.orderStatus = OrderStatus.ACTIVE;
    harness.state.vehicleStatus = VehicleStatus.RESERVED;

    await expect(
      harness.service.cancelOrder(
        harness.orderId,
        { reason: "cannot cancel active order" },
        harness.user,
        harness.context
      )
    ).rejects.toThrow();

    expect(harness.state.vehicleStatus).toBe(VehicleStatus.RESERVED);
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });
});

function createOrderServiceHarness() {
  const now = new Date("2026-06-02T08:00:00.000Z");
  const orderId = "order-1";
  const quoteId = "quote-1";
  const vehicleId = "vehicle-1";
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
    contractId: string | null;
    contracts: Array<Record<string, unknown> & { id: string; status: ContractStatus }>;
    orderStatus: OrderStatus;
    quoteSnapshot: Record<string, unknown> | null;
    vehicleStatus: VehicleStatus;
  } = {
    contractId: null,
    contracts: [],
    orderStatus: OrderStatus.PENDING_CONTRACT,
    quoteSnapshot: null,
    vehicleStatus: VehicleStatus.RESERVED
  };
  const template = {
    approvedAt: now,
    approvedBy: user.id,
    businessType: BusinessType.SUBSCRIPTION,
    contentTemplate: "合同模板",
    createdAt: now,
    createdBy: user.id,
    deletedAt: null,
    effectiveFrom: now,
    effectiveTo: null,
    fileId: null,
    id: "contract-version-1",
    status: ContractVersionStatus.ACTIVE,
    templateName: "订阅合同",
    templateType: "SUBSCRIPTION_STANDARD",
    updatedAt: now,
    updatedBy: user.id,
    versionNo: "V1.0"
  };

  function buildVehicle() {
    return {
      brand: "NIO",
      createdAt: now,
      currentSalePriceAmount: 10000000n,
      deletedAt: null,
      id: vehicleId,
      licensePlateNo: "沪A00001",
      model: "ET5",
      purchasePriceAmount: 12000000n,
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleNo: "VEH2026060200001",
      vin: "VIN202606020000001"
    };
  }

  function buildQuote() {
    return {
      application: {
        applicationNo: "APP202606020001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      cancelledAt: null,
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: "customer-1", mobile: "13800000000", name: "测试客户" },
      customerId: "customer-1",
      deletedAt: null,
      depositAmount: 500000n,
      energyLimitCount: null,
      energyLimitKwh: null,
      expiredAt: null,
      id: quoteId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      order: null,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quoteNo: "QUO202606020800000001",
      riskResult: { id: "risk-result-1" },
      riskResultId: "risk-result-1",
      status: QuoteStatus.CONFIRMED,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n,
      vehicleSnapshot: { vehicleNo: "VEH2026060200001", vin: "VIN202606020000001" }
    };
  }

  function buildOrder() {
    const currentContract = state.contracts.find((contract) => contract.id === state.contractId) ?? null;
    return {
      actualDeliveryAt: null,
      application: {
        applicationNo: "APP202606020001",
        id: "application-1",
        salesUserId: user.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: [],
      contract: currentContract,
      contractId: state.contractId,
      contracts: state.contracts,
      createdAt: now,
      createdBy: user.id,
      customer: { grade: "A", id: "customer-1", mobile: "13800000000", name: "测试客户" },
      customerId: "customer-1",
      deletedAt: null,
      depositAmount: 500000n,
      endDate: null,
      energyLimitCount: null,
      energyLimitKwh: null,
      id: orderId,
      mileageLimitKm: 1500,
      monthlyFeeAmount: 300000n,
      orderNo: "ORD202606020800000001",
      orderStatus: state.orderStatus,
      overMileageFeeAmount: 100n,
      periodMonths: 12,
      productId: "product-1",
      productVersion: {
        product: { productType: BusinessType.SUBSCRIPTION, status: ProductStatus.ACTIVE }
      },
      productVersionId: "product-version-1",
      quote: { id: quoteId, quoteNo: "QUO202606020800000001", status: QuoteStatus.CONFIRMED },
      quoteId,
      quoteSnapshot: state.quoteSnapshot ?? {
        vehicleSnapshot: { vehicleNo: "VEH2026060200001", vin: "VIN202606020000001" }
      },
      riskResult: { id: "risk-result-1" },
      riskResultId: "risk-result-1",
      startDate: null,
      updatedAt: now,
      updatedBy: user.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehicleModel: "ET5",
      vehiclePurchasePriceAmount: 10000000n
    };
  }

  function buildContract(contract: Record<string, unknown> & { id: string; status: ContractStatus }) {
    return {
      ...contract,
      contractVersion: template,
      customer: { id: "customer-1", mobile: "13800000000", name: "测试客户" },
      order: buildOrder()
    };
  }

  const tx = {
    contract: {
      count: vi.fn(async () => state.contracts.length),
      create: vi.fn(async ({ data }) => {
        const contract = {
          ...data,
          archivedAt: null,
          createdAt: now,
          deletedAt: null,
          fileId: null,
          id: "contract-" + (state.contracts.length + 1),
          signedAt: null,
          updatedAt: now
        };
        state.contracts.push(contract);
        return contract;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("Contract not found");
        }
        return buildContract(contract);
      }),
      update: vi.fn(async ({ data, where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        if (!contract) {
          throw new Error("Contract not found");
        }
        Object.assign(contract, data);
        return buildContract(contract);
      })
    },
    subscriptionOrder: {
      create: vi.fn(async ({ data }) => {
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        state.quoteSnapshot = data.quoteSnapshot as Record<string, unknown>;
        return buildOrder();
      }),
      update: vi.fn(async ({ data }) => {
        if ("contractId" in data) {
          state.contractId = data.contractId;
        }
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        return buildOrder();
      })
    },
    vehicle: {
      update: vi.fn(async ({ data }) => {
        if (data.status) {
          state.vehicleStatus = data.status;
        }
        return buildVehicle();
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    contract: {
      findUnique: vi.fn(async ({ where }) => {
        const contract = state.contracts.find((item) => item.id === where.id);
        return contract ? buildContract(contract) : null;
      })
    },
    contractVersion: {
      findFirst: vi.fn(async () => template)
    },
    subscriptionQuote: {
      findUnique: vi.fn(async () => buildQuote())
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => {
        if (data.orderStatus) {
          state.orderStatus = data.orderStatus;
        }
        state.quoteSnapshot = data.quoteSnapshot as Record<string, unknown>;
        return buildOrder();
      }),
      findUnique: vi.fn(async () => buildOrder())
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, context, orderId, quoteId, service, state, tx, user, vehicleId };
}
