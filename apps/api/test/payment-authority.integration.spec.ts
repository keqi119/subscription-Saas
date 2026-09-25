import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { FinanceService } from "../src/finance/finance.service";
import { MockPaymentProvider } from "../src/payment/mock-payment.provider";
import type { PaymentProvider } from "../src/payment/payment-provider";
import { PaymentOrderService } from "../src/payment/payment-order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const database = requiredReleaseDatabaseTestContext(
  "apps/api/test/payment-authority.integration.spec.ts"
);

describe("active payment authority PostgreSQL integration", () => {
  let prisma: PrismaService;
  let audit: AuditService;
  let config: ConfigService;
  let service: PaymentOrderService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_POOL_MAX: "10", DATABASE_URL: database.databaseUrl })
    );
    await prisma.onModuleInit();
    config = new ConfigService({
      APP_ENV: "test",
      PAYMENT_DEFAULT_CHANNEL: "MOCK",
      PAYMENT_MOCK_ENABLED: "true",
      PAYMENT_PROVIDER: "mock",
      WECHAT_PAY_ENABLED: "false"
    });
    audit = new AuditService(prisma);
    service = paymentService();
  });
  afterAll(async () => prisma?.onModuleDestroy());

  function paymentService(
    client = prisma,
    financeClient = prisma,
    provider: PaymentProvider = new MockPaymentProvider(config)
  ) {
    return new PaymentOrderService(
      audit,
      config,
      new FinanceService(audit, financeClient),
      provider,
      {} as never,
      client
    );
  }

  async function withFixture(label: string, run: (fixture: PaymentFixture) => Promise<void>) {
    const fixture = await seedPaymentFixture(prisma, label);
    try {
      await run(fixture);
    } finally {
      await deletePaymentFixture(prisma, fixture);
    }
  }

  function callback(fixture: PaymentFixture, paidAmount = 1000) {
    return {
      eventType: "mock.payment.success",
      paidAmount,
      providerTradeNo: fixture.providerTradeNo,
      providerTransactionId: `${fixture.providerTradeNo}:${paidAmount}`
    };
  }

  async function expectNoMoney(fixture: PaymentFixture) {
    expect(await prisma.paymentRecord.count({ where: { orderId: fixture.orderId } })).toBe(0);
    expect(await prisma.paymentWriteOff.count({ where: { orderId: fixture.orderId } })).toBe(0);
    expect(
      await prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.billId } })
    ).toMatchObject({ billStatus: "PENDING", paidAmount: 0n, remainingAmount: 1000n });
  }

  async function expectSettled(fixture: PaymentFixture, handledCallbacks: number) {
    const payment = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: fixture.paymentOrderId }
    });
    const records = await prisma.paymentRecord.findMany({ where: { orderId: fixture.orderId } });
    const allocations = await prisma.paymentWriteOff.findMany({
      where: { orderId: fixture.orderId }
    });
    expect(payment).toMatchObject({
      paymentStatus: "PAID",
      paidAmount: 1000n,
      providerTransactionId: callback(fixture).providerTransactionId
    });
    expect(records).toHaveLength(1);
    expect(payment.paymentRecordId).toBe(records[0]!.id);
    expect(records[0]).toMatchObject({ paymentStatus: "CONFIRMED", paymentAmount: 1000n });
    expect(allocations).toEqual([
      expect.objectContaining({
        billId: fixture.billId,
        paymentId: records[0]!.id,
        writeOffAmount: 1000n
      })
    ]);
    expect(
      await prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.billId } })
    ).toMatchObject({ billStatus: "PAID", paidAmount: 1000n, remainingAmount: 0n });
    expect(
      await prisma.paymentCallbackLog.count({
        where: { paymentOrderId: fixture.paymentOrderId, handled: true, verified: true }
      })
    ).toBe(handledCallbacks);
    expect(
      await prisma.auditLog.count({
        where: {
          module: "payment",
          entityId: { in: [payment.id, records[0]!.id, allocations[0]!.id] },
          entityType: { in: ["payment_order", "payment_record", "payment_write_off"] }
        }
      })
    ).toBe(3);
  }

  async function expectRejectedCallback(fixture: PaymentFixture) {
    expect(
      await prisma.paymentCallbackLog.findFirstOrThrow({
        where: {
          providerTradeNo: fixture.providerTradeNo,
          providerTransactionId: callback(fixture, 400).providerTransactionId
        }
      })
    ).toMatchObject({
      paymentOrderId: fixture.paymentOrderId,
      verified: true,
      handled: false,
      errorMessage: "支付金额与支付单金额不一致。"
    });
  }

  it("keeps a partial callback outside payment, receipt, allocation and bill authority", () =>
    withFixture("PARTIAL", async (fixture) => {
      const before = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: fixture.paymentOrderId }
      });
      await expect(service.handleCallback("mock", callback(fixture, 400))).rejects.toThrow(
        "支付金额与支付单金额不一致。"
      );
      const after = await prisma.paymentOrder.findUniqueOrThrow({
        where: { id: fixture.paymentOrderId }
      });
      expect(after).toMatchObject({
        paymentStatus: "PENDING",
        paymentRecordId: null,
        errorSnapshot: before.errorSnapshot,
        updatedAt: before.updatedAt
      });
      await expectRejectedCallback(fixture);
      await expectNoMoney(fixture);
    }));

  it.each([false, true])(
    "preserves real settlement across wrong and correct callbacks (valid first: %s)",
    (validFirst) =>
      withFixture(`ORDER-${validFirst}`, async (fixture) => {
        if (validFirst) await service.handleCallback("mock", callback(fixture));
        await expect(service.handleCallback("mock", callback(fixture, 400))).rejects.toThrow(
          "支付金额与支付单金额不一致。"
        );
        if (!validFirst) await service.handleCallback("mock", callback(fixture));
        await expectRejectedCallback(fixture);
        await expectSettled(fixture, 1);
      })
  );

  it("cannot overwrite PAID from an incorrect callback holding an old PENDING read", () =>
    withFixture("STALE", async (fixture) => {
      const barrier = manualBarrier();
      const delegate = prisma.paymentOrder;
      const gated = Object.create(prisma) as PrismaService;
      Object.defineProperty(gated, "paymentOrder", {
        value: new Proxy(delegate, {
          get(target, key) {
            if (key === "findFirst")
              return async (args: Prisma.PaymentOrderFindFirstArgs) => {
                const result = await delegate.findFirst(args);
                // Provider lookup does not use id; pause only completePaymentOrder's actual authority read.
                if (args.where?.id === fixture.paymentOrderId) {
                  barrier.arrived();
                  await barrier.wait;
                }
                return result;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          }
        })
      });
      const wrong = paymentService(gated).handleCallback("mock", callback(fixture, 400));
      const rejected = expect(wrong).rejects.toThrow("支付金额与支付单金额不一致。");
      try {
        await barrier.entered;
        await service.handleCallback("mock", callback(fixture));
      } finally {
        barrier.release();
      }
      await rejected;
      await expectRejectedCallback(fixture);
      await expectSettled(fixture, 1);
    }));

  it("settles concurrent duplicate verified callbacks exactly once across all money facts", () =>
    withFixture("DUPLICATE", async (fixture) => {
      const enter = createTwoTransactionEntryBarrier();
      const concurrent = paymentService(prisma, withTransactionEntryBarrier(prisma, enter));
      const results = await Promise.all([
        concurrent.handleCallback("mock", callback(fixture)),
        concurrent.handleCallback("mock", callback(fixture))
      ]);
      expect(results.every((result) => result.handled && result.verified)).toBe(true);
      await expectSettled(fixture, 2);
    }));

  it.each(["unverified", "non-paid"])("does not enter finance for a %s callback", (mode) =>
    withFixture(mode, async (fixture) => {
      const provider = new MockPaymentProvider(config);
      if (mode === "unverified") {
        provider.verifyCallback = async () => ({
          ...callback(fixture),
          payload: callback(fixture),
          verified: false,
          errorMessage: "SYNTHETIC_INVALID_SIGNATURE"
        });
      }
      const payload = {
        ...callback(fixture),
        eventType: mode === "non-paid" ? "mock.payment.failed" : "mock.payment.success"
      };
      const result = await paymentService(prisma, prisma, provider).handleCallback("mock", payload);
      expect(result).toMatchObject({ handled: false, verified: mode !== "unverified" });
      await expectNoMoney(fixture);
      expect(
        await prisma.paymentOrder.findUniqueOrThrow({ where: { id: fixture.paymentOrderId } })
      ).toMatchObject({ paymentStatus: "PENDING", paidAmount: 0n });
    })
  );

  it("still settles a legal verified callback after the local payment order was closed", () =>
    withFixture("CLOSED", async (fixture) => {
      await prisma.paymentOrder.update({
        where: { id: fixture.paymentOrderId },
        data: { paymentStatus: "CLOSED" }
      });
      await service.handleCallback("mock", callback(fixture));
      await expectSettled(fixture, 1);
    }));
});

function manualBarrier() {
  let arrived!: () => void;
  let release!: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const entered = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("B5_STALE_READ_BARRIER_TIMEOUT")), 5000);
    arrived = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    entered,
    wait,
    release: () => {
      clearTimeout(timer);
      release();
    }
  };
}

function createTwoTransactionEntryBarrier() {
  const barrier = manualBarrier();
  let entered = 0;
  return async () => {
    if (++entered === 2) {
      barrier.arrived();
      barrier.release();
    }
    await barrier.entered;
  };
}

function withTransactionEntryBarrier(prisma: PrismaService, enter: () => Promise<void>) {
  const runTransaction = prisma.$transaction.bind(prisma);
  const gated = Object.create(prisma) as PrismaService;
  Object.defineProperty(gated, "$transaction", {
    value: ((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      runTransaction(async (tx) => {
        await enter();
        return callback(tx);
      })) as PrismaService["$transaction"]
  });
  return gated;
}

interface PaymentFixture {
  billId: string;
  orderId: string;
  paymentOrderId: string;
  providerTradeNo: string;
}

async function seedPaymentFixture(prisma: PrismaService, label: string): Promise<PaymentFixture> {
  const orderId = randomUUID();
  const billId = randomUUID();
  const paymentOrderId = randomUUID();
  const providerTradeNo = `b5-${label.toLowerCase()}-${randomUUID()}`;
  await prisma.$transaction(async (tx) => {
    const created = await insertRuntimeOrderGraph(tx, {
      label: `B5-PAYMENT-${label}`,
      orderId,
      vehicleId: null
    });
    await tx.receivableBill.create({
      data: {
        id: billId,
        amount: 1000n,
        billNo: `B5-BILL-${randomUUID()}`,
        billStatus: "PENDING",
        billType: "MONTHLY_RENT",
        customerId: created.customerId,
        dueDate: new Date("2026-09-01T00:00:00Z"),
        orderId,
        paidAmount: 0n,
        remainingAmount: 1000n,
        sourceKey: `b5-payment:${orderId}`
      }
    });
    await tx.paymentOrder.create({
      data: {
        id: paymentOrderId,
        amount: 1000n,
        customerId: created.customerId,
        items: { create: [{ amount: 1000n, billId }] },
        orderId,
        paymentChannel: "MOCK",
        paymentOrderNo: `B5-PYO-${randomUUID()}`,
        paymentStatus: "PENDING",
        provider: "MOCK",
        providerTradeNo
      }
    });
  });
  return { billId, orderId, paymentOrderId, providerTradeNo };
}

async function deletePaymentFixture(prisma: PrismaService, fixture: PaymentFixture) {
  const ids = (
    await prisma.paymentRecord.findMany({
      select: { id: true },
      where: { orderId: fixture.orderId }
    })
  ).map(({ id }) => id);
  await prisma.paymentCallbackLog.deleteMany({
    where: { providerTradeNo: fixture.providerTradeNo }
  });
  await prisma.paymentWriteOff.deleteMany({ where: { orderId: fixture.orderId } });
  await prisma.paymentOrderItem.deleteMany({ where: { paymentOrderId: fixture.paymentOrderId } });
  await prisma.paymentOrder.deleteMany({ where: { id: fixture.paymentOrderId } });
  await prisma.paymentRecord.deleteMany({ where: { id: { in: ids } } });
  await prisma.receivableBill.deleteMany({ where: { id: fixture.billId } });
}
