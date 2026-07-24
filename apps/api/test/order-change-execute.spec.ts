import {
  ApplicationStatus,
  BusinessType,
  ContractStatus,
  OrderChangeStatus,
  OrderChangeType,
  OrderStatus,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleStatus
} from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

import { OrderService } from "../src/order/order.service";

describe("pre-contract order change return-to-plan flow", () => {
  it("creates an order change when there is no active change", async () => {
    const harness = createOrderChangeHarness({ changeStatus: null });

    await expect(
      harness.service.createOrderChange(
        harness.orderId,
        { changeType: OrderChangeType.PLAN_CHANGE, reason: "customer request" },
        harness.saUser,
        harness.context
      )
    ).resolves.toMatchObject({ changeType: OrderChangeType.PLAN_CHANGE });
  });

  it("rejects duplicate creation when a PENDING change exists", async () => {
    const harness = createOrderChangeHarness({ changeStatus: OrderChangeStatus.PENDING });

    await expect(
      harness.service.createOrderChange(
        harness.orderId,
        { changeType: OrderChangeType.PLAN_CHANGE, reason: "customer request" },
        harness.saUser,
        harness.context
      )
    ).rejects.toThrow("该订单已有进行中的变更申请，请先处理后再发起新的变更。");
  });

  it("rejects duplicate creation when an APPROVED unfinished change exists", async () => {
    const harness = createOrderChangeHarness({ changeStatus: OrderChangeStatus.APPROVED });

    await expect(
      harness.service.createOrderChange(
        harness.orderId,
        { changeType: OrderChangeType.PLAN_CHANGE, reason: "customer request" },
        harness.saUser,
        harness.context
      )
    ).rejects.toThrow("该订单已有进行中的变更申请，请先处理后再发起新的变更。");
  });

  it("blocks contract generation while an order change is active", async () => {
    const harness = createOrderChangeHarness({ changeStatus: OrderChangeStatus.PENDING });

    await expect(
      harness.service.generateContract(harness.orderId, harness.opUser, harness.context)
    ).rejects.toThrow("当前订单存在进行中的变更申请，请先完成或取消变更后再继续操作。");
  });

  it("blocks contract signing while an order change is active", async () => {
    const harness = createOrderChangeHarness({
      changeStatus: OrderChangeStatus.PENDING,
      contractStatus: ContractStatus.GENERATED,
      orderStatus: OrderStatus.PENDING_SIGN
    });

    await expect(
      harness.service.signContract(harness.contractId, harness.opUser, harness.context)
    ).rejects.toThrow("当前订单存在进行中的变更申请，请先完成或取消变更后再继续操作。");
  });

  it("allows the creator to cancel a PENDING change", async () => {
    const harness = createOrderChangeHarness({
      changeStatus: OrderChangeStatus.PENDING,
      createdBy: "sa-1"
    });

    await expect(
      harness.service.cancelOrderChange(harness.changeId, harness.saUser, harness.context)
    ).resolves.toMatchObject({ status: OrderChangeStatus.CANCELLED });
    expect(harness.state.change.status).toBe(OrderChangeStatus.CANCELLED);
  });

  it("rejects canceling a PENDING change by a non-creator", async () => {
    const harness = createOrderChangeHarness({
      changeStatus: OrderChangeStatus.PENDING,
      createdBy: "other-user"
    });

    await expect(
      harness.service.cancelOrderChange(harness.changeId, harness.saUser, harness.context)
    ).rejects.toThrow("Permission denied.");
  });

  it("allows an operator to approve a PENDING change and keeps the order locked", async () => {
    const harness = createOrderChangeHarness({ changeStatus: OrderChangeStatus.PENDING });

    await harness.service.setOrderChangeStatus(
      harness.changeId,
      OrderChangeStatus.APPROVED,
      harness.opUser,
      harness.context
    );

    expect(harness.state.change.status).toBe(OrderChangeStatus.APPROVED);
    await expect(
      harness.service.generateContract(harness.orderId, harness.opUser, harness.context)
    ).rejects.toThrow("当前订单存在进行中的变更申请，请先完成或取消变更后再继续操作。");
  });

  it("allows an operator to reject a PENDING change and then generate a contract", async () => {
    const harness = createOrderChangeHarness({ changeStatus: OrderChangeStatus.PENDING });

    await harness.service.setOrderChangeStatus(
      harness.changeId,
      OrderChangeStatus.REJECTED,
      harness.opUser,
      harness.context
    );
    await expect(
      harness.service.generateContract(harness.orderId, harness.opUser, harness.context)
    ).resolves.toMatchObject({ status: ContractStatus.GENERATED });
  });

  it("cancels a PENDING_CONTRACT order and releases the reserved vehicle", async () => {
    const harness = createOrderChangeHarness({ orderStatus: OrderStatus.PENDING_CONTRACT });

    const change = await harness.service.returnOrderChangeToPlan(
      harness.changeId,
      harness.opUser,
      harness.context
    ) as Record<string, unknown>;

    expect(change.status).toBe(OrderChangeStatus.EXECUTED);
    expect(change.executedAt).toBeTruthy();
    expect(harness.state.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.monthlyFeeAmount).toBe(300000n);
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.tx.subscriptionQuote.update).not.toHaveBeenCalled();
    expect(harness.tx.subscriptionPlan.findUnique).not.toHaveBeenCalled();
  });

  it("cancels a PENDING_SIGN order and voids its unsigned contract", async () => {
    const harness = createOrderChangeHarness({
      contractStatus: ContractStatus.GENERATED,
      orderStatus: OrderStatus.PENDING_SIGN
    });

    await harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context);

    expect(harness.state.contractStatus).toBe(ContractStatus.CANCELLED);
    expect(harness.state.contractId).toBeNull();
    expect(harness.state.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(harness.tx.contract.update).toHaveBeenCalledWith({
      data: { status: ContractStatus.CANCELLED, updatedBy: harness.opUser.id },
      where: { id: harness.contractId }
    });
  });

  it.each([OrderStatus.ACTIVE, OrderStatus.SUSPENDED])(
    "rejects return-to-plan for fulfillment order status %s",
    async (orderStatus) => {
      const harness = createOrderChangeHarness({ orderStatus });

      await expect(
        harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context)
      ).rejects.toThrow("当前订单已进入履约阶段，请走履约变更或合同变更流程。");
    }
  );

  it.each([OrderStatus.CANCELLED, OrderStatus.COMPLETED, OrderStatus.TERMINATED])(
    "rejects return-to-plan for final order status %s",
    async (orderStatus) => {
      const harness = createOrderChangeHarness({ orderStatus });

      await expect(
        harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context)
      ).rejects.toThrow("当前订单已结束，不允许退回重做方案。");
    }
  );

  it("uses order.vehicleId and releases REVIEW_RESERVED vehicles for A-line orders", async () => {
    const harness = createOrderChangeHarness({
      afterSnapshot: { subscriptionPlanId: "plan-new", vehicleBaseFeeAmount: 400000, vehicleId: "other-vehicle" },
      orderSource: "CUSTOMER_SELF_SERVICE",
      orderStatus: OrderStatus.PENDING_REVIEW,
      vehicleStatus: VehicleStatus.REVIEW_RESERVED
    });

    await harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context);

    expect(harness.tx.vehicle.findUnique).toHaveBeenCalledWith({ where: { id: harness.vehicleId } });
    expect(harness.state.vehicleStatus).toBe(VehicleStatus.AVAILABLE);
    expect(harness.state.change.afterSnapshot).toMatchObject({
      action: "RETURN_TO_PLAN",
      nextStep: "客户需重新提交订单申请。",
      orderStatus: OrderStatus.CANCELLED,
      vehicleReleased: true
    });
  });

  it("records B-line next step to return to the application detail", async () => {
    const harness = createOrderChangeHarness({ orderSource: "SALES_ASSISTED" });

    await harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context);

    expect(harness.state.change.afterSnapshot).toMatchObject({
      action: "RETURN_TO_PLAN",
      nextStep: "返回进件详情重新生成订阅报价和订阅订单。",
      orderStatus: OrderStatus.CANCELLED
    });
  });

  it.each([ContractStatus.SIGNED, ContractStatus.ARCHIVED])(
    "rejects return-to-plan when the current contract is %s",
    async (contractStatus) => {
      const harness = createOrderChangeHarness({
        contractStatus,
        orderStatus: OrderStatus.PENDING_PAYMENT
      });

      await expect(
        harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context)
      ).rejects.toThrow("当前订单已进入履约阶段，请走履约变更或合同变更流程。");
    }
  );

  it("writes beforeSnapshot, afterSnapshot, executedAt, and audit logs", async () => {
    const harness = createOrderChangeHarness();

    await harness.service.returnOrderChangeToPlan(harness.changeId, harness.opUser, harness.context);

    expect(harness.state.change.beforeSnapshot).toMatchObject({
      order: expect.objectContaining({ id: harness.orderId })
    });
    expect(harness.state.change.afterSnapshot).toMatchObject({
      action: "RETURN_TO_PLAN",
      order: expect.objectContaining({ id: harness.orderId }),
      orderStatus: OrderStatus.CANCELLED,
      vehicleReleased: true
    });
    expect(harness.state.change.executedAt).toBeInstanceOf(Date);
    expect(harness.auditService.write).toHaveBeenCalled();
  });

  it("allows SA to create but not approve or return order changes", async () => {
    const harness = createOrderChangeHarness({ changeStatus: null });

    await expect(
      harness.service.createOrderChange(
        harness.orderId,
        {
          changeType: OrderChangeType.PLAN_CHANGE,
          reason: "customer request"
        },
        harness.saUser,
        harness.context
      )
    ).resolves.toMatchObject({ changeType: OrderChangeType.PLAN_CHANGE });

    await expect(
      harness.service.setOrderChangeStatus(
        harness.changeId,
        OrderChangeStatus.APPROVED,
        harness.saUser,
        harness.context
      )
    ).rejects.toThrow("Permission denied.");

    await expect(
      harness.service.returnOrderChangeToPlan(harness.changeId, harness.saUser, harness.context)
    ).rejects.toThrow("Permission denied.");
  });

  it("does not expose raw JSON in the order detail quote snapshot UI", () => {
    const pagePath = join(process.cwd(), "..", "web", "src", "app", "orders", "[id]", "page.tsx");
    const source = readFileSync(pagePath, "utf8");

    expect(source).not.toContain("snapshotJson(");
    expect(source).not.toContain("<pre");
    expect(source).not.toContain("rawSnapshot");
  });
});

interface HarnessOptions {
  afterSnapshot?: Record<string, unknown>;
  changeStatus?: OrderChangeStatus | null;
  contractStatus?: ContractStatus | null;
  createdBy?: string | null;
  executedAt?: Date | null;
  orderSource?: "CUSTOMER_SELF_SERVICE" | "SALES_ASSISTED";
  orderStatus?: OrderStatus;
  planVehicleModel?: VehicleModel;
  vehicleStatus?: VehicleStatus;
}

function createOrderChangeHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-06-05T00:30:00.000Z");
  const orderId = "order-1";
  const changeId = "change-1";
  const quoteId = "quote-1";
  const vehicleId = "vehicle-1";
  const contractId = "contract-1";
  const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };
  const opUser = {
    id: "op-1",
    menus: [],
    name: "Operator",
    permissions: ["order_change:create", "order_change:approve", "order_change:reject", "order_change:execute"],
    roles: ["OP"],
    username: "op"
  };
  const saUser = {
    id: "sa-1",
    menus: [],
    name: "Sales",
    permissions: ["order:view", "order_change:view", "order_change:create"],
    roles: ["SA"],
    username: "sa"
  };
  const state = {
    change: {
      afterSnapshot: options.afterSnapshot ?? {
        periodMonths: 12,
        subscriptionPlanId: "plan-new",
        vehicleBaseFeeAmount: 400000
      },
      beforeSnapshot: null as unknown,
      createdBy: options.createdBy === undefined ? saUser.id : options.createdBy,
      executedAt: options.executedAt ?? null as Date | null,
      exists: options.changeStatus !== null,
      status: options.changeStatus ?? OrderChangeStatus.APPROVED
    },
    contractId: options.contractStatus === undefined ? null as string | null : contractId,
    contractStatus: options.contractStatus ?? null,
    energyLimitCount: null as number | null,
    energyLimitKwh: null as number | null,
    mileageLimitKm: 1500,
    monthlyFeeAmount: 300000n,
    orderStatus: options.orderStatus ?? OrderStatus.PENDING_CONTRACT,
    orderSource: options.orderSource ?? "SALES_ASSISTED",
    overMileageFeeAmount: 100n,
    periodMonths: 12,
    productId: "product-old",
    productVersionId: "version-old",
    quoteSnapshot: { vehicleBaseFeeAmount: 300000 },
    vehicleStatus: options.vehicleStatus ?? VehicleStatus.RESERVED
  };

  function buildVehicle() {
    return {
      assetLocation: "Shanghai",
      brand: "NIO",
      createdAt: now,
      currentMileageKm: 12000,
      currentSalePriceAmount: 20000000n,
      currentSalePriceInitializedAt: now,
      currentSalePriceReviewedAt: now,
      deletedAt: null,
      id: vehicleId,
      model: "ET5",
      plateNo: "沪A00001",
      purchasePriceAmount: 18000000n,
      salePriceStatus: SalePriceStatus.EFFECTIVE,
      series: "ET5",
      status: state.vehicleStatus,
      updatedAt: now,
      vehicleModel: VehicleModel.ET5,
      vehicleNo: "VEH202606050001",
      vin: "VIN202606050001"
    };
  }

  function buildContract() {
    if (!state.contractStatus) {
      return null;
    }
    return {
      archivedAt: null,
      businessType: BusinessType.SUBSCRIPTION,
      contractNo: "CON202606050001",
      contractSnapshot: {},
      contractTitle: "Subscription Contract",
      contractVersionId: "contract-version-1",
      createdAt: now,
      createdBy: opUser.id,
      customerId: "customer-1",
      deletedAt: null,
      fileId: null,
      id: contractId,
      orderId,
      signedAt: state.contractStatus === ContractStatus.SIGNED ? now : null,
      status: state.contractStatus,
      updatedAt: now,
      updatedBy: opUser.id
    };
  }

  function buildOrder() {
    const contract = buildContract();
    return {
      actualDeliveryAt: null,
      application: {
        applicationNo: "APP202606050001",
        id: "application-1",
        salesUserId: saUser.id,
        status: ApplicationStatus.APPROVED
      },
      applicationId: "application-1",
      businessType: BusinessType.SUBSCRIPTION,
      changes: state.change.exists ? [buildChange()] : [],
      contract,
      contractId: state.contractId,
      contracts: contract ? [contract] : [],
      createdAt: now,
      createdBy: saUser.id,
      creditReviewStatus: "APPROVED",
      customer: { grade: "A", id: "customer-1", identity: { idCardNo: "TEST-ID-CHANGE-0001" }, mobile: "13800000000", name: "Test Customer" },
      customerConfirmedAt: null,
      customerId: "customer-1",
      customerSelectedSnapshot: null,
      deletedAt: null,
      depositAmount: 500000n,
      depositStatus: "CONFIRMED",
      endDate: null,
      energyLimitCount: state.energyLimitCount,
      energyLimitKwh: state.energyLimitKwh,
      finalDepositAmount: 500000n,
      finalPlanConfirmedAt: null,
      id: orderId,
      mileageLimitKm: state.mileageLimitKm,
      monthlyFeeAmount: state.monthlyFeeAmount,
      orderNo: "ORD202606050001",
      orderSource: state.orderSource,
      orderStatus: state.orderStatus,
      overMileageFeeAmount: state.overMileageFeeAmount,
      periodMonths: state.periodMonths,
      productId: state.productId,
      productReviewStatus: "APPROVED",
      productVersion: { product: { productType: ProductType.SUBSCRIPTION, status: ProductStatus.ACTIVE } },
      productVersionId: state.productVersionId,
      quote: { id: quoteId, quoteNo: "QUO202606050001", status: QuoteStatus.CONFIRMED },
      quoteId,
      quoteSnapshot: state.quoteSnapshot,
      riskResult: null,
      riskResultId: null,
      startDate: null,
      updatedAt: now,
      updatedBy: opUser.id,
      vehicle: buildVehicle(),
      vehicleId,
      vehicleModel: VehicleModel.ET5,
      vehiclePurchasePriceAmount: 18000000n,
      vehicleReviewStatus: "APPROVED"
    };
  }

  function buildChange() {
    return {
      afterSnapshot: state.change.afterSnapshot,
      approvedAt: now,
      approvedBy: opUser.id,
      beforeSnapshot: state.change.beforeSnapshot,
      changeType: OrderChangeType.PLAN_CHANGE,
      createdAt: now,
      createdBy: state.change.createdBy,
      deletedAt: null,
      executedAt: state.change.executedAt,
      id: changeId,
      orderId,
      reason: "Change plan",
      status: state.change.status,
      updatedAt: now,
      updatedBy: opUser.id
    };
  }

  const plan = makePlan(now, options.planVehicleModel ?? VehicleModel.ET5);

  const tx = {
    contract: {
      create: vi.fn(async ({ data }) => {
        state.contractId = contractId;
        state.contractStatus = data.status;
        return { ...buildContract(), ...data, id: contractId };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...buildContract(), order: buildOrder() })),
      update: vi.fn(async ({ data }) => {
        state.contractStatus = data.status;
        return buildContract();
      })
    },
    orderChange: {
      findUnique: vi.fn(async () => buildChange()),
      update: vi.fn(async ({ data }) => {
        state.change.beforeSnapshot = data.beforeSnapshot;
        state.change.afterSnapshot = data.afterSnapshot;
        state.change.executedAt = data.executedAt;
        state.change.status = data.status;
        return buildChange();
      })
    },
    subscriptionOrder: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => buildOrder()),
      update: vi.fn(async ({ data }) => {
        if ("contractId" in data) state.contractId = data.contractId;
        if (data.energyLimitCount !== undefined) state.energyLimitCount = data.energyLimitCount;
        if (data.energyLimitKwh !== undefined) state.energyLimitKwh = data.energyLimitKwh;
        if (data.mileageLimitKm !== undefined) state.mileageLimitKm = data.mileageLimitKm;
        if (data.monthlyFeeAmount !== undefined) state.monthlyFeeAmount = data.monthlyFeeAmount;
        if (data.orderStatus !== undefined) state.orderStatus = data.orderStatus;
        if (data.overMileageFeeAmount !== undefined) state.overMileageFeeAmount = data.overMileageFeeAmount;
        if (data.periodMonths !== undefined) state.periodMonths = data.periodMonths;
        if (data.productId !== undefined) state.productId = data.productId;
        if (data.productVersionId !== undefined) state.productVersionId = data.productVersionId;
        if (data.quoteSnapshot !== undefined) state.quoteSnapshot = data.quoteSnapshot;
        return buildOrder();
      })
    },
    subscriptionPlan: {
      findUnique: vi.fn(async () => plan)
    },
    subscriptionQuote: {
      findUnique: vi.fn(async () => ({
        id: quoteId,
        quoteNo: "QUO202606050001",
        status: QuoteStatus.CONFIRMED
      })),
      update: vi.fn(async ({ data }) => ({ id: quoteId, ...data }))
    },
    vehicle: {
      findUnique: vi.fn(async () => buildVehicle()),
      update: vi.fn(async ({ data }) => {
        if (data.status !== undefined) state.vehicleStatus = data.status;
        return buildVehicle();
      })
    }
  };

  const prisma = {
    $transaction: vi.fn(async (callback) => callback(tx)),
    orderChange: {
      create: vi.fn(async ({ data }) => ({ ...buildChange(), ...data, id: "created-change" })),
      findUnique: vi.fn(async () => state.change.exists ? ({ ...buildChange(), order: buildOrder() }) : null),
      update: vi.fn(async ({ data }) => {
        if (data.beforeSnapshot !== undefined) state.change.beforeSnapshot = data.beforeSnapshot;
        if (data.afterSnapshot !== undefined) state.change.afterSnapshot = data.afterSnapshot;
        if (data.executedAt !== undefined) state.change.executedAt = data.executedAt;
        if (data.status !== undefined) state.change.status = data.status;
        return buildChange();
      })
    },
    contract: {
      findUnique: vi.fn(async () => {
        const contract = buildContract();
        return contract ? { ...contract, order: buildOrder() } : null;
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async () => buildOrder())
    },
    subscriptionPlan: {
      findMany: vi.fn(async () => [plan])
    },
    contractVersion: {
      findFirst: vi.fn(async () => ({
        businessType: BusinessType.SUBSCRIPTION,
        contentTemplate: "Contract template",
        effectiveFrom: now,
        effectiveTo: null,
        id: "contract-version-1",
        status: "ACTIVE",
        templateName: "Template",
        versionNo: "V1"
      }))
    }
  };
  const auditService = { write: vi.fn(async () => undefined) };
  const service = new OrderService(auditService as never, prisma as never);

  return { auditService, changeId, context, contractId, opUser, orderId, prisma, saUser, service, state, tx, vehicleId };
}

function makePlan(now: Date, vehicleModel: VehicleModel) {
  const product = {
    deletedAt: null,
    id: "product-new",
    name: "Subscription Product",
    productNo: "PROD-NEW",
    productType: ProductType.SUBSCRIPTION,
    status: ProductStatus.ACTIVE
  };
  const productVersion = {
    deletedAt: null,
    effectiveFrom: now,
    effectiveTo: null,
    id: "version-new",
    productId: product.id,
    status: ProductVersionStatus.ACTIVE,
    versionNo: "V2"
  };
  const basePackage = {
    createdAt: now,
    createdBy: "op-1",
    deletedAt: null,
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    status: RecordStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "op-1"
  };

  return {
    baseMonthlyFeeAmount: null,
    benefitPackage: {
      ...basePackage,
      benefitCount: 1,
      benefitType: "SERVICE",
      description: "Benefit",
      id: "benefit-package-new",
      packageName: "Benefit Package",
      packageNo: "BEN-NEW",
      priceAmount: 10000n,
      remark: null
    },
    benefitPackageId: "benefit-package-new",
    createdAt: now,
    createdBy: "op-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    energyPackage: {
      ...basePackage,
      id: "energy-package-new",
      monthlyEnergyCount: 4,
      monthlyEnergyKwh: 100,
      packageName: "Energy Package",
      packageNo: "ENE-NEW",
      priceAmount: 20000n,
      remark: null
    },
    energyPackageId: "energy-package-new",
    id: "plan-new",
    maxPeriodMonths: 36,
    mileagePackage: {
      ...basePackage,
      id: "mileage-package-new",
      monthlyMileageKm: 1800,
      overMileageFeeAmount: 120n,
      packageName: "Mileage Package",
      packageNo: "MIL-NEW",
      priceAmount: 30000n,
      remark: null
    },
    mileagePackageId: "mileage-package-new",
    minPeriodMonths: 6,
    monthlyFeeCapRate: null,
    monthlyFeeMode: "RATE_FORMULA",
    monthlyFeeRate: 0.03,
    planName: "New Plan",
    planNo: "PLAN-NEW",
    product,
    productId: product.id,
    productVersion,
    productVersionId: productVersion.id,
    status: SubscriptionPlanStatus.ACTIVE,
    updatedAt: now,
    updatedBy: "op-1",
    vehiclePackage: {
      ...basePackage,
      brand: "NIO",
      configName: "ET5 Standard",
      id: "vehicle-package-new",
      maxPeriodMonths: 36,
      maxPurchasePriceAmount: null,
      minPeriodMonths: 6,
      minPurchasePriceAmount: null,
      monthlyFeeRate: 0.03,
      packageName: "Vehicle Package",
      packageNo: "VEH-NEW",
      remark: null,
      series: "ET5",
      vehicleModel,
      vehicleModelName: vehicleModel
    },
    vehiclePackageId: "vehicle-package-new"
  };
}
