import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  AuditAction,
  BillStatus,
  OrderStatus,
  PaymentMandateStatus,
  PaymentProviderType,
  Prisma
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo } from "../common/business-number";
import { CurrentCustomer, PortalRequestContext } from "../portal/portal-auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { AdminMandateQueryDto } from "./auto-debit.dto";
import { AutoDebitConfig } from "./auto-debit.config";
import { AutoDebitScheduler } from "./auto-debit.scheduler";
import {
  AUTO_DEBIT_CONFIG,
  MandateDebitProvider,
  MandateProviderResult,
  MANDATE_DEBIT_PROVIDER,
  ProviderSnapshot
} from "./auto-debit-provider";

const OPEN_MANDATE_STATUSES = [
  PaymentMandateStatus.PENDING,
  PaymentMandateStatus.ACTIVE,
  PaymentMandateStatus.SUSPENDED
];

const TERMINAL_MANDATE_STATUSES = new Set<PaymentMandateStatus>([
  PaymentMandateStatus.REVOKED,
  PaymentMandateStatus.EXPIRED,
  PaymentMandateStatus.FAILED
]);

@Injectable()
export class PaymentMandateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MANDATE_DEBIT_PROVIDER)
    private readonly provider: MandateDebitProvider,
    @Inject(AUTO_DEBIT_CONFIG)
    private readonly config: AutoDebitConfig,
    private readonly scheduler: AutoDebitScheduler,
    private readonly audit: AuditService
  ) {}

  getPortalAvailability() {
    return {
      enabled: this.config.enabled,
      provider: this.config.enabled ? "WECHAT_AUTO_DEBIT" : null
    };
  }

  async createPortalMandate(
    orderId: string,
    customer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.ensureEnabled();
    const pending = await this.createPendingMandate(
      orderId,
      customer.customerId,
      customer.customerAccountId
    );
    await this.writeAudit(AuditAction.CREATE, pending, customer.customerAccountId, context);

    let updated: MandateRecord;
    try {
      const result = await this.provider.createMandate({
        customerId: customer.customerId,
        mandateNo: pending.mandateNo,
        orderId,
        providerTemplateId: pending.providerTemplateId ?? "mock-auto-debit-template"
      });
      updated = await this.persistProviderResult(pending, result, {
        updatedBy: customer.customerAccountId
      });
    } catch (error) {
      const failed = await this.failPendingMandate(pending.id, error, customer.customerAccountId);
      await this.writeAudit(AuditAction.UPDATE, failed, customer.customerAccountId, context);
      throw new ServiceUnavailableException("支付授权服务暂不可用，请稍后重试。");
    }
    await this.writeAudit(AuditAction.UPDATE, updated, customer.customerAccountId, context);
    return portalMandate(updated);
  }

  async listPortalMandates(query: { orderId?: string }, customer: CurrentCustomer) {
    const records = await this.prisma.paymentMandate.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        customerId: customer.customerId,
        ...(query.orderId ? { orderId: query.orderId } : {})
      }
    });
    return records.map(portalMandate);
  }

  async listPortalAttempts(
    query: { billId?: string; orderId?: string },
    customer: CurrentCustomer
  ) {
    const records = await this.prisma.debitAttempt.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        customerId: customer.customerId,
        ...(query.billId ? { billId: query.billId } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {})
      }
    });
    return records.map(portalAttempt);
  }

  async revokePortalMandate(id: string, customer: CurrentCustomer, context: PortalRequestContext) {
    return this.revokeMandate(id, customer.customerId, customer.customerAccountId, context);
  }

  async listAdminMandates(query: AdminMandateQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where: Prisma.PaymentMandateWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.orderNo
        ? { order: { orderNo: { contains: query.orderNo.trim(), mode: "insensitive" } } }
        : {}),
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.paymentMandate.findMany({
        include: {
          customer: { select: { customerNo: true, name: true } },
          order: { select: { orderNo: true } }
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.paymentMandate.count({ where })
    ]);
    return { items: items.map(adminMandate), page, pageSize, total };
  }

  async syncAdminMandate(
    id: string,
    action: { reason: string },
    user: RequestUser,
    context: RequestContext
  ) {
    this.ensureEnabled();
    const current = await this.findMandateOrThrow(id);
    if (TERMINAL_MANDATE_STATUSES.has(current.status)) {
      throw new ConflictException("终态支付授权不可重新激活。");
    }
    const result = await this.provider.queryMandate({
      providerMandateId: requiredProviderMandateId(current.providerMandateId),
      providerSnapshot: providerSnapshot(current.responseSnapshot)
    });
    const updated = await this.persistProviderResult(current, result, {
      updatedBy: user.id
    });
    await this.writeAudit(AuditAction.UPDATE, updated, user.id, context, {
      reason: action.reason
    });
    return adminMandate(updated);
  }

  async revokeAdminMandate(
    id: string,
    action: { reason: string },
    user: RequestUser,
    context: RequestContext
  ) {
    return this.revokeMandate(id, undefined, user.id, context, {
      reason: action.reason
    });
  }

  private async createPendingMandate(orderId: string, customerId: string, actorId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.subscriptionOrder.findFirst({
          select: { customerId: true, id: true, orderNo: true, orderStatus: true },
          where: {
            customerId,
            deletedAt: null,
            id: orderId,
            orderStatus: OrderStatus.ACTIVE
          }
        });
        if (!order) {
          throw new NotFoundException("可开通自动扣款的订单不存在。");
        }
        const existing = await tx.paymentMandate.findFirst({
          select: { id: true },
          where: { orderId, status: { in: OPEN_MANDATE_STATUSES } }
        });
        if (existing) {
          throw new ConflictException("该订单已有待确认或生效中的支付授权。");
        }
        return tx.paymentMandate.create({
          data: {
            createdBy: actorId,
            customerId,
            mandateNo: createBusinessNo("MDT"),
            orderId,
            provider: providerType(this.config),
            providerMode: this.config.provider,
            providerTemplateId: this.config.wechatTemplateId,
            requestSnapshot: toJson({
              customerId,
              orderId,
              providerMode: this.config.provider
            }),
            status: PaymentMandateStatus.PENDING,
            updatedBy: actorId
          }
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("该订单已有待确认或生效中的支付授权。");
      }
      throw error;
    }
  }

  private async persistProviderResult(
    current: MandateRecord,
    result: MandateProviderResult,
    actor: { updatedBy: string }
  ) {
    const nextStatus = result.status as PaymentMandateStatus;
    assertMandateTransition(current.status, nextStatus);
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentMandate.update({
        data: {
          effectiveAt: result.effectiveAt,
          errorSnapshot:
            result.errorCode || result.errorMessage
              ? toJson({ code: result.errorCode, message: result.errorMessage })
              : Prisma.JsonNull,
          expiresAt: result.expiresAt,
          lastSyncedAt: now,
          providerMandateId: result.providerMandateId,
          responseSnapshot: toJson(result.providerSnapshot),
          signedAt: result.signedAt,
          status: nextStatus,
          suspendedAt: nextStatus === PaymentMandateStatus.SUSPENDED ? now : null,
          revokedAt: nextStatus === PaymentMandateStatus.REVOKED ? now : null,
          updatedBy: actor.updatedBy
        },
        where: { id: current.id }
      });
      if (nextStatus === PaymentMandateStatus.ACTIVE) {
        const bills = await tx.receivableBill.findMany({
          select: { dueDate: true, id: true, orderId: true },
          where: {
            billStatus: {
              in: [BillStatus.PENDING, BillStatus.PARTIALLY_PAID, BillStatus.OVERDUE]
            },
            deletedAt: null,
            orderId: current.orderId,
            remainingAmount: { gt: 0n }
          }
        });
        for (const bill of bills) {
          await this.scheduler.enqueueFutureForBill(tx, bill, now);
        }
      }
      return updated;
    });
  }

  private async failPendingMandate(id: string, error: unknown, updatedBy: string) {
    return this.prisma.paymentMandate.update({
      data: {
        errorSnapshot: toJson({ message: safeErrorMessage(error) }),
        lastSyncedAt: new Date(),
        status: PaymentMandateStatus.FAILED,
        updatedBy
      },
      where: { id }
    });
  }

  private async revokeMandate(
    id: string,
    customerId: string | undefined,
    actorId: string,
    context: RequestContext | PortalRequestContext,
    auditMetadata?: Record<string, unknown>
  ) {
    this.ensureEnabled();
    const current = await this.findMandateOrThrow(id, customerId);
    if (current.status === PaymentMandateStatus.REVOKED) {
      return customerId ? portalMandate(current) : adminMandate(current);
    }
    if (TERMINAL_MANDATE_STATUSES.has(current.status)) {
      throw new ConflictException("该支付授权已终止，不能重复解约。");
    }
    const result = await this.provider.revokeMandate({
      providerMandateId: requiredProviderMandateId(current.providerMandateId),
      providerSnapshot: providerSnapshot(current.responseSnapshot)
    });
    const updated = await this.persistProviderResult(current, result, {
      updatedBy: actorId
    });
    await this.writeAudit(AuditAction.UPDATE, updated, actorId, context, auditMetadata);
    return customerId ? portalMandate(updated) : adminMandate(updated);
  }

  private async findMandateOrThrow(id: string, customerId?: string) {
    const mandate = await this.prisma.paymentMandate.findUnique({
      where: { id }
    });
    if (!mandate || (customerId && mandate.customerId !== customerId)) {
      throw new NotFoundException("支付授权不存在。");
    }
    return mandate;
  }

  private ensureEnabled() {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException("自动扣款暂未开通。");
    }
  }

  private writeAudit(
    action: AuditAction,
    mandate: MandateRecord,
    operatorId: string,
    context: RequestContext | PortalRequestContext,
    metadata?: Record<string, unknown>
  ) {
    return this.audit.write({
      action,
      after: { ...auditMandate(mandate), ...(metadata ?? {}) },
      entityId: mandate.id,
      entityType: "payment_mandate",
      ipAddress: context.ipAddress,
      module: "auto_debit",
      operatorId,
      userAgent: context.userAgent
    });
  }
}

export function assertMandateTransition(current: PaymentMandateStatus, next: PaymentMandateStatus) {
  if (current === next) {
    return;
  }
  const allowed: Record<PaymentMandateStatus, PaymentMandateStatus[]> = {
    ACTIVE: [
      PaymentMandateStatus.SUSPENDED,
      PaymentMandateStatus.REVOKED,
      PaymentMandateStatus.EXPIRED
    ],
    EXPIRED: [],
    FAILED: [],
    PENDING: [
      PaymentMandateStatus.ACTIVE,
      PaymentMandateStatus.FAILED,
      PaymentMandateStatus.REVOKED,
      PaymentMandateStatus.EXPIRED
    ],
    REVOKED: [],
    SUSPENDED: [
      PaymentMandateStatus.ACTIVE,
      PaymentMandateStatus.REVOKED,
      PaymentMandateStatus.EXPIRED
    ]
  };
  if (!allowed[current].includes(next)) {
    throw new ConflictException(`支付授权状态不可从 ${current} 变更为 ${next}。`);
  }
}

type MandateRecord = Prisma.PaymentMandateGetPayload<Record<string, never>>;

function portalMandate(record: MandateRecord) {
  return {
    effectiveAt: record.effectiveAt,
    expiresAt: record.expiresAt,
    id: record.id,
    mandateNo: record.mandateNo,
    orderId: record.orderId,
    provider: record.provider,
    providerMode: record.providerMode,
    providerReference: maskReference(record.providerMandateId),
    revokedAt: record.revokedAt,
    signedAt: record.signedAt,
    status: record.status
  };
}

function portalAttempt(record: Prisma.DebitAttemptGetPayload<Record<string, never>>) {
  return {
    acceptedAt: record.acceptedAt,
    billId: record.billId,
    confirmedAmount: record.confirmedAmount.toString(),
    createdAt: record.createdAt,
    debitAttemptNo: record.debitAttemptNo,
    id: record.id,
    orderId: record.orderId,
    requestedAmount: record.requestedAmount.toString(),
    resolvedAt: record.resolvedAt,
    retrySlot: record.retrySlot,
    status: record.status
  };
}

function adminMandate(record: MandateRecord & Record<string, unknown>) {
  return {
    ...portalMandate(record),
    customer: record.customer,
    customerId: record.customerId,
    lastSyncedAt: record.lastSyncedAt,
    order: record.order,
    providerMandateId: record.providerMandateId,
    providerTemplateId: record.providerTemplateId
  };
}

function auditMandate(record: MandateRecord) {
  return {
    customerId: record.customerId,
    mandateNo: record.mandateNo,
    orderId: record.orderId,
    provider: record.provider,
    providerMode: record.providerMode,
    status: record.status
  };
}

function providerType(config: AutoDebitConfig) {
  return config.provider === "mock" ? PaymentProviderType.MOCK : PaymentProviderType.WECHAT_PAY;
}

function maskReference(value: string | null) {
  if (!value) {
    return null;
  }
  const visible = value.slice(-6);
  return `${"*".repeat(Math.max(4, value.length - visible.length))}${visible}`;
}

function providerSnapshot(value: Prisma.JsonValue | null): ProviderSnapshot {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ConflictException("支付授权缺少可查询的渠道快照。");
  }
  return value as ProviderSnapshot;
}

function requiredProviderMandateId(value: string | null) {
  if (!value) {
    throw new ConflictException("支付授权尚未取得渠道协议编号。");
  }
  return value;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 512) : "UNKNOWN_ERROR";
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
