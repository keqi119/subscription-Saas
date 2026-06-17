import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  BillStatus,
  PaymentChannel,
  PaymentMethod,
  PaymentOrderStatus,
  PaymentProviderType,
  Prisma,
  UserStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { CreatePaymentDto, WriteOffPaymentDto } from "../finance/dto/finance.dto";
import { FinanceService } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer } from "../portal/portal-auth.types";
import { CreatePortalPaymentOrderDto, PortalPayableBillsQueryDto } from "./payment.dto";
import { PAYMENT_PROVIDER_CLIENT, PaymentProvider } from "./payment-provider";

const PAYABLE_BILL_STATUSES: BillStatus[] = [
  BillStatus.PENDING,
  BillStatus.PARTIALLY_PAID,
  BillStatus.OVERDUE
];

const REUSABLE_PAYMENT_ORDER_STATUSES: PaymentOrderStatus[] = [
  PaymentOrderStatus.CREATED,
  PaymentOrderStatus.PENDING
];

const PAYABLE_PAYMENT_ORDER_STATUSES = new Set<PaymentOrderStatus>([
  PaymentOrderStatus.CREATED,
  PaymentOrderStatus.PENDING
]);

const CALLBACK_PAID_EVENTS = new Set([
  "PAID",
  "PAYMENT_SUCCESS",
  "PAY_SUCCESS",
  "TRANSACTION_SUCCESS",
  "MOCK_PAYMENT_SUCCESS",
  "mock.payment.success"
]);

const paymentOrderInclude = {
  callbacks: {
    orderBy: { receivedAt: "desc" as const },
    take: 10
  },
  customer: { select: { id: true, mobile: true, name: true } },
  items: {
    include: {
      bill: {
        include: {
          order: { select: { id: true, orderNo: true, orderStatus: true } }
        }
      }
    },
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  },
  order: {
    select: {
      contractId: true,
      id: true,
      orderNo: true,
      orderStatus: true
    }
  },
  paymentRecord: { select: { id: true, paymentNo: true } }
} satisfies Prisma.PaymentOrderInclude;

type PaymentOrderWithDetails = Prisma.PaymentOrderGetPayload<{ include: typeof paymentOrderInclude }>;
type PayableBill = Prisma.ReceivableBillGetPayload<{
  include: { order: { select: { id: true; orderNo: true; orderStatus: true } } };
}>;

@Injectable()
export class PaymentOrderService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly financeService: FinanceService,
    @Inject(PAYMENT_PROVIDER_CLIENT)
    private readonly provider: PaymentProvider,
    private readonly prisma: PrismaService
  ) {}

  async listPayableBills(currentCustomer: CurrentCustomer, query: PortalPayableBillsQueryDto) {
    const bills = await this.prisma.receivableBill.findMany({
      include: {
        order: { select: { id: true, orderNo: true, orderStatus: true } }
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      where: {
        billStatus: { in: PAYABLE_BILL_STATUSES },
        customerId: currentCustomer.customerId,
        deletedAt: null,
        orderId: query.orderId,
        remainingAmount: { gt: 0 }
      }
    });

    return bills.map(toPayableBillView);
  }

  async createPortalPaymentOrder(
    dto: CreatePortalPaymentOrderDto,
    currentCustomer: CurrentCustomer,
    context: RequestContext
  ) {
    this.assertMockProviderAvailable();
    const billIds = uniqueStrings(dto.billIds);
    const paymentChannel = dto.paymentChannel ?? PaymentChannel.MOCK;
    if (paymentChannel !== PaymentChannel.MOCK) {
      throw new BadRequestException("当前阶段仅开放 Mock 支付通道。");
    }

    const bills = await this.loadPayableBillsForPayment(currentCustomer.customerId, billIds);
    this.assertBillsCanCreatePaymentOrder(bills, billIds);

    const existing = await this.findReusablePaymentOrder(currentCustomer.customerId, billIds);
    if (existing) {
      if (existing.cashierUrl && isFuture(existing.cashierUrlExpiresAt)) {
        return toPaymentOrderView(existing);
      }
      return this.refreshProviderPayment(existing.id, context);
    }

    const orderId = assertSingleOrder(bills);
    const amount = bills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);
    const subject = buildPaymentSubject(bills);
    const description = buildPaymentDescription(bills);

    const paymentOrder = await withUniqueBusinessNoRetry(() =>
      this.prisma.paymentOrder.create({
        data: {
          amount,
          clientIp: context.ipAddress,
          customerId: currentCustomer.customerId,
          description,
          items: {
            create: bills.map((bill) => ({
              amount: bill.remainingAmount,
              billId: bill.id
            }))
          },
          orderId,
          paymentChannel,
          paymentOrderNo: createBusinessNo("PYO"),
          paymentStatus: PaymentOrderStatus.CREATED,
          provider: this.providerType,
          requestSnapshot: toJsonValue({
            billIds,
            channel: paymentChannel,
            customerId: currentCustomer.customerId,
            source: "portal"
          }),
          subject,
          userAgent: context.userAgent
        },
        include: paymentOrderInclude
      })
    );

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toPaymentOrderView(paymentOrder),
      entityId: paymentOrder.id,
      entityType: "payment_order",
      ipAddress: context.ipAddress,
      module: "payment",
      userAgent: context.userAgent
    });

    return this.refreshProviderPayment(paymentOrder.id, context);
  }

  async getPortalPaymentOrder(id: string, currentCustomer: CurrentCustomer) {
    const paymentOrder = await this.findPortalPaymentOrderOrThrow(id, currentCustomer.customerId);
    return toPaymentOrderView(paymentOrder);
  }

  async startPortalPayment(id: string, currentCustomer: CurrentCustomer, context: RequestContext) {
    this.assertMockProviderAvailable();
    const paymentOrder = await this.findPortalPaymentOrderOrThrow(id, currentCustomer.customerId);
    if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
      return toPaymentOrderView(paymentOrder);
    }
    if (!PAYABLE_PAYMENT_ORDER_STATUSES.has(paymentOrder.paymentStatus)) {
      throw new BadRequestException("当前支付单状态不允许继续支付。");
    }
    if (paymentOrder.cashierUrl && isFuture(paymentOrder.cashierUrlExpiresAt)) {
      return toPaymentOrderView(paymentOrder);
    }
    return this.refreshProviderPayment(paymentOrder.id, context);
  }

  async mockPay(id: string, currentCustomer: CurrentCustomer, context: RequestContext) {
    this.assertMockProviderAvailable();
    const paymentOrder = await this.findPortalPaymentOrderOrThrow(id, currentCustomer.customerId);
    const paidAt = new Date();
    const providerTransactionId = `mock_txn_${paymentOrder.paymentOrderNo}`;

    return this.completePaymentOrder(paymentOrder.id, {
      callbackPayload: {
        eventType: "mock.payment.success",
        paymentOrderId: paymentOrder.id,
        providerTradeNo: paymentOrder.providerTradeNo,
        providerTransactionId
      },
      eventType: "mock.payment.success",
      paidAmount: Number(paymentOrder.amount),
      paidAt,
      providerTradeNo: paymentOrder.providerTradeNo ?? `mock_${paymentOrder.paymentOrderNo}`,
      providerTransactionId
    }, context);
  }

  async handleCallback(provider: string, payload: unknown, headers?: Record<string, unknown>) {
    const providerType = parseProviderType(provider);
    const callbackLog = await this.prisma.paymentCallbackLog.create({
      data: {
        payload: toJsonValue(payload),
        provider: providerType
      }
    });

    try {
      const result = await this.provider.verifyCallback(payload, headers);
      await this.prisma.paymentCallbackLog.update({
        data: {
          eventType: result.eventType,
          providerTradeNo: result.providerTradeNo,
          providerTransactionId: result.providerTransactionId,
          verified: result.verified
        },
        where: { id: callbackLog.id }
      });

      if (!result.verified) {
        return { handled: false, received: true, verified: false };
      }

      const paymentOrder = await this.findPaymentOrderByProviderRefs(result);
      if (!paymentOrder) {
        await this.prisma.paymentCallbackLog.update({
          data: { errorMessage: "未找到对应支付单" },
          where: { id: callbackLog.id }
        });
        return { handled: false, received: true, verified: true };
      }

      await this.prisma.paymentCallbackLog.update({
        data: { paymentOrderId: paymentOrder.id },
        where: { id: callbackLog.id }
      });

      if (!isPaidCallbackEvent(result.eventType)) {
        return { handled: false, paymentOrderId: paymentOrder.id, received: true, verified: true };
      }

      const completed = await this.completePaymentOrder(paymentOrder.id, {
        callbackLogId: callbackLog.id,
        callbackPayload: payload,
        eventType: result.eventType,
        paidAmount: result.paidAmount,
        paidAt: result.paidAt,
        providerTradeNo: result.providerTradeNo,
        providerTransactionId: result.providerTransactionId
      });

      return { handled: true, paymentOrder: completed, received: true, verified: true };
    } catch (error) {
      await this.prisma.paymentCallbackLog.update({
        data: { errorMessage: getErrorMessage(error) },
        where: { id: callbackLog.id }
      });
      throw error;
    }
  }

  private async refreshProviderPayment(paymentOrderId: string, context: RequestContext) {
    const paymentOrder = await this.findPaymentOrderOrThrow(paymentOrderId);
    if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
      return toPaymentOrderView(paymentOrder);
    }

    const result = await this.provider.createPayment({
      amount: paymentOrder.amount,
      clientIp: context.ipAddress,
      description: paymentOrder.description ?? undefined,
      notifyUrl: this.buildNotifyUrl(),
      paymentOrderId: paymentOrder.id,
      paymentOrderNo: paymentOrder.paymentOrderNo,
      returnUrl: this.buildReturnUrl(paymentOrder.id),
      subject: paymentOrder.subject ?? undefined
    });

    const updated = await this.prisma.paymentOrder.update({
      data: {
        cashierUrl: result.cashierUrl,
        cashierUrlExpiresAt: result.cashierUrlExpiresAt,
        providerPrepayId: result.providerPrepayId,
        providerTradeNo: result.providerTradeNo,
        paymentStatus: PaymentOrderStatus.PENDING,
        responseSnapshot: toJsonValue(result.rawResponse),
        updatedAt: new Date()
      },
      include: paymentOrderInclude,
      where: { id: paymentOrder.id }
    });

    return toPaymentOrderView(updated);
  }

  private async completePaymentOrder(
    paymentOrderId: string,
    options: {
      callbackLogId?: string;
      callbackPayload?: unknown;
      eventType?: string;
      paidAmount?: number;
      paidAt?: Date;
      providerTradeNo?: string;
      providerTransactionId?: string;
    },
    context: RequestContext = {}
  ) {
    const paymentOrder = await this.findPaymentOrderOrThrow(paymentOrderId);
    if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
      if (options.callbackLogId) {
        await this.markCallbackHandled(options.callbackLogId, paymentOrder.id);
      }
      return toPaymentOrderView(paymentOrder);
    }
    if (!PAYABLE_PAYMENT_ORDER_STATUSES.has(paymentOrder.paymentStatus)) {
      throw new BadRequestException("当前支付单状态不允许完成支付。");
    }

    const paidAmount = options.paidAmount === undefined ? paymentOrder.amount : BigInt(options.paidAmount);
    if (paidAmount !== paymentOrder.amount) {
      await this.prisma.paymentOrder.update({
        data: {
          errorSnapshot: toJsonValue({
            expectedAmount: Number(paymentOrder.amount),
            paidAmount: Number(paidAmount)
          }),
          paymentStatus: PaymentOrderStatus.FAILED
        },
        where: { id: paymentOrder.id }
      });
      throw new BadRequestException("支付金额与支付单金额不一致。");
    }

    const operator = await this.resolveFinanceOperator(paymentOrder.customerId);
    const paidAt = options.paidAt ?? new Date();
    let paymentRecordId = paymentOrder.paymentRecordId;

    if (!paymentRecordId) {
      const createPaymentDto: CreatePaymentDto = {
        customerId: paymentOrder.customerId!,
        orderId: paymentOrder.orderId!,
        payerAccount: options.providerTransactionId ?? options.providerTradeNo,
        payerName: "客户线上支付",
        paymentAmount: Number(paymentOrder.amount),
        paymentMethod: mapPaymentMethod(paymentOrder.paymentChannel),
        paymentProofUrls: [],
        receivedAt: paidAt.toISOString(),
        remark: `线上支付单 ${paymentOrder.paymentOrderNo}`
      };
      const paymentRecord = await this.financeService.createPayment(createPaymentDto, operator, context);
      paymentRecordId = paymentRecord.id;

      const writeOffDto: WriteOffPaymentDto = {
        items: paymentOrder.items.map((item) => ({
          billId: item.billId,
          writeOffAmount: Number(item.amount)
        })),
        remark: `线上支付单 ${paymentOrder.paymentOrderNo} 自动核销`
      };
      await this.financeService.writeOffPayment(paymentRecord.id, writeOffDto, operator, context);
    }

    const updated = await this.prisma.paymentOrder.update({
      data: {
        callbackSnapshot: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
        paidAmount: paymentOrder.amount,
        paidAt,
        paymentRecordId,
        paymentStatus: PaymentOrderStatus.PAID,
        providerTradeNo: options.providerTradeNo ?? paymentOrder.providerTradeNo,
        providerTransactionId: options.providerTransactionId ?? paymentOrder.providerTransactionId,
        updatedBy: operator.id
      },
      include: paymentOrderInclude,
      where: { id: paymentOrder.id }
    });

    if (options.callbackLogId) {
      await this.markCallbackHandled(options.callbackLogId, paymentOrder.id);
    } else {
      await this.prisma.paymentCallbackLog.create({
        data: {
          eventType: options.eventType,
          handled: true,
          handledAt: paidAt,
          payload: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
          paymentOrderId: paymentOrder.id,
          provider: paymentOrder.provider,
          providerTradeNo: options.providerTradeNo ?? paymentOrder.providerTradeNo,
          providerTransactionId: options.providerTransactionId,
          verified: true
        }
      });
    }

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toPaymentOrderView(updated),
      before: toPaymentOrderView(paymentOrder),
      entityId: updated.id,
      entityType: "payment_order",
      ipAddress: context.ipAddress,
      module: "payment",
      operatorId: operator.id,
      userAgent: context.userAgent
    });

    return toPaymentOrderView(updated);
  }

  private async findPortalPaymentOrderOrThrow(id: string, customerId: string) {
    const paymentOrder = await this.prisma.paymentOrder.findFirst({
      include: paymentOrderInclude,
      where: { customerId, deletedAt: null, id }
    });
    if (!paymentOrder) {
      throw new NotFoundException("支付单不存在。");
    }
    return paymentOrder;
  }

  private async findPaymentOrderOrThrow(id: string) {
    const paymentOrder = await this.prisma.paymentOrder.findFirst({
      include: paymentOrderInclude,
      where: { deletedAt: null, id }
    });
    if (!paymentOrder) {
      throw new NotFoundException("支付单不存在。");
    }
    return paymentOrder;
  }

  private async loadPayableBillsForPayment(customerId: string, billIds: string[]) {
    return this.prisma.receivableBill.findMany({
      include: { order: { select: { id: true, orderNo: true, orderStatus: true } } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      where: {
        customerId,
        deletedAt: null,
        id: { in: billIds }
      }
    });
  }

  private assertBillsCanCreatePaymentOrder(bills: PayableBill[], billIds: string[]) {
    if (bills.length !== billIds.length) {
      throw new NotFoundException("账单不存在或不属于当前客户。");
    }
    for (const bill of bills) {
      if (!PAYABLE_BILL_STATUSES.includes(bill.billStatus) || bill.remainingAmount <= 0n) {
        throw new BadRequestException("仅未结清账单可以创建支付单。");
      }
    }
    assertSingleOrder(bills);
  }

  private async findReusablePaymentOrder(customerId: string, billIds: string[]) {
    const sortedBillIds = [...billIds].sort();
    const candidates = await this.prisma.paymentOrder.findMany({
      include: paymentOrderInclude,
      orderBy: { createdAt: "desc" },
      where: {
        customerId,
        deletedAt: null,
        paymentStatus: { in: REUSABLE_PAYMENT_ORDER_STATUSES }
      }
    });

    return candidates.find((candidate) => {
      const candidateBillIds = candidate.items.map((item) => item.billId).sort();
      return arraysEqual(sortedBillIds, candidateBillIds);
    }) ?? null;
  }

  private async findPaymentOrderByProviderRefs(result: { providerTradeNo?: string; providerTransactionId?: string }) {
    if (result.providerTradeNo) {
      const byTradeNo = await this.prisma.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, providerTradeNo: result.providerTradeNo }
      });
      if (byTradeNo) {
        return byTradeNo;
      }
    }

    if (result.providerTransactionId) {
      return this.prisma.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, providerTransactionId: result.providerTransactionId }
      });
    }

    return null;
  }

  private async markCallbackHandled(callbackLogId: string, paymentOrderId: string) {
    await this.prisma.paymentCallbackLog.update({
      data: {
        handled: true,
        handledAt: new Date(),
        paymentOrderId
      },
      where: { id: callbackLogId }
    });
  }

  private async resolveFinanceOperator(customerId: string | null) {
    const customer = customerId
      ? await this.prisma.customer.findFirst({
          select: { ownerUserId: true },
          where: { deletedAt: null, id: customerId }
        })
      : null;
    const configuredOperatorId = this.configService.get<string>("PORTAL_PAYMENT_OPERATOR_USER_ID");
    const operatorId = configuredOperatorId || customer?.ownerUserId;
    const user = operatorId
      ? await this.prisma.user.findFirst({
          where: { deletedAt: null, id: operatorId, status: UserStatus.ACTIVE }
        })
      : await this.prisma.user.findFirst({
          orderBy: { createdAt: "asc" },
          where: { deletedAt: null, status: UserStatus.ACTIVE }
        });

    if (!user) {
      throw new BadRequestException("缺少可用于自动核销的后台操作员。");
    }

    return {
      id: user.id,
      menus: [],
      name: user.name,
      permissions: [],
      roles: ["ADMIN"],
      username: user.username
    } satisfies RequestUser;
  }

  private assertMockProviderAvailable() {
    if (this.providerType !== PaymentProviderType.MOCK || !this.mockEnabled) {
      throw new ForbiddenException("Mock 支付未开启。");
    }
  }

  private buildNotifyUrl() {
    const apiBaseUrl = trimTrailingSlash(
      this.configService.get<string>("API_BASE_URL") ?? "http://localhost:3001/api"
    );
    return `${apiBaseUrl}/payments/callback/mock`;
  }

  private buildReturnUrl(paymentOrderId: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    return `${portalBaseUrl}/portal/payment-orders/${encodeURIComponent(paymentOrderId)}`;
  }

  private get mockEnabled() {
    return (this.configService.get<string>("PAYMENT_MOCK_ENABLED") ?? "false").toLowerCase() === "true";
  }

  private get providerType() {
    const provider = (this.configService.get<string>("PAYMENT_PROVIDER") ?? "mock").toLowerCase();
    if (provider === "mock") {
      return PaymentProviderType.MOCK;
    }
    if (provider === "wechat_pay" || provider === "wechat" || provider === "wxpay") {
      return PaymentProviderType.WECHAT_PAY;
    }
    if (provider === "alipay") {
      return PaymentProviderType.ALIPAY;
    }
    if (provider === "bank_transfer") {
      return PaymentProviderType.BANK_TRANSFER;
    }
    return PaymentProviderType.OTHER;
  }
}

function toPayableBillView(bill: PayableBill) {
  return {
    amount: Number(bill.amount),
    billId: bill.id,
    billNo: bill.billNo,
    billStatus: bill.billStatus,
    billType: bill.billType,
    dueDate: toIsoDateTime(bill.dueDate),
    orderId: bill.orderId,
    orderNo: bill.order.orderNo,
    orderStatus: bill.order.orderStatus,
    paidAmount: Number(bill.paidAmount),
    periodEnd: toIsoDate(bill.billPeriodEnd),
    periodStart: toIsoDate(bill.billPeriodStart),
    remainingAmount: Number(bill.remainingAmount)
  };
}

function toPaymentOrderView(paymentOrder: PaymentOrderWithDetails) {
  return {
    amount: Number(paymentOrder.amount),
    callbacks: paymentOrder.callbacks.map((callback) => ({
      eventType: callback.eventType,
      handled: callback.handled,
      id: callback.id,
      receivedAt: toIsoDateTime(callback.receivedAt),
      verified: callback.verified
    })),
    cashierUrl: paymentOrder.cashierUrl,
    cashierUrlExpiresAt: toIsoDateTime(paymentOrder.cashierUrlExpiresAt),
    createdAt: toIsoDateTime(paymentOrder.createdAt),
    customerId: paymentOrder.customerId,
    id: paymentOrder.id,
    items: paymentOrder.items.map((item) => ({
      amount: Number(item.amount),
      billId: item.billId,
      billNo: item.bill.billNo,
      billStatus: item.bill.billStatus,
      billType: item.bill.billType,
      dueDate: toIsoDateTime(item.bill.dueDate),
      id: item.id,
      orderNo: item.bill.order.orderNo,
      paidAmount: Number(item.bill.paidAmount),
      remainingAmount: Number(item.bill.remainingAmount)
    })),
    orderId: paymentOrder.orderId,
    orderNo: paymentOrder.order?.orderNo ?? null,
    orderStatus: paymentOrder.order?.orderStatus ?? null,
    paidAmount: Number(paymentOrder.paidAmount),
    paidAt: toIsoDateTime(paymentOrder.paidAt),
    paymentChannel: paymentOrder.paymentChannel,
    paymentOrderNo: paymentOrder.paymentOrderNo,
    paymentRecord: paymentOrder.paymentRecord,
    paymentStatus: paymentOrder.paymentStatus,
    provider: paymentOrder.provider,
    providerPrepayId: paymentOrder.providerPrepayId,
    providerTradeNo: paymentOrder.providerTradeNo,
    providerTransactionId: paymentOrder.providerTransactionId,
    subject: paymentOrder.subject
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function assertSingleOrder(bills: PayableBill[]) {
  const orderIds = [...new Set(bills.map((bill) => bill.orderId))];
  if (orderIds.length !== 1) {
    throw new BadRequestException("同一支付单仅支持同一订单下的账单。");
  }
  return orderIds[0]!;
}

function buildPaymentSubject(bills: PayableBill[]) {
  const orderNo = bills[0]?.order.orderNo ?? "订单";
  return `${orderNo} 账单支付`;
}

function buildPaymentDescription(bills: PayableBill[]) {
  return bills.map((bill) => `${bill.billNo}/${bill.billType}`).join(", ");
}

function mapPaymentMethod(channel: PaymentChannel) {
  if (channel === PaymentChannel.ALIPAY_H5) {
    return PaymentMethod.ALIPAY;
  }
  if (channel === PaymentChannel.BANK_TRANSFER) {
    return PaymentMethod.BANK_TRANSFER;
  }
  return PaymentMethod.WECHAT;
}

function parseProviderType(provider: string) {
  const normalized = provider.toLowerCase();
  if (normalized === "mock") {
    return PaymentProviderType.MOCK;
  }
  if (normalized === "wechat_pay" || normalized === "wechat" || normalized === "wxpay") {
    return PaymentProviderType.WECHAT_PAY;
  }
  if (normalized === "alipay") {
    return PaymentProviderType.ALIPAY;
  }
  if (normalized === "bank_transfer") {
    return PaymentProviderType.BANK_TRANSFER;
  }
  return PaymentProviderType.OTHER;
}

function isPaidCallbackEvent(eventType?: string) {
  return !eventType || CALLBACK_PAID_EVENTS.has(eventType);
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isFuture(value?: Date | null) {
  return Boolean(value && value.getTime() > Date.now());
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function toIsoDateTime(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function toIsoDate(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
