import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApplicationActionType,
  ApplicationMaterialType,
  ApplicationSource,
  ApplicationStatus,
  AuditAction,
  Prisma,
  UserStatus
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/auth.types";
import { CustomerService, MaterialPreview, UploadedMaterialFile } from "../customer/customer.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import {
  CreatePortalSelfServiceApplicationDto,
  UploadPortalApplicationMaterialDto
} from "./portal-application.dto";

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
      deletedAt: true,
      id: true,
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
  }
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

  async createApplication(
    dto: CreatePortalSelfServiceApplicationDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const operator = await this.resolvePortalApplicationOperator(currentCustomer.customerId);
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
      message: result.message,
      status: result.status,
      vehicleStatus: result.vehicleStatus
    };
  }

  async listApplications(currentCustomer: CurrentCustomer) {
    const applications = await this.prisma.application.findMany({
      include: portalApplicationInclude,
      orderBy: { createdAt: "desc" },
      where: {
        applicationSource: ApplicationSource.SELF_SERVICE,
        customerId: currentCustomer.customerId,
        deletedAt: null
      }
    });

    return applications.map(toPortalApplicationListItem);
  }

  async getApplication(id: string, currentCustomer: CurrentCustomer) {
    const application = await this.findOwnedApplicationOrThrow(id, currentCustomer.customerId);
    return toPortalApplicationDetail(application);
  }

  async cancelApplication(id: string, currentCustomer: CurrentCustomer, context: PortalRequestContext) {
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
          comment: buildPortalMaterialActionComment(dto.materialType, materialFiles.map((file) => file.fileName), dto.remark),
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

  private async findOwnedApplicationOrThrow(id: string, customerId: string) {
    const application = await this.prisma.application.findFirst({
      include: portalApplicationInclude,
      where: {
        applicationSource: ApplicationSource.SELF_SERVICE,
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

function toPortalApplicationDetail(application: PortalApplication) {
  return {
    ...toPortalApplicationListItem(application),
    canCancel: PORTAL_CUSTOMER_MUTABLE_APPLICATION_STATUSES.includes(application.status) &&
      application.orders.length === 0,
    finalDepositAmount:
      application.finalDepositAmount === null ? null : Number(application.finalDepositAmount),
    materials: application.materialGroups.map(toPortalMaterialGroupView),
    nextStepHint: buildApplicationNextStepHint(application),
    ordersGenerated: application.orders.length > 0,
    rejectedReason: application.rejectedReason,
    salesUser: application.salesUser
      ? {
          name: application.salesUser.name
        }
      : null,
    softReservationExpiresAt: application.softReservationExpiresAt
  };
}

function toPortalMaterialGroupView(group: PortalMaterialGroup) {
  return {
    files: group.files
      .filter((file) => !file.isDeleted)
      .map((file) => ({
        fileName: file.fileName,
        fileRecordId: file.id,
        id: file.id,
        materialType: file.materialType,
        mimeType: file.mimeType,
        previewUrl: `/api/portal/applications/${file.applicationId}/materials/${file.id}/preview`,
        sizeBytes: Number(file.sizeBytes),
        uploadedAt: file.uploadedAt
      })),
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
    model: stringOrNull(vehicleSnapshot.vehicleModel),
    series: stringOrNull(vehicleSnapshot.series)
  };
  const plan = {
    depositDescription: stringOrNull(intent.depositDescription) ?? "押金金额将根据审核结果最终确认。",
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
  return [
    stringOrNull(vehicleSnapshot.brand),
    stringOrNull(vehicleSnapshot.series),
    stringOrNull(vehicleSnapshot.vehicleModel)
  ].filter(Boolean).join(" ");
}

function buildApplicationNextStepHint(application: PortalApplication) {
  if (application.status === ApplicationStatus.SUBMITTED) {
    return "申请已提交，平台将进行材料、信用、产品和车辆审核。";
  }
  if (application.status === ApplicationStatus.NEED_MORE_INFO) {
    return "请根据平台提示补充材料。";
  }
  if (application.status === ApplicationStatus.APPROVED) {
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
    ? value as Record<string, unknown>
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
