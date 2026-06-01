import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ApplicationStatus,
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractVersionStatus,
  OrderChangeStatus,
  OrderChangeType,
  OrderStatus,
  Prisma,
  QuoteStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  ArchiveContractDto,
  CancelOrderDto,
  CreateContractVersionDto,
  CreateOrderChangeDto,
  CreateOrderFromQuoteDto,
  UpdateContractVersionDto
} from "./dto/order.dto";

const CURRENT_BUSINESS_TYPE = BusinessType.SUBSCRIPTION;
const RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE = "当前阶段暂未开放以租代购订单。";
const DISALLOWED_CHANGE_TYPES = new Set<OrderChangeType>([
  OrderChangeType.BUYOUT,
  OrderChangeType.EARLY_SETTLEMENT,
  OrderChangeType.OWNERSHIP_TRANSFER
]);

const orderInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  changes: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  contract: true,
  contracts: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  productVersion: { include: { product: true } },
  quote: { select: { id: true, quoteNo: true, status: true } },
  riskResult: true
} satisfies Prisma.SubscriptionOrderInclude;

const quoteInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  order: true,
  productVersion: { include: { product: true } },
  riskResult: true
} satisfies Prisma.SubscriptionQuoteInclude;

const contractInclude = {
  contractVersion: true,
  customer: { select: { id: true, mobile: true, name: true } },
  order: {
    include: {
      application: { select: { applicationNo: true, id: true, salesUserId: true } },
      quote: { select: { id: true, quoteNo: true } }
    }
  }
} satisfies Prisma.ContractInclude;

type OrderWithDetails = Prisma.SubscriptionOrderGetPayload<{ include: typeof orderInclude }>;
type QuoteWithDetails = Prisma.SubscriptionQuoteGetPayload<{ include: typeof quoteInclude }>;
type ContractWithDetails = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

@Injectable()
export class OrderService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService
  ) {}

  async listOrders(user: RequestUser) {
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      where: canViewAllOrders(user) ? { deletedAt: null } : { application: { salesUserId: user.id }, deletedAt: null }
    });
    return orders.map(toOrderView);
  }

  async getOrder(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    return toOrderView(order);
  }

  async createOrderFromQuote(
    quoteId: string,
    dto: CreateOrderFromQuoteDto,
    user: RequestUser,
    context: RequestContext
  ) {
    ensureSubscriptionBusinessType(dto.businessType);
    const quote = await this.prisma.subscriptionQuote.findUnique({
      include: quoteInclude,
      where: { id: quoteId }
    });
    if (!quote || quote.deletedAt) {
      throw new NotFoundException("Quote not found.");
    }
    ensureCanAccessQuote(quote, user);
    if (quote.status !== QuoteStatus.CONFIRMED || quote.cancelledAt || quote.expiredAt) {
      throw new BadRequestException("仅已确认且未取消、未过期的订阅报价可以创建订单。");
    }
    if (quote.application.status !== ApplicationStatus.APPROVED) {
      throw new BadRequestException("仅审批通过的进件报价可以创建订单。");
    }
    if (quote.productVersion.product.productType !== "SUBSCRIPTION") {
      throw new BadRequestException(RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE);
    }
    if (quote.order && !quote.order.deletedAt && quote.order.orderStatus !== OrderStatus.CANCELLED) {
      throw new BadRequestException("该报价已生成订单，请勿重复创建。");
    }

    const quoteSnapshot = toJsonValue(toPlain(quote));
    const order = await this.prisma.subscriptionOrder.create({
      data: {
        applicationId: quote.applicationId,
        businessType: CURRENT_BUSINESS_TYPE,
        createdBy: user.id,
        customerId: quote.customerId,
        depositAmount: quote.depositAmount,
        energyLimitCount: quote.energyLimitCount,
        energyLimitKwh: quote.energyLimitKwh,
        mileageLimitKm: quote.mileageLimitKm,
        monthlyFeeAmount: quote.monthlyFeeAmount,
        orderNo: await generateBusinessNo(this.prisma, "subscriptionOrder", "ORD"),
        orderStatus: OrderStatus.PENDING_CONTRACT,
        overMileageFeeAmount: quote.overMileageFeeAmount,
        periodMonths: quote.periodMonths,
        productId: quote.productId,
        productVersionId: quote.productVersionId,
        quoteId: quote.id,
        quoteSnapshot,
        riskResultId: quote.riskResultId,
        updatedBy: user.id,
        vehicleModel: quote.vehicleModel,
        vehiclePurchasePriceAmount: quote.vehiclePurchasePriceAmount
      },
      include: orderInclude
    });

    await this.writeAudit(AuditAction.CREATE, "subscription_order", order.id, undefined, toOrderView(order), user, context);
    return toOrderView(order);
  }

  async cancelOrder(id: string, dto: CancelOrderDto, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(id);
    const cancellableStatuses: OrderStatus[] = [
      OrderStatus.PENDING_CONTRACT,
      OrderStatus.PENDING_SIGN,
      OrderStatus.PENDING_PAYMENT
    ];
    if (!cancellableStatuses.includes(before.orderStatus)) {
      throw new BadRequestException("当前订单状态不允许取消。");
    }
    const order = await this.prisma.subscriptionOrder.update({
      data: { orderStatus: OrderStatus.CANCELLED, updatedBy: user.id },
      include: orderInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "subscription_order", id, { ...toOrderView(before), reason: dto.reason }, toOrderView(order), user, context);
    return toOrderView(order);
  }

  async generateContract(orderId: string, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(orderId);
    if (before.businessType !== BusinessType.SUBSCRIPTION) {
      throw new BadRequestException(RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE);
    }
    if (before.orderStatus !== OrderStatus.PENDING_CONTRACT) {
      throw new BadRequestException("仅待生成合同的订单可以生成合同。");
    }
    const existing = before.contracts.find((contract) => contract.status !== ContractStatus.CANCELLED);
    if (existing || before.contractId) {
      throw new BadRequestException("该订单已生成有效合同。");
    }
    const template = await this.prisma.contractVersion.findFirst({
      orderBy: { effectiveFrom: "desc" },
      where: {
        businessType: BusinessType.SUBSCRIPTION,
        deletedAt: null,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
        status: ContractVersionStatus.ACTIVE
      }
    });
    if (!template) {
      throw new BadRequestException("未找到生效中的订阅合同模板。");
    }
    const contractSnapshot = toJsonValue({
      contentTemplate: template.contentTemplate,
      customer: before.customer,
      order: toOrderView(before),
      quoteSnapshot: before.quoteSnapshot
    });

    const contract = await this.prisma.$transaction(async (tx) => {
      const created = await tx.contract.create({
        data: {
          businessType: BusinessType.SUBSCRIPTION,
          contractNo: await generateBusinessNo(tx, "contract", "CON"),
          contractSnapshot,
          contractTitle: `${template.templateName} ${template.versionNo}`,
          contractVersionId: template.id,
          createdBy: user.id,
          customerId: before.customerId,
          orderId: before.id,
          status: ContractStatus.GENERATED,
          updatedBy: user.id
        }
      });
      await tx.subscriptionOrder.update({
        data: { contractId: created.id, orderStatus: OrderStatus.PENDING_SIGN, updatedBy: user.id },
        where: { id: before.id }
      });
      return tx.contract.findUniqueOrThrow({ include: contractInclude, where: { id: created.id } });
    });

    await this.writeAudit(AuditAction.CREATE, "contract", contract.id, toOrderView(before), toContractView(contract), user, context);
    return toContractView(contract);
  }

  async listContracts(user: RequestUser) {
    const contracts = await this.prisma.contract.findMany({
      include: contractInclude,
      orderBy: { createdAt: "desc" },
      where: canViewAllOrders(user) ? { deletedAt: null } : { deletedAt: null, order: { application: { salesUserId: user.id } } }
    });
    return contracts.map(toContractView);
  }

  async getContract(id: string, user: RequestUser) {
    const contract = await this.findContractOrThrow(id);
    ensureCanAccessContract(contract, user);
    return toContractView(contract);
  }

  async signContract(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findContractOrThrow(id);
    const signableStatuses: ContractStatus[] = [ContractStatus.GENERATED, ContractStatus.SIGNING];
    if (!signableStatuses.includes(before.status)) {
      throw new BadRequestException("当前合同状态不允许签署。");
    }
    const contract = await this.prisma.$transaction(async (tx) => {
      await tx.contract.update({
        data: { signedAt: new Date(), status: ContractStatus.SIGNED, updatedBy: user.id },
        where: { id }
      });
      await tx.subscriptionOrder.update({
        data: { orderStatus: OrderStatus.PENDING_PAYMENT, updatedBy: user.id },
        where: { id: before.orderId }
      });
      return tx.contract.findUniqueOrThrow({ include: contractInclude, where: { id } });
    });
    await this.writeAudit(AuditAction.APPROVE, "contract", id, toContractView(before), toContractView(contract), user, context);
    return toContractView(contract);
  }

  async archiveContract(id: string, dto: ArchiveContractDto, user: RequestUser, context: RequestContext) {
    const before = await this.findContractOrThrow(id);
    if (before.status !== ContractStatus.SIGNED) {
      throw new BadRequestException("仅已签署合同可以归档。");
    }
    const contract = await this.prisma.contract.update({
      data: { archivedAt: new Date(), fileId: dto.fileId, status: ContractStatus.ARCHIVED, updatedBy: user.id },
      include: contractInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "contract", id, toContractView(before), toContractView(contract), user, context);
    return toContractView(contract);
  }

  async cancelContract(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findContractOrThrow(id);
    const cancellableStatuses: ContractStatus[] = [ContractStatus.GENERATED, ContractStatus.SIGNING];
    if (!cancellableStatuses.includes(before.status)) {
      throw new BadRequestException("当前合同状态不允许取消。");
    }
    const contract = await this.prisma.contract.update({
      data: { status: ContractStatus.CANCELLED, updatedBy: user.id },
      include: contractInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "contract", id, toContractView(before), toContractView(contract), user, context);
    return toContractView(contract);
  }

  async listContractVersions() {
    const versions = await this.prisma.contractVersion.findMany({
      orderBy: { createdAt: "desc" },
      where: { deletedAt: null }
    });
    return versions.map(toContractVersionView);
  }

  async getContractVersion(id: string) {
    return toContractVersionView(await this.findContractVersionOrThrow(id));
  }

  async createContractVersion(dto: CreateContractVersionDto, user: RequestUser, context: RequestContext) {
    ensureSubscriptionBusinessType(dto.businessType);
    const version = await this.prisma.contractVersion.create({
      data: {
        businessType: BusinessType.SUBSCRIPTION,
        contentTemplate: dto.contentTemplate,
        createdBy: user.id,
        effectiveFrom: parseDateOnly(dto.effectiveFrom, "effectiveFrom"),
        effectiveTo: dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null,
        status: dto.status ?? ContractVersionStatus.DRAFT,
        templateName: dto.templateName,
        templateType: dto.templateType ?? "SUBSCRIPTION_STANDARD",
        updatedBy: user.id,
        versionNo: dto.versionNo
      }
    });
    await this.writeAudit(AuditAction.CREATE, "contract_version", version.id, undefined, toContractVersionView(version), user, context);
    return toContractVersionView(version);
  }

  async updateContractVersion(id: string, dto: UpdateContractVersionDto, user: RequestUser, context: RequestContext) {
    const before = await this.findContractVersionOrThrow(id);
    const version = await this.prisma.contractVersion.update({
      data: {
        contentTemplate: dto.contentTemplate,
        effectiveFrom: dto.effectiveFrom ? parseDateOnly(dto.effectiveFrom, "effectiveFrom") : undefined,
        effectiveTo: dto.effectiveTo === undefined ? undefined : dto.effectiveTo ? parseDateOnly(dto.effectiveTo, "effectiveTo") : null,
        templateName: dto.templateName,
        updatedBy: user.id,
        versionNo: dto.versionNo
      },
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "contract_version", id, toContractVersionView(before), toContractVersionView(version), user, context);
    return toContractVersionView(version);
  }

  async setContractVersionStatus(id: string, status: ContractVersionStatus, user: RequestUser, context: RequestContext) {
    const before = await this.findContractVersionOrThrow(id);
    const version = await this.prisma.contractVersion.update({
      data: {
        approvedAt: status === ContractVersionStatus.ACTIVE ? new Date() : before.approvedAt,
        approvedBy: status === ContractVersionStatus.ACTIVE ? user.id : before.approvedBy,
        status,
        updatedBy: user.id
      },
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "contract_version", id, toContractVersionView(before), toContractVersionView(version), user, context);
    return toContractVersionView(version);
  }

  async listOrderChanges(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    return order.changes.map(toOrderChangeView);
  }

  async createOrderChange(orderId: string, dto: CreateOrderChangeDto, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    ensureAllowedChangeType(dto.changeType);
    const change = await this.prisma.orderChange.create({
      data: {
        afterSnapshot: toJsonValue(dto.afterSnapshot ?? {}),
        beforeSnapshot: toJsonValue(dto.beforeSnapshot ?? toOrderView(order)),
        changeType: dto.changeType,
        createdBy: user.id,
        orderId,
        reason: dto.reason,
        updatedBy: user.id
      }
    });
    await this.writeAudit(AuditAction.CREATE, "order_change", change.id, undefined, toOrderChangeView(change), user, context);
    return toOrderChangeView(change);
  }

  async setOrderChangeStatus(id: string, status: OrderChangeStatus, user: RequestUser, context: RequestContext) {
    const before = await this.prisma.orderChange.findUnique({ where: { id } });
    if (!before || before.deletedAt) {
      throw new NotFoundException("Order change not found.");
    }
    if (before.status !== OrderChangeStatus.PENDING) {
      throw new BadRequestException("仅待审批的订单变更可以处理。");
    }
    const change = await this.prisma.orderChange.update({
      data: { approvedAt: new Date(), approvedBy: user.id, status, updatedBy: user.id },
      where: { id }
    });
    await this.writeAudit(status === OrderChangeStatus.APPROVED ? AuditAction.APPROVE : AuditAction.REJECT, "order_change", id, toOrderChangeView(before), toOrderChangeView(change), user, context);
    return toOrderChangeView(change);
  }

  private async findOrderOrThrow(id: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({ include: orderInclude, where: { id } });
    if (!order || order.deletedAt) {
      throw new NotFoundException("Order not found.");
    }
    return order;
  }

  private async findContractOrThrow(id: string) {
    const contract = await this.prisma.contract.findUnique({ include: contractInclude, where: { id } });
    if (!contract || contract.deletedAt) {
      throw new NotFoundException("Contract not found.");
    }
    return contract;
  }

  private async findContractVersionOrThrow(id: string) {
    const version = await this.prisma.contractVersion.findUnique({ where: { id } });
    if (!version || version.deletedAt) {
      throw new NotFoundException("Contract version not found.");
    }
    return version;
  }

  private async writeAudit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after,
      before,
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: entityType.startsWith("contract") ? "contract" : "order",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

export function ensureSubscriptionBusinessType(businessType?: BusinessType | null) {
  if (!businessType) {
    return CURRENT_BUSINESS_TYPE;
  }
  if (businessType !== CURRENT_BUSINESS_TYPE) {
    throw new BadRequestException(RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE);
  }
  return businessType;
}

export function ensureAllowedChangeType(changeType: OrderChangeType) {
  if (DISALLOWED_CHANGE_TYPES.has(changeType)) {
    throw new BadRequestException("当前阶段暂未开放以租代购订单变更类型。");
  }
}

async function generateBusinessNo(
  tx: Pick<Prisma.TransactionClient, "subscriptionOrder" | "contract">,
  table: "subscriptionOrder" | "contract",
  prefix: string
) {
  const today = new Date();
  const datePart = today.toISOString().slice(0, 10).replaceAll("-", "");
  const count = table === "subscriptionOrder" ? await tx.subscriptionOrder.count() : await tx.contract.count();
  return `${prefix}${datePart}${String(count + 1).padStart(5, "0")}`;
}

function ensureCanAccessOrder(order: OrderWithDetails, user: RequestUser) {
  if (!canViewAllOrders(user) && order.application.salesUserId !== user.id) {
    throw new ForbiddenException("Order is outside your scope.");
  }
}

function ensureCanAccessQuote(quote: QuoteWithDetails, user: RequestUser) {
  if (!canViewAllOrders(user) && quote.application.salesUserId !== user.id) {
    throw new ForbiddenException("Quote is outside your scope.");
  }
}

function ensureCanAccessContract(contract: ContractWithDetails, user: RequestUser) {
  if (!canViewAllOrders(user) && contract.order.application.salesUserId !== user.id) {
    throw new ForbiddenException("Contract is outside your scope.");
  }
}

function canViewAllOrders(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "GM", "OP", "RC", "FI", "AS"].includes(role));
}

function parseDateOnly(value: string, field: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date.`);
  }
  return date;
}

function toOrderView(order: OrderWithDetails): Record<string, unknown> {
  return toPlain({
    ...order,
    depositAmount: Number(order.depositAmount),
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    overMileageFeeAmount: Number(order.overMileageFeeAmount),
    vehiclePurchasePriceAmount: Number(order.vehiclePurchasePriceAmount)
  }) as Record<string, unknown>;
}

function toContractView(contract: ContractWithDetails): Record<string, unknown> {
  return toPlain(contract) as Record<string, unknown>;
}

function toContractVersionView(version: Prisma.ContractVersionGetPayload<object>): Record<string, unknown> {
  return toPlain(version) as Record<string, unknown>;
}

function toOrderChangeView(change: Prisma.OrderChangeGetPayload<object>): Record<string, unknown> {
  return toPlain(change) as Record<string, unknown>;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}
