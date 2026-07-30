import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  AuditAction,
  BusinessType,
  CustomerGrade,
  CustomerStatus,
  DepositStatus,
  MaterialStatus,
  MonthlyFeeMode,
  NotificationEventType,
  NotificationType,
  OrderReviewStatus,
  OrderSource,
  OrderStatus,
  PlanConfirmStatus,
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
import { PermissionCode } from "@subscription-saas/shared";
import type { Readable } from "node:stream";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import {
  buildVehicleModelSnapshot,
  type ModelDefinitionSnapshot,
  modelDefinitionSnapshotSelect
} from "../common/vehicle-model-snapshot";
import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { RiskService, riskResultInclude, toRiskResultView } from "../risk/risk.service";
import { StorageService } from "../storage/storage.service";
import {
  assertCustomerIdentityProfileReady,
  assertValidCustomerApplicationIdentityInput
} from "./customer-identity-readiness";
import {
  ApproveApplicationDto,
  NeedMoreInfoDto,
  RejectApplicationDto,
  ReviewApplicationDto,
  SubmitApplicationDto
} from "./dto/application-review.dto";
import { CreateApplicationDto } from "./dto/create-application.dto";
import {
  CreateCustomerDto,
  CustomerIdentityDto,
  CustomerProfileDto
} from "./dto/create-customer.dto";
import { CreateFollowupDto } from "./dto/create-followup.dto";
import {
  CreateMaterialDto,
  DeleteMaterialFileDto,
  ReviewMaterialDto
} from "./dto/create-material.dto";
import { CreateSelfServiceApplicationDto } from "./dto/create-self-service-application.dto";
import { UpdateApplicationDto } from "./dto/update-application.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";

const customerInclude = {
  applications: {
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  identity: true,
  ownerUser: {
    select: { id: true, name: true, username: true }
  },
  profile: true
} satisfies Prisma.CustomerInclude;

const materialInclude = {
  file: {
    include: {
      uploader: {
        select: { id: true, name: true, username: true }
      }
    }
  },
  reviewer: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialInclude;

const materialGroupInclude = {
  files: {
    include: {
      file: true,
      uploader: {
        select: { id: true, name: true, username: true }
      },
      deleter: {
        select: { id: true, name: true, username: true }
      }
    },
    orderBy: { uploadedAt: "desc" as const }
  },
  reviewer: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialGroupInclude;

const materialFileInclude = {
  file: true,
  uploader: {
    select: { id: true, name: true, username: true }
  },
  deleter: {
    select: { id: true, name: true, username: true }
  }
} satisfies Prisma.ApplicationMaterialFileInclude;

const selfServicePackageInclude = {
  product: { select: { id: true, name: true, productNo: true, status: true } },
  productVersion: { select: { id: true, productId: true, status: true, versionNo: true } }
} satisfies Prisma.VehiclePackageInclude;

const selfServiceVehiclePackageInclude = {
  ...selfServicePackageInclude,
  modelDefinition: { select: modelDefinitionSnapshotSelect }
} satisfies Prisma.VehiclePackageInclude;

const selfServiceSubscriptionPlanInclude = {
  benefitPackage: { include: selfServicePackageInclude },
  energyPackage: { include: selfServicePackageInclude },
  mileagePackage: { include: selfServicePackageInclude },
  product: {
    select: {
      deletedAt: true,
      id: true,
      name: true,
      productNo: true,
      productType: true,
      status: true
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
  vehiclePackage: { include: selfServiceVehiclePackageInclude }
} satisfies Prisma.SubscriptionPlanInclude;

const selfServiceVehicleInclude = {
  modelDefinition: { select: modelDefinitionSnapshotSelect }
} satisfies Prisma.VehicleInclude;

const applicationInclude = {
  customer: {
    select: {
      customerNo: true,
      id: true,
      identity: true,
      mobile: true,
      name: true,
      ownerUserId: true,
      profile: true,
      sourceChannel: true,
      status: true
    }
  },
  materials: {
    include: materialInclude,
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  materialGroups: {
    include: materialGroupInclude,
    orderBy: { materialType: "asc" as const },
    where: { deletedAt: null }
  },
  riskResults: {
    include: riskResultInclude,
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  orders: {
    orderBy: { createdAt: "desc" as const },
    select: { deletedAt: true, id: true, orderNo: true, orderStatus: true },
    where: { deletedAt: null }
  },
  salesUser: {
    select: { id: true, name: true, username: true }
  },
  actionLogs: {
    include: {
      material: {
        select: {
          id: true,
          materialName: true,
          materialType: true
        }
      },
      materialFile: {
        select: {
          fileName: true,
          id: true,
          materialType: true
        }
      },
      materialGroup: {
        select: {
          id: true,
          materialName: true,
          materialType: true
        }
      },
      operator: {
        select: { id: true, name: true, username: true }
      }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ApplicationInclude;

type CustomerWithDetails = Prisma.CustomerGetPayload<{ include: typeof customerInclude }>;
type ApplicationWithDetails = Prisma.ApplicationGetPayload<{ include: typeof applicationInclude }>;
type SelfServiceSubscriptionPlan = Prisma.SubscriptionPlanGetPayload<{
  include: typeof selfServiceSubscriptionPlanInclude;
}>;
type SelfServiceVehicle = Prisma.VehicleGetPayload<{
  include: typeof selfServiceVehicleInclude;
}>;
type VehicleRecord = Prisma.VehicleGetPayload<object>;
type Tx = Prisma.TransactionClient;
type ApplicationReviewType = "material" | "credit" | "product" | "vehicle";
type ApplicationFinalPlanInput = {
  periodMonths: number;
  subscriptionPlanId: string;
  vehicleId: string;
};
type ApplicationFinalPlanDetails = {
  benefitPackagePriceAmount: bigint;
  energyPackagePriceAmount: bigint;
  finalPlanSnapshot: Prisma.InputJsonValue;
  fixedRate: number | null;
  mileagePackagePriceAmount: bigint;
  monthlyFeeAmount: bigint;
  packageSnapshot: Prisma.InputJsonValue;
  periodMonths: number;
  plan: SelfServiceSubscriptionPlan;
  vehicle: SelfServiceVehicle;
  vehicleBaseFeeAmount: bigint;
  vehicleBaseFeeCapAmount: bigint;
  vehicleSalePriceAmount: bigint;
  vehicleSnapshot: Prisma.InputJsonValue;
};

const SELF_SERVICE_APPLICATION_DEPOSIT_NOTICE =
  "当前选择为意向订阅方案，押金金额将根据您的资质审核结果最终确认。";
const SELF_SERVICE_APPLICATION_SUCCESS_MESSAGE =
  "自助进件已提交，押金金额将在资质审核后确认。";
const SELF_SERVICE_APPLICATION_MATERIALS_HINT =
  "请继续上传身份证、驾驶证等资质材料。";
const SELF_SERVICE_MANUAL_QUOTE_MESSAGE =
  "该套餐需后台报价确认，暂不支持客户自助提交。";
const SELF_SERVICE_VEHICLE_UNAVAILABLE_MESSAGE =
  "所选车辆当前不可租用，请重新选择车辆";

export interface UploadedMaterialFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface MaterialPreview {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: Readable;
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly riskService: RiskService,
    private readonly storageService: StorageService,
    @Optional() private readonly notificationService?: NotificationService
  ) {}

  private async safeNotifyCustomer(input: {
    aggregateId: string;
    aggregateNo: string;
    aggregateType: string;
    content: string;
    customerId: string;
    eventType: NotificationEventType;
    notificationType: NotificationType;
    status: string;
    title: string;
    url: string;
  }) {
    if (!this.notificationService) return;
    try {
      await this.notificationService.notifyCustomer({
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        content: input.content,
        customerId: input.customerId,
        data: {
          aggregateNo: input.aggregateNo,
          status: input.status
        },
        eventType: input.eventType,
        notificationType: input.notificationType,
        title: input.title,
        url: input.url
      });
    } catch {
      // Notification delivery must not block the primary application workflow.
    }
  }

  async listCustomers(user: RequestUser) {
    const customers = await this.prisma.customer.findMany({
      include: customerInclude,
      orderBy: { createdAt: "desc" },
      where: this.customerScopeWhere(user)
    });

    return customers.map(toCustomerView);
  }

  async createCustomer(dto: CreateCustomerDto, user: RequestUser, context: RequestContext) {
    const hasFullScope = canViewAll(user);
    const ownerUserId = hasFullScope && dto.ownerUserId ? dto.ownerUserId : user.id;
    const customer = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          createdBy: user.id,
          customerNo: createBusinessNo("CUS"),
          customerType: dto.customerType,
          grade: hasFullScope ? dto.grade : undefined,
          mobile: dto.mobile,
          name: dto.name,
          ownerUserId,
          remark: dto.remark,
          sourceChannel: dto.sourceChannel,
          status: hasFullScope ? (dto.status ?? CustomerStatus.LEAD) : CustomerStatus.LEAD,
          updatedBy: user.id
        }
      });

      if (dto.identity) {
        await tx.customerIdentity.create({
          data: {
            ...identityData(dto.identity),
            createdBy: user.id,
            customerId: created.id,
            updatedBy: user.id
          }
        });
      }

      if (dto.profile) {
        await tx.customerProfile.create({
          data: {
            ...profileData(dto.profile),
            createdBy: user.id,
            customerId: created.id,
            updatedBy: user.id
          }
        });
      }

      return tx.customer.findUniqueOrThrow({
        include: customerInclude,
        where: { id: created.id }
      });
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toCustomerView(customer),
      entityId: customer.id,
      entityType: "customer",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCustomerView(customer);
  }

  async getCustomer(id: string, user: RequestUser) {
    const customer = await this.findCustomerOrThrow(id);
    ensureCanAccessCustomer(customer, user);
    return toCustomerView(customer);
  }

  async updateCustomer(
    id: string,
    dto: UpdateCustomerDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findCustomerOrThrow(id);
    ensureCanAccessCustomer(before, user);

    const hasFullScope = canViewAll(user);
    const ownerUserId = hasFullScope ? (dto.ownerUserId ?? before.ownerUserId) : before.ownerUserId;
    const customer = await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        data: {
          customerType: dto.customerType,
          grade: hasFullScope ? dto.grade : undefined,
          mobile: dto.mobile,
          name: dto.name,
          ownerUserId,
          remark: dto.remark,
          sourceChannel: dto.sourceChannel,
          status: hasFullScope ? dto.status : undefined,
          updatedBy: user.id
        },
        where: { id }
      });

      if (dto.identity) {
        await tx.customerIdentity.upsert({
          create: {
            ...identityData(dto.identity),
            createdBy: user.id,
            customerId: id,
            updatedBy: user.id
          },
          update: {
            ...identityData(dto.identity),
            updatedBy: user.id
          },
          where: { customerId: id }
        });
      }

      if (dto.profile) {
        await tx.customerProfile.upsert({
          create: {
            ...profileData(dto.profile),
            createdBy: user.id,
            customerId: id,
            updatedBy: user.id
          },
          update: {
            ...profileData(dto.profile),
            updatedBy: user.id
          },
          where: { customerId: id }
        });
      }

      return tx.customer.findUniqueOrThrow({
        include: customerInclude,
        where: { id }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toCustomerView(customer),
      before: toCustomerView(before),
      entityId: id,
      entityType: "customer",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toCustomerView(customer);
  }

  async listFollowups(customerId: string, user: RequestUser) {
    const customer = await this.findCustomerOrThrow(customerId);
    ensureCanAccessCustomer(customer, user);

    return this.prisma.customerFollowup.findMany({
      include: {
        followupUser: {
          select: { id: true, name: true, username: true }
        }
      },
      orderBy: { createdAt: "desc" },
      where: { customerId, deletedAt: null }
    });
  }

  async createFollowup(
    customerId: string,
    dto: CreateFollowupDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const customer = await this.findCustomerOrThrow(customerId);
    ensureCanAccessCustomer(customer, user);

    const followup = await this.prisma.customerFollowup.create({
      data: {
        content: dto.content,
        createdBy: user.id,
        customerId,
        followupType: dto.followupType,
        followupUserId: user.id,
        nextFollowupAt: dto.nextFollowupAt ? new Date(dto.nextFollowupAt) : undefined,
        updatedBy: user.id
      }
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: followup,
      entityId: followup.id,
      entityType: "customer_followup",
      ipAddress: context.ipAddress,
      module: "customer",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return followup;
  }

  async listApplications(user: RequestUser) {
    const applications = await this.prisma.application.findMany({
      include: applicationInclude,
      orderBy: { createdAt: "desc" },
      where: this.applicationScopeWhere(user)
    });

    return applications.map((application) => toApplicationView(application, user));
  }

  async listApplicationReviewQueue(user: RequestUser) {
    const applications = await this.prisma.application.findMany({
      include: applicationInclude,
      orderBy: { createdAt: "desc" },
      where: {
        ...this.applicationScopeWhere(user),
        applicationSource: ApplicationSource.SELF_SERVICE,
        orders: { none: { deletedAt: null } },
        status: { notIn: [ApplicationStatus.REJECTED, ApplicationStatus.CANCELLED] }
      }
    });

    return applications.map((application) => toApplicationView(application, user));
  }

  async reviewApplication(
    id: string,
    reviewType: ApplicationReviewType,
    dto: ReviewApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const decision = applicationReviewDecision(dto);
    const comment = applicationReviewComment(dto);
    assertApplicationReviewDecision(decision);
    const before = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    ensureApplicationReviewWorkflowAllowed(before);
    assertApplicationHasNoOrder(before);

    if (decision === OrderReviewStatus.REJECTED) {
      return this.rejectApplicationWithReviewType(id, dto, user, context, reviewType, before);
    }

    if (decision === OrderReviewStatus.NEED_MORE_INFO) {
      const application = await this.prisma.$transaction(async (tx) => {
        await tx.application.update({
          data: {
            [applicationReviewStatusField(reviewType)]: OrderReviewStatus.NEED_MORE_INFO,
            rejectedReason: comment,
            status: ApplicationStatus.NEED_MORE_INFO,
            updatedBy: user.id
          },
          where: { id }
        });

        await createApplicationActionLog(tx, {
          actionType: ApplicationActionType.NEED_MORE_INFO,
          applicationId: id,
          comment,
          fromStatus: before.status,
          operator: user,
          toStatus: ApplicationStatus.NEED_MORE_INFO
        });

        return tx.application.findUniqueOrThrow({
          include: applicationInclude,
          where: { id }
        });
      });

      await this.auditApplicationChange(AuditAction.UPDATE, before, application, user, context);
      return toApplicationView(application, user);
    }

    if (reviewType === "material") {
      const application = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.application.update({
          data: {
            materialReviewStatus: OrderReviewStatus.APPROVED,
            rejectedReason: null,
            status: ApplicationStatus.SUBMITTED,
            updatedBy: user.id
          },
          include: applicationInclude,
          where: { id }
        });

        await createApplicationActionLog(tx, {
          actionType: ApplicationActionType.REVIEW_MATERIAL,
          applicationId: id,
          comment,
          fromStatus: before.status,
          operator: user,
          toStatus: updated.status
        });

        return updated;
      });

      await this.auditApplicationChange(AuditAction.APPROVE, before, application, user, context);
      return toApplicationView(application, user);
    }

    if (reviewType === "credit") {
      const customerGrade = dto.customerGrade;
      if (!customerGrade) {
        throw new BadRequestException("客户资质审核通过时必须选择客户等级。");
      }

      const result = await this.prisma.$transaction(async (tx) => {
        const depositRule = await findActiveApplicationDepositRule(tx, customerGrade);
        if (!depositRule) {
          throw new BadRequestException(`No active deposit rule configured for grade ${customerGrade}.`);
        }

        const depositRuleSnapshot = toJsonSnapshot({
          customerGrade,
          defaultRate: Number(depositRule.defaultRate),
          depositAmount: Number(depositRule.depositAmount),
          depositRuleId: depositRule.id,
          grade: depositRule.grade,
          status: DepositStatus.CONFIRMED
        });
        const customerBefore = await tx.customer.findUnique({ where: { id: before.customerId } });
        const customerAfter = await tx.customer.update({
          data: {
            grade: customerGrade,
            status: CustomerStatus.APPROVED,
            updatedBy: user.id
          },
          where: { id: before.customerId }
        });
        const application = await tx.application.update({
          data: {
            creditReviewComment: comment,
            creditReviewStatus: OrderReviewStatus.APPROVED,
            customerGrade,
            depositRuleId: depositRule.id,
            depositRuleSnapshot,
            depositStatus: DepositStatus.CONFIRMED,
            finalDepositAmount: depositRule.depositAmount,
            rejectedReason: null,
            status: ApplicationStatus.SUBMITTED,
            updatedBy: user.id
          },
          include: applicationInclude,
          where: { id }
        });

        await createApplicationActionLog(tx, {
          actionType: ApplicationActionType.APPROVE,
          applicationId: id,
          comment,
          fromStatus: before.status,
          operator: user,
          toStatus: application.status
        });

        return { application, customerAfter, customerBefore };
      });

      if (result.customerBefore && result.customerAfter) {
        await this.auditService.write({
          action: AuditAction.UPDATE,
          after: toAuditSnapshot(result.customerAfter),
          before: toAuditSnapshot(result.customerBefore),
          entityId: result.customerAfter.id,
          entityType: "customer",
          ipAddress: context.ipAddress,
          module: "customer",
          operatorId: user.id,
          userAgent: context.userAgent
        });
      }
      await this.auditApplicationChange(AuditAction.APPROVE, before, result.application, user, context);
      return toApplicationView(result.application, user);
    }

    if (reviewType === "product") {
      const application = await this.prisma.$transaction(async (tx) => {
        const details = await loadApplicationFinalPlanDetails(tx, before, dto);
        const updated = await tx.application.update({
          data: {
            finalPeriodMonths: details.periodMonths,
            finalSubscriptionPlanId: details.plan.id,
            finalVehicleBaseFeeAmount: details.vehicleBaseFeeAmount,
            finalVehicleId: details.vehicle.id,
            productReviewStatus: OrderReviewStatus.APPROVED,
            rejectedReason: null,
            status: ApplicationStatus.SUBMITTED,
            updatedBy: user.id
          },
          include: applicationInclude,
          where: { id }
        });

        await createApplicationActionLog(tx, {
          actionType: ApplicationActionType.APPROVE,
          applicationId: id,
          comment,
          fromStatus: before.status,
          operator: user,
          toStatus: updated.status
        });

        return updated;
      });

      await this.auditApplicationChange(AuditAction.APPROVE, before, application, user, context);
      return toApplicationView(application, user);
    }

    if (reviewType === "vehicle") {
      const application = await this.prisma.$transaction(async (tx) => {
        const details = await loadApplicationFinalPlanDetails(tx, before, dto);
        await assertApplicationVehicleReviewAllowed(tx, before, details.vehicle);
        const updated = await tx.application.update({
          data: {
            finalVehicleId: details.vehicle.id,
            finalVehicleBaseFeeAmount:
              before.finalVehicleBaseFeeAmount ?? details.vehicleBaseFeeAmount,
            rejectedReason: null,
            status: ApplicationStatus.SUBMITTED,
            updatedBy: user.id,
            vehicleReviewStatus: OrderReviewStatus.APPROVED
          },
          include: applicationInclude,
          where: { id }
        });

        await createApplicationActionLog(tx, {
          actionType: ApplicationActionType.APPROVE,
          applicationId: id,
          comment,
          fromStatus: before.status,
          operator: user,
          toStatus: updated.status
        });

        return updated;
      });

      await this.auditApplicationChange(AuditAction.APPROVE, before, application, user, context);
      return toApplicationView(application, user);
    }

    throw new BadRequestException("Unsupported application review type.");
  }

  async finalizeApplicationPlan(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    ensureApplicationReviewWorkflowAllowed(before);
    assertApplicationHasNoOrder(before);
    assertApplicationReadyForFinalPlan(before);

    const result = await this.prisma.$transaction(async (tx) => {
      const details = await loadApplicationFinalPlanDetails(tx, before);
      await assertApplicationVehicleReviewAllowed(tx, before, details.vehicle);
      const finalPlanSnapshot = {
        ...(details.finalPlanSnapshot as Record<string, unknown>),
        finalPlanConfirmedAt: null,
        planConfirmStatus: PlanConfirmStatus.PENDING
      } satisfies Prisma.InputJsonValue;
      const now = new Date();
      const application = await tx.application.update({
        data: {
          approvedAt: before.approvedAt ?? now,
          finalPeriodMonths: details.periodMonths,
          finalPlanConfirmedAt: null,
          finalPlanSnapshot,
          finalQuoteSnapshot: finalPlanSnapshot,
          finalSubscriptionPlanId: details.plan.id,
          finalVehicleBaseFeeAmount: details.vehicleBaseFeeAmount,
          finalVehicleId: details.vehicle.id,
          planConfirmStatus: PlanConfirmStatus.PENDING,
          productReviewStatus: OrderReviewStatus.APPROVED,
          rejectedReason: null,
          status: ApplicationStatus.APPROVED,
          updatedBy: user.id,
          vehicleReviewStatus: OrderReviewStatus.APPROVED
        },
        include: applicationInclude,
        where: { id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.APPROVE,
        applicationId: id,
        comment: "生成最终方案，待客户确认",
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.APPROVED
      });

      return { application, details };
    });

    await this.auditApplicationChange(AuditAction.APPROVE, before, result.application, user, context);
    await this.safeNotifyCustomer({
      aggregateId: result.application.id,
      aggregateNo: result.application.applicationNo,
      aggregateType: "application",
      content: "平台已生成最终方案，请登录客户门户确认。",
      customerId: result.application.customerId,
      eventType: NotificationEventType.FINAL_PLAN_READY,
      notificationType: NotificationType.FINAL_PLAN_PENDING,
      status: result.application.planConfirmStatus,
      title: "最终方案待确认",
      url: `/portal/applications/${result.application.id}`
    });
    return toApplicationView(result.application, user);
  }

  async createOrderFromApplication(id: string, user: RequestUser, context: RequestContext) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    assertApplicationCanCreateOrder(before);
    const finalDepositAmount = before.finalDepositAmount;
    if (finalDepositAmount === null) {
      throw new BadRequestException("押金确认后才可以生成订单。");
    }

    const result = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const details = await loadApplicationFinalPlanDetails(tx, before);
      const vehicleBefore = await tx.vehicle.findUnique({ where: { id: details.vehicle.id } });
      assertApplicationVehicleCanEnterOrder(before, vehicleBefore);

      const vehicleUpdate = await tx.vehicle.updateMany({
        data: { status: VehicleStatus.RESERVED, updatedBy: user.id },
        where: {
          deletedAt: null,
          id: details.vehicle.id,
          status:
            before.applicationSource === ApplicationSource.SELF_SERVICE
              ? VehicleStatus.REVIEW_RESERVED
              : VehicleStatus.AVAILABLE
        }
      });
      if (vehicleUpdate.count !== 1) {
        throw new BadRequestException("车辆当前状态不允许生成订单。");
      }
      const vehicleAfter = await tx.vehicle.findUniqueOrThrow({ where: { id: details.vehicle.id } });

      const finalPlanSnapshot = (before.finalPlanSnapshot ?? details.finalPlanSnapshot) as Prisma.InputJsonValue;
      const modelSnapshot = buildVehicleModelSnapshot(
        toCanonicalModelIdentity(details.vehicle)
      );
      const quote = await tx.subscriptionQuote.create({
        data: {
          applicationId: before.id,
          benefitPackageId: details.plan.benefitPackage?.id ?? null,
          benefitPackagePriceAmount: details.benefitPackagePriceAmount,
          confirmedAt: new Date(),
          confirmedBy: user.id,
          createdBy: user.id,
          customerId: before.customerId,
          customerSelectedSnapshot: before.customerSelectedSnapshot as Prisma.InputJsonValue | undefined,
          depositAmount: finalDepositAmount,
          depositRuleSnapshot: before.depositRuleSnapshot as Prisma.InputJsonValue | undefined,
          energyLimitCount: details.plan.energyPackage.monthlyEnergyCount,
          energyLimitKwh: details.plan.energyPackage.monthlyEnergyKwh,
          energyPackageId: details.plan.energyPackage.id,
          energyPackagePriceAmount: details.energyPackagePriceAmount,
          mileageLimitKm: details.plan.mileagePackage.monthlyMileageKm,
          mileagePackageId: details.plan.mileagePackage.id,
          mileagePackagePriceAmount: details.mileagePackagePriceAmount,
          monthlyFeeAmount: details.monthlyFeeAmount,
          monthlyFeeCapAmount: details.vehicleBaseFeeCapAmount,
          monthlyFeeRate: details.plan.monthlyFeeRate,
          ...modelSnapshot,
          overMileageFeeAmount: details.plan.mileagePackage.overMileageFeeAmount,
          packageSnapshot: details.packageSnapshot,
          periodMonths: details.periodMonths,
          productId: details.plan.productId,
          productVersionId: details.plan.productVersionId,
          quoteNo: createBusinessNo("QUO"),
          riskResultId: null,
          status: QuoteStatus.CONFIRMED,
          subscriptionPlanId: details.plan.id,
          updatedBy: user.id,
          vehicleBaseFeeAmount: details.vehicleBaseFeeAmount,
          vehicleBaseFeeCapAmount: details.vehicleBaseFeeCapAmount,
          vehicleId: details.vehicle.id,
          vehiclePackageId: details.plan.vehiclePackage.id,
          vehiclePurchasePriceAmount: details.vehicle.purchasePriceAmount,
          vehicleSalePriceAmount: details.vehicleSalePriceAmount,
          vehicleSnapshot: details.vehicleSnapshot
        }
      });

      const confirmedAt = before.finalPlanConfirmedAt ?? new Date();
      const order = await tx.subscriptionOrder.create({
        data: {
          applicationId: before.id,
          businessType: BusinessType.SUBSCRIPTION,
          createdBy: user.id,
          creditReviewStatus: OrderReviewStatus.APPROVED,
          customerConfirmedAt: confirmedAt,
          customerId: before.customerId,
          customerSelectedSnapshot: before.customerSelectedSnapshot as Prisma.InputJsonValue | undefined,
          depositAmount: finalDepositAmount,
          depositStatus: DepositStatus.CONFIRMED,
          energyLimitCount: details.plan.energyPackage.monthlyEnergyCount,
          energyLimitKwh: details.plan.energyPackage.monthlyEnergyKwh,
          finalDepositAmount,
          finalPlanConfirmedAt: confirmedAt,
          finalPlanSnapshot,
          mileageLimitKm: details.plan.mileagePackage.monthlyMileageKm,
          monthlyFeeAmount: details.monthlyFeeAmount,
          ...modelSnapshot,
          orderNo: createBusinessNo("ORD"),
          orderSource: mapApplicationSourceToOrderSource(before.applicationSource),
          orderStatus: OrderStatus.PENDING_CONTRACT,
          overMileageFeeAmount: details.plan.mileagePackage.overMileageFeeAmount,
          periodMonths: details.periodMonths,
          productId: details.plan.productId,
          productReviewStatus: OrderReviewStatus.APPROVED,
          productVersionId: details.plan.productVersionId,
          quoteId: quote.id,
          quoteSnapshot: finalPlanSnapshot,
          riskResultId: null,
          updatedBy: user.id,
          vehicleId: details.vehicle.id,
          vehiclePurchasePriceAmount: details.vehicle.purchasePriceAmount,
          vehicleReviewStatus: OrderReviewStatus.APPROVED
        }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.APPROVE,
        applicationId: id,
        comment: "生成正式订单",
        fromStatus: before.status,
        operator: user,
        toStatus: before.status
      });

      return { order, quote, vehicleAfter, vehicleBefore };
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toAuditSnapshot(result.quote),
      entityId: result.quote.id,
      entityType: "subscription_quote",
      ipAddress: context.ipAddress,
      module: "quote",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toAuditSnapshot(result.order),
      entityId: result.order.id,
      entityType: "subscription_order",
      ipAddress: context.ipAddress,
      module: "order",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    if (result.vehicleBefore) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toAuditSnapshot(result.vehicleAfter),
        before: toAuditSnapshot(result.vehicleBefore),
        entityId: result.vehicleAfter.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }

    return {
      applicationId: before.id,
      orderId: result.order.id,
      orderNo: result.order.orderNo,
      orderStatus: result.order.orderStatus,
      quoteId: result.quote.id,
      quoteNo: result.quote.quoteNo,
      vehicleStatus: result.vehicleAfter.status
    };
  }

  async createApplication(dto: CreateApplicationDto, user: RequestUser, context: RequestContext) {
    const customer = await this.findCustomerOrThrow(dto.customerId);
    ensureCanAccessCustomer(customer, user);
    const identityInput = dto.customerIdentity
      ? assertValidCustomerApplicationIdentityInput(dto.customerIdentity)
      : null;
    if (!identityInput) {
      assertCustomerIdentityProfileReady(customer);
    }

    const application = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      if (identityInput) {
        await tx.customer.update({
          data: {
            mobile: identityInput.mobile,
            name: identityInput.name,
            updatedBy: user.id
          },
          where: { id: customer.id }
        });
        await tx.customerIdentity.upsert({
          create: {
            createdBy: user.id,
            customerId: customer.id,
            idCardNo: identityInput.idCardNo,
            updatedBy: user.id
          },
          update: {
            idCardNo: identityInput.idCardNo,
            updatedBy: user.id
          },
          where: { customerId: customer.id }
        });
      }

      const created = await tx.application.create({
        data: {
          applicationNo: createBusinessNo("APP"),
          createdBy: user.id,
          customerId: dto.customerId,
          intendedModel: dto.intendedModel,
          intendedPeriodMonths: dto.intendedPeriodMonths,
          salesUserId: customer.ownerUserId ?? user.id,
          updatedBy: user.id
        }
      });

      await tx.customer.update({
        data: {
          status:
            customer.status === CustomerStatus.LEAD
              ? CustomerStatus.PENDING_APPLICATION
              : customer.status,
          updatedBy: user.id
        },
        where: { id: customer.id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.CREATE,
        applicationId: created.id,
        operator: user,
        toStatus: ApplicationStatus.DRAFT
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id: created.id }
      });
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toApplicationView(application),
      entityId: application.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toApplicationView(application);
  }

  async createSelfServiceApplication(
    dto: CreateSelfServiceApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const [customer, selection] = await Promise.all([
      this.prisma.customer.findUnique({
        include: { identity: true },
        where: { id: dto.customerId }
      }),
      this.validateSelfServiceApplicationSelection(dto)
    ]);

    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }
    assertCustomerIdentityProfileReady(customer);
    const { plan, vehicle } = selection;
    assertSelfServiceVehicleAvailable(vehicle);
    assertSelfServiceSubscriptionPlanAvailable(plan);

    if (vehicle.modelDefinitionId !== plan.vehiclePackage.modelDefinitionId) {
      throw new BadRequestException("所选套餐不适用于该车辆车型");
    }
    assertSelfServicePeriodInRange(dto.periodMonths, plan.minPeriodMonths, plan.maxPeriodMonths);

    const vehicleSalePriceAmount = requireSelfServiceCurrentSalePriceAmount(
      vehicle.currentSalePriceAmount
    );
    const vehicleBaseFeePricing = calculateSelfServiceVehicleBaseFee(
      plan,
      vehicleSalePriceAmount
    );
    const mileagePackagePriceAmount = plan.mileagePackage.priceAmount;
    const energyPackagePriceAmount = plan.energyPackage.priceAmount;
    const benefitPackagePriceAmount = plan.benefitPackage?.priceAmount ?? 0n;
    const monthlyFeeAmount =
      vehicleBaseFeePricing.vehicleBaseFeeAmount +
      mileagePackagePriceAmount +
      energyPackagePriceAmount +
      benefitPackagePriceAmount;
    const now = new Date();
    const softReservationExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const vehicleSnapshot = toJsonSnapshot({
      assetLocation: vehicle.assetLocation,
      batteryCapacityKwh: vehicle.batteryCapacityKwh?.toNumber() ?? null,
      batteryUsageType: vehicle.batteryUsageType,
      batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
      brand: vehicle.brand,
      currentMileageKm: vehicle.currentMileageKm,
      currentSalePriceAmount: Number(vehicleSalePriceAmount),
      model: vehicle.model,
      modelYear: vehicle.modelYear,
      ...buildVehicleModelSnapshot(toCanonicalModelIdentity(vehicle)),
      plateNo: vehicle.plateNo,
      series: vehicle.series,
      status: vehicle.status,
      vehicleNo: vehicle.vehicleNo,
      vin: vehicle.vin
    });
    const packageSnapshot = toJsonSnapshot({
      benefitPackage: plan.benefitPackage ? toSelfServicePackageSnapshot(plan.benefitPackage) : null,
      energyPackage: toSelfServicePackageSnapshot(plan.energyPackage),
      mileagePackage: toSelfServicePackageSnapshot(plan.mileagePackage),
      pricing: {
        benefitPackagePriceAmount: Number(benefitPackagePriceAmount),
        currentSalePriceAmount: Number(vehicleSalePriceAmount),
        energyPackagePriceAmount: Number(energyPackagePriceAmount),
        fixedRate: vehicleBaseFeePricing.fixedRate,
        mileagePackagePriceAmount: Number(mileagePackagePriceAmount),
        monthlyFeeAmount: Number(monthlyFeeAmount),
        vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
        vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
        vehicleBaseFeeMode: plan.monthlyFeeMode,
        vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel
      },
      subscriptionPlan: toSelfServiceSubscriptionPlanSnapshot(plan),
      vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
      vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
      vehicleBaseFeeMode: plan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel,
      vehiclePackage: toSelfServicePackageSnapshot(plan.vehiclePackage)
    });
    const intentSnapshot = toJsonSnapshot({
      customerId: customer.id,
      customerName: customer.name,
      depositDescription: SELF_SERVICE_APPLICATION_DEPOSIT_NOTICE,
      depositStatus: DepositStatus.PENDING_CONFIRM,
      packageSnapshot,
      periodMonths: dto.periodMonths,
      selectedAt: now.toISOString(),
      subscriptionPlanId: plan.id,
      vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
      vehicleId: vehicle.id,
      vehicleSnapshot
    });
    const customerSelectedSnapshot = intentSnapshot;

    const result = await withUniqueBusinessNoRetry(() => this.prisma.$transaction(async (tx) => {
      const vehicleBefore = await tx.vehicle.findUnique({ where: { id: dto.vehicleId } });
      assertSelfServiceVehicleAvailable(vehicleBefore);

      const application = await tx.application.create({
        data: {
          applicationNo: createBusinessNo("APP"),
          applicationSource: ApplicationSource.SELF_SERVICE,
          createdBy: user.id,
          creditReviewStatus: OrderReviewStatus.PENDING,
          customerId: customer.id,
          customerSelectedSnapshot,
          depositStatus: DepositStatus.PENDING_CONFIRM,
          finalDepositAmount: null,
          intentPeriodMonths: dto.periodMonths,
          intentSnapshot,
          intentSubscriptionPlanId: plan.id,
          intentVehicleBaseFeeAmount: vehicleBaseFeePricing.vehicleBaseFeeAmount,
          intentVehicleId: vehicle.id,
          intendedModel: vehicle.modelDefinition.displayName,
          intendedPeriodMonths: dto.periodMonths,
          materialReviewStatus: OrderReviewStatus.PENDING,
          planConfirmStatus: PlanConfirmStatus.PENDING,
          productReviewStatus: OrderReviewStatus.PENDING,
          salesUserId: customer.ownerUserId ?? user.id,
          softReservationExpiresAt,
          softReservedAt: now,
          softReservedVehicleId: vehicle.id,
          status: ApplicationStatus.SUBMITTED,
          submittedAt: now,
          updatedBy: user.id,
          vehicleReviewStatus: OrderReviewStatus.PENDING
        },
        include: applicationInclude
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.CREATE,
        applicationId: application.id,
        comment: "客户自助进件提交",
        operator: user,
        toStatus: ApplicationStatus.SUBMITTED
      });

      if (customer.status === CustomerStatus.LEAD) {
        await tx.customer.update({
          data: {
            status: CustomerStatus.PENDING_APPLICATION,
            updatedBy: user.id
          },
          where: { id: customer.id }
        });
      }

      const vehicleUpdate = await tx.vehicle.updateMany({
        data: { status: VehicleStatus.REVIEW_RESERVED, updatedBy: user.id },
        where: {
          deletedAt: null,
          id: vehicle.id,
          status: VehicleStatus.AVAILABLE
        }
      });

      if (vehicleUpdate.count !== 1) {
        throw new BadRequestException(SELF_SERVICE_VEHICLE_UNAVAILABLE_MESSAGE);
      }

      const vehicleAfter = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });

      return { application, vehicleAfter, vehicleBefore };
    }));

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toAuditSnapshot(result.application),
      entityId: result.application.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toAuditSnapshot(result.vehicleAfter),
      before: toAuditSnapshot(result.vehicleBefore),
      entityId: result.vehicleAfter.id,
      entityType: "vehicle",
      ipAddress: context.ipAddress,
      module: "vehicle",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    await this.safeNotifyCustomer({
      aggregateId: result.application.id,
      aggregateNo: result.application.applicationNo,
      aggregateType: "application",
      content: "您的订阅申请已提交，平台将尽快完成审核。",
      customerId: result.application.customerId,
      eventType: NotificationEventType.APPLICATION_SUBMITTED,
      notificationType: NotificationType.APPLICATION_PROGRESS,
      status: result.application.status,
      title: "申请已提交",
      url: `/portal/applications/${result.application.id}`
    });

    return {
      applicationId: result.application.id,
      applicationNo: result.application.applicationNo,
      applicationSource: result.application.applicationSource,
      depositStatus: result.application.depositStatus,
      materialsUploadHint: SELF_SERVICE_APPLICATION_MATERIALS_HINT,
      message: SELF_SERVICE_APPLICATION_SUCCESS_MESSAGE,
      status: result.application.status,
      vehicleStatus: result.vehicleAfter.status
    };
  }

  async validateSelfServiceApplicationSelection(
    dto: Pick<CreateSelfServiceApplicationDto, "subscriptionPlanId" | "vehicleId"> &
      Partial<Pick<CreateSelfServiceApplicationDto, "periodMonths">>
  ) {
    const [vehicle, plan] = await Promise.all([
      this.prisma.vehicle.findUnique({
        include: selfServiceVehicleInclude,
        where: { id: dto.vehicleId }
      }),
      this.prisma.subscriptionPlan.findUnique({
        include: selfServiceSubscriptionPlanInclude,
        where: { id: dto.subscriptionPlanId }
      })
    ]);

    assertSelfServiceVehicleAvailable(vehicle);
    assertSelfServiceSubscriptionPlanAvailable(plan);

    if (vehicle.modelDefinitionId !== plan.vehiclePackage.modelDefinitionId) {
      throw new BadRequestException("所选套餐不适用于该车辆车型");
    }
    if (dto.periodMonths !== undefined) {
      assertSelfServicePeriodInRange(dto.periodMonths, plan.minPeriodMonths, plan.maxPeriodMonths);
    }

    return { plan, vehicle };
  }

  async getApplication(id: string, user: RequestUser) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    return toApplicationView(application, user);
  }

  async updateApplication(
    id: string,
    dto: UpdateApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(before, user);

    if (!canEditApplication(before.status)) {
      throw new BadRequestException("Only draft or need-more-info applications can be updated.");
    }

    const application = await this.prisma.application.update({
      data: {
        intendedModel: dto.intendedModel,
        intendedPeriodMonths: dto.intendedPeriodMonths,
        updatedBy: user.id
      },
      include: applicationInclude,
      where: { id }
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toApplicationView(application),
      before: toApplicationView(before),
      entityId: id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toApplicationView(application);
  }

  async submitApplication(
    id: string,
    dto: SubmitApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(before, user);

    if (!canEditApplication(before.status)) {
      throw new BadRequestException("Only draft or need-more-info applications can be submitted.");
    }
    assertCustomerIdentityProfileReady(before.customer);
    assertCanSubmitApplication(before);

    const application = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          status: ApplicationStatus.SUBMITTED,
          submittedAt: new Date(),
          updatedBy: user.id
        },
        where: { id }
      });

      await tx.customer.update({
        data: { status: CustomerStatus.UNDER_REVIEW, updatedBy: user.id },
        where: { id: before.customerId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.SUBMIT,
        applicationId: id,
        comment: normalizeOptionalText(dto.comment),
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.SUBMITTED
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });
    });

    await this.auditApplicationChange(AuditAction.UPDATE, before, application, user, context);
    return toApplicationView(application);
  }

  async uploadMaterial(
    id: string,
    dto: CreateMaterialDto,
    files: UploadedMaterialFile[] | undefined,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanManageApplication(application, user);

    if (!canUploadMaterialForApplication(application, user)) {
      throw new BadRequestException("Materials can only be uploaded before review is finalized.");
    }

    const uploadFiles = (files ?? []).filter((file) => file.buffer?.length);

    if (uploadFiles.length === 0) {
      throw new BadRequestException("Material file is required.");
    }

    const storedFiles = await Promise.all(
      uploadFiles.map(async (file) => ({
        file,
        storage: await this.storageService.putApplicationMaterial({
          applicationId: id,
          buffer: file.buffer,
          contentType: file.mimetype,
          originalName: file.originalname
        })
      }))
    );

    const group = await this.prisma.$transaction(async (tx) => {
      const materialGroup = await upsertMaterialGroup(tx, {
        applicationId: id,
        materialType: dto.materialType,
        user
      });

      const materialFiles = [];

      for (const { file, storage } of storedFiles) {
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: storage.bucket,
            objectKey: storage.objectKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: BigInt(file.size),
            uploadedBy: user.id
          }
        });

        const materialFile = await tx.applicationMaterialFile.create({
          data: {
            applicationId: id,
            createdBy: user.id,
            fileId: fileObject.id,
            fileName: file.originalname,
            materialGroupId: materialGroup.id,
            materialType: dto.materialType,
            mimeType: file.mimetype,
            sizeBytes: BigInt(file.size),
            updatedBy: user.id,
            uploadedBy: user.id
          },
          include: materialFileInclude
        });

        materialFiles.push(materialFile);
      }

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.UPLOAD_MATERIAL_FILE,
        applicationId: id,
        comment: buildMaterialFileActionComment(
          "上传资料文件",
          dto.materialType,
          materialFiles.map((file) => file.fileName),
          normalizeOptionalText(dto.reviewRemark)
        ),
        materialFileId: materialFiles[0]?.id,
        materialGroupId: materialGroup.id,
        operator: user,
        toStatus: application.status
      });

      return tx.applicationMaterialGroup.findUniqueOrThrow({
        include: materialGroupInclude,
        where: { id: materialGroup.id }
      });
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: toMaterialGroupView(group, application, user),
      entityId: group.id,
      entityType: "application_material_group",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialGroupView(group, application, user);
  }

  async previewMaterial(
    id: string,
    materialId: string,
    user: RequestUser
  ): Promise<MaterialPreview> {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);

    const material = await this.prisma.applicationMaterial.findFirst({
      include: { file: true },
      where: { applicationId: id, deletedAt: null, id: materialId }
    });

    if (!material) {
      throw new NotFoundException("Application material not found.");
    }

    const storedObject = await this.storageService.getObject(
      material.file.bucket,
      material.file.objectKey
    );

    return {
      filename: material.file.originalName,
      mimeType: material.file.mimeType ?? storedObject.contentType,
      sizeBytes: storedObject.contentLength ?? Number(material.file.sizeBytes),
      stream: storedObject.stream
    };
  }

  async previewMaterialFile(
    id: string,
    fileRecordId: string,
    user: RequestUser
  ): Promise<MaterialPreview> {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);

    const materialFile = await this.prisma.applicationMaterialFile.findFirst({
      include: { file: true },
      where: { applicationId: id, id: fileRecordId }
    });

    if (!materialFile || materialFile.isDeleted) {
      throw new NotFoundException("Application material file not found.");
    }

    const storedObject = await this.storageService.getObject(
      materialFile.file.bucket,
      materialFile.file.objectKey
    );

    return {
      filename: materialFile.fileName,
      mimeType: materialFile.mimeType ?? storedObject.contentType,
      sizeBytes: storedObject.contentLength ?? Number(materialFile.sizeBytes),
      stream: storedObject.stream
    };
  }

  async reviewMaterial(
    id: string,
    materialId: string,
    dto: ReviewMaterialDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    assertReviewMaterialInput(dto.status, dto.comment);

    const before = await this.prisma.applicationMaterial.findFirst({
      include: materialInclude,
      where: { applicationId: id, deletedAt: null, id: materialId }
    });

    if (!before) {
      throw new NotFoundException("Application material not found.");
    }

    const reviewedAt = new Date();
    const comment = normalizeOptionalText(dto.comment);
    const material = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterial.update({
        data: {
          reviewComment: comment,
          reviewRemark: comment,
          reviewedAt,
          reviewedBy: user.id,
          status: dto.status,
          updatedBy: user.id
        },
        include: materialInclude,
        where: { id: materialId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REVIEW_MATERIAL,
        applicationId: id,
        comment,
        fromStatus: application.status,
        materialId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toMaterialView(material),
      before: toMaterialView(before),
      entityId: material.id,
      entityType: "application_material",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialView(material);
  }

  async reviewMaterialGroup(
    id: string,
    materialGroupId: string,
    dto: ReviewMaterialDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    assertCanReviewMaterialGroup(application, user);
    assertReviewMaterialInput(dto.status, dto.comment);

    const before = await this.prisma.applicationMaterialGroup.findFirst({
      include: materialGroupInclude,
      where: { applicationId: id, deletedAt: null, id: materialGroupId }
    });

    if (!before) {
      throw new NotFoundException("Application material group not found.");
    }

    assertCanReviewMaterialGroupStatus(before, dto.status);

    const reviewedAt = new Date();
    const comment = normalizeOptionalText(dto.comment);
    const group = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterialGroup.update({
        data: {
          reviewComment: comment,
          reviewedAt,
          reviewedBy: user.id,
          reviewStatus: dto.status,
          updatedBy: user.id
        },
        include: materialGroupInclude,
        where: { id: materialGroupId }
      });
      const materialGroups = await tx.applicationMaterialGroup.findMany({
        include: { files: true },
        where: { applicationId: id, deletedAt: null }
      });
      await tx.application.update({
        data: {
          materialReviewStatus: deriveApplicationMaterialReviewStatus(materialGroups),
          updatedBy: user.id
        },
        where: { id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REVIEW_MATERIAL_GROUP,
        applicationId: id,
        comment,
        fromStatus: application.status,
        materialGroupId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toMaterialGroupView(group, application, user),
      before: toMaterialGroupView(before, application, user),
      entityId: group.id,
      entityType: "application_material_group",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialGroupView(group, application, user);
  }

  async deleteMaterialFile(
    id: string,
    fileRecordId: string,
    dto: DeleteMaterialFileDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const application = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(application, user);
    const reason = assertDeleteMaterialFileInput(dto.reason);

    const before = await this.prisma.applicationMaterialFile.findFirst({
      include: materialFileInclude,
      where: { applicationId: id, id: fileRecordId }
    });

    if (!before || before.isDeleted) {
      throw new NotFoundException("Application material file not found.");
    }

    if (!canDeleteMaterialFile(application, user)) {
      throw new ForbiddenException("You do not have permission to delete this material file.");
    }

    const deletedAt = new Date();
    const materialFile = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.applicationMaterialFile.update({
        data: {
          deletedAt,
          deletedBy: user.id,
          deleteReason: reason,
          isDeleted: true,
          updatedBy: user.id
        },
        include: materialFileInclude,
        where: { id: fileRecordId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.DELETE_MATERIAL_FILE,
        applicationId: id,
        comment: buildMaterialFileActionComment(
          "删除资料文件",
          before.materialType,
          [before.fileName],
          reason
        ),
        fromStatus: application.status,
        materialFileId: fileRecordId,
        materialGroupId: before.materialGroupId,
        operator: user,
        toStatus: application.status
      });

      return updated;
    });

    await this.auditService.write({
      action: AuditAction.DELETE,
      after: toMaterialFileView(materialFile, application, user),
      before: toMaterialFileView(before, application, user),
      entityId: materialFile.id,
      entityType: "application_material_file",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toMaterialFileView(materialFile, application, user);
  }

  async needMoreInfo(id: string, dto: NeedMoreInfoDto, user: RequestUser, context: RequestContext) {
    const before = await this.findApplicationOrThrow(id);
    ensureReviewable(before);
    const comment = normalizeRequiredText(dto.comment ?? dto.reason, "comment");

    const application = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          ...(before.applicationSource === ApplicationSource.SELF_SERVICE
            ? { materialReviewStatus: OrderReviewStatus.NEED_MORE_INFO }
            : {}),
          rejectedReason: comment,
          status: ApplicationStatus.NEED_MORE_INFO,
          updatedBy: user.id
        },
        where: { id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.NEED_MORE_INFO,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.NEED_MORE_INFO
      });

      return tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });
    });

    await this.auditApplicationChange(AuditAction.UPDATE, before, application, user, context);
    return toApplicationView(application);
  }

  async approveApplication(
    id: string,
    dto: ApproveApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureReviewable(before);
    assertCanApproveApplication(before);
    const approvedAt = new Date();
    const comment = normalizeOptionalText(dto.comment ?? dto.remark);

    const { application, riskResult } = await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        data: {
          approvedAt,
          rejectedReason: null,
          status: ApplicationStatus.APPROVED,
          updatedBy: user.id
        },
        where: { id }
      });

      await tx.customer.update({
        data: {
          grade: dto.grade,
          riskScore: dto.riskScore,
          status: CustomerStatus.APPROVED,
          updatedBy: user.id
        },
        where: { id: before.customerId }
      });

      const riskResult = await this.riskService.createApprovalRiskResult(tx, {
        applicationId: id,
        approvedAt,
        customerId: before.customerId,
        grade: dto.grade,
        maxVehiclePurchasePriceAmount: dto.maxVehiclePurchasePriceAmount,
        operatorId: user.id,
        remark: comment,
        riskScore: dto.riskScore
      });

      if (before.applicationSource === ApplicationSource.SELF_SERVICE) {
        await tx.application.update({
          data: {
            creditReviewComment: comment,
            creditReviewStatus: OrderReviewStatus.APPROVED,
            customerGrade: dto.grade,
            depositRuleSnapshot: toJsonSnapshot({
              approvedAt: riskResult.approvedAt?.toISOString() ?? approvedAt.toISOString(),
              defaultRate: Number(riskResult.defaultRate),
              depositAmount: Number(riskResult.approvedDepositAmount),
              grade: riskResult.grade,
              maxVehiclePurchasePriceAmount:
                riskResult.maxVehiclePurchasePriceAmount === null
                  ? null
                  : Number(riskResult.maxVehiclePurchasePriceAmount),
              riskResultId: riskResult.id,
              riskScore: riskResult.score,
              status: DepositStatus.CONFIRMED
            }),
            depositStatus: DepositStatus.CONFIRMED,
            finalDepositAmount: riskResult.approvedDepositAmount,
            updatedBy: user.id
          },
          where: { id }
        });
      }

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.APPROVE,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.APPROVED
      });

      const application = await tx.application.findUniqueOrThrow({
        include: applicationInclude,
        where: { id }
      });

      return { application, riskResult };
    });

    await this.auditApplicationChange(AuditAction.APPROVE, before, application, user, context);
    await this.auditService.write({
      action: AuditAction.APPROVE,
      after: toRiskResultView(riskResult),
      entityId: riskResult.id,
      entityType: "risk_result",
      ipAddress: context.ipAddress,
      module: "risk",
      operatorId: user.id,
      userAgent: context.userAgent
    });
    return toApplicationView(application);
  }

  async rejectApplication(
    id: string,
    dto: RejectApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    ensureApplicationReviewWorkflowAllowed(before);
    return this.rejectApplicationWithReviewType(id, dto, user, context, undefined, before);
  }

  async cancelApplication(
    id: string,
    dto: RejectApplicationDto,
    user: RequestUser,
    context: RequestContext
  ) {
    const before = await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    assertApplicationHasNoOrder(before);
    if (before.status === ApplicationStatus.CANCELLED || before.status === ApplicationStatus.REJECTED) {
      throw new BadRequestException("当前进件状态不允许取消。");
    }
    const comment = normalizeRequiredText(dto.comment ?? dto.reason, "comment");

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicleRelease = await releaseApplicationSoftReservedVehicle(tx, before, user);
      const application = await tx.application.update({
        data: {
          rejectedReason: comment,
          status: ApplicationStatus.CANCELLED,
          updatedBy: user.id
        },
        include: applicationInclude,
        where: { id }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REJECT,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.CANCELLED
      });

      return { application, vehicleRelease };
    });

    await this.auditApplicationChange(AuditAction.UPDATE, before, result.application, user, context);
    if (result.vehicleRelease) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toAuditSnapshot(result.vehicleRelease.after),
        before: toAuditSnapshot(result.vehicleRelease.before),
        entityId: result.vehicleRelease.after.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return toApplicationView(result.application, user);
  }

  private async rejectApplicationWithReviewType(
    id: string,
    dto: Partial<ReviewApplicationDto & RejectApplicationDto>,
    user: RequestUser,
    context: RequestContext,
    reviewType?: ApplicationReviewType,
    beforeApplication?: ApplicationWithDetails
  ) {
    const before = beforeApplication ?? await this.findApplicationOrThrow(id);
    ensureCanAccessApplication(before, user);
    ensureApplicationReviewWorkflowAllowed(before);
    assertApplicationHasNoOrder(before);
    const comment = normalizeRequiredText(dto.comment ?? dto.reason ?? dto.remark, "comment");

    const result = await this.prisma.$transaction(async (tx) => {
      const vehicleRelease = await releaseApplicationSoftReservedVehicle(tx, before, user);
      const data: Prisma.ApplicationUpdateInput = {
        rejectedReason: comment,
        status: ApplicationStatus.REJECTED,
        updatedBy: user.id
      };
      if (reviewType) {
        data[applicationReviewStatusField(reviewType)] = OrderReviewStatus.REJECTED;
      }

      const application = await tx.application.update({
        data,
        include: applicationInclude,
        where: { id }
      });

      await tx.customer.update({
        data: { status: CustomerStatus.REJECTED, updatedBy: user.id },
        where: { id: before.customerId }
      });

      await createApplicationActionLog(tx, {
        actionType: ApplicationActionType.REJECT,
        applicationId: id,
        comment,
        fromStatus: before.status,
        operator: user,
        toStatus: ApplicationStatus.REJECTED
      });

      return { application, vehicleRelease };
    });

    await this.auditApplicationChange(AuditAction.REJECT, before, result.application, user, context);
    if (result.vehicleRelease) {
      await this.auditService.write({
        action: AuditAction.UPDATE,
        after: toAuditSnapshot(result.vehicleRelease.after),
        before: toAuditSnapshot(result.vehicleRelease.before),
        entityId: result.vehicleRelease.after.id,
        entityType: "vehicle",
        ipAddress: context.ipAddress,
        module: "vehicle",
        operatorId: user.id,
        userAgent: context.userAgent
      });
    }
    return toApplicationView(result.application, user);
  }

  private customerScopeWhere(user: RequestUser): Prisma.CustomerWhereInput {
    return {
      deletedAt: null,
      ...(canViewAll(user) ? {} : { ownerUserId: user.id })
    };
  }

  private applicationScopeWhere(user: RequestUser): Prisma.ApplicationWhereInput {
    return {
      deletedAt: null,
      ...(canViewAll(user) ? {} : { salesUserId: user.id })
    };
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.prisma.customer.findUnique({
      include: customerInclude,
      where: { id }
    });

    if (!customer || customer.deletedAt) {
      throw new NotFoundException("Customer not found.");
    }

    return customer;
  }

  private async findApplicationOrThrow(id: string) {
    const application = await this.prisma.application.findUnique({
      include: applicationInclude,
      where: { id }
    });

    if (!application || application.deletedAt) {
      throw new NotFoundException("Application not found.");
    }

    return application;
  }

  private async auditApplicationChange(
    action: AuditAction,
    before: ApplicationWithDetails,
    after: ApplicationWithDetails,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.auditService.write({
      action,
      after: toApplicationView(after),
      before: toApplicationView(before),
      entityId: after.id,
      entityType: "application",
      ipAddress: context.ipAddress,
      module: "application",
      operatorId: user.id,
      userAgent: context.userAgent
    });
  }

}

function applicationReviewDecision(dto: ReviewApplicationDto) {
  return dto.action ?? dto.status ?? OrderReviewStatus.APPROVED;
}

function applicationReviewComment(dto: {
  comment?: string | null;
  reason?: string | null;
  remark?: string | null;
}) {
  return normalizeOptionalText(dto.comment ?? dto.remark ?? dto.reason);
}

function assertApplicationReviewDecision(status: OrderReviewStatus) {
  if (
    status !== OrderReviewStatus.APPROVED &&
    status !== OrderReviewStatus.REJECTED &&
    status !== OrderReviewStatus.NEED_MORE_INFO
  ) {
    throw new BadRequestException("审核状态必须为 APPROVED、REJECTED 或 NEED_MORE_INFO。");
  }
}

function applicationReviewStatusField(reviewType: ApplicationReviewType) {
  return {
    credit: "creditReviewStatus",
    material: "materialReviewStatus",
    product: "productReviewStatus",
    vehicle: "vehicleReviewStatus"
  }[reviewType] as
    | "creditReviewStatus"
    | "materialReviewStatus"
    | "productReviewStatus"
    | "vehicleReviewStatus";
}

function ensureApplicationReviewWorkflowAllowed(application: ApplicationWithDetails) {
  if (application.status === ApplicationStatus.REJECTED || application.status === ApplicationStatus.CANCELLED) {
    throw new BadRequestException("当前进件状态不允许审核。");
  }
  if (
    application.status !== ApplicationStatus.SUBMITTED &&
    application.status !== ApplicationStatus.NEED_MORE_INFO &&
    application.status !== ApplicationStatus.APPROVED
  ) {
    throw new BadRequestException("仅已提交、需补充资料或已确认方案前的进件可进入审核流程。");
  }
}

function assertApplicationHasNoOrder(application: ApplicationWithDetails) {
  const activeOrder = application.orders.find((order) => !order.deletedAt);
  if (activeOrder) {
    throw new BadRequestException("该进件已生成订单，请勿重复处理。");
  }
}

async function findActiveApplicationDepositRule(tx: Tx, grade: CustomerGrade) {
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

async function releaseApplicationSoftReservedVehicle(
  tx: Tx,
  application: ApplicationWithDetails,
  user: RequestUser
) {
  if (!application.softReservedVehicleId) {
    return null;
  }

  const before = await tx.vehicle.findUnique({ where: { id: application.softReservedVehicleId } });
  if (!before || before.deletedAt || before.status !== VehicleStatus.REVIEW_RESERVED) {
    return null;
  }

  const after = await tx.vehicle.update({
    data: { status: VehicleStatus.AVAILABLE, updatedBy: user.id },
    where: { id: before.id }
  });

  return { after, before };
}

async function loadApplicationFinalPlanDetails(
  tx: Tx,
  application: ApplicationWithDetails,
  dto?: ReviewApplicationDto
): Promise<ApplicationFinalPlanDetails> {
  const input = resolveApplicationFinalPlanInput(application, dto);
  const [plan, vehicle] = await Promise.all([
    tx.subscriptionPlan.findUnique({
      include: selfServiceSubscriptionPlanInclude,
      where: { id: input.subscriptionPlanId }
    }),
    tx.vehicle.findUnique({
      include: selfServiceVehicleInclude,
      where: { id: input.vehicleId }
    })
  ]);

  assertSelfServiceSubscriptionPlanAvailable(plan);
  assertApplicationVehicleExists(vehicle);
  if (vehicle.modelDefinitionId !== plan.vehiclePackage.modelDefinitionId) {
    throw new BadRequestException("所选套餐不适用于该车辆车型。");
  }
  assertSelfServicePeriodInRange(input.periodMonths, plan.minPeriodMonths, plan.maxPeriodMonths);

  const vehicleSalePriceAmount = requireSelfServiceCurrentSalePriceAmount(
    vehicle.currentSalePriceAmount
  );
  const vehicleBaseFeePricing = calculateSelfServiceVehicleBaseFee(plan, vehicleSalePriceAmount);
  const mileagePackagePriceAmount = plan.mileagePackage.priceAmount;
  const energyPackagePriceAmount = plan.energyPackage.priceAmount;
  const benefitPackagePriceAmount = plan.benefitPackage?.priceAmount ?? 0n;
  const monthlyFeeAmount =
    vehicleBaseFeePricing.vehicleBaseFeeAmount +
    mileagePackagePriceAmount +
    energyPackagePriceAmount +
    benefitPackagePriceAmount;
  const vehicleSnapshot = toJsonSnapshot({
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: vehicle.batteryCapacityKwh?.toNumber() ?? null,
    batteryUsageType: vehicle.batteryUsageType,
    batteryUsageTypeLabel: VEHICLE_BATTERY_USAGE_TYPE_LABELS[vehicle.batteryUsageType],
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    currentSalePriceAmount: Number(vehicleSalePriceAmount),
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    ...buildVehicleModelSnapshot(toCanonicalModelIdentity(vehicle)),
    plateNo: vehicle.plateNo,
    series: vehicle.series,
    status: vehicle.status,
    vehicleNo: vehicle.vehicleNo,
    vin: vehicle.vin
  });
  const packageSnapshot = toJsonSnapshot({
    benefitPackage: plan.benefitPackage ? toSelfServicePackageSnapshot(plan.benefitPackage) : null,
    energyPackage: toSelfServicePackageSnapshot(plan.energyPackage),
    mileagePackage: toSelfServicePackageSnapshot(plan.mileagePackage),
    pricing: {
      benefitPackagePriceAmount: Number(benefitPackagePriceAmount),
      currentSalePriceAmount: Number(vehicleSalePriceAmount),
      energyPackagePriceAmount: Number(energyPackagePriceAmount),
      fixedRate: vehicleBaseFeePricing.fixedRate,
      mileagePackagePriceAmount: Number(mileagePackagePriceAmount),
      monthlyFeeAmount: Number(monthlyFeeAmount),
      vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
      vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
      vehicleBaseFeeMode: plan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel
    },
    subscriptionPlan: toSelfServiceSubscriptionPlanSnapshot(plan),
    vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
    vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
    vehicleBaseFeeMode: plan.monthlyFeeMode,
    vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel,
    vehiclePackage: toSelfServicePackageSnapshot(plan.vehiclePackage)
  });
  const finalPlanSnapshot = toJsonSnapshot({
    applicationId: application.id,
    applicationNo: application.applicationNo,
    applicationSource: application.applicationSource,
    customerGrade: application.customerGrade,
    customerId: application.customerId,
    depositAmount: application.finalDepositAmount === null ? null : Number(application.finalDepositAmount),
    depositRuleSnapshot: application.depositRuleSnapshot,
    depositStatus: application.depositStatus,
    finalPlanConfirmedAt: application.finalPlanConfirmedAt?.toISOString() ?? null,
    packageSnapshot,
    periodMonths: input.periodMonths,
    pricing: {
      benefitPackagePriceAmount: Number(benefitPackagePriceAmount),
      currentSalePriceAmount: Number(vehicleSalePriceAmount),
      energyPackagePriceAmount: Number(energyPackagePriceAmount),
      fixedRate: vehicleBaseFeePricing.fixedRate,
      mileagePackagePriceAmount: Number(mileagePackagePriceAmount),
      monthlyFeeAmount: Number(monthlyFeeAmount),
      vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
      vehicleBaseFeeCapAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeCapAmount),
      vehicleBaseFeeMode: plan.monthlyFeeMode,
      vehicleBaseFeeModeLabel: vehicleBaseFeePricing.vehicleBaseFeeModeLabel
    },
    subscriptionPlan: toSelfServiceSubscriptionPlanSnapshot(plan),
    subscriptionPlanId: plan.id,
    vehicleBaseFeeAmount: Number(vehicleBaseFeePricing.vehicleBaseFeeAmount),
    vehicleId: vehicle.id,
    vehicleSnapshot
  });

  return {
    benefitPackagePriceAmount,
    energyPackagePriceAmount,
    finalPlanSnapshot,
    fixedRate: vehicleBaseFeePricing.fixedRate,
    mileagePackagePriceAmount,
    monthlyFeeAmount,
    packageSnapshot,
    periodMonths: input.periodMonths,
    plan,
    vehicle,
    vehicleBaseFeeAmount: vehicleBaseFeePricing.vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount: vehicleBaseFeePricing.vehicleBaseFeeCapAmount,
    vehicleSalePriceAmount,
    vehicleSnapshot
  };
}

function resolveApplicationFinalPlanInput(
  application: ApplicationWithDetails,
  dto?: ReviewApplicationDto
): ApplicationFinalPlanInput {
  const subscriptionPlanId =
    dto?.finalSubscriptionPlanId ??
    application.finalSubscriptionPlanId ??
    application.intentSubscriptionPlanId;
  const vehicleId =
    dto?.finalVehicleId ??
    application.finalVehicleId ??
    application.intentVehicleId ??
    application.softReservedVehicleId;
  const periodMonths =
    dto?.finalPeriodMonths ??
    application.finalPeriodMonths ??
    application.intentPeriodMonths ??
    application.intendedPeriodMonths;

  if (!subscriptionPlanId) {
    throw new BadRequestException("进件缺少订阅套餐，无法确认最终方案。");
  }
  if (!vehicleId) {
    throw new BadRequestException("进件缺少车辆，无法确认最终方案。");
  }
  if (!periodMonths) {
    throw new BadRequestException("进件缺少订阅周期，无法确认最终方案。");
  }

  return { periodMonths, subscriptionPlanId, vehicleId };
}

function assertApplicationVehicleExists<T extends VehicleRecord>(
  vehicle: T | null
): asserts vehicle is T {
  if (!vehicle || vehicle.deletedAt) {
    throw new NotFoundException("Vehicle not found.");
  }
}

function toCanonicalModelIdentity(vehicle: {
  modelDefinition: ModelDefinitionSnapshot;
  modelDefinitionId: string;
}) {
  return {
    modelCode: vehicle.modelDefinition.modelCode,
    modelDefinitionId: vehicle.modelDefinitionId,
    modelDisplayName: vehicle.modelDefinition.displayName
  };
}

async function assertApplicationVehicleReviewAllowed(
  tx: Tx,
  application: ApplicationWithDetails,
  vehicle: SelfServiceVehicle
) {
  if (
    application.applicationSource === ApplicationSource.SELF_SERVICE &&
    application.softReservedVehicleId !== vehicle.id
  ) {
    throw new BadRequestException("暂不支持审核中更换车辆，请取消当前进件后重新提交。");
  }

  if (application.applicationSource === ApplicationSource.SELF_SERVICE) {
    if (vehicle.status !== VehicleStatus.REVIEW_RESERVED) {
      throw new BadRequestException("当前车辆不再处于审核占用状态，请重新选择车辆。");
    }
  } else if (vehicle.status !== VehicleStatus.AVAILABLE) {
    throw new BadRequestException("所选车辆当前不可租用，请重新选择车辆。");
  }

  requireSelfServiceCurrentSalePriceAmount(vehicle.currentSalePriceAmount);
  const occupiedByOrderCount = await tx.subscriptionOrder.count({
    where: {
      deletedAt: null,
      orderStatus: { notIn: [OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.COMPLETED, OrderStatus.TERMINATED] },
      vehicleId: vehicle.id
    }
  });
  if (occupiedByOrderCount > 0) {
    throw new BadRequestException("所选车辆已不可用，请重新选择车辆。");
  }
}

function assertApplicationReadyForFinalPlan(application: ApplicationWithDetails) {
  if (
    application.materialReviewStatus !== OrderReviewStatus.APPROVED ||
    application.creditReviewStatus !== OrderReviewStatus.APPROVED
  ) {
    throw new BadRequestException("资料审核和客户资质审核通过后才可以确认最终方案。");
  }
  if (application.depositStatus !== DepositStatus.CONFIRMED || application.finalDepositAmount === null) {
    throw new BadRequestException("押金确认后才可以确认最终方案。");
  }
  resolveApplicationFinalPlanInput(application);
  if (
    application.applicationSource !== ApplicationSource.SELF_SERVICE &&
    application.finalVehicleBaseFeeAmount === null
  ) {
    throw new BadRequestException("进件缺少最终车辆基础费，无法确认最终方案。");
  }
}

function assertApplicationCanCreateOrder(application: ApplicationWithDetails) {
  if (application.status === ApplicationStatus.REJECTED || application.status === ApplicationStatus.CANCELLED) {
    throw new BadRequestException("当前进件状态不允许生成订单。");
  }
  assertApplicationHasNoOrder(application);
  if (application.status !== ApplicationStatus.APPROVED) {
    throw new BadRequestException("最终方案确认后才可以生成订单。");
  }
  if (!allApplicationReviewsApproved(applicationReviewStatuses(application))) {
    throw new BadRequestException("进件审核全部通过后才可以生成订单。");
  }
  if (application.depositStatus !== DepositStatus.CONFIRMED || application.finalDepositAmount === null) {
    throw new BadRequestException("押金确认后才可以生成订单。");
  }
  if (application.planConfirmStatus !== PlanConfirmStatus.CONFIRMED || !application.finalPlanSnapshot) {
    throw new BadRequestException("最终方案确认后才可以生成订单。");
  }
  resolveApplicationFinalPlanInput(application);
}

function assertApplicationVehicleCanEnterOrder(
  application: ApplicationWithDetails,
  vehicle: VehicleRecord | null
): asserts vehicle is VehicleRecord {
  assertApplicationVehicleExists(vehicle);
  if (
    application.applicationSource === ApplicationSource.SELF_SERVICE &&
    application.softReservedVehicleId !== vehicle.id
  ) {
    throw new BadRequestException("暂不支持审核中更换车辆，请取消当前进件后重新提交。");
  }
  const expectedStatus =
    application.applicationSource === ApplicationSource.SELF_SERVICE
      ? VehicleStatus.REVIEW_RESERVED
      : VehicleStatus.AVAILABLE;
  if (vehicle.status !== expectedStatus) {
    throw new BadRequestException("车辆当前状态不允许生成订单。");
  }
}

function applicationReviewStatuses(application: ApplicationWithDetails) {
  return {
    creditReviewStatus: application.creditReviewStatus,
    materialReviewStatus: application.materialReviewStatus,
    productReviewStatus: application.productReviewStatus,
    vehicleReviewStatus: application.vehicleReviewStatus
  };
}

function allApplicationReviewsApproved(statuses: {
  creditReviewStatus: OrderReviewStatus;
  materialReviewStatus: OrderReviewStatus;
  productReviewStatus: OrderReviewStatus;
  vehicleReviewStatus: OrderReviewStatus;
}) {
  return (
    statuses.creditReviewStatus === OrderReviewStatus.APPROVED &&
    statuses.materialReviewStatus === OrderReviewStatus.APPROVED &&
    statuses.productReviewStatus === OrderReviewStatus.APPROVED &&
    statuses.vehicleReviewStatus === OrderReviewStatus.APPROVED
  );
}

function mapApplicationSourceToOrderSource(source: ApplicationSource) {
  return source === ApplicationSource.SELF_SERVICE
    ? OrderSource.CUSTOMER_SELF_SERVICE
    : OrderSource.SALES_ASSISTED;
}

function canViewAll(user: RequestUser) {
  return user.roles.some((role) => ["ADMIN", "GM", "OP", "RC"].includes(role));
}

function ensureCanAccessCustomer(customer: CustomerWithDetails, user: RequestUser) {
  if (!canViewAll(user) && customer.ownerUserId !== user.id) {
    throw new ForbiddenException("Customer is outside your scope.");
  }
}

function ensureCanAccessApplication(application: ApplicationWithDetails, user: RequestUser) {
  if (!canAccessScopedApplication(application, user)) {
    throw new ForbiddenException("Application is outside your scope.");
  }
}

export function canAccessScopedApplication(
  application: Pick<ApplicationWithDetails, "salesUserId">,
  user: RequestUser
) {
  return canViewAll(user) || application.salesUserId === user.id;
}

function ensureCanManageApplication(application: ApplicationWithDetails, user: RequestUser) {
  ensureCanAccessApplication(application, user);
}

function ensureReviewable(application: ApplicationWithDetails) {
  if (application.status !== ApplicationStatus.SUBMITTED) {
    throw new BadRequestException("Only submitted applications can be reviewed.");
  }
}

export function canEditApplication(status: ApplicationStatus) {
  return status === ApplicationStatus.DRAFT || status === ApplicationStatus.NEED_MORE_INFO;
}

function canUploadMaterialForApplication(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user: RequestUser
) {
  return (
    user.permissions.includes(PermissionCode.APPLICATION_MATERIAL_UPLOAD) &&
    canAccessScopedApplication(application, user) &&
    canUploadMaterial(application.status, user, application.salesUserId)
  );
}

function canUploadMaterial(status: ApplicationStatus, user: RequestUser, salesUserId?: string) {
  if (user.roles.includes("ADMIN")) {
    return true;
  }

  if (status === ApplicationStatus.DRAFT || status === ApplicationStatus.NEED_MORE_INFO) {
    return canViewAll(user) || salesUserId === user.id;
  }

  if (status === ApplicationStatus.SUBMITTED) {
    return user.roles.some((role) => role === "OP" || role === "RC");
  }

  return false;
}

export function isUploadableStatus(status: ApplicationStatus) {
  return (
    status === ApplicationStatus.DRAFT ||
    status === ApplicationStatus.SUBMITTED ||
    status === ApplicationStatus.NEED_MORE_INFO
  );
}

export function canDeleteMaterialFile(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user: RequestUser
) {
  if (!user.permissions.includes(PermissionCode.APPLICATION_MATERIAL_DELETE)) {
    return false;
  }

  if (user.roles.includes("ADMIN")) {
    return true;
  }

  if (application.status === ApplicationStatus.DRAFT || application.status === ApplicationStatus.NEED_MORE_INFO) {
    return canViewAll(user) || application.salesUserId === user.id;
  }

  if (application.status === ApplicationStatus.SUBMITTED) {
    return user.roles.some((role) => role === "OP" || role === "RC");
  }

  return false;
}

function assertCanReviewMaterialGroup(
  application: Pick<ApplicationWithDetails, "status">,
  user: RequestUser
) {
  if (canReviewMaterialGroup(application, user)) {
    return;
  }

  throw new ForbiddenException("You do not have permission to review this material group.");
}

function canReviewMaterialGroup(
  application: Pick<ApplicationWithDetails, "status">,
  user: RequestUser
) {
  if (!user.permissions.includes(PermissionCode.APPLICATION_REVIEW)) {
    return false;
  }

  if (user.roles.includes("ADMIN")) {
    return true;
  }

  return (
    user.roles.includes("RC") &&
    (application.status === ApplicationStatus.SUBMITTED ||
      application.status === ApplicationStatus.NEED_MORE_INFO)
  );
}

function identityData(dto: CustomerIdentityDto) {
  return {
    driverLicenseNo: dto.driverLicenseNo,
    idCardNo: dto.idCardNo,
    licenseValidUntil: dto.licenseValidUntil ? new Date(dto.licenseValidUntil) : undefined,
    realnameVerified: dto.realnameVerified
  };
}

function profileData(dto: CustomerProfileDto) {
  return {
    companyName: dto.companyName,
    emergencyContactMobile: dto.emergencyContactMobile,
    emergencyContactName: dto.emergencyContactName,
    housingFundMonths: dto.housingFundMonths,
    monthlyIncomeAmount:
      dto.monthlyIncomeAmount === undefined ? undefined : BigInt(dto.monthlyIncomeAmount),
    occupation: dto.occupation,
    residenceAddress: dto.residenceAddress,
    socialSecurityMonths: dto.socialSecurityMonths
  };
}

const requiredMaterialTypes: ApplicationMaterialType[] = [
  ApplicationMaterialType.ID_CARD,
  ApplicationMaterialType.DRIVER_LICENSE
];

function isRequiredMaterialType(type: ApplicationMaterialType) {
  return requiredMaterialTypes.includes(type);
}

function deriveApplicationMaterialReviewStatus(
  groups: Array<{
    files: Array<{ isDeleted: boolean }>;
    materialType: ApplicationMaterialType;
    reviewStatus: MaterialStatus;
  }>
) {
  const groupsByType = new Map(groups.map((group) => [group.materialType, group]));
  const requiredGroups = requiredMaterialTypes.map((type) => groupsByType.get(type));

  if (
    requiredGroups.every(
      (group) =>
        group &&
        group.files.some((file) => !file.isDeleted) &&
        isApprovedMaterialStatus(group.reviewStatus)
    )
  ) {
    return OrderReviewStatus.APPROVED;
  }

  if (requiredGroups.some((group) => group?.reviewStatus === MaterialStatus.REJECTED)) {
    return OrderReviewStatus.REJECTED;
  }

  if (requiredGroups.some((group) => group?.reviewStatus === MaterialStatus.NEED_MORE_INFO)) {
    return OrderReviewStatus.NEED_MORE_INFO;
  }

  return OrderReviewStatus.PENDING;
}

export function assertCanSubmitApplication(application: ApplicationWithDetails) {
  const groups = materialGroupByType(application.materialGroups);
  const missingTypes = requiredMaterialTypes.filter((type) => {
    const group = groups.get(type);
    return !group || activeMaterialFiles(group).length === 0;
  });
  const rejectedTypes = requiredMaterialTypes.filter(
    (type) => groups.get(type)?.reviewStatus === MaterialStatus.REJECTED
  );

  if (missingTypes.length > 0) {
    throw new BadRequestException(
      `Missing required materials: ${missingTypes.map(getMaterialTypeName).join(", ")}.`
    );
  }

  if (rejectedTypes.length > 0) {
    throw new BadRequestException(
      `Rejected required materials must be re-uploaded: ${rejectedTypes
        .map(getMaterialTypeName)
        .join(", ")}.`
    );
  }
}

export function assertCanApproveApplication(application: ApplicationWithDetails) {
  const invalidTypes = requiredMaterialTypes.filter((type) => {
    const group = materialGroupByType(application.materialGroups).get(type);
    return !group || activeMaterialFiles(group).length === 0 || !isApprovedMaterialStatus(group.reviewStatus);
  });

  if (invalidTypes.length > 0) {
    throw new BadRequestException(
      `Required materials are not approved: ${invalidTypes.map(getMaterialTypeName).join(", ")}.`
    );
  }
}

function materialGroupByType(groups: ApplicationWithDetails["materialGroups"]) {
  return new Map(groups.map((group) => [group.materialType, group]));
}

function activeMaterialFiles(group: Pick<ApplicationWithDetails["materialGroups"][number], "files">) {
  return group.files.filter((file) => !file.isDeleted);
}

export function isApprovedMaterialStatus(status: MaterialStatus) {
  return status === MaterialStatus.APPROVED || status === MaterialStatus.VERIFIED;
}

export function assertReviewMaterialInput(status: MaterialStatus, comment?: string) {
  if (
    status !== MaterialStatus.APPROVED &&
    status !== MaterialStatus.NEED_MORE_INFO &&
    status !== MaterialStatus.REJECTED
  ) {
    throw new BadRequestException("Material review status must be APPROVED, NEED_MORE_INFO, or REJECTED.");
  }

  if (
    (status === MaterialStatus.NEED_MORE_INFO || status === MaterialStatus.REJECTED) &&
    !normalizeOptionalText(comment)
  ) {
    throw new BadRequestException("comment is required for this material review status.");
  }
}

export function assertDeleteMaterialFileInput(reason?: string | null) {
  return normalizeRequiredText(reason, "reason");
}

export function assertCanReviewMaterialGroupStatus(
  group: Pick<
    ApplicationWithDetails["materialGroups"][number],
    "files" | "materialType" | "required"
  >,
  status: MaterialStatus
) {
  if (
    status === MaterialStatus.APPROVED &&
    isRequiredMaterialType(group.materialType) &&
    activeMaterialFiles(group).length === 0
  ) {
    throw new BadRequestException(
      `Required material cannot be approved without files: ${getMaterialTypeName(group.materialType)}.`
    );
  }
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeRequiredText(value: string | undefined | null, field: string) {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new BadRequestException(`${field} is required.`);
  }

  return normalized;
}

function assertSelfServiceVehicleAvailable<T extends VehicleRecord>(
  vehicle: T | null
): asserts vehicle is T {
  if (!vehicle || vehicle.deletedAt) {
    throw new NotFoundException("Vehicle not found.");
  }
  if (vehicle.status !== VehicleStatus.AVAILABLE) {
    throw new BadRequestException(SELF_SERVICE_VEHICLE_UNAVAILABLE_MESSAGE);
  }
  if (
    vehicle.salePriceStatus !== SalePriceStatus.EFFECTIVE ||
    !vehicle.currentSalePriceAmount ||
    vehicle.currentSalePriceAmount <= 0n
  ) {
    throw new BadRequestException("当前车辆销售价未初始化，无法提交自助进件");
  }
}

function assertSelfServiceSubscriptionPlanAvailable(
  plan: SelfServiceSubscriptionPlan | null
): asserts plan is SelfServiceSubscriptionPlan {
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
    !isSelfServicePackageActiveForPlan(plan, plan.vehiclePackage) ||
    !isSelfServicePackageActiveForPlan(plan, plan.mileagePackage) ||
    !isSelfServicePackageActiveForPlan(plan, plan.energyPackage) ||
    (plan.benefitPackage !== null && !isSelfServicePackageActiveForPlan(plan, plan.benefitPackage))
  ) {
    throw new BadRequestException("所选订阅套餐包含未启用组件");
  }
  if (plan.monthlyFeeMode === MonthlyFeeMode.MANUAL_QUOTE) {
    throw new BadRequestException(SELF_SERVICE_MANUAL_QUOTE_MESSAGE);
  }
}

function requireSelfServiceCurrentSalePriceAmount(value: bigint | null) {
  if (!value || value <= 0n) {
    throw new BadRequestException("当前车辆销售价未初始化，无法提交自助进件");
  }
  return value;
}

function isSelfServicePackageActiveForPlan(
  plan: SelfServiceSubscriptionPlan,
  row: SelfServicePackage
) {
  return (
    !row.deletedAt &&
    row.status === RecordStatus.ACTIVE &&
    row.productId === plan.productId &&
    row.productVersionId === plan.productVersionId
  );
}

function assertSelfServicePeriodInRange(periodMonths: number, minPeriodMonths: number, maxPeriodMonths: number) {
  if (periodMonths < minPeriodMonths || periodMonths > maxPeriodMonths) {
    throw new BadRequestException("订阅周期不在套餐允许范围内");
  }
}

const SELF_SERVICE_VEHICLE_BASE_FEE_MODE_LABELS: Record<MonthlyFeeMode, string> = {
  [MonthlyFeeMode.FIXED_AMOUNT]: "固定金额",
  [MonthlyFeeMode.MANUAL_QUOTE]: "现场报价",
  [MonthlyFeeMode.RATE_FORMULA]: "固定费率"
};

const VEHICLE_BATTERY_USAGE_TYPE_LABELS: Record<VehicleBatteryUsageType, string> = {
  [VehicleBatteryUsageType.BAAS]: "BaaS / 电池租用",
  [VehicleBatteryUsageType.BUYOUT]: "电池买断"
};

function calculateSelfServiceVehicleBaseFee(
  plan: SelfServiceSubscriptionPlan,
  vehicleSalePriceAmount: bigint
) {
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
      throw new BadRequestException(SELF_SERVICE_MANUAL_QUOTE_MESSAGE);
    default:
      throw new BadRequestException("不支持的车辆基础月费模式");
  }

  assertSelfServiceVehicleBaseFeeWithinCap(vehicleBaseFeeAmount, vehicleBaseFeeCapAmount);

  return {
    fixedRate,
    vehicleBaseFeeAmount,
    vehicleBaseFeeCapAmount,
    vehicleBaseFeeModeLabel: SELF_SERVICE_VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode]
  };
}

function assertSelfServiceVehicleBaseFeeWithinCap(vehicleBaseFeeAmount: bigint, capAmount: bigint) {
  if (vehicleBaseFeeAmount > capAmount) {
    throw new BadRequestException("车辆基础费超过车型包系数允许上限");
  }
}

function toSelfServiceSubscriptionPlanSnapshot(plan: SelfServiceSubscriptionPlan) {
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
    monthlyFeeModeLabel: SELF_SERVICE_VEHICLE_BASE_FEE_MODE_LABELS[plan.monthlyFeeMode],
    monthlyFeeRate: Number(plan.monthlyFeeRate),
    planName: plan.planName,
    planNo: plan.planNo,
    productId: plan.productId,
    productVersionId: plan.productVersionId,
    status: plan.status,
    vehiclePackageId: plan.vehiclePackageId
  };
}

type SelfServicePackage =
  | Prisma.VehiclePackageGetPayload<{ include: typeof selfServiceVehiclePackageInclude }>
  | Prisma.MileagePackageGetPayload<{ include: typeof selfServicePackageInclude }>
  | Prisma.EnergyPackageGetPayload<{ include: typeof selfServicePackageInclude }>
  | Prisma.BenefitPackageGetPayload<{ include: typeof selfServicePackageInclude }>;

function toSelfServicePackageSnapshot(row: SelfServicePackage) {
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
  if ("monthlyEnergyCount" in row) {
    result.monthlyEnergyCount = row.monthlyEnergyCount;
    result.monthlyEnergyKwh = row.monthlyEnergyKwh;
    result.priceAmount = Number(row.priceAmount);
  }
  if ("benefitType" in row) {
    result.benefitType = row.benefitType;
    result.description = row.description;
    result.priceAmount = Number(row.priceAmount);
  }

  return result;
}

function toJsonSnapshot(value: unknown): Prisma.InputJsonValue {
  return toAuditSnapshot(value) as Prisma.InputJsonValue;
}

function toAuditSnapshot(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_key: string, item: unknown) =>
      typeof item === "bigint" ? Number(item) : item
    )
  ) as unknown;
}

async function createApplicationActionLog(
  tx: Tx,
  input: {
    actionType: ApplicationActionType;
    applicationId: string;
    comment?: string;
    fromStatus?: ApplicationStatus | null;
    materialId?: string;
    materialFileId?: string;
    materialGroupId?: string;
    operator: RequestUser;
    toStatus?: ApplicationStatus | null;
  }
) {
  await tx.applicationActionLog.create({
    data: {
      actionType: input.actionType,
      applicationId: input.applicationId,
      comment: input.comment,
      createdBy: input.operator.id,
      fromStatus: input.fromStatus,
      materialFileId: input.materialFileId,
      materialGroupId: input.materialGroupId,
      materialId: input.materialId,
      operatorId: input.operator.id,
      operatorName: input.operator.name,
      toStatus: input.toStatus,
      updatedBy: input.operator.id
    }
  });
}

async function upsertMaterialGroup(
  tx: Tx,
  input: {
    applicationId: string;
    materialType: ApplicationMaterialType;
    user: RequestUser;
  }
) {
  return tx.applicationMaterialGroup.upsert({
    create: {
      applicationId: input.applicationId,
      createdBy: input.user.id,
      materialName: getMaterialTypeName(input.materialType),
      materialType: input.materialType,
      required: isRequiredMaterialType(input.materialType),
      updatedBy: input.user.id
    },
    update: {
      materialName: getMaterialTypeName(input.materialType),
      required: isRequiredMaterialType(input.materialType),
      updatedBy: input.user.id
    },
    where: {
      applicationId_materialType: {
        applicationId: input.applicationId,
        materialType: input.materialType
      }
    }
  });
}

function buildMaterialFileActionComment(
  action: string,
  materialType: ApplicationMaterialType,
  fileNames: string[],
  comment?: string
) {
  const text = `${action}: ${getMaterialTypeName(materialType)} - ${fileNames.join(", ")}`;
  return comment ? `${text}; ${comment}` : text;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function getMaterialTypeLabel(type: ApplicationMaterialType) {
  const labels: Record<ApplicationMaterialType, string> = {
    BANK_FLOW: "银行流水",
    CREDIT_AUTH: "征信授权",
    DRIVER_LICENSE: "驾驶证",
    ID_CARD: "身份证",
    OTHER: "其他",
    RESIDENCE_PROOF: "居住证明",
    WORK_PROOF: "工作证明"
  };

  return labels[type];
}

function getMaterialTypeName(type: ApplicationMaterialType) {
  const labels: Record<ApplicationMaterialType, string> = {
    BANK_FLOW: "银行流水",
    CREDIT_AUTH: "征信授权",
    DRIVER_LICENSE: "驾驶证",
    ID_CARD: "身份证",
    OTHER: "其他",
    RESIDENCE_PROOF: "居住证明",
    WORK_PROOF: "工作证明"
  };

  return labels[type];
}

export function getAvailableApplicationActions(
  application: Pick<ApplicationWithDetails, "salesUserId" | "status"> &
    Partial<Pick<ApplicationWithDetails, "planConfirmStatus">>,
  user: RequestUser
) {
  const permissions = new Set(user.permissions);
  const actions: string[] = [];

  if (
    permissions.has(PermissionCode.APPLICATION_MATERIAL_UPLOAD) &&
    canUploadMaterialForApplication(application, user)
  ) {
    actions.push("uploadMaterial");
  }

  if (
    permissions.has(PermissionCode.APPLICATION_SUBMIT) &&
    (canViewAll(user) || application.salesUserId === user.id) &&
    canEditApplication(application.status)
  ) {
    actions.push("submit");
  }

  if (
    permissions.has(PermissionCode.APPLICATION_REVIEW) &&
    (application.status === ApplicationStatus.SUBMITTED ||
      application.status === ApplicationStatus.NEED_MORE_INFO ||
      application.status === ApplicationStatus.APPROVED)
  ) {
    actions.push(
      "reviewMaterial",
      "approve",
      "needMoreInfo",
      "reject",
      "reviewApplicationMaterial",
      "reviewApplicationCredit",
      "reviewApplicationProduct",
      "reviewApplicationVehicle",
      "finalizeApplicationPlan"
    );
  }

  if (
    permissions.has(PermissionCode.QUOTE_CREATE) &&
    (canViewAll(user) || application.salesUserId === user.id) &&
    application.status === ApplicationStatus.APPROVED
  ) {
    actions.push("createQuote");
  }

  if (
    permissions.has(PermissionCode.ORDER_CREATE) &&
    (canViewAll(user) || application.salesUserId === user.id) &&
    application.status === ApplicationStatus.APPROVED &&
    application.planConfirmStatus === PlanConfirmStatus.CONFIRMED
  ) {
    actions.push("createOrderFromApplication");
  }

  return actions;
}

export function toCustomerView(customer: CustomerWithDetails) {
  return {
    applications: customer.applications.map((application) => ({
      applicationNo: application.applicationNo,
      id: application.id,
      intendedModel: application.intendedModel,
      status: application.status
    })),
    createdAt: customer.createdAt,
    customerNo: customer.customerNo,
    customerType: customer.customerType,
    grade: customer.grade,
    id: customer.id,
    identity: customer.identity,
    mobile: customer.mobile,
    name: customer.name,
    ownerUser: customer.ownerUser,
    profile: customer.profile
      ? {
          ...customer.profile,
          monthlyIncomeAmount:
            customer.profile.monthlyIncomeAmount === null
              ? null
              : Number(customer.profile.monthlyIncomeAmount)
        }
      : null,
    remark: customer.remark,
    riskScore: customer.riskScore,
    sourceChannel: customer.sourceChannel,
    status: customer.status
  };
}

export function toApplicationView(application: ApplicationWithDetails, user?: RequestUser) {
  return {
    actionLogs: application.actionLogs.map(toApplicationActionLogView),
    applicationNo: application.applicationNo,
    applicationSource: application.applicationSource,
    approvedAt: application.approvedAt,
    availableActions: user ? getAvailableApplicationActions(application, user) : [],
    creditReviewComment: application.creditReviewComment,
    creditReviewStatus: application.creditReviewStatus,
    createdAt: application.createdAt,
    customer: {
      ...application.customer,
      profile: application.customer.profile
        ? {
            ...application.customer.profile,
            monthlyIncomeAmount:
              application.customer.profile.monthlyIncomeAmount === null
                ? null
                : Number(application.customer.profile.monthlyIncomeAmount)
          }
        : null
    },
    customerId: application.customerId,
    customerGrade: application.customerGrade,
    customerSelectedSnapshot: application.customerSelectedSnapshot,
    depositRuleId: application.depositRuleId,
    depositRuleSnapshot: application.depositRuleSnapshot,
    depositStatus: application.depositStatus,
    finalDepositAmount:
      application.finalDepositAmount === null ? null : Number(application.finalDepositAmount),
    finalPeriodMonths: application.finalPeriodMonths,
    finalPlanConfirmedAt: application.finalPlanConfirmedAt,
    finalPlanSnapshot: application.finalPlanSnapshot,
    finalQuoteSnapshot: application.finalQuoteSnapshot,
    finalSubscriptionPlanId: application.finalSubscriptionPlanId,
    finalVehicleBaseFeeAmount:
      application.finalVehicleBaseFeeAmount === null
        ? null
        : Number(application.finalVehicleBaseFeeAmount),
    finalVehicleId: application.finalVehicleId,
    id: application.id,
    intentPeriodMonths: application.intentPeriodMonths,
    intentSnapshot: application.intentSnapshot,
    intentSubscriptionPlanId: application.intentSubscriptionPlanId,
    intentVehicleBaseFeeAmount:
      application.intentVehicleBaseFeeAmount === null
        ? null
        : Number(application.intentVehicleBaseFeeAmount),
    intentVehicleId: application.intentVehicleId,
    intendedModel: application.intendedModel,
    intendedPeriodMonths: application.intendedPeriodMonths,
    materialReviewStatus: application.materialReviewStatus,
    materials: application.materialGroups.map((group) => toMaterialGroupView(group, application, user)),
    orders: (application.orders ?? [])
      .filter((order) => !order.deletedAt)
      .map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        orderStatus: order.orderStatus
      })),
    planConfirmStatus: application.planConfirmStatus,
    productReviewStatus: application.productReviewStatus,
    rejectedReason: application.rejectedReason,
    riskResult: application.riskResults[0] ? toRiskResultView(application.riskResults[0]) : null,
    salesUser: application.salesUser,
    salesUserId: application.salesUserId,
    softReservationExpiresAt: application.softReservationExpiresAt,
    softReservedAt: application.softReservedAt,
    softReservedVehicleId: application.softReservedVehicleId,
    status: application.status,
    submittedAt: application.submittedAt,
    vehicleReviewStatus: application.vehicleReviewStatus
  };
}

function toMaterialView(
  material: Prisma.ApplicationMaterialGetPayload<{ include: typeof materialInclude }>
) {
  return {
    createdAt: material.createdAt,
    file: {
      bucket: material.file.bucket,
      id: material.file.id,
      mimeType: material.file.mimeType,
      objectKey: material.file.objectKey,
      originalName: material.file.originalName,
      sizeBytes: Number(material.file.sizeBytes),
      uploader: material.file.uploader
    },
    fileId: material.fileId,
    id: material.id,
    materialName: material.materialName ?? getMaterialTypeName(material.materialType),
    materialType: material.materialType,
    reviewComment: material.reviewComment ?? material.reviewRemark,
    reviewedAt: material.reviewedAt,
    reviewer: material.reviewer,
    reviewRemark: material.reviewRemark,
    status: material.status
  };
}

function toMaterialGroupView(
  group: Prisma.ApplicationMaterialGroupGetPayload<{ include: typeof materialGroupInclude }>,
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user?: RequestUser
) {
  return {
    canReview: user ? canReviewMaterialGroup(application, user) : false,
    canUpload: user ? canUploadMaterialForApplication(application, user) : false,
    files: group.files
      .filter((file) => !file.isDeleted)
      .map((file) => toMaterialFileView(file, application, user)),
    id: group.id,
    materialGroupId: group.id,
    materialName: group.materialName ?? getMaterialTypeName(group.materialType),
    materialType: group.materialType,
    required: isRequiredMaterialType(group.materialType),
    reviewComment: group.reviewComment,
    reviewedAt: group.reviewedAt,
    reviewer: group.reviewer,
    reviewStatus: group.reviewStatus,
    status: group.reviewStatus
  };
}

function toMaterialFileView(
  file: Prisma.ApplicationMaterialFileGetPayload<{ include: typeof materialFileInclude }>,
  application: Pick<ApplicationWithDetails, "salesUserId" | "status">,
  user?: RequestUser
) {
  const source = file.file?.objectKey?.startsWith("customer-profile-materials/")
    ? "CUSTOMER_PROFILE"
    : "APPLICATION_UPLOAD";
  return {
    canDelete: user ? canDeleteMaterialFile(application, user) && !file.isDeleted : false,
    deletedAt: file.deletedAt,
    deletedBy: file.deleter,
    deleteReason: file.deleteReason,
    fileId: file.fileId,
    fileName: file.fileName,
    fileRecordId: file.id,
    id: file.id,
    isDeleted: file.isDeleted,
    materialType: file.materialType,
    mimeType: file.mimeType,
    sizeBytes: Number(file.sizeBytes),
    source,
    sourceLabel: source === "CUSTOMER_PROFILE" ? "客户资料中心" : "申请上传",
    uploadedAt: file.uploadedAt,
    uploadedBy: file.uploader,
    uploader: file.uploader
  };
}

function toApplicationActionLogView(
  actionLog: ApplicationWithDetails["actionLogs"][number]
) {
  return {
    actionType: actionLog.actionType,
    comment: actionLog.comment,
    createdAt: actionLog.createdAt,
    fromStatus: actionLog.fromStatus,
    id: actionLog.id,
    material: actionLog.material,
    materialFile: actionLog.materialFile,
    materialFileId: actionLog.materialFileId,
    materialGroup: actionLog.materialGroup,
    materialGroupId: actionLog.materialGroupId,
    materialId: actionLog.materialId,
    operator: actionLog.operator,
    operatorId: actionLog.operatorId,
    operatorName: actionLog.operatorName,
    toStatus: actionLog.toStatus
  };
}
