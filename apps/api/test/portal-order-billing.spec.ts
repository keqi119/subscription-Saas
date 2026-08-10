import { Logger } from "@nestjs/common";
import {
  BillStatus,
  BillType,
  ContractStatus,
  DepositTransactionStatus,
  DepositTransactionType,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
  ESignTaskStatus,
  OrderSource,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { TEST_MODEL_CODES } from "./helpers/vehicle-model-codes";

import { PortalBillingService } from "../src/portal/portal-billing.service";

describe("portal billing and entitlement center", () => {
  it("lists only the current customer's orders and does not expose sensitive vehicle fields", async () => {
    const harness = createPortalBillingHarness();

    const result = await harness.service.listOrders(harness.currentCustomer("customer_a"), {});

    expect(result.total).toBe(1);
    expect(result.items[0]?.orderNo).toBe("ORD-A");
    const serialized = JSON.stringify(result.items[0]);
    expect(serialized).not.toContain("purchasePriceAmount");
    expect(serialized).not.toContain("currentSalePriceAmount");
    expect(serialized).not.toContain("vin");
    expect(serialized).not.toContain("plateNo");
  });

  it("uses immutable order snapshot display names for customer-facing order vehicles", async () => {
    const harness = createPortalBillingHarness();

    const result = await harness.service.listOrders(harness.currentCustomer("customer_a"), {});

    expect(result.items[0]?.vehicleSummary?.displayName).toBe("Frozen Portal ET5");
    const serialized = JSON.stringify(result.items[0]);
    expect(serialized).not.toContain("modelDefinitionIdSnapshot");
    expect(serialized).not.toContain("legacyVehicleModelSnapshot");
    expect(serialized).not.toContain("legacyVehicleModelCodeSnapshot");
    expect(serialized).not.toContain("modelDisplaySource");
  });

  it("orders customer actions by earliest real deadline before processing", async () => {
    const harness = createPortalBillingHarness();
    harness.orders.splice(
      0,
      harness.orders.length,
      makeOrder({ id: "processing", orderNo: "PROCESSING", orderStatus: OrderStatus.PENDING_DELIVERY, updatedAt: new Date("2026-08-10T06:00:00Z") }),
      makeOrder({
        id: "sign",
        orderNo: "SIGN",
        orderStatus: OrderStatus.PENDING_SIGN,
        contract: {
          contractNo: "CON-SIGN",
          createdAt: new Date("2026-08-09T00:00:00Z"),
          esignTasks: [{
            signUrlExpiresAt: new Date("2026-08-10T12:00:00Z"),
            taskStatus: ESignTaskStatus.WAITING_CUSTOMER
          }],
          id: "contract-sign",
          signedAt: null,
          status: ContractStatus.SIGNING
        }
      }),
      makeOrder({
        id: "pay",
        orderNo: "PAY",
        orderStatus: OrderStatus.ACTIVE,
        receivableBills: [makeBill({ id: "pay-bill", orderId: "pay", dueDate: new Date("2026-08-12T00:00:00Z") })]
      }),
      makeOrder({
        id: "mileage",
        orderNo: "MILEAGE",
        orderStatus: OrderStatus.ACTIVE,
        receivableBills: [],
        mileageReviews: [{
          cycleNo: 1,
          dueAt: new Date("2026-08-11T00:00:00Z"),
          id: "review-mileage",
          lockVersion: 0,
          overMileageBillId: null,
          scheduledReviewAt: new Date("2026-08-10T00:00:00Z"),
          status: OrderMileageReviewStatus.PENDING_SUBMISSION
        }]
      })
    );

    const result = await harness.service.listOrders(harness.currentCustomer("customer_a"), {});
    expect(result.items.map((item) => item.orderNo)).toEqual([
      "SIGN",
      "MILEAGE",
      "PAY",
      "PROCESSING"
    ]);
  });

  it("continues from sorted non-terminal orders into paged history", async () => {
    const harness = createPortalBillingHarness();
    harness.orders.splice(
      0,
      harness.orders.length,
      makeOrder({ id: "active", orderNo: "ACTIVE", orderStatus: OrderStatus.PENDING_PAYMENT }),
      makeOrder({ id: "completed-new", orderNo: "COMPLETED-NEW", orderStatus: OrderStatus.COMPLETED, updatedAt: new Date("2026-08-10T06:00:00Z") }),
      makeOrder({ id: "completed-old", orderNo: "COMPLETED-OLD", orderStatus: OrderStatus.COMPLETED, updatedAt: new Date("2026-08-09T06:00:00Z") })
    );

    const page = await harness.service.listOrders(
      harness.currentCustomer("customer_a"),
      { page: 1, pageSize: 2 }
    );
    expect(page.items.map((item) => item.orderNo)).toEqual(["ACTIVE", "COMPLETED-NEW"]);
    expect(page.total).toBe(3);
  });

  it("keeps orderStatus filtering exact", async () => {
    const harness = createPortalBillingHarness();
    harness.orders.splice(
      0,
      harness.orders.length,
      makeOrder({ id: "active", orderNo: "ACTIVE", orderStatus: OrderStatus.ACTIVE }),
      makeOrder({ id: "completed", orderNo: "COMPLETED", orderStatus: OrderStatus.COMPLETED })
    );

    const result = await harness.service.listOrders(
      harness.currentCustomer("customer_a"),
      { orderStatus: OrderStatus.COMPLETED }
    );
    expect(result.items.map((item) => item.orderNo)).toEqual(["COMPLETED"]);
    expect(result.total).toBe(1);
  });

  it("warns without customer PII when the non-terminal working set exceeds 100", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const harness = createPortalBillingHarness();
    harness.orders.splice(
      0,
      harness.orders.length,
      ...Array.from({ length: 101 }, (_, index) =>
        makeOrder({ id: `active-${index}`, orderNo: `ACTIVE-${index}` })
      )
    );

    await harness.service.listOrders(harness.currentCustomer("customer_a"), { page: 1, pageSize: 20 });

    expect(warn).toHaveBeenCalledWith({
      errorCode: "PORTAL_ORDER_ACTIVE_SET_LARGE",
      nonTerminalCount: 101,
      page: 1,
      pageSize: 20
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("13800000000");
    warn.mockRestore();
  });

  it("returns only bills owned by the current customer and marks payable bills", async () => {
    const harness = createPortalBillingHarness();

    const result = await harness.service.listBills(harness.currentCustomer("customer_a"), {});

    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.billNo)).toEqual(["BIL-A1", "BIL-A2"]);
    expect(result.items.find((item) => item.billNo === "BIL-A1")?.canPay).toBe(true);
    expect(result.items.find((item) => item.billNo === "BIL-A2")?.canPay).toBe(false);
  });

  it("sorts bills by business status before due date across pages", async () => {
    const harness = createPortalBillingHarness();
    harness.bills.splice(
      0,
      harness.bills.length,
      makeBill({ id: "paid", billNo: "PAID", billStatus: BillStatus.PAID, dueDate: new Date("2026-06-01T00:00:00Z"), remainingAmount: 0n }),
      makeBill({ id: "pending", billNo: "PENDING", billStatus: BillStatus.PENDING, dueDate: new Date("2026-06-20T00:00:00Z") }),
      makeBill({ id: "partial", billNo: "PARTIAL", billStatus: BillStatus.PARTIALLY_PAID, dueDate: new Date("2026-06-19T00:00:00Z"), paidAmount: 1n }),
      makeBill({ id: "overdue-new", billNo: "OVERDUE-NEW", billStatus: BillStatus.OVERDUE, dueDate: new Date("2026-06-10T00:00:00Z") }),
      makeBill({ id: "overdue-old", billNo: "OVERDUE-OLD", billStatus: BillStatus.OVERDUE, dueDate: new Date("2026-06-05T00:00:00Z") }),
      makeBill({ id: "cancelled", billNo: "CANCELLED", billStatus: BillStatus.CANCELLED, dueDate: new Date("2026-05-01T00:00:00Z"), remainingAmount: 0n })
    );

    const first = await harness.service.listBills(
      harness.currentCustomer("customer_a"),
      { page: 1, pageSize: 3 }
    );
    const second = await harness.service.listBills(
      harness.currentCustomer("customer_a"),
      { page: 2, pageSize: 3 }
    );

    expect(first.items.map((item) => item.billNo)).toEqual([
      "OVERDUE-OLD",
      "OVERDUE-NEW",
      "PARTIAL"
    ]);
    expect(second.items.map((item) => item.billNo)).toEqual([
      "PENDING",
      "PAID",
      "CANCELLED"
    ]);
    expect(first.total).toBe(6);
  });

  it("keeps a bill status filter and only sorts inside that status", async () => {
    const harness = createPortalBillingHarness();
    harness.bills.splice(
      0,
      harness.bills.length,
      makeBill({ id: "pending-late", billNo: "LATE", dueDate: new Date("2026-06-22T00:00:00Z") }),
      makeBill({ id: "pending-soon", billNo: "SOON", dueDate: new Date("2026-06-20T00:00:00Z") }),
      makeBill({ id: "paid", billNo: "PAID", billStatus: BillStatus.PAID, remainingAmount: 0n })
    );

    const result = await harness.service.listBills(
      harness.currentCustomer("customer_a"),
      { billStatus: BillStatus.PENDING }
    );

    expect(result.items.map((item) => item.billNo)).toEqual(["SOON", "LATE"]);
    expect(result.total).toBe(2);
  });

  it("rejects bill detail access for another customer's bill", async () => {
    const harness = createPortalBillingHarness();

    await expect(
      harness.service.getBill("bill_b1", harness.currentCustomer("customer_a"))
    ).rejects.toThrow("账单不存在或不属于当前客户");
  });

  it("summarizes only the current customer's deposit ledgers", async () => {
    const harness = createPortalBillingHarness();

    const result = await harness.service.getDepositOverview(harness.currentCustomer("customer_a"));

    expect(result.totalCollectedAmount).toBe(100000);
    expect(result.totalDeductedAmount).toBe(20000);
    expect(result.availableAmount).toBe(80000);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.orderNo).toBe("ORD-A");
  });

  it("serializes order detail when no confirmed deposit ledger exists", async () => {
    const harness = createPortalBillingHarness({ ledgers: [] });

    const result = await harness.service.getOrder("order_a", harness.currentCustomer("customer_a"));

    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.depositSummary).toEqual(
      expect.objectContaining({
        collectedAmount: 0,
        deductedAmount: 0,
        frozenAmount: 0,
        refundedAmount: 0,
        remainingAmount: 0,
        status: "NONE"
      })
    );
  });

  it("points an active customer to the current mileage review when submission is due", async () => {
    const harness = createPortalBillingHarness();
    const order = harness.orders[0]!;
    order.orderStatus = OrderStatus.ACTIVE;
    order.receivableBills = [];
    order.mileageReviews = [
      {
        cycleNo: 1,
        dueAt: new Date("2026-08-03T04:00:00.000Z"),
        id: "review_a1",
        lockVersion: 0,
        overMileageBillId: null,
        scheduledReviewAt: new Date("2026-08-02T04:00:00.000Z"),
        status: OrderMileageReviewStatus.PENDING_SUBMISSION
      }
    ];

    const result = await harness.service.getOrder("order_a", harness.currentCustomer("customer_a"));

    expect(result).toMatchObject({
      mileageReviewSummary: {
        actionUrl: "/portal/mileage-reviews/review_a1",
        currentReviewId: "review_a1",
        cycleNo: 1,
        hasAction: true,
        status: OrderMileageReviewStatus.PENDING_SUBMISSION
      },
      nextAction: "SUBMIT_MILEAGE_REVIEW",
      nextActionTarget: {
        label: "提交里程复核",
        url: "/portal/mileage-reviews/review_a1"
      }
    });
  });

  it("keeps a payable monthly-rent bill ahead of an overdue mileage submission", async () => {
    const harness = createPortalBillingHarness();
    const order = harness.orders[0]!;
    order.orderStatus = OrderStatus.ACTIVE;
    order.mileageReviews = [
      {
        cycleNo: 1,
        dueAt: new Date("2026-08-01T04:00:00.000Z"),
        id: "review_a1",
        lockVersion: 0,
        overMileageBillId: null,
        scheduledReviewAt: new Date("2026-07-31T04:00:00.000Z"),
        status: OrderMileageReviewStatus.PENDING_SUBMISSION
      }
    ];

    const result = await harness.service.getOrder("order_a", harness.currentCustomer("customer_a"));

    expect(result).toMatchObject({
      mileageReviewSummary: {
        currentReviewId: "review_a1",
        hasAction: true
      },
      nextAction: "PAY_BILL",
      nextActionTarget: null
    });
  });

  it("lists only the current customer's entitlement grants and usage records", async () => {
    const harness = createPortalBillingHarness();

    const grants = await harness.service.listEntitlements(
      harness.currentCustomer("customer_a"),
      {}
    );
    const usages = await harness.service.listEntitlementUsages(
      harness.currentCustomer("customer_a"),
      {}
    );

    expect(grants.total).toBe(2);
    expect(grants.items.map((item) => item.orderNo)).toEqual(["ORD-A", "ORD-A"]);
    expect(grants.items.find((item) => item.unit === "TEXT")?.remainingAmount).toBeNull();
    expect(usages.total).toBe(1);
    expect(usages.items[0]?.orderNo).toBe("ORD-A");
  });
});

function createPortalBillingHarness(overrides: { ledgers?: AnyRecord[] } = {}) {
  const now = new Date("2026-06-18T00:00:00Z");
  const orders = [
    makeOrder({
      customerId: "customer_a",
      id: "order_a",
      orderNo: "ORD-A"
    }),
    makeOrder({
      customerId: "customer_b",
      id: "order_b",
      orderNo: "ORD-B"
    })
  ];
  const bills = [
    makeBill({ billNo: "BIL-A1", id: "bill_a1", orderId: "order_a", remainingAmount: 1000n }),
    makeBill({
      billNo: "BIL-A2",
      billStatus: BillStatus.PAID,
      id: "bill_a2",
      orderId: "order_a",
      paidAmount: 2000n,
      remainingAmount: 0n
    }),
    makeBill({
      billNo: "BIL-B1",
      customerId: "customer_b",
      id: "bill_b1",
      orderId: "order_b",
      remainingAmount: 3000n
    })
  ];
  const ledgers = overrides.ledgers ?? [
    makeDepositLedger({
      amount: 100000n,
      balanceAfter: 100000n,
      id: "ledger_a1",
      orderId: "order_a",
      transactionType: DepositTransactionType.COLLECT
    }),
    makeDepositLedger({
      amount: 20000n,
      balanceAfter: 80000n,
      id: "ledger_a2",
      orderId: "order_a",
      transactionType: DepositTransactionType.DEDUCT
    }),
    makeDepositLedger({
      amount: 99999n,
      balanceAfter: 99999n,
      customerId: "customer_b",
      id: "ledger_b1",
      orderId: "order_b",
      transactionType: DepositTransactionType.COLLECT
    })
  ];
  const usages = [
    makeUsage({ id: "usage_a1", orderId: "order_a" }),
    makeUsage({ customerId: "customer_b", grantId: "grant_b1", id: "usage_b1", orderId: "order_b" })
  ];
  const grants = [
    makeGrant({ id: "grant_a1", orderId: "order_a", usages: [usages[0]!] }),
    makeGrant({
      id: "grant_a2",
      orderId: "order_a",
      totalAmount: null,
      remainingAmount: null,
      unit: EntitlementUnit.TEXT
    }),
    makeGrant({
      customerId: "customer_b",
      id: "grant_b1",
      orderId: "order_b",
      usages: [usages[1]!]
    })
  ];

  attachRelations(orders, bills, grants);

  const prisma: AnyRecord = {
    $transaction: vi.fn(async (callback: (tx: AnyRecord) => unknown) => callback(prisma)),
    depositLedger: {
      count: vi.fn(
        async ({ where }: AnyRecord) => ledgers.filter((item) => matches(item, where)).length
      ),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        ledgers.filter((item) => matches(item, where)).map((item) => includeOrder(item, orders))
      )
    },
    orderEntitlementGrant: {
      count: vi.fn(
        async ({ where }: AnyRecord) => grants.filter((item) => matches(item, where)).length
      ),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        grants.filter((item) => matches(item, where)).map((item) => includeOrder(item, orders))
      )
    },
    orderEntitlementUsage: {
      count: vi.fn(
        async ({ where }: AnyRecord) => usages.filter((item) => matches(item, where)).length
      ),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        usages
          .filter((item) => matches(item, where))
          .map((item) => ({
            ...includeOrder(item, orders),
            grant: {
              entitlementName: "月度洗车",
              grantNo: "EG-A1",
              id: item.grantId
            }
          }))
      )
    },
    receivableBill: {
      count: vi.fn(
        async ({ where }: AnyRecord) => bills.filter((item) => matches(item, where)).length
      ),
      findFirst: vi.fn(async ({ where }: AnyRecord) => {
        const bill = bills.find((item) => matches(item, where));
        return bill ? includeBillDetail(bill, orders) : null;
      }),
      findMany: vi.fn(async ({ orderBy, skip = 0, take, where }: AnyRecord) => {
        const rows = bills
          .filter((item) => matches(item, where))
          .map((item) => includeOrder(item, orders));
        const sorted = applyOrderBy(rows, orderBy);
        return sorted.slice(skip, take === undefined ? undefined : skip + take);
      })
    },
    subscriptionOrder: {
      count: vi.fn(
        async ({ where }: AnyRecord) => orders.filter((item) => matches(item, where)).length
      ),
      findFirst: vi.fn(
        async ({ where }: AnyRecord) => orders.find((item) => matches(item, where)) ?? null
      ),
      findMany: vi.fn(async ({ orderBy, skip = 0, take, where }: AnyRecord) => {
        const sorted = applyOrderBy(orders.filter((item) => matches(item, where)), orderBy);
        return sorted.slice(skip, take === undefined ? undefined : skip + take);
      })
    }
  };

  return {
    bills,
    currentCustomer(customerId: string) {
      return {
        accountStatus: "ACTIVE",
        customerAccountId: `${customerId}_account`,
        customerId,
        phone: "13800000000"
      } as never;
    },
    now,
    orders,
    service: new PortalBillingService(prisma as never)
  };
}

function makeOrder(input: Partial<AnyRecord>): AnyRecord {
  const customerId = input.customerId ?? "customer_a";
  return {
    actualDeliveryAt: null,
    actualReturnAt: null,
    contract: input.contract === undefined ? {
      contractNo: `CON-${input.orderNo ?? "A"}`,
      createdAt: new Date("2026-06-17T00:00:00Z"),
      esignTasks: [],
      id: `contract_${input.id ?? "a"}`,
      signedAt: new Date("2026-06-17T01:00:00Z"),
      status: ContractStatus.SIGNED
    } : input.contract,
    contracts: input.contracts ?? [],
    createdAt: input.createdAt ?? new Date("2026-06-16T00:00:00Z"),
    customerId,
    customerSelectedSnapshot: null,
    deletedAt: null,
    deliveries: [],
    endDate: null,
    entitlementGrants: [],
    finalPlanSnapshot: { subscriptionPlan: { planName: "安心订阅套餐" } },
    id: input.id ?? "order_a",
    legacyVehicleModelSnapshot: input.legacyVehicleModelSnapshot ?? TEST_MODEL_CODES.ET5,
    legacyVehicleModelCodeSnapshot: input.legacyVehicleModelCodeSnapshot ?? TEST_MODEL_CODES.ET5,
    mileageLimitKm: 1500,
    mileageReviews: input.mileageReviews ?? [],
    modelDefinitionIdSnapshot: input.modelDefinitionIdSnapshot ?? "model-et5",
    modelDisplayNameSnapshot: input.modelDisplayNameSnapshot ?? "Frozen Portal ET5",
    monthlyFeeAmount: 39900n,
    orderNo: input.orderNo ?? "ORD-A",
    orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
    orderStatus: input.orderStatus ?? OrderStatus.PENDING_PAYMENT,
    overMileageFeeAmount: 120n,
    periodMonths: 12,
    productVersion: {
      product: {
        id: "product_1",
        name: "纯电订阅",
        productNo: "PROD-1"
      }
    },
    quoteSnapshot: {},
    receivableBills: input.receivableBills ?? [],
    startDate: null,
    vehicleModel: input.vehicleModel ?? TEST_MODEL_CODES.ET5,
    updatedAt: input.updatedAt ?? new Date("2026-06-18T00:00:00Z"),
    vehicle: {
      assetLocation: "上海",
      batteryCapacityKwh: new Prisma.Decimal(75),
      batteryUsageType: "BUYOUT",
      brand: "Tesla",
      currentMileageKm: 12000,
      id: "vehicle_1",
      model: "Model 3",
      modelYear: 2024,
      series: "Model 3",
      vehicleModel: "SEDAN"
    }
  };
}

function makeBill(input: Partial<AnyRecord>) {
  const orderId = input.orderId ?? "order_a";
  const customerId = input.customerId ?? (orderId === "order_b" ? "customer_b" : "customer_a");
  const remainingAmount = input.remainingAmount ?? 1000n;
  const paidAmount = input.paidAmount ?? 0n;
  return {
    amount: input.amount ?? remainingAmount + paidAmount,
    billNo: input.billNo ?? "BIL-A1",
    billPeriodEnd: null,
    billPeriodStart: null,
    billStatus: input.billStatus ?? BillStatus.PENDING,
    billType: input.billType ?? BillType.MONTHLY_RENT,
    customerId,
    createdAt: input.createdAt ?? new Date("2026-06-18T00:00:00Z"),
    deletedAt: null,
    dueDate: input.dueDate ?? new Date("2026-06-20T00:00:00Z"),
    id: input.id ?? "bill_a1",
    orderId,
    paidAmount,
    paymentOrderItems: [],
    remainingAmount,
    updatedAt: input.updatedAt ?? new Date("2026-06-18T00:00:00Z"),
    writeOffs: []
  };
}

function makeDepositLedger(input: Partial<AnyRecord>) {
  const orderId = input.orderId ?? "order_a";
  return {
    amount: input.amount ?? 1000n,
    balanceAfter: input.balanceAfter ?? input.amount ?? 1000n,
    createdAt: new Date("2026-06-18T00:00:00Z"),
    customerId: input.customerId ?? (orderId === "order_b" ? "customer_b" : "customer_a"),
    deletedAt: null,
    id: input.id ?? "ledger_a1",
    occurredAt: new Date("2026-06-18T00:00:00Z"),
    orderId,
    remark: null,
    transactionStatus: input.transactionStatus ?? DepositTransactionStatus.CONFIRMED,
    transactionType: input.transactionType ?? DepositTransactionType.COLLECT
  };
}

function makeGrant(input: Partial<AnyRecord>) {
  const orderId = input.orderId ?? "order_a";
  const customerId = input.customerId ?? (orderId === "order_b" ? "customer_b" : "customer_a");
  return {
    createdAt: new Date("2026-06-18T00:00:00Z"),
    customerId,
    deletedAt: null,
    entitlementName: input.entitlementName ?? "月度洗车",
    entitlementType: input.entitlementType ?? EntitlementType.BENEFIT,
    grantNo: input.grantNo ?? "EG-A1",
    grantPeriodEnd: null,
    grantPeriodStart: new Date("2026-06-18T00:00:00Z"),
    grantSource: input.grantSource ?? EntitlementGrantSource.ORDER_START,
    id: input.id ?? "grant_a1",
    orderId,
    remainingAmount:
      input.remainingAmount === undefined ? new Prisma.Decimal(2) : input.remainingAmount,
    remark: input.remark ?? null,
    status: input.status ?? EntitlementGrantStatus.ACTIVE,
    totalAmount: input.totalAmount === undefined ? new Prisma.Decimal(2) : input.totalAmount,
    unit: input.unit ?? EntitlementUnit.TIMES,
    usages: input.usages ?? [],
    usedAmount: input.usedAmount === undefined ? new Prisma.Decimal(0) : input.usedAmount
  };
}

function makeUsage(input: Partial<AnyRecord>) {
  const orderId = input.orderId ?? "order_a";
  const customerId = input.customerId ?? (orderId === "order_b" ? "customer_b" : "customer_a");
  return {
    customerId,
    deletedAt: null,
    entitlementName: "月度洗车",
    entitlementType: EntitlementType.BENEFIT,
    externalRefNo: null,
    grantId: input.grantId ?? "grant_a1",
    id: input.id ?? "usage_a1",
    occurredAt: new Date("2026-06-18T00:00:00Z"),
    orderId,
    remark: null,
    unit: EntitlementUnit.TIMES,
    usageNo: input.usageNo ?? "EU-A1",
    usageSource: EntitlementUsageSource.MANUAL,
    usageStatus: EntitlementUsageStatus.CONFIRMED,
    usedAmount: new Prisma.Decimal(1)
  };
}

function attachRelations(orders: AnyRecord[], bills: AnyRecord[], grants: AnyRecord[]) {
  for (const order of orders) {
    order.receivableBills = bills.filter((bill) => bill.orderId === order.id);
    order.entitlementGrants = grants.filter((grant) => grant.orderId === order.id);
  }
}

function includeOrder<T extends AnyRecord>(item: T, orders: AnyRecord[]) {
  const order = orders.find((candidate) => candidate.id === item.orderId);
  return {
    ...item,
    order: {
      id: order?.id,
      orderNo: order?.orderNo,
      orderStatus: order?.orderStatus
    }
  };
}

function includeBillDetail(bill: AnyRecord, orders: AnyRecord[]) {
  return {
    ...includeOrder(bill, orders),
    paymentOrderItems: [],
    writeOffs: []
  };
}

function matches(item: AnyRecord, where: AnyRecord = {}) {
  if (where.deletedAt === null && item.deletedAt !== null) {
    return false;
  }
  if (where.customerId && item.customerId !== where.customerId) {
    return false;
  }
  if (where.id && item.id !== where.id) {
    return false;
  }
  if (where.orderId && item.orderId !== where.orderId) {
    return false;
  }
  if (typeof where.orderStatus === "string" && item.orderStatus !== where.orderStatus) {
    return false;
  }
  if (where.orderStatus?.in && !where.orderStatus.in.includes(item.orderStatus)) {
    return false;
  }
  if (where.orderStatus?.notIn && where.orderStatus.notIn.includes(item.orderStatus)) {
    return false;
  }
  if (where.billStatus && item.billStatus !== where.billStatus) {
    return false;
  }
  if (where.billType && item.billType !== where.billType) {
    return false;
  }
  if (where.transactionStatus && item.transactionStatus !== where.transactionStatus) {
    return false;
  }
  if (where.transactionType && item.transactionType !== where.transactionType) {
    return false;
  }
  if (where.status && item.status !== where.status) {
    return false;
  }
  if (where.grantId && item.grantId !== where.grantId) {
    return false;
  }
  return true;
}

function applyOrderBy(items: AnyRecord[], orderBy: AnyRecord | AnyRecord[] | undefined) {
  const entries = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...items].sort((left, right) => {
    for (const entry of entries) {
      const [field, direction] = Object.entries(entry)[0] ?? [];
      if (!field || (direction !== "asc" && direction !== "desc")) {
        continue;
      }
      const leftValue = comparable(left[field]);
      const rightValue = comparable(right[field]);
      if (leftValue < rightValue) return direction === "asc" ? -1 : 1;
      if (leftValue > rightValue) return direction === "asc" ? 1 : -1;
    }
    return 0;
  });
}

function comparable(value: unknown): number | string {
  return value instanceof Date ? value.getTime() : String(value ?? "");
}

// The fake Prisma harness deliberately accepts loosely-shaped query/data objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
