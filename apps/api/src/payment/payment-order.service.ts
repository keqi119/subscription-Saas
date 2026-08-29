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
  PaymentOrderStatus,
  PaymentProviderType,
  Prisma,
  UserStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { planPortalBucketPage } from "../common/portal-list-ordering";
import { FinanceService } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer } from "../portal/portal-auth.types";
import { PortalPaymentOrdersQueryDto } from "../portal/portal-billing.dto";
import { WeChatOAuthService } from "../wechat/wechat-oauth.service";
import { CreatePortalPaymentOrderDto, PortalPayableBillsQueryDto } from "./payment.dto";
import { PAYMENT_PROVIDER_CLIENT, PaymentProvider, WeChatJsapiPaymentParams } from "./payment-provider";
import { readPaymentRuntimeConfigFromConfig } from "./payment-runtime.config";

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

const PORTAL_PAYMENT_ORDER_BUCKETS = [
  {
    bucket: "ACTION" as const,
    statuses: [PaymentOrderStatus.CREATED, PaymentOrderStatus.PENDING]
  },
  {
    bucket: "HISTORY" as const,
    statuses: [
      PaymentOrderStatus.PAID,
      PaymentOrderStatus.FAILED,
      PaymentOrderStatus.CLOSED,
      PaymentOrderStatus.CANCELLED,
      PaymentOrderStatus.EXPIRED
    ]
  }
] as const;

const CALLBACK_PAID_EVENTS = new Set([
  "PAID",
  "PAYMENT_SUCCESS",
  "PAY_SUCCESS",
  "TRANSACTION_SUCCESS",
  "SUCCESS",
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
    private readonly wechatOAuthService: WeChatOAuthService,
    private readonly prisma: PrismaService
  ) {}

  async closeActivePaymentOrdersForBills(billIds: readonly string[], reason: string) {
    const normalizedBillIds = uniqueStrings([...billIds]);
    if (normalizedBillIds.length === 0) {
      return { closedPaymentOrderIds: [] as string[] };
    }
    const activeOrders = await this.prisma.paymentOrder.findMany({
      include: paymentOrderInclude,
      orderBy: { createdAt: "asc" },
      where: {
        debitAttempt: { is: null },
        deletedAt: null,
        items: { some: { billId: { in: normalizedBillIds }, deletedAt: null } },
        paymentStatus: { in: REUSABLE_PAYMENT_ORDER_STATUSES }
      }
    });
    const closedPaymentOrderIds: string[] = [];
    for (const paymentOrder of activeOrders) {
      const closed = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "payment_order" WHERE "id" = ${paymentOrder.id}::uuid FOR UPDATE`
        );
        const locked = await tx.paymentOrder.findFirst({
          select: {
            cashierUrl: true,
            id: true,
            paymentOrderNo: true,
            paymentStatus: true,
            provider: true,
            providerPrepayId: true,
            providerTradeNo: true
          },
          where: { deletedAt: null, id: paymentOrder.id }
        });
        if (!locked) return false;
        if (locked.paymentStatus === PaymentOrderStatus.PAID) {
          throw new BadRequestException("PAYMENT_SETTLED_DURING_CLOSE");
        }
        if (!REUSABLE_PAYMENT_ORDER_STATUSES.includes(locked.paymentStatus)) return false;
        if (locked.provider !== this.providerType) {
          throw new BadRequestException("PAYMENT_PROVIDER_CLOSE_UNAVAILABLE");
        }
        const remoteTransactionExists = !(
          locked.paymentStatus === PaymentOrderStatus.CREATED &&
          !locked.providerTradeNo &&
          !locked.providerPrepayId &&
          !locked.cashierUrl
        );
        if (remoteTransactionExists) {
          await this.provider.closePayment({
            providerTradeNo: locked.providerTradeNo ?? locked.paymentOrderNo
          });
        }
        await tx.paymentOrder.update({
          data: {
            cashierUrl: null,
            cashierUrlExpiresAt: null,
            closedAt: new Date(),
            errorSnapshot: toJsonValue({ code: "GOVERNED_PAYMENT_ORDER_CLOSED", reason }),
            paymentStatus: PaymentOrderStatus.CLOSED
          },
          where: { id: locked.id }
        });
        return true;
      });
      if (closed) closedPaymentOrderIds.push(paymentOrder.id);
    }
    return { closedPaymentOrderIds: closedPaymentOrderIds.sort() };
  }

  async listPayableBills(currentCustomer: CurrentCustomer, query: PortalPayableBillsQueryDto) {
    const bills = await this.prisma.receivableBill.findMany({
      include: {
        order: { select: { id: true, orderNo: true, orderStatus: true } }
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      where: {
        billStatus: { in: PAYABLE_BILL_STATUSES },
        closureChargeLines: {
          none: {
            disputes: {
              some: {
                OR: [
                  { decision: null, status: "OPEN" },
                  { decision: { decision: "ACCEPTED_BY_PLATFORM" } }
                ]
              }
            }
          }
        },
        closureLegalCollectionCases: { none: { closedAt: null } },
        closureReceivableDispositions: {
          none: { disposition: "LEGAL_COLLECTION", supersededBy: null }
        },
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
    const billIds = uniqueStrings(dto.billIds);
    const paymentChannel = dto.paymentChannel ?? this.defaultPaymentChannel;
    this.assertPaymentProviderAvailable(paymentChannel);

    const bills = await this.loadPayableBillsForPayment(currentCustomer.customerId, billIds);
    this.assertBillsCanCreatePaymentOrder(bills, billIds);
    const blockedDispute = await this.prisma.subscriptionClosureChargeDispute.findFirst({
      select: { chargeLineId: true },
      where: {
        chargeLine: { billId: { in: billIds } },
        OR: [
          { decision: null },
          { decision: { decision: "ACCEPTED_BY_PLATFORM" } }
        ]
      }
    });
    if (blockedDispute) {
      throw new BadRequestException(
        "Disputed closure bills cannot be paid until the platform rejects the dispute or publishes an adjusted successor settlement."
      );
    }
    const [governedDisposition, openLegalCase] = await Promise.all([
      this.prisma.subscriptionClosureReceivableDisposition.findFirst({
        select: { id: true },
        where: {
          billId: { in: billIds },
          disposition: "LEGAL_COLLECTION",
          supersededBy: null
        }
      }),
      this.prisma.subscriptionClosureLegalCollectionCase.findFirst({
        select: { id: true },
        where: { billId: { in: billIds }, closedAt: null }
      })
    ]);
    if (governedDisposition || openLegalCase) {
      throw new BadRequestException(
        "Bills transferred to legal collection cannot be paid through the customer portal."
      );
    }

    const existing = await this.findReusablePaymentOrder(currentCustomer.customerId, billIds, paymentChannel);
    if (existing) {
      if (existing.cashierUrl && isFuture(existing.cashierUrlExpiresAt)) {
        return toPaymentOrderView(existing);
      }
      return this.refreshProviderPayment(existing.id, context, currentCustomer);
    }

    const paymentOrderResult = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const sortedBillIds = [...billIds].sort();
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" IN (${Prisma.join(
            sortedBillIds.map((id) => Prisma.sql`${id}::uuid`)
          )}) ORDER BY "id" FOR UPDATE`
        );
        const lockedBills = await tx.receivableBill.findMany({
          include: { order: { select: { id: true, orderNo: true, orderStatus: true } } },
          orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
          where: {
            customerId: currentCustomer.customerId,
            deletedAt: null,
            id: { in: billIds }
          }
        });
        this.assertBillsCanCreatePaymentOrder(lockedBills, billIds);
        const [lockedDispute, lockedLegalDisposition, lockedLegalCase] = await Promise.all([
          tx.subscriptionClosureChargeDispute.findFirst({
            select: { id: true },
            where: {
              chargeLine: { billId: { in: billIds } },
              OR: [{ decision: null }, { decision: { decision: "ACCEPTED_BY_PLATFORM" } }]
            }
          }),
          tx.subscriptionClosureReceivableDisposition.findFirst({
            select: { id: true },
            where: {
              billId: { in: billIds },
              disposition: "LEGAL_COLLECTION",
              supersededBy: null
            }
          }),
          tx.subscriptionClosureLegalCollectionCase.findFirst({
            select: { id: true },
            where: { billId: { in: billIds }, closedAt: null }
          })
        ]);
        if (lockedDispute || lockedLegalDisposition || lockedLegalCase) {
          throw new BadRequestException(
            "The selected closure bills are under dispute or legal collection and cannot be paid through the customer portal."
          );
        }
        const reusableCandidates = await tx.paymentOrder.findMany({
          include: paymentOrderInclude,
          orderBy: { createdAt: "desc" },
          where: {
            customerId: currentCustomer.customerId,
            debitAttempt: { is: null },
            deletedAt: null,
            paymentChannel,
            paymentStatus: { in: REUSABLE_PAYMENT_ORDER_STATUSES }
          }
        });
        const reusable = reusableCandidates.find((candidate) =>
          arraysEqual(
            sortedBillIds,
            candidate.items.map((item) => item.billId).sort()
          )
        );
        if (reusable) return { created: false, paymentOrder: reusable };

        const orderId = assertSingleOrder(lockedBills);
        const amount = lockedBills.reduce((sum, bill) => sum + bill.remainingAmount, 0n);
        const paymentOrder = await tx.paymentOrder.create({
          data: {
            amount,
            clientIp: context.ipAddress,
            customerId: currentCustomer.customerId,
            description: buildPaymentDescription(lockedBills),
            items: {
              create: lockedBills.map((bill) => ({
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
            subject: buildPaymentSubject(lockedBills),
            userAgent: context.userAgent
          },
          include: paymentOrderInclude
        });
        return { created: true, paymentOrder };
      })
    );
    const paymentOrder = paymentOrderResult.paymentOrder;

    if (!paymentOrderResult.created) {
      if (paymentOrder.cashierUrl && isFuture(paymentOrder.cashierUrlExpiresAt)) {
        return toPaymentOrderView(paymentOrder);
      }
      return this.refreshProviderPayment(paymentOrder.id, context, currentCustomer);
    }

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toPaymentOrderView(paymentOrder),
      entityId: paymentOrder.id,
      entityType: "payment_order",
      ipAddress: context.ipAddress,
      module: "payment",
      userAgent: context.userAgent
    });

    return this.refreshProviderPayment(paymentOrder.id, context, currentCustomer);
  }

  async getPortalPaymentOrder(id: string, currentCustomer: CurrentCustomer) {
    const paymentOrder = await this.findPortalPaymentOrderOrThrow(id, currentCustomer.customerId);
    return toPaymentOrderView(paymentOrder);
  }

  async listPortalPaymentOrders(currentCustomer: CurrentCustomer, query: PortalPaymentOrdersQueryDto) {
    const { page, pageSize, skip } = resolvePagination(query);
    const baseWhere: Prisma.PaymentOrderWhereInput = {
      customerId: currentCustomer.customerId,
      debitAttempt: { is: null },
      deletedAt: null,
      orderId: query.orderId,
      paymentChannel: { not: PaymentChannel.WECHAT_AUTO_DEBIT }
    };
    const buckets: Array<{
      bucket: "ACTION" | "HISTORY";
      statuses: PaymentOrderStatus[];
    }> = query.paymentStatus
      ? [{
          bucket: PAYABLE_PAYMENT_ORDER_STATUSES.has(query.paymentStatus)
            ? "ACTION"
            : "HISTORY",
          statuses: [query.paymentStatus]
        }]
      : PORTAL_PAYMENT_ORDER_BUCKETS.map(({ bucket, statuses }) => ({
          bucket,
          statuses: [...statuses]
        }));

    return this.prisma.$transaction(async (tx) => {
      const counts = await Promise.all(
        buckets.map(({ statuses }) =>
          tx.paymentOrder.count({
            where: { ...baseWhere, paymentStatus: { in: statuses } }
          })
        )
      );
      const slices = planPortalBucketPage(
        buckets.map(({ bucket }, index) => ({ bucket, count: counts[index] ?? 0 })),
        skip,
        pageSize
      );
      const pages = await Promise.all(
        slices.map((slice) => {
          const bucket = buckets.find((candidate) => candidate.bucket === slice.bucket)!;
          return tx.paymentOrder.findMany({
            include: paymentOrderInclude,
            orderBy: slice.bucket === "ACTION"
              ? [
                  { cashierUrlExpiresAt: { sort: "asc", nulls: "last" } },
                  { updatedAt: "desc" },
                  { createdAt: "desc" },
                  { id: "asc" }
                ]
              : [
                  { updatedAt: "desc" },
                  { createdAt: "desc" },
                  { id: "asc" }
                ],
            skip: slice.skip,
            take: slice.take,
            where: { ...baseWhere, paymentStatus: { in: bucket.statuses } }
          });
        })
      );
      const total = counts.reduce((sum, count) => sum + count, 0);

      return {
        items: pages.flat().map((paymentOrder) => toPaymentOrderView(paymentOrder)),
        page,
        pageSize,
        total
      };
    });
  }

  async startPortalPayment(id: string, currentCustomer: CurrentCustomer, context: RequestContext) {
    const paymentOrder = await this.findPortalPaymentOrderOrThrow(id, currentCustomer.customerId);
    this.assertPaymentProviderAvailable(paymentOrder.paymentChannel);
    if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
      return toPaymentOrderView(paymentOrder);
    }
    if (!PAYABLE_PAYMENT_ORDER_STATUSES.has(paymentOrder.paymentStatus)) {
      throw new BadRequestException("当前支付单状态不允许继续支付。");
    }
    const billIds = paymentOrder.items.map((item) => item.billId);
    const [blockedDispute, governedDisposition, openLegalCase] = await Promise.all([
      this.prisma.subscriptionClosureChargeDispute.findFirst({
        select: { id: true },
        where: {
          chargeLine: { billId: { in: billIds } },
          OR: [{ decision: null }, { decision: { decision: "ACCEPTED_BY_PLATFORM" } }]
        }
      }),
      this.prisma.subscriptionClosureReceivableDisposition.findFirst({
        select: { id: true },
        where: {
          billId: { in: billIds },
          disposition: "LEGAL_COLLECTION",
          supersededBy: null
        }
      }),
      this.prisma.subscriptionClosureLegalCollectionCase.findFirst({
        select: { id: true },
        where: { billId: { in: billIds }, closedAt: null }
      })
    ]);
    if (blockedDispute || governedDisposition || openLegalCase) {
      throw new BadRequestException(
        "The selected closure bills are under dispute or legal collection and cannot be paid through the customer portal."
      );
    }
    if (paymentOrder.cashierUrl && isFuture(paymentOrder.cashierUrlExpiresAt)) {
      return toPaymentOrderView(paymentOrder);
    }
    return this.refreshProviderPayment(paymentOrder.id, context, currentCustomer);
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

  async handleCallback(
    provider: string,
    payload: unknown,
    headers?: Record<string, unknown>,
    rawBody?: Buffer
  ) {
    const providerType = parseProviderType(provider);
    const sanitizedPayload = sanitizePaymentCallbackPayload(payload);
    const callbackLog = await this.prisma.paymentCallbackLog.create({
      data: {
        payload: toJsonValue(sanitizedPayload),
        provider: providerType
      }
    });

    try {
      const runtimeConfig = readPaymentRuntimeConfigFromConfig(this.configService);
      if (providerType !== runtimeConfig.providerType) {
        return this.rejectCallback(callbackLog.id, "PAYMENT_CALLBACK_PROVIDER_MISMATCH");
      }
      if (providerType === PaymentProviderType.MOCK && !runtimeConfig.mockEnabled) {
        return this.rejectCallback(callbackLog.id, "PAYMENT_CALLBACK_MOCK_DISABLED");
      }

      const result = await this.provider.verifyCallback(payload, headers, rawBody);
      await this.prisma.paymentCallbackLog.update({
        data: {
          errorMessage: result.errorMessage,
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

      const paymentOrder = await this.findPaymentOrderByProviderRefs(result, providerType);
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
        callbackPayload: sanitizedPayload,
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

  private async refreshProviderPayment(
    paymentOrderId: string,
    context: RequestContext,
    currentCustomer?: CurrentCustomer
  ) {
    const paymentOrder = await this.findPaymentOrderOrThrow(paymentOrderId);
    if (paymentOrder.paymentStatus === PaymentOrderStatus.PAID) {
      return toPaymentOrderView(paymentOrder);
    }

    let openId: string | undefined;
    if (paymentOrder.paymentChannel === PaymentChannel.WECHAT_JSAPI) {
      if (!currentCustomer) {
        throw new BadRequestException("WECHAT_OPENID_REQUIRED");
      }
      openId = await this.wechatOAuthService.getOpenId(currentCustomer) ?? undefined;
      if (!openId) {
        const binding = await this.wechatOAuthService.createOAuthUrl(
          currentCustomer,
          this.buildReturnUrl(paymentOrder.id)
        );
        return toPaymentOrderView(paymentOrder, {
          requiresWechatBinding: true,
          wechatAuthUrl: binding.authUrl,
          wechatBindingExpiresIn: binding.expiresIn
        });
      }
    }

    const result = await this.provider.createPayment({
      amount: paymentOrder.amount,
      clientIp: context.ipAddress,
      description: paymentOrder.description ?? undefined,
      notifyUrl: this.buildNotifyUrl(paymentOrder.provider),
      openId,
      paymentOrderId: paymentOrder.id,
      paymentOrderNo: paymentOrder.paymentOrderNo,
      returnUrl: this.buildReturnUrl(paymentOrder.id),
      subject: paymentOrder.subject ?? undefined
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "payment_order" WHERE "id" = ${paymentOrder.id}::uuid FOR UPDATE`
      );
      const current = await tx.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, id: paymentOrder.id }
      });
      if (
        !current ||
        current.paymentStatus !== paymentOrder.paymentStatus ||
        current.updatedAt.getTime() !== paymentOrder.updatedAt.getTime()
      ) {
        return null;
      }
      return tx.paymentOrder.update({
        data: {
          cashierUrl: result.cashierUrl,
          cashierUrlExpiresAt: result.cashierUrlExpiresAt,
          providerPrepayId: result.providerPrepayId,
          providerTradeNo: result.providerTradeNo,
          paymentStatus: PaymentOrderStatus.PENDING,
          responseSnapshot:
            result.rawResponse === undefined ? undefined : toJsonValue(result.rawResponse),
          updatedAt: new Date()
        },
        include: paymentOrderInclude,
        where: { id: paymentOrder.id }
      });
    });
    if (!updated) {
      await this.provider.closePayment({
        providerTradeNo: result.providerTradeNo ?? paymentOrder.paymentOrderNo
      });
      throw new BadRequestException("PAYMENT_ORDER_CLOSED_DURING_PROVIDER_CREATE");
    }

    return toPaymentOrderView(updated, { jsapiParams: result.jsapiParams });
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
    if (
      !PAYABLE_PAYMENT_ORDER_STATUSES.has(paymentOrder.paymentStatus) &&
      !(options.callbackLogId && paymentOrder.paymentStatus === PaymentOrderStatus.CLOSED)
    ) {
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
    await this.financeService.settlePaymentOrder({
      callbackLogId: options.callbackLogId,
      callbackPayload: options.callbackPayload,
      eventType: options.eventType,
      ipAddress: context.ipAddress,
      operatorId: operator.id,
      paidAmount,
      paidAt,
      paymentOrderId: paymentOrder.id,
      providerTradeNo:
        options.providerTradeNo ?? paymentOrder.providerTradeNo ?? undefined,
      providerTransactionId:
        options.providerTransactionId ??
        paymentOrder.providerTransactionId ??
        undefined,
      userAgent: context.userAgent
    });
    const updated = await this.findPaymentOrderOrThrow(paymentOrder.id);
    return toPaymentOrderView(updated);
  }

  private async findPortalPaymentOrderOrThrow(id: string, customerId: string) {
    const paymentOrder = await this.prisma.paymentOrder.findFirst({
      include: paymentOrderInclude,
      where: {
        customerId,
        debitAttempt: { is: null },
        deletedAt: null,
        id,
        paymentChannel: { not: PaymentChannel.WECHAT_AUTO_DEBIT }
      }
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

  private async findReusablePaymentOrder(customerId: string, billIds: string[], paymentChannel: PaymentChannel) {
    const sortedBillIds = [...billIds].sort();
    const candidates = await this.prisma.paymentOrder.findMany({
      include: paymentOrderInclude,
      orderBy: { createdAt: "desc" },
      where: {
        customerId,
        debitAttempt: { is: null },
        deletedAt: null,
        paymentChannel,
        paymentStatus: { in: REUSABLE_PAYMENT_ORDER_STATUSES }
      }
    });

    return candidates.find((candidate) => {
      const candidateBillIds = candidate.items.map((item) => item.billId).sort();
      return arraysEqual(sortedBillIds, candidateBillIds);
    }) ?? null;
  }

  private async findPaymentOrderByProviderRefs(
    result: { providerTradeNo?: string; providerTransactionId?: string },
    provider: PaymentProviderType
  ) {
    if (result.providerTradeNo) {
      const byTradeNo = await this.prisma.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, provider, providerTradeNo: result.providerTradeNo }
      });
      if (byTradeNo) {
        return byTradeNo;
      }

      const byPaymentOrderNo = await this.prisma.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, paymentOrderNo: result.providerTradeNo, provider }
      });
      if (byPaymentOrderNo) {
        return byPaymentOrderNo;
      }
    }

    if (result.providerTransactionId) {
      return this.prisma.paymentOrder.findFirst({
        include: paymentOrderInclude,
        where: { deletedAt: null, provider, providerTransactionId: result.providerTransactionId }
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

  private async rejectCallback(callbackLogId: string, errorMessage: string) {
    await this.prisma.paymentCallbackLog.update({
      data: {
        errorMessage,
        verified: false
      },
      where: { id: callbackLogId }
    });

    return { handled: false, received: true, verified: false };
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

  private assertPaymentProviderAvailable(paymentChannel: PaymentChannel) {
    if (paymentChannel === PaymentChannel.MOCK) {
      this.assertMockProviderAvailable();
      return;
    }
    if (paymentChannel === PaymentChannel.WECHAT_JSAPI) {
      if (this.providerType !== PaymentProviderType.WECHAT_PAY || !this.wechatPayEnabled) {
        throw new ForbiddenException("WECHAT_PAY_NOT_ENABLED");
      }
      return;
    }
    throw new BadRequestException("PAYMENT_CHANNEL_NOT_SUPPORTED");
  }

  private buildNotifyUrl(provider: PaymentProviderType) {
    if (provider === PaymentProviderType.WECHAT_PAY) {
      return this.configService.get<string>("WECHAT_PAY_NOTIFY_URL")
        ?? `${this.apiBaseUrl}/payments/callback/wechat-pay`;
    }
    return `${this.apiBaseUrl}/payments/callback/mock`;
  }

  private get apiBaseUrl() {
    const apiBaseUrl = trimTrailingSlash(
      this.configService.get<string>("API_BASE_URL") ?? "http://localhost:3001/api"
    );
    return apiBaseUrl;
  }

  private buildReturnUrl(paymentOrderId: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    return `${portalBaseUrl}/portal/payment-orders/${encodeURIComponent(paymentOrderId)}`;
  }

  private get mockEnabled() {
    return readPaymentRuntimeConfigFromConfig(this.configService).mockEnabled;
  }

  private get wechatPayEnabled() {
    return readPaymentRuntimeConfigFromConfig(this.configService).wechatPayEnabled;
  }

  private get defaultPaymentChannel() {
    return readPaymentRuntimeConfigFromConfig(this.configService).defaultChannel;
  }

  private get providerType() {
    return readPaymentRuntimeConfigFromConfig(this.configService).providerType;
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

function toPaymentOrderView(
  paymentOrder: PaymentOrderWithDetails,
  extra: {
    jsapiParams?: WeChatJsapiPaymentParams;
    requiresWechatBinding?: boolean;
    wechatAuthUrl?: string;
    wechatBindingExpiresIn?: number;
  } = {}
) {
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
    jsapiParams: extra.jsapiParams,
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
    requiresWechatBinding: extra.requiresWechatBinding ?? false,
    subject: paymentOrder.subject,
    wechatAuthUrl: extra.wechatAuthUrl,
    wechatBindingExpiresIn: extra.wechatBindingExpiresIn
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function resolvePagination(query: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
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

function parseProviderType(provider: string) {
  const normalized = provider.toLowerCase();
  if (normalized === "mock") {
    return PaymentProviderType.MOCK;
  }
  if (normalized === "wechat_pay" || normalized === "wechat-pay" || normalized === "wechat" || normalized === "wxpay") {
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
  return Boolean(eventType && CALLBACK_PAID_EVENTS.has(eventType));
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

const SENSITIVE_CALLBACK_KEYS = new Set([
  "associated_data",
  "authorization",
  "certificate",
  "ciphertext",
  "credential",
  "nonce",
  "openid",
  "payer",
  "private_key",
  "secret",
  "signature",
  "token"
]);

function sanitizePaymentCallbackPayload(
  value: unknown,
  key = "",
  depth = 0
): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    SENSITIVE_CALLBACK_KEYS.has(normalizedKey) ||
    normalizedKey.endsWith("_url") ||
    normalizedKey.endsWith("url")
  ) {
    return "[REDACTED]";
  }
  if (depth >= 8) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizePaymentCallbackPayload(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizePaymentCallbackPayload(entryValue, entryKey, depth + 1)
      ])
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value ?? "");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
