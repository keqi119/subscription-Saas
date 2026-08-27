import type { Readable } from "node:stream";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PermissionCode } from "@subscription-saas/shared";
import {
  ApplicationActionType,
  ApplicationStatus,
  AuditAction,
  BusinessType,
  ContractSegmentStatus,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  CustomerStatus,
  DeliveryStatus,
  DepositStatus,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
  LeaseStatus,
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
  VehicleDamageLevel,
  VehicleHandoverType,
  VehicleMileageSourceType,
  VehicleReturnStatus,
  VehicleReturnType,
  VehicleStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { AssetOperationsService } from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { BillingAutomationService } from "../billing-automation/billing-automation.service";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { resolveVehicleInsuranceCoverage } from "../common/vehicle-insurance-coverage";
import { vehiclePackageSupportsModel } from "../common/vehicle-package-membership";
import { buildVehicleModelSnapshot } from "../common/vehicle-model-snapshot";
import { ContractPdfArtifactWriterService } from "../contract/contract-pdf-artifact-writer.service";
import type { ContractPdfArtifactWriteResult } from "../contract/contract-pdf-artifact.types";
import {
  ContractPdfAppendixRow,
  ContractPdfAppendixSection,
  ContractPdfRenderModel,
  ContractPdfValue,
  createStage1ContractPdfSigningSlots
} from "../contract/contract-pdf-render-model";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  AddDamageCloseupDto,
  AttachDeliveryEvidenceFileDto,
  DeclareNoVisibleDamageDto,
  RejectDeliveryEvidenceDto
} from "../delivery-evidence/delivery-evidence.dto";
import {
  DeliveryEvidenceReadiness,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import {
  DELIVERY_HANDOVER_NOT_READY_MESSAGE,
  findDeliveryHandoverForConfirmation,
  getDeliveryHandoverArchiveWarning,
  isDeliveryHandoverArchived,
  isDeliveryHandoverReadyForDelivery,
  isDeliveryHandoverSigned
} from "../delivery-handover/delivery-handover.service";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { MileageReviewService } from "../mileage-review/mileage-review.service";
import { activateLeaseRecord } from "../lease/lease-activation.persistence";
import { LeaseActivationEngine } from "../lease/lease-activation.engine";
import { VehicleMileageService } from "../vehicle-mileage/vehicle-mileage.service";
import { journeyError } from "../subscription-journey/subscription-journey.errors";
import {
  SubscriptionClosureService,
  type ManagedReturnTransactionCapability
} from "../subscription-closure/subscription-closure.service";
import { lockDeliveryConfirmationGateRows } from "./delivery-confirmation-gate-lock";
import { OrderEntitlementService } from "./order-entitlement.service";
import {
  ArchiveContractDto,
  CancelOrderDto,
  ConsumeEntitlementDto,
  CreateContractVersionDto,
  CreateCustomerOrderDto,
  CreateOrderChangeDto,
  CreateOrderFromQuoteDto,
  ConfirmDeliveryDto,
  ConfirmReturnDto,
  EntitlementMonthlyRenewalDto,
  ExpireEntitlementsDto,
  ListContractsQueryDto,
  ListOrdersQueryDto,
  ListEntitlementUsagesQueryDto,
  PrepareDeliveryDto,
  PrepareReturnDto,
  ReviewOrderDto,
  UpdateContractVersionDto
} from "./dto/order.dto";
import { projectOrderChangeView } from "./order-workspace-detail-projection";

const CURRENT_BUSINESS_TYPE = BusinessType.SUBSCRIPTION;
const RENT_TO_OWN_ORDER_NOT_OPEN_MESSAGE = "当前阶段暂未开放以租代购订单。";
const DISALLOWED_CHANGE_TYPES = new Set<OrderChangeType>([
  OrderChangeType.BUYOUT,
  OrderChangeType.EARLY_SETTLEMENT,
  OrderChangeType.OWNERSHIP_TRANSFER
]);
const CUSTOMER_ORDER_DEPOSIT_NOTICE =
  "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。";
const CUSTOMER_ORDER_MANUAL_QUOTE_MESSAGE = "该套餐需后台报价确认，暂不支持客户自助提交。";
const CUSTOMER_ORDER_VEHICLE_UNAVAILABLE_MESSAGE = "所选车辆当前不可租用，请重新选择车辆";

const CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED_ENV = "CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED";
const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";
const STAGE1_PARTY_B_ID_NUMBER_MISSING = "STAGE1_PARTY_B_ID_NUMBER_MISSING";

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
const ORDER_FULFILLMENT_CHANGE_MESSAGE = "当前订单已进入履约阶段，请走履约变更或合同变更流程。";
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
const RETURN_ALREADY_DONE_MESSAGE = "该订单已完成退车，不能重复退车。";
const RETURN_READY_REQUIRED_MESSAGE = "请先准备退车验收。";
const RETURN_REQUIRED_CHECKLIST: Array<keyof ConfirmReturnDto> = [
  "keysReturnedConfirmed",
  "chargingEquipmentReturnedConfirmed",
  "vehicleDocumentsReturnedConfirmed",
  "customerItemsClearedConfirmed",
  "exteriorCheckedConfirmed",
  "interiorCheckedConfirmed",
  "batteryCheckedConfirmed",
  "mileageConfirmed",
  "violationCheckedConfirmed"
];

const packageInclude = {
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
} satisfies Prisma.VehiclePackageInclude;

const modelDefinitionIdentitySelect = {
  displayName: true,
  id: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

const vehiclePackageInclude = {
  ...packageInclude,
  modelDefinition: { select: modelDefinitionIdentitySelect },
  modelMembers: { select: { modelDefinitionId: true } }
} satisfies Prisma.VehiclePackageInclude;

const subscriptionPlanInclude = {
  benefitPackage: { include: packageInclude },
  energyPackage: { include: packageInclude },
  mileagePackage: { include: packageInclude },
  product: {
    select: {
      id: true,
      name: true,
      productNo: true,
      productType: true,
      status: true,
      deletedAt: true
    }
  },
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
  vehiclePackage: { include: vehiclePackageInclude }
} satisfies Prisma.SubscriptionPlanInclude;

const orderInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  changes: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  contract: true,
  contracts: { orderBy: { createdAt: "desc" as const }, where: { deletedAt: null } },
  contractSegments: { orderBy: { sequenceNo: "asc" as const } },
  customer: {
    select: {
      grade: true,
      id: true,
      identity: { select: { idCardNo: true } },
      mobile: true,
      name: true,
      profile: { select: { residenceAddress: true } }
    }
  },
  productVersion: { include: { product: true } },
  quote: { select: { id: true, packageSnapshot: true, quoteNo: true, status: true } },
  riskResult: true,
  vehicle: {
    include: {
      insurancePolicies: { where: { deletedAt: null } },
      modelDefinition: { select: modelDefinitionIdentitySelect }
    }
  }
} satisfies Prisma.SubscriptionOrderInclude;

const quoteInclude = {
  application: { select: { applicationNo: true, id: true, salesUserId: true, status: true } },
  customer: { select: { grade: true, id: true, mobile: true, name: true } },
  order: true,
  productVersion: { include: { product: true } },
  riskResult: true,
  vehicle: { include: { modelDefinition: { select: modelDefinitionIdentitySelect } } }
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

const returnInclude = {
  customer: { select: { id: true, mobile: true, name: true } },
  damages: { orderBy: { createdAt: "asc" as const }, where: { deletedAt: null } },
  vehicle: true
} satisfies Prisma.VehicleReturnInclude;

const entitlementGrantUsageOverviewInclude = {
  usages: {
    orderBy: { occurredAt: "desc" as const },
    take: 1,
    where: { deletedAt: null, usageStatus: EntitlementUsageStatus.CONFIRMED }
  }
} satisfies Prisma.OrderEntitlementGrantInclude;

const entitlementAccountInclude = {
  grants: {
    include: entitlementGrantUsageOverviewInclude,
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.OrderEntitlementAccountInclude;

type OrderWithDetails = Prisma.SubscriptionOrderGetPayload<{ include: typeof orderInclude }>;
type QuoteWithDetails = Prisma.SubscriptionQuoteGetPayload<{ include: typeof quoteInclude }>;
type ContractWithDetails = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;
type SubscriptionPlanWithDetails = Prisma.SubscriptionPlanGetPayload<{
  include: typeof subscriptionPlanInclude;
}>;
type DeliveryWithDetails = Prisma.VehicleDeliveryGetPayload<{ include: typeof deliveryInclude }>;
type ReturnWithDetails = Prisma.VehicleReturnGetPayload<{ include: typeof returnInclude }>;
type EntitlementAccountWithGrants = Prisma.OrderEntitlementAccountGetPayload<{
  include: typeof entitlementAccountInclude;
}>;
type EntitlementGrantWithUsageOverview = Prisma.OrderEntitlementGrantGetPayload<{
  include: typeof entitlementGrantUsageOverviewInclude;
}>;
type EntitlementUsageRecord = Prisma.OrderEntitlementUsageGetPayload<object>;
type EntitlementRenewalAction =
  | "GENERATED"
  | "SKIPPED_NOT_DUE"
  | "SKIPPED_EXISTING"
  | "FAILED"
  | "DRY_RUN_GENERATE"
  | "DRY_RUN_SKIP"
  | "DRY_RUN_FAILED";

type MonthlyRenewalPlan = {
  action: EntitlementRenewalAction;
  account: EntitlementAccountWithGrants;
  asOfDate: Date;
  dryRun: boolean;
  existingGrants: EntitlementAccountWithGrants["grants"];
  grantInputs: OrderEntitlementGrantInput[];
  missingGrantInputs: OrderEntitlementGrantInput[];
  nextCycleIndex: number;
  order: OrderWithDetails;
  periodEnd: Date;
  periodStart: Date;
  reason: string;
};

type ContractPdfPreview = {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: Readable;
};

type DeliveryConfirmationDefaults = {
  deliveredAt: string;
  deliveredAtSource: "STAGE2_COMPLETED_AT";
  fieldWorkOrderId: string;
  handoverMileageKm: number;
  handoverMileageSource: "FIELD_WORK_ORDER";
  stage2HandoverId: string;
};

type DeliveryConfirmationDefaultsResolution = {
  blockingReasons: string[];
  defaults: DeliveryConfirmationDefaults | null;
};

@Injectable()
export class OrderService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    @Optional() private readonly contractPdfArtifactWriter?: ContractPdfArtifactWriterService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly storageService?: StorageService,
    @Optional() private readonly deliveryEvidenceService?: DeliveryEvidenceService,
    @Optional() private readonly handoverWorkOrderService?: HandoverWorkOrderService,
    @Optional() private readonly vehicleMileageService?: VehicleMileageService,
    @Optional() private readonly mileageReviewService?: MileageReviewService,
    @Optional() private readonly billingAutomationService?: BillingAutomationService,
    @Optional() private readonly orderEntitlementService?: OrderEntitlementService,
    @Optional() private readonly leaseActivationEngine?: LeaseActivationEngine,
    @Optional() private readonly assetOperationsService?: AssetOperationsService,
    @Optional() private readonly subscriptionClosureService?: SubscriptionClosureService
  ) {}

  async listOrders(user: RequestUser, query: ListOrdersQueryDto = {}) {
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      where: {
        ...(canViewAllOrders(user)
          ? {}
          : { application: { salesUserId: user.id } }),
        deletedAt: null,
        ...(query.journeyStatus
          ? {
              subscriptionJourney: {
                is: { status: query.journeyStatus }
              }
            }
          : {})
      }
    });
    return orders.map(toOrderView);
  }

  async createJourneyContractInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorId: string,
    sourceKey: string
  ) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "subscription_order"
      WHERE "id" = ${orderId}::uuid
      FOR UPDATE
    `);
    const order = await tx.subscriptionOrder.findUnique({
      include: orderInclude,
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw journeyError("JOURNEY_NOT_FOUND", "The journey order was not found.");
    }
    if (
      order.businessType !== BusinessType.SUBSCRIPTION ||
      order.productVersion.product.productType !== ProductType.SUBSCRIPTION
    ) {
      throw journeyError(
        "JOURNEY_APPLICATION_PRODUCT_INVALID",
        "The journey order is not a subscription product."
      );
    }
    if (!order.vehicleId || order.vehicle?.status !== VehicleStatus.RESERVED) {
      throw journeyError(
        "JOURNEY_APPLICATION_VEHICLE_UNAVAILABLE",
        "The journey order does not have a reserved concrete vehicle."
      );
    }

    const existing = await tx.contract.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderId,
        status: { not: ContractStatus.CANCELLED }
      }
    });
    if (existing) {
      const existingSourceKey = asSnapshotRecord(existing.contractSnapshot)?.journeySourceKey;
      if (existingSourceKey && existingSourceKey !== sourceKey) {
        throw journeyError(
          "JOURNEY_IDEMPOTENCY_CONFLICT",
          "The journey order is already attached to a contract from another source."
        );
      }
      return existing;
    }
    if (order.orderStatus !== OrderStatus.PENDING_CONTRACT) {
      throw journeyError(
        "JOURNEY_INVALID_TRANSITION",
        "The journey order is not waiting for contract generation."
      );
    }

    const now = new Date();
    const template = await tx.contractVersion.findFirst({
      orderBy: { effectiveFrom: "desc" },
      where: {
        businessType: BusinessType.SUBSCRIPTION,
        deletedAt: null,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        status: ContractVersionStatus.ACTIVE,
        templateType: ContractTemplateType.SUBSCRIPTION_STANDARD
      }
    });
    if (!template) {
      throw journeyError(
        "JOURNEY_CONTRACT_TEMPLATE_INACTIVE",
        "No active subscription contract template is available."
      );
    }
    assertStage1PartyBIdNumberPresent(order);
    const contractSnapshot = toJsonValue({
      contentTemplate: template.contentTemplate,
      customer: buildContractSnapshotCustomer(order.customer),
      journeySourceKey: sourceKey,
      order: toOrderView(order),
      quoteSnapshot: order.quoteSnapshot
    });
    const created = await tx.contract.create({
      data: {
        businessType: BusinessType.SUBSCRIPTION,
        contractNo: createBusinessNo("CON"),
        contractSnapshot,
        contractTitle: `${template.templateName} ${template.versionNo}`,
        contractVersionId: template.id,
        createdBy: actorId,
        customerId: order.customerId,
        orderId,
        status: ContractStatus.GENERATED,
        updatedBy: actorId
      }
    });
    await tx.subscriptionOrder.update({
      data: {
        contractId: created.id,
        orderStatus: OrderStatus.PENDING_SIGN,
        updatedBy: actorId
      },
      where: { id: orderId }
    });
    return tx.contract.findUniqueOrThrow({ where: { id: created.id } });
  }

  async ensureJourneyContractPdfArtifact(contractId: string, actorId: string): Promise<void> {
    if (!this.contractPdfArtifactWriter) {
      throw journeyError(
        "JOURNEY_CONFIGURATION_ERROR",
        "The generated contract PDF writer is not configured."
      );
    }
    const contract = await this.findContractOrThrow(contractId);
    if (hasGeneratedContractPdfArtifact(contract)) {
      return;
    }
    if (contract.fileId) {
      throw journeyError(
        "JOURNEY_IDEMPOTENCY_CONFLICT",
        "The journey contract has a file that is not a generated signing PDF artifact."
      );
    }
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: orderInclude,
      where: { id: contract.orderId }
    });
    if (!order || order.deletedAt || order.contractId !== contract.id) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "The journey contract is not attached to its active order."
      );
    }

    const artifact = await this.contractPdfArtifactWriter.writeGeneratedContractPdfArtifact({
      cjkFontPath: this.configService?.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
      contractStatus: contract.status,
      existingContractFileId: contract.fileId,
      recoverExistingObject: true,
      renderModel: buildContractPdfRenderModel(contract, order, contract.contractVersion),
      uploadedBy: actorId
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "contract"
        WHERE "id" = ${contractId}::uuid
        FOR UPDATE
      `);
      const current = await tx.contract.findUniqueOrThrow({ where: { id: contractId } });
      if (current.deletedAt) {
        throw journeyError("JOURNEY_NOT_FOUND", "The journey contract was not found.");
      }
      if (hasGeneratedContractPdfArtifact(current)) {
        return;
      }
      if (current.fileId && current.fileId !== artifact.fileId) {
        throw journeyError(
          "JOURNEY_IDEMPOTENCY_CONFLICT",
          "The journey contract was attached to another file while its PDF was generated."
        );
      }
      await tx.contract.update({
        data: {
          contractSnapshot: buildContractSnapshotWithGeneratedPdfArtifact(
            current.contractSnapshot,
            artifact
          ),
          fileId: artifact.fileId,
          updatedBy: actorId
        },
        where: { id: contractId }
      });
    });
  }

  async getOrder(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    return toOrderView(order);
  }

  async getOrderEntitlements(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);

    const account = await this.findActiveEntitlementAccount(id);
    if (!account) {
      return { account: null, grants: [] };
    }

    return toEntitlementResponse(account);
  }

  async generateOrderEntitlements(id: string, user: RequestUser, context: RequestContext) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    assertCanGenerateEntitlements(order);

    const existingAccount = await this.findActiveEntitlementAccount(id);
    if (existingAccount) {
      return toEntitlementResponse(existingAccount);
    }

    const snapshot = resolveOrderEntitlementSnapshot(order);
    const grantInputs = buildOrderEntitlementGrantInputs(snapshot.packageSnapshot);
    if (grantInputs.length === 0) {
      throw new BadRequestException("当前订单套餐快照缺少可生成权益的组件。");
    }

    const firstPeriod = resolveMonthlyEntitlementPeriod(order, 0);
    const periodStart = firstPeriod.periodStart;
    const periodEnd = firstPeriod.periodEnd;
    const accountSnapshot = toJsonValue({
      customer: order.customer,
      generatedAt: new Date().toISOString(),
      order: {
        actualDeliveryAt: order.actualDeliveryAt,
        orderId: order.id,
        orderNo: order.orderNo,
        orderStatus: order.orderStatus,
        periodMonths: order.periodMonths
      },
      packageSnapshot: snapshot.packageSnapshot,
      source: EntitlementGrantSource.ORDER_START,
      sourceSnapshot: snapshot.sourceSnapshot,
      vehicle: order.vehicle
        ? {
            brand: order.vehicle.brand,
            id: order.vehicle.id,
            plateNo: order.vehicle.plateNo,
            vehicleNo: order.vehicle.vehicleNo,
            vin: order.vehicle.vin
          }
        : null
    });
    const subscriptionPlanId = resolveSubscriptionPlanId(snapshot.packageSnapshot);

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        await (
          this.orderEntitlementService ?? new OrderEntitlementService()
        ).ensureInitialEntitlements(tx, id, user.id);
        const accountInTransaction = await tx.orderEntitlementAccount.findFirst({
          include: entitlementAccountInclude,
          orderBy: { createdAt: "desc" },
          where: {
            deletedAt: null,
            orderId: id
          }
        });

        if (accountInTransaction) {
          const created =
            accountInTransaction.accountStatus !== EntitlementAccountStatus.ACTIVE;
          if (created) {
            await tx.orderEntitlementAccount.update({
              data: {
                accountStatus: EntitlementAccountStatus.ACTIVE,
                updatedBy: user.id
              },
              where: { id: accountInTransaction.id }
            });
          }
          const activeAccount = await tx.orderEntitlementAccount.findUniqueOrThrow({
            include: entitlementAccountInclude,
            where: { id: accountInTransaction.id }
          });
          return { account: activeAccount, created };
        }

        const account = await tx.orderEntitlementAccount.create({
          data: {
            accountNo: createBusinessNo("EA"),
            accountStatus: EntitlementAccountStatus.ACTIVE,
            createdBy: user.id,
            customerId: order.customerId,
            orderId: order.id,
            periodEnd,
            periodStart,
            snapshot: accountSnapshot,
            subscriptionPlanId,
            updatedBy: user.id
          }
        });

        for (const grant of grantInputs) {
          await tx.orderEntitlementGrant.create({
            data: {
              accountId: account.id,
              createdBy: user.id,
              customerId: order.customerId,
              entitlementName: grant.entitlementName,
              entitlementType: grant.entitlementType,
              grantNo: createBusinessNo("EG"),
              grantPeriodEnd: periodEnd,
              grantPeriodStart: periodStart,
              grantSource: EntitlementGrantSource.ORDER_START,
              orderId: order.id,
              remainingAmount: grant.remainingAmount,
              snapshot: grant.snapshot,
              status: EntitlementGrantStatus.ACTIVE,
              totalAmount: grant.totalAmount,
              unit: grant.unit,
              updatedBy: user.id,
              usedAmount: grant.usedAmount
            }
          });
        }

        const accountWithGrants = await tx.orderEntitlementAccount.findUniqueOrThrow({
          include: entitlementAccountInclude,
          where: { id: account.id }
        });

        return { account: accountWithGrants, created: true };
      })
    );

    if (result.created) {
      await this.writeEntitlementAudit(
        AuditAction.CREATE,
        "order_entitlement_account",
        result.account.id,
        result.account,
        user,
        context
      );
      await this.writeEntitlementAudit(
        AuditAction.CREATE,
        "order_entitlement_grant",
        result.account.id,
        {
          accountId: result.account.id,
          customerId: order.customerId,
          grantIds: result.account.grants.map((grant) => grant.id),
          orderId: order.id,
          source: EntitlementGrantSource.ORDER_START
        },
        user,
        context
      );
    }

    return toEntitlementResponse(result.account);
  }

  async renewOrderMonthlyEntitlements(
    id: string,
    dto: EntitlementMonthlyRenewalDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);

    const asOfDate = resolveEntitlementAsOfDate(dto.asOfDate);
    const dryRun = Boolean(dto.dryRun);
    const plan = await this.buildMonthlyRenewalPlan(order, asOfDate, dryRun);
    if (plan.action !== "GENERATED" && plan.action !== "DRY_RUN_GENERATE") {
      return toMonthlyRenewalResponse(plan);
    }
    if (dryRun) {
      return toMonthlyRenewalResponse(plan);
    }

    const createdGrants = await this.createMonthlyRenewalGrants(plan, user);
    const action = createdGrants.length > 0 ? "GENERATED" : "SKIPPED_EXISTING";
    const response = toMonthlyRenewalResponse(
      plan,
      action,
      createdGrants.map((grant) => grant.id)
    );

    if (createdGrants.length > 0) {
      await this.writeEntitlementAudit(
        AuditAction.CREATE,
        "order_entitlement_grant",
        plan.account.id,
        {
          accountId: plan.account.id,
          asOfDate: dateKey(plan.asOfDate),
          grantCount: createdGrants.length,
          grantIds: createdGrants.map((grant) => grant.id),
          orderId: order.id,
          periodEnd: dateKey(plan.periodEnd),
          periodStart: dateKey(plan.periodStart),
          source: EntitlementGrantSource.MONTHLY_RENEWAL
        },
        user,
        context
      );
    }

    return response;
  }

  async generateMonthlyEntitlements(
    dto: EntitlementMonthlyRenewalDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const asOfDate = resolveEntitlementAsOfDate(dto.asOfDate);
    const dryRun = Boolean(dto.dryRun);
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: orderInclude,
      orderBy: { actualDeliveryAt: "asc" },
      where: {
        actualDeliveryAt: { not: null },
        deletedAt: null,
        orderStatus: OrderStatus.ACTIVE
      }
    });
    const items: Array<Record<string, unknown>> = [];
    const generatedAuditItems: Array<Record<string, unknown>> = [];

    for (const order of orders) {
      try {
        const plan = await this.buildMonthlyRenewalPlan(order, asOfDate, dryRun);
        if (plan.action === "GENERATED" && !dryRun) {
          const createdGrants = await this.createMonthlyRenewalGrants(plan, user);
          const action = createdGrants.length > 0 ? "GENERATED" : "SKIPPED_EXISTING";
          const item = toMonthlyRenewalItem(
            plan,
            action,
            createdGrants.map((grant) => grant.id)
          );
          items.push(item);
          if (createdGrants.length > 0) {
            generatedAuditItems.push({
              accountId: plan.account.id,
              grantCount: createdGrants.length,
              grantIds: createdGrants.map((grant) => grant.id),
              orderId: order.id,
              orderNo: order.orderNo,
              periodEnd: dateKey(plan.periodEnd),
              periodStart: dateKey(plan.periodStart)
            });
          }
        } else {
          items.push(toMonthlyRenewalItem(plan));
        }
      } catch (error) {
        items.push(toMonthlyRenewalFailedItem(order, dryRun, error));
      }
    }

    if (!dryRun && generatedAuditItems.length > 0) {
      await this.writeEntitlementAudit(
        AuditAction.CREATE,
        "order_entitlement_grant",
        `monthly-renewal-${dateKey(asOfDate)}`,
        {
          asOfDate: dateKey(asOfDate),
          generatedCount: generatedAuditItems.length,
          items: generatedAuditItems,
          source: EntitlementGrantSource.MONTHLY_RENEWAL
        },
        user,
        context
      );
    }

    return toMonthlyRenewalBatchResponse(items, dryRun);
  }

  async expireEntitlements(dto: ExpireEntitlementsDto, user: RequestUser, context: RequestContext) {
    const asOfDate = resolveEntitlementAsOfDate(dto.asOfDate);
    const dryRun = Boolean(dto.dryRun);
    const where: Prisma.OrderEntitlementGrantWhereInput = {
      deletedAt: null,
      grantPeriodEnd: { lt: asOfDate },
      status: EntitlementGrantStatus.ACTIVE
    };
    const [items, activeCount] = await Promise.all([
      this.prisma.orderEntitlementGrant.findMany({
        orderBy: { grantPeriodEnd: "asc" },
        where
      }),
      this.prisma.orderEntitlementGrant.count({
        where: { deletedAt: null, status: EntitlementGrantStatus.ACTIVE }
      })
    ]);

    if (dryRun) {
      return toExpireEntitlementsResponse(items, activeCount, dryRun);
    }

    const result = await this.prisma.orderEntitlementGrant.updateMany({
      data: {
        status: EntitlementGrantStatus.EXPIRED,
        updatedBy: user.id
      },
      where
    });

    if (result.count > 0) {
      await this.writeEntitlementAudit(
        AuditAction.UPDATE,
        "order_entitlement_grant",
        `entitlement-expire-${dateKey(asOfDate)}`,
        {
          asOfDate: dateKey(asOfDate),
          expiredCount: result.count,
          grantIds: items.map((grant) => grant.id),
          items: items.map((grant) => ({
            accountId: grant.accountId,
            grantId: grant.id,
            orderId: grant.orderId,
            periodEnd: grant.grantPeriodEnd ? dateKey(grant.grantPeriodEnd) : null,
            periodStart: dateKey(grant.grantPeriodStart)
          })),
          source: "ENTITLEMENT_EXPIRE"
        },
        user,
        context
      );
    }

    return toExpireEntitlementsResponse(items, activeCount, dryRun, result.count);
  }

  async consumeOrderEntitlement(
    id: string,
    grantId: string,
    dto: ConsumeEntitlementDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    assertCanConsumeEntitlementOrder(order);

    const usedAmount = positiveEntitlementAmount(dto.usedAmount);
    const occurredAt = dto.occurredAt ? parseDateTime(dto.occurredAt, "occurredAt") : new Date();
    const usageSource = dto.usageSource ?? EntitlementUsageSource.MANUAL;
    const externalRefNo = optionalText(dto.externalRefNo, 128);
    const scenario = optionalText(dto.scenario, 128);
    const remark = optionalText(dto.remark);

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const existingUsage = externalRefNo
          ? await tx.orderEntitlementUsage.findFirst({
              where: {
                deletedAt: null,
                externalRefNo,
                grantId,
                orderId: id,
                usageStatus: { not: EntitlementUsageStatus.CANCELLED }
              }
            })
          : null;

        if (existingUsage) {
          const existingGrant = await tx.orderEntitlementGrant.findFirst({
            include: entitlementGrantUsageOverviewInclude,
            where: { deletedAt: null, id: existingUsage.grantId, orderId: id }
          });
          if (!existingGrant) {
            throw new NotFoundException("权益发放记录不存在或不属于当前订单。");
          }
          return { created: false, grant: existingGrant, usage: existingUsage };
        }

        const activeAccount = await tx.orderEntitlementAccount.findFirst({
          orderBy: { createdAt: "desc" },
          where: {
            accountStatus: EntitlementAccountStatus.ACTIVE,
            deletedAt: null,
            orderId: id
          }
        });
        const account =
          activeAccount ??
          (await tx.orderEntitlementAccount.findFirst({
            orderBy: { createdAt: "desc" },
            where: { deletedAt: null, orderId: id }
          }));
        assertCanConsumeEntitlementAccount(account);

        const grant = await tx.orderEntitlementGrant.findFirst({
          where: {
            accountId: account.id,
            deletedAt: null,
            id: grantId,
            orderId: id
          }
        });
        assertCanConsumeEntitlementGrant(grant);
        assertGrantWithinConsumptionPeriod(grant, order, occurredAt);

        const remainingAmount = requiredGrantRemainingAmount(grant);
        if (usedAmount.gt(remainingAmount)) {
          throw new BadRequestException("权益剩余额度不足，不能超额消耗。");
        }

        const nextRemainingAmount = remainingAmount.minus(usedAmount);
        if (nextRemainingAmount.lt(0)) {
          throw new BadRequestException("权益剩余额度不足，不能超额消耗。");
        }

        const currentUsedAmount = grant.usedAmount ?? new Prisma.Decimal(0);
        const nextUsedAmount = currentUsedAmount.plus(usedAmount);
        const nextStatus = nextRemainingAmount.equals(0)
          ? EntitlementGrantStatus.EXHAUSTED
          : EntitlementGrantStatus.ACTIVE;
        const updateResult = await tx.orderEntitlementGrant.updateMany({
          data: {
            remainingAmount: nextRemainingAmount,
            status: nextStatus,
            updatedBy: user.id,
            usedAmount: nextUsedAmount
          },
          where: {
            deletedAt: null,
            id: grant.id,
            remainingAmount: { gte: usedAmount },
            status: EntitlementGrantStatus.ACTIVE
          }
        });

        if (updateResult.count !== 1) {
          throw new BadRequestException("权益剩余额度不足，不能超额消耗。");
        }

        const usage = await tx.orderEntitlementUsage.create({
          data: {
            accountId: account.id,
            createdBy: user.id,
            customerId: order.customerId,
            entitlementName: grant.entitlementName,
            entitlementType: grant.entitlementType,
            externalRefNo,
            grantId: grant.id,
            occurredAt,
            orderId: order.id,
            remark,
            scenario,
            snapshot: toJsonValue({
              account: {
                accountNo: account.accountNo,
                accountStatus: account.accountStatus,
                id: account.id
              },
              grant: {
                entitlementName: grant.entitlementName,
                entitlementType: grant.entitlementType,
                grantNo: grant.grantNo,
                id: grant.id,
                remainingAmount: grant.remainingAmount,
                status: grant.status,
                totalAmount: grant.totalAmount,
                unit: grant.unit,
                usedAmount: grant.usedAmount
              },
              order: {
                orderId: order.id,
                orderNo: order.orderNo,
                orderStatus: order.orderStatus
              }
            }),
            unit: grant.unit,
            updatedBy: user.id,
            usageNo: createBusinessNo("EU"),
            usageSource,
            usageStatus: EntitlementUsageStatus.CONFIRMED,
            usedAmount
          }
        });

        const updatedGrant = await tx.orderEntitlementGrant.findUniqueOrThrow({
          include: entitlementGrantUsageOverviewInclude,
          where: { id: grant.id }
        });

        return { created: true, grant: updatedGrant, usage };
      })
    );

    if (result.created) {
      await this.writeEntitlementAudit(
        AuditAction.CREATE,
        "order_entitlement_usage",
        result.usage.id,
        {
          accountId: result.usage.accountId,
          customerId: result.usage.customerId,
          entitlementType: result.usage.entitlementType,
          externalRefNo: result.usage.externalRefNo,
          grantId: result.usage.grantId,
          orderId: result.usage.orderId,
          remainingAmount: result.grant.remainingAmount,
          source: result.usage.usageSource,
          unit: result.usage.unit,
          usageId: result.usage.id,
          usedAmount: result.usage.usedAmount
        },
        user,
        context
      );
    }

    return {
      grant: toEntitlementGrantView(result.grant),
      usage: toEntitlementUsageView(result.usage)
    };
  }

  async listOrderEntitlementUsages(
    id: string,
    query: ListEntitlementUsagesQueryDto,
    user: RequestUser
  ) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);

    const pagination = resolveEntitlementUsagePagination(query);
    const where: Prisma.OrderEntitlementUsageWhereInput = {
      deletedAt: null,
      orderId: id,
      ...(query.entitlementType ? { entitlementType: query.entitlementType } : {}),
      ...(query.grantId ? { grantId: query.grantId } : {}),
      ...(query.usageStatus ? { usageStatus: query.usageStatus } : {})
    };
    const occurredAt: Prisma.DateTimeFilter = {};
    if (query.startDate) {
      occurredAt.gte = parseDateTime(query.startDate, "startDate");
    }
    if (query.endDate) {
      occurredAt.lte = parseDateTime(query.endDate, "endDate");
    }
    if (Object.keys(occurredAt).length > 0) {
      where.occurredAt = occurredAt;
    }

    const [items, total] = await Promise.all([
      this.prisma.orderEntitlementUsage.findMany({
        orderBy: { occurredAt: "desc" },
        skip: pagination.skip,
        take: pagination.pageSize,
        where
      }),
      this.prisma.orderEntitlementUsage.count({ where })
    ]);

    return {
      items: items.map(toEntitlementUsageView),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total
    };
  }

  async listReviewQueue(user: RequestUser) {
    const orders = await this.prisma.subscriptionOrder.findMany({
      include: orderInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderSource: OrderSource.CUSTOMER_SELF_SERVICE,
        orderStatus: {
          in: [OrderStatus.PENDING_REVIEW, OrderStatus.PENDING_CUSTOMER_CONFIRMATION]
        },
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
      return this.rejectCustomerOrder(
        id,
        { ...dto, status: OrderReviewStatus.REJECTED },
        user,
        context,
        reviewType
      );
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
      await this.writeAudit(
        AuditAction.UPDATE,
        "subscription_order",
        id,
        toOrderView(before),
        toOrderView(order),
        user,
        context
      );
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
          throw new BadRequestException(
            `No active deposit rule configured for grade ${dto.customerGrade}.`
          );
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      toOrderView(before),
      toOrderView(result.order),
      user,
      context
    );
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      toOrderView(before),
      toOrderView(order),
      user,
      context
    );
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
        if (this.assetOperationsService) {
          await lockVehicleAvailabilityAuthority(tx, before.vehicleId);
        }
        vehicleBefore = await tx.vehicle.findUnique({ where: { id: before.vehicleId } });
        if (
          !vehicleBefore ||
          vehicleBefore.deletedAt ||
          vehicleBefore.status !== VehicleStatus.REVIEW_RESERVED
        ) {
          throw new BadRequestException("订单车辆未处于审核占用状态，无法释放库存。");
        }
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          before.vehicleId,
          VehicleAvailabilityPurpose.MARK_AVAILABLE,
          new Date(),
          VehicleStatus.AVAILABLE
        );
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
        if (this.assetOperationsService) {
          await lockVehicleAvailabilityAuthority(tx, before.vehicleId);
        }
        vehicleBefore = await tx.vehicle.findUnique({ where: { id: before.vehicleId } });
        if (
          !vehicleBefore ||
          vehicleBefore.deletedAt ||
          vehicleBefore.status !== VehicleStatus.REVIEW_RESERVED
        ) {
          throw new BadRequestException("订单车辆未处于审核占用状态，无法进入签约。");
        }
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          before.vehicleId,
          VehicleAvailabilityPurpose.ALLOCATION,
          new Date(),
          VehicleStatus.AVAILABLE
        );
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

    await this.writeAudit(
      AuditAction.APPROVE,
      "subscription_order",
      id,
      toOrderView(before),
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

  async createCustomerOrder(
    dto: CreateCustomerOrderDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const [customer, vehicle, plan] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: dto.customerId } }),
      this.prisma.vehicle.findUnique({
        include: { modelDefinition: { select: modelDefinitionIdentitySelect } },
        where: { id: dto.vehicleId }
      }),
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

    const modelCode = vehicle.modelDefinition.modelCode;
    if (!vehiclePackageSupportsModel(plan.vehiclePackage, vehicle.modelDefinitionId)) {
      throw new BadRequestException("所选套餐不适用于该车型");
    }
    const modelSnapshot = buildVehicleModelSnapshot({
      modelCode,
      modelDefinitionId: vehicle.modelDefinitionId,
      modelDisplayName: vehicle.modelDefinition.displayName
    });
    assertPeriodInRange(dto.periodMonths, plan.minPeriodMonths, plan.maxPeriodMonths);

    const vehicleSalePriceAmount = vehicle.currentSalePriceAmount;
    if (!vehicleSalePriceAmount || vehicleSalePriceAmount <= 0n) {
      throw new BadRequestException("当前车辆销售价未初始化，无法下单");
    }
    const vehicleBaseFeePricing = calculateCustomerOrderVehicleBaseFee(
      plan,
      vehicleSalePriceAmount
    );
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
      modelCode,
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

    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        if (this.assetOperationsService) {
          await lockVehicleAvailabilityAuthority(tx, dto.vehicleId);
        }
        const vehicleBefore = await tx.vehicle.findUnique({ where: { id: dto.vehicleId } });
        assertVehicleAvailableForCustomerOrder(vehicleBefore);
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          dto.vehicleId,
          VehicleAvailabilityPurpose.ALLOCATION,
          new Date()
        );

        const application = await tx.application.create({
          data: {
            applicationNo: createBusinessNo("APP"),
            createdBy: user.id,
            customerId: customer.id,
            intendedModel: modelCode,
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

        const quote = (await tx.subscriptionQuote.create({
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
            ...modelSnapshot,
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
            vehiclePackageId: plan.vehiclePackage.id,
            vehiclePurchasePriceAmount: vehicle.purchasePriceAmount,
            vehicleSalePriceAmount,
            vehicleSnapshot
          },
          include: quoteInclude
        })) as QuoteWithDetails;

        const quoteSnapshot = toJsonValue({
          ...(toPlain(quote) as Record<string, unknown>),
          customerSelectedSnapshot,
          depositDescription: CUSTOMER_ORDER_DEPOSIT_NOTICE,
          depositStatus: DepositStatus.PENDING_CONFIRM,
          finalDepositAmount: null
        });

        const order = (await tx.subscriptionOrder.create({
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
            ...modelSnapshot,
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
            vehiclePurchasePriceAmount: vehicle.purchasePriceAmount,
            vehicleReviewStatus: OrderReviewStatus.PENDING
          },
          include: orderInclude
        })) as OrderWithDetails;

        const vehicleAfter = await tx.vehicle.update({
          data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: user.id },
          where: { id: vehicle.id }
        });

        return { application, order, quote, vehicleAfter, vehicleBefore };
      })
    );

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
    await this.writeAudit(
      AuditAction.CREATE,
      "subscription_order",
      result.order.id,
      undefined,
      toOrderView(result.order),
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
    if (
      quote.order &&
      !quote.order.deletedAt &&
      quote.order.orderStatus !== OrderStatus.CANCELLED
    ) {
      throw new BadRequestException("该报价已生成订单，请勿重复创建。");
    }

    if (!quote.vehicleId) {
      throw new BadRequestException("已确认报价未绑定车辆，无法创建订单。");
    }
    if (
      !quote.vehicle ||
      quote.vehicle.deletedAt ||
      quote.vehicle.status !== VehicleStatus.RESERVED
    ) {
      throw new BadRequestException("已确认报价绑定车辆未锁定，请重新确认报价。");
    }

    const quoteSnapshot = toJsonValue(toPlain(quote));
    const modelSnapshot = buildVehicleModelSnapshot({
      modelCode: quote.modelCodeSnapshot,
      modelDefinitionId: quote.modelDefinitionIdSnapshot,
      modelDisplayName: quote.modelDisplayNameSnapshot
    });
    const order = await withUniqueBusinessNoRetry(() =>
      this.prisma.subscriptionOrder.create({
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
          ...modelSnapshot,
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
          vehiclePurchasePriceAmount: quote.vehiclePurchasePriceAmount
        },
        include: orderInclude
      })
    );

    await this.writeAudit(
      AuditAction.CREATE,
      "subscription_order",
      order.id,
      undefined,
      toOrderView(order),
      user,
      context
    );
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
        if (this.assetOperationsService) {
          await lockVehicleAvailabilityAuthority(tx, before.vehicleId);
        }
        vehicleBefore = await tx.vehicle.findUnique({ where: { id: before.vehicleId } });
        if (
          !vehicleBefore ||
          vehicleBefore.deletedAt ||
          vehicleBefore.status !== VehicleStatus.RESERVED
        ) {
          throw new BadRequestException("订单车辆未处于签约锁定状态，无法释放库存。");
        }
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          before.vehicleId,
          VehicleAvailabilityPurpose.MARK_AVAILABLE,
          new Date(),
          VehicleStatus.AVAILABLE
        );
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      { ...toOrderView(before), reason: dto.reason },
      toOrderView(order),
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
    return toOrderView(order);
  }

  async getDeliveryCheck(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const [delivery, handover] = await Promise.all([
      this.prisma.vehicleDelivery.findUnique({
        include: deliveryInclude,
        where: { orderId: id }
      }),
      findActiveDeliveryHandover(this.prisma, id)
    ]);
    const confirmationDefaults = await resolveDeliveryConfirmationDefaults(
      this.prisma,
      id,
      handover
    );
    const evidenceReadiness = await this.getDeliveryConfirmationReadiness(id, handover?.id ?? null);
    return buildDeliveryCheck(
      order,
      delivery && !delivery.deletedAt ? delivery : null,
      undefined,
      handover,
      evidenceReadiness,
      confirmationDefaults
    );
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

  async getDeliveryEvidenceChecklist(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    return this.getDeliveryEvidenceService().getChecklist({
      handoverId: handover?.id ?? null,
      orderId: id
    });
  }

  async initializeDeliveryEvidenceChecklist(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    return this.getDeliveryEvidenceService().initializeChecklist(id, handover?.id ?? null);
  }

  async attachDeliveryEvidenceFile(
    itemId: string,
    dto: AttachDeliveryEvidenceFileDto,
    user: RequestUser
  ) {
    await this.assertCanAccessDeliveryEvidenceItem(itemId, user);
    void dto;
    throw new BadRequestException("该文件绑定入口已停用，请使用交接现场证据上传接口完成预处理。");
  }

  async approveDeliveryEvidenceItem(itemId: string, user: RequestUser) {
    await this.assertCanAccessDeliveryEvidenceItem(itemId, user);
    return this.getDeliveryEvidenceService().approveEvidenceItem(itemId, user.id);
  }

  async rejectDeliveryEvidenceItem(
    itemId: string,
    dto: RejectDeliveryEvidenceDto,
    user: RequestUser
  ) {
    await this.assertCanAccessDeliveryEvidenceItem(itemId, user);
    return this.getDeliveryEvidenceService().rejectEvidenceItem(itemId, user.id, dto.reason);
  }

  async declareNoVisibleDamage(id: string, dto: DeclareNoVisibleDamageDto, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    return this.getDeliveryEvidenceService().declareNoVisibleDamage(
      id,
      user.id,
      handover?.id ?? null,
      dto.remark
    );
  }

  async addDamageCloseup(id: string, dto: AddDamageCloseupDto, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    if (dto.fileId) {
      throw new BadRequestException("损伤近拍必须通过交接现场证据上传接口完成预处理。");
    }
    return this.getDeliveryEvidenceService().addDamageCloseup({
      actorId: user.id,
      description: dto.description,
      fileId: dto.fileId,
      handoverId: handover?.id ?? null,
      mediaType: dto.mediaType,
      orderId: id
    });
  }

  async getDeliveryEvidenceReadiness(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    return this.getDeliveryEvidenceService().validateEvidenceReadyForDeliveryConfirmation(
      id,
      handover?.id ?? null
    );
  }

  async prepareDelivery(
    id: string,
    dto: PrepareDeliveryDto,
    user: RequestUser,
    context: RequestContext
  ) {
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

      if (
        beforeDelivery?.deliveryStatus === DeliveryStatus.DELIVERED ||
        beforeDelivery?.deliveredAt
      ) {
        throw new BadRequestException(DELIVERY_ALREADY_DONE_MESSAGE);
      }

      const deliveryData = buildPrepareDeliveryData(
        beforeOrder,
        dto,
        scheduledAt,
        user.id,
        beforeDelivery
      );
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

  async confirmDelivery(
    id: string,
    _dto: ConfirmDeliveryDto,
    user: RequestUser,
    _context: RequestContext
  ) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertOrderNotDelivered(beforeOrder);
    const journey = await this.prisma.subscriptionJourney?.findUnique({
      where: { orderId: id }
    });
    if (journey) {
      throw new BadRequestException(
        "JOURNEY_MANAGED_DELIVERY_REQUIRES_AUDITED_RECOVERY"
      );
    }
    if (!this.leaseActivationEngine) {
      return this.confirmDeliveryLegacy(id, _dto, user, _context);
    }
    return this.prisma.$transaction(async (tx) => {
      await lockDeliveryConfirmationGateRows(tx, id);
      await this.assetOperationsService?.assertVehicleAvailable(
        tx,
        beforeOrder.vehicleId!,
        VehicleAvailabilityPurpose.DELIVERY,
        new Date()
      );
      await this.leaseActivationEngine!.activateFromAuthoritativeHandover(tx, {
        actorId: user.id,
        orderId: id
      });
      const delivery = await tx.vehicleDelivery.findUnique({
        include: deliveryInclude,
        where: { orderId: id }
      });
      if (!delivery) {
        throw new NotFoundException("Delivery not found.");
      }
      return toDeliveryView(delivery);
    });
  }

  private async confirmDeliveryLegacy(
    id: string,
    dto: ConfirmDeliveryDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertOrderNotDelivered(beforeOrder);

    const deliveredAt = parseDateTime(dto.deliveredAt, "deliveredAt");
    assertDeliveryConfirmationValues(beforeOrder, dto, deliveredAt);
    const beforeDelivery = await this.prisma.vehicleDelivery.findUnique({
      include: deliveryInclude,
      where: { orderId: id }
    });
    const handover = await findActiveDeliveryHandover(this.prisma, id);
    const confirmationDefaults = await resolveDeliveryConfirmationDefaults(
      this.prisma,
      id,
      handover
    );
    const evidenceReadiness = await this.getDeliveryConfirmationReadiness(id, handover?.id ?? null);
    assertCanConfirmDelivery(
      beforeOrder,
      beforeDelivery,
      deliveredAt,
      handover,
      evidenceReadiness,
      confirmationDefaults
    );
    await this.handoverWorkOrderService?.assertDeliveryCanBeConfirmed(id, handover?.id ?? null);

    const result = await this.prisma.$transaction(
      async (tx) => {
        await lockDeliveryConfirmationGateRows(tx, id);
        const orderBefore = await tx.subscriptionOrder.findUnique({
          include: orderInclude,
          where: { id }
        });
        if (!orderBefore || orderBefore.deletedAt) {
          throw new NotFoundException("Order not found.");
        }
        ensureCanAccessOrder(orderBefore, user);
        assertNoActiveOrderChange(orderBefore);
        assertOrderNotDelivered(orderBefore);
        assertDeliveryConfirmationValues(orderBefore, dto, deliveredAt);

        const deliveryBefore = await tx.vehicleDelivery.findUnique({
          include: deliveryInclude,
          where: { orderId: id }
        });
        const currentHandover = await findDeliveryHandoverForConfirmation(tx, id);
        const currentEvidenceReadiness = await this.getDeliveryConfirmationReadiness(
          id,
          currentHandover?.id ?? null,
          tx
        );
        const currentConfirmationDefaults = await resolveDeliveryConfirmationDefaults(
          tx,
          id,
          currentHandover
        );
        assertCanConfirmDelivery(
          orderBefore,
          deliveryBefore,
          deliveredAt,
          currentHandover,
          currentEvidenceReadiness,
          currentConfirmationDefaults
        );
        await this.handoverWorkOrderService?.assertDeliveryCanBeConfirmed(
          id,
          currentHandover?.id ?? null,
          tx
        );

        const vehicleBefore = await tx.vehicle.findUnique({
          where: { id: orderBefore.vehicleId! }
        });
        if (
          !vehicleBefore ||
          vehicleBefore.deletedAt ||
          vehicleBefore.status !== VehicleStatus.RESERVED
        ) {
          throw new BadRequestException("交付前车辆必须处于“签约锁定（RESERVED）”状态。");
        }
        await this.assetOperationsService?.assertVehicleAvailable(
          tx,
          orderBefore.vehicleId!,
          VehicleAvailabilityPurpose.DELIVERY,
          new Date()
        );

        const occupiedByOtherOrderCount = await tx.subscriptionOrder.count({
          where: {
            deletedAt: null,
            id: { not: orderBefore.id },
            orderStatus: { notIn: VEHICLE_OCCUPYING_FINAL_STATUSES },
            vehicleId: orderBefore.vehicleId
          }
        });
        if (occupiedByOtherOrderCount > 0) {
          throw new BadRequestException("车辆已被其他订单占用，不能交付。");
        }

        const authoritativeDefaults = currentConfirmationDefaults.defaults;
        if (!authoritativeDefaults) {
          throw new BadRequestException("交付确认缺少 Stage 2 签署时间或 Field 现场里程。");
        }

        const deliveryReading = await this.getVehicleMileageService().appendConfirmedReading(tx, {
          confirmedBy: user.id,
          evidenceSnapshot: {
            authoritativeDefaults,
            finalValues: {
              deliveredAt: deliveredAt.toISOString(),
              handoverMileageKm: dto.handoverMileageKm
            },
            manuallyAdjusted: {
              deliveredAt:
                deliveredAt.getTime() !== new Date(authoritativeDefaults.deliveredAt).getTime(),
              handoverMileageKm: dto.handoverMileageKm !== authoritativeDefaults.handoverMileageKm
            }
          },
          mileageKm: dto.handoverMileageKm,
          orderId: id,
          recordedAt: deliveredAt,
          sourceRecordId: deliveryBefore!.id,
          sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
          vehicleId: orderBefore.vehicleId!
        });
        await this.getMileageReviewService().createFirstReview(tx, {
          actualDeliveryAt: deliveredAt,
          actorId: user.id,
          deliveryReadingId: deliveryReading.id,
          orderId: id,
          vehicleId: orderBefore.vehicleId!
        });

        const delivery = await tx.vehicleDelivery.update({
          data: {
            deliveredAt,
            deliveryStatus: DeliveryStatus.DELIVERED,
            handoverMileageKm: dto.handoverMileageKm,
            remark: dto.remark,
            updatedBy: user.id
          },
          include: deliveryInclude,
          where: { id: deliveryBefore!.id }
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
          where: { id: orderBefore.vehicleId! }
        });
        const { existing: leaseBefore, lease: leaseAfter } = await activateLeaseRecord(tx, {
          activatedAt: deliveredAt,
          actorId: user.id,
          orderId: id
        });
        if (!this.billingAutomationService) {
          throw new Error("Billing automation service is unavailable.");
        }
        await this.billingAutomationService.ensureActiveSchedule(tx, id, deliveredAt);

        return {
          delivery,
          deliveryBefore,
          order,
          orderBefore,
          leaseAfter,
          leaseBefore,
          vehicleAfter,
          vehicleBefore
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted
      }
    );

    await this.writeAudit(
      AuditAction.UPDATE,
      "subscription_order",
      id,
      toOrderView(result.orderBefore),
      toOrderView(result.order),
      user,
      context
    );
    await this.writeDeliveryAudit(
      AuditAction.UPDATE,
      result.delivery.id,
      toDeliveryView(result.deliveryBefore!),
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
    await this.auditService.write({
      action: result.leaseBefore ? AuditAction.UPDATE : AuditAction.CREATE,
      after: toJsonValue(result.leaseAfter),
      before: result.leaseBefore ? toJsonValue(result.leaseBefore) : undefined,
      entityId: result.leaseAfter.id,
      entityType: "lease",
      ipAddress: context.ipAddress,
      module: "lease",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toDeliveryView(result.delivery);
  }

  async getReturnCheck(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const vehicleReturn = await this.prisma.vehicleReturn.findUnique({
      include: returnInclude,
      where: { orderId: id }
    });
    return buildReturnCheck(
      order,
      vehicleReturn && !vehicleReturn.deletedAt ? vehicleReturn : null
    );
  }

  async getReturn(id: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(order, user);
    const vehicleReturn = await this.prisma.vehicleReturn.findUnique({
      include: returnInclude,
      where: { orderId: id }
    });
    return vehicleReturn && !vehicleReturn.deletedAt ? toReturnView(vehicleReturn) : null;
  }

  async prepareReturn(
    id: string,
    dto: PrepareReturnDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertCanPrepareReturn(beforeOrder);

    const scheduledAt = dto.scheduledAt ? parseDateTime(dto.scheduledAt, "scheduledAt") : null;
    const result = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const managedCapability = this.subscriptionClosureService
          ? await this.subscriptionClosureService.prepareManagedReturnInTransaction(tx, {
              actorId: user.id,
              orderId: id,
              returnLocation: dto.returnLocation ?? null,
              scheduledAt
            })
          : null;
        const beforeReturn = await tx.vehicleReturn.findUnique({
          include: returnInclude,
          where: { orderId: id }
        });

        if (
          beforeReturn?.returnStatus === VehicleReturnStatus.CONFIRMED ||
          beforeReturn?.returnedAt
        ) {
          throw new BadRequestException(RETURN_ALREADY_DONE_MESSAGE);
        }

        const returnData = buildPrepareReturnData(dto, scheduledAt, user.id, beforeReturn);
        const vehicleReturn = beforeReturn
          ? await tx.vehicleReturn.update({
              data: returnData,
              include: returnInclude,
              where: { id: beforeReturn.id }
            })
          : await tx.vehicleReturn.create({
              data: {
                ...returnData,
                createdBy: user.id,
                customerId: beforeOrder.customerId,
                orderId: beforeOrder.id,
                returnNo: createBusinessNo("RET"),
                vehicleId: beforeOrder.vehicleId!
              },
              include: returnInclude
            });

        if (managedCapability) {
          await this.subscriptionClosureService!.completeManagedReturnInTransaction(
            tx,
            {
              actorId: user.id,
              orderId: id,
              returnLocation: dto.returnLocation ?? null,
              scheduledAt,
              vehicleReturnId: vehicleReturn.id
            },
            managedCapability as ManagedReturnTransactionCapability
          );
        }

        await this.writeReturnAudit(
          beforeReturn ? AuditAction.UPDATE : AuditAction.CREATE,
          vehicleReturn.id,
          beforeReturn ? toReturnView(beforeReturn) : undefined,
          toReturnView(vehicleReturn),
          user,
          context,
          tx
        );

        return { beforeReturn, vehicleReturn };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    );

    return toReturnView(result.vehicleReturn);
  }

  async confirmReturn(
    id: string,
    dto: ConfirmReturnDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const beforeOrder = await this.findOrderOrThrow(id);
    ensureCanAccessOrder(beforeOrder, user);
    assertNoActiveOrderChange(beforeOrder);
    assertValidReturnMileage(dto.returnMileageKm);
    assertReturnChecklistConfirmed(dto);

    const returnedAt = dto.returnedAt ? parseDateTime(dto.returnedAt, "returnedAt") : new Date();
    const managedReceipt = this.subscriptionClosureService
      ? await this.subscriptionClosureService.confirmManagedPhysicalReceipt(
          {
            actorId: user.id,
            checklist: buildReturnChecklistSnapshot(
              dto,
              dto.damageFound ?? (dto.damages?.length ?? 0) > 0
            ),
            damages: dto.damages ?? [],
            orderId: id,
            physicalControlMode: "VOLUNTARY_RETURN",
            remark: dto.remark ?? null,
            returnMileageKm: dto.returnMileageKm!,
            returnType: dto.returnType ?? VehicleReturnType.NORMAL_RETURN,
            returnedAt
          },
          context
        )
      : null;
    if (managedReceipt) {
      const managedReturn = await this.prisma.vehicleReturn.findUnique({
        include: returnInclude,
        where: { id: managedReceipt.vehicleReturnId }
      });
      if (!managedReturn || managedReturn.deletedAt) {
        throw new ConflictException("退车事实已变化，请刷新后重试。");
      }
      return toReturnView(managedReturn);
    }
    const beforeReturn = await this.prisma.vehicleReturn.findUnique({
      include: returnInclude,
      where: { orderId: id }
    });
    assertCanConfirmReturn(beforeOrder, beforeReturn);

    const delivery = await this.prisma.vehicleDelivery.findUnique({
      where: { orderId: id }
    });
    if (
      delivery?.handoverMileageKm !== null &&
      delivery?.handoverMileageKm !== undefined &&
      dto.returnMileageKm < delivery.handoverMileageKm
    ) {
      throw new BadRequestException("退车里程不能小于交付里程。");
    }

    const damages = dto.damages ?? [];
    const returnType = dto.returnType ?? beforeReturn!.returnType;
    const hasMediumOrSevereDamage = damages.some(
      (damage) =>
        damage.damageLevel === VehicleDamageLevel.MEDIUM ||
        damage.damageLevel === VehicleDamageLevel.SEVERE
    );
    const nextVehicleStatus =
      dto.maintenanceRequired || hasMediumOrSevereDamage
        ? VehicleStatus.MAINTENANCE
        : VehicleStatus.RETURNED;
    const nextOrderStatus =
      returnType === VehicleReturnType.EARLY_TERMINATION
        ? OrderStatus.TERMINATED
        : OrderStatus.COMPLETED;
    const damageFound = dto.damageFound ?? damages.length > 0;

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicleBefore = await tx.vehicle.findUnique({ where: { id: beforeOrder.vehicleId! } });
      if (
        !vehicleBefore ||
        vehicleBefore.deletedAt ||
        vehicleBefore.status !== VehicleStatus.LEASED
      ) {
        throw new BadRequestException("车辆状态不是已出租，不能退车。");
      }

      await this.getVehicleMileageService().appendConfirmedReading(tx, {
        confirmedBy: user.id,
        evidenceSnapshot: {
          damageFound,
          maintenanceRequired: dto.maintenanceRequired ?? false,
          returnType,
          returnedAt: returnedAt.toISOString()
        },
        mileageKm: dto.returnMileageKm,
        orderId: id,
        recordedAt: returnedAt,
        sourceRecordId: beforeReturn!.id,
        sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
        vehicleId: beforeOrder.vehicleId!
      });

      const vehicleReturn = await tx.vehicleReturn.update({
        data: {
          batteryCheckedConfirmed: dto.batteryCheckedConfirmed,
          chargingEquipmentReturnedConfirmed: dto.chargingEquipmentReturnedConfirmed,
          checklistSnapshot: toJsonValue(buildReturnChecklistSnapshot(dto, damageFound)),
          cleaningRequired: dto.cleaningRequired ?? false,
          customerItemsClearedConfirmed: dto.customerItemsClearedConfirmed,
          damageFound,
          exteriorCheckedConfirmed: dto.exteriorCheckedConfirmed,
          interiorCheckedConfirmed: dto.interiorCheckedConfirmed,
          keysReturnedConfirmed: dto.keysReturnedConfirmed,
          maintenanceRequired: dto.maintenanceRequired ?? false,
          mileageConfirmed: dto.mileageConfirmed,
          remark: dto.remark,
          returnMileageKm: dto.returnMileageKm,
          returnStatus: VehicleReturnStatus.CONFIRMED,
          returnType,
          returnedAt,
          updatedBy: user.id,
          vehicleDocumentsReturnedConfirmed: dto.vehicleDocumentsReturnedConfirmed,
          violationCheckedConfirmed: dto.violationCheckedConfirmed
        },
        include: returnInclude,
        where: { id: beforeReturn!.id }
      });

      const createdDamages = [];
      for (const damage of damages) {
        createdDamages.push(
          await tx.vehicleReturnDamage.create({
            data: {
              createdBy: user.id,
              damageLevel: damage.damageLevel,
              damageType: damage.damageType,
              description: damage.description,
              estimatedRepairAmount:
                damage.estimatedRepairAmount === undefined
                  ? null
                  : BigInt(damage.estimatedRepairAmount),
              orderId: beforeOrder.id,
              photoUrls: damage.photoUrls ? toJsonValue(damage.photoUrls) : undefined,
              responsibleParty: damage.responsibleParty ?? "UNKNOWN",
              returnId: vehicleReturn.id,
              status: "RECORDED",
              updatedBy: user.id,
              vehicleId: beforeOrder.vehicleId!
            }
          })
        );
      }

      const vehicleReturnAfterDamage = await tx.vehicleReturn.findUniqueOrThrow({
        include: returnInclude,
        where: { id: vehicleReturn.id }
      });

      const order = await tx.subscriptionOrder.update({
        data: {
          actualReturnAt: returnedAt,
          orderStatus: nextOrderStatus,
          updatedBy: user.id
        },
        include: orderInclude,
        where: { id }
      });

      const leaseBefore = await tx.lease.findUnique({ where: { orderId: id } });
      if (
        !leaseBefore ||
        (leaseBefore.status !== LeaseStatus.ACTIVE && leaseBefore.status !== LeaseStatus.RETURN_DUE)
      ) {
        throw new BadRequestException("租约状态不允许完成退车。");
      }
      const completedLease = await tx.lease.updateMany({
        data: {
          status: LeaseStatus.COMPLETED,
          updatedBy: user.id
        },
        where: {
          orderId: id,
          status: { in: [LeaseStatus.ACTIVE, LeaseStatus.RETURN_DUE] }
        }
      });
      if (completedLease.count !== 1) {
        throw new ConflictException("租约状态已变化，请刷新后重试。");
      }
      await this.auditService.write(
        {
          action: AuditAction.UPDATE,
          after: { ...leaseBefore, status: LeaseStatus.COMPLETED, updatedBy: user.id },
          before: leaseBefore,
          entityId: leaseBefore.id,
          entityType: "lease",
          ipAddress: context.ipAddress,
          module: "lease",
          operatorId: user.id,
          userAgent: context.userAgent
        },
        tx
      );

      const vehicleAfter = await tx.vehicle.update({
        data: {
          status: nextVehicleStatus,
          updatedBy: user.id
        },
        where: { id: beforeOrder.vehicleId! }
      });

      return {
        createdDamages,
        order,
        vehicleAfter,
        vehicleBefore,
        vehicleReturn: vehicleReturnAfterDamage
      };
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
    await this.writeReturnAudit(
      AuditAction.UPDATE,
      result.vehicleReturn.id,
      toReturnView(beforeReturn!),
      toReturnView(result.vehicleReturn),
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
    for (const damage of result.createdDamages) {
      await this.auditService.write({
        action: AuditAction.CREATE,
        after: toJsonValue(damage),
        entityId: damage.id,
        entityType: "vehicle_return_damage",
        ipAddress: context.ipAddress,
        module: "vehicle_return",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return toReturnView(result.vehicleReturn);
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
    const existing = before.contracts.find(
      (contract) => contract.status !== ContractStatus.CANCELLED
    );
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
        status: ContractVersionStatus.ACTIVE,
        templateType: ContractTemplateType.SUBSCRIPTION_STANDARD
      }
    });
    if (!template) {
      throw new BadRequestException("未找到生效中的订阅合同模板。");
    }
    assertStage1PartyBIdNumberPresent(before);
    const contractSnapshot = toJsonValue({
      contentTemplate: template.contentTemplate,
      customer: buildContractSnapshotCustomer(before.customer),
      order: toOrderView(before),
      quoteSnapshot: before.quoteSnapshot
    });

    const contract = this.isContractPdfArtifactGenerationEnabled()
      ? await this.generateContractWithPdfArtifact(before, template, contractSnapshot, user)
      : await withUniqueBusinessNoRetry(() =>
          this.prisma.$transaction(async (tx) => {
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
              data: {
                contractId: created.id,
                orderStatus: OrderStatus.PENDING_SIGN,
                updatedBy: user.id
              },
              where: { id: before.id }
            });
            return tx.contract.findUniqueOrThrow({
              include: contractInclude,
              where: { id: created.id }
            });
          })
        );

    await this.writeAudit(
      AuditAction.CREATE,
      "contract",
      contract.id,
      toOrderView(before),
      toContractView(contract),
      user,
      context
    );
    return toContractView(contract);
  }

  private isContractPdfArtifactGenerationEnabled() {
    return parseBooleanFlag(
      this.configService?.get<string>(CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED_ENV)
    );
  }

  private async generateContractWithPdfArtifact(
    before: OrderWithDetails,
    template: ContractWithDetails["contractVersion"],
    contractSnapshot: Prisma.InputJsonValue,
    user: RequestUser
  ) {
    if (!this.contractPdfArtifactWriter) {
      throw new Error("CONTRACT_PDF_ARTIFACT_WRITER_MISSING: PDF artifact writer is not available");
    }

    const createdContract = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
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
        return tx.contract.findUniqueOrThrow({
          include: contractInclude,
          where: { id: created.id }
        });
      })
    );

    try {
      const artifact = await this.contractPdfArtifactWriter.writeGeneratedContractPdfArtifact({
        cjkFontPath: this.configService?.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        contractStatus: createdContract.status,
        existingContractFileId: createdContract.fileId,
        renderModel: buildContractPdfRenderModel(createdContract, before, template),
        uploadedBy: user.id
      });

      return await this.prisma.$transaction(async (tx) => {
        await tx.contract.update({
          data: {
            contractSnapshot: buildContractSnapshotWithGeneratedPdfArtifact(
              createdContract.contractSnapshot,
              artifact
            ),
            fileId: artifact.fileId,
            updatedBy: user.id
          },
          where: { id: createdContract.id }
        });
        await tx.subscriptionOrder.update({
          data: {
            contractId: createdContract.id,
            orderStatus: OrderStatus.PENDING_SIGN,
            updatedBy: user.id
          },
          where: { id: before.id }
        });
        return tx.contract.findUniqueOrThrow({
          include: contractInclude,
          where: { id: createdContract.id }
        });
      });
    } catch (error) {
      await this.cancelContractAfterPdfArtifactFailure(createdContract.id, user.id);
      throw error;
    }
  }

  private async cancelContractAfterPdfArtifactFailure(contractId: string, userId: string) {
    try {
      await this.prisma.contract.update({
        data: { status: ContractStatus.CANCELLED, updatedBy: userId },
        where: { id: contractId }
      });
    } catch {
      // Preserve the original renderer/writer/update error for the caller.
    }
  }

  async listContracts(user: RequestUser, query: ListContractsQueryDto = {}) {
    const contractNo = query.contractNo?.trim() || undefined;
    const orderNo = query.orderNo?.trim() || undefined;
    const filters: Prisma.ContractWhereInput[] = [];

    if (contractNo) {
      filters.push({ contractNo: { contains: contractNo, mode: "insensitive" } });
    }
    if (orderNo) {
      filters.push({ order: { orderNo: { contains: orderNo, mode: "insensitive" } } });
    }
    const orderScope: Prisma.SubscriptionOrderWhereInput = {
      deletedAt: null,
      ...(canViewAllOrders(user) ? {} : { application: { salesUserId: user.id } })
    };

    const contracts = await this.prisma.contract.findMany({
      include: contractInclude,
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        order: orderScope,
        ...(filters.length > 0 ? { AND: filters } : {})
      }
    });
    return contracts.map(toContractView);
  }

  async getContract(id: string, user: RequestUser) {
    const contract = await this.findContractOrThrow(id);
    ensureCanAccessContract(contract, user);
    return toContractView(contract);
  }

  async previewGeneratedContractPdf(id: string, user: RequestUser): Promise<ContractPdfPreview> {
    const contract = await this.findContractOrThrow(id);
    ensureCanAccessContract(contract, user);

    if (!this.storageService) {
      throw new Error("CONTRACT_PDF_PREVIEW_STORAGE_MISSING: storage service is unavailable");
    }
    if (!contract.fileId || !hasGeneratedContractPdfArtifact(contract)) {
      throw new NotFoundException("Generated contract PDF not found.");
    }

    const fileObject = await this.prisma.fileObject.findUnique({ where: { id: contract.fileId } });
    if (!fileObject) {
      throw new NotFoundException("Generated contract PDF file not found.");
    }

    const storedObject = await this.storageService.getObject(
      fileObject.bucket,
      fileObject.objectKey
    );
    return {
      filename: fileObject.originalName,
      mimeType: fileObject.mimeType ?? storedObject.contentType,
      sizeBytes: storedObject.contentLength ?? Number(fileObject.sizeBytes),
      stream: storedObject.stream
    };
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
    await this.writeAudit(
      AuditAction.APPROVE,
      "contract",
      id,
      toContractView(before),
      toContractView(contract),
      user,
      context
    );
    return toContractView(contract);
  }

  async archiveContract(
    id: string,
    dto: ArchiveContractDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findContractOrThrow(id);
    const order = await this.findOrderOrThrow(before.orderId);
    assertNoActiveOrderChange(order);
    if (before.status !== ContractStatus.SIGNED) {
      throw new BadRequestException("仅已签署合同可以归档。");
    }
    const contract = await this.prisma.contract.update({
      data: {
        archivedAt: new Date(),
        fileId: dto.fileId,
        status: ContractStatus.ARCHIVED,
        updatedBy: user.id
      },
      include: contractInclude,
      where: { id }
    });
    await this.writeAudit(
      AuditAction.UPDATE,
      "contract",
      id,
      toContractView(before),
      toContractView(contract),
      user,
      context
    );
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
    const cancellableStatuses: ContractStatus[] = [
      ContractStatus.GENERATED,
      ContractStatus.SIGNING
    ];
    if (!cancellableStatuses.includes(before.status)) {
      throw new BadRequestException("当前合同状态不允许取消。");
    }
    if (before.order.contractId !== before.id) {
      throw new BadRequestException("当前合同不是该订单的当前合同。");
    }
    const cancellableOrderStatuses: OrderStatus[] = [
      OrderStatus.PENDING_SIGN,
      OrderStatus.PENDING_CONTRACT
    ];
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "contract",
      id,
      toContractView(before),
      toContractView(contract),
      user,
      context
    );
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

  async createContractVersion(
    dto: CreateContractVersionDto,
    user: RequestUser,
    context: RequestContext
  ) {
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
    await this.writeAudit(
      AuditAction.CREATE,
      "contract_version",
      version.id,
      undefined,
      toContractVersionView(version),
      user,
      context
    );
    return toContractVersionView(version);
  }

  async updateContractVersion(
    id: string,
    dto: UpdateContractVersionDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findContractVersionOrThrow(id);
    const version = await this.prisma.contractVersion.update({
      data: {
        contentTemplate: dto.contentTemplate,
        effectiveFrom: dto.effectiveFrom
          ? parseDateOnly(dto.effectiveFrom, "effectiveFrom")
          : undefined,
        effectiveTo:
          dto.effectiveTo === undefined
            ? undefined
            : dto.effectiveTo
              ? parseDateOnly(dto.effectiveTo, "effectiveTo")
              : null,
        templateName: dto.templateName,
        updatedBy: user.id,
        versionNo: dto.versionNo
      },
      where: { id }
    });
    await this.writeAudit(
      AuditAction.UPDATE,
      "contract_version",
      id,
      toContractVersionView(before),
      toContractVersionView(version),
      user,
      context
    );
    return toContractVersionView(version);
  }

  async setContractVersionStatus(
    id: string,
    status: ContractVersionStatus,
    user: RequestUser,
    context: RequestContext
  ) {
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "contract_version",
      id,
      toContractVersionView(before),
      toContractVersionView(version),
      user,
      context
    );
    return toContractVersionView(version);
  }

  async listOrderChanges(orderId: string, user: RequestUser) {
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    return order.changes.map((change) => toOrderChangeResponse(change, user));
  }

  async listPlanChangeSubscriptionPlans(orderId: string, user: RequestUser) {
    ensureUserPermission(user, PermissionCode.ORDER_CHANGE_CREATE);
    const order = await this.findOrderOrThrow(orderId);
    ensureCanAccessOrder(order, user);
    if (!order.vehicleId || !order.vehicle) {
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
        status: SubscriptionPlanStatus.ACTIVE
      }
    });

    return plans
      .filter(isSubscriptionPlanCurrentlyAvailableForOrder)
      .filter((plan) =>
        vehiclePackageSupportsModel(plan.vehiclePackage, order.vehicle!.modelDefinitionId)
      )
      .map(toPlanChangeSubscriptionPlanView);
  }

  async createOrderChange(
    orderId: string,
    dto: CreateOrderChangeDto,
    user: RequestUser,
    context: RequestContext
  ) {
    ensureUserPermission(user, PermissionCode.ORDER_CHANGE_CREATE);
    if (dto.changeType === OrderChangeType.EXTENSION) {
      throw new ConflictException(
        "Contract extensions must be created through the V2 subscription-change workflow."
      );
    }
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
    await this.writeAudit(
      AuditAction.CREATE,
      "order_change",
      change.id,
      undefined,
      toOrderChangeAuditView(change),
      user,
      context
    );
    return toOrderChangeResponse(change, user);
  }

  async setOrderChangeStatus(
    id: string,
    status: OrderChangeStatus,
    user: RequestUser,
    context: RequestContext
  ) {
    if (status === OrderChangeStatus.APPROVED) {
      ensureUserPermission(user, PermissionCode.ORDER_CHANGE_APPROVE);
    } else if (
      !user.roles.includes("ADMIN") &&
      !user.permissions.includes(PermissionCode.ORDER_CHANGE_REJECT) &&
      !user.permissions.includes(PermissionCode.ORDER_CHANGE_APPROVE)
    ) {
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
    await this.writeAudit(
      status === OrderChangeStatus.APPROVED ? AuditAction.APPROVE : AuditAction.REJECT,
      "order_change",
      id,
      toOrderChangeAuditView(before),
      toOrderChangeAuditView(change),
      user,
      context
    );
    return toOrderChangeResponse(change, user);
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
    await this.writeAudit(
      AuditAction.UPDATE,
      "order_change",
      id,
      toOrderChangeAuditView(before),
      toOrderChangeAuditView(change),
      user,
      context
    );
    return toOrderChangeResponse(change, user);
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
      if (orderBefore.vehicleId && this.assetOperationsService) {
        await lockVehicleAvailabilityAuthority(tx, orderBefore.vehicleId);
      }
      const vehicleBefore = orderBefore.vehicleId
        ? await tx.vehicle.findUnique({ where: { id: orderBefore.vehicleId } })
        : null;

      let contractAfter = null;
      let vehicleAfter = null;
      if (
        vehicleBefore &&
        !vehicleBefore.deletedAt &&
        (vehicleBefore.status === VehicleStatus.RESERVED ||
          vehicleBefore.status === VehicleStatus.REVIEW_RESERVED)
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
          await this.assetOperationsService?.assertVehicleAvailable(
            tx,
            vehicleBefore.id,
            VehicleAvailabilityPurpose.MARK_AVAILABLE,
            new Date(),
            VehicleStatus.AVAILABLE
          );
          vehicleAfter = await tx.vehicle.update({
            data: { status: VehicleStatus.AVAILABLE, updatedBy: user.id },
            where: { id: vehicleBefore.id }
          });
        }
      }

      if (unsignedContract) {
        contractAfter = await tx.contract.update({
          data: { status: ContractStatus.CANCELLED, updatedBy: user.id },
          where: { id: unsignedContract.id }
        });
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
      toOrderChangeAuditView(before),
      toOrderChangeAuditView(result.changeAfter),
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
    return toOrderChangeResponse(result.changeAfter, user);
  }

  private async findOrderOrThrow(id: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: orderInclude,
      where: { id }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("Order not found.");
    }
    return order;
  }

  private getDeliveryEvidenceService() {
    return this.deliveryEvidenceService ?? new DeliveryEvidenceService(this.prisma);
  }

  private getVehicleMileageService() {
    if (!this.vehicleMileageService) {
      throw new Error("Vehicle mileage service is unavailable.");
    }
    return this.vehicleMileageService;
  }

  private getMileageReviewService() {
    if (!this.mileageReviewService) {
      throw new Error("Mileage review service is unavailable.");
    }
    return this.mileageReviewService;
  }

  private async getDeliveryConfirmationReadiness(
    orderId: string,
    handoverId?: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const evidenceReadiness =
      await this.getDeliveryEvidenceService().validateEvidenceReadyForDeliveryConfirmation(
        orderId,
        handoverId ?? null,
        undefined,
        db
      );
    if (!this.handoverWorkOrderService) {
      return evidenceReadiness;
    }
    try {
      await this.handoverWorkOrderService.assertReadyForStage2ESign(
        orderId,
        handoverId ?? null,
        db
      );
      return evidenceReadiness;
    } catch (error) {
      const message = error instanceof Error ? error.message : "交付工单尚未就绪。";
      return {
        ...evidenceReadiness,
        blockingReasons: [...evidenceReadiness.blockingReasons, message],
        ready: false
      };
    }
  }

  private async assertCanAccessDeliveryEvidenceItem(itemId: string, user: RequestUser) {
    const item = await this.prisma.vehicleDeliveryEvidenceItem.findFirst({
      select: { orderId: true },
      where: { id: itemId }
    });
    if (!item) {
      throw new NotFoundException("交付证据项不存在。");
    }
    const order = await this.findOrderOrThrow(item.orderId);
    ensureCanAccessOrder(order, user);
  }

  private async buildMonthlyRenewalPlan(
    order: OrderWithDetails,
    asOfDate: Date,
    dryRun: boolean
  ): Promise<MonthlyRenewalPlan> {
    assertCanGenerateEntitlements(order);

    const account = await this.findActiveEntitlementAccount(order.id);
    if (!account) {
      throw new BadRequestException("当前订单缺少生效中的权益账户，不能续发。");
    }

    const latestCycleIndex = resolveLatestEntitlementCycleIndex(order, account);
    if (latestCycleIndex === null) {
      throw new BadRequestException("当前权益账户缺少首期权益，不能续发。");
    }

    const latestPeriod = resolveMonthlyEntitlementPeriod(order, latestCycleIndex);
    const nextCycleIndex = latestCycleIndex + 1;
    const nextPeriod = resolveMonthlyEntitlementPeriod(order, nextCycleIndex);
    const snapshot = resolveOrderEntitlementSnapshotForPeriod(
      order,
      nextPeriod.periodStart,
      nextPeriod.periodStart > asOfDate
    );
    const grantInputs = buildOrderEntitlementGrantInputs(snapshot.packageSnapshot);
    if (grantInputs.length === 0) {
      throw new BadRequestException("当前订单套餐快照缺少可生成权益的组件。");
    }
    const latestExistingGrants = findExistingMonthlyRenewalGrants(
      account,
      latestPeriod.periodStart,
      latestPeriod.periodEnd,
      grantInputs
    );
    const latestPeriodCovered =
      latestCycleIndex > 0 && latestExistingGrants.length === grantInputs.length;

    if (nextPeriod.periodStart > asOfDate) {
      if (
        latestPeriodCovered &&
        latestPeriod.periodStart <= asOfDate &&
        asOfDate <= latestPeriod.periodEnd
      ) {
        return {
          account,
          action: dryRun ? "DRY_RUN_SKIP" : "SKIPPED_EXISTING",
          asOfDate,
          dryRun,
          existingGrants: latestExistingGrants,
          grantInputs,
          missingGrantInputs: [],
          nextCycleIndex: latestCycleIndex,
          order,
          periodEnd: latestPeriod.periodEnd,
          periodStart: latestPeriod.periodStart,
          reason: "本期权益已存在。"
        };
      }

      return {
        account,
        action: dryRun ? "DRY_RUN_SKIP" : "SKIPPED_NOT_DUE",
        asOfDate,
        dryRun,
        existingGrants: [],
        grantInputs,
        missingGrantInputs: [],
        nextCycleIndex,
        order,
        periodEnd: nextPeriod.periodEnd,
        periodStart: nextPeriod.periodStart,
        reason: "未到续发日期。"
      };
    }

    const existingGrants = findExistingMonthlyRenewalGrants(
      account,
      nextPeriod.periodStart,
      nextPeriod.periodEnd,
      grantInputs
    );
    const missingGrantInputs = grantInputs.filter(
      (grantInput) => !existingGrants.some((grant) => isSameEntitlementGrant(grant, grantInput))
    );
    if (missingGrantInputs.length === 0) {
      return {
        account,
        action: dryRun ? "DRY_RUN_SKIP" : "SKIPPED_EXISTING",
        asOfDate,
        dryRun,
        existingGrants,
        grantInputs,
        missingGrantInputs,
        nextCycleIndex,
        order,
        periodEnd: nextPeriod.periodEnd,
        periodStart: nextPeriod.periodStart,
        reason: "本期权益已存在。"
      };
    }

    return {
      account,
      action: dryRun ? "DRY_RUN_GENERATE" : "GENERATED",
      asOfDate,
      dryRun,
      existingGrants,
      grantInputs,
      missingGrantInputs,
      nextCycleIndex,
      order,
      periodEnd: nextPeriod.periodEnd,
      periodStart: nextPeriod.periodStart,
      reason: "-"
    };
  }

  private async createMonthlyRenewalGrants(plan: MonthlyRenewalPlan, user: RequestUser) {
    return withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const createdGrants: Prisma.OrderEntitlementGrantGetPayload<object>[] = [];

        for (const grant of plan.missingGrantInputs) {
          const existingGrant = await tx.orderEntitlementGrant.findFirst({
            where: {
              accountId: plan.account.id,
              deletedAt: null,
              entitlementName: grant.entitlementName,
              entitlementType: grant.entitlementType,
              grantPeriodEnd: plan.periodEnd,
              grantPeriodStart: plan.periodStart,
              grantSource: EntitlementGrantSource.MONTHLY_RENEWAL,
              orderId: plan.order.id,
              unit: grant.unit
            }
          });
          if (existingGrant) {
            continue;
          }

          const createdGrant = await tx.orderEntitlementGrant.create({
            data: {
              accountId: plan.account.id,
              createdBy: user.id,
              customerId: plan.order.customerId,
              entitlementName: grant.entitlementName,
              entitlementType: grant.entitlementType,
              grantNo: createBusinessNo("EG"),
              grantPeriodEnd: plan.periodEnd,
              grantPeriodStart: plan.periodStart,
              grantSource: EntitlementGrantSource.MONTHLY_RENEWAL,
              orderId: plan.order.id,
              remainingAmount: grant.remainingAmount,
              snapshot: grant.snapshot,
              status: EntitlementGrantStatus.ACTIVE,
              totalAmount: grant.totalAmount,
              unit: grant.unit,
              updatedBy: user.id,
              usedAmount: grant.usedAmount
            }
          });
          createdGrants.push(createdGrant);
        }

        return createdGrants;
      })
    );
  }

  private async findActiveEntitlementAccount(orderId: string) {
    return this.prisma.orderEntitlementAccount.findFirst({
      include: entitlementAccountInclude,
      orderBy: { createdAt: "desc" },
      where: {
        accountStatus: EntitlementAccountStatus.ACTIVE,
        deletedAt: null,
        orderId
      }
    });
  }

  private async findContractOrThrow(id: string) {
    const contract = await this.prisma.contract.findUnique({
      include: contractInclude,
      where: { id }
    });
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

  private async writeReturnAudit(
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
    user: RequestUser,
    context: RequestContext,
    tx?: Prisma.TransactionClient
  ) {
    await this.auditService.write(
      {
        action,
        after,
        before,
        entityId,
        entityType: "vehicle_return",
        ipAddress: context.ipAddress,
        module: "vehicle_return",
        operatorId: user.id,
        userAgent: context.userAgent
      },
      tx
    );
  }

  private async writeEntitlementAudit(
    action: AuditAction,
    entityType: string,
    entityId: string,
    after: unknown,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after: toJsonValue(after),
      entityId,
      entityType,
      ipAddress: context.ipAddress,
      module: "entitlement",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }
}

type SnapshotRecord = Record<string, unknown>;

type OrderEntitlementPackageSnapshot = {
  benefitPackage: SnapshotRecord | null;
  energyPackage: SnapshotRecord | null;
  mileagePackage: SnapshotRecord | null;
  pricing: SnapshotRecord | null;
  source: SnapshotRecord;
  subscriptionPlan: SnapshotRecord | null;
  subscriptionPlanId: string | null;
  vehiclePackage: SnapshotRecord | null;
};

type OrderEntitlementSnapshot = {
  packageSnapshot: OrderEntitlementPackageSnapshot;
  sourceSnapshot: unknown;
};

export type OrderEntitlementGrantInput = {
  entitlementName: string;
  entitlementType: EntitlementType;
  remainingAmount: Prisma.Decimal | null;
  snapshot: Prisma.InputJsonValue;
  totalAmount: Prisma.Decimal | null;
  unit: EntitlementUnit;
  usedAmount: Prisma.Decimal | null;
};

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

function parseBooleanFlag(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase() === "true";
}

function assertStage1PartyBIdNumberPresent(order: OrderWithDetails) {
  if (!getStage1PartyBIdNumber(order)) {
    throw new BadRequestException(
      `${STAGE1_PARTY_B_ID_NUMBER_MISSING}: 乙方证件号码缺失，请先完善客户身份信息`
    );
  }
}

function getStage1PartyBIdNumber(order: OrderWithDetails) {
  const value = order.customer.identity?.idCardNo;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildContractSnapshotCustomer(customer: OrderWithDetails["customer"]) {
  return {
    grade: customer.grade,
    id: customer.id,
    mobile: customer.mobile,
    name: customer.name,
    profile: customer.profile ? { residenceAddress: customer.profile.residenceAddress } : null
  };
}

function buildContractPdfRenderModel(
  contract: ContractWithDetails,
  order: OrderWithDetails,
  template: ContractWithDetails["contractVersion"]
): ContractPdfRenderModel {
  const subscriberIdNumber = getStage1PartyBIdNumber(order);
  if (!subscriberIdNumber) {
    throw new BadRequestException(
      `${STAGE1_PARTY_B_ID_NUMBER_MISSING}: 乙方证件号码缺失，请先完善客户身份信息`
    );
  }

  return {
    appendix: {
      sections: [
        buildAppendixSection("合同基础信息", [
          appendixRow("合同编号", contract.contractNo),
          appendixRow("订单编号", order.orderNo),
          appendixRow("合同模板", template.templateName),
          appendixRow("模板版本", template.versionNo),
          appendixRow("生成时间", contract.createdAt)
        ]),
        buildAppendixSection("客户信息", [
          appendixRow("客户姓名", order.customer.name),
          appendixRow("客户手机号", maskPhone(order.customer.mobile), {
            applied: true,
            reason: "phone_masked"
          })
        ]),
        buildAppendixSection("订阅方案摘要", [
          appendixRow("租期（月）", order.periodMonths),
          appendixRow("月租金（人民币元）", formatMinorAmountAsYuan(order.monthlyFeeAmount)),
          appendixRow("押金（人民币元）", formatMinorAmountAsYuan(order.depositAmount)),
          appendixRow("里程额度（公里/月）", order.mileageLimitKm),
          appendixRow("能源额度（kWh/月）", order.energyLimitKwh),
          appendixRow("能源次数（次/月）", order.energyLimitCount),
          appendixRow(
            "超里程费（人民币元/公里）",
            formatMinorAmountAsYuan(order.overMileageFeeAmount)
          ),
          appendixRow("报价编号", order.quote?.quoteNo)
        ]),
        buildAppendixSection("车辆摘要", [
          appendixRow("车辆编号", order.vehicle?.vehicleNo),
          appendixRow("品牌", order.vehicle?.brand),
          appendixRow("车型", order.vehicle?.model ?? order.modelDisplayNameSnapshot),
          appendixRow("车牌号", maskPlate(order.vehicle?.plateNo), {
            applied: true,
            reason: "plate_masked"
          })
        ])
      ]
    },
    contentTemplate: template.contentTemplate,
    contractId: contract.id,
    contractNo: contract.contractNo,
    generatedAt: contract.createdAt,
    orderNo: order.orderNo,
    signingSlots: createStage1ContractPdfSigningSlots(),
    signingStage: "STAGE1_CONTRACT",
    subscriberParty: {
      subscriberContactAddress: order.customer.profile?.residenceAddress ?? null,
      subscriberContactName: order.customer.name,
      subscriberContactPhone: order.customer.mobile,
      subscriberEmail: null,
      subscriberIdNumber,
      subscriberName: order.customer.name,
      subscriberWechat: null
    },
    templateName: template.templateName,
    templateVersion: template.versionNo
  };
}

function buildAppendixSection(
  title: string,
  rows: Array<ContractPdfAppendixRow | null>
): ContractPdfAppendixSection {
  return {
    rows: rows.filter((row): row is ContractPdfAppendixRow => Boolean(row)),
    title
  };
}

function appendixRow(
  label: string,
  value: unknown,
  redaction?: ContractPdfAppendixRow["redaction"]
): ContractPdfAppendixRow | null {
  const formatted = formatValueForPdf(value);
  if (formatted === null || formatted === "") {
    return null;
  }

  return {
    label,
    redaction,
    value: formatted
  };
}

function formatValueForPdf(value: unknown): ContractPdfValue | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date || ["boolean", "number", "string"].includes(typeof value)) {
    return value as ContractPdfValue;
  }
  return String(value);
}

function formatMinorAmountAsYuan(value: bigint | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const minor = typeof value === "bigint" ? value : BigInt(value);
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  const yuan = absolute / 100n;
  const cents = (absolute % 100n).toString().padStart(2, "0");

  return `${sign}${yuan.toString()}.${cents}`;
}

function maskPhone(value: null | string | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length <= 7) {
    return "***";
  }
  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
}

function maskPlate(value: null | string | undefined) {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length <= 3) {
    return "***";
  }
  return `${normalized.slice(0, 2)}***${normalized.slice(-1)}`;
}

function assertCanGenerateEntitlements(order: OrderWithDetails) {
  if (order.orderStatus !== OrderStatus.ACTIVE) {
    throw new BadRequestException("当前订单尚未起租，不能生成权益。");
  }
  if (!order.actualDeliveryAt) {
    throw new BadRequestException("当前订单缺少实际交付时间，不能生成权益。");
  }
}

function assertCanConsumeEntitlementOrder(order: OrderWithDetails) {
  if (order.orderStatus !== OrderStatus.ACTIVE) {
    throw new BadRequestException("当前订单尚未起租，不能消耗权益。");
  }
}

function assertCanConsumeEntitlementAccount(
  account: Prisma.OrderEntitlementAccountGetPayload<object> | null
): asserts account is Prisma.OrderEntitlementAccountGetPayload<object> {
  if (!account) {
    throw new BadRequestException("当前订单尚未生成权益账户，不能消耗权益。");
  }
  if (account.accountStatus !== EntitlementAccountStatus.ACTIVE) {
    throw new BadRequestException("当前权益账户不是生效中，不能消耗权益。");
  }
}

function assertCanConsumeEntitlementGrant(
  grant: Prisma.OrderEntitlementGrantGetPayload<object> | null
): asserts grant is Prisma.OrderEntitlementGrantGetPayload<object> {
  if (!grant) {
    throw new NotFoundException("权益发放记录不存在或不属于当前订单。");
  }
  if (grant.status !== EntitlementGrantStatus.ACTIVE) {
    throw new BadRequestException("当前权益发放记录不是生效中，不能消耗权益。");
  }
  if (grant.unit === EntitlementUnit.TEXT) {
    throw new BadRequestException("文本型权益不支持消耗核销");
  }
}

function positiveEntitlementAmount(value: unknown) {
  const amount = numberValue(value);
  if (amount === null || amount <= 0) {
    throw new BadRequestException("权益消耗数量必须大于 0。");
  }
  return new Prisma.Decimal(amount);
}

function requiredGrantRemainingAmount(grant: Prisma.OrderEntitlementGrantGetPayload<object>) {
  if (grant.remainingAmount === null) {
    throw new BadRequestException("权益发放记录缺少剩余额度，不能消耗权益。");
  }
  return grant.remainingAmount;
}

function assertGrantWithinConsumptionPeriod(
  grant: Prisma.OrderEntitlementGrantGetPayload<object>,
  order: OrderWithDetails,
  occurredAt: Date
) {
  const occurredDate = toBusinessDate(occurredAt);
  const periodStart = toBusinessDate(grant.grantPeriodStart);
  const periodEnd = resolveConsumableGrantPeriodEnd(grant, order, periodStart);
  if (!periodEnd) {
    throw new BadRequestException("权益缺少有效期，不能消耗。");
  }
  if (occurredDate < periodStart || occurredDate > periodEnd) {
    throw new BadRequestException("权益不在有效期内，不能消耗");
  }
}

function resolveConsumableGrantPeriodEnd(
  grant: Prisma.OrderEntitlementGrantGetPayload<object>,
  order: OrderWithDetails,
  periodStart: Date
) {
  if (grant.grantPeriodEnd) {
    return toBusinessDate(grant.grantPeriodEnd);
  }
  if (grant.grantSource === EntitlementGrantSource.ORDER_START && order.actualDeliveryAt) {
    return resolveMonthlyEntitlementPeriod(order, 0, periodStart).periodEnd;
  }
  return null;
}

function resolveOrderEntitlementSnapshot(order: OrderWithDetails): OrderEntitlementSnapshot {
  const orderRecord = order as unknown as SnapshotRecord;
  const quoteRecord = asSnapshotRecord(order.quote);
  const quoteSnapshotRecord = asSnapshotRecord(order.quoteSnapshot);
  const candidates = [
    order.finalPlanSnapshot,
    orderRecord.packageSnapshot,
    quoteSnapshotRecord?.packageSnapshot,
    order.quoteSnapshot,
    quoteRecord?.packageSnapshot
  ];

  const existingCandidates = candidates.filter((candidate) => asSnapshotRecord(candidate));
  if (existingCandidates.length === 0) {
    throw new BadRequestException("当前订单缺少套餐快照，无法生成权益。");
  }

  for (const candidate of existingCandidates) {
    const packageSnapshot = normalizeEntitlementPackageSnapshot(candidate);
    if (hasEntitlementPackageComponent(packageSnapshot)) {
      return { packageSnapshot, sourceSnapshot: candidate };
    }
  }

  return {
    packageSnapshot: normalizeEntitlementPackageSnapshot(existingCandidates[0]),
    sourceSnapshot: existingCandidates[0]
  };
}

function resolveOrderEntitlementSnapshotForPeriod(
  order: OrderWithDetails,
  periodStart: Date,
  allowScheduled: boolean
): OrderEntitlementSnapshot {
  const segment = order.contractSegments.find(
    (candidate) =>
      candidate.status !== ContractSegmentStatus.CANCELLED &&
      candidate.startDate <= periodStart &&
      periodStart <= candidate.endDate
  );
  if (!segment) return resolveOrderEntitlementSnapshot(order);
  if (
    segment.status !== ContractSegmentStatus.ACTIVE &&
    segment.status !== ContractSegmentStatus.COMPLETED &&
    !(allowScheduled && segment.status === ContractSegmentStatus.SCHEDULED)
  ) {
    throw new BadRequestException("目标权益周期的合同分段尚未生效，不能续发。");
  }
  return {
    packageSnapshot: normalizeEntitlementPackageSnapshot(segment.planSnapshot),
    sourceSnapshot: segment.planSnapshot
  };
}

function normalizeEntitlementPackageSnapshot(snapshot: unknown): OrderEntitlementPackageSnapshot {
  const record = asSnapshotRecord(snapshot) ?? {};
  const nestedPackageSnapshot = asSnapshotRecord(record.packageSnapshot);
  const source = nestedPackageSnapshot ?? record;

  return {
    benefitPackage: firstSnapshotRecord(source.benefitPackage, record.benefitPackage),
    energyPackage: firstSnapshotRecord(source.energyPackage, record.energyPackage),
    mileagePackage: firstSnapshotRecord(source.mileagePackage, record.mileagePackage),
    pricing: firstSnapshotRecord(source.pricing, record.pricing),
    source,
    subscriptionPlan: firstSnapshotRecord(source.subscriptionPlan, record.subscriptionPlan),
    subscriptionPlanId: firstStringValue(source.subscriptionPlanId, record.subscriptionPlanId),
    vehiclePackage: firstSnapshotRecord(source.vehiclePackage, record.vehiclePackage)
  };
}

function buildOrderEntitlementGrantInputs(
  packageSnapshot: OrderEntitlementPackageSnapshot
): OrderEntitlementGrantInput[] {
  const grants: OrderEntitlementGrantInput[] = [];
  const monthlyMileageKm = numberField(
    packageSnapshot.mileagePackage,
    "monthlyMileageKm",
    "monthly_mileage_km"
  );
  if (monthlyMileageKm !== null && monthlyMileageKm > 0) {
    grants.push(
      amountGrant({
        entitlementName: "月里程额度",
        entitlementType: EntitlementType.MILEAGE,
        snapshot: {
          mileagePackage: packageSnapshot.mileagePackage,
          overMileageFeeAmount: numberField(
            packageSnapshot.mileagePackage,
            "overMileageFeeAmount",
            "over_mileage_fee_amount",
            "excessMileageUnitPrice"
          )
        },
        totalAmount: monthlyMileageKm,
        unit: EntitlementUnit.KM
      })
    );
  }

  const monthlyEnergyKwh = numberField(
    packageSnapshot.energyPackage,
    "monthlyEnergyKwh",
    "monthly_energy_kwh"
  );
  if (monthlyEnergyKwh !== null && monthlyEnergyKwh > 0) {
    grants.push(
      amountGrant({
        entitlementName: "月补能额度",
        entitlementType: EntitlementType.ENERGY,
        snapshot: { energyPackage: packageSnapshot.energyPackage },
        totalAmount: monthlyEnergyKwh,
        unit: EntitlementUnit.KWH
      })
    );
  }

  const monthlyEnergyCount = numberField(
    packageSnapshot.energyPackage,
    "monthlyEnergyCount",
    "monthly_energy_count",
    "monthlyEnergyTimes"
  );
  if (monthlyEnergyCount !== null && monthlyEnergyCount > 0) {
    grants.push(
      amountGrant({
        entitlementName: "月补能次数",
        entitlementType: EntitlementType.ENERGY,
        snapshot: { energyPackage: packageSnapshot.energyPackage },
        totalAmount: monthlyEnergyCount,
        unit: EntitlementUnit.TIMES
      })
    );
  }

  if (packageSnapshot.benefitPackage) {
    const benefitCount = numberField(
      packageSnapshot.benefitPackage,
      "benefitCount",
      "benefit_count"
    );
    const benefitType = stringField(packageSnapshot.benefitPackage, "benefitType", "benefit_type");
    const description = stringField(packageSnapshot.benefitPackage, "description");
    const packageName = stringField(packageSnapshot.benefitPackage, "packageName", "package_name");
    const entitlementName = truncateEntitlementName(
      description ?? benefitTypeLabel(benefitType) ?? packageName ?? "服务权益"
    );

    if (benefitCount !== null && benefitCount > 0) {
      grants.push(
        amountGrant({
          entitlementName,
          entitlementType: EntitlementType.BENEFIT,
          snapshot: {
            benefitPackage: packageSnapshot.benefitPackage,
            benefitType,
            description
          },
          totalAmount: benefitCount,
          unit: EntitlementUnit.TIMES
        })
      );
    } else {
      grants.push({
        entitlementName,
        entitlementType: EntitlementType.BENEFIT,
        remainingAmount: null,
        snapshot: toJsonValue({
          benefitPackage: packageSnapshot.benefitPackage,
          benefitType,
          description
        }),
        totalAmount: null,
        unit: EntitlementUnit.TEXT,
        usedAmount: null
      });
    }
  }

  return grants;
}

function amountGrant(input: {
  entitlementName: string;
  entitlementType: EntitlementType;
  snapshot: unknown;
  totalAmount: number;
  unit: EntitlementUnit;
}): OrderEntitlementGrantInput {
  const amount = new Prisma.Decimal(input.totalAmount);
  return {
    entitlementName: truncateEntitlementName(input.entitlementName),
    entitlementType: input.entitlementType,
    remainingAmount: amount,
    snapshot: toJsonValue(input.snapshot),
    totalAmount: amount,
    unit: input.unit,
    usedAmount: new Prisma.Decimal(0)
  };
}

function hasEntitlementPackageComponent(packageSnapshot: OrderEntitlementPackageSnapshot) {
  return Boolean(
    packageSnapshot.mileagePackage ||
    packageSnapshot.energyPackage ||
    packageSnapshot.benefitPackage
  );
}

function resolveSubscriptionPlanId(packageSnapshot: OrderEntitlementPackageSnapshot) {
  return packageSnapshot.subscriptionPlanId ?? stringField(packageSnapshot.subscriptionPlan, "id");
}

function resolveMonthlyEntitlementPeriod(
  order: OrderWithDetails,
  cycleIndex: number,
  fallbackStart?: Date
) {
  const baseDate = fallbackStart ?? toBusinessDate(order.actualDeliveryAt!);
  const periodStart = fallbackStart
    ? toBusinessDate(fallbackStart)
    : addMonthsClampedUtc(baseDate, cycleIndex);
  const nextPeriodStart = fallbackStart
    ? addMonthsClampedUtc(periodStart, 1)
    : addMonthsClampedUtc(baseDate, cycleIndex + 1);
  return {
    periodEnd: addDaysUtc(nextPeriodStart, -1),
    periodStart
  };
}

function resolveEntitlementAsOfDate(value?: string) {
  return toBusinessDate(value ? parseDateTime(value, "asOfDate") : new Date());
}

function resolveLatestEntitlementCycleIndex(
  order: OrderWithDetails,
  account: EntitlementAccountWithGrants
) {
  let latestCycleIndex: number | null = null;
  for (const grant of account.grants) {
    if (
      grant.grantSource !== EntitlementGrantSource.ORDER_START &&
      grant.grantSource !== EntitlementGrantSource.MONTHLY_RENEWAL
    ) {
      continue;
    }
    const cycleIndex =
      grant.grantSource === EntitlementGrantSource.ORDER_START
        ? 0
        : resolveCycleIndexByPeriodStart(order, grant.grantPeriodStart);
    if (cycleIndex === null) {
      continue;
    }
    latestCycleIndex =
      latestCycleIndex === null ? cycleIndex : Math.max(latestCycleIndex, cycleIndex);
  }
  return latestCycleIndex;
}

function resolveCycleIndexByPeriodStart(order: OrderWithDetails, periodStart: Date) {
  const targetKey = dateKey(toBusinessDate(periodStart));
  const maxCycles = Math.max(order.periodMonths + 24, 240);
  for (let cycleIndex = 0; cycleIndex <= maxCycles; cycleIndex += 1) {
    const currentPeriod = resolveMonthlyEntitlementPeriod(order, cycleIndex);
    const currentKey = dateKey(currentPeriod.periodStart);
    if (currentKey === targetKey) {
      return cycleIndex;
    }
    if (currentPeriod.periodStart > periodStart) {
      return null;
    }
  }
  return null;
}

function findExistingMonthlyRenewalGrants(
  account: EntitlementAccountWithGrants,
  periodStart: Date,
  periodEnd: Date,
  grantInputs: OrderEntitlementGrantInput[]
) {
  return account.grants.filter(
    (grant) =>
      grant.grantSource === EntitlementGrantSource.MONTHLY_RENEWAL &&
      dateKey(grant.grantPeriodStart) === dateKey(periodStart) &&
      grant.grantPeriodEnd !== null &&
      dateKey(grant.grantPeriodEnd) === dateKey(periodEnd) &&
      grantInputs.some((grantInput) => isSameEntitlementGrant(grant, grantInput))
  );
}

function isSameEntitlementGrant(
  grant: Pick<
    EntitlementAccountWithGrants["grants"][number],
    "entitlementName" | "entitlementType" | "unit"
  >,
  grantInput: OrderEntitlementGrantInput
) {
  return (
    grant.entitlementType === grantInput.entitlementType &&
    grant.entitlementName === grantInput.entitlementName &&
    grant.unit === grantInput.unit
  );
}

function addMonthsClampedUtc(date: Date, months: number) {
  const firstOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(
      firstOfTargetMonth.getUTCFullYear(),
      firstOfTargetMonth.getUTCMonth(),
      Math.min(date.getUTCDate(), lastDayOfTargetMonth)
    )
  );
}

function addDaysUtc(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function toBusinessDate(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function toEntitlementResponse(account: EntitlementAccountWithGrants) {
  return {
    account: toEntitlementAccountView(account),
    grants: account.grants.map(toEntitlementGrantView)
  };
}

function toMonthlyRenewalResponse(
  plan: MonthlyRenewalPlan,
  overrideAction?: EntitlementRenewalAction,
  grantIds: string[] = []
) {
  return {
    dryRun: plan.dryRun,
    grants: plan.missingGrantInputs.map(toMonthlyRenewalGrantPreview),
    ...toMonthlyRenewalItem(plan, overrideAction, grantIds)
  };
}

function toMonthlyRenewalItem(
  plan: MonthlyRenewalPlan,
  overrideAction?: EntitlementRenewalAction,
  grantIds: string[] = []
) {
  const action = overrideAction ?? plan.action;
  const isExisting =
    action === "SKIPPED_EXISTING" ||
    (action === "DRY_RUN_SKIP" && plan.reason !== "未到续发日期。");
  return {
    accountId: plan.account.id,
    action,
    grantCount: isExisting ? plan.existingGrants.length : plan.missingGrantInputs.length,
    grantIds,
    orderId: plan.order.id,
    orderNo: plan.order.orderNo,
    periodEnd: dateKey(plan.periodEnd),
    periodStart: dateKey(plan.periodStart),
    reason: action === "GENERATED" || action === "DRY_RUN_GENERATE" ? "-" : plan.reason
  };
}

function toMonthlyRenewalGrantPreview(grant: OrderEntitlementGrantInput) {
  return {
    entitlementName: grant.entitlementName,
    entitlementType: grant.entitlementType,
    remainingAmount: toPlain(grant.remainingAmount),
    totalAmount: toPlain(grant.totalAmount),
    unit: grant.unit,
    usedAmount: toPlain(grant.usedAmount)
  };
}

function toMonthlyRenewalFailedItem(order: OrderWithDetails, dryRun: boolean, error: unknown) {
  return {
    action: dryRun ? "DRY_RUN_FAILED" : "FAILED",
    grantCount: 0,
    orderId: order.id,
    orderNo: order.orderNo,
    periodEnd: null,
    periodStart: null,
    reason: error instanceof Error ? error.message : "权益月度续发失败。"
  };
}

function toMonthlyRenewalBatchResponse(items: Array<Record<string, unknown>>, dryRun: boolean) {
  const generatedActions = new Set(["GENERATED", "DRY_RUN_GENERATE"]);
  const failedActions = new Set(["FAILED", "DRY_RUN_FAILED"]);
  const generatedCount = items.filter((item) => generatedActions.has(String(item.action))).length;
  const failedCount = items.filter((item) => failedActions.has(String(item.action))).length;
  return {
    dryRun,
    failedCount,
    generatedCount,
    items,
    skippedCount: items.length - generatedCount - failedCount
  };
}

function toExpireEntitlementsResponse(
  grants: Array<Prisma.OrderEntitlementGrantGetPayload<object>>,
  activeCount: number,
  dryRun: boolean,
  updatedCount = grants.length
) {
  return {
    dryRun,
    expiredCount: updatedCount,
    items: grants.map(toExpireEntitlementItem),
    skippedCount: Math.max(activeCount - grants.length, 0)
  };
}

function toExpireEntitlementItem(grant: Prisma.OrderEntitlementGrantGetPayload<object>) {
  return {
    accountId: grant.accountId,
    entitlementName: grant.entitlementName,
    entitlementType: grant.entitlementType,
    grantId: grant.id,
    grantNo: grant.grantNo,
    orderId: grant.orderId,
    periodEnd: grant.grantPeriodEnd ? dateKey(grant.grantPeriodEnd) : null,
    periodStart: dateKey(grant.grantPeriodStart),
    status: grant.status,
    unit: grant.unit
  };
}

function toEntitlementAccountView(account: EntitlementAccountWithGrants) {
  const accountData = { ...account } as Record<string, unknown>;
  delete accountData.grants;
  return toPlain(accountData) as Record<string, unknown>;
}

function toEntitlementGrantView(
  grant: EntitlementAccountWithGrants["grants"][number] | EntitlementGrantWithUsageOverview
) {
  const grantData = { ...grant } as Record<string, unknown>;
  const usages = Array.isArray(grantData.usages) ? grantData.usages : [];
  const latestUsage = usages[0] as { occurredAt?: Date | string | null } | undefined;
  delete grantData.usages;
  return {
    ...(toPlain(grantData) as Record<string, unknown>),
    latestUsageAt: latestUsage?.occurredAt ? toPlain(latestUsage.occurredAt) : null
  };
}

function toEntitlementUsageView(usage: EntitlementUsageRecord) {
  return toPlain(usage) as Record<string, unknown>;
}

function resolveEntitlementUsagePagination(query: { page?: number; pageSize?: number }) {
  const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = clampInteger(query.pageSize, 1, 100, 20);
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function optionalText(value: string | undefined, maxLength?: number) {
  if (!value?.trim()) {
    return null;
  }
  const text = value.trim();
  return maxLength ? text.slice(0, maxLength) : text;
}

function firstSnapshotRecord(...values: unknown[]) {
  for (const value of values) {
    const record = asSnapshotRecord(value);
    if (record) {
      return record;
    }
  }
  return null;
}

function asSnapshotRecord(value: unknown): SnapshotRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as SnapshotRecord;
}

function numberField(record: SnapshotRecord | null, ...keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function stringField(record: SnapshotRecord | null, ...keys: string[]) {
  if (!record) {
    return null;
  }
  return firstStringValue(...keys.map((key) => record[key]));
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toNumber();
  }
  return null;
}

function benefitTypeLabel(benefitType: string | null) {
  if (!benefitType) {
    return null;
  }
  const labels: Record<string, string> = {
    CAR_SWAP: "换车权益",
    DRIVER_SERVICE: "代驾权益",
    OTHER: "其他权益",
    POINTS: "积分权益",
    WASH_CAR: "洗车权益"
  };
  return labels[benefitType] ?? benefitType;
}

function truncateEntitlementName(value: string) {
  return value.length > 128 ? value.slice(0, 128) : value;
}

function assertOrderNotDelivered(order: OrderWithDetails) {
  if (order.actualDeliveryAt || order.orderStatus === OrderStatus.ACTIVE) {
    throw new BadRequestException(DELIVERY_ALREADY_DONE_MESSAGE);
  }
}

export function buildEntitlementGrantInputsFromSnapshot(
  snapshot: unknown
): OrderEntitlementGrantInput[] {
  return buildOrderEntitlementGrantInputs(normalizeEntitlementPackageSnapshot(snapshot));
}

function assertDeliveryConfirmationValues(
  order: OrderWithDetails,
  dto: ConfirmDeliveryDto,
  deliveredAt: Date
) {
  if (!Number.isSafeInteger(dto.handoverMileageKm) || dto.handoverMileageKm < 0) {
    throw new BadRequestException("交付里程必须是非负整数。");
  }
  if (deliveredAt.getTime() < order.createdAt.getTime()) {
    throw new BadRequestException("实际交付时间不能早于订单创建时间。");
  }
  if (deliveredAt.getTime() > Date.now()) {
    throw new BadRequestException("实际交付时间不能晚于当前时间。");
  }
}

function assertCanPrepareDelivery(order: OrderWithDetails, scheduledAt: Date | null) {
  const check = buildDeliveryCheck(order, null, scheduledAt ?? undefined);
  if (!check.canPrepareDelivery) {
    throw new BadRequestException(firstBlockingReason(check, "当前订单不满足准备交付条件。"));
  }
}

function findActiveDeliveryHandover(prisma: PrismaService, orderId: string) {
  return findDeliveryHandoverForConfirmation(prisma, orderId);
}

async function resolveDeliveryConfirmationDefaults(
  db: Prisma.TransactionClient | PrismaService,
  orderId: string,
  handover: Awaited<ReturnType<typeof findActiveDeliveryHandover>> | null
): Promise<DeliveryConfirmationDefaultsResolution> {
  if (!handover) {
    return { blockingReasons: [], defaults: null };
  }
  if (!handover.completedAt) {
    return {
      blockingReasons: ["Stage 2 交接单尚未完成双方签署"],
      defaults: null
    };
  }

  const fieldWorkOrder = await db.vehicleHandoverWorkOrder.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      handoverMileageKm: true,
      id: true
    },
    where: {
      handoverId: handover.id,
      handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
      orderId
    }
  });
  if (!fieldWorkOrder || fieldWorkOrder.handoverMileageKm === null) {
    return {
      blockingReasons: ["Field 现场交接里程尚未填写"],
      defaults: null
    };
  }

  return {
    blockingReasons: [],
    defaults: {
      deliveredAt: handover.completedAt.toISOString(),
      deliveredAtSource: "STAGE2_COMPLETED_AT",
      fieldWorkOrderId: fieldWorkOrder.id,
      handoverMileageKm: fieldWorkOrder.handoverMileageKm,
      handoverMileageSource: "FIELD_WORK_ORDER",
      stage2HandoverId: handover.id
    }
  };
}

function assertCanConfirmDelivery(
  order: OrderWithDetails,
  delivery: DeliveryWithDetails | null,
  deliveredAt: Date,
  handover: Awaited<ReturnType<typeof findActiveDeliveryHandover>> | null,
  evidenceReadiness: DeliveryEvidenceReadiness,
  confirmationDefaults?: DeliveryConfirmationDefaultsResolution
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

  const check = buildDeliveryCheck(
    order,
    delivery,
    deliveredAt,
    handover,
    evidenceReadiness,
    confirmationDefaults
  );
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

function assertCanPrepareReturn(order: OrderWithDetails) {
  const check = buildReturnCheck(order, null);
  if (!check.canPrepareReturn) {
    throw new BadRequestException(firstReturnBlockingReason(check, "当前订单不满足准备退车条件。"));
  }
}

function assertCanConfirmReturn(order: OrderWithDetails, vehicleReturn: ReturnWithDetails | null) {
  if (!vehicleReturn || vehicleReturn.deletedAt) {
    throw new BadRequestException(RETURN_READY_REQUIRED_MESSAGE);
  }
  if (vehicleReturn.returnStatus === VehicleReturnStatus.CONFIRMED || vehicleReturn.returnedAt) {
    throw new BadRequestException(RETURN_ALREADY_DONE_MESSAGE);
  }
  if (vehicleReturn.returnStatus !== VehicleReturnStatus.READY) {
    throw new BadRequestException(RETURN_READY_REQUIRED_MESSAGE);
  }

  const check = buildReturnCheck(order, vehicleReturn);
  if (!check.canConfirmReturn) {
    throw new BadRequestException(firstReturnBlockingReason(check, "当前订单不满足确认退车条件。"));
  }
}

function firstReturnBlockingReason(check: ReturnType<typeof buildReturnCheck>, fallback: string) {
  return check.blockingReasons[0] ?? fallback;
}

function buildDeliveryCheck(
  order: OrderWithDetails,
  delivery: DeliveryWithDetails | null,
  targetAt?: Date,
  handover?: Awaited<ReturnType<typeof findActiveDeliveryHandover>> | null,
  evidenceReadiness?: DeliveryEvidenceReadiness,
  confirmationDefaults?: DeliveryConfirmationDefaultsResolution
) {
  const contractSigned = isCurrentContractSigned(order);
  const vehicle = order.vehicle;
  const deliveryCheckAt =
    targetAt ??
    delivery?.deliveredAt ??
    delivery?.scheduledAt ??
    order.startDate ??
    order.createdAt;
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
  const resolvedInsuranceCoverage = resolveVehicleInsuranceCoverage(
    vehicle?.insurancePolicies ?? [],
    deliveryCheckAt
  );
  const insuranceCoverage = {
    commercialCovered: resolvedInsuranceCoverage.commercial.covered,
    compulsoryTrafficCovered: resolvedInsuranceCoverage.compulsoryTraffic.covered,
    evaluatedAt: resolvedInsuranceCoverage.evaluationDate
  };
  const insuranceValid = Boolean(vehicle && resolvedInsuranceCoverage.covered);
  const depositRequiredAmount = getRequiredDepositAmount(order);
  const depositRequired = depositRequiredAmount > 0n;
  const depositReceivedConfirmed =
    !depositRequired ||
    (order.depositStatus === DepositStatus.CONFIRMED &&
      Boolean(delivery?.depositReceivedConfirmed));
  const firstMonthlyFeeReceivedConfirmed = Boolean(delivery?.firstMonthlyFeeReceivedConfirmed);
  const vehiclePrepared = Boolean(delivery?.vehiclePreparedConfirmed);
  const vehiclePhotosConfirmed = Boolean(delivery?.vehiclePhotosConfirmed);
  const customerIdentityConfirmed = Boolean(delivery?.customerIdentityConfirmed);
  const handoverDocumentsConfirmed = Boolean(delivery?.handoverDocumentsConfirmed);
  const handoverSigned = isDeliveryHandoverSigned(handover);
  const handoverArchived = isDeliveryHandoverArchived(handover);
  const handoverReady = isDeliveryHandoverReadyForDelivery(handover);
  const handoverArchiveWarning = getDeliveryHandoverArchiveWarning(handover);
  const handoverEvidenceReady = evidenceReadiness?.ready ?? false;
  const deliveryReady = delivery?.deliveryStatus === DeliveryStatus.READY;

  if (alreadyDelivered) {
    return {
      alreadyDelivered,
      blockingReasons: [],
      canConfirmDelivery: false,
      canPrepareDelivery: false,
      contractSigned,
      currentSalePriceInitialized,
      confirmationDefaults: confirmationDefaults?.defaults ?? null,
      deliveryStatus: delivery?.deliveryStatus ?? null,
      depositRequired,
      depositRequiredAmount: Number(depositRequiredAmount),
      depositReceivedConfirmed,
      firstMonthlyFeeReceivedConfirmed,
      handoverArchived,
      handoverArchiveWarning,
      handoverEvidenceBlockingReasons: evidenceReadiness?.blockingReasons ?? [],
      handoverEvidenceReady,
      handoverReady,
      handoverSigned,
      insuranceCoverage,
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
  if (!resolvedInsuranceCoverage.compulsoryTraffic.covered) {
    prepareBlockingReasons.push("交强险未覆盖计划交付日");
  }
  if (!resolvedInsuranceCoverage.commercial.covered) {
    prepareBlockingReasons.push("商业险未覆盖计划交付日");
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
    confirmBlockingReasons.push("保险人工核验尚未确认");
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
  if (!handoverReady) {
    confirmBlockingReasons.push(DELIVERY_HANDOVER_NOT_READY_MESSAGE);
  }
  if (!handoverEvidenceReady) {
    confirmBlockingReasons.push(
      ...(evidenceReadiness?.blockingReasons ?? ["交付证据尚未全部上传并审核通过。"])
    );
  }
  if (confirmationDefaults) {
    confirmBlockingReasons.push(...confirmationDefaults.blockingReasons);
  }

  return {
    alreadyDelivered,
    blockingReasons: confirmBlockingReasons,
    canConfirmDelivery: confirmBlockingReasons.length === 0,
    canPrepareDelivery: prepareBlockingReasons.length === 0,
    contractSigned,
    currentSalePriceInitialized,
    confirmationDefaults: confirmationDefaults?.defaults ?? null,
    deliveryStatus: delivery?.deliveryStatus ?? null,
    depositRequired,
    depositRequiredAmount: Number(depositRequiredAmount),
    depositReceivedConfirmed,
    firstMonthlyFeeReceivedConfirmed,
    handoverArchived,
    handoverArchiveWarning,
    handoverEvidenceBlockingReasons: evidenceReadiness?.blockingReasons ?? [],
    handoverEvidenceReady,
    handoverReady,
    handoverSigned,
    insuranceCoverage,
    insuranceValid,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    vehiclePrepared,
    vehicleStatus: vehicle?.status ?? null
  };
}

function buildReturnCheck(order: OrderWithDetails, vehicleReturn: ReturnWithDetails | null) {
  const vehicle = order.vehicle;
  const eligibility = buildReturnEligibility(order, vehicleReturn);
  return {
    ...eligibility,
    orderId: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus,
    returnId: vehicleReturn?.id ?? null,
    returnStatus: vehicleReturn?.returnStatus ?? null,
    returnUpdatedAt: vehicleReturn?.updatedAt ?? null,
    vehicleId: order.vehicleId,
    vehicleStatus: vehicle?.status ?? null
  };
}

export function buildReturnEligibility(
  order: {
    actualDeliveryAt?: Date | null;
    actualReturnAt?: Date | null;
    orderStatus: OrderStatus;
    vehicle?: { deletedAt?: Date | null; id: string; status: VehicleStatus } | null;
    vehicleId?: string | null;
  },
  vehicleReturn: {
    returnStatus: VehicleReturnStatus;
    returnedAt?: Date | null;
  } | null
) {
  const vehicle = order.vehicle;
  const alreadyReturned = Boolean(
    order.actualReturnAt ||
    vehicleReturn?.returnStatus === VehicleReturnStatus.CONFIRMED ||
    vehicleReturn?.returnedAt
  );

  if (alreadyReturned) {
    return {
      alreadyReturned,
      blockingReasons: [RETURN_ALREADY_DONE_MESSAGE],
      canConfirmReturn: false,
      canPrepareReturn: false
    };
  }

  const prepareBlockingReasons: string[] = [];
  const confirmBlockingReasons: string[] = [];

  if (
    (order.orderStatus !== OrderStatus.ACTIVE &&
      order.orderStatus !== OrderStatus.PENDING_RETURN) ||
    !order.actualDeliveryAt
  ) {
    prepareBlockingReasons.push("订单尚未起租，不能退车");
  }
  if (!order.vehicleId || !vehicle || vehicle.deletedAt) {
    prepareBlockingReasons.push("订单未绑定有效车辆");
  } else if (vehicle.id !== order.vehicleId) {
    prepareBlockingReasons.push("车辆与订单不匹配");
  } else if (vehicle.status !== VehicleStatus.LEASED) {
    prepareBlockingReasons.push("车辆状态不是已出租，不能退车");
  }

  confirmBlockingReasons.push(...prepareBlockingReasons);
  if (vehicleReturn?.returnStatus !== VehicleReturnStatus.READY) {
    confirmBlockingReasons.push(RETURN_READY_REQUIRED_MESSAGE);
  }

  return {
    alreadyReturned,
    blockingReasons: confirmBlockingReasons,
    canConfirmReturn: confirmBlockingReasons.length === 0,
    canPrepareReturn: prepareBlockingReasons.length === 0
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
  const depositReceivedConfirmed =
    beforeDelivery?.depositReceivedConfirmed ?? false;
  const firstMonthlyFeeReceivedConfirmed =
    beforeDelivery?.firstMonthlyFeeReceivedConfirmed ?? false;
  const insuranceValidConfirmed =
    dto.insuranceValidConfirmed ?? beforeDelivery?.insuranceValidConfirmed ?? false;
  const vehiclePreparedConfirmed =
    dto.vehiclePreparedConfirmed ?? beforeDelivery?.vehiclePreparedConfirmed ?? false;
  const vehiclePhotosConfirmed =
    dto.vehiclePhotosConfirmed ?? beforeDelivery?.vehiclePhotosConfirmed ?? false;
  const customerIdentityConfirmed =
    dto.customerIdentityConfirmed ?? beforeDelivery?.customerIdentityConfirmed ?? false;
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
    handoverDocumentsConfirmed,
    insuranceValidConfirmed,
    remark,
    scheduledAt: nextScheduledAt,
    updatedBy: userId,
    vehiclePhotosConfirmed,
    vehiclePreparedConfirmed
  };
}

function buildPrepareReturnData(
  dto: PrepareReturnDto,
  scheduledAt: Date | null,
  userId: string,
  beforeReturn: ReturnWithDetails | null
) {
  return {
    remark: dto.remark ?? beforeReturn?.remark ?? null,
    returnLocation: dto.returnLocation ?? beforeReturn?.returnLocation ?? null,
    returnStatus: VehicleReturnStatus.READY,
    returnType: dto.returnType ?? beforeReturn?.returnType ?? VehicleReturnType.NORMAL_RETURN,
    scheduledAt: scheduledAt ?? beforeReturn?.scheduledAt ?? null,
    updatedBy: userId
  };
}

function buildReturnChecklistSnapshot(dto: ConfirmReturnDto, damageFound: boolean) {
  return {
    batteryCheckedConfirmed: Boolean(dto.batteryCheckedConfirmed),
    chargingEquipmentReturnedConfirmed: Boolean(dto.chargingEquipmentReturnedConfirmed),
    cleaningRequired: Boolean(dto.cleaningRequired),
    customerItemsClearedConfirmed: Boolean(dto.customerItemsClearedConfirmed),
    damageFound,
    exteriorCheckedConfirmed: Boolean(dto.exteriorCheckedConfirmed),
    interiorCheckedConfirmed: Boolean(dto.interiorCheckedConfirmed),
    keysReturnedConfirmed: Boolean(dto.keysReturnedConfirmed),
    maintenanceRequired: Boolean(dto.maintenanceRequired),
    mileageConfirmed: Boolean(dto.mileageConfirmed),
    vehicleDocumentsReturnedConfirmed: Boolean(dto.vehicleDocumentsReturnedConfirmed),
    violationCheckedConfirmed: Boolean(dto.violationCheckedConfirmed)
  };
}

function assertReturnChecklistConfirmed(dto: ConfirmReturnDto) {
  if (RETURN_REQUIRED_CHECKLIST.some((field) => dto[field] !== true)) {
    throw new BadRequestException("退车验收必填检查项尚未全部确认。");
  }
}

function assertValidReturnMileage(returnMileageKm: number | undefined) {
  if (
    typeof returnMileageKm !== "number" ||
    !Number.isSafeInteger(returnMileageKm) ||
    returnMileageKm < 0
  ) {
    throw new BadRequestException("退车里程必须是大于等于 0 的整数。");
  }
}

function isCurrentContractSigned(order: OrderWithDetails) {
  const contract = findCurrentContract(order);
  return contract?.status === ContractStatus.SIGNED || contract?.status === ContractStatus.ARCHIVED;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getRequiredDepositAmount(
  order: Pick<OrderWithDetails, "depositAmount" | "finalDepositAmount">
) {
  return order.finalDepositAmount ?? order.depositAmount ?? 0n;
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

function ensureCanReviewOrderSection(
  user: RequestUser,
  reviewType: "credit" | "product" | "vehicle"
) {
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
  return (
    change.status === OrderChangeStatus.PENDING || change.status === OrderChangeStatus.APPROVED
  );
}

function hasActiveOrderChange(order: {
  changes?: Array<{
    deletedAt?: Date | null;
    executedAt?: Date | null;
    status: OrderChangeStatus;
  }>;
}) {
  return order.changes?.some(isActiveOrderChange) ?? false;
}

function assertNoActiveOrderChange(order: {
  changes?: Array<{
    deletedAt?: Date | null;
    executedAt?: Date | null;
    status: OrderChangeStatus;
  }>;
}) {
  if (hasActiveOrderChange(order)) {
    throw new BadRequestException(ACTIVE_ORDER_CHANGE_MESSAGE);
  }
}

function assertNoDuplicateActiveOrderChange(order: {
  changes?: Array<{
    deletedAt?: Date | null;
    executedAt?: Date | null;
    status: OrderChangeStatus;
  }>;
}) {
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

async function lockVehicleAvailabilityAuthority(tx: Prisma.TransactionClient, vehicleId: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${vehicleId}::uuid FOR UPDATE`
  );
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
    modelCodeSnapshot: order.modelCodeSnapshot,
    modelDefinitionIdSnapshot: order.modelDefinitionIdSnapshot,
    modelDisplayNameSnapshot: order.modelDisplayNameSnapshot
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

  const modelDefinitionId =
    order.vehicle?.modelDefinitionId ??
    quote.vehicle?.modelDefinitionId ??
    order.modelDefinitionIdSnapshot;
  if (!vehiclePackageSupportsModel(quote.subscriptionPlan.vehiclePackage, modelDefinitionId)) {
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
  if (
    !UNSIGNED_CONTRACT_STATUSES.has(contract.status) &&
    contract.status !== ContractStatus.CANCELLED
  ) {
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
  const packages = [
    plan.vehiclePackage,
    plan.mileagePackage,
    plan.energyPackage,
    plan.benefitPackage
  ].filter(Boolean);
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
  return (
    dateOnlyTimeForOrder(effectiveFrom) <= todayTime &&
    (!effectiveTo || dateOnlyTimeForOrder(effectiveTo) >= todayTime)
  );
}

function dateOnlyTimeForOrder(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function toPlanChangeSubscriptionPlanView(plan: SubscriptionPlanWithDetails) {
  return {
    benefitDescription:
      plan.benefitPackage?.description ?? plan.benefitPackage?.packageName ?? null,
    benefitPackagePriceAmount: plan.benefitPackage ? Number(plan.benefitPackage.priceAmount) : 0,
    energyPackagePriceAmount: Number(plan.energyPackage.priceAmount),
    maxPeriodMonths: plan.maxPeriodMonths,
    maxPurchasePriceAmount:
      plan.vehiclePackage.maxPurchasePriceAmount === null
        ? null
        : Number(plan.vehiclePackage.maxPurchasePriceAmount),
    minPeriodMonths: plan.minPeriodMonths,
    minPurchasePriceAmount:
      plan.vehiclePackage.minPurchasePriceAmount === null
        ? null
        : Number(plan.vehiclePackage.minPurchasePriceAmount),
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
    modelCode: plan.vehiclePackage.modelDefinition.modelCode,
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

function assertPeriodInRange(
  periodMonths: number,
  minPeriodMonths: number,
  maxPeriodMonths: number
) {
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

function calculateCustomerOrderVehicleBaseFee(
  plan: SubscriptionPlanWithDetails,
  vehicleSalePriceAmount: bigint
) {
  const vehiclePackageRate = Number(plan.vehiclePackage.monthlyFeeRate);
  if (!Number.isFinite(vehiclePackageRate) || vehiclePackageRate <= 0) {
    throw new BadRequestException("车型包车辆基础费上限率必须大于 0");
  }
  const vehicleBaseFeeCapAmount = BigInt(
    Math.floor(Number(vehicleSalePriceAmount) * vehiclePackageRate)
  );
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

async function findActiveDepositRule(
  tx: Prisma.TransactionClient,
  grade: NonNullable<ReviewOrderDto["customerGrade"]>
) {
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
  const view = toPlain({
    ...order,
    depositAmount: Number(order.depositAmount),
    finalDepositAmount: order.finalDepositAmount === null ? null : Number(order.finalDepositAmount),
    modelDisplayName: order.modelDisplayNameSnapshot,
    modelDisplaySource: "SNAPSHOT",
    monthlyFeeAmount: Number(order.monthlyFeeAmount),
    overMileageFeeAmount: Number(order.overMileageFeeAmount),
    vehiclePurchasePriceAmount: Number(order.vehiclePurchasePriceAmount)
  }) as Record<string, unknown>;
  redactIdentityIdCardNumbers(view);
  return view;
}

function redactIdentityIdCardNumbers(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) {
      redactIdentityIdCardNumbers(item);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  if ("idCardNo" in value) {
    const idCardNo = value.idCardNo;
    value.idCardNoPresent = typeof idCardNo === "string" && idCardNo.trim().length > 0;
    delete value.idCardNo;
  }
  for (const item of Object.values(value)) {
    redactIdentityIdCardNumbers(item);
  }
}

function toDeliveryView(delivery: DeliveryWithDetails): Record<string, unknown> {
  return toPlain(delivery) as Record<string, unknown>;
}

function toReturnView(vehicleReturn: ReturnWithDetails): Record<string, unknown> {
  return toPlain(vehicleReturn) as Record<string, unknown>;
}

function toQuoteAuditView(quote: QuoteWithDetails): Prisma.InputJsonValue {
  return toJsonValue(quote);
}

function toSubscriptionPlanSnapshot(plan: SubscriptionPlanWithDetails) {
  return {
    baseMonthlyFeeAmount:
      plan.baseMonthlyFeeAmount === null ? null : Number(plan.baseMonthlyFeeAmount),
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
    | Prisma.VehiclePackageGetPayload<{ include: typeof vehiclePackageInclude }>
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

  if ("modelDefinitionId" in row) {
    result.configName = row.configName;
    result.maxPurchasePriceAmount =
      row.maxPurchasePriceAmount === null ? null : Number(row.maxPurchasePriceAmount);
    result.minPurchasePriceAmount =
      row.minPurchasePriceAmount === null ? null : Number(row.minPurchasePriceAmount);
    result.modelCode = row.modelDefinition.modelCode;
    result.modelDefinitionId = row.modelDefinitionId;
    result.modelDisplayName = row.modelDefinition.displayName;
    result.monthlyFeeRate = Number(row.monthlyFeeRate);
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
  const view = {
    ...(toPlain(contract) as Record<string, unknown>),
    hasGeneratedPdfArtifact: hasGeneratedContractPdfArtifact(contract)
  };
  redactIdentityIdCardNumbers(view);
  return view;
}

function toContractVersionView(
  version: Prisma.ContractVersionGetPayload<object>
): Record<string, unknown> {
  return toPlain(version) as Record<string, unknown>;
}

function toOrderChangeAuditView(
  change: Prisma.OrderChangeGetPayload<object>
): Record<string, unknown> {
  return toPlain(change) as Record<string, unknown>;
}

function toOrderChangeResponse(
  change: Prisma.OrderChangeGetPayload<object>,
  user: RequestUser
): Record<string, unknown> {
  return projectOrderChangeView(toOrderChangeAuditView(change), new Set(user.permissions));
}

function buildContractSnapshotWithGeneratedPdfArtifact(
  contractSnapshot: unknown,
  artifact: ContractPdfArtifactWriteResult
): Prisma.InputJsonValue {
  const plainSnapshot = toPlain(contractSnapshot);
  const baseSnapshot = isPlainRecord(plainSnapshot) ? plainSnapshot : {};
  return toJsonValue({
    ...baseSnapshot,
    generatedContractPdfArtifact: {
      fileId: artifact.fileId,
      mimeType: artifact.mimeType,
      objectKey: artifact.objectKey,
      originalName: artifact.originalName,
      signingStage: artifact.diagnostics.signingStage,
      sizeBytes: artifact.sizeBytes,
      slotCoordinates: artifact.diagnostics.slotCoordinates,
      source: artifact.diagnostics.source
    }
  });
}

function hasGeneratedContractPdfArtifact(
  contract: Pick<ContractWithDetails, "contractSnapshot" | "fileId">
) {
  const snapshot = toPlain(contract.contractSnapshot);
  if (!isPlainRecord(snapshot)) {
    return false;
  }
  const artifact = snapshot.generatedContractPdfArtifact;
  return isPlainRecord(artifact) && Boolean(contract.fileId) && artifact.fileId === contract.fileId;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
