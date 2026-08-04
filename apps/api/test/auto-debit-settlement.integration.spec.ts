import {
  BillStatus,
  DebitAttemptStatus,
  DebitRetrySlot,
  PaymentChannel,
  PaymentOrderStatus,
  PaymentProviderType,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType
} from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../src/audit/audit.service";
import { FinanceService } from "../src/finance/finance.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://subscription:subscription@127.0.0.1:5432/subscription_saas?schema=public";

describe("auto debit atomic settlement PostgreSQL integration", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({
        DATABASE_POOL_MAX: "5",
        DATABASE_URL: TEST_DATABASE_URL
      })
    );
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("settles one bill once and preserves the later channel receipt as unallocated", async () => {
    const ids = {
      application: randomUUID(),
      attempt: randomUUID(),
      bill: randomUUID(),
      customer: randomUUID(),
      order: randomUUID(),
      mandate: randomUUID(),
      paymentOrderA: randomUUID(),
      paymentOrderB: randomUUID(),
      quote: randomUUID(),
      vehicle: randomUUID()
    };
    const paymentOrderNoA = uniqueNo("PYOA");
    const paymentOrderNoB = uniqueNo("PYOB");
    const finance = new FinanceService(new AuditService(prisma), prisma);

    try {
      await seedSettlementFixture(prisma, ids, paymentOrderNoA, paymentOrderNoB);

      await Promise.all([
        finance.settlePaymentOrder({
          debitAttempt: {
            confirmedAmount: 1n,
            id: ids.attempt,
            providerTransactionId: `txn-${ids.paymentOrderA}`,
            resolvedAt: new Date("2026-08-05T01:00:00.000Z"),
            responseSnapshot: { status: "SUCCEEDED" }
          },
          operatorId: null,
          paidAmount: 1n,
          paidAt: new Date("2026-08-05T01:00:00.000Z"),
          paymentOrderId: ids.paymentOrderA,
          providerTransactionId: `txn-${ids.paymentOrderA}`
        }),
        finance.settlePaymentOrder({
          operatorId: null,
          paidAmount: 1n,
          paidAt: new Date("2026-08-05T01:00:01.000Z"),
          paymentOrderId: ids.paymentOrderB,
          providerTransactionId: `txn-${ids.paymentOrderB}`
        })
      ]);

      const [bill, attempt, paymentOrders, payments, writeOffs, jobs] = await Promise.all([
        prisma.receivableBill.findUniqueOrThrow({ where: { id: ids.bill } }),
        prisma.debitAttempt.findUniqueOrThrow({ where: { id: ids.attempt } }),
        prisma.paymentOrder.findMany({ where: { id: { in: [ids.paymentOrderA, ids.paymentOrderB] } } }),
        prisma.paymentRecord.findMany({ where: { orderId: ids.order } }),
        prisma.paymentWriteOff.findMany({ where: { billId: ids.bill } }),
        prisma.subscriptionAutomationJob.findMany({ where: { billId: ids.bill } })
      ]);
      expect(bill).toMatchObject({
        billStatus: BillStatus.PAID,
        paidAmount: 1n,
        remainingAmount: 0n
      });
      expect(attempt).toMatchObject({
        confirmedAmount: 1n,
        status: DebitAttemptStatus.SUCCEEDED
      });
      expect(paymentOrders).toHaveLength(2);
      expect(paymentOrders.every((item) => item.paymentStatus === PaymentOrderStatus.PAID)).toBe(true);
      expect(payments).toHaveLength(2);
      expect(writeOffs).toHaveLength(1);
      expect(writeOffs[0]?.writeOffAmount).toBe(1n);
      expect(
        payments.reduce((sum, item) => sum + item.paymentAmount, 0n) -
          writeOffs.reduce((sum, item) => sum + item.writeOffAmount, 0n)
      ).toBe(1n);
      expect(
        jobs.every((item) => item.jobStatus === SubscriptionAutomationJobStatus.CANCELLED)
      ).toBe(true);

      await finance.settlePaymentOrder({
        operatorId: null,
        paidAmount: 1n,
        paidAt: new Date("2026-08-05T01:00:02.000Z"),
        paymentOrderId: ids.paymentOrderA,
        providerTransactionId: `txn-${ids.paymentOrderA}`
      });
      await expect(
        prisma.paymentRecord.count({ where: { orderId: ids.order } })
      ).resolves.toBe(2);
      await expect(
        prisma.paymentWriteOff.count({ where: { billId: ids.bill } })
      ).resolves.toBe(1);
    } finally {
      await cleanupSettlementFixture(prisma, ids);
    }
  });
});

async function seedSettlementFixture(
  prisma: PrismaService,
  ids: {
    application: string;
    attempt: string;
    bill: string;
    customer: string;
    order: string;
    mandate: string;
    paymentOrderA: string;
    paymentOrderB: string;
    quote: string;
    vehicle: string;
  },
  paymentOrderNoA: string,
  paymentOrderNoB: string
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`
      INSERT INTO "customer" (
        "id", "customer_no", "name", "mobile", "status", "created_at", "updated_at"
      ) VALUES (
        ${ids.customer}::uuid, ${uniqueNo("CUS")}, 'Settlement integration',
        ${`139${ids.customer.replaceAll("-", "").slice(0, 8)}`}, 'ACTIVE',
        clock_timestamp(), clock_timestamp()
      )
    `;
    await tx.$executeRaw`
      INSERT INTO "subscription_order" (
        "id", "order_no", "customer_id", "application_id", "quote_id",
        "vehicle_id", "product_id", "product_version_id",
        "vehicle_purchase_price_amount", "monthly_fee_amount", "deposit_amount",
        "period_months", "mileage_limit_km", "over_mileage_fee_amount",
        "model_definition_id_snapshot", "model_code_snapshot",
        "model_display_name_snapshot", "quote_snapshot", "order_status",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.order}::uuid, ${uniqueNo("ORD")}, ${ids.customer}::uuid,
        ${ids.application}::uuid, ${ids.quote}::uuid, ${ids.vehicle}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        20000000, 1, 0, 12, 1500, 100, ${randomUUID()}::uuid,
        'NIO_ET5_2024', 'NIO ET5', '{}'::jsonb, 'ACTIVE',
        clock_timestamp(), clock_timestamp()
      )
    `;
    await tx.receivableBill.create({
      data: {
        amount: 1n,
        billNo: uniqueNo("BIL"),
        billStatus: BillStatus.PENDING,
        billType: "MONTHLY_RENT",
        customerId: ids.customer,
        dueDate: new Date("2026-08-05T00:00:00.000Z"),
        id: ids.bill,
        orderId: ids.order,
        paidAmount: 0n,
        remainingAmount: 1n
      }
    });
    for (const [id, paymentOrderNo] of [
      [ids.paymentOrderA, paymentOrderNoA],
      [ids.paymentOrderB, paymentOrderNoB]
    ] as const) {
      await tx.paymentOrder.create({
        data: {
          amount: 1n,
          customerId: ids.customer,
          id,
          items: { create: { amount: 1n, billId: ids.bill } },
          orderId: ids.order,
          paidAmount: 0n,
          paymentChannel: PaymentChannel.MOCK,
          paymentOrderNo,
          paymentStatus: PaymentOrderStatus.PENDING,
          provider: PaymentProviderType.MOCK,
          providerTradeNo: `trade-${id}`
        }
      });
    }
    await tx.paymentMandate.create({
      data: {
        customerId: ids.customer,
        id: ids.mandate,
        mandateNo: uniqueNo("MDT"),
        orderId: ids.order,
        provider: PaymentProviderType.MOCK,
        providerMandateId: `mandate-${ids.mandate}`,
        providerMode: "mock",
        status: "ACTIVE"
      }
    });
    await tx.debitAttempt.create({
      data: {
        billId: ids.bill,
        customerId: ids.customer,
        debitAttemptNo: uniqueNo("DBT"),
        id: ids.attempt,
        idempotencyKey: `debit:${ids.bill}:DUE`,
        mandateId: ids.mandate,
        orderId: ids.order,
        paymentOrderId: ids.paymentOrderA,
        providerOutTradeNo: `trade-${ids.paymentOrderA}`,
        requestedAmount: 1n,
        retrySlot: DebitRetrySlot.DUE,
        status: DebitAttemptStatus.UNKNOWN
      }
    });
    for (const [index, jobType] of [
      SubscriptionAutomationJobType.SEND_BILL_DUE_NOTICE,
      SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
      SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT
    ].entries()) {
      await tx.subscriptionAutomationJob.create({
        data: {
          billId: ids.bill,
          idempotencyKey: `settlement:${ids.bill}:${index}`,
          jobType,
          orderId: ids.order
        }
      });
    }
  });
}

async function cleanupSettlementFixture(
  prisma: PrismaService,
  ids: {
    bill: string;
    customer: string;
    mandate: string;
    order: string;
    paymentOrderA: string;
    paymentOrderB: string;
  }
) {
  const paymentOrderIds = [ids.paymentOrderA, ids.paymentOrderB];
  const payments = await prisma.paymentRecord.findMany({
    select: { id: true },
    where: { orderId: ids.order }
  });
  const writeOffs = await prisma.paymentWriteOff.findMany({
    select: { id: true },
    where: { paymentId: { in: payments.map((item) => item.id) } }
  });
  await prisma.paymentCallbackLog.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.debitAttempt.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.paymentOrderItem.deleteMany({ where: { paymentOrderId: { in: paymentOrderIds } } });
  await prisma.paymentOrder.deleteMany({ where: { id: { in: paymentOrderIds } } });
  await prisma.paymentWriteOff.deleteMany({ where: { paymentId: { in: payments.map((item) => item.id) } } });
  await prisma.paymentRecord.deleteMany({ where: { id: { in: payments.map((item) => item.id) } } });
  await prisma.paymentMandate.deleteMany({ where: { id: ids.mandate } });
  await prisma.subscriptionAutomationJob.deleteMany({ where: { billId: ids.bill } });
  await prisma.receivableBill.deleteMany({ where: { id: ids.bill } });
  await prisma.auditLog.deleteMany({
    where: {
      entityId: {
        in: [
          ...paymentOrderIds,
          ...payments.map((item) => item.id),
          ...writeOffs.map((item) => item.id),
          ids.bill
        ]
      }
    }
  });
  await prisma.subscriptionOrder.deleteMany({ where: { id: ids.order } });
  await prisma.customer.deleteMany({ where: { id: ids.customer } });
}

function uniqueNo(prefix: string) {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
