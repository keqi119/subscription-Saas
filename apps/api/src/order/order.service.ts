import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import {
  ApplicationActionType,
  ApplicationStatus,
  AuditAction,
  BusinessType,
  ContractStatus,
  ContractVersionStatus,
  CustomerStatus,
  DeliveryStatus,
  DepositStatus,
  MonthlyFeeMode,
  OrderChangeStatus,
  OrderChangeType,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  Prisma,
  ProductStatus,
  ProductType,
  ProductVersionStatus,
  QuoteStatus,
  RecordStatus,
  SalePriceStatus,
  SubscriptionPlanStatus,
  VehicleBatteryUsageType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import {
  ArchiveContractDto,
  CancelOrderDto,
  CreateContractVersionDto,
  CreateCustomerOrderDto,
  CreateOrderChangeDto,
  CreateOrderFromQuoteDto,
  ConfirmDeliveryDto,
  PrepareDeliveryDto,
  ReviewOrderDto,
  UpdateContractVersionDto
} from "./dto/order.dto";

const CURRENT_BUSINESS_TYPE = BusinessType.SUBSCRIPTION;
const RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE = "当前阶段暂未开放以租代购订单。";
const DISALLOWED_CHANGE_TYPES = new Set<OrderChangeType>([
  OrderChangeType.BUYOUT,
  OrderChangeType.EARLY_SETTLEMENT,
  OrderChangeType.OWNERSHIP_TRANSFER
]);
const CUSTOMER_ORDER_DEPOSIT_NOTICE =
  "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。";
const CUSTOMER_ORDER_MANUAL_QUOTE_MESSAGE =
  "该套餐需后台报价确认，暂不支持客户自助提交。";
const CUSTOMER_ORDER_VEHICLE_UNAVAILABLE_MESSAGE =
  "所选车辆当前不可租用，请重新选择车辆";

const PRE_CONTRACT_CHANGE_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING_REVIEW,
  OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
  OrderStatus.PENDING_CONTRACT,
  OrderStatus.PENDING_SIGN,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_VEHICLE,
  OrderStatus.PENDING_DELIVERY
]);
const ACTIVE_CHANGE_STATUSES = new Set<OrderStatus>([OrderStatus.ACTIVE, OrderStatus.SUSPENDED]);
const FINAL_CHANGE_STATUSES = new Set<OrderStatus>([
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
]);
const VEHICLE_OCCUPYING_FINAL_STATUSES = [
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
] satisfies OrderStatus[];
const UNSIGNED_CONTRACT_STATUSES = new Set<ContractStatus>([
  ContractStatus.DRAFT,
  ContractStatus.GENERATED,
  ContractStatus.SIGNING
]);
const ORDER_FULFILLMENT_CHANGE_MESSAGE =
  "当前订单已进入履约阶段，请走履约变更或合同变更流程。";
const ACTIVE_ORDER_CHANGE_MESSAGE =
  "当前订单存在进行中的变更申请，请先完成或取消变更后再继续操作。";
const DUPLICATE_ACTIVE_ORDER_CHANGE_MESSAGE =
  "该订单已有进行中的变更申请，请先处理后再发起新的变更。";
const RETURN_TO_PLAN_ACTION = "RETURN_TO_PLAN";
const RETURN_TO_PLAN_CHANGE_TYPES = new Set<OrderChangeType>([
  OrderChangeType.PLAN_CHANGE,
  OrderChangeType.VEHICLE_SWAP,
  OrderChangeType.EXTENSION,
  OrderChangeType.CANCEL_ORDER
]);
const DELIVERY_ALLOWED_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PENDING_VEHICLE,
  OrderStatus.PENDING_DELIVERY
]);
const DELIVERY_ALREADY_DONE_MESSAGE = "该订单已完成交付，不能重复确认。";
const DELIVERY_INSURANCE_INVALID_MESSAGE = "车辆保险未生效或已过期，不能交付。";

const packageInclude = {
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
} satisfies Prisma.VehiclePackageInclude;

const subscriptionPlanInclude = {
  benefitPackage: { include: packageInclude },
  energyPackage: { include: packageInclude },
  mileagePackage: { include: packageInclude },
  product: { select: { id: true, name: true, productNo: true, productType: true, status: true, deletedAt: true } },
  productVersion: {
    select: {
      deletedAt: true,
      effectiveFrom: true,
      effectiveTo: true,
      id: true,
      productId: true,
      status: true,
      versionNo: true
    }
  },
  vehiclePackage: { include: packageInclude }
} satisfies Prisma.SubscriptionPlanInclude;

const orderInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  changes: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  contract: true,
  contracts: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  productVersion: { include: { product: true } },
  quote: { select: { id: true, quoteNo: true, status: true } },
  riskResult: true,
  vehicle: true
} satisfies Prisma.SubscriptionOrderInclude;

const quoteInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  order: true,
  productVersion: { include: { product: true } },
  riskResult: true,
  vehicle: true
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

const deliveryInclude = {
  customer: { select: { id: true, mobile: true, name: true } },
  vehicle: true
} satisfies Prisma.VehicleDeliveryInclude;

type OrderWithDetails = Prisma.SubscriptionOrderGetPayload<{ include: typeof orderInclude }>;
type QuoteWithDetails = Prisma.SubscriptionQuoteGetPayload<{ include: typeof quoteInclude }>;
type ContractWithDetails = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;
type SubscriptionPlanWithDetails = Prisma.SubscriptionPlanGetPayload<{ include: typeof subscriptionPlanInclude }>;
type DeliveryWithDetails = Prisma.VehicleDeliveryGetPayload<{ include: typeof deliveryInclude }>;

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

  async listReviewQueue(user: RequestUser) {
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
        orderStatus: { in: [OrderStatus.PENDING_REVIEW, OrderStatus.PENDING_CUSTOMER_CONFIRMATION] },
        ...(canViewAllOrders(user) ? {} : { application: { salesUserId: user.id } })
      }
    });

    return orders.map(toOrderView);
  }

  async reviewOrder(
    id: string,
    reviewType: "credit" | "product" | "vehicle",
    dto: ReviewOrderDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const decision = reviewDecision(dto);
    const comment = reviewComment(dto);
    assertReviewDecision(decision);
    const before = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(before, user);
    ensureCanReviewOrderSection(user, reviewType);
    ensureCustomerSelfServiceOrder(before);
    assertNoActiveOrderChange(before);

    if (decision === OrderReviewStatus.REJECTED) {
      return this.rejectCustomerOrder(id, { ...dto, status: OrderReviewStatus.REJECTED }, user, context, reviewType);
    }

    if (decision === OrderReviewStatus.NEED_MORE_INFO) {
      const order = await this.prisma.subscriptionOrder.update({
        data: {
          [reviewStatusField(reviewType)]: OrderReviewStatus.NEED_MORE_INFO,
          orderStatus: OrderStatus.PENDING_REVIEW,
          reviewComment: comment,
          updatedBy: user.id
        },
        include: orderInclude,
        where: { id }
      });
      await this.writeAudit(AuditAction.UPDATE, "subscription_order", id, toOrderView(before), toOrderView(order), user, context);
      return toOrderView(order);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.SubscriptionOrderUpdateInput = {
        [reviewStatusField(reviewType)]: OrderReviewStatus.APPROVED,
        reviewComment: comment,
        updatedBy: user.id
      };
      let customerBefore = null;
      let customerAfter = null;
      let quoteBefore = null;
      let quoteAfter = null;

      if (reviewType === "credit") {
        if (!dto.customerGrade) {
          throw new BadRequestException("客户资质审核通过时必须选择客户等级。");
        }
        const depositRule = await findActiveDepositRule(tx, dto.customerGrade);
        if (!depositRule) {
          throw new BadRequestException(`No active deposit rule configured for grade ${dto.customerGrade}.`);
        }
        const depositRuleSnapshot = toJsonValue({
          customerGrade: dto.customerGrade,
          defaultRate: Number(depositRule.defaultRate),
          depositAmount: Number(depositRule.depositAmount),
          depositRuleId: depositRule.id,
          grade: depositRule.grade,
          status: DepositStatus.CONFIRMED
        });
        customerBefore = await tx.customer.findUnique({ where: { id: before.customerId } });
        customerAfter = await tx.customer.update({
          data: { grade: dto.customerGrade, updatedBy: user.id },
          where: { id: before.customerId }
        });
        quoteBefore = await tx.subscriptionQuote.findUnique({ where: { id: before.quoteId } });
        quoteAfter = await tx.subscriptionQuote.update({
          data: {
            depositAmount: depositRule.depositAmount,
            depositRuleSnapshot,
            updatedBy: user.id
          },
          where: { id: before.quoteId }
        });
        data.depositAmount = depositRule.depositAmount;
        data.depositStatus = DepositStatus.CONFIRMED;
        data.finalDepositAmount = depositRule.depositAmount;
        data.quoteSnapshot = toJsonValue({
          ...(toPlain(before.quoteSnapshot) as Record<string, unknown>),
          customerGrade: dto.customerGrade,
          defaultRate: Number(depositRule.defaultRate),
          depositAmount: Number(depositRule.depositAmount),
          depositRuleSnapshot,
          depositStatus: DepositStatus.CONFIRMED,
          finalDepositAmount: Number(depositRule.depositAmount)
        });
      }
      if (reviewType === "product") {
        await assertCustomerOrderProductStillMatches(tx, before);
      }
      if (reviewType === "vehicle") {
        await assertCustomerOrderVehicleStillHeld(tx, before);
      }

      const nextStatuses = nextReviewStatuses(before, reviewType, OrderReviewStatus.APPROVED);
      if (allReviewsApproved(nextStatuses)) {
        data.orderStatus = OrderStatus.PENDING_CUSTOMER_CONFIRMATION;
      }

      const order = await tx.subscriptionOrder.update({
        data,
        include: orderInclude,
        where: { id }
      });

      return { customerAfter, customerBefore, order, quoteAfter, quoteBefore };
    });

    if (result.customerBefore && result.customerAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.customerAfter),
        before: toJsonValue(result.customerBefore),
        entityId: result.customerAfter.id,
        entityType: "customer",
        ipAddress: context.ipAddress,
        module: "customer",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    if (result.quoteBefore && result.quoteAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.quoteAfter),
        before: toJsonValue(result.quoteBefore),
        entityId: result.quoteAfter.id,
        entityType: "subscription_quote",
        ipAddress: context.ipAddress,
        module: "quote",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    await this.writeAudit(AuditAction.UPDATE, "subscription_order", id, toOrderView(before), toOrderView(result.order), user, context);
    return toOrderView(result.order);
  }

  async finalizePlan(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(before, user);
    ensureCustomerSelfServiceOrder(before);
    assertNoActiveOrderChange(before);
    if (!allReviewsApproved(currentReviewStatuses(before))) {
      throw new BadRequestException("三项审核全部通过后才可以确认最终方案。");
    }

    if (before.depositStatus !== DepositStatus.CONFIRMED || before.finalDepositAmount === null) {
      throw new BadRequestException("押金确认后才可以确认最终方案。");
    }

    const order = await this.prisma.subscriptionOrder.update({
      data: {
        finalPlanSnapshot: buildFinalPlanSnapshot(before),
        orderStatus: OrderStatus.PENDING_CUSTOMER_CONFIRMATION,
        updatedBy: user.id
      },
      include: orderInclude,
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "subscription_order", id, toOrderView(before), toOrderView(order), user, context);
    return toOrderView(order);
  }

  async rejectCustomerOrder(
    id: string,
    dto: Partial<ReviewOrderDto>,
    user: RequestUser,
    context: RequestContext,
    reviewType?: "credit" | "product" | "vehicle"
  ) {
    const before = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(before, user);
    ensureCustomerSelfServiceOrder(before);
    assertNoActiveOrderChange(before);
    const comment = reviewComment(dto);

    const result = await this.prisma.$transaction(async (tx) => {
      let vehicleBefore = null;
      let vehicleAfter = null;
      if (before.vehicleId && before.vehicle?.status === VehicleStatus.REVIEW_RESERVED) {
        vehicleBefore = before.vehicle;
        vehicleAfter = await tx.vehicle.update({
          data: { status: VehicleStatus.AVAILABLE, updatedBy: user.id },
          where: { id: before.vehicleId }
        });
      }

      const data: Prisma.SubscriptionOrderUpdateInput = {
        orderStatus: OrderStatus.REJECTED,
        reviewComment: comment,
        updatedBy: user.id
      };
      if (reviewType) {
        data[reviewStatusField(reviewType)] = OrderReviewStatus.REJECTED;
      }

      const order = await tx.subscriptionOrder.update({
        data,
        include: orderInclude,
        where: { id }
      });

      return { order, reason: comment, vehicleAfter, vehicleBefore };
    });

    await this.writeAudit(
      AuditAction.REJECT,
      "subscription_order",
      id,
      { ...toOrderView(before), reason: result.reason },
      toOrderView(result.order),
      user,
      context
    );
    if (result.vehicleBefore && result.vehicleAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.vehicleAfter),
        before: toJsonValue(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return toOrderView(result.order);
  }

  async confirmCustomerOrder(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(before, user);
    ensureCustomerSelfServiceOrder(before);
    assertNoActiveOrderChange(before);
    if (before.orderStatus !== OrderStatus.PENDING_CUSTOMER_CONFIRMATION) {
      throw new BadRequestException("仅待客户确认的订单可以进入签约。");
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let vehicleBefore = null;
      let vehicleAfter = null;
      if (before.vehicleId) {
        vehicleBefore = await tx.vehicle.findUnique({ where: { id: before.vehicleId } });
        if (!vehicleBefore || vehicleBefore.deletedAt || vehicleBefore.status !== VehicleStatus.REVIEW_RESERVED) {
          throw new BadRequestException("订单车辆未处于审核占用状态，无法进入签约。");
        }
        vehicleAfter = await tx.vehicle.update({
          data: { status: VehicleStatus.RESERVED, updatedBy: user.id },
          where: { id: before.vehicleId }
        });
      }

      await tx.subscriptionQuote.update({
        data: {
          confirmedAt: new Date(),
          confirmedBy: user.id,
          status: QuoteStatus.CONFIRMED,
          updatedBy: user.id
        },
        where: { id: before.quoteId }
      });

      const order = await tx.subscriptionOrder.update({
        data: {
          customerConfirmedAt: new Date(),
          finalPlanConfirmedAt: new Date(),
          orderStatus: OrderStatus.PENDING_CONTRACT,
          updatedBy: user.id
        },
        include: orderInclude,
        where: { id }
      });

      return { order, vehicleAfter, vehicleBefore };
    });

    await this.writeAudit(AuditAction.APPROVE, "subscription_order", id, toOrderView(before), toOrderView(result.order), user, context);
    if (result.vehicleBefore && result.vehicleAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.vehicleAfter),
        before: toJsonValue(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return toOrderView(result.order);
  }

  async createCustomerOrder(dto: CreateCustomerOrderDto, user: RequestUser, context: RequestContext) {
    const [customer, vehicle, plan] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: dto.customerId } }),
      this.prisma.vehicle.findUnique({ where: { id: dto.vehicleId } }),
      this.prisma.subscriptionPlan.findUnique({
        include: subscriptionPlanInclude,
        where: { id: dto.subscriptionPlanId }
      })
    ]);

    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }
    assertVehicleAvailableForCustomerOrder(vehicle);
    assertSubscriptionPlanAvailableForCustomerOrder(plan);

    if (!vehicle.vehicleModel) {
      throw new BadRequestException("所选车辆缺少车型信息，无法下单");
    }
    const vehicleModel = vehicle.vehicleModel;
    if (vehicleModel !== plan.vehiclePackage.vehicleModel) {
      throw new BadRequestException("所选套餐不适用于该车型");
    }
    assertPeriodInRange(dto.periodMonths, plan.minPeriodMonths, plan.maxPeriodMonths);

    const vehicleSalePriceAmount = vehicle.currentSalePriceAmount;
    if (!vehicleSalePriceAmount || vehicleSalePriceAmount <= 0n) {
      throw new BadRequestException("当前车辆销售价未初始化，无法下单");
    }
    const vehicleBaseFeePricing = calculateCustomerOrderVehicleBaseFee(plan, vehicleSalePriceAmount);
    const vehicleBaseFeeAmount = vehicleBaseFeePricing.vehicleBaseFeeAmount;
    const vehicleBaseFeeCapAmount = vehicleBaseFeePricing.vehicleBaseFeeCapAmount;

    const mileagePackagePriceAmount = plan.mileagePackage.priceAmount;
    const energyPackagePriceAmount = plan.energyPackage.priceAmount;
    const benefitPackagePriceAmount = plan.benefitPackage?.priceAmount ?? 0n;
    const monthlyFeeAmount =
      vehicleBaseFeeAmount +
      mileagePackagePriceAmount +
      energyPackagePriceAmount +
      benefitPackagePriceAmount;
    const now = new Date();

    const vehicleSnapshot = toJsonValue({
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: vehicle.batteryCapacityKwh?.toNumber() ?? null,
      batteryUsageType: vehicle.batteryUsageType,
      batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
      brand: vehicle.brand,
      currentMileageKm: vehicle.currentMileageKm,
      currentSalePriceAmount: Number(vehicleSalePriceAmount),
      plateNo: vehicle.plateNo,
      series: vehicle.series,
      status: vehicle.status,
      vehicleModel,
      vehicleNo: vehicle.vehicleNo,
      vin: vehicle.vin
    });
    const packageSnapshot = toJsonValue({
      benefitPackage: plan.benefitPackage ? toPackageSnapshot(plan.benefitPackage) : null,
      energyPackage: toPackageSnapshot(plan.energyPackage),
      mileagePackage: toPackageSnapshot(plan.mileagePackage),
      pricing: {
        benefitPackagePriceAmount: Number(benefitPackagePriceAmount),
        currentSalePriceAmount: Number(vehicleSalePriceAmount),
        energyPackagePriceAmount: Number(energyPackagePriceAmount),
        fixedRate: vehicleBaseFeePricing.fixedRate,
        mileagePackagePriceAmount: Number(mileagePackagePriceAmount),
        monthlyFeeAmount: Number(monthlyFeeAmount),
        vehicleBaseFeeAmount: Number(vehicleBaseFeeAmount),
        vehicleBaseFeeCapAmount: Number(vehicleBaseFeeCapAmount),
        vehicleBaseFeeMode: plan.monthlyFeeMode,
        vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel
      },
      subscriptionPlan: toSubscriptionPlanSnapshot(plan),
      vehicleBaseFeeAmount: Number(vehicleBaseFeeAmount),
      vehicleBaseFeeCapAmount: Number(vehicleBaseFeeCapAmount),
      vehicleBaseFeeMode: plan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel,
      vehiclePackage: toPackageSnapshot(plan.vehiclePackage)
    });
    const customerSelectedSnapshot = toJsonValue({
      customerId: customer.id,
      customerName: customer.name,
      depositDescription: CUSTOMER_ORDER_DEPOSIT_NOTICE,
      depositStatus: DepositStatus.PENDING_CONFIRM,
      periodMonths: dto.periodMonths,
      selectedAt: now.toISOString(),
      subscriptionPlanId: plan.id,
      vehicleBaseFeeAmount: Number(vehicleBaseFeeAmount),
      vehicleId: vehicle.id
    });
    const depositRuleSnapshot = toJsonValue({
      depositDescription: CUSTOMER_ORDER_DEPOSIT_NOTICE,
      status: DepositStatus.PENDING_CONFIRM
    });

    const result = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const vehicleBefore = await tx.vehicle.findUnique({ where: { id: dto.vehicleId } });
      assertVehicleAvailableForCustomerOrder(vehicleBefore);

      const application = await tx.application.create({
        data: {
          applicationNo: createBusinessNo("APP"),
          createdBy: user.id,
          customerId: customer.id,
          intendedModel: vehicleModel,
          intendedPeriodMonths: dto.periodMonths,
          salesUserId: customer.ownerUserId ?? user.id,
          status: ApplicationStatus.SUBMITTED,
          submittedAt: now,
          updatedBy: user.id
        }
      });

      await tx.applicationActionLog.create({
        data: {
          actionType: ApplicationActionType.CREATE,
          applicationId: application.id,
          comment: "客户自助下单自动生成进件",
          createdBy: user.id,
          operatorId: user.id,
          operatorName: user.name,
          toStatus: ApplicationStatus.SUBMITTED,
          updatedBy: user.id
        }
      });

      if (customer.status === CustomerStatus.LEAD) {
        await tx.customer.update({
          data: { status: CustomerStatus.PENDING_APPLICATION, updatedBy: user.id },
          where: { id: customer.id }
        });
      }

      const quote = await tx.subscriptionQuote.create({
        data: {
          applicationId: application.id,
          benefitPackageId: plan.benefitPackage?.id ?? null,
          benefitPackagePriceAmount,
          createdBy: user.id,
          customerId: customer.id,
          customerSelectedSnapshot,
          depositAmount: 0n,
          depositRuleSnapshot,
          energyLimitCount: plan.energyPackage.monthlyEnergyCount,
          energyLimitKwh: plan.energyPackage.monthlyEnergyKwh,
          energyPackageId: plan.energyPackage.id,
          energyPackagePriceAmount,
          mileageLimitKm: plan.mileagePackage.monthlyMileageKm,
          mileagePackageId: plan.mileagePackage.id,
          mileagePackagePriceAmount,
          monthlyFeeAmount,
          monthlyFeeCapAmount: vehicleBaseFeeCapAmount,
          monthlyFeeRate: plan.monthlyFeeRate,
          overMileageFeeAmount: plan.mileagePackage.overMileageFeeAmount,
          packageSnapshot,
          periodMonths: dto.periodMonths,
          productId: plan.productId,
          productVersionId: plan.productVersionId,
          quoteNo: createBusinessNo("QUO"),
          riskResultId: null,
          status: QuoteStatus.DRAFT,
          subscriptionPlanId: plan.id,
          updatedBy: user.id,
          vehicleBaseFeeAmount,
          vehicleBaseFeeCapAmount,
          vehicleId: vehicle.id,
          vehicleModel,
          vehiclePackageId: plan.vehiclePackage.id,
          vehiclePurchasePriceAmount: vehicle.purchasePriceAmount,
          vehicleSalePriceAmount,
          vehicleSnapshot
        },
        include: quoteInclude
      }) as QuoteWithDetails;

      const quoteSnapshot = toJsonValue({
        ...(toPlain(quote) as Record<string, unknown>),
        customerSelectedSnapshot,
        depositDescription: CUSTOMER_ORDER_DEPOSIT_NOTICE,
        depositStatus: DepositStatus.PENDING_CONFIRM,
        finalDepositAmount: null
      });

      const order = await tx.subscriptionOrder.create({
        data: {
          applicationId: application.id,
          businessType: CURRENT_BUSINESS_TYPE,
          createdBy: user.id,
          creditReviewStatus: OrderReviewStatus.PENDING,
          customerId: customer.id,
          customerSelectedSnapshot,
          depositAmount: 0n,
          depositStatus: DepositStatus.PENDING_CONFIRM,
          energyLimitCount: plan.energyPackage.monthlyEnergyCount,
          energyLimitKwh: plan.energyPackage.monthlyEnergyKwh,
          finalDepositAmount: null,
          mileageLimitKm: plan.mileagePackage.monthlyMileageKm,
          monthlyFeeAmount,
          orderNo: createBusinessNo("ORD"),
          orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
          orderStatus: OrderStatus.PENDING_REVIEW,
          overMileageFeeAmount: plan.mileagePackage.overMileageFeeAmount,
          periodMonths: dto.periodMonths,
          productId: plan.productId,
          productReviewStatus: OrderReviewStatus.PENDING,
          productVersionId: plan.productVersionId,
          quoteId: quote.id,
          quoteSnapshot,
          riskResultId: null,
          updatedBy: user.id,
          vehicleId: vehicle.id,
          vehicleModel,
          vehiclePurchasePriceAmount: vehicle.purchasePriceAmount,
          vehicleReviewStatus: OrderReviewStatus.PENDING
        },
        include: orderInclude
      }) as OrderWithDetails;

      const vehicleAfter = await tx.vehicle.update({
        data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: user.id },
        where: { id: vehicle.id }
      });

      return { application, order, quote, vehicleAfter, vehicleBefore };
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toJsonValue(result.application),
      entityId: result.application.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toQuoteAuditView(result.quote),
      entityId: result.quote.id,
      entityType: "subscription_quote",
      ipAddress: context.ipAddress,
      module: "quote",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.writeAudit(AuditAction.CREATE, "subscription_order", result.order.id, undefined, toOrderView(result.order), user, context);
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toJsonValue(result.vehicleAfter),
      before: toJsonValue(result.vehicleBefore),
      entityId: result.vehicleAfter.id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toOrderView(result.order);
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

    if (!quote.vehicleId) {
      throw new BadRequestException("已确认报价未绑定车辆，无法创建订单。");
    }
    if (!quote.vehicle || quote.vehicle.deletedAt || quote.vehicle.status !== VehicleStatus.RESERVED) {
      throw new BadRequestException("已确认报价绑定车辆未锁定，请重新确认报价。");
    }

    const quoteSnapshot = toJsonValue(toPlain(quote));
    const order = await withUniqueBusinessNoRetry(() => this.prisma.subscriptionOrder.create({
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
        orderNo: createBusinessNo("ORD"),
        orderStatus: OrderStatus.PENDING_CONTRACT,
        overMileageFeeAmount: quote.overMileageFeeAmount,
        periodMonths: quote.periodMonths,
        productId: quote.productId,
        productVersionId: quote.productVersionId,
        quoteId: quote.id,
        quoteSnapshot,
        riskResultId: quote.riskResultId,
        updatedBy: user.id,
        vehicleId: quote.vehicleId,
        vehicleModel: quote.vehicleModel,
        vehiclePurchasePriceAmount: quote.vehiclePurchasePriceAmount
      },
      include: orderInclude
    }));

    await this.writeAudit(AuditAction.CREATE, "subscription_order", order.id, undefined, toOrderView(order), user, context);
    return toOrderView(order);
  }

  async cancelOrder(id: string, dto: CancelOrderDto, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(id);
    assertNoActiveOrderChange(before);
    const cancellableStatuses: OrderStatus[] = [
      OrderStatus.PENDING_CONTRACT,
      OrderStatus.PENDING_SIGN,
      OrderStatus.PENDING_PAYMENT
    ];
    if (!cancellableStatuses.includes(before.orderStatus)) {
      throw new BadRequestException("当前订单状态不允许取消。");
    }
    const result = await this.prisma.$transaction(async (tx) => {
      let vehicleBefore = null;
      let vehicleAfter = null;

      if (before.vehicleId && before.vehicle?.status === VehicleStatus.RESERVED) {
        vehicleBefore = before.vehicle;
        vehicleAfter = await tx.vehicle.update({
          data: { status: VehicleStatus.AVAILABLE, updatedBy: user.id },
          where: { id: before.vehicleId }
        });
      }

      const order = await tx.subscriptionOrder.update({
        data: { orderStatus: OrderStatus.CANCELLED, updatedBy: user.id },
        include: orderInclude,
        where: { id }
      });
      return { order, vehicleAfter, vehicleBefore };
    });
    const order = result.order;
    await this.writeAudit(AuditAction.UPDATE, "subscription_order", id, { ...toOrderView(before), reason: dto.reason }, toOrderView(order), user, context);
    if (result.vehicleBefore && result.vehicleAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.vehicleAfter),
        before: toJsonValue(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return toOrderView(order);
  }

  async getDeliveryCheck(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const delivery = await this.prisma.vehicleDelivery.findUnique({
      include: deliveryInclude,
      where: { orderId: id }
    });
    return buildDeliveryCheck(order, delivery && !delivery.deletedAt ? delivery : null);
  }

  async getDelivery(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const delivery = await this.prisma.vehicleDelivery.findUnique({
      include: deliveryInclude,
      where: { orderId: id }
    });
    return delivery && !delivery.deletedAt ? toDeliveryView(delivery) : null;
  }

  async prepareDelivery(id: string, dto: PrepareDeliveryDto, user: RequestUser, context: RequestContext) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertOrderNotDelivered(beforeOrder);

    const scheduledAt = dto.scheduledAt ? parseDateTime(dto.scheduledAt, "scheduledAt") : null;
    assertCanPrepareDelivery(beforeOrder, scheduledAt);

    const result = await this.prisma.$transaction(async (tx) => {
      const beforeDelivery = await tx.vehicleDelivery.findUnique({
        include: deliveryInclude,
        where: { orderId: id }
      });

      if (beforeDelivery?.deliveryStatus === DeliveryStatus.DELIVERED || beforeDelivery?.deliveredAt) {
        throw new BadRequestException(DELIVERY_ALREADY_DONE_MESSAGE);
      }

      const deliveryData = buildPrepareDeliveryData(beforeOrder, dto, scheduledAt, user.id, beforeDelivery);
      const delivery = beforeDelivery
        ? await tx.vehicleDelivery.update({
            data: deliveryData,
            include: deliveryInclude,
            where: { id: beforeDelivery.id }
          })
        : await tx.vehicleDelivery.create({
            data: {
              ...deliveryData,
              createdBy: user.id,
              customerId: beforeOrder.customerId,
              deliveryNo: createBusinessNo("DLV"),
              orderId: beforeOrder.id,
              vehicleId: beforeOrder.vehicleId!
            },
            include: deliveryInclude
          });

      const order = await tx.subscriptionOrder.update({
        data: { orderStatus: OrderStatus.PENDING_DELIVERY, updatedBy: user.id },
        include: orderInclude,
        where: { id }
      });

      return { beforeDelivery, delivery, order };
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      toOrderView(beforeOrder),
      toOrderView(result.order),
      user,
      context
    );
    await this.writeDeliveryAudit(
      result.beforeDelivery ? AuditAction.UPDATE : AuditAction.CREATE,
      result.delivery.id,
      result.beforeDelivery ? toDeliveryView(result.beforeDelivery) : undefined,
      toDeliveryView(result.delivery),
      user,
      context
    );
    return toDeliveryView(result.delivery);
  }

  async confirmDelivery(id: string, dto: ConfirmDeliveryDto, user: RequestUser, context: RequestContext) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertOrderNotDelivered(beforeOrder);

    const deliveredAt = dto.deliveredAt ? parseDateTime(dto.deliveredAt, "deliveredAt") : new Date();
    const beforeDelivery = await this.prisma.vehicleDelivery.findUnique({
      include: deliveryInclude,
      where: { orderId: id }
    });
    assertCanConfirmDelivery(beforeOrder, beforeDelivery, deliveredAt);

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicleBefore = await tx.vehicle.findUnique({ where: { id: beforeOrder.vehicleId! } });
      if (!vehicleBefore || vehicleBefore.deletedAt || vehicleBefore.status !== VehicleStatus.RESERVED) {
        throw new BadRequestException("交付前车辆必须处于“签约锁定（RESERVED）”状态。");
      }

      const occupiedByOtherOrderCount = await tx.subscriptionOrder.count({
        where: {
          deletedAt: null,
          id: { not: beforeOrder.id },
          orderStatus: { notIn: VEHICLE_OCCUPYING_FINAL_STATUSES },
          vehicleId: beforeOrder.vehicleId
        }
      });
      if (occupiedByOtherOrderCount > 0) {
        throw new BadRequestException("车辆已被其他订单占用，不能交付。");
      }

      const delivery = await tx.vehicleDelivery.update({
        data: {
          deliveredAt,
          deliveryStatus: DeliveryStatus.DELIVERED,
          handoverMileageKm: dto.handoverMileageKm,
          remark: dto.remark,
          updatedBy: user.id
        },
        include: deliveryInclude,
        where: { id: beforeDelivery!.id }
      });
      const order = await tx.subscriptionOrder.update({
        data: {
          actualDeliveryAt: deliveredAt,
          orderStatus: OrderStatus.ACTIVE,
          updatedBy: user.id
        },
        include: orderInclude,
        where: { id }
      });
      const vehicleAfter = await tx.vehicle.update({
        data: { status: VehicleStatus.LEASED, updatedBy: user.id },
        where: { id: beforeOrder.vehicleId! }
      });

      return { delivery, order, vehicleAfter, vehicleBefore };
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      toOrderView(beforeOrder),
      toOrderView(result.order),
      user,
      context
    );
    await this.writeDeliveryAudit(
      AuditAction.UPDATE,
      result.delivery.id,
      toDeliveryView(beforeDelivery!),
      toDeliveryView(result.delivery),
      user,
      context
    );
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toJsonValue(result.vehicleAfter),
      before: toJsonValue(result.vehicleBefore),
      entityId: result.vehicleAfter.id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toDeliveryView(result.delivery);
  }

  async generateContract(orderId: string, user: RequestUser, context: RequestContext) {
    const before = await this.findOrderOrThrow(orderId);
    assertNoActiveOrderChange(before);
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

    const contract = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const created = await tx.contract.create({
        data: {
          businessType: BusinessType.SUBSCRIPTION,
          contractNo: createBusinessNo("CON"),
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
    }));

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
    const order = await this.findOrderOrThrow(before.orderId);
    assertNoActiveOrderChange(order);
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
    const order = await this.findOrderOrThrow(before.orderId);
    assertNoActiveOrderChange(order);
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
    const order = await this.findOrderOrThrow(before.orderId);
    assertNoActiveOrderChange(order);
    if (before.order.id !== before.orderId) {
      throw new BadRequestException("合同所属订单不一致。");
    }
    if (before.status === ContractStatus.ARCHIVED) {
      throw new BadRequestException("已归档合同不能取消。");
    }
    if (before.status === ContractStatus.SIGNED) {
      throw new BadRequestException("已签署合同不能取消。");
    }
    const cancellableStatuses: ContractStatus[] = [ContractStatus.GENERATED, ContractStatus.SIGNING];
    if (!cancellableStatuses.includes(before.status)) {
      throw new BadRequestException("当前合同状态不允许取消。");
    }
    if (before.order.contractId !== before.id) {
      throw new BadRequestException("当前合同不是该订单的当前合同。");
    }
    const cancellableOrderStatuses: OrderStatus[] = [OrderStatus.PENDING_SIGN, OrderStatus.PENDING_CONTRACT];
    if (!cancellableOrderStatuses.includes(before.order.orderStatus)) {
      throw new BadRequestException("当前订单状态不允许取消合同。");
    }

    const contract = await this.prisma.$transaction(async (tx) => {
      await tx.contract.update({
        data: { status: ContractStatus.CANCELLED, updatedBy: user.id },
        where: { id }
      });
      await tx.subscriptionOrder.update({
        data: { contractId: null, orderStatus: OrderStatus.PENDING_CONTRACT, updatedBy: user.id },
        where: { id: before.orderId }
      });
      return tx.contract.findUniqueOrThrow({ include: contractInclude, where: { id } });
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

  async listPlanChangeSubscriptionPlans(orderId: string, user: RequestUser) {
    ensureUserPermission(user, PermissionCode.ORDER_CHANGE_CREATE);
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    if (!order.vehicleId || !order.vehicle?.vehicleModel) {
      throw new BadRequestException("当前订单未绑定车辆，无法发起套餐变更。");
    }

    const today = new Date();
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: subscriptionPlanInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        product: { deletedAt: null, status: ProductStatus.ACTIVE },
        productVersion: { deletedAt: null, status: ProductVersionStatus.ACTIVE },
        status: SubscriptionPlanStatus.ACTIVE,
        vehiclePackage: { vehicleModel: order.vehicle.vehicleModel }
      }
    });

    return plans.filter(isSubscriptionPlanCurrentlyAvailableForOrder).map(toPlanChangeSubscriptionPlanView);
  }

  async createOrderChange(orderId: string, dto: CreateOrderChangeDto, user: RequestUser, context: RequestContext) {
    ensureUserPermission(user, PermissionCode.ORDER_CHANGE_CREATE);
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    ensureAllowedChangeType(dto.changeType);
    if (!RETURN_TO_PLAN_CHANGE_TYPES.has(dto.changeType)) {
      throw new BadRequestException("当前阶段仅支持签约前方案变更退回重做。");
    }
    ensureReturnToPlanOrderStatus(order.orderStatus);
    assertNoSignedCurrentContract(order);
    assertNoDuplicateActiveOrderChange(order);
    const afterSnapshot = buildRequestedOrderChangeSnapshot(dto, order);
    const change = await this.prisma.orderChange.create({
      data: {
        afterSnapshot,
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
    if (status === OrderChangeStatus.APPROVED) {
      ensureUserPermission(user, PermissionCode.ORDER_CHANGE_APPROVE);
    } else if (!user.roles.includes("ADMIN") && !user.permissions.includes(PermissionCode.ORDER_CHANGE_REJECT) && !user.permissions.includes(PermissionCode.ORDER_CHANGE_APPROVE)) {
      throw new ForbiddenException("Permission denied.");
    }
    const before = await this.prisma.orderChange.findUnique({
      include: { order: { include: orderInclude } },
      where: { id }
    });
    if (!before || before.deletedAt) {
      throw new NotFoundException("Order change not found.");
    }
    ensureCanAccessOrder(before.order, user);
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

  async cancelOrderChange(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.prisma.orderChange.findUnique({
      include: { order: { include: orderInclude } },
      where: { id }
    });
    if (!before || before.deletedAt) {
      throw new NotFoundException("Order change not found.");
    }
    ensureCanAccessOrder(before.order, user);
    if (before.status !== OrderChangeStatus.PENDING) {
      throw new BadRequestException("仅待审核的订单变更可以取消。");
    }
    if (!user.roles.includes("ADMIN") && before.createdBy !== user.id) {
      throw new ForbiddenException("Permission denied.");
    }
    const change = await this.prisma.orderChange.update({
      data: {
        status: OrderChangeStatus.CANCELLED,
        updatedBy: user.id
      },
      where: { id }
    });
    await this.writeAudit(AuditAction.UPDATE, "order_change", id, toOrderChangeView(before), toOrderChangeView(change), user, context);
    return toOrderChangeView(change);
  }

  async executeOrderChange(id: string, user: RequestUser, context: RequestContext) {
    return this.returnOrderChangeToPlan(id, user, context);
  }

  async returnOrderChangeToPlan(id: string, user: RequestUser, context: RequestContext) {
    ensureUserPermission(user, PermissionCode.ORDER_CHANGE_EXECUTE);
    const before = await this.prisma.orderChange.findUnique({
      include: { order: { include: orderInclude } },
      where: { id }
    });
    if (!before || before.deletedAt) {
      throw new NotFoundException("Order change not found.");
    }
    ensureCanAccessOrder(before.order, user);
    ensureReturnToPlanOrderChange(before);

    const result = await this.prisma.$transaction(async (tx) => {
      const orderBefore = await tx.subscriptionOrder.findUnique({
        include: orderInclude,
        where: { id: before.orderId }
      });
      if (!orderBefore || orderBefore.deletedAt) {
        throw new NotFoundException("Order not found.");
      }
      ensureCanAccessOrder(orderBefore, user);
      ensureReturnToPlanOrderStatus(orderBefore.orderStatus);
      const currentChange = await tx.orderChange.findUnique({ where: { id } });
      if (!currentChange || currentChange.deletedAt) {
        throw new NotFoundException("Order change not found.");
      }
      ensureReturnToPlanOrderChange({ ...currentChange, order: orderBefore });
      const unsignedContract = findUnsignedCurrentContract(orderBefore);
      const vehicleBefore = orderBefore.vehicleId
        ? await tx.vehicle.findUnique({ where: { id: orderBefore.vehicleId } })
        : null;

      let contractAfter = null;
      if (unsignedContract) {
        contractAfter = await tx.contract.update({
          data: { status: ContractStatus.CANCELLED, updatedBy: user.id },
          where: { id: unsignedContract.id }
        });
      }

      let vehicleAfter = null;
      if (
        vehicleBefore &&
        !vehicleBefore.deletedAt &&
        (vehicleBefore.status === VehicleStatus.RESERVED || vehicleBefore.status === VehicleStatus.REVIEW_RESERVED)
      ) {
        const occupyingOrders = await tx.subscriptionOrder.count({
          where: {
            deletedAt: null,
            id: { not: orderBefore.id },
            orderStatus: { notIn: VEHICLE_OCCUPYING_FINAL_STATUSES },
            vehicleId: vehicleBefore.id
          }
        });
        if (occupyingOrders === 0) {
          vehicleAfter = await tx.vehicle.update({
            data: { status: VehicleStatus.AVAILABLE, updatedBy: user.id },
            where: { id: vehicleBefore.id }
          });
        }
      }

      const orderAfter = await tx.subscriptionOrder.update({
        data: {
          contractId: null,
          orderStatus: OrderStatus.CANCELLED,
          updatedBy: user.id
        },
        include: orderInclude,
        where: { id: orderBefore.id }
      });

      const executedAt = new Date();
      const beforeSnapshot = toJsonValue({
        order: toOrderView(orderBefore),
        requestedChange: toPlain(currentChange.afterSnapshot)
      });
      const nextStep =
        orderBefore.orderSource === OrderSource.CUSTOMER_SELF_SERVICE
          ? "客户需重新提交订单申请。"
          : "返回进件详情重新生成订阅报价和订阅订单。";
      const afterSnapshot = toJsonValue({
        action: RETURN_TO_PLAN_ACTION,
        contractCancelled: Boolean(unsignedContract),
        nextStep,
        order: toOrderView(orderAfter),
        orderStatus: OrderStatus.CANCELLED,
        vehicleReleased: Boolean(vehicleAfter),
        vehicleStatus: vehicleAfter?.status ?? vehicleBefore?.status ?? null
      });
      const changeAfter = await tx.orderChange.update({
        data: {
          afterSnapshot,
          beforeSnapshot,
          executedAt,
          status: OrderChangeStatus.EXECUTED,
          updatedBy: user.id
        },
        where: { id }
      });

      return {
        changeAfter,
        contractAfter,
        contractBefore: unsignedContract,
        orderAfter,
        orderBefore,
        vehicleAfter,
        vehicleBefore
      };
    });

    await this.writeAudit(
      AuditAction.UPDATE,
      "order_change",
      id,
      toOrderChangeView(before),
      toOrderChangeView(result.changeAfter),
      user,
      context
    );
    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      result.orderAfter.id,
      toOrderView(result.orderBefore),
      toOrderView(result.orderAfter),
      user,
      context
    );
    if (result.contractBefore && result.contractAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.contractAfter),
        before: toJsonValue(result.contractBefore),
        entityId: result.contractAfter.id,
        entityType: "contract",
        ipAddress: context.ipAddress,
        module: "contract",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    if (result.vehicleBefore && result.vehicleAfter) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toJsonValue(result.vehicleAfter),
        before: toJsonValue(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return toOrderChangeView(result.changeAfter);
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

  private async writeDeliveryAudit(
    action: AuditAction,
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
      entityType: "vehicle_delivery",
      ipAddress: context.ipAddress,
      module: "delivery",
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

function assertOrderNotDelivered(order: OrderWithDetails) {
  if (order.actualDeliveryAt || order.orderStatus === OrderStatus.ACTIVE) {
    throw new BadRequestException(DELIVERY_ALREADY_DONE_MESSAGE);
  }
}

function assertCanPrepareDelivery(order: OrderWithDetails, scheduledAt: Date | null) {
  const check = buildDeliveryCheck(order, null, scheduledAt ?? undefined);
  if (!check.canPrepareDelivery) {
    throw new BadRequestException(firstBlockingReason(check, "当前订单不满足准备交付条件。"));
  }
}

function assertCanConfirmDelivery(
  order: OrderWithDetails,
  delivery: DeliveryWithDetails | null,
  deliveredAt: Date
) {
  if (!delivery || delivery.deletedAt) {
    throw new BadRequestException("请先准备交付。");
  }
  if (delivery.deliveryStatus === DeliveryStatus.DELIVERED || delivery.deliveredAt) {
    throw new BadRequestException(DELIVERY_ALREADY_DONE_MESSAGE);
  }
  if (delivery.deliveryStatus !== DeliveryStatus.READY) {
    throw new BadRequestException("请先准备交付。");
  }

  const check = buildDeliveryCheck(order, delivery, deliveredAt);
  if (!check.insuranceValid) {
    throw new BadRequestException(DELIVERY_INSURANCE_INVALID_MESSAGE);
  }
  if (!check.canConfirmDelivery) {
    throw new BadRequestException(firstBlockingReason(check, "当前订单不满足确认交付条件。"));
  }
}

function firstBlockingReason(check: ReturnType<typeof buildDeliveryCheck>, fallback: string) {
  return check.blockingReasons[0] ?? fallback;
}

function buildDeliveryCheck(order: OrderWithDetails, delivery: DeliveryWithDetails | null, targetAt?: Date) {
  const contractSigned = isCurrentContractSigned(order);
  const vehicle = order.vehicle;
  const deliveryCheckAt = targetAt ?? delivery?.deliveredAt ?? delivery?.scheduledAt ?? new Date();
  const alreadyDelivered = Boolean(
    order.actualDeliveryAt ||
      order.orderStatus === OrderStatus.ACTIVE ||
      delivery?.deliveryStatus === DeliveryStatus.DELIVERED ||
      delivery?.deliveredAt
  );
  const currentSalePriceInitialized = Boolean(
    vehicle &&
      vehicle.salePriceStatus === SalePriceStatus.EFFECTIVE &&
      vehicle.currentSalePriceAmount &&
      vehicle.currentSalePriceAmount > 0n
  );
  const insuranceValid = Boolean(vehicle && isVehicleInsuranceValid(vehicle, deliveryCheckAt));
  const depositReceivedConfirmed = order.depositStatus === DepositStatus.CONFIRMED && Boolean(delivery?.depositReceivedConfirmed);
  const firstMonthlyFeeReceivedConfirmed = Boolean(delivery?.firstMonthlyFeeReceivedConfirmed);
  const vehiclePrepared = Boolean(delivery?.vehiclePreparedConfirmed);
  const vehiclePhotosConfirmed = Boolean(delivery?.vehiclePhotosConfirmed);
  const customerIdentityConfirmed = Boolean(delivery?.customerIdentityConfirmed);
  const handoverDocumentsConfirmed = Boolean(delivery?.handoverDocumentsConfirmed);
  const deliveryReady = delivery?.deliveryStatus === DeliveryStatus.READY;

  if (alreadyDelivered) {
    return {
      alreadyDelivered,
      blockingReasons: [],
      canConfirmDelivery: false,
      canPrepareDelivery: false,
      contractSigned,
      currentSalePriceInitialized,
      deliveryStatus: delivery?.deliveryStatus ?? null,
      depositReceivedConfirmed,
      firstMonthlyFeeReceivedConfirmed,
      insuranceValid,
      orderId: order.id,
      orderNo: order.orderNo,
      orderStatus: order.orderStatus,
      vehiclePrepared,
      vehicleStatus: vehicle?.status ?? null
    };
  }

  const prepareBlockingReasons: string[] = [];
  const confirmBlockingReasons: string[] = [];

  if (!DELIVERY_ALLOWED_ORDER_STATUSES.has(order.orderStatus)) {
    prepareBlockingReasons.push("订单状态不允许交付");
  }
  if (!contractSigned) {
    prepareBlockingReasons.push("合同尚未签署");
  }
  if (!order.vehicleId || !vehicle || vehicle.deletedAt) {
    prepareBlockingReasons.push("订单未绑定有效车辆");
  } else if (vehicle.id !== order.vehicleId) {
    prepareBlockingReasons.push("订单绑定车辆不一致");
  } else if (vehicle.status !== VehicleStatus.RESERVED) {
    prepareBlockingReasons.push("交付前车辆必须处于“签约锁定（RESERVED）”状态。");
  }
  if (!currentSalePriceInitialized) {
    prepareBlockingReasons.push("车辆当前销售价尚未初始化");
  }
  if (!insuranceValid) {
    prepareBlockingReasons.push("车辆保险已过期");
  }

  confirmBlockingReasons.push(...prepareBlockingReasons);
  if (!deliveryReady) {
    confirmBlockingReasons.push("请先准备交付");
  }
  if (!depositReceivedConfirmed) {
    confirmBlockingReasons.push("押金尚未确认收取");
  }
  if (!firstMonthlyFeeReceivedConfirmed) {
    confirmBlockingReasons.push("首期月费尚未确认收取");
  }
  if (!delivery?.insuranceValidConfirmed) {
    confirmBlockingReasons.push("保险有效性尚未确认");
  }
  if (!vehiclePrepared) {
    confirmBlockingReasons.push("车辆尚未整备");
  }
  if (!vehiclePhotosConfirmed) {
    confirmBlockingReasons.push("交付照片尚未确认");
  }
  if (!customerIdentityConfirmed) {
    confirmBlockingReasons.push("客户身份尚未核验");
  }
  if (!handoverDocumentsConfirmed) {
    confirmBlockingReasons.push("交付文件尚未准备");
  }

  return {
    alreadyDelivered,
    blockingReasons: confirmBlockingReasons,
    canConfirmDelivery: confirmBlockingReasons.length === 0,
    canPrepareDelivery: prepareBlockingReasons.length === 0,
    contractSigned,
    currentSalePriceInitialized,
    deliveryStatus: delivery?.deliveryStatus ?? null,
    depositReceivedConfirmed,
    firstMonthlyFeeReceivedConfirmed,
    insuranceValid,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    vehiclePrepared,
    vehicleStatus: vehicle?.status ?? null
  };
}

function buildPrepareDeliveryData(
  order: OrderWithDetails,
  dto: PrepareDeliveryDto,
  scheduledAt: Date | null,
  userId: string,
  beforeDelivery: DeliveryWithDetails | null
) {
  const contractSignedConfirmed = isCurrentContractSigned(order);
  const depositReceivedConfirmed = dto.depositReceivedConfirmed ?? beforeDelivery?.depositReceivedConfirmed ?? false;
  const firstMonthlyFeeReceivedConfirmed =
    dto.firstMonthlyFeeReceivedConfirmed ?? beforeDelivery?.firstMonthlyFeeReceivedConfirmed ?? false;
  const insuranceValidConfirmed = dto.insuranceValidConfirmed ?? beforeDelivery?.insuranceValidConfirmed ?? false;
  const vehiclePreparedConfirmed = dto.vehiclePreparedConfirmed ?? beforeDelivery?.vehiclePreparedConfirmed ?? false;
  const vehiclePhotosConfirmed = dto.vehiclePhotosConfirmed ?? beforeDelivery?.vehiclePhotosConfirmed ?? false;
  const customerIdentityConfirmed = dto.customerIdentityConfirmed ?? beforeDelivery?.customerIdentityConfirmed ?? false;
  const handoverDocumentsConfirmed =
    dto.handoverDocumentsConfirmed ?? beforeDelivery?.handoverDocumentsConfirmed ?? false;
  const nextScheduledAt = scheduledAt ?? beforeDelivery?.scheduledAt ?? null;
  const deliveryLocation = dto.deliveryLocation ?? beforeDelivery?.deliveryLocation ?? null;
  const remark = dto.remark ?? beforeDelivery?.remark ?? null;

  return {
    checklistSnapshot: toJsonValue({
      contractSignedConfirmed,
      customerIdentityConfirmed,
      depositReceivedConfirmed,
      firstMonthlyFeeReceivedConfirmed,
      handoverDocumentsConfirmed,
      insuranceValidConfirmed,
      vehiclePhotosConfirmed,
      vehiclePreparedConfirmed
    }),
    contractSignedConfirmed,
    customerIdentityConfirmed,
    deliveryLocation,
    deliveryStatus: DeliveryStatus.READY,
    depositReceivedConfirmed,
    firstMonthlyFeeReceivedConfirmed,
    handoverDocumentsConfirmed,
    insuranceValidConfirmed,
    remark,
    scheduledAt: nextScheduledAt,
    updatedBy: userId,
    vehiclePhotosConfirmed,
    vehiclePreparedConfirmed
  };
}

function isCurrentContractSigned(order: OrderWithDetails) {
  const contract = findCurrentContract(order);
  return contract?.status === ContractStatus.SIGNED || contract?.status === ContractStatus.ARCHIVED;
}

function isVehicleInsuranceValid(
  vehicle: Pick<NonNullable<OrderWithDetails["vehicle"]>, "insuranceEndDate" | "insuranceStartDate">,
  targetAt: Date
) {
  if (!vehicle.insuranceStartDate || !vehicle.insuranceEndDate) {
    return false;
  }
  const targetDate = dateKey(targetAt);
  return dateKey(vehicle.insuranceStartDate) <= targetDate && targetDate <= dateKey(vehicle.insuranceEndDate);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDateTime(value: string, field: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid datetime.`);
  }
  return date;
}

function ensureUserPermission(user: RequestUser, permission: PermissionCode) {
  if (!user.roles.includes("ADMIN") && !user.permissions.includes(permission)) {
    throw new ForbiddenException("Permission denied.");
  }
}

function ensureCanReviewOrderSection(user: RequestUser, reviewType: "credit" | "product" | "vehicle") {
  if (user.roles.some((role) => ["ADMIN", "GM", "OP"].includes(role))) {
    return;
  }
  if (reviewType === "credit" && user.roles.includes("RC")) {
    return;
  }
  if (reviewType === "vehicle" && user.roles.includes("AS")) {
    return;
  }
  throw new ForbiddenException("当前角色无权执行该审核环节。");
}

function buildRequestedOrderChangeSnapshot(dto: CreateOrderChangeDto, order: OrderWithDetails) {
  const snapshot = toMutableRecord(dto.afterSnapshot);
  if (dto.subscriptionPlanId !== undefined) {
    snapshot.subscriptionPlanId = dto.subscriptionPlanId;
  }
  if (dto.periodMonths !== undefined) {
    snapshot.periodMonths = dto.periodMonths;
  }
  if (dto.vehicleBaseFeeAmount !== undefined) {
    snapshot.vehicleBaseFeeAmount = dto.vehicleBaseFeeAmount;
  }

  if (dto.changeType === OrderChangeType.PLAN_CHANGE) {
    snapshot.action = RETURN_TO_PLAN_ACTION;
    snapshot.changeStage = "PRE_CONTRACT_RETURN_TO_PLAN";
    snapshot.changeType = OrderChangeType.PLAN_CHANGE;
    snapshot.orderSource = order.orderSource;
    snapshot.vehicleId = order.vehicleId;
  }

  return toJsonValue(snapshot);
}

function ensureReturnToPlanOrderChange(change: {
  changeType: OrderChangeType;
  executedAt?: Date | null;
  order: OrderWithDetails;
  status: OrderChangeStatus;
}) {
  if (!RETURN_TO_PLAN_CHANGE_TYPES.has(change.changeType)) {
    throw new BadRequestException("当前阶段仅支持签约前方案变更退回重做。");
  }
  if (change.status !== OrderChangeStatus.APPROVED || change.executedAt) {
    throw new BadRequestException("仅已审批且未处理的订单变更可以退回重做。");
  }
  ensureReturnToPlanOrderStatus(change.order.orderStatus);
}

function ensureReturnToPlanOrderStatus(status: OrderStatus) {
  if (PRE_CONTRACT_CHANGE_STATUSES.has(status)) {
    return;
  }
  if (ACTIVE_CHANGE_STATUSES.has(status)) {
    throw new BadRequestException(ORDER_FULFILLMENT_CHANGE_MESSAGE);
  }
  if (FINAL_CHANGE_STATUSES.has(status)) {
    throw new BadRequestException("当前订单已结束，不允许退回重做方案。");
  }
  throw new BadRequestException("当前订单状态暂不支持退回重做方案。");
}

function isActiveOrderChange(change: {
  deletedAt?: Date | null;
  executedAt?: Date | null;
  status: OrderChangeStatus;
}) {
  if (change.deletedAt || change.executedAt) {
    return false;
  }
  return change.status === OrderChangeStatus.PENDING || change.status === OrderChangeStatus.APPROVED;
}

function hasActiveOrderChange(order: { changes?: Array<{
  deletedAt?: Date | null;
  executedAt?: Date | null;
  status: OrderChangeStatus;
}> }) {
  return order.changes?.some(isActiveOrderChange) ?? false;
}

function assertNoActiveOrderChange(order: { changes?: Array<{
  deletedAt?: Date | null;
  executedAt?: Date | null;
  status: OrderChangeStatus;
}> }) {
  if (hasActiveOrderChange(order)) {
    throw new BadRequestException(ACTIVE_ORDER_CHANGE_MESSAGE);
  }
}

function assertNoDuplicateActiveOrderChange(order: { changes?: Array<{
  deletedAt?: Date | null;
  executedAt?: Date | null;
  status: OrderChangeStatus;
}> }) {
  if (hasActiveOrderChange(order)) {
    throw new BadRequestException(DUPLICATE_ACTIVE_ORDER_CHANGE_MESSAGE);
  }
}

function reviewDecision(dto: Partial<ReviewOrderDto>) {
  const decision = dto.status ?? dto.action;
  if (!decision) {
    throw new BadRequestException("审核动作不能为空。");
  }
  return decision;
}

function reviewComment(dto: Partial<ReviewOrderDto>) {
  return dto.comment ?? dto.remark ?? null;
}

function buildFinalPlanSnapshot(order: OrderWithDetails) {
  return toJsonValue({
    customerId: order.customerId,
    customerSelectedSnapshot: order.customerSelectedSnapshot ?? null,
    depositAmount: Number(order.depositAmount),
    depositStatus: order.depositStatus,
    finalDepositAmount: order.finalDepositAmount === null ? null : Number(order.finalDepositAmount),
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    orderId: order.id,
    orderNo: order.orderNo,
    periodMonths: order.periodMonths,
    productId: order.productId,
    productVersionId: order.productVersionId,
    quoteId: order.quoteId,
    quoteSnapshot: order.quoteSnapshot,
    vehicleId: order.vehicleId,
    vehicleModel: order.vehicleModel
  });
}

async function assertCustomerOrderProductStillMatches(
  tx: Prisma.TransactionClient,
  order: OrderWithDetails
) {
  const quote = await tx.subscriptionQuote.findUnique({
    include: {
      subscriptionPlan: { include: subscriptionPlanInclude },
      vehicle: true
    },
    where: { id: order.quoteId }
  });

  if (!quote?.subscriptionPlan) {
    throw new BadRequestException("订单缺少订阅套餐，无法通过产品审核。");
  }

  assertSubscriptionPlanAvailableForCustomerOrder(quote.subscriptionPlan);

  const vehicleModel = order.vehicle?.vehicleModel ?? quote.vehicle?.vehicleModel ?? order.vehicleModel;
  if (vehicleModel !== quote.subscriptionPlan.vehiclePackage.vehicleModel) {
    throw new BadRequestException("套餐仍需匹配订单车辆车型。");
  }
}

async function assertCustomerOrderVehicleStillHeld(
  tx: Prisma.TransactionClient,
  order: OrderWithDetails
) {
  if (!order.vehicleId) {
    throw new BadRequestException("NEED_CHANGE_VEHICLE");
  }

  const vehicle = await tx.vehicle.findUnique({ where: { id: order.vehicleId } });
  if (!vehicle || vehicle.deletedAt || vehicle.status !== VehicleStatus.REVIEW_RESERVED) {
    throw new BadRequestException("NEED_CHANGE_VEHICLE");
  }
  if (
    vehicle.salePriceStatus !== SalePriceStatus.EFFECTIVE ||
    !vehicle.currentSalePriceAmount ||
    vehicle.currentSalePriceAmount <= 0n
  ) {
    throw new BadRequestException("NEED_CHANGE_VEHICLE");
  }

  const occupiedByOtherOrderCount = await tx.subscriptionOrder.count({
    where: {
      deletedAt: null,
      id: { not: order.id },
      orderStatus: { notIn: VEHICLE_OCCUPYING_FINAL_STATUSES },
      vehicleId: order.vehicleId
    }
  });

  if (occupiedByOtherOrderCount > 0) {
    throw new BadRequestException("NEED_CHANGE_VEHICLE");
  }
}

function findCurrentContract(order: OrderWithDetails) {
  if (order.contract) {
    return order.contract;
  }
  if (!order.contractId) {
    return null;
  }
  return order.contracts.find((contract) => contract.id === order.contractId) ?? null;
}

function assertNoSignedCurrentContract(order: OrderWithDetails) {
  const contract = findCurrentContract(order);
  if (!contract) {
    return;
  }
  if (contract.status === ContractStatus.SIGNED || contract.status === ContractStatus.ARCHIVED) {
    throw new BadRequestException(ORDER_FULFILLMENT_CHANGE_MESSAGE);
  }
  if (!UNSIGNED_CONTRACT_STATUSES.has(contract.status) && contract.status !== ContractStatus.CANCELLED) {
    throw new BadRequestException("当前合同状态暂不支持退回重做方案。");
  }
}

function findUnsignedCurrentContract(order: OrderWithDetails) {
  assertNoSignedCurrentContract(order);
  const contract = findCurrentContract(order);
  return contract && UNSIGNED_CONTRACT_STATUSES.has(contract.status) ? contract : null;
}

function isSubscriptionPlanCurrentlyAvailableForOrder(plan: SubscriptionPlanWithDetails) {
  return (
    plan.status === SubscriptionPlanStatus.ACTIVE &&
    plan.product.status === ProductStatus.ACTIVE &&
    plan.productVersion.status === ProductVersionStatus.ACTIVE &&
    isDateInRangeForOrder(plan.effectiveFrom, plan.effectiveTo) &&
    isSubscriptionPlanComponentsActiveForOrder(plan)
  );
}

function isSubscriptionPlanComponentsActiveForOrder(plan: SubscriptionPlanWithDetails) {
  const packages = [plan.vehiclePackage, plan.mileagePackage, plan.energyPackage, plan.benefitPackage].filter(Boolean);
  return (
    plan.productVersion.productId === plan.product.id &&
    packages.every(
      (item) =>
        item &&
        !item.deletedAt &&
        item.status === RecordStatus.ACTIVE &&
        item.productId === plan.product.id &&
        item.productVersionId === plan.productVersion.id
    )
  );
}

function isDateInRangeForOrder(effectiveFrom: Date, effectiveTo: Date | null, today = new Date()) {
  const todayTime = dateOnlyTimeForOrder(today);
  return dateOnlyTimeForOrder(effectiveFrom) <= todayTime && (!effectiveTo || dateOnlyTimeForOrder(effectiveTo) >= todayTime);
}

function dateOnlyTimeForOrder(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function toPlanChangeSubscriptionPlanView(plan: SubscriptionPlanWithDetails) {
  return {
    benefitDescription: plan.benefitPackage?.description ?? plan.benefitPackage?.packageName ?? null,
    benefitPackagePriceAmount: plan.benefitPackage ? Number(plan.benefitPackage.priceAmount) : 0,
    energyPackagePriceAmount: Number(plan.energyPackage.priceAmount),
    maxPeriodMonths: plan.maxPeriodMonths,
    maxPurchasePriceAmount:
      plan.vehiclePackage.maxPurchasePriceAmount === null ? null : Number(plan.vehiclePackage.maxPurchasePriceAmount),
    minPeriodMonths: plan.minPeriodMonths,
    minPurchasePriceAmount:
      plan.vehiclePackage.minPurchasePriceAmount === null ? null : Number(plan.vehiclePackage.minPurchasePriceAmount),
    monthlyEnergyCount: plan.energyPackage.monthlyEnergyCount,
    monthlyEnergyKwh: plan.energyPackage.monthlyEnergyKwh,
    monthlyFeeCapRate: Number(plan.monthlyFeeCapRate ?? plan.monthlyFeeRate),
    monthlyFeeRate: Number(plan.monthlyFeeRate),
    monthlyMileageKm: plan.mileagePackage.monthlyMileageKm,
    mileagePackagePriceAmount: Number(plan.mileagePackage.priceAmount),
    overMileageFeeAmount: Number(plan.mileagePackage.overMileageFeeAmount),
    planName: plan.planName,
    planNo: plan.planNo,
    productId: plan.productId,
    productName: plan.product.name,
    productVersionId: plan.productVersionId,
    subscriptionPlanId: plan.id,
    vehicleModel: plan.vehiclePackage.vehicleModel,
    versionNo: plan.productVersion.versionNo
  };
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  const plain = toPlain(value);
  if (plain && typeof plain === "object" && !Array.isArray(plain)) {
    return { ...(plain as Record<string, unknown>) };
  }
  return {};
}

type CustomerOrderVehicle = Prisma.VehicleGetPayload<object>;

function assertVehicleAvailableForCustomerOrder(
  vehicle: CustomerOrderVehicle | null
): asserts vehicle is CustomerOrderVehicle {
  if (!vehicle || vehicle.deletedAt) {
    throw new NotFoundException("车辆不存在");
  }
  if (vehicle.status !== VehicleStatus.AVAILABLE) {
    throw new BadRequestException(CUSTOMER_ORDER_VEHICLE_UNAVAILABLE_MESSAGE);
  }
  if (
    vehicle.salePriceStatus !== SalePriceStatus.EFFECTIVE ||
    !vehicle.currentSalePriceAmount ||
    vehicle.currentSalePriceAmount <= 0n
  ) {
    throw new BadRequestException("当前车辆销售价未初始化，无法生成报价");
  }
}

function assertSubscriptionPlanAvailableForCustomerOrder(
  plan: SubscriptionPlanWithDetails | null
): asserts plan is SubscriptionPlanWithDetails {
  if (!plan || plan.deletedAt) {
    throw new NotFoundException("Subscription plan not found.");
  }
  const today = new Date();
  if (
    plan.status !== SubscriptionPlanStatus.ACTIVE ||
    plan.product.status !== ProductStatus.ACTIVE ||
    plan.product.deletedAt ||
    plan.product.productType !== ProductType.SUBSCRIPTION ||
    plan.productVersion.status !== ProductVersionStatus.ACTIVE ||
    plan.productVersion.deletedAt ||
    plan.effectiveFrom > today ||
    (plan.effectiveTo !== null && plan.effectiveTo < today)
  ) {
    throw new BadRequestException("所选订阅套餐当前不可用");
  }
  if (
    plan.vehiclePackage.status !== RecordStatus.ACTIVE ||
    plan.mileagePackage.status !== RecordStatus.ACTIVE ||
    plan.energyPackage.status !== RecordStatus.ACTIVE ||
    (plan.benefitPackage !== null && plan.benefitPackage.status !== RecordStatus.ACTIVE)
  ) {
    throw new BadRequestException("所选订阅套餐包含未启用组件");
  }
  if (plan.monthlyFeeMode === MonthlyFeeMode.MANUAL_QUOTE) {
    throw new BadRequestException(CUSTOMER_ORDER_MANUAL_QUOTE_MESSAGE);
  }
}

function assertPeriodInRange(periodMonths: number, minPeriodMonths: number, maxPeriodMonths: number) {
  if (periodMonths < minPeriodMonths || periodMonths > maxPeriodMonths) {
    throw new BadRequestException("订阅周期不在套餐允许范围内");
  }
}

const VEHICLE_BASE_FEE_MODE_LABELS: Record<MonthlyFeeMode, string> = {
  [MonthlyFeeMode.FIXED_AMOUNT]: "固定金额",
  [MonthlyFeeMode.MANUAL_QUOTE]: "现场报价",
  [MonthlyFeeMode.RATE_FORMULA]: "固定费率"
};

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  [VehicleBatteryUsageType.BAAS]: "BaaS / 电池租用",
  [VehicleBatteryUsageType.BUYOUT]: "电池买断"
};

function calculateCustomerOrderVehicleBaseFee(plan: SubscriptionPlanWithDetails, vehicleSalePriceAmount: bigint) {
  const vehiclePackageRate = Number(plan.vehiclePackage.monthlyFeeRate);
  if (!Number.isFinite(vehiclePackageRate) || vehiclePackageRate <= 0) {
    throw new BadRequestException("车型包车辆基础费上限率必须大于 0");
  }
  const vehicleBaseFeeCapAmount = BigInt(Math.floor(Number(vehicleSalePriceAmount) * vehiclePackageRate));
  let fixedRate: number | null = null;
  let vehicleBaseFeeAmount: bigint;

  switch (plan.monthlyFeeMode) {
    case MonthlyFeeMode.FIXED_AMOUNT:
      if (!plan.baseMonthlyFeeAmount || plan.baseMonthlyFeeAmount <= 0n) {
        throw new BadRequestException("固定金额套餐必须配置车辆基础月费");
      }
      vehicleBaseFeeAmount = plan.baseMonthlyFeeAmount;
      break;
    case MonthlyFeeMode.RATE_FORMULA:
      fixedRate = Number(plan.monthlyFeeRate ?? plan.vehiclePackage.monthlyFeeRate);
      if (!Number.isFinite(fixedRate) || fixedRate <= 0) {
        throw new BadRequestException("固定费率套餐的车辆基础月费费率必须大于 0");
      }
      if (fixedRate > vehiclePackageRate) {
        throw new BadRequestException("固定费率套餐的车辆基础月费费率不能高于车型包上限率");
      }
      vehicleBaseFeeAmount = BigInt(Math.floor(Number(vehicleSalePriceAmount) * fixedRate));
      break;
    case MonthlyFeeMode.MANUAL_QUOTE:
      throw new BadRequestException(CUSTOMER_ORDER_MANUAL_QUOTE_MESSAGE);
    default:
      throw new BadRequestException("不支持的车辆基础月费模式");
  }

  assertVehicleBaseFeeWithinCap(vehicleBaseFeeAmount, vehicleBaseFeeCapAmount);

  return {
    fixedRate,
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleBaseFeeModeLabel: VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode]
  };
}

function assertVehicleBaseFeeWithinCap(vehicleBaseFeeAmount: bigint, capAmount: bigint) {
  if (vehicleBaseFeeAmount > capAmount) {
    throw new BadRequestException("车辆基础费不能超过当前车辆销售价对应的上限");
  }
}

function assertReviewDecision(status: OrderReviewStatus) {
  if (
    status !== OrderReviewStatus.APPROVED &&
    status !== OrderReviewStatus.REJECTED &&
    status !== OrderReviewStatus.NEED_MORE_INFO
  ) {
    throw new BadRequestException("审核状态必须为 APPROVED、REJECTED 或 NEED_MORE_INFO。");
  }
}

function ensureCustomerSelfServiceOrder(order: OrderWithDetails) {
  if (order.orderSource !== OrderSource.CUSTOMER_SELF_SERVICE) {
    throw new BadRequestException("仅客户自助订单可以使用 A 线审核流程。");
  }
  if (order.orderStatus === OrderStatus.CANCELLED || order.orderStatus === OrderStatus.REJECTED) {
    throw new BadRequestException("当前订单状态不允许审核。");
  }
}

function reviewStatusField(reviewType: "credit" | "product" | "vehicle") {
  return {
    credit: "creditReviewStatus",
    product: "productReviewStatus",
    vehicle: "vehicleReviewStatus"
  }[reviewType] as "creditReviewStatus" | "productReviewStatus" | "vehicleReviewStatus";
}

function currentReviewStatuses(order: OrderWithDetails) {
  return {
    creditReviewStatus: order.creditReviewStatus,
    productReviewStatus: order.productReviewStatus,
    vehicleReviewStatus: order.vehicleReviewStatus
  };
}

function nextReviewStatuses(
  order: OrderWithDetails,
  reviewType: "credit" | "product" | "vehicle",
  status: OrderReviewStatus
) {
  return {
    ...currentReviewStatuses(order),
    [reviewStatusField(reviewType)]: status
  };
}

function allReviewsApproved(statuses: {
  creditReviewStatus: OrderReviewStatus;
  productReviewStatus: OrderReviewStatus;
  vehicleReviewStatus: OrderReviewStatus;
}) {
  return (
    statuses.creditReviewStatus === OrderReviewStatus.APPROVED &&
    statuses.productReviewStatus === OrderReviewStatus.APPROVED &&
    statuses.vehicleReviewStatus === OrderReviewStatus.APPROVED
  );
}

async function findActiveDepositRule(tx: Prisma.TransactionClient, grade: NonNullable<ReviewOrderDto["customerGrade"]>) {
  const now = new Date();
  return tx.depositRule.findFirst({
    orderBy: { effectiveFrom: "desc" },
    where: {
      deletedAt: null,
      effectiveFrom: { lte: now },
      grade,
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
      status: RecordStatus.ACTIVE
    }
  });
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
    finalDepositAmount: order.finalDepositAmount === null ? null : Number(order.finalDepositAmount),
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    overMileageFeeAmount: Number(order.overMileageFeeAmount),
    vehiclePurchasePriceAmount: Number(order.vehiclePurchasePriceAmount)
  }) as Record<string, unknown>;
}

function toDeliveryView(delivery: DeliveryWithDetails): Record<string, unknown> {
  return toPlain(delivery) as Record<string, unknown>;
}

function toQuoteAuditView(quote: QuoteWithDetails): Prisma.InputJsonValue {
  return toJsonValue(quote);
}

function toSubscriptionPlanSnapshot(plan: SubscriptionPlanWithDetails) {
  return {
    baseMonthlyFeeAmount: plan.baseMonthlyFeeAmount === null ? null : Number(plan.baseMonthlyFeeAmount),
    benefitPackageId: plan.benefitPackageId,
    effectiveFrom: plan.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: plan.effectiveTo?.toISOString().slice(0, 10) ?? null,
    energyPackageId: plan.energyPackageId,
    id: plan.id,
    maxPeriodMonths: plan.maxPeriodMonths,
    mileagePackageId: plan.mileagePackageId,
    minPeriodMonths: plan.minPeriodMonths,
    monthlyFeeCapRate: plan.monthlyFeeCapRate === null ? null : Number(plan.monthlyFeeCapRate),
    monthlyFeeMode: plan.monthlyFeeMode,
    monthlyFeeModeLabel: VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode],
    monthlyFeeRate: Number(plan.monthlyFeeRate),
    planName: plan.planName,
    planNo: plan.planNo,
    productId: plan.productId,
    productVersionId: plan.productVersionId,
    status: plan.status,
    vehiclePackageId: plan.vehiclePackageId
  };
}

function toPackageSnapshot(
  row:
    | Prisma.VehiclePackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.MileagePackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.EnergyPackageGetPayload<{ include: typeof packageInclude }>
    | Prisma.BenefitPackageGetPayload<{ include: typeof packageInclude }>
) {
  const result: Record<string, unknown> = {
    id: row.id,
    packageName: row.packageName,
    packageNo: row.packageNo,
    productId: row.productId,
    productVersionId: row.productVersionId,
    status: row.status
  };

  if ("vehicleModel" in row) {
    result.configName = row.configName;
    result.maxPurchasePriceAmount =
      row.maxPurchasePriceAmount === null ? null : Number(row.maxPurchasePriceAmount);
    result.minPurchasePriceAmount =
      row.minPurchasePriceAmount === null ? null : Number(row.minPurchasePriceAmount);
    result.monthlyFeeRate = Number(row.monthlyFeeRate);
    result.vehicleModel = row.vehicleModel;
  }
  if ("monthlyMileageKm" in row) {
    result.monthlyMileageKm = row.monthlyMileageKm;
    result.overMileageFeeAmount = Number(row.overMileageFeeAmount);
    result.priceAmount = Number(row.priceAmount);
  }
  if ("monthlyEnergyKwh" in row) {
    result.monthlyEnergyCount = row.monthlyEnergyCount;
    result.monthlyEnergyKwh = row.monthlyEnergyKwh;
    result.priceAmount = Number(row.priceAmount);
  }
  if ("benefitType" in row) {
    result.benefitCount = row.benefitCount;
    result.benefitType = row.benefitType;
    result.description = row.description;
    result.priceAmount = Number(row.priceAmount);
  }

  return result;
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
