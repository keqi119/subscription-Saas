import {
  AuditAction,
  BillStatus,
  BillType,
  BusinessType,
  DepositStatus,
  FinancingCollateralType,
  FinancingInstrumentStatus,
  FinancingInstrumentType,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  Prisma,
  RevenueRightAssigneeType,
  RevenueRightAssignmentStatus,
  RevenueRightAssignmentType,
  RevenueRightTargetType,
  RevenueShareBasis,
  RevenueShareRuleStatus,
  RevenueShareRuleType,
  RevenueShareSettlementCycle,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

import { RevenueRightService } from "../src/revenue-right/revenue-right.service";

describe("RevenueRightService assignments", () => {
  it("creates an ORDER revenue right assignment", async () => {
    const harness = createRevenueHarness();

    const result = await harness.service.createAssignment(
      {
        assigneeName: "某银行",
        assigneeType: RevenueRightAssigneeType.FINANCIER,
        assignmentType: RevenueRightAssignmentType.PLEDGE,
        effectiveFrom: "2026-07-01",
        financingInstrumentId: "instrument-1",
        orderId: "order-1",
        shareRatioBps: 10000,
        targetType: RevenueRightTargetType.ORDER
      },
      user,
      context
    );

    expect(result.assignmentNo).toMatch(/^RRA\d{14}[A-Z0-9]{4}$/);
    expect(result.orderId).toBe("order-1");
    expect(result.vehicleId).toBe("vehicle-1");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "revenue_right_assignment" })
    );
  });

  it("creates a RECEIVABLE_BILL revenue right assignment", async () => {
    const harness = createRevenueHarness();

    const result = await harness.service.createAssignment(
      {
        assigneeName: "某银行",
        assigneeType: RevenueRightAssigneeType.FINANCIER,
        assignmentType: RevenueRightAssignmentType.PLEDGE,
        billId: "bill-rent",
        effectiveFrom: "2026-07-01",
        financingInstrumentId: "instrument-1",
        targetType: RevenueRightTargetType.RECEIVABLE_BILL
      },
      user,
      context
    );

    expect(result.billId).toBe("bill-rent");
    expect(result.orderId).toBe("order-1");
    expect(result.vehicleId).toBe("vehicle-1");
  });

  it("serializes assignment views without leaking nested bigint values", async () => {
    const harness = createRevenueHarness({
      assignments: [makeAssignment({ billId: "bill-rent", targetType: RevenueRightTargetType.RECEIVABLE_BILL })]
    });

    const result = await harness.service.listAssignments({});

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.items[0]?.bill?.paidAmount).toBe(500000);
    expect(result.items[0]?.financingInstrument).toEqual({
      id: "instrument-1",
      instrumentNo: "FI20260602000000A1B2",
      instrumentType: FinancingInstrumentType.RECEIVABLE_PLEDGE,
      lenderName: "某银行"
    });
  });

  it("rejects ORDER target without orderId", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createAssignment(
        {
          assigneeType: RevenueRightAssigneeType.FINANCIER,
          assignmentType: RevenueRightAssignmentType.OTHER,
          effectiveFrom: "2026-07-01",
          targetType: RevenueRightTargetType.ORDER
        },
        user,
        context
      )
    ).rejects.toThrow("orderId 必填");
  });

  it("rejects RECEIVABLE_BILL target without billId", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createAssignment(
        {
          assigneeType: RevenueRightAssigneeType.FINANCIER,
          assignmentType: RevenueRightAssignmentType.OTHER,
          effectiveFrom: "2026-07-01",
          targetType: RevenueRightTargetType.RECEIVABLE_BILL
        },
        user,
        context
      )
    ).rejects.toThrow("billId 必填");
  });

  it("rejects PLEDGE assignment without financingInstrumentId", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createAssignment(
        {
          assigneeType: RevenueRightAssigneeType.FINANCIER,
          assignmentType: RevenueRightAssignmentType.PLEDGE,
          effectiveFrom: "2026-07-01",
          orderId: "order-1",
          targetType: RevenueRightTargetType.ORDER
        },
        user,
        context
      )
    ).rejects.toThrow("必须关联融资工具");
  });

  it("rejects shareRatioBps greater than 10000", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createAssignment(
        {
          assigneeType: RevenueRightAssigneeType.FINANCIER,
          assignmentType: RevenueRightAssignmentType.OTHER,
          effectiveFrom: "2026-07-01",
          orderId: "order-1",
          shareRatioBps: 10001,
          targetType: RevenueRightTargetType.ORDER
        },
        user,
        context
      )
    ).rejects.toThrow("shareRatioBps");
  });

  it("rejects duplicate ACTIVE assignment", async () => {
    const assignment = makeAssignment({
      assigneeName: "某银行",
      financingInstrumentId: "instrument-1"
    });
    const harness = createRevenueHarness({ assignments: [assignment] });

    await expect(
      harness.service.createAssignment(
        {
          assigneeName: "某银行",
          assigneeType: RevenueRightAssigneeType.FINANCIER,
          assignmentType: RevenueRightAssignmentType.PLEDGE,
          effectiveFrom: "2026-07-01",
          financingInstrumentId: "instrument-1",
          orderId: "order-1",
          targetType: RevenueRightTargetType.ORDER
        },
        user,
        context
      )
    ).rejects.toThrow("完全重复");
  });

  it("releases an ACTIVE assignment", async () => {
    const assignment = makeAssignment();
    const harness = createRevenueHarness({ assignments: [assignment] });

    const result = await harness.service.releaseAssignment(
      assignment.id,
      { releaseReason: "融资到期解除质押", releasedAt: "2027-07-01" },
      user,
      context
    );

    expect(result.assignmentStatus).toBe(RevenueRightAssignmentStatus.RELEASED);
    expect(result.releasedAt).toEqual(new Date("2027-07-01T00:00:00.000Z"));
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "revenue_right_assignment" })
    );
  });

  it("does not release an assignment twice", async () => {
    const assignment = makeAssignment({ assignmentStatus: RevenueRightAssignmentStatus.RELEASED });
    const harness = createRevenueHarness({ assignments: [assignment] });

    await expect(
      harness.service.releaseAssignment(
        assignment.id,
        { releaseReason: "重复解除", releasedAt: "2027-07-01" },
        user,
        context
      )
    ).rejects.toThrow("不能重复释放");
  });
});

describe("RevenueRightService revenue share rules", () => {
  it("creates a revenue share rule", async () => {
    const harness = createRevenueHarness();

    const result = await harness.service.createVehicleRevenueShareRule(
      "vehicle-1",
      validShareRuleDto(),
      user,
      context
    );

    expect(result.ruleNo).toMatch(/^RSR\d{14}[A-Z0-9]{4}$/);
    expect(result.ownerShareBps).toBe(3000);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.CREATE, entityType: "revenue_share_rule" })
    );
  });

  it("rejects REVENUE_SHARE without ownerShareBps", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createVehicleRevenueShareRule(
        "vehicle-1",
        { ...validShareRuleDto(), ownerShareBps: null },
        user,
        context
      )
    ).rejects.toThrow("ownerShareBps");
  });

  it("rejects FIXED_RENT without fixedMonthlyAmount", async () => {
    const harness = createRevenueHarness();

    await expect(
      harness.service.createVehicleRevenueShareRule(
        "vehicle-1",
        {
          ...validShareRuleDto(),
          fixedMonthlyAmount: null,
          ownerShareBps: null,
          ruleType: RevenueShareRuleType.FIXED_RENT
        },
        user,
        context
      )
    ).rejects.toThrow("fixedMonthlyAmount");
  });

  it("rejects duplicate ACTIVE rule for one vehicle", async () => {
    const harness = createRevenueHarness({ rules: [makeShareRule()] });

    await expect(
      harness.service.createVehicleRevenueShareRule("vehicle-1", validShareRuleDto(), user, context)
    ).rejects.toThrow("重复创建 ACTIVE 分润规则");
  });

  it("deactivates a revenue share rule", async () => {
    const rule = makeShareRule();
    const harness = createRevenueHarness({ rules: [rule] });

    const result = await harness.service.deactivateVehicleRevenueShareRule(
      "vehicle-1",
      rule.id,
      { effectiveTo: "2027-07-01", remark: "合作结束" },
      user,
      context
    );

    expect(result.ruleStatus).toBe(RevenueShareRuleStatus.INACTIVE);
    expect(result.effectiveTo).toEqual(new Date("2027-07-01T00:00:00.000Z"));
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.UPDATE, entityType: "revenue_share_rule" })
    );
  });

  it("RENTAL_PAID preview excludes DEPOSIT", async () => {
    const harness = createRevenueHarness({
      bills: [
        makeBill({ billType: BillType.DEPOSIT, id: "bill-deposit", paidAmount: 100000n }),
        makeBill({ billType: BillType.FIRST_MONTHLY_FEE, id: "bill-first", paidAmount: 300000n }),
        makeBill({ billType: BillType.MONTHLY_RENT, id: "bill-rent", paidAmount: 500000n })
      ],
      rules: [makeShareRule({ ownerShareBps: 3000, shareBasis: RevenueShareBasis.RENTAL_PAID })]
    });

    const result = await harness.service.getVehicleRevenueSharePreview("vehicle-1", {
      endDate: "2026-07-31",
      startDate: "2026-07-01"
    });

    expect(result.preview?.shareBaseAmount).toBe(800000);
    expect(result.preview?.ownerShareAmount).toBe(240000);
  });

  it("OPERATING_REVENUE preview includes DAMAGE_FEE and OTHER", async () => {
    const harness = createRevenueHarness({
      bills: [
        makeBill({ billType: BillType.FIRST_MONTHLY_FEE, id: "bill-first", paidAmount: 300000n }),
        makeBill({ billType: BillType.MONTHLY_RENT, id: "bill-rent", paidAmount: 500000n }),
        makeBill({ billType: BillType.DAMAGE_FEE, id: "bill-damage", paidAmount: 200000n }),
        makeBill({ billType: BillType.OTHER, id: "bill-other", paidAmount: 100000n }),
        makeBill({ billType: BillType.DEPOSIT, id: "bill-deposit", paidAmount: 999999n })
      ],
      rules: [makeShareRule({ ownerShareBps: 3000, shareBasis: RevenueShareBasis.OPERATING_REVENUE })]
    });

    const result = await harness.service.getVehicleRevenueSharePreview("vehicle-1", {
      endDate: "2026-07-31",
      startDate: "2026-07-01"
    });

    expect(result.preview?.shareBaseAmount).toBe(1100000);
    expect(result.preview?.ownerShareAmount).toBe(330000);
  });

  it("prorates fixedMonthlyAmount by date range", async () => {
    const harness = createRevenueHarness({
      bills: [],
      rules: [
        makeShareRule({
          fixedMonthlyAmount: 36500n,
          ownerShareBps: null,
          ruleType: RevenueShareRuleType.FIXED_RENT
        })
      ]
    });

    const result = await harness.service.getVehicleRevenueSharePreview("vehicle-1", {
      endDate: "2026-07-10",
      startDate: "2026-07-01"
    });

    expect(result.preview?.fixedCostAmount).toBe(12000);
    expect(result.preview?.ownerShareAmount).toBe(12000);
    expect(result.preview?.warnings).toContain("platformShareAmount < 0，请检查固定成本或分成规则。");
  });

  it("returns unsupportedReason for MANUAL shareBasis", async () => {
    const harness = createRevenueHarness({
      rules: [
        makeShareRule({
          fixedMonthlyAmount: 36500n,
          ruleType: RevenueShareRuleType.FIXED_RENT,
          shareBasis: RevenueShareBasis.MANUAL
        })
      ]
    });

    const result = await harness.service.getVehicleRevenueSharePreview("vehicle-1", {
      endDate: "2026-07-31",
      startDate: "2026-07-01"
    });

    expect(result.preview?.previewSupported).toBe(false);
    expect(result.preview?.fixedCostAmount).toBe(37200);
    expect(result.preview?.unsupportedReason).toContain("MANUAL");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

function createRevenueHarness(seed: {
  assignments?: ReturnType<typeof makeAssignment>[];
  bills?: ReturnType<typeof makeBill>[];
  instruments?: ReturnType<typeof makeInstrument>[];
  orders?: ReturnType<typeof makeOrder>[];
  rules?: ReturnType<typeof makeShareRule>[];
  vehicles?: ReturnType<typeof makeVehicle>[];
} = {}) {
  const state = {
    assignments: seed.assignments ?? [],
    bills: seed.bills ?? [makeBill()],
    instruments: seed.instruments ?? [makeInstrument()],
    orders: seed.orders ?? [makeOrder()],
    rules: seed.rules ?? [],
    vehicles: seed.vehicles ?? [makeVehicle()]
  };
  const prisma = revenuePrismaMock(state);
  const auditService = { write: vi.fn(async () => undefined) };

  return {
    auditService,
    prisma,
    service: new RevenueRightService(auditService as never, prisma as never),
    state
  };
}

function revenuePrismaMock(state: {
  assignments: ReturnType<typeof makeAssignment>[];
  bills: ReturnType<typeof makeBill>[];
  instruments: ReturnType<typeof makeInstrument>[];
  orders: ReturnType<typeof makeOrder>[];
  rules: ReturnType<typeof makeShareRule>[];
  vehicles: ReturnType<typeof makeVehicle>[];
}) {
  return {
    financingInstrument: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.instruments.find((instrument) => instrument.id === where.id) ?? null
      )
    },
    receivableBill: {
      findMany: vi.fn(async () => state.bills),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const bill = state.bills.find((item) => item.id === where.id);
        const order = state.orders.find((item) => item.id === bill?.orderId);
        return bill ? { ...bill, order } : null;
      })
    },
    revenueRightAssignment: {
      count: vi.fn(async () => state.assignments.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const assignment = makeAssignment({
          ...data,
          id: `assignment-${state.assignments.length + 1}`
        } as Partial<ReturnType<typeof makeAssignment>>);
        state.assignments.push(assignment);
        return hydrateAssignment(assignment, state);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.assignments.find((assignment) => assignmentMatchesWhere(assignment, where)) ?? null
      ),
      findMany: vi.fn(async () => state.assignments.map((assignment) => hydrateAssignment(assignment, state))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const assignment = state.assignments.find((item) => item.id === where.id);
        return assignment ? hydrateAssignment(assignment, state) : null;
      }),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.assignments.findIndex((assignment) => assignment.id === where.id);
        const next = { ...state.assignments[index], ...data, updatedAt: now } as ReturnType<typeof makeAssignment>;
        state.assignments[index] = next;
        return hydrateAssignment(next, state);
      })
    },
    revenueShareRule: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const rule = makeShareRule({
          ...data,
          id: `rule-${state.rules.length + 1}`
        } as Partial<ReturnType<typeof makeShareRule>>);
        state.rules.push(rule);
        return hydrateRule(rule, state);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rule = state.rules.find(
          (item) =>
            item.vehicleId === where.vehicleId &&
            !item.deletedAt &&
            item.ruleStatus === RevenueShareRuleStatus.ACTIVE
        );
        return rule ? hydrateRule(rule, state) : null;
      }),
      findMany: vi.fn(async () => state.rules.map((rule) => hydrateRule(rule, state))),
      update: vi.fn(async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const index = state.rules.findIndex((rule) => rule.id === where.id);
        const next = { ...state.rules[index], ...data, updatedAt: now } as ReturnType<typeof makeShareRule>;
        state.rules[index] = next;
        return hydrateRule(next, state);
      })
    },
    subscriptionOrder: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.orders.find((order) => order.id === where.id) ?? null
      )
    },
    vehicle: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.vehicles.find((vehicle) => vehicle.id === where.id) ?? null
      )
    }
  };
}

function assignmentMatchesWhere(assignment: ReturnType<typeof makeAssignment>, where: Record<string, unknown>) {
  return (
    assignment.assignmentStatus === where.assignmentStatus &&
    assignment.assignmentType === where.assignmentType &&
    assignment.targetType === where.targetType &&
    assignment.vehicleId === where.vehicleId &&
    assignment.orderId === where.orderId &&
    assignment.billId === where.billId &&
    assignment.financingInstrumentId === where.financingInstrumentId &&
    assignment.assigneeType === where.assigneeType &&
    assignment.assigneeName === where.assigneeName &&
    !assignment.deletedAt
  );
}

function hydrateAssignment(
  assignment: ReturnType<typeof makeAssignment>,
  state: ReturnState
) {
  return {
    ...assignment,
    bill: state.bills.find((bill) => bill.id === assignment.billId) ?? null,
    financingInstrument:
      state.instruments.find((instrument) => instrument.id === assignment.financingInstrumentId) ?? null,
    order: state.orders.find((order) => order.id === assignment.orderId) ?? null,
    vehicle: state.vehicles.find((vehicle) => vehicle.id === assignment.vehicleId) ?? null
  };
}

function hydrateRule(rule: ReturnType<typeof makeShareRule>, state: ReturnState) {
  return {
    ...rule,
    vehicle: state.vehicles.find((vehicle) => vehicle.id === rule.vehicleId) ?? null
  };
}

function validShareRuleDto() {
  return {
    effectiveFrom: "2026-07-01",
    ownerName: "外部车主张三",
    ownerShareBps: 3000,
    platformShareBps: 7000,
    ruleType: RevenueShareRuleType.REVENUE_SHARE,
    settlementCycle: RevenueShareSettlementCycle.MONTHLY,
    shareBasis: RevenueShareBasis.RENTAL_PAID
  };
}

const now = new Date("2026-06-02T00:00:00.000Z");
const user = { id: "user-1", menus: [], name: "财务", permissions: [], roles: [], username: "fi" };
const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

function makeAssignment(overrides: Partial<Prisma.RevenueRightAssignmentGetPayload<Record<string, never>>> = {}) {
  return {
    assigneeName: "某银行",
    assigneeType: RevenueRightAssigneeType.FINANCIER,
    assignmentNo: "RRA20260602000000A1B2",
    assignmentStatus: RevenueRightAssignmentStatus.ACTIVE,
    assignmentType: RevenueRightAssignmentType.PLEDGE,
    billId: null,
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    financingInstrumentId: "instrument-1",
    id: "assignment-1",
    orderId: "order-1",
    priority: null,
    releaseReason: null,
    releasedAt: null,
    remark: null,
    shareRatioBps: 10000,
    snapshot: {},
    targetType: RevenueRightTargetType.ORDER,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeShareRule(overrides: Partial<Prisma.RevenueShareRuleGetPayload<Record<string, never>>> = {}) {
  return {
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
    effectiveTo: null,
    fixedMonthlyAmount: null,
    id: "rule-1",
    minimumGuaranteeAmount: null,
    ownerContact: "13900000000",
    ownerName: "外部车主张三",
    ownerShareBps: 3000,
    platformShareBps: 7000,
    remark: null,
    ruleNo: "RSR20260602000000A1B2",
    ruleStatus: RevenueShareRuleStatus.ACTIVE,
    ruleType: RevenueShareRuleType.REVENUE_SHARE,
    settlementCycle: RevenueShareSettlementCycle.MONTHLY,
    shareBasis: RevenueShareBasis.RENTAL_PAID,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function makeInstrument(overrides: Partial<Prisma.FinancingInstrumentGetPayload<Record<string, never>>> = {}) {
  return {
    annualRateBps: 650,
    collateralType: FinancingCollateralType.BILL_RECEIVABLE,
    contractNo: "AR-2026-001",
    createdAt: now,
    createdBy: "user-1",
    deletedAt: null,
    id: "instrument-1",
    instrumentNo: "FI20260602000000A1B2",
    instrumentStatus: FinancingInstrumentStatus.ACTIVE,
    instrumentType: FinancingInstrumentType.RECEIVABLE_PLEDGE,
    lenderName: "某银行",
    maturityDate: new Date("2027-07-01T00:00:00.000Z"),
    principalAmount: 10000000n,
    remark: null,
    repaymentMethod: null,
    snapshot: {},
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    termMonths: 12,
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeBill(overrides: Partial<Prisma.ReceivableBillGetPayload<Record<string, never>>> = {}) {
  return {
    amount: 500000n,
    billNo: "BIL20260602000000A1B2",
    billPeriodEnd: new Date("2026-07-31T00:00:00.000Z"),
    billPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
    billStatus: BillStatus.PAID,
    billType: BillType.MONTHLY_RENT,
    cancelledAt: null,
    createdAt: now,
    createdBy: "user-1",
    customerId: "customer-1",
    deletedAt: null,
    dueDate: new Date("2026-07-31T00:00:00.000Z"),
    id: "bill-rent",
    orderId: "order-1",
    paidAmount: 500000n,
    paidAt: new Date("2026-07-31T00:00:00.000Z"),
    remainingAmount: 0n,
    remark: null,
    snapshot: {},
    updatedAt: now,
    updatedBy: "user-1",
    ...overrides
  };
}

function makeOrder(overrides: Partial<Prisma.SubscriptionOrderGetPayload<Record<string, never>>> = {}) {
  return {
    actualDeliveryAt: null,
    actualReturnAt: null,
    applicationId: "application-1",
    businessType: BusinessType.SUBSCRIPTION,
    contractId: null,
    createdAt: now,
    createdBy: "user-1",
    creditReviewStatus: OrderReviewStatus.APPROVED,
    customerConfirmedAt: null,
    customerId: "customer-1",
    customerSelectedSnapshot: null,
    deletedAt: null,
    depositAmount: 500000n,
    depositStatus: DepositStatus.CONFIRMED,
    endDate: null,
    energyLimitCount: null,
    energyLimitKwh: null,
    finalDepositAmount: null,
    finalPlanConfirmedAt: null,
    finalPlanSnapshot: null,
    id: "order-1",
    mileageLimitKm: 1000,
    monthlyFeeAmount: 500000n,
    orderNo: "ORD20260602000000A1B2",
    orderSource: OrderSource.SALES_ASSISTED,
    orderStatus: OrderStatus.ACTIVE,
    overMileageFeeAmount: 100n,
    periodMonths: 12,
    productId: "product-1",
    productReviewStatus: OrderReviewStatus.APPROVED,
    productVersionId: "version-1",
    quoteId: "quote-1",
    quoteSnapshot: {},
    reviewComment: null,
    riskResultId: null,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: now,
    updatedBy: "user-1",
    vehicleId: "vehicle-1",
    vehicleModel: VehicleModel.ET5,
    vehiclePurchasePriceAmount: 16800000n,
    vehicleReviewStatus: OrderReviewStatus.APPROVED,
    ...overrides
  };
}

function makeVehicle(overrides: Partial<Prisma.VehicleGetPayload<Record<string, never>>> = {}) {
  return {
    acquisitionMode: VehicleAcquisitionMode.MANAGED_REVENUE_SHARE,
    assetLocation: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: now,
    createdBy: "user-1",
    currentMileageKm: 0,
    currentSalePriceAmount: null,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "vehicle-1",
    model: null,
    modelYear: null,
    nextSalePriceReviewAt: null,
    plateNo: null,
    purchaseDate: null,
    purchasePriceAmount: 16800000n,
    registrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: "PENDING_INITIALIZE",
    series: null,
    status: VehicleStatus.DRAFT,
    updatedAt: now,
    updatedBy: "user-1",
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VEH20260602000000A1B2",
    vin: null,
    ...overrides
  };
}

type ReturnState = {
  assignments: ReturnType<typeof makeAssignment>[];
  bills: ReturnType<typeof makeBill>[];
  instruments: ReturnType<typeof makeInstrument>[];
  orders: ReturnType<typeof makeOrder>[];
  rules: ReturnType<typeof makeShareRule>[];
  vehicles: ReturnType<typeof makeVehicle>[];
};
