import {
  BillStatus,
  BillType,
  PaymentChannel,
  PaymentOrderStatus,
  PaymentProviderType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { PaymentOrderService } from "../src/payment/payment-order.service";
import { MockPaymentProvider } from "../src/payment/mock-payment.provider";

describe("portal payment foundation", () => {
  it("lists only payable bills owned by the current customer", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_a", customerId: "customer_a", remainingAmount: 1000n });
    harness.addBill({ id: "bill_b", customerId: "customer_b", remainingAmount: 2000n });
    harness.addBill({ id: "bill_paid", billStatus: BillStatus.PAID, customerId: "customer_a", remainingAmount: 0n });

    const result = await harness.service.listPayableBills(harness.currentCustomer("customer_a"), {});

    expect(result).toHaveLength(1);
    expect(result[0]?.billId).toBe("bill_a");
    expect(result[0]?.remainingAmount).toBe(1000);
  });

  it("creates a pending mock payment order without creating finance records", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_deposit", billType: BillType.DEPOSIT, remainingAmount: 100000n });
    harness.addBill({ id: "bill_first_month", billType: BillType.FIRST_MONTHLY_FEE, remainingAmount: 39900n });

    const result = await harness.service.createPortalPaymentOrder(
      {
        billIds: ["bill_deposit", "bill_first_month"],
        paymentChannel: PaymentChannel.MOCK
      },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    expect(result.paymentStatus).toBe(PaymentOrderStatus.PENDING);
    expect(result.paymentChannel).toBe(PaymentChannel.MOCK);
    expect(result.amount).toBe(139900);
    expect(result.cashierUrl).toContain("/portal/payment-orders/");
    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
  });

  it("reuses the same open payment order for the same customer bills", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_deposit", remainingAmount: 100000n });
    harness.addBill({ id: "bill_first_month", remainingAmount: 39900n });
    const request = {
      billIds: ["bill_first_month", "bill_deposit"],
      paymentChannel: PaymentChannel.MOCK
    };

    const first = await harness.service.createPortalPaymentOrder(
      request,
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const second = await harness.service.createPortalPaymentOrder(
      { ...request, billIds: [...request.billIds].reverse() },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    expect(second.id).toBe(first.id);
    expect(harness.state.paymentOrders).toHaveLength(1);
  });

  it("rejects payment order creation with another customer's bill", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_other", customerId: "customer_b", remainingAmount: 1000n });

    await expect(
      harness.service.createPortalPaymentOrder(
        { billIds: ["bill_other"], paymentChannel: PaymentChannel.MOCK },
        harness.currentCustomer("customer_a"),
        harness.context
      )
    ).rejects.toThrow("账单不存在或不属于当前客户");
  });

  it("mock-pay creates PaymentRecord, writes off bills, and is idempotent", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_deposit", billType: BillType.DEPOSIT, remainingAmount: 100000n });
    harness.addBill({ id: "bill_first_month", billType: BillType.FIRST_MONTHLY_FEE, remainingAmount: 39900n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      {
        billIds: ["bill_deposit", "bill_first_month"],
        paymentChannel: PaymentChannel.MOCK
      },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    const paid = await harness.service.mockPay(paymentOrder.id, harness.currentCustomer("customer_a"), harness.context);
    const repeated = await harness.service.mockPay(paymentOrder.id, harness.currentCustomer("customer_a"), harness.context);

    expect(paid.paymentStatus).toBe(PaymentOrderStatus.PAID);
    expect(repeated.paymentStatus).toBe(PaymentOrderStatus.PAID);
    expect(harness.financeService.settlePaymentOrder).toHaveBeenCalledTimes(1);
    expect(harness.state.bills.find((bill) => bill.id === "bill_deposit")?.billStatus).toBe(BillStatus.PAID);
    expect(harness.state.bills.find((bill) => bill.id === "bill_first_month")?.remainingAmount).toBe(0n);
    expect(harness.state.depositLedgers).toHaveLength(1);
  });

  it("handles mock paid callbacks idempotently", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_monthly", billType: BillType.MONTHLY_RENT, remainingAmount: 29900n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_monthly"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    const payload = {
      eventType: "mock.payment.success",
      providerTradeNo: harness.state.paymentOrders.find(
        (item) => item.id === paymentOrder.id
      )?.providerTradeNo,
      providerTransactionId: "mock_txn_callback_1"
    };
    const first = await harness.service.handleCallback("mock", payload);
    const second = await harness.service.handleCallback("mock", payload);

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(true);
    expect(harness.financeService.settlePaymentOrder).toHaveBeenCalledTimes(1);
    expect(harness.state.callbacks.filter((callback) => callback.handled)).toHaveLength(2);
  });

  it("does not regress a paid order when a late non-paid callback arrives", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_monthly", remainingAmount: 29900n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_monthly"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const providerTradeNo = harness.state.paymentOrders.find(
      (item) => item.id === paymentOrder.id
    )?.providerTradeNo;

    await harness.service.handleCallback("mock", {
      eventType: "mock.payment.success",
      providerTradeNo,
      providerTransactionId: "mock_txn_callback_late_1"
    });
    const late = await harness.service.handleCallback("mock", {
      eventType: "mock.payment.failed",
      providerTradeNo,
      providerTransactionId: "mock_txn_callback_late_1"
    });

    expect(late).toMatchObject({ handled: false, verified: true });
    expect(
      harness.state.paymentOrders.find((item) => item.id === paymentOrder.id)
        ?.paymentStatus
    ).toBe(PaymentOrderStatus.PAID);
    expect(harness.financeService.settlePaymentOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects a callback route that does not match the configured provider before verification", async () => {
    const provider = {
      createPayment: vi.fn(),
      verifyCallback: vi.fn(async () => ({
        eventType: "TRANSACTION_SUCCESS",
        paidAmount: 1000,
        providerTradeNo: "shared-trade-no",
        verified: true
      }))
    };
    const harness = createPaymentHarness({
      config: {
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never
    });
    harness.addPaymentOrder({
      paymentChannel: PaymentChannel.WECHAT_JSAPI,
      provider: PaymentProviderType.WECHAT_PAY,
      providerTradeNo: "shared-trade-no"
    });

    await expect(
      harness.service.handleCallback("mock", {
        eventType: "mock.payment.success",
        providerTradeNo: "shared-trade-no"
      })
    ).resolves.toMatchObject({ handled: false, verified: false });

    expect(provider.verifyCallback).not.toHaveBeenCalled();
    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
    expect(harness.state.callbacks[0]?.errorMessage).toBe("PAYMENT_CALLBACK_PROVIDER_MISMATCH");
  });

  it("rejects Mock callbacks while Mock payment is disabled", async () => {
    const harness = createPaymentHarness({
      config: {
        APP_ENV: "test",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: ""
      }
    });
    harness.addPaymentOrder({ providerTradeNo: "mock-disabled-trade-no" });

    await expect(
      harness.service.handleCallback("mock", {
        eventType: "mock.payment.success",
        providerTradeNo: "mock-disabled-trade-no"
      })
    ).resolves.toMatchObject({ handled: false, verified: false });

    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
    expect(harness.state.callbacks[0]?.errorMessage).toBe("PAYMENT_CALLBACK_MOCK_DISABLED");
  });

  it("does not settle a payment when a verified callback omits the paid event", async () => {
    const harness = createPaymentHarness();
    harness.addPaymentOrder({ providerTradeNo: "missing-event-trade-no" });

    await expect(
      harness.service.handleCallback("mock", {
        providerTradeNo: "missing-event-trade-no"
      })
    ).resolves.toMatchObject({ handled: false, verified: true });

    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
    expect(harness.state.paymentOrders[0]?.paymentStatus).toBe(PaymentOrderStatus.CREATED);
  });

  it("does not select a payment order owned by another provider", async () => {
    const provider = {
      createPayment: vi.fn(),
      verifyCallback: vi.fn(async () => ({
        eventType: "TRANSACTION_SUCCESS",
        paidAmount: 1000,
        providerTradeNo: "cross-provider-trade-no",
        verified: true
      }))
    };
    const harness = createPaymentHarness({
      config: {
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never
    });
    harness.addPaymentOrder({
      provider: PaymentProviderType.MOCK,
      providerTradeNo: "cross-provider-trade-no"
    });

    await expect(
      harness.service.handleCallback("wechat-pay", { resource: {} })
    ).resolves.toMatchObject({ handled: false, verified: true });

    expect(provider.verifyCallback).toHaveBeenCalledOnce();
    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
    expect(harness.state.paymentOrders[0]?.paymentStatus).toBe(PaymentOrderStatus.CREATED);
  });

  it("returns a WeChat binding URL when JSAPI payment has no openid", async () => {
    const provider = {
      createPayment: vi.fn(),
      verifyCallback: vi.fn()
    };
    const harness = createPaymentHarness({
      config: {
        AUTO_DEBIT_ENABLED: "false",
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never
    });
    harness.addBill({ id: "bill_wechat", remainingAmount: 1000n });

    const result = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_wechat"] },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    expect(result.requiresWechatBinding).toBe(true);
    expect(result.wechatAuthUrl).toContain("open.weixin.qq.com");
    expect(provider.createPayment).not.toHaveBeenCalled();
  });

  it("creates a WeChat JSAPI payment when openid is bound", async () => {
    const provider = {
      createPayment: vi.fn(async (input: AnyRecord) => ({
        jsapiParams: {
          appId: "wx_test_app",
          nonceStr: "nonce",
          package: "prepay_id=wx_prepay",
          paySign: "signature",
          signType: "RSA",
          timeStamp: "1710000000"
        },
        providerPrepayId: "wx_prepay",
        providerTradeNo: input.paymentOrderNo,
        rawResponse: {
          prepayId: "wx_prepay"
        }
      })),
      verifyCallback: vi.fn()
    };
    const harness = createPaymentHarness({
      config: {
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never,
      wechatOpenId: "openid_customer_a"
    });
    harness.addBill({ id: "bill_wechat", remainingAmount: 1000n });

    const result = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_wechat"] },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    expect(result.paymentChannel).toBe(PaymentChannel.WECHAT_JSAPI);
    expect(result.paymentStatus).toBe(PaymentOrderStatus.PENDING);
    expect(result.jsapiParams?.package).toBe("prepay_id=wx_prepay");
    expect(JSON.stringify(result.jsapiParams)).not.toContain("secret");
    expect(provider.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1000n,
      openId: "openid_customer_a"
    }));
    expect(harness.autoDebitMandateRepository.findFirst).not.toHaveBeenCalled();
  });

  it("verifies WeChat callbacks without persisting raw encrypted payload fields", async () => {
    const paidAt = new Date("2026-08-06T08:00:00.000Z");
    const provider = {
      createPayment: vi.fn(async () => ({
        jsapiParams: {
          appId: "wx_test_app",
          nonceStr: "nonce",
          package: "prepay_id=wx_prepay",
          paySign: "signature",
          signType: "RSA",
          timeStamp: "1710000000"
        },
        providerPrepayId: "wx_prepay",
        providerTradeNo: "wechat-order-1"
      })),
      verifyCallback: vi.fn(async () => ({
        eventType: "TRANSACTION_SUCCESS",
        paidAmount: 1000,
        paidAt,
        providerTradeNo: "wechat-order-1",
        providerTransactionId: "wechat-transaction-1",
        verified: true
      }))
    };
    const harness = createPaymentHarness({
      config: {
        AUTO_DEBIT_ENABLED: "false",
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never,
      wechatOpenId: "openid_customer_a"
    });
    harness.addBill({ id: "bill_wechat", remainingAmount: 1000n });
    await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_wechat"] },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const rawPayload = {
      id: "event-1",
      resource: {
        associated_data: "secret-associated-data",
        ciphertext: "secret-ciphertext",
        nonce: "secret-nonce"
      },
      summary: "payment success"
    };

    await expect(
      harness.service.handleCallback("wechat-pay", rawPayload)
    ).resolves.toMatchObject({ handled: true, verified: true });

    const persisted = JSON.stringify(harness.state.callbacks[0]?.payload);
    const financeInput = JSON.stringify(
      harness.financeService.settlePaymentOrder.mock.calls[0]?.[0],
      (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    );
    for (const secret of [
      "secret-associated-data",
      "secret-ciphertext",
      "secret-nonce"
    ]) {
      expect(persisted).not.toContain(secret);
      expect(financeInput).not.toContain(secret);
    }
    expect(provider.verifyCallback).toHaveBeenCalledWith(
      rawPayload,
      undefined,
      undefined
    );
  });

  it("records WeChat callback verification errors without marking the payment paid", async () => {
    const provider = {
      createPayment: vi.fn(async (input: AnyRecord) => ({
        jsapiParams: {
          appId: "wx_test_app",
          nonceStr: "nonce",
          package: "prepay_id=wx_prepay",
          paySign: "signature",
          signType: "RSA",
          timeStamp: "1710000000"
        },
        providerPrepayId: "wx_prepay",
        providerTradeNo: input.paymentOrderNo
      })),
      verifyCallback: vi.fn(async () => ({
        errorMessage: "WECHATPAY_SERIAL_NOT_CONFIGURED",
        eventType: "SUCCESS",
        payload: {},
        providerTradeNo: "PYO_UNKNOWN",
        verified: false
      }))
    };
    const harness = createPaymentHarness({
      config: {
        PAYMENT_DEFAULT_CHANNEL: "WECHAT_JSAPI",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PROVIDER: "wechat_pay",
        WECHAT_PAY_ENABLED: "true"
      },
      provider: provider as never,
      wechatOpenId: "openid_customer_a"
    });
    harness.addBill({ id: "bill_wechat", remainingAmount: 1000n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_wechat"] },
      harness.currentCustomer("customer_a"),
      harness.context
    );

    const result = await harness.service.handleCallback("wechat-pay", { resource: {} });

    expect(result.verified).toBe(false);
    expect(harness.state.callbacks[0]?.errorMessage).toBe("WECHATPAY_SERIAL_NOT_CONFIGURED");
    expect(harness.state.paymentOrders.find((item) => item.id === paymentOrder.id)?.paymentStatus)
      .toBe(PaymentOrderStatus.PENDING);
    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
  });

  it("lists only payment orders owned by the current customer", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_a", customerId: "customer_a", orderId: "order_a", remainingAmount: 1000n });
    harness.addBill({ id: "bill_b", customerId: "customer_b", orderId: "order_b", remainingAmount: 2000n });
    await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_a"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_b"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_b"),
      harness.context
    );

    const result = await harness.service.listPortalPaymentOrders(harness.currentCustomer("customer_a"), {});

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.customerId).toBe("customer_a");
    expect(result.items[0]?.amount).toBe(1000);
  });

  it("puts payable payment orders before historical orders across pages", async () => {
    const harness = createPaymentHarness();
    harness.addPaymentOrder({ id: "paid", paymentStatus: PaymentOrderStatus.PAID, updatedAt: new Date("2026-08-10T05:00:00Z") });
    harness.addPaymentOrder({ id: "pending-late", paymentStatus: PaymentOrderStatus.PENDING, cashierUrlExpiresAt: new Date("2026-08-12T00:00:00Z") });
    harness.addPaymentOrder({ id: "created-soon", paymentStatus: PaymentOrderStatus.CREATED, cashierUrlExpiresAt: new Date("2026-08-11T00:00:00Z") });
    harness.addPaymentOrder({ id: "failed", paymentStatus: PaymentOrderStatus.FAILED, updatedAt: new Date("2026-08-10T06:00:00Z") });

    const first = await harness.service.listPortalPaymentOrders(
      harness.currentCustomer("customer_a"),
      { page: 1, pageSize: 2 }
    );
    const second = await harness.service.listPortalPaymentOrders(
      harness.currentCustomer("customer_a"),
      { page: 2, pageSize: 2 }
    );

    expect(first.items.map((item) => item.id)).toEqual(["created-soon", "pending-late"]);
    expect(second.items.map((item) => item.id)).toEqual(["failed", "paid"]);
  });

  it("keeps paymentStatus filtering exact", async () => {
    const harness = createPaymentHarness();
    harness.addPaymentOrder({ id: "pending", paymentStatus: PaymentOrderStatus.PENDING });
    harness.addPaymentOrder({ id: "paid", paymentStatus: PaymentOrderStatus.PAID });

    const result = await harness.service.listPortalPaymentOrders(
      harness.currentCustomer("customer_a"),
      { paymentStatus: PaymentOrderStatus.PAID }
    );
    expect(result.items.map((item) => item.id)).toEqual(["paid"]);
  });

  it("hides debit-backed payment orders and rejects Portal mock settlement", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_auto_debit", remainingAmount: 1000n });
    const paymentOrder = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_auto_debit"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const stored = harness.state.paymentOrders.find((item) => item.id === paymentOrder.id)!;
    stored.debitAttempt = { id: "attempt-1" };
    stored.paymentChannel = PaymentChannel.WECHAT_AUTO_DEBIT;

    const listed = await harness.service.listPortalPaymentOrders(
      harness.currentCustomer("customer_a"),
      {}
    );

    expect(listed.items).toHaveLength(0);
    await expect(
      harness.service.mockPay(
        paymentOrder.id,
        harness.currentCustomer("customer_a"),
        harness.context
      )
    ).rejects.toThrow("支付单不存在");
    expect(harness.financeService.settlePaymentOrder).not.toHaveBeenCalled();
  });

  it("never exposes provider transaction references in Portal payment DTOs", async () => {
    const harness = createPaymentHarness();
    harness.addBill({ id: "bill_private_refs", remainingAmount: 1000n });
    const created = await harness.service.createPortalPaymentOrder(
      { billIds: ["bill_private_refs"], paymentChannel: PaymentChannel.MOCK },
      harness.currentCustomer("customer_a"),
      harness.context
    );
    const stored = harness.state.paymentOrders.find((item) => item.id === created.id)!;
    stored.providerTradeNo = "private-trade-reference";
    stored.providerTransactionId = "private-transaction-reference";

    const result = await harness.service.getPortalPaymentOrder(
      created.id,
      harness.currentCustomer("customer_a")
    );

    expect(result).not.toHaveProperty("providerTradeNo");
    expect(result).not.toHaveProperty("providerTransactionId");
    expect(JSON.stringify(result)).not.toContain("private-transaction-reference");
  });
});

function createPaymentHarness(options: {
  config?: Record<string, string>;
  provider?: MockPaymentProvider;
  wechatOpenId?: string | null;
} = {}) {
  const state = {
    bills: [] as AnyRecord[],
    callbacks: [] as AnyRecord[],
    depositLedgers: [] as AnyRecord[],
    paymentOrders: [] as AnyRecord[],
    paymentRecords: [] as AnyRecord[],
    users: [{
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: null,
      id: "operator_1",
      name: "Admin",
      status: "ACTIVE",
      username: "admin"
    }]
  };

  const prisma: AnyRecord = {
    $transaction: vi.fn(async (callback: (tx: AnyRecord) => unknown) => callback(prisma)),
    autoDebitMandate: {
      findFirst: vi.fn(async () => null)
    },
    customer: {
      findFirst: vi.fn(async () => ({ ownerUserId: "operator_1" }))
    },
    paymentCallbackLog: {
      create: vi.fn(async ({ data }: AnyRecord) => {
        const callback = {
          eventType: data.eventType ?? null,
          handled: data.handled ?? false,
          handledAt: data.handledAt ?? null,
          id: `callback_${state.callbacks.length + 1}`,
          payload: data.payload ?? null,
          paymentOrderId: data.paymentOrderId ?? null,
          provider: data.provider,
          providerTradeNo: data.providerTradeNo ?? null,
          providerTransactionId: data.providerTransactionId ?? null,
          receivedAt: new Date(),
          verified: data.verified ?? false
        };
        state.callbacks.push(callback);
        return callback;
      }),
      update: vi.fn(async ({ data, where }: AnyRecord) => {
        const callback = state.callbacks.find((item) => item.id === where.id);
        Object.assign(callback!, data);
        return callback;
      })
    },
    paymentOrder: {
      count: vi.fn(async ({ where }: AnyRecord) =>
        state.paymentOrders.filter((item) => matchesPaymentOrder(item, where)).length
      ),
      create: vi.fn(async ({ data }: AnyRecord) => {
        const paymentOrder = {
          amount: data.amount,
          callbacks: [],
          cashierUrl: null,
          cashierUrlExpiresAt: null,
          clientIp: data.clientIp ?? null,
          createdAt: new Date(),
          customerId: data.customerId,
          deletedAt: null,
          description: data.description ?? null,
          id: `payment_order_${state.paymentOrders.length + 1}`,
          items: data.items.create.map((item: AnyRecord, index: number) => ({
            amount: item.amount,
            billId: item.billId,
            createdAt: new Date(),
            deletedAt: null,
            id: `payment_order_item_${state.paymentOrders.length + 1}_${index + 1}`,
            paymentOrderId: `payment_order_${state.paymentOrders.length + 1}`
          })),
          orderId: data.orderId,
          paidAmount: 0n,
          paidAt: null,
          paymentChannel: data.paymentChannel,
          paymentOrderNo: data.paymentOrderNo,
          paymentRecordId: null,
          paymentStatus: data.paymentStatus,
          provider: data.provider,
          providerPrepayId: null,
          providerTradeNo: null,
          providerTransactionId: null,
          subject: data.subject ?? null,
          updatedAt: new Date()
        };
        state.paymentOrders.push(paymentOrder);
        return includePaymentOrder(state, paymentOrder);
      }),
      findFirst: vi.fn(async ({ where }: AnyRecord) => {
        const paymentOrder = state.paymentOrders.find((item) => matchesPaymentOrder(item, where));
        return paymentOrder ? includePaymentOrder(state, paymentOrder) : null;
      }),
      findMany: vi.fn(async ({ orderBy, skip = 0, take, where }: AnyRecord) => {
        const rows = state.paymentOrders
          .filter((item) => matchesPaymentOrder(item, where))
          .map((item) => includePaymentOrder(state, item));
        const sorted = applyOrderBy(rows, orderBy);
        return sorted.slice(skip, take === undefined ? undefined : skip + take);
      }),
      update: vi.fn(async ({ data, where }: AnyRecord) => {
        const paymentOrder = state.paymentOrders.find((item) => item.id === where.id);
        Object.assign(paymentOrder!, data, { updatedAt: new Date() });
        return includePaymentOrder(state, paymentOrder!);
      })
    },
    receivableBill: {
      findMany: vi.fn(async ({ where }: AnyRecord) =>
        state.bills.filter((bill) => {
          if (where.customerId && bill.customerId !== where.customerId) {
            return false;
          }
          if (where.orderId && bill.orderId !== where.orderId) {
            return false;
          }
          if (where.id?.in && !where.id.in.includes(bill.id)) {
            return false;
          }
          if (where.billStatus?.in && !where.billStatus.in.includes(bill.billStatus)) {
            return false;
          }
          if (where.remainingAmount?.gt !== undefined && !(bill.remainingAmount > BigInt(where.remainingAmount.gt))) {
            return false;
          }
          return !bill.deletedAt;
        }).map((bill) => includeBillOrder(bill))
      )
    },
    user: {
      findFirst: vi.fn(async ({ where }: AnyRecord = {}) =>
        state.users.find((user) => (!where?.id || user.id === where.id) && user.status === "ACTIVE") ?? null
      )
    }
  };

  const financeService = {
    createPayment: vi.fn(async (dto: AnyRecord) => {
      const paymentRecord = {
        customerId: dto.customerId,
        id: `payment_record_${state.paymentRecords.length + 1}`,
        orderId: dto.orderId,
        paymentAmount: BigInt(dto.paymentAmount),
        paymentNo: `PAY-${state.paymentRecords.length + 1}`
      };
      state.paymentRecords.push(paymentRecord);
      return {
        ...paymentRecord,
        paymentAmount: Number(paymentRecord.paymentAmount)
      };
    }),
    writeOffPayment: vi.fn(async (paymentId: string, dto: AnyRecord) => {
      for (const item of dto.items) {
        const bill = state.bills.find((candidate) => candidate.id === item.billId)!;
        const writeOffAmount = BigInt(item.writeOffAmount);
        bill.paidAmount += writeOffAmount;
        bill.remainingAmount -= writeOffAmount;
        bill.billStatus = bill.remainingAmount === 0n ? BillStatus.PAID : BillStatus.PARTIALLY_PAID;
        if (bill.billType === BillType.DEPOSIT && bill.billStatus === BillStatus.PAID) {
          state.depositLedgers.push({ billId: bill.id, paymentId });
        }
      }
      return { paymentId };
    }),
    settlePaymentOrder: vi.fn(async (input: AnyRecord) => {
      const paymentOrder = state.paymentOrders.find(
        (item) => item.id === input.paymentOrderId
      )!;
      if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
        return { idempotent: true, paymentOrderId: paymentOrder.id };
      }
      const paymentRecord = await financeService.createPayment({
        customerId: paymentOrder.customerId,
        orderId: paymentOrder.orderId,
        paymentAmount: Number(input.paidAmount)
      });
      await financeService.writeOffPayment(paymentRecord.id, {
        items: paymentOrder.items.map((item: AnyRecord) => {
          const bill = state.bills.find(
            (candidate) => candidate.id === item.billId
          )!;
          return {
            billId: item.billId,
            writeOffAmount: Number(
              item.amount < bill.remainingAmount
                ? item.amount
                : bill.remainingAmount
            )
          };
        })
      });
      Object.assign(paymentOrder, {
        paidAmount: input.paidAmount,
        paidAt: input.paidAt,
        paymentRecordId: paymentRecord.id,
        paymentStatus: PaymentOrderStatus.PAID,
        providerTradeNo:
          input.providerTradeNo ?? paymentOrder.providerTradeNo,
        providerTransactionId:
          input.providerTransactionId ?? paymentOrder.providerTransactionId
      });
      if (input.callbackLogId) {
        const callback = state.callbacks.find(
          (item) => item.id === input.callbackLogId
        );
        Object.assign(callback!, {
          handled: true,
          handledAt: input.paidAt,
          paymentOrderId: paymentOrder.id
        });
      }
      return { idempotent: false, paymentOrderId: paymentOrder.id };
    })
  };

  const configService = {
    get: vi.fn((key: string) => {
      const values: Record<string, string> = {
        API_BASE_URL: "http://localhost:3001/api",
        PAYMENT_DEFAULT_CHANNEL: "MOCK",
        PAYMENT_MOCK_ENABLED: "true",
        PAYMENT_PROVIDER: "mock",
        PORTAL_BASE_URL: "http://localhost:3000",
        WECHAT_PAY_ENABLED: "false",
        ...options.config
      };
      return values[key];
    })
  };
  const wechatOAuthService = {
    createOAuthUrl: vi.fn(async () => ({
      authUrl: "https://open.weixin.qq.com/connect/oauth2/authorize?mock=1",
      expiresIn: 300
    })),
    getOpenId: vi.fn(async () => options.wechatOpenId ?? null)
  };

  const service = new PaymentOrderService(
    { write: vi.fn() } as never,
    configService as never,
    financeService as never,
    (options.provider ?? new MockPaymentProvider(configService as never)) as never,
    wechatOAuthService as never,
    prisma as never
  );

  return {
    autoDebitMandateRepository: prisma.autoDebitMandate,
    addBill(input: Partial<AnyRecord>) {
      const orderId = input.orderId ?? "order_a";
      state.bills.push({
        amount: input.amount ?? input.remainingAmount ?? 1000n,
        billNo: input.billNo ?? `BIL-${state.bills.length + 1}`,
        billPeriodEnd: null,
        billPeriodStart: null,
        billStatus: input.billStatus ?? BillStatus.PENDING,
        billType: input.billType ?? BillType.MONTHLY_RENT,
        createdAt: new Date(),
        customerId: input.customerId ?? "customer_a",
        deletedAt: null,
        dueDate: new Date("2026-06-16T00:00:00Z"),
        id: input.id ?? `bill_${state.bills.length + 1}`,
        order: {
          id: orderId,
          orderNo: input.orderNo ?? "ORD-1",
          orderStatus: "PENDING_PAYMENT"
        },
        orderId,
        paidAmount: input.paidAmount ?? 0n,
        remainingAmount: input.remainingAmount ?? input.amount ?? 1000n
      });
    },
    addPaymentOrder(input: Partial<AnyRecord>) {
      const createdAt = input.createdAt ?? new Date(
        Date.parse("2026-08-01T00:00:00Z") + state.paymentOrders.length * 60_000
      );
      state.paymentOrders.push({
        amount: input.amount ?? 1000n,
        callbacks: [],
        cashierUrl: null,
        cashierUrlExpiresAt: input.cashierUrlExpiresAt ?? null,
        clientIp: null,
        createdAt,
        customerId: input.customerId ?? "customer_a",
        debitAttempt: null,
        deletedAt: null,
        description: null,
        id: input.id ?? `payment_order_${state.paymentOrders.length + 1}`,
        items: [],
        orderId: input.orderId ?? "order_a",
        paidAmount: input.paymentStatus === PaymentOrderStatus.PAID ? 1000n : 0n,
        paidAt: null,
        paymentChannel: input.paymentChannel ?? PaymentChannel.MOCK,
        paymentOrderNo: input.paymentOrderNo ?? `PAY-${state.paymentOrders.length + 1}`,
        paymentRecordId: null,
        paymentStatus: input.paymentStatus ?? PaymentOrderStatus.CREATED,
        provider: input.provider ?? PaymentProviderType.MOCK,
        providerPrepayId: input.providerPrepayId ?? null,
        providerTradeNo: input.providerTradeNo ?? null,
        providerTransactionId: input.providerTransactionId ?? null,
        subject: null,
        updatedAt: input.updatedAt ?? createdAt
      });
    },
    context: { ipAddress: "127.0.0.1", userAgent: "vitest" },
    currentCustomer(customerId: string) {
      return {
        accountStatus: "ACTIVE",
        customerAccountId: `${customerId}_account`,
        customerId,
        phone: "13800000000"
      } as never;
    },
    financeService,
    service,
    state,
    wechatOAuthService
  };
}

function includePaymentOrder(state: ReturnType<typeof createPaymentHarness>["state"], paymentOrder: AnyRecord) {
  return {
    ...paymentOrder,
    callbacks: state.callbacks.filter((callback) => callback.paymentOrderId === paymentOrder.id),
    customer: { id: paymentOrder.customerId, mobile: "13800000000", name: "客户" },
    items: paymentOrder.items.map((item: AnyRecord) => ({
      ...item,
      bill: includeBillOrder(state.bills.find((bill) => bill.id === item.billId)!)
    })),
    order: paymentOrder.orderId
      ? { contractId: "contract_1", id: paymentOrder.orderId, orderNo: "ORD-1", orderStatus: "PENDING_PAYMENT" }
      : null,
    paymentRecord: paymentOrder.paymentRecordId
      ? state.paymentRecords.find((record) => record.id === paymentOrder.paymentRecordId) ?? null
      : null,
    provider: paymentOrder.provider ?? PaymentProviderType.MOCK
  };
}

function includeBillOrder(bill: AnyRecord) {
  return {
    ...bill,
    order: bill.order ?? { id: bill.orderId, orderNo: "ORD-1", orderStatus: "PENDING_PAYMENT" }
  };
}

function matchesPaymentOrder(paymentOrder: AnyRecord, where: AnyRecord) {
  if (where.deletedAt === null && paymentOrder.deletedAt !== null) {
    return false;
  }
  if (where.id && paymentOrder.id !== where.id) {
    return false;
  }
  if (where.customerId && paymentOrder.customerId !== where.customerId) {
    return false;
  }
  if (where.providerTradeNo && paymentOrder.providerTradeNo !== where.providerTradeNo) {
    return false;
  }
  if (where.paymentOrderNo && paymentOrder.paymentOrderNo !== where.paymentOrderNo) {
    return false;
  }
  if (where.provider && paymentOrder.provider !== where.provider) {
    return false;
  }
  if (where.providerTransactionId && paymentOrder.providerTransactionId !== where.providerTransactionId) {
    return false;
  }
  if (where.paymentStatus?.in && !where.paymentStatus.in.includes(paymentOrder.paymentStatus)) {
    return false;
  }
  if (where.paymentStatus && !where.paymentStatus.in && paymentOrder.paymentStatus !== where.paymentStatus) {
    return false;
  }
  if (
    where.paymentChannel?.not &&
    paymentOrder.paymentChannel === where.paymentChannel.not
  ) {
    return false;
  }
  if (
    where.paymentChannel &&
    typeof where.paymentChannel === "string" &&
    paymentOrder.paymentChannel !== where.paymentChannel
  ) {
    return false;
  }
  if (where.orderId && paymentOrder.orderId !== where.orderId) {
    return false;
  }
  if (where.debitAttempt?.is === null && paymentOrder.debitAttempt) {
    return false;
  }
  return true;
}

function applyOrderBy(items: AnyRecord[], orderBy: AnyRecord | AnyRecord[] | undefined) {
  const entries = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...items].sort((left, right) => {
    for (const entry of entries) {
      const [field, rawDirection] = Object.entries(entry)[0] ?? [];
      if (!field) continue;
      const directionConfig = rawDirection && typeof rawDirection === "object"
        ? rawDirection as { nulls?: string; sort?: string }
        : null;
      const direction = typeof rawDirection === "string" ? rawDirection : directionConfig?.sort;
      const nulls = directionConfig?.nulls;
      const leftValue = left[field];
      const rightValue = right[field];
      if (leftValue == null || rightValue == null) {
        if (leftValue == null && rightValue == null) continue;
        if (nulls === "last") return leftValue == null ? 1 : -1;
        return leftValue == null ? -1 : 1;
      }
      const leftComparable = leftValue instanceof Date ? leftValue.getTime() : String(leftValue);
      const rightComparable = rightValue instanceof Date ? rightValue.getTime() : String(rightValue);
      if (leftComparable < rightComparable) return direction === "asc" ? -1 : 1;
      if (leftComparable > rightComparable) return direction === "asc" ? 1 : -1;
    }
    return 0;
  });
}

// The fake Prisma harness deliberately accepts loosely-shaped query/data objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;
