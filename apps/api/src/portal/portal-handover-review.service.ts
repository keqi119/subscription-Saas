import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { DeliveryEvidenceService } from "../delivery-evidence/delivery-evidence.service";
import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer } from "./portal-auth.types";
import {
  ConfirmPortalHandoverReviewDto,
  ObjectPortalHandoverReviewDto
} from "./portal-handover-review.dto";

const PORTAL_VISIBLE_REVIEW_STATUSES = [
  "EVIDENCE_SUBMITTED",
  "CUSTOMER_REVIEWING",
  "CUSTOMER_CONFIRMED",
  "CUSTOMER_OBJECTED",
  "SIGNING",
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED"
] as const;
const CUSTOMER_REVIEW_ACTIONABLE_STATUSES = new Set(["EVIDENCE_SUBMITTED", "CUSTOMER_REVIEWING"]);
const TERMINAL_WORK_ORDER_STATUSES = new Set(["VOIDED", "FAILED", "CANCELLED"]);

const portalHandoverReviewInclude = {
  handover: {
    select: {
      archiveStatus: true,
      archivedAt: true,
      completedAt: true,
      id: true,
      status: true
    }
  },
  order: {
    include: {
      customer: true,
      vehicle: true
    }
  },
  reviewAttempts: {
    orderBy: { attemptNo: "asc" as const },
    select: {
      adminStatus: true,
      attemptNo: true,
      customerConfirmedAt: true,
      customerObjectedAt: true,
      customerObjectionDetails: true,
      customerObjectionReason: true,
      customerReviewStartedAt: true,
      fieldSubmittedAt: true,
      id: true,
      sentBackToCustomerReviewAt: true,
      status: true
    }
  }
} satisfies Prisma.VehicleHandoverWorkOrderInclude;

type PortalHandoverReviewRecord = Prisma.VehicleHandoverWorkOrderGetPayload<{
  include: typeof portalHandoverReviewInclude;
}>;

@Injectable()
export class PortalHandoverReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryEvidenceService: DeliveryEvidenceService,
    private readonly handoverWorkOrderService: HandoverWorkOrderService
  ) {}

  async listReviews(currentCustomer: CurrentCustomer) {
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      include: portalHandoverReviewInclude,
      orderBy: [
        { scheduledAt: "asc" },
        { createdAt: "desc" }
      ],
      where: {
        order: {
          customerId: currentCustomer.customerId,
          deletedAt: null
        },
        status: { in: [...PORTAL_VISIBLE_REVIEW_STATUSES] }
      }
    });

    return Promise.all(workOrders.map((workOrder) => this.toReviewListItem(workOrder)));
  }

  async getReview(id: string, currentCustomer: CurrentCustomer) {
    const workOrder = await this.findVisibleReviewOrThrow(id, currentCustomer.customerId);
    return this.toReviewDetail(workOrder);
  }

  async previewEvidenceFile(id: string, evidenceFileId: string, currentCustomer: CurrentCustomer) {
    await this.findVisibleReviewOrThrow(id, currentCustomer.customerId);
    return this.handoverWorkOrderService.previewEvidenceFile(id, evidenceFileId);
  }

  async downloadEvidenceFile(id: string, evidenceFileId: string, currentCustomer: CurrentCustomer) {
    await this.findVisibleReviewOrThrow(id, currentCustomer.customerId);
    return this.handoverWorkOrderService.downloadEvidenceFile(id, evidenceFileId);
  }

  async confirmNoObjection(
    id: string,
    _dto: ConfirmPortalHandoverReviewDto,
    currentCustomer: CurrentCustomer
  ) {
    const workOrder = await this.findOwnedReviewOrThrow(id, currentCustomer.customerId);
    assertCanConfirmNoObjection(workOrder.status);
    await this.handoverWorkOrderService.customerConfirmNoObjection(id, currentCustomer.customerId);
    return this.getReview(id, currentCustomer);
  }

  async objectReview(
    id: string,
    dto: ObjectPortalHandoverReviewDto,
    currentCustomer: CurrentCustomer
  ) {
    const reason = normalizeRequiredText(dto.reason, "请填写客户异议原因。");
    const workOrder = await this.findOwnedReviewOrThrow(id, currentCustomer.customerId);
    assertCanObject(workOrder.status);
    await this.handoverWorkOrderService.customerObject(
      id,
      currentCustomer.customerId,
      reason,
      normalizeOptionalText(dto.details)
    );
    return this.getReview(id, currentCustomer);
  }

  private async findVisibleReviewOrThrow(id: string, customerId: string) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      include: portalHandoverReviewInclude,
      where: {
        id,
        order: {
          customerId,
          deletedAt: null
        },
        status: { in: [...PORTAL_VISIBLE_REVIEW_STATUSES] }
      }
    });

    if (!workOrder) {
      throw new NotFoundException("交付复核不存在。");
    }
    return workOrder;
  }

  private async findOwnedReviewOrThrow(id: string, customerId: string) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      include: portalHandoverReviewInclude,
      where: {
        id,
        order: {
          customerId,
          deletedAt: null
        }
      }
    });

    if (!workOrder) {
      throw new NotFoundException("交付复核不存在。");
    }
    return workOrder;
  }

  private async toReviewListItem(workOrder: PortalHandoverReviewRecord) {
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });

    return {
      customer: {
        displayName: workOrder.order.customer?.name ?? null,
        mobileMasked: maskPhone(workOrder.order.customer?.mobile)
      },
      adminReviewStatus: workOrder.adminReviewStatus === "NONE"
        ? readMetadataString(workOrder.metadata, "handoverReviewAdminStatus")
        : workOrder.adminReviewStatus,
      customerConfirmedAt: workOrder.customerConfirmedAt,
      customerObjectedAt: workOrder.customerObjectedAt,
      customerReviewStartedAt: workOrder.customerReviewStartedAt,
      deliveryLocation: workOrder.deliveryLocation,
      evidenceProgress: summarizeEvidenceChecklist(evidenceChecklist),
      fieldSubmittedAt: workOrder.fieldSubmittedAt,
      handover: toSafeHandover(workOrder.handover),
      handoverId: workOrder.handoverId,
      handoverType: workOrder.handoverType,
      id: workOrder.id,
      objection: toObjectionView(workOrder),
      orderNo: workOrder.order.orderNo,
      scheduledAt: workOrder.scheduledAt,
      status: workOrder.status,
      vehicle: toSafeVehicleView(workOrder.order.vehicle)
    };
  }

  private async toReviewDetail(workOrder: PortalHandoverReviewRecord) {
    const [listItem, evidenceChecklist, readiness] = await Promise.all([
      this.toReviewListItem(workOrder),
      this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }),
      this.handoverWorkOrderService.getReadiness(workOrder.id)
    ]);

    return {
      ...listItem,
      evidenceChecklist: toSafeEvidenceChecklist(evidenceChecklist, workOrder.id),
      fieldFacts: {
        accessoryChecklist: workOrder.accessoryChecklist,
        damageDeclared: workOrder.damageDeclared,
        deliveryLocation: workOrder.deliveryLocation,
        energyLevelText: workOrder.energyLevelText,
        fieldNotes: workOrder.fieldNotes,
        fieldStartedAt: workOrder.fieldStartedAt,
        fieldSubmittedAt: workOrder.fieldSubmittedAt,
        fuelLevelText: workOrder.fuelLevelText,
        handoverMileageKm: workOrder.handoverMileageKm,
        noVisibleDamageDeclared: workOrder.noVisibleDamageDeclared,
        scheduledAt: workOrder.scheduledAt
      },
      reviewHistory: (workOrder.reviewAttempts ?? []).map((attempt) => ({
        adminStatus: attempt.adminStatus,
        attemptNo: attempt.attemptNo,
        customerConfirmedAt: attempt.customerConfirmedAt,
        customerObjectedAt: attempt.customerObjectedAt,
        customerObjectionDetails: attempt.customerObjectionDetails,
        customerObjectionReason: attempt.customerObjectionReason,
        customerReviewStartedAt: attempt.customerReviewStartedAt,
        fieldSubmittedAt: attempt.fieldSubmittedAt,
        id: attempt.id,
        sentBackToCustomerReviewAt: attempt.sentBackToCustomerReviewAt,
        status: attempt.status
      })),
      readiness
    };
  }
}

function assertCanConfirmNoObjection(status: unknown) {
  if (status === "CUSTOMER_CONFIRMED") {
    throw new BadRequestException("客户已确认无异议。");
  }
  if (status === "CUSTOMER_OBJECTED") {
    throw new BadRequestException("客户已提交异议，需后台介入。");
  }
  if (TERMINAL_WORK_ORDER_STATUSES.has(String(status))) {
    throw new BadRequestException("交付工单已终止。");
  }
  if (!CUSTOMER_REVIEW_ACTIONABLE_STATUSES.has(String(status))) {
    throw new BadRequestException("当前交接复核状态不能确认。");
  }
}

function assertCanObject(status: unknown) {
  if (status === "CUSTOMER_OBJECTED") {
    throw new BadRequestException("客户已提交异议，需后台介入。");
  }
  if (status === "CUSTOMER_CONFIRMED") {
    throw new BadRequestException("客户已确认无异议，需后台介入后再提交异议。");
  }
  if (TERMINAL_WORK_ORDER_STATUSES.has(String(status))) {
    throw new BadRequestException("交付工单已终止。");
  }
  if (!CUSTOMER_REVIEW_ACTIONABLE_STATUSES.has(String(status))) {
    throw new BadRequestException("当前交接复核状态不能提交异议。");
  }
}

function toSafeHandover(handover: PortalHandoverReviewRecord["handover"]) {
  return handover
    ? {
        archiveStatus: handover.archiveStatus,
        archivedAt: handover.archivedAt,
        completedAt: handover.completedAt,
        id: handover.id,
        status: handover.status
      }
    : null;
}

function toSafeVehicleView(vehicle: PortalHandoverReviewRecord["order"]["vehicle"]) {
  return vehicle
    ? {
        brand: vehicle.brand,
        model: vehicle.model,
        plateMasked: maskPlate(vehicle.plateNo),
        series: vehicle.series,
        vinSuffix: suffix(vehicle.vin, 6)
      }
    : null;
}

function toObjectionView(workOrder: {
  customerObjectedAt?: Date | null;
  customerObjectionReason?: string | null;
  metadata?: unknown;
}) {
  return {
    details: readMetadataString(workOrder.metadata, "customerObjectionDetails"),
    objectedAt: workOrder.customerObjectedAt ?? null,
    reason: workOrder.customerObjectionReason ?? null
  };
}

function summarizeEvidenceChecklist(checklist: unknown) {
  const items = getChecklistItems(checklist);
  return {
    approved: items.filter((item) =>
      readString(item, "status") === "APPROVED" || readString(item, "reviewStatus") === "APPROVED"
    ).length,
    required: items.filter((item) => readBoolean(item, "isRequired") === true).length,
    total: items.length,
    uploaded: items.filter((item) => {
      const status = readString(item, "status");
      return getFileCount(item) > 0 || Boolean(status && status !== "NOT_STARTED");
    }).length
  };
}

function toSafeEvidenceChecklist(checklist: unknown, reviewId?: string) {
  return {
    blockingReasons: readStringArray(checklist, "blockingReasons"),
    items: getChecklistItems(checklist).map((item) => toSafeEvidenceItem(item, reviewId)),
    ready: readBoolean(checklist, "ready") ?? false
  };
}

function toSafeEvidenceItem(item: Record<string, unknown>, reviewId?: string) {
  return {
    allowedMediaTypes: readStringArray(item, "allowedMediaTypes"),
    conditionKey: readNullableString(item, "conditionKey"),
    conditionValue: readNullableString(item, "conditionValue"),
    declaredNoDamage: readNullableBoolean(item, "declaredNoDamage"),
    description: readNullableString(item, "description"),
    evidenceType: readString(item, "evidenceType"),
    fileCount: getFileCount(item),
    fileRequired: readNullableBoolean(item, "fileRequired"),
    files: getEvidenceFiles(item).map((file) => toSafeEvidenceFile(file, reviewId)),
    id: readString(item, "id"),
    isConditional: readNullableBoolean(item, "isConditional"),
    isRequired: readNullableBoolean(item, "isRequired"),
    rejectionReason: readNullableString(item, "rejectionReason"),
    requirementLevel: readString(item, "requirementLevel"),
    reviewedAt: readUnknown(item, "reviewedAt"),
    reviewStatus: readString(item, "reviewStatus"),
    status: readString(item, "status"),
    title: readString(item, "title")
  };
}

function toSafeEvidenceFile(file: Record<string, unknown>, reviewId?: string) {
  const linkedFile = readRecord(file, "file");
  const evidenceFileId = readString(file, "id");
  const mimeType = linkedFile ? readNullableString(linkedFile, "mimeType") : null;
  const displayName = linkedFile ? readNullableString(linkedFile, "originalName") : null;
  const sizeBytes = linkedFile ? readNumberLike(linkedFile, "sizeBytes") : null;
  const previewAvailable = isPreviewableEvidenceMime(mimeType);
  return {
    displayName,
    downloadUrl: evidenceFileId && reviewId
      ? `/api/portal/handover-reviews/${encodeURIComponent(reviewId)}/evidence-files/${encodeURIComponent(evidenceFileId)}/download`
      : null,
    evidenceFileId,
    file: linkedFile
      ? {
          id: readString(linkedFile, "id"),
          mimeType,
          originalName: displayName,
          sizeBytes
        }
      : null,
    fileId: readString(file, "fileId"),
    id: readString(file, "id"),
    mimeType,
    mediaType: readString(file, "mediaType"),
    previewAvailable,
    previewUrl:
      evidenceFileId && reviewId && previewAvailable
        ? `/api/portal/handover-reviews/${encodeURIComponent(reviewId)}/evidence-files/${encodeURIComponent(evidenceFileId)}/preview`
        : null,
    sizeBytes,
    uploadedAt: readUnknown(file, "uploadedAt")
  };
}

function getChecklistItems(checklist: unknown) {
  const record = asRecord(checklist);
  return Array.isArray(record?.items) ? record.items.filter(isPlainObject) : [];
}

function getEvidenceFiles(item: Record<string, unknown>) {
  return Array.isArray(item.files) ? item.files.filter(isPlainObject) : [];
}

function getFileCount(item: Record<string, unknown>) {
  return getEvidenceFiles(item).length;
}

function readRecord(record: Record<string, unknown>, key: string) {
  return isPlainObject(record[key]) ? record[key] : null;
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNullableString(record: Record<string, unknown>, key: string) {
  return readString(record, key);
}

function readBoolean(value: unknown, key: string) {
  const record = asRecord(value);
  const entry = record?.[key];
  return typeof entry === "boolean" ? entry : undefined;
}

function readNullableBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown, key: string) {
  const record = asRecord(value);
  const entry = record?.[key];
  return Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : [];
}

function readUnknown(record: Record<string, unknown>, key: string) {
  return record[key] ?? null;
}

function readNumberLike(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
}

function isPreviewableEvidenceMime(mimeType: null | string | undefined) {
  return Boolean(mimeType && (mimeType.startsWith("image/") || mimeType.startsWith("video/")));
}

function readMetadataString(metadata: unknown, key: string) {
  const record = asRecord(metadata);
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function normalizeRequiredText(value: unknown, message: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new BadRequestException(message);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function maskPhone(value: null | string | undefined) {
  if (!value) {
    return null;
  }
  if (value.length < 7) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function maskPlate(value: null | string | undefined) {
  if (!value || value.length < 3) {
    return value ?? null;
  }
  return `${value.slice(0, 1)}***${value.slice(-2)}`;
}

function suffix(value: null | string | undefined, length: number) {
  if (!value) {
    return null;
  }
  return value.slice(-length);
}
