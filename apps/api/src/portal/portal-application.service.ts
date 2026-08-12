import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  AuditAction,
  CustomerProfileMaterialStatus,
  DepositStatus,
  MaterialStatus,
  OrderReviewStatus,
  OrderMileageReviewStatus,
  OrderStatus,
  PlanConfirmStatus,
  Prisma,
  UserStatus,
  VehicleHandoverType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/auth.types";
import { sortByPortalListOrder } from "../common/portal-list-ordering";
import type { PortalListSortKey } from "../common/portal-list-ordering";
import {
  assertCustomerApplicationProfileReady,
  buildCustomerApplicationProfileReadiness,
  type CustomerApplicationProfileReadiness
} from "../customer/customer-application-profile-readiness";
import {
  CustomerService,
  MaterialPreview,
  UploadedMaterialFile
} from "../customer/customer.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { journeyError } from "../subscription-journey/subscription-journey.errors";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import {
  ConfirmPortalFinalPlanDto,
  CreatePortalSelfServiceApplicationDto,
  PrecheckPortalSelfServiceApplicationDto,
  RejectPortalFinalPlanDto,
  UploadPortalApplicationMaterialDto
} from "./portal-application.dto";
import {
  buildCustomerProfileMaterialCompleteness,
  getCustomerProfileMaterialLabel,
  isCustomerProfileMaterialObjectKey,
  toApplicationMaterialType
} from "./portal-profile-materials";
import type { CustomerProfileMaterialCompleteness } from "./portal-profile-materials";

const PORTAL_APPLICATION_ACTIONS = new Set([
  "UPLOAD_MATERIAL",
  "CONFIRM_FINAL_PLAN",
  "GO_CONTRACT",
  "GO_PAYMENT",
  "SUBMIT_MILEAGE_REVIEW"
]);
const PORTAL_APPLICATION_TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.TERMINATED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.REJECTED
]);

const portalApplicationInclude = {
  materialGroups: {
    include: {
      files: {
        include: { file: true },
        orderBy: { uploadedAt: "desc" as const }
      }
    },
    orderBy: { materialType: "asc" as const },
    where: { deletedAt: null }
  },
  orders: {
    orderBy: { createdAt: "desc" as const },
    select: {
      contractId: true,
      deletedAt: true,
      handoverWorkOrders: {
        orderBy: { createdAt: "desc" as const },
        select: {
          handoverType: true,
          id: true,
          status: true
        },
        take: 1,
        where: { handoverType: VehicleHandoverType.DELIVERY_OUTBOUND }
      },
      id: true,
      mileageReviews: {
        orderBy: [
          { cycleNo: "desc" as const },
          { version: "desc" as const },
          { createdAt: "desc" as const }
        ],
        select: {
          id: true,
          status: true
        },
        take: 1,
        where: {
          deletedAt: null,
          status: { not: OrderMileageReviewStatus.VOIDED }
        }
      },
      orderNo: true,
      orderStatus: true
    },
    where: { deletedAt: null }
  },
  salesUser: {
    select: {
      id: true,
      name: true,
      username: true
    }
  },
  subscriptionJourney: { select: { id: true } }
} satisfies Prisma.ApplicationInclude;

type PortalApplication = Prisma.ApplicationGetPayload<{
  include: typeof portalApplicationInclude;
}>;

type PortalMaterialGroup = PortalApplication["materialGroups"][number];

@Injectable()
export class PortalApplicationService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly customerService: CustomerService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  async precheckApplication(
    dto: PrecheckPortalSelfServiceApplicationDto,
    currentCustomer: CurrentCustomer
  ) {
    await this.customerService.validateSelfServiceApplicationSelection({
      periodMonths: dto.subscriptionPeriodMonths,
      subscriptionPlanId: dto.subscriptionPlanId,
      vehicleId: dto.vehicleId
    });

    const [materialCompleteness, profileReadiness] = await Promise.all([
      this.getProfileMaterialCompleteness(currentCustomer.customerId),
      this.getApplicationProfileReadiness(currentCustomer.customerId)
    ]);
    return toPortalApplicationPrecheck(materialCompleteness, profileReadiness);
  }

  async createApplication(
    dto: CreatePortalSelfServiceApplicationDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const operator = await this.resolvePortalApplicationOperator(currentCustomer.customerId);
    const [materialCompleteness, profileReadiness] = await Promise.all([
      this.getProfileMaterialCompleteness(currentCustomer.customerId),
      this.getApplicationProfileReadiness(currentCustomer.customerId)
    ]);
    if (!profileReadiness.complete) {
      assertCustomerApplicationProfileReady(
        await this.getApplicationProfileSource(currentCustomer.customerId)
      );
    }
    const result = await this.customerService.createSelfServiceApplication(
      {
        customerId: currentCustomer.customerId,
        periodMonths: dto.subscriptionPeriodMonths,
        subscriptionPlanId: dto.subscriptionPlanId,
        vehicleId: dto.vehicleId
      },
      operator,
      context
    );
    await this.copyProfileMaterialsToApplication(result.applicationId, currentCustomer, operator);

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: {
        applicationId: result.applicationId,
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        portalRemark: normalizeOptionalText(dto.remark)
      },
      entityId: result.applicationId,
      entityType: "portal_self_service_application",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return {
      applicationId: result.applicationId,
      applicationNo: result.applicationNo,
      depositStatus: result.depositStatus,
      materialComplete: materialCompleteness.complete,
      missingMaterials: materialCompleteness.missingMaterials,
      message: result.message,
      profileMaterialsAvailable: materialCompleteness.completedCount > 0,
      status: result.status,
      vehicleStatus: result.vehicleStatus
    };
  }

  async listApplications(currentCustomer: CurrentCustomer) {
    const applications = await this.prisma.application.findMany({
      include: portalApplicationInclude,
      orderBy: { createdAt: "desc" },
      where: {
        ...portalApplicationSourceScope,
        customerId: currentCustomer.customerId,
        deletedAt: null
      }
    });

    return sortByPortalListOrder(applications, portalApplicationSortKey).map(
      toPortalApplicationListItem
    );
  }

  async getApplication(id: string, currentCustomer: CurrentCustomer) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    const materialCompleteness = await this.getProfileMaterialCompleteness(
      currentCustomer.customerId
    );
    return toPortalApplicationDetail(application, materialCompleteness);
  }

  async getApplicationProgress(id: string, currentCustomer: CurrentCustomer) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    return toPortalApplicationProgress(application);
  }

  async getFinalPlan(id: string, currentCustomer: CurrentCustomer) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    return toPortalFinalPlanView(application);
  }

  async confirmFinalPlan(
    id: string,
    dto: ConfirmPortalFinalPlanDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    assertPortalFinalPlanPending(application);
    if (
      application.subscriptionJourney &&
      dto.revision !== application.finalPlanRevision
    ) {
      throw journeyError(
        "FINAL_PLAN_REVISION_STALE",
        "The displayed final plan revision is stale."
      );
    }

    const operator = await this.resolveApplicationSalesUser(application.salesUserId);
    const confirmedAt = new Date();
    const finalPlanSnapshot = withPortalFinalPlanDecision(application.finalPlanSnapshot, {
      customerAccountId: currentCustomer.customerAccountId,
      customerId: currentCustomer.customerId,
      phone: currentCustomer.phone,
      finalPlanConfirmedAt: confirmedAt.toISOString(),
      planConfirmStatus: PlanConfirmStatus.CONFIRMED,
      source: "PORTAL"
    });
    const finalQuoteSnapshot = withPortalFinalPlanDecision(
      application.finalQuoteSnapshot ?? application.finalPlanSnapshot,
      {
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        phone: currentCustomer.phone,
        finalPlanConfirmedAt: confirmedAt.toISOString(),
        planConfirmStatus: PlanConfirmStatus.CONFIRMED,
        source: "PORTAL"
      }
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.application.updateMany({
        data: {
          customerConfirmedPlanRevision: application.subscriptionJourney
            ? dto.revision
            : undefined,
          finalPlanConfirmedAt: confirmedAt,
          finalPlanSnapshot,
          finalQuoteSnapshot,
          planConfirmStatus: PlanConfirmStatus.CONFIRMED,
          rejectedReason: null,
          updatedBy: operator.id
        },
        where: {
          ...portalApplicationSourceScope,
          customerId: currentCustomer.customerId,
          deletedAt: null,
          finalPlanRevision: application.subscriptionJourney
            ? dto.revision
            : undefined,
          id,
          planConfirmStatus: PlanConfirmStatus.PENDING
        }
      });

      if (updateResult.count !== 1) {
        throw new BadRequestException("最终方案状态已变化，请刷新后重试。");
      }

      await tx.applicationActionLog.create({
        data: {
          actionType: ApplicationActionType.APPROVE,
          applicationId: id,
          comment: "客户确认最终方案",
          createdBy: operator.id,
          fromStatus: application.status,
          operatorId: operator.id,
          operatorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          toStatus: application.status,
          updatedBy: operator.id
        }
      });

      if (application.subscriptionJourney) {
        await this.customerService.recordJourneyCustomerPlanConfirmation(tx, {
          applicationId: id,
          revision: dto.revision
        });
      }

      return tx.application.findFirstOrThrow({
        include: portalApplicationInclude,
        where: {
          applicationSource: ApplicationSource.SELF_SERVICE,
          customerId: currentCustomer.customerId,
          deletedAt: null,
          id
        }
      });
    });

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: {
        applicationId: id,
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        finalPlanConfirmedAt: confirmedAt.toISOString(),
        planConfirmStatus: PlanConfirmStatus.CONFIRMED
      },
      before: {
        planConfirmStatus: application.planConfirmStatus
      },
      entityId: id,
      entityType: "portal_application_final_plan",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return {
      ...toPortalFinalPlanView(updated),
      nextAction: "WAIT_ORDER_CREATION",
      order: null
    };
  }

  async rejectFinalPlan(
    id: string,
    dto: RejectPortalFinalPlanDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    assertPortalFinalPlanPending(application);

    const reason = dto.reason.trim();
    const operator = await this.resolveApplicationSalesUser(application.salesUserId);
    const rejectedAt = new Date();
    const finalPlanSnapshot = withPortalFinalPlanDecision(application.finalPlanSnapshot, {
      customerAccountId: currentCustomer.customerAccountId,
      customerId: currentCustomer.customerId,
      phone: currentCustomer.phone,
      planConfirmStatus: PlanConfirmStatus.REJECTED,
      reason,
      rejectedAt: rejectedAt.toISOString(),
      source: "PORTAL"
    });
    const finalQuoteSnapshot = withPortalFinalPlanDecision(
      application.finalQuoteSnapshot ?? application.finalPlanSnapshot,
      {
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        phone: currentCustomer.phone,
        planConfirmStatus: PlanConfirmStatus.REJECTED,
        reason,
        rejectedAt: rejectedAt.toISOString(),
        source: "PORTAL"
      }
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.application.updateMany({
        data: {
          finalPlanSnapshot,
          finalQuoteSnapshot,
          planConfirmStatus: PlanConfirmStatus.REJECTED,
          rejectedReason: reason,
          updatedBy: operator.id
        },
        where: {
          applicationSource: ApplicationSource.SELF_SERVICE,
          customerId: currentCustomer.customerId,
          deletedAt: null,
          id,
          planConfirmStatus: PlanConfirmStatus.PENDING
        }
      });

      if (updateResult.count !== 1) {
        throw new BadRequestException("最终方案状态已变化，请刷新后重试。");
      }

      await tx.applicationActionLog.create({
        data: {
          actionType: ApplicationActionType.REJECT,
          applicationId: id,
          comment: `客户拒绝最终方案：${reason}`,
          createdBy: operator.id,
          fromStatus: application.status,
          operatorId: operator.id,
          operatorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          toStatus: application.status,
          updatedBy: operator.id
        }
      });

      return tx.application.findFirstOrThrow({
        include: portalApplicationInclude,
        where: {
          applicationSource: ApplicationSource.SELF_SERVICE,
          customerId: currentCustomer.customerId,
          deletedAt: null,
          id
        }
      });
    });

    await this.auditService.write({
      action: AuditAction.REJECT,
      after: {
        applicationId: id,
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        planConfirmStatus: PlanConfirmStatus.REJECTED,
        reason
      },
      before: {
        planConfirmStatus: application.planConfirmStatus
      },
      entityId: id,
      entityType: "portal_application_final_plan",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return toPortalFinalPlanView(updated);
  }

  async cancelApplication(
    id: string,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);

    if (!PORTAL_CUSTOMER_MUTABLE_APPLICATION_STATUSES.includes(application.status)) {
      throw new BadRequestException("当前申请状态暂不支持客户取消。");
    }

    if (application.orders.some((order) => !order.deletedAt)) {
      throw new BadRequestException("该申请已生成正式订单，不能从客户门户取消。");
    }

    const operator = await this.resolveApplicationSalesUser(application.salesUserId);
    await this.customerService.cancelApplication(
      id,
      { comment: "客户从门户取消申请。" },
      operator,
      context
    );

    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: {
        applicationId: id,
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId,
        status: ApplicationStatus.CANCELLED
      },
      before: {
        status: application.status
      },
      entityId: id,
      entityType: "portal_self_service_application",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return this.getApplication(id, currentCustomer);
  }

  async listMaterials(id: string, currentCustomer: CurrentCustomer) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    return application.materialGroups.map(toPortalMaterialGroupView);
  }

  async uploadMaterial(
    id: string,
    dto: UploadPortalApplicationMaterialDto,
    files: UploadedMaterialFile[] | undefined,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);

    if (!PORTAL_CUSTOMER_MUTABLE_APPLICATION_STATUSES.includes(application.status)) {
      throw new BadRequestException("当前申请状态暂不支持补充材料。");
    }

    const uploadFiles = (files ?? []).filter((file) => file.buffer?.length);
    if (uploadFiles.length === 0) {
      throw new BadRequestException("请上传材料文件。");
    }

    const operator = await this.resolveApplicationSalesUser(application.salesUserId);
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
      const materialGroup = await tx.applicationMaterialGroup.upsert({
        create: {
          applicationId: id,
          createdBy: operator.id,
          materialName: MATERIAL_TYPE_LABELS[dto.materialType],
          materialType: dto.materialType,
          required: isRequiredMaterialType(dto.materialType),
          updatedBy: operator.id
        },
        update: {
          materialName: MATERIAL_TYPE_LABELS[dto.materialType],
          updatedBy: operator.id
        },
        where: {
          applicationId_materialType: {
            applicationId: id,
            materialType: dto.materialType
          }
        }
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
            uploadedBy: operator.id
          }
        });

        const materialFile = await tx.applicationMaterialFile.create({
          data: {
            applicationId: id,
            createdBy: operator.id,
            fileId: fileObject.id,
            fileName: file.originalname,
            materialGroupId: materialGroup.id,
            materialType: dto.materialType,
            mimeType: file.mimetype,
            sizeBytes: BigInt(file.size),
            updatedBy: operator.id,
            uploadedBy: operator.id
          }
        });

        materialFiles.push(materialFile);
      }

      await tx.applicationActionLog.create({
        data: {
          actionType: ApplicationActionType.UPLOAD_MATERIAL_FILE,
          applicationId: id,
          comment: buildPortalMaterialActionComment(
            dto.materialType,
            materialFiles.map((file) => file.fileName),
            dto.remark
          ),
          createdBy: operator.id,
          materialFileId: materialFiles[0]?.id,
          materialGroupId: materialGroup.id,
          operatorId: operator.id,
          operatorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          toStatus: application.status,
          updatedBy: operator.id
        }
      });

      return tx.applicationMaterialGroup.findUniqueOrThrow({
        include: portalApplicationInclude.materialGroups.include,
        where: { id: materialGroup.id }
      });
    });

    const view = toPortalMaterialGroupView(group);
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: {
        ...view,
        customerAccountId: currentCustomer.customerAccountId,
        customerId: currentCustomer.customerId
      },
      entityId: group.id,
      entityType: "portal_application_material_group",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return view;
  }

  async previewMaterialFile(
    id: string,
    materialFileId: string,
    currentCustomer: CurrentCustomer
  ): Promise<MaterialPreview> {
    const materialFile = await this.prisma.applicationMaterialFile.findFirst({
      include: { file: true },
      where: {
        applicationId: id,
        application: {
          applicationSource: ApplicationSource.SELF_SERVICE,
          customerId: currentCustomer.customerId,
          deletedAt: null
        },
        id: materialFileId,
        isDeleted: false
      }
    });

    if (!materialFile) {
      throw new NotFoundException("申请材料不存在。");
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

  private async getProfileMaterialCompleteness(customerId: string) {
    const materials = await this.prisma.customerProfileMaterial.findMany({
      select: {
        deletedAt: true,
        materialStatus: true,
        materialType: true
      },
      where: {
        customerId,
        deletedAt: null
      }
    });

    return buildCustomerProfileMaterialCompleteness(materials);
  }

  private async getApplicationProfileReadiness(customerId: string) {
    const customer = await this.getApplicationProfileSource(customerId);
    return buildCustomerApplicationProfileReadiness(customer);
  }

  private async getApplicationProfileSource(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      select: {
        id: true,
        identity: {
          select: {
            idCardNo: true
          }
        },
        mobile: true,
        name: true,
        profile: {
          select: {
            emergencyContactMobile: true,
            emergencyContactName: true,
            residenceCity: true,
            residenceDetail: true,
            residenceDistrict: true,
            residenceProvince: true
          }
        },
        sourceChannel: true
      },
      where: { id: customerId }
    });
    if (!customer) {
      throw new NotFoundException("Customer not found.");
    }
    return customer;
  }

  private async copyProfileMaterialsToApplication(
    applicationId: string,
    currentCustomer: CurrentCustomer,
    operator: RequestUser
  ) {
    const materials = await this.prisma.customerProfileMaterial.findMany({
      orderBy: [{ materialType: "asc" }, { createdAt: "asc" }],
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        materialStatus: CustomerProfileMaterialStatus.ACTIVE
      }
    });

    const reusableMaterials = materials.filter((material) => material.bucket && material.objectKey);
    if (reusableMaterials.length === 0) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      for (const material of reusableMaterials) {
        const applicationMaterialType = toApplicationMaterialType(material.materialType);
        const materialGroup = await tx.applicationMaterialGroup.upsert({
          create: {
            applicationId,
            createdBy: operator.id,
            materialName: MATERIAL_TYPE_LABELS[applicationMaterialType],
            materialType: applicationMaterialType,
            required: REQUIRED_MATERIAL_TYPES.includes(applicationMaterialType),
            updatedBy: operator.id
          },
          update: {
            materialName: MATERIAL_TYPE_LABELS[applicationMaterialType],
            required: REQUIRED_MATERIAL_TYPES.includes(applicationMaterialType),
            updatedBy: operator.id
          },
          where: {
            applicationId_materialType: {
              applicationId,
              materialType: applicationMaterialType
            }
          }
        });

        const label = getCustomerProfileMaterialLabel(material.materialType);
        const originalName = material.originalName ?? material.fileName;
        const fileName = `客户资料中心 - ${label} - ${originalName}`;
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: material.bucket ?? "",
            mimeType: material.mimeType,
            objectKey: material.objectKey ?? "",
            originalName,
            sizeBytes: BigInt(material.fileSize ?? 0),
            uploadedBy: operator.id
          }
        });

        const materialFile = await tx.applicationMaterialFile.create({
          data: {
            applicationId,
            createdBy: operator.id,
            fileId: fileObject.id,
            fileName,
            materialGroupId: materialGroup.id,
            materialType: applicationMaterialType,
            mimeType: material.mimeType,
            sizeBytes: BigInt(material.fileSize ?? 0),
            updatedBy: operator.id,
            uploadedBy: operator.id
          }
        });

        await tx.applicationActionLog.create({
          data: {
            actionType: ApplicationActionType.UPLOAD_MATERIAL_FILE,
            applicationId,
            comment: `来自客户资料中心：${label} - ${originalName}`,
            createdBy: operator.id,
            materialFileId: materialFile.id,
            materialGroupId: materialGroup.id,
            operatorId: operator.id,
            operatorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
            toStatus: ApplicationStatus.SUBMITTED,
            updatedBy: operator.id
          }
        });
      }
    });
  }

  private async findOwnedApplicationOrThrow(id: string, customerId: string) {
    const application = await this.prisma.application.findFirst({
      include: portalApplicationInclude,
      where: {
        ...portalApplicationSourceScope,
        customerId,
        deletedAt: null,
        id
      }
    });

    if (!application) {
      throw new NotFoundException("申请不存在。");
    }

    return application;
  }

  private async resolvePortalApplicationOperator(customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      select: { ownerUserId: true },
      where: { deletedAt: null, id: customerId }
    });

    if (!customer) {
      throw new NotFoundException("客户不存在。");
    }

    const configuredUserId = this.configService.get<string>("PORTAL_APPLICATION_OWNER_USER_ID");
    const ownerUser = await this.findActiveUser(customer.ownerUserId);
    const configuredUser = ownerUser ? null : await this.findActiveUser(configuredUserId);
    const user = ownerUser ?? configuredUser;

    if (user) {
      return toRequestUser(user);
    }

    const fallbackUser = await this.prisma.user.findFirst({
      orderBy: { createdAt: "asc" },
      where: {
        deletedAt: null,
        status: UserStatus.ACTIVE
      }
    });

    if (!fallbackUser) {
      throw new BadRequestException("客户门户暂未配置申请归属人员，请联系平台处理。");
    }

    return toRequestUser(fallbackUser);
  }

  private async resolveApplicationSalesUser(userId: string) {
    const user = await this.findActiveUser(userId);

    if (!user) {
      throw new BadRequestException("申请归属人员不可用，请联系平台处理。");
    }

    return toRequestUser(user);
  }

  private async findActiveUser(userId?: string | null) {
    if (!userId) {
      return null;
    }

    return this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        id: userId,
        status: UserStatus.ACTIVE
      }
    });
  }
}

const portalApplicationSourceScope = {
  OR: [
    { applicationSource: ApplicationSource.SELF_SERVICE },
    { subscriptionJourney: { isNot: null } }
  ]
} satisfies Prisma.ApplicationWhereInput;

function toRequestUser(user: { id: string; name: string; username: string }): RequestUser {
  return {
    id: user.id,
    menus: [],
    name: user.name,
    permissions: [],
    roles: [],
    username: user.username
  };
}

function toPortalApplicationListItem(application: PortalApplication) {
  const intent = parseIntentSnapshot(application.intentSnapshot);
  return {
    applicationNo: application.applicationNo,
    createdAt: application.createdAt,
    depositStatus: application.depositStatus,
    id: application.id,
    plan: intent.plan,
    planConfirmStatus: application.planConfirmStatus,
    reviewStatus: {
      credit: application.creditReviewStatus,
      material: application.materialReviewStatus,
      product: application.productReviewStatus,
      vehicle: application.vehicleReviewStatus
    },
    status: application.status,
    submittedAt: application.submittedAt,
    vehicle: intent.vehicle
  };
}

function toPortalApplicationDetail(
  application: PortalApplication,
  materialCompleteness: CustomerProfileMaterialCompleteness
) {
  return {
    ...toPortalApplicationListItem(application),
    canCancel:
      PORTAL_CUSTOMER_MUTABLE_APPLICATION_STATUSES.includes(application.status) &&
      application.orders.length === 0,
    finalDepositAmount:
      application.finalDepositAmount === null ? null : Number(application.finalDepositAmount),
    materialComplete: materialCompleteness.complete,
    materials: application.materialGroups.map(toPortalMaterialGroupView),
    missingMaterials: materialCompleteness.missingMaterials,
    nextStepHint: buildApplicationNextStepHint(application),
    ordersGenerated: Boolean(findActivePortalOrder(application)),
    profileMaterialsAvailable: materialCompleteness.completedCount > 0,
    rejectedReason: application.rejectedReason,
    salesUser: application.salesUser
      ? {
          name: application.salesUser.name
        }
      : null,
    softReservationExpiresAt: application.softReservationExpiresAt
  };
}

function toPortalApplicationPrecheck(
  materialCompleteness: CustomerProfileMaterialCompleteness,
  profileReadiness: CustomerApplicationProfileReadiness
) {
  return {
    actions: [
      ...(profileReadiness.complete
        ? []
        : [
            {
              key: "COMPLETE_PROFILE",
              label: "Complete identity profile",
              url: "/portal/me"
            }
          ]),
      {
        key: "UPLOAD_MATERIALS",
        label: "去补充资料",
        url: "/portal/materials"
      },
      {
        key: "CONTINUE_SUBMIT",
        label: "继续提交，稍后补充"
      }
    ],
    canSubmit: materialCompleteness.canSubmit && profileReadiness.complete,
    materialComplete: materialCompleteness.complete,
    missingProfileFields: profileReadiness.missingFields,
    missingMaterials: materialCompleteness.missingMaterials,
    profileComplete: profileReadiness.complete,
    warnings: materialCompleteness.complete ? [] : ["为加快审核，建议先补充身份证和驾驶证资料。"]
  };
}

function toPortalApplicationProgress(application: PortalApplication) {
  const nextAction = resolvePortalNextAction(application);
  const steps = buildPortalProgressSteps(application);
  const currentStep =
    steps.find((step) => step.status === "CURRENT")?.key ??
    steps.find((step) => step.status === "FAILED")?.key ??
    [...steps].reverse().find((step) => step.status === "DONE")?.key ??
    "SUBMITTED";

  return {
    applicationId: application.id,
    applicationNo: application.applicationNo,
    currentStep,
    materialSupplementHints: buildMaterialSupplementHints(application),
    nextAction,
    nextActionTarget: resolvePortalNextActionTarget(application),
    overallStatus: resolvePortalOverallStatus(application, nextAction),
    steps
  };
}

function toPortalFinalPlanView(application: PortalApplication) {
  if (!isPortalFinalPlanReady(application)) {
    return {
      applicationId: application.id,
      applicationNo: application.applicationNo,
      finalPlanStatus: "NOT_READY",
      nextAction: resolvePortalNextAction(application)
    };
  }

  const snapshot = asRecord(application.finalPlanSnapshot);
  const pricing = asRecord(snapshot.pricing);
  const vehicleSnapshot = asRecord(snapshot.vehicleSnapshot);
  const subscriptionPlan = asRecord(snapshot.subscriptionPlan);
  const packageSnapshot = asRecord(snapshot.packageSnapshot);
  const periodMonths = numberOrNull(snapshot.periodMonths) ?? application.finalPeriodMonths;
  const monthlyFeeAmount = numberOrNull(pricing.monthlyFeeAmount);
  const finalDepositAmount =
    numberOrNull(snapshot.depositAmount) ??
    (application.finalDepositAmount === null ? null : Number(application.finalDepositAmount));

  return {
    applicationId: application.id,
    applicationNo: application.applicationNo,
    finalPlanRevision: application.finalPlanRevision,
    changes: buildFinalPlanChanges(application, {
      finalDepositAmount,
      monthlyFeeAmount,
      periodMonths,
      subscriptionPlanId: stringOrNull(snapshot.subscriptionPlanId),
      vehicleId: stringOrNull(snapshot.vehicleId)
    }),
    finalPlanStatus: mapPortalFinalPlanStatus(application.planConfirmStatus),
    importantNotes: buildFinalPlanImportantNotes(application),
    nextAction: resolvePortalNextAction(application),
    pricing: {
      currency: "CNY",
      finalDepositAmount,
      monthlyFeeAmount
    },
    rejectedReason: application.rejectedReason,
    subscriptionPlan: {
      packageSummary: buildPackageSummary(packageSnapshot),
      periodMonths,
      planName: stringOrNull(subscriptionPlan.planName),
      planNo: stringOrNull(subscriptionPlan.planNo)
    },
    vehicle: {
      batteryCapacityKwh: numberOrNull(vehicleSnapshot.batteryCapacityKwh),
      batteryUsageType: stringOrNull(vehicleSnapshot.batteryUsageType),
      batteryUsageTypeLabel: stringOrNull(vehicleSnapshot.batteryUsageTypeLabel),
      brand: stringOrNull(vehicleSnapshot.brand),
      city: stringOrNull(vehicleSnapshot.assetLocation),
      currentMileageKm: numberOrNull(vehicleSnapshot.currentMileageKm),
      displayName: buildSnapshotVehicleDisplayName(vehicleSnapshot),
      model: stringOrNull(vehicleSnapshot.model),
      modelCode: stringOrNull(vehicleSnapshot.modelCodeSnapshot),
      modelDefinitionId: stringOrNull(vehicleSnapshot.modelDefinitionIdSnapshot),
      modelDisplayName: stringOrNull(vehicleSnapshot.modelDisplayNameSnapshot),
      modelYear: numberOrNull(vehicleSnapshot.modelYear),
      series: stringOrNull(vehicleSnapshot.series)
    }
  };
}

function buildPortalProgressSteps(application: PortalApplication) {
  const materialStatus = mapReviewStepStatus(application.materialReviewStatus, true);
  const creditStatus = mapReviewStepStatus(
    application.creditReviewStatus,
    isStepDone(materialStatus)
  );
  const depositStatus = mapDepositStepStatus(
    application.depositStatus,
    isStepDone(materialStatus) && isStepDone(creditStatus)
  );
  const productStatus = mapReviewStepStatus(
    application.productReviewStatus,
    isStepDone(depositStatus)
  );
  const vehicleStatus = mapReviewStepStatus(
    application.vehicleReviewStatus,
    isStepDone(productStatus)
  );
  const finalPlanStatus = mapFinalPlanStepStatus(application, isStepDone(vehicleStatus));
  const orderStage = resolvePortalOrderStage(findActivePortalOrder(application));
  const orderStatus = mapOrderStepStatus(orderStage, isStepDone(finalPlanStatus));
  const contractStatus = mapContractStepStatus(orderStage);
  const paymentStatus = mapPaymentStepStatus(orderStage);
  const deliveryStatus = mapDeliveryStepStatus(orderStage);
  const activeStatus = mapActiveStepStatus(orderStage);

  if (application.status === ApplicationStatus.CANCELLED) {
    return [
      buildProgressStep(
        "SUBMITTED",
        "已提交",
        "DONE",
        application.submittedAt ?? application.createdAt
      ),
      buildProgressStep("CANCELLED", "已取消", "CURRENT", application.updatedAt, "申请已取消。")
    ];
  }

  if (application.status === ApplicationStatus.REJECTED) {
    return [
      buildProgressStep(
        "SUBMITTED",
        "已提交",
        "DONE",
        application.submittedAt ?? application.createdAt
      ),
      buildProgressStep(
        "REJECTED",
        "已拒绝",
        "FAILED",
        application.updatedAt,
        application.rejectedReason ?? "申请未通过。"
      )
    ];
  }

  return [
    buildProgressStep(
      "SUBMITTED",
      "已提交",
      "DONE",
      application.submittedAt ?? application.createdAt
    ),
    buildProgressStep(
      "MATERIAL_REVIEW",
      "材料审核",
      materialStatus,
      null,
      buildMaterialStepMessage(application)
    ),
    buildProgressStep(
      "CREDIT_REVIEW",
      "信用审核",
      creditStatus,
      null,
      "平台正在审核您的资质与信用情况。"
    ),
    buildProgressStep(
      "DEPOSIT_CONFIRM",
      "押金确认",
      depositStatus,
      null,
      "押金金额将根据审核结果最终确认。"
    ),
    buildProgressStep(
      "PRODUCT_REVIEW",
      "产品方案审核",
      productStatus,
      null,
      "平台正在确认订阅套餐与周期。"
    ),
    buildProgressStep(
      "VEHICLE_REVIEW",
      "车辆库存审核",
      vehicleStatus,
      null,
      "平台正在确认车辆库存占用。"
    ),
    buildProgressStep(
      "FINAL_PLAN",
      "最终方案确认",
      finalPlanStatus,
      application.finalPlanConfirmedAt,
      buildFinalPlanStepMessage(application)
    ),
    buildProgressStep(
      "ORDER",
      "生成正式订单",
      orderStatus,
      null,
      "最终方案确认后，由平台生成正式订单。"
    ),
    buildProgressStep(
      "CONTRACT",
      "待签约",
      contractStatus,
      null,
      "正式订单生成后进入合同签署流程。"
    ),
    buildProgressStep("PAYMENT", "待支付", paymentStatus, null, "合同签署后开放线上支付。"),
    buildProgressStep("DELIVERY", "待交付", deliveryStatus, null, "支付完成后安排交付。"),
    buildProgressStep("ACTIVE", "在租中", activeStatus, null)
  ];
}

function buildProgressStep(
  key: string,
  label: string,
  status: "DONE" | "CURRENT" | "FAILED" | "PENDING",
  time?: Date | null,
  message?: string
) {
  return {
    key,
    label,
    message,
    status,
    time: time?.toISOString() ?? null
  };
}

function resolvePortalNextAction(application: PortalApplication) {
  if (application.status === ApplicationStatus.CANCELLED) {
    return "CANCELLED";
  }
  if (
    application.status === ApplicationStatus.REJECTED ||
    application.planConfirmStatus === PlanConfirmStatus.REJECTED
  ) {
    return "REJECTED";
  }
  if (
    application.status === ApplicationStatus.NEED_MORE_INFO ||
    application.materialReviewStatus === OrderReviewStatus.NEED_MORE_INFO ||
    application.materialGroups.some((group) => group.reviewStatus === MaterialStatus.NEED_MORE_INFO)
  ) {
    return "UPLOAD_MATERIAL";
  }
  if (
    isPortalFinalPlanReady(application) &&
    application.planConfirmStatus === PlanConfirmStatus.PENDING
  ) {
    return "CONFIRM_FINAL_PLAN";
  }
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    switch (resolvePortalOrderStage(findActivePortalOrder(application))) {
      case "NONE":
        return "WAIT_ORDER_CREATION";
      case "ORDER":
        return "WAIT_REVIEW";
      case "CONTRACT":
        return "GO_CONTRACT";
      case "PAYMENT":
        return "GO_PAYMENT";
      case "DELIVERY":
        return "WAIT_DELIVERY";
      case "ACTIVE":
        return findActionableMileageReview(findActivePortalOrder(application))
          ? "SUBMIT_MILEAGE_REVIEW"
          : "NONE";
      case "COMPLETED":
      case "FAILED":
        return "NONE";
    }
  }
  return "WAIT_REVIEW";
}

function portalApplicationSortKey(application: PortalApplication): PortalListSortKey {
  const latestOrder = findActivePortalOrder(application);
  const nextAction = resolvePortalNextAction(application);
  const terminal =
    application.status === ApplicationStatus.CANCELLED ||
    application.status === ApplicationStatus.REJECTED ||
    nextAction === "CANCELLED" ||
    nextAction === "REJECTED" ||
    (latestOrder
      ? PORTAL_APPLICATION_TERMINAL_ORDER_STATUSES.has(latestOrder.orderStatus)
      : false);

  return {
    createdAt: application.createdAt,
    deadlineAt: null,
    id: application.id,
    priority: terminal ? 2 : PORTAL_APPLICATION_ACTIONS.has(nextAction) ? 0 : 1,
    updatedAt: application.updatedAt
  };
}

const PORTAL_VISIBLE_HANDOVER_STATUSES = new Set<VehicleHandoverWorkOrderStatus>([
  VehicleHandoverWorkOrderStatus.EVIDENCE_SUBMITTED,
  VehicleHandoverWorkOrderStatus.CUSTOMER_REVIEWING,
  VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED,
  VehicleHandoverWorkOrderStatus.CUSTOMER_OBJECTED,
  VehicleHandoverWorkOrderStatus.SIGNING,
  VehicleHandoverWorkOrderStatus.CUSTOMER_SIGNED,
  VehicleHandoverWorkOrderStatus.PLATFORM_SEALED,
  VehicleHandoverWorkOrderStatus.FIELD_COMPLETED,
  VehicleHandoverWorkOrderStatus.OPS_REVIEW_PENDING,
  VehicleHandoverWorkOrderStatus.OPS_REVIEWED
]);

function resolvePortalNextActionTarget(application: PortalApplication) {
  if (application.planConfirmStatus !== PlanConfirmStatus.CONFIRMED) {
    return null;
  }

  const order = findActivePortalOrder(application);
  if (!order) {
    return null;
  }
  const orderId = encodeURIComponent(order.id);

  switch (resolvePortalOrderStage(order)) {
    case "ORDER":
      return { label: "查看订单进度", url: `/portal/orders/${orderId}` };
    case "CONTRACT":
      return {
        label: "去签署合同",
        url: order.contractId
          ? `/portal/contracts/${encodeURIComponent(order.contractId)}`
          : "/portal/contracts"
      };
    case "PAYMENT":
      return { label: "去支付", url: `/portal/bills?orderId=${orderId}` };
    case "DELIVERY": {
      const handoverWorkOrder = order.handoverWorkOrders?.[0];
      if (handoverWorkOrder && PORTAL_VISIBLE_HANDOVER_STATUSES.has(handoverWorkOrder.status)) {
        return {
          label: "处理车辆交接",
          url: `/portal/handover-reviews/${encodeURIComponent(handoverWorkOrder.id)}`
        };
      }
      return { label: "查看交付进度", url: `/portal/orders/${orderId}` };
    }
    case "ACTIVE": {
      const mileageReview = findActionableMileageReview(order);
      if (mileageReview) {
        return {
          label: "提交本月里程",
          url: `/portal/mileage-reviews/${encodeURIComponent(mileageReview.id)}`
        };
      }
      return { label: "查看已交付订单", url: `/portal/orders/${orderId}` };
    }
    case "COMPLETED":
      return { label: "查看已交付订单", url: `/portal/orders/${orderId}` };
    case "FAILED":
      return { label: "查看订单", url: `/portal/orders/${orderId}` };
    case "NONE":
      return null;
  }
}

function resolvePortalOverallStatus(application: PortalApplication, nextAction: string) {
  if (nextAction === "CANCELLED") {
    return "CANCELLED";
  }
  if (nextAction === "REJECTED") {
    return "REJECTED";
  }
  if (nextAction === "CONFIRM_FINAL_PLAN") {
    return "PENDING_CUSTOMER_CONFIRMATION";
  }
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    const order = findActivePortalOrder(application);
    switch (resolvePortalOrderStage(order)) {
      case "NONE":
      case "ORDER":
        return "PENDING_ORDER";
      case "CONTRACT":
        return "PENDING_CONTRACT";
      case "PAYMENT":
        return "PENDING_PAYMENT";
      case "DELIVERY":
        return "PENDING_DELIVERY";
      case "ACTIVE":
      case "COMPLETED":
      case "FAILED":
        return order?.orderStatus ?? "APPROVED";
    }
  }
  return application.status === ApplicationStatus.APPROVED ? "APPROVED" : "UNDER_REVIEW";
}

type PortalOrderStage =
  | "NONE"
  | "ORDER"
  | "CONTRACT"
  | "PAYMENT"
  | "DELIVERY"
  | "ACTIVE"
  | "COMPLETED"
  | "FAILED";

const PORTAL_ORDER_STAGE_BY_STATUS = {
  [OrderStatus.PENDING_REVIEW]: "ORDER",
  [OrderStatus.PENDING_CUSTOMER_CONFIRMATION]: "ORDER",
  [OrderStatus.PENDING_CONTRACT]: "CONTRACT",
  [OrderStatus.PENDING_SIGN]: "CONTRACT",
  [OrderStatus.PENDING_PAYMENT]: "PAYMENT",
  [OrderStatus.PENDING_VEHICLE]: "DELIVERY",
  [OrderStatus.PENDING_DELIVERY]: "DELIVERY",
  [OrderStatus.ACTIVE]: "ACTIVE",
  [OrderStatus.SUSPENDED]: "ACTIVE",
  [OrderStatus.PENDING_RETURN]: "ACTIVE",
  [OrderStatus.TERMINATED]: "COMPLETED",
  [OrderStatus.COMPLETED]: "COMPLETED",
  [OrderStatus.CANCELLED]: "FAILED",
  [OrderStatus.REJECTED]: "FAILED"
} satisfies Record<OrderStatus, PortalOrderStage>;

function findActivePortalOrder(application: PortalApplication) {
  return application.orders.find((order) => !order.deletedAt);
}

function findActionableMileageReview(order: PortalApplication["orders"][number] | undefined) {
  if (order?.orderStatus !== OrderStatus.ACTIVE) {
    return null;
  }
  const review = order?.mileageReviews?.[0];
  return review &&
    (review.status === OrderMileageReviewStatus.PENDING_SUBMISSION ||
      review.status === OrderMileageReviewStatus.RETURNED)
    ? review
    : null;
}

function resolvePortalOrderStage(
  order: PortalApplication["orders"][number] | undefined
): PortalOrderStage {
  return order ? PORTAL_ORDER_STAGE_BY_STATUS[order.orderStatus] : "NONE";
}

function mapReviewStepStatus(status: OrderReviewStatus, reachable: boolean) {
  if (status === OrderReviewStatus.APPROVED) {
    return "DONE" as const;
  }
  if (status === OrderReviewStatus.REJECTED) {
    return "FAILED" as const;
  }
  if (status === OrderReviewStatus.NEED_MORE_INFO || reachable) {
    return "CURRENT" as const;
  }
  return "PENDING" as const;
}

function mapDepositStepStatus(status: DepositStatus, reachable: boolean) {
  if (status === DepositStatus.CONFIRMED || status === DepositStatus.WAIVED) {
    return "DONE" as const;
  }
  if (status === DepositStatus.REJECTED) {
    return "FAILED" as const;
  }
  return reachable ? ("CURRENT" as const) : ("PENDING" as const);
}

function mapFinalPlanStepStatus(application: PortalApplication, reachable: boolean) {
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    return "DONE" as const;
  }
  if (application.planConfirmStatus === PlanConfirmStatus.REJECTED) {
    return "FAILED" as const;
  }
  if (isPortalFinalPlanReady(application)) {
    return "CURRENT" as const;
  }
  return reachable ? ("CURRENT" as const) : ("PENDING" as const);
}

function mapOrderStepStatus(orderStage: PortalOrderStage, reachable: boolean) {
  if (orderStage === "FAILED") {
    return "FAILED" as const;
  }
  if (orderStage === "ORDER") {
    return "CURRENT" as const;
  }
  if (orderStage !== "NONE") {
    return "DONE" as const;
  }
  return reachable ? ("CURRENT" as const) : ("PENDING" as const);
}

function mapContractStepStatus(orderStage: PortalOrderStage) {
  if (orderStage === "CONTRACT") {
    return "CURRENT" as const;
  }
  if (["PAYMENT", "DELIVERY", "ACTIVE", "COMPLETED"].includes(orderStage)) {
    return "DONE" as const;
  }
  return "PENDING" as const;
}

function mapPaymentStepStatus(orderStage: PortalOrderStage) {
  if (orderStage === "PAYMENT") {
    return "CURRENT" as const;
  }
  if (["DELIVERY", "ACTIVE", "COMPLETED"].includes(orderStage)) {
    return "DONE" as const;
  }
  return "PENDING" as const;
}

function mapDeliveryStepStatus(orderStage: PortalOrderStage) {
  if (orderStage === "DELIVERY") {
    return "CURRENT" as const;
  }
  if (["ACTIVE", "COMPLETED"].includes(orderStage)) {
    return "DONE" as const;
  }
  return "PENDING" as const;
}

function mapActiveStepStatus(orderStage: PortalOrderStage) {
  if (orderStage === "ACTIVE") {
    return "CURRENT" as const;
  }
  if (orderStage === "COMPLETED") {
    return "DONE" as const;
  }
  return "PENDING" as const;
}

function isStepDone(status: "DONE" | "CURRENT" | "FAILED" | "PENDING") {
  return status === "DONE";
}

function buildMaterialSupplementHints(application: PortalApplication) {
  return application.materialGroups
    .filter((group) => group.reviewStatus === MaterialStatus.NEED_MORE_INFO)
    .map((group) => ({
      materialGroupId: group.id,
      materialName: group.materialName ?? MATERIAL_TYPE_LABELS[group.materialType],
      materialType: group.materialType,
      message: group.reviewComment ?? "请根据平台提示补充或重新上传材料。"
    }));
}

function buildMaterialStepMessage(application: PortalApplication) {
  if (
    application.materialReviewStatus === OrderReviewStatus.NEED_MORE_INFO ||
    application.materialGroups.some((group) => group.reviewStatus === MaterialStatus.NEED_MORE_INFO)
  ) {
    return "请补充平台要求的材料。";
  }
  if (application.materialReviewStatus === OrderReviewStatus.APPROVED) {
    return "材料审核已通过。";
  }
  return "平台正在审核您提交的材料。";
}

function buildFinalPlanStepMessage(application: PortalApplication) {
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    return buildConfirmedApplicationStageMessage(application);
  }
  if (application.planConfirmStatus === PlanConfirmStatus.REJECTED) {
    return application.rejectedReason
      ? `您已拒绝最终方案：${application.rejectedReason}`
      : "您已拒绝最终方案。";
  }
  if (isPortalFinalPlanReady(application)) {
    return "请确认最终签约方案。";
  }
  return "平台审核完成后将展示最终方案。";
}

function isPortalFinalPlanReady(application: PortalApplication) {
  return (
    Boolean(application.finalPlanSnapshot) &&
    application.status === ApplicationStatus.APPROVED &&
    application.depositStatus === DepositStatus.CONFIRMED &&
    application.finalDepositAmount !== null
  );
}

function assertPortalFinalPlanPending(application: PortalApplication) {
  if (!isPortalFinalPlanReady(application)) {
    throw new BadRequestException("最终方案暂未生成，请等待平台审核。");
  }
  if (application.orders.some((order) => !order.deletedAt)) {
    throw new BadRequestException("该申请已生成正式订单，不能重复确认最终方案。");
  }
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    throw new BadRequestException("最终方案已确认，请勿重复确认。");
  }
  if (application.planConfirmStatus === PlanConfirmStatus.REJECTED) {
    throw new BadRequestException("最终方案已拒绝，请等待平台重新处理。");
  }
}

function mapPortalFinalPlanStatus(status: PlanConfirmStatus) {
  if (status === PlanConfirmStatus.PENDING) {
    return "PENDING_CONFIRM";
  }
  return status;
}

function withPortalFinalPlanDecision(
  snapshot: Prisma.JsonValue | null,
  decision: Prisma.InputJsonObject
) {
  const base = asRecord(snapshot);
  const planConfirmStatus = stringOrNull(decision.planConfirmStatus);
  return {
    ...base,
    customerDecision: decision,
    finalPlanConfirmedAt:
      stringOrNull(decision.finalPlanConfirmedAt) ?? stringOrNull(base.finalPlanConfirmedAt),
    planConfirmStatus: planConfirmStatus ?? base.planConfirmStatus
  } as Prisma.InputJsonValue;
}

function buildFinalPlanChanges(
  application: PortalApplication,
  finalPlan: {
    finalDepositAmount: number | null;
    monthlyFeeAmount: number | null;
    periodMonths: number | null;
    subscriptionPlanId: string | null;
    vehicleId: string | null;
  }
) {
  const intent = parseIntentSnapshot(application.intentSnapshot);
  const changes = [
    {
      field: "deposit",
      label: "押金",
      message: "押金金额已根据审核结果确认。"
    }
  ];

  if (intent.vehicle.id && finalPlan.vehicleId && intent.vehicle.id !== finalPlan.vehicleId) {
    changes.push({
      field: "vehicle",
      label: "车辆",
      message: "最终车辆与您提交审核时选择的意向车辆不同，请仔细核对。"
    });
  }
  if (
    intent.plan.id &&
    finalPlan.subscriptionPlanId &&
    intent.plan.id !== finalPlan.subscriptionPlanId
  ) {
    changes.push({
      field: "subscriptionPlan",
      label: "订阅套餐",
      message: "最终套餐与您提交审核时选择的意向套餐不同，请仔细核对。"
    });
  }
  if (
    intent.plan.subscriptionPeriodMonths !== null &&
    finalPlan.periodMonths !== null &&
    intent.plan.subscriptionPeriodMonths !== finalPlan.periodMonths
  ) {
    changes.push({
      field: "period",
      label: "订阅周期",
      message: "订阅周期已根据最终方案调整。"
    });
  }
  if (
    intent.plan.monthlyFeeAmount !== null &&
    finalPlan.monthlyFeeAmount !== null &&
    intent.plan.monthlyFeeAmount !== finalPlan.monthlyFeeAmount
  ) {
    changes.push({
      field: "monthlyFee",
      label: "月租",
      message: "月租金额已根据最终车辆与套餐重新计算。"
    });
  }

  return changes;
}

function buildFinalPlanImportantNotes(application: PortalApplication) {
  if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
    return [buildConfirmedApplicationStageMessage(application)];
  }
  if (application.planConfirmStatus === PlanConfirmStatus.REJECTED) {
    return ["您已拒绝当前最终方案，平台将联系您或重新处理方案。"];
  }
  return ["请确认最终签约方案。确认后由平台生成正式订单，再进入合同签署流程。"];
}

function buildPackageSummary(packageSnapshot: Record<string, unknown>) {
  return [
    packageName(asRecord(packageSnapshot.vehiclePackage)),
    packageName(asRecord(packageSnapshot.mileagePackage)),
    packageName(asRecord(packageSnapshot.energyPackage)),
    packageName(asRecord(packageSnapshot.benefitPackage))
  ].filter((text): text is string => Boolean(text));
}

function packageName(value: Record<string, unknown>) {
  return stringOrNull(value.packageName) ?? stringOrNull(value.name);
}

function toPortalMaterialGroupView(group: PortalMaterialGroup) {
  return {
    files: group.files
      .filter((file) => !file.isDeleted)
      .map((file) => {
        const source = isCustomerProfileMaterialObjectKey(file.file.objectKey)
          ? "CUSTOMER_PROFILE"
          : "APPLICATION_UPLOAD";
        return {
          fileName: file.fileName,
          fileRecordId: file.id,
          id: file.id,
          materialType: file.materialType,
          mimeType: file.mimeType,
          previewUrl: `/api/portal/applications/${file.applicationId}/materials/${file.id}/preview`,
          sizeBytes: Number(file.sizeBytes),
          source,
          sourceLabel: source === "CUSTOMER_PROFILE" ? "客户资料中心" : "申请上传",
          uploadedAt: file.uploadedAt
        };
      }),
    id: group.id,
    materialGroupId: group.id,
    materialName: group.materialName ?? MATERIAL_TYPE_LABELS[group.materialType],
    materialType: group.materialType,
    required: group.required,
    reviewComment: group.reviewComment,
    reviewedAt: group.reviewedAt,
    reviewStatus: group.reviewStatus,
    status: group.reviewStatus
  };
}

function parseIntentSnapshot(snapshot: Prisma.JsonValue) {
  const intent = asRecord(snapshot);
  const packageSnapshot = asRecord(intent.packageSnapshot);
  const pricing = asRecord(packageSnapshot.pricing);
  const subscriptionPlan = asRecord(packageSnapshot.subscriptionPlan);
  const vehicleSnapshot = asRecord(intent.vehicleSnapshot);
  const vehicle = {
    batteryCapacityKwh: numberOrNull(vehicleSnapshot.batteryCapacityKwh),
    batteryUsageType: stringOrNull(vehicleSnapshot.batteryUsageType),
    batteryUsageTypeLabel: stringOrNull(vehicleSnapshot.batteryUsageTypeLabel),
    brand: stringOrNull(vehicleSnapshot.brand),
    city: stringOrNull(vehicleSnapshot.assetLocation),
    currentMileageKm: numberOrNull(vehicleSnapshot.currentMileageKm),
    displayName: buildSnapshotVehicleDisplayName(vehicleSnapshot),
    id: stringOrNull(intent.vehicleId),
    model: stringOrNull(vehicleSnapshot.model),
    modelCode: stringOrNull(vehicleSnapshot.modelCodeSnapshot),
    modelDefinitionId: stringOrNull(vehicleSnapshot.modelDefinitionIdSnapshot),
    modelDisplayName: stringOrNull(vehicleSnapshot.modelDisplayNameSnapshot),
    series: stringOrNull(vehicleSnapshot.series)
  };
  const plan = {
    depositDescription:
      stringOrNull(intent.depositDescription) ?? "押金金额将根据审核结果最终确认。",
    id: stringOrNull(intent.subscriptionPlanId),
    monthlyFeeAmount: numberOrNull(pricing.monthlyFeeAmount),
    monthlyFeeDescription:
      numberOrNull(pricing.monthlyFeeAmount) === null
        ? "审核后确认"
        : `预估月租 ${formatMoney(numberOrNull(pricing.monthlyFeeAmount)!)} / 月`,
    planName: stringOrNull(subscriptionPlan.planName),
    subscriptionPeriodMonths: numberOrNull(intent.periodMonths)
  };

  return { plan, vehicle };
}

function buildSnapshotVehicleDisplayName(vehicleSnapshot: Record<string, unknown>) {
  const canonicalDisplayName = stringOrNull(vehicleSnapshot.modelDisplayNameSnapshot);
  if (canonicalDisplayName) {
    return canonicalDisplayName;
  }

  return [
    stringOrNull(vehicleSnapshot.brand),
    stringOrNull(vehicleSnapshot.series),
    stringOrNull(vehicleSnapshot.model)
  ]
    .filter(Boolean)
    .join(" ");
}

function buildApplicationNextStepHint(application: PortalApplication) {
  if (application.status === ApplicationStatus.SUBMITTED) {
    return "申请已提交，平台将进行材料、信用、产品和车辆审核。";
  }
  if (application.status === ApplicationStatus.NEED_MORE_INFO) {
    return "请根据平台提示补充材料。";
  }
  if (application.status === ApplicationStatus.APPROVED) {
    if (application.planConfirmStatus === PlanConfirmStatus.CONFIRMED) {
      return buildConfirmedApplicationStageMessage(application);
    }
    return "审核已通过，最终方案确认将在下一阶段开放。";
  }
  if (application.status === ApplicationStatus.REJECTED) {
    return "申请未通过，如有疑问请联系平台。";
  }
  if (application.status === ApplicationStatus.CANCELLED) {
    return "申请已取消。";
  }
  return "请等待平台处理。";
}

function buildConfirmedApplicationStageMessage(application: PortalApplication) {
  const order = findActivePortalOrder(application);
  switch (resolvePortalOrderStage(order)) {
    case "NONE":
      return "已确认最终方案，等待平台生成正式订单。";
    case "ORDER":
      return "正式订单已生成，等待平台审核。";
    case "CONTRACT":
      return "正式订单已生成，等待合同签署。";
    case "PAYMENT":
      return "合同已签署，等待支付。";
    case "DELIVERY":
      return "订单已完成签约支付，等待车辆交付。";
    case "ACTIVE":
      return order?.orderStatus === OrderStatus.SUSPENDED
        ? "订阅服务当前已暂停。"
        : "订阅服务进行中。";
    case "COMPLETED":
      return "订阅流程已结束。";
    case "FAILED":
      return "正式订单已取消或未通过，请联系平台。";
  }
}

function buildPortalMaterialActionComment(
  materialType: ApplicationMaterialType,
  fileNames: string[],
  remark?: string
) {
  const text = `客户门户上传材料：${MATERIAL_TYPE_LABELS[materialType]} - ${fileNames.join(", ")}`;
  const normalizedRemark = normalizeOptionalText(remark);
  return normalizedRemark ? `${text}; ${normalizedRemark}` : text;
}

function isRequiredMaterialType(type: ApplicationMaterialType) {
  return REQUIRED_MATERIAL_TYPES.includes(type);
}

function normalizeOptionalText(value?: string) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMoney(amount: number) {
  return `¥${(amount / 100).toLocaleString("zh-CN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  })}`;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

const MATERIAL_TYPE_LABELS: Record<ApplicationMaterialType, string> = {
  BANK_FLOW: "银行流水",
  CREDIT_AUTH: "征信授权",
  DRIVER_LICENSE: "驾驶证",
  ID_CARD: "身份证",
  OTHER: "其他",
  RESIDENCE_PROOF: "居住证明",
  WORK_PROOF: "工作证明"
};

const PORTAL_CUSTOMER_MUTABLE_APPLICATION_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.NEED_MORE_INFO
];

const REQUIRED_MATERIAL_TYPES: ApplicationMaterialType[] = [
  ApplicationMaterialType.ID_CARD,
  ApplicationMaterialType.DRIVER_LICENSE
];
