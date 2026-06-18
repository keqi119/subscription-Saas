import {
  BadRequestException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  ServiceCaseActionType,
  ServiceCaseActorType,
  ServiceCaseAttachmentType,
  ServiceCaseSource,
  ServiceCaseStatus,
  ServiceCaseType
} from "@prisma/client";
import type { Readable } from "node:stream";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CurrentCustomer, PortalRequestContext } from "../portal/portal-auth.types";
import {
  AcceptServiceCaseDto,
  AddServiceCaseActionDto,
  AdminServiceCasesQueryDto,
  CancelPortalServiceCaseDto,
  CloseServiceCaseDto,
  CreatePortalServiceCaseDto,
  PortalServiceCasesQueryDto,
  UpdateServiceCaseStatusDto
} from "./dto/service-case.dto";

export interface UploadedServiceCaseFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

export interface ServiceCasePreview {
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
  stream: Readable;
}

const serviceCaseInclude = {
  actions: {
    orderBy: { createdAt: "asc" as const }
  },
  attachments: {
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  customer: {
    select: {
      customerNo: true,
      id: true,
      mobile: true,
      name: true
    }
  },
  order: {
    select: {
      id: true,
      orderNo: true,
      orderStatus: true
    }
  },
  vehicle: {
    select: {
      assetLocation: true,
      batteryCapacityKwh: true,
      batteryUsageType: true,
      brand: true,
      currentMileageKm: true,
      id: true,
      model: true,
      modelYear: true,
      series: true,
      vehicleModel: true
    }
  }
} satisfies Prisma.ServiceCaseInclude;

type ServiceCaseWithRelations = Prisma.ServiceCaseGetPayload<{ include: typeof serviceCaseInclude }>;

const PORTAL_ALLOWED_CASE_TYPES = new Set<ServiceCaseType>([
  ServiceCaseType.ACCIDENT_REPORT,
  ServiceCaseType.RESCUE_REQUEST
]);

const PORTAL_CANCELABLE_STATUSES = new Set<ServiceCaseStatus>([
  ServiceCaseStatus.SUBMITTED,
  ServiceCaseStatus.ACCEPTED
]);

const ADMIN_STATUS_TRANSITIONS: Partial<Record<ServiceCaseStatus, ServiceCaseStatus[]>> = {
  [ServiceCaseStatus.ACCEPTED]: [ServiceCaseStatus.IN_PROGRESS],
  [ServiceCaseStatus.IN_PROGRESS]: [
    ServiceCaseStatus.WAITING_CUSTOMER,
    ServiceCaseStatus.RESOLVED
  ],
  [ServiceCaseStatus.RESOLVED]: [ServiceCaseStatus.CLOSED],
  [ServiceCaseStatus.WAITING_CUSTOMER]: [ServiceCaseStatus.IN_PROGRESS]
};

@Injectable()
export class ServiceCaseService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService
  ) {}

  async createPortalServiceCase(
    dto: CreatePortalServiceCaseDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.validatePortalCreateDto(dto);

    const order = await this.prisma.subscriptionOrder.findFirst({
      include: {
        customer: { select: { customerNo: true, id: true, mobile: true, name: true } },
        vehicle: {
          select: {
            assetLocation: true,
            batteryCapacityKwh: true,
            batteryUsageType: true,
            brand: true,
            currentMileageKm: true,
            id: true,
            model: true,
            modelYear: true,
            series: true,
            vehicleModel: true
          }
        }
      },
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null,
        id: dto.orderId
      }
    });

    if (!order) {
      throw new NotFoundException("订单不存在或不属于当前客户。");
    }

    const customerSnapshot = buildCustomerSnapshot(order.customer);
    const orderSnapshot = buildOrderSnapshot(order);
    const vehicleSnapshot = buildVehicleSnapshot(order.vehicle);

    const created = await withUniqueBusinessNoRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const serviceCase = await tx.serviceCase.create({
          data: {
            accidentHasInjury:
              dto.caseType === ServiceCaseType.ACCIDENT_REPORT ? dto.accidentHasInjury ?? null : null,
            accidentPoliceReported:
              dto.caseType === ServiceCaseType.ACCIDENT_REPORT ? dto.accidentPoliceReported ?? null : null,
            caseNo: createBusinessNo("SC"),
            caseSource: ServiceCaseSource.CUSTOMER_PORTAL,
            caseStatus: ServiceCaseStatus.SUBMITTED,
            caseType: dto.caseType,
            contactName: emptyToNull(dto.contactName),
            contactPhone: emptyToNull(dto.contactPhone),
            createdBy: currentCustomer.customerAccountId,
            customerId: currentCustomer.customerId,
            customerSnapshot: toJsonValue(customerSnapshot),
            description: emptyToNull(dto.description),
            insuranceReportNo:
              dto.caseType === ServiceCaseType.ACCIDENT_REPORT
                ? emptyToNull(dto.insuranceReportNo)
                : null,
            latitude: dto.latitude ?? null,
            locationText: emptyToNull(dto.locationText),
            longitude: dto.longitude ?? null,
            occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : null,
            orderId: order.id,
            orderSnapshot: toJsonValue(orderSnapshot),
            rescueAddress:
              dto.caseType === ServiceCaseType.RESCUE_REQUEST ? emptyToNull(dto.rescueAddress) : null,
            rescueType:
              dto.caseType === ServiceCaseType.RESCUE_REQUEST ? dto.rescueType ?? null : null,
            snapshot: toJsonValue({
              submittedFrom: "portal",
              customerAccountId: currentCustomer.customerAccountId
            }),
            title: emptyToNull(dto.title) ?? defaultTitle(dto.caseType),
            updatedBy: currentCustomer.customerAccountId,
            vehicleId: order.vehicleId,
            vehicleSnapshot: toJsonValue(vehicleSnapshot)
          }
        });

        await tx.serviceCaseAction.create({
          data: {
            actionType: ServiceCaseActionType.SUBMIT,
            actorId: currentCustomer.customerAccountId,
            actorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
            actorType: ServiceCaseActorType.CUSTOMER,
            remark: "客户通过门户提交服务工单。",
            serviceCaseId: serviceCase.id,
            toStatus: ServiceCaseStatus.SUBMITTED
          }
        });

        return tx.serviceCase.findUniqueOrThrow({
          include: serviceCaseInclude,
          where: { id: serviceCase.id }
        });
      })
    );

    const view = toServiceCaseView(created, "portal");
    await this.auditService.write({
      action: AuditAction.CREATE,
      after: view,
      entityId: created.id,
      entityType: "service_case",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return view;
  }

  async listPortalServiceCases(currentCustomer: CurrentCustomer, query: PortalServiceCasesQueryDto) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.ServiceCaseWhereInput = {
      caseStatus: query.caseStatus,
      caseType: query.caseType,
      customerId: currentCustomer.customerId,
      deletedAt: null
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.serviceCase.findMany({
        include: serviceCaseInclude,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.serviceCase.count({ where })
    ]);

    return {
      items: items.map((item) => toServiceCaseView(item, "portal")),
      page,
      pageSize,
      total
    };
  }

  async getPortalServiceCase(id: string, currentCustomer: CurrentCustomer) {
    const serviceCase = await this.findOwnedCaseOrThrow(id, currentCustomer.customerId);
    return toServiceCaseView(serviceCase, "portal");
  }

  async cancelPortalServiceCase(
    id: string,
    dto: CancelPortalServiceCaseDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findOwnedCaseOrThrow(id, currentCustomer.customerId);

    if (!PORTAL_CANCELABLE_STATUSES.has(serviceCase.caseStatus)) {
      throw new BadRequestException("当前工单状态不支持客户取消。");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.serviceCase.update({
        data: {
          cancelReason: dto.reason,
          cancelledAt: new Date(),
          caseStatus: ServiceCaseStatus.CANCELLED,
          updatedBy: currentCustomer.customerAccountId
        },
        include: serviceCaseInclude,
        where: { id }
      });

      await tx.serviceCaseAction.create({
        data: {
          actionType: ServiceCaseActionType.CANCEL,
          actorId: currentCustomer.customerAccountId,
          actorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          actorType: ServiceCaseActorType.CUSTOMER,
          fromStatus: serviceCase.caseStatus,
          remark: dto.reason,
          serviceCaseId: id,
          toStatus: ServiceCaseStatus.CANCELLED
        }
      });

      return tx.serviceCase.findUniqueOrThrow({
        include: serviceCaseInclude,
        where: { id }
      });
    });

    const view = toServiceCaseView(updated, "portal");
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: view,
      before: toServiceCaseView(serviceCase, "portal"),
      entityId: id,
      entityType: "service_case",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return view;
  }

  async uploadPortalAttachments(
    id: string,
    files: UploadedServiceCaseFile[] | undefined,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findOwnedCaseOrThrow(id, currentCustomer.customerId);

    if (([ServiceCaseStatus.CLOSED, ServiceCaseStatus.CANCELLED] as ServiceCaseStatus[]).includes(serviceCase.caseStatus)) {
      throw new BadRequestException("当前工单状态不支持继续上传附件。");
    }

    const uploadFiles = (files ?? []).filter((file) => file.buffer?.length);
    if (uploadFiles.length === 0) {
      throw new BadRequestException("请上传附件文件。");
    }

    for (const file of uploadFiles) {
      if (file.mimetype?.startsWith("video/")) {
        throw new BadRequestException("当前阶段暂不支持视频上传，请上传图片或普通文件。");
      }
    }

    const storedFiles = await Promise.all(
      uploadFiles.map(async (file) => ({
        attachmentType: attachmentTypeFromMime(file.mimetype),
        file,
        storage: await this.storageService.putServiceCaseAttachment({
          buffer: file.buffer,
          contentType: file.mimetype,
          originalName: file.originalname,
          serviceCaseId: id
        })
      }))
    );

    const attachments = await this.prisma.$transaction(async (tx) => {
      const rows = [];

      for (const { attachmentType, file, storage } of storedFiles) {
        const row = await tx.serviceCaseAttachment.create({
          data: {
            attachmentType,
            bucket: storage.bucket,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            objectKey: storage.objectKey,
            originalName: file.originalname,
            serviceCaseId: id,
            snapshot: toJsonValue({
              stored: storage.stored
            }),
            uploadedBy: currentCustomer.customerAccountId,
            uploadedByType: ServiceCaseActorType.CUSTOMER
          }
        });
        rows.push(row);
      }

      await tx.serviceCaseAction.create({
        data: {
          actionType: ServiceCaseActionType.UPLOAD_ATTACHMENT,
          actorId: currentCustomer.customerAccountId,
          actorName: `客户门户 ${maskPhone(currentCustomer.phone)}`,
          actorType: ServiceCaseActorType.CUSTOMER,
          fromStatus: serviceCase.caseStatus,
          remark: `客户上传附件：${rows.map((row) => row.fileName).join("、")}`,
          serviceCaseId: id,
          toStatus: serviceCase.caseStatus
        }
      });

      return rows;
    });

    await this.auditService.write({
      action: AuditAction.CREATE,
      after: {
        attachments: attachments.map(toAttachmentView),
        serviceCaseId: id
      },
      entityId: id,
      entityType: "service_case_attachment",
      ipAddress: context.ipAddress,
      module: "portal",
      operatorId: currentCustomer.customerAccountId,
      userAgent: context.userAgent
    });

    return { files: attachments.map(toAttachmentView) };
  }

  async previewPortalAttachment(
    id: string,
    attachmentId: string,
    currentCustomer: CurrentCustomer
  ): Promise<ServiceCasePreview> {
    const attachment = await this.prisma.serviceCaseAttachment.findFirst({
      where: {
        deletedAt: null,
        id: attachmentId,
        serviceCaseId: id,
        serviceCase: {
          customerId: currentCustomer.customerId,
          deletedAt: null
        }
      }
    });

    if (!attachment?.bucket || !attachment.objectKey) {
      throw new NotFoundException("工单附件不存在。");
    }

    const storedObject = await this.storageService.getObject(attachment.bucket, attachment.objectKey);

    return {
      filename: attachment.fileName,
      mimeType: attachment.mimeType ?? storedObject.contentType,
      sizeBytes: storedObject.contentLength ?? attachment.fileSize ?? 0,
      stream: storedObject.stream
    };
  }

  async listAdminServiceCases(query: AdminServiceCasesQueryDto) {
    const page = normalizePage(query.page);
    const pageSize = normalizePageSize(query.pageSize);
    const where: Prisma.ServiceCaseWhereInput = {
      caseStatus: query.caseStatus,
      caseType: query.caseType,
      customerId: query.customerId,
      deletedAt: null,
      orderId: query.orderId,
      priority: query.priority,
      vehicleId: query.vehicleId
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.serviceCase.findMany({
        include: serviceCaseInclude,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        where
      }),
      this.prisma.serviceCase.count({ where })
    ]);

    return {
      items: items.map((item) => toServiceCaseView(item, "admin")),
      page,
      pageSize,
      total
    };
  }

  async getAdminServiceCase(id: string) {
    const serviceCase = await this.findCaseOrThrow(id);
    return toServiceCaseView(serviceCase, "admin");
  }

  async acceptServiceCase(
    id: string,
    dto: AcceptServiceCaseDto,
    user: RequestUser,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findCaseOrThrow(id);

    if (serviceCase.caseStatus !== ServiceCaseStatus.SUBMITTED) {
      throw new BadRequestException("只有已提交工单可以受理。");
    }

    return this.updateAdminStatus(
      serviceCase,
      {
        acceptedAt: new Date(),
        assignedTo: dto.assignedTo ?? user.id,
        caseStatus: ServiceCaseStatus.ACCEPTED,
        updatedBy: user.id
      },
      {
        actionType: ServiceCaseActionType.ACCEPT,
        remark: dto.remark ?? "后台已受理工单。",
        toStatus: ServiceCaseStatus.ACCEPTED
      },
      user,
      context
    );
  }

  async updateServiceCaseStatus(
    id: string,
    dto: UpdateServiceCaseStatusDto,
    user: RequestUser,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findCaseOrThrow(id);
    const allowedTargets = ADMIN_STATUS_TRANSITIONS[serviceCase.caseStatus] ?? [];

    if (!allowedTargets.includes(dto.toStatus)) {
      throw new BadRequestException("当前工单状态不支持该流转。");
    }

    const timestamps: Prisma.ServiceCaseUpdateInput = {};
    if (dto.toStatus === ServiceCaseStatus.RESOLVED) {
      timestamps.resolvedAt = new Date();
    }
    if (dto.toStatus === ServiceCaseStatus.CLOSED) {
      timestamps.closedAt = new Date();
    }

    return this.updateAdminStatus(
      serviceCase,
      {
        ...timestamps,
        caseStatus: dto.toStatus,
        updatedBy: user.id
      },
      {
        actionType:
          dto.toStatus === ServiceCaseStatus.RESOLVED
            ? ServiceCaseActionType.RESOLVE
            : dto.toStatus === ServiceCaseStatus.CLOSED
              ? ServiceCaseActionType.CLOSE
              : ServiceCaseActionType.UPDATE_STATUS,
        remark: dto.remark,
        toStatus: dto.toStatus
      },
      user,
      context
    );
  }

  async addServiceCaseAction(
    id: string,
    dto: AddServiceCaseActionDto,
    user: RequestUser,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findCaseOrThrow(id);

    await this.prisma.serviceCaseAction.create({
      data: {
        actionType: ServiceCaseActionType.ADD_NOTE,
        actorId: user.id,
        actorName: user.name,
        actorType: ServiceCaseActorType.STAFF,
        fromStatus: serviceCase.caseStatus,
        remark: dto.remark,
        serviceCaseId: id,
        toStatus: serviceCase.caseStatus
      }
    });

    const updated = await this.findCaseOrThrow(id);
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: toServiceCaseView(updated, "admin"),
      before: toServiceCaseView(serviceCase, "admin"),
      entityId: id,
      entityType: "service_case",
      ipAddress: context.ipAddress,
      module: "service_case",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return toServiceCaseView(updated, "admin");
  }

  async closeServiceCase(
    id: string,
    dto: CloseServiceCaseDto,
    user: RequestUser,
    context: PortalRequestContext
  ) {
    const serviceCase = await this.findCaseOrThrow(id);

    if (([ServiceCaseStatus.CLOSED, ServiceCaseStatus.CANCELLED] as ServiceCaseStatus[]).includes(serviceCase.caseStatus)) {
      throw new BadRequestException("工单已结束，不能重复关闭。");
    }

    return this.updateAdminStatus(
      serviceCase,
      {
        caseStatus: ServiceCaseStatus.CLOSED,
        closeRemark: dto.closeRemark,
        closedAt: new Date(),
        updatedBy: user.id
      },
      {
        actionType: ServiceCaseActionType.CLOSE,
        remark: dto.closeRemark,
        toStatus: ServiceCaseStatus.CLOSED
      },
      user,
      context
    );
  }

  private async updateAdminStatus(
    serviceCase: ServiceCaseWithRelations,
    data: Prisma.ServiceCaseUpdateInput,
    action: {
      actionType: ServiceCaseActionType;
      remark?: string;
      toStatus: ServiceCaseStatus;
    },
    user: RequestUser,
    context: PortalRequestContext
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.serviceCase.update({
        data,
        where: { id: serviceCase.id }
      });

      await tx.serviceCaseAction.create({
        data: {
          actionType: action.actionType,
          actorId: user.id,
          actorName: user.name,
          actorType: ServiceCaseActorType.STAFF,
          fromStatus: serviceCase.caseStatus,
          remark: action.remark,
          serviceCaseId: serviceCase.id,
          toStatus: action.toStatus
        }
      });

      return tx.serviceCase.findUniqueOrThrow({
        include: serviceCaseInclude,
        where: { id: serviceCase.id }
      });
    });

    const view = toServiceCaseView(updated, "admin");
    await this.auditService.write({
      action: AuditAction.UPDATE,
      after: view,
      before: toServiceCaseView(serviceCase, "admin"),
      entityId: serviceCase.id,
      entityType: "service_case",
      ipAddress: context.ipAddress,
      module: "service_case",
      operatorId: user.id,
      userAgent: context.userAgent
    });

    return view;
  }

  private validatePortalCreateDto(dto: CreatePortalServiceCaseDto) {
    if (!PORTAL_ALLOWED_CASE_TYPES.has(dto.caseType)) {
      throw new BadRequestException("客户门户暂不支持该工单类型。");
    }

    if (dto.caseType === ServiceCaseType.ACCIDENT_REPORT) {
      if (
        dto.accidentHasInjury === undefined ||
        dto.accidentPoliceReported === undefined
      ) {
        throw new BadRequestException("请补充事故人伤和报警信息。");
      }
      return;
    }

    if (dto.caseType === ServiceCaseType.RESCUE_REQUEST) {
      if (!dto.rescueType || !dto.rescueAddress?.trim()) {
        throw new BadRequestException("请补充救援类型和救援地址。");
      }
    }
  }

  private async findOwnedCaseOrThrow(id: string, customerId: string) {
    const serviceCase = await this.prisma.serviceCase.findFirst({
      include: serviceCaseInclude,
      where: {
        customerId,
        deletedAt: null,
        id
      }
    });

    if (!serviceCase) {
      throw new NotFoundException("服务工单不存在。");
    }

    return serviceCase;
  }

  private async findCaseOrThrow(id: string) {
    const serviceCase = await this.prisma.serviceCase.findFirst({
      include: serviceCaseInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!serviceCase) {
      throw new NotFoundException("服务工单不存在。");
    }

    return serviceCase;
  }
}

function toServiceCaseView(serviceCase: ServiceCaseWithRelations, scope: "admin" | "portal") {
  return {
    acceptedAt: toIso(serviceCase.acceptedAt),
    actions: serviceCase.actions.map(toActionView),
    attachments: serviceCase.attachments.map(toAttachmentView),
    canCancel: PORTAL_CANCELABLE_STATUSES.has(serviceCase.caseStatus),
    cancelReason: serviceCase.cancelReason,
    cancelledAt: toIso(serviceCase.cancelledAt),
    caseNo: serviceCase.caseNo,
    caseSource: serviceCase.caseSource,
    caseStatus: serviceCase.caseStatus,
    caseType: serviceCase.caseType,
    closeRemark: serviceCase.closeRemark,
    closedAt: toIso(serviceCase.closedAt),
    contactName: serviceCase.contactName,
    contactPhone: serviceCase.contactPhone,
    createdAt: toIso(serviceCase.createdAt),
    customer:
      scope === "admin"
        ? {
            customerNo: serviceCase.customer.customerNo,
            id: serviceCase.customer.id,
            mobile: serviceCase.customer.mobile,
            name: serviceCase.customer.name
          }
        : undefined,
    description: serviceCase.description,
    id: serviceCase.id,
    insuranceReportNo: serviceCase.insuranceReportNo,
    locationText: serviceCase.locationText,
    occurredAt: toIso(serviceCase.occurredAt),
    order: serviceCase.order
      ? {
          id: serviceCase.order.id,
          orderNo: serviceCase.order.orderNo,
          orderStatus: serviceCase.order.orderStatus
        }
      : null,
    priority: serviceCase.priority,
    rescueAddress: serviceCase.rescueAddress,
    rescueType: serviceCase.rescueType,
    resolvedAt: toIso(serviceCase.resolvedAt),
    title: serviceCase.title,
    updatedAt: toIso(serviceCase.updatedAt),
    vehicle: serviceCase.vehicle ? buildVehicleSnapshot(serviceCase.vehicle) : null
  };
}

function toAttachmentView(attachment: {
  attachmentType: ServiceCaseAttachmentType;
  createdAt: Date;
  fileName: string;
  fileSize: number | null;
  id: string;
  mimeType: string | null;
  serviceCaseId: string;
}) {
  return {
    attachmentType: attachment.attachmentType,
    createdAt: toIso(attachment.createdAt),
    fileName: attachment.fileName,
    fileSize: attachment.fileSize,
    id: attachment.id,
    mimeType: attachment.mimeType,
    previewUrl: `/api/portal/service-cases/${attachment.serviceCaseId}/attachments/${attachment.id}/preview`
  };
}

function toActionView(action: {
  actionType: ServiceCaseActionType;
  actorName: string | null;
  actorType: ServiceCaseActorType;
  createdAt: Date;
  fromStatus: ServiceCaseStatus | null;
  id: string;
  remark: string | null;
  toStatus: ServiceCaseStatus | null;
}) {
  return {
    actionType: action.actionType,
    actorName: action.actorName,
    actorType: action.actorType,
    createdAt: toIso(action.createdAt),
    fromStatus: action.fromStatus,
    id: action.id,
    remark: action.remark,
    toStatus: action.toStatus
  };
}

function attachmentTypeFromMime(mimeType?: string) {
  if (mimeType?.startsWith("image/")) {
    return ServiceCaseAttachmentType.IMAGE;
  }
  if (
    mimeType === "application/pdf" ||
    mimeType?.includes("word") ||
    mimeType?.includes("excel") ||
    mimeType?.startsWith("text/")
  ) {
    return ServiceCaseAttachmentType.DOCUMENT;
  }
  return ServiceCaseAttachmentType.OTHER;
}

function buildCustomerSnapshot(customer: { customerNo: string; id: string; mobile: string; name: string }) {
  return {
    customerNo: customer.customerNo,
    id: customer.id,
    mobile: customer.mobile,
    name: customer.name
  };
}

function buildOrderSnapshot(order: { id: string; orderNo: string; orderStatus: string }) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    orderStatus: order.orderStatus
  };
}

function buildVehicleSnapshot(
  vehicle: {
    assetLocation: string | null;
    batteryCapacityKwh: Prisma.Decimal | null;
    batteryUsageType: string;
    brand: string;
    currentMileageKm: number;
    id: string;
    model: string | null;
    modelYear: number | null;
    series: string | null;
    vehicleModel: string | null;
  } | null
) {
  if (!vehicle) {
    return null;
  }

  return {
    assetLocation: vehicle.assetLocation,
    batteryCapacityKwh: vehicle.batteryCapacityKwh === null ? null : Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    currentMileageKm: vehicle.currentMileageKm,
    displayName: [vehicle.brand, vehicle.series, vehicle.model].filter(Boolean).join(" "),
    id: vehicle.id,
    model: vehicle.model,
    modelYear: vehicle.modelYear,
    series: vehicle.series,
    vehicleModel: vehicle.vehicleModel
  };
}

function defaultTitle(caseType: ServiceCaseType) {
  if (caseType === ServiceCaseType.ACCIDENT_REPORT) {
    return "事故报案";
  }
  if (caseType === ServiceCaseType.RESCUE_REQUEST) {
    return "救援申请";
  }
  return "客户服务工单";
}

function emptyToNull(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
}

function normalizePage(page?: number) {
  return page && page > 0 ? page : 1;
}

function normalizePageSize(pageSize?: number) {
  if (!pageSize || pageSize < 1) {
    return 20;
  }
  return Math.min(pageSize, 100);
}

function toIso(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function toJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
