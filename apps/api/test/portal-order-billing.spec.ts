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
  OrderSource,
  OrderStatus,
  Prisma
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

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

  it("returns only bills owned by the current customer and marks payable bills", async () => {
    const harness = createPortalBillingHarness();

    const result = await harness.service.listBills(harness.currentCustomer("customer_a"), {});

    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.billNo)).toEqual(["BIL-A1", "BIL-A2"]);
    expect(result.items.find((item) => item.billNo === "BIL-A1")?.canPay).toBe(true);
    expect(result.items.find((item) => item.billNo === "BIL-A2")?.canPay).toBe(false);
  });

  it("rejects bill detail access for another customer's bill", async () => {
    const harness = createPortalBillingHarness();

    await expect(harness.service.getBill("bill_b1", harness.currentCustomer("customer_a"))).rejects.toThrow(
      "账单不存在或不属于当前客户"
    );
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

  it("lists only the current customer's entitlement grants and usage records", async () => {
    const harness = createPortalBillingHarness();

    const grants = await harness.service.listEntitlements(harness.currentCustomer("customer_a"), {});
    const usages = await harness.service.listEntitlementUsages(harness.currentCustomer("customer_a"), {});

    expect(grants.total).toBe(2);
    expect(grants.items.map((item) => item.orderNo)).toEqual(["ORD-A", "ORD-A"]);
    expect(grants.items.find((item) => item.unit === "TEXT")?.remainingAmount).toBeNull();
    expect(usages.total).toBe(1);
    expect(usages.items[0]?.orderNo).toBe("ORD-A");
  });
});

function createPortalBillingHarness() {
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
    makeBill({ billNo: "BIL-B1", customerId: "customer_b", id: "bill_b1", orderId: "order_b", remainingAmount: 3000n })
  ];
  const ledgers = [
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
    makeGrant({ id: "grant_a2", orderId: "order_a", totalAmount: null, remainingAmount: null, unit: EntitlementUnit.TEXT }),
    makeGrant({ customerId: "customer_b", id: "grant_b1", orderId: "order_b", usages: [usages[1]!] })
  ];

  attachRelations(orders, bills, grants);

  const prisma = {
    depositLedger: {
      count: vi.fn(async ({ where }: AnyRecord) => ledgers.filter((item) => matches(item, where)).length),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        ledgers.filter((item) => matches(item, where)).map((item) => includeOrder(item, orders))
      )
    },
    orderEntitlementGrant: {
      count: vi.fn(async ({ where }: AnyRecord) => grants.filter((item) => matches(item, where)).length),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        grants.filter((item) => matches(item, where)).map((item) => includeOrder(item, orders))
      )
    },
    orderEntitlementUsage: {
      count: vi.fn(async ({ where }: AnyRecord) => usages.filter((item) => matches(item, where)).length),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        usages.filter((item) => matches(item, where)).map((item) => ({
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
      count: vi.fn(async ({ where }: AnyRecord) => bills.filter((item) => matches(item, where)).length),
      findFirst: vi.fn(async ({ where }: AnyRecord) => {
        const bill = bills.find((item) => matches(item, where));
        return bill ? includeBillDetail(bill, orders) : null;
      }),
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        bills.filter((item) => matches(item, where)).map((item) => includeOrder(item, orders))
      )
    },
    subscriptionOrder: {
      count: vi.fn(async ({ where }: AnyRecord) => orders.filter((item) => matches(item, where)).length),
      findFirst: vi.fn(async ({ where }: AnyRecord) => orders.find((item) => matches(item, where)) ?? null),
      findMany: vi.fn(async ({ where }: AnyRecord) => orders.filter((item) => matches(item, where)))
    }
  };

  return {
    currentCustomer(customerId: string) {
      return {
        accountStatus: "ACTIVE",
        customerAccountId: `${customerId}_account`,
        customerId,
        phone: "13800000000"
      } as never;
    },
    now,
    service: new PortalBillingService(prisma as never)
  };
}

function makeOrder(input: Partial<AnyRecord>) {
  const customerId = input.customerId ?? "customer_a";
  return {
    actualDeliveryAt: null,
    actualReturnAt: null,
    contract: {
      contractNo: `CON-${input.orderNo ?? "A"}`,
      createdAt: new Date("2026-06-17T00:00:00Z"),
      id: `contract_${input.id ?? "a"}`,
      signedAt: new Date("2026-06-17T01:00:00Z"),
      status: ContractStatus.SIGNED
    },
    contracts: [],
    createdAt: new Date("2026-06-16T00:00:00Z"),
    customerId,
    customerSelectedSnapshot: null,
    deletedAt: null,
    deliveries: [],
    endDate: null,
    entitlementGrants: [],
    finalPlanSnapshot: { subscriptionPlan: { planName: "安心订阅套餐" } },
    id: input.id ?? "order_a",
    mileageLimitKm: 1500,
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
    receivableBills: [],
    startDate: null,
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
    deletedAt: null,
    dueDate: new Date("2026-06-20T00:00:00Z"),
    id: input.id ?? "bill_a1",
    orderId,
    paidAmount,
    paymentOrderItems: [],
    remainingAmount,
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
    remainingAmount: input.remainingAmount === undefined ? new Prisma.Decimal(2) : input.remainingAmount,
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

// The fake Prisma harness deliberately accepts loosely-shaped query/data objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
