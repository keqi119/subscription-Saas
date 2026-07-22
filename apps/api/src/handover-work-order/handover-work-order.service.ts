import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnsupportedMediaTypeException,
  UnauthorizedException
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { DeliveryEvidenceMediaType, Prisma } from "@prisma/client";

import {
  DeliveryEvidenceFieldState,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import {
  normalizeFieldOperatorPhone,
  normalizeOptionalFieldOperatorPhone
} from "../field-operator/field-operator-phone";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

const TERMINAL_WORK_ORDER_STATUSES = ["VOIDED", "FAILED", "CANCELLED"] as const;
const FIELD_HIDDEN_WORK_ORDER_STATUSES = [
  "VOIDED",
  "FAILED",
  "CANCELLED",
  "FIELD_COMPLETED",
  "OPS_REVIEWED"
] as const;
const READY_FOR_STAGE2_STATUSES = [
  "CUSTOMER_CONFIRMED",
  "SIGNING",
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED"
] as const;
const CUSTOMER_REVIEW_ACTIONABLE_STATUSES = new Set(["CUSTOMER_REVIEWING", "EVIDENCE_SUBMITTED"]);
const OPS_REVIEW_PENDING_ALLOWED_STATUSES = new Set([
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED"
]);
const FIELD_SESSION_LOCKED_STATUSES = new Set([
  "CUSTOMER_OBJECTED",
  "CUSTOMER_REVIEWING",
  "EVIDENCE_SUBMITTED",
  "CUSTOMER_CONFIRMED",
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED",
  "VOIDED",
  "FAILED",
  "CANCELLED"
]);
const HANDOVER_REVIEW_ADMIN_STATUS_KEY = "handoverReviewAdminStatus";
const ADMIN_REVIEW_STATUS_ACKNOWLEDGED = "ACKNOWLEDGED";
const ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED = "RESUBMISSION_REQUESTED";
const ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN = "RESUBMITTED_PENDING_ADMIN";
const ADMIN_REVIEW_STATUS_SENT_BACK_TO_CUSTOMER_REVIEW = "SENT_BACK_TO_CUSTOMER_REVIEW";
const ADMIN_REVIEW_STATUS_RESOLVED = "RESOLVED";
const PREVIEWABLE_EVIDENCE_MIME_PREFIXES = ["image/", "video/"];

type HandoverType = "DELIVERY_OUTBOUND" | "RETURN_INBOUND";
type WorkOrderStatus = typeof TERMINAL_WORK_ORDER_STATUSES[number] |
  typeof READY_FOR_STAGE2_STATUSES[number] |
  "DRAFT" |
  "ASSIGNED" |
  "FIELD_IN_PROGRESS" |
  "EVIDENCE_SUBMITTED" |
  "CUSTOMER_REVIEWING" |
  "CUSTOMER_OBJECTED";

interface WorkOrderRecord {
  accessTokenExpiresAt?: Date | null;
  accessTokenRevokedAt?: Date | null;
  accessoryChecklist?: unknown;
  createdAt?: Date | null;
  customerConfirmedAt?: Date | null;
  customerObjectedAt?: Date | null;
  customerObjectionReason?: string | null;
  customerReviewStartedAt?: Date | null;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  externalOperatorName?: string | null;
  externalOperatorPhone?: string | null;
  fieldCompletedAt?: Date | null;
  fieldNotes?: string | null;
  fieldStartedAt?: Date | null;
  fieldSubmittedAt?: Date | null;
  fuelLevelText?: string | null;
  handoverId?: string | null;
  handoverMileageKm?: number | null;
  handoverType?: string | null;
  id: string;
  metadata?: unknown;
  noVisibleDamageDeclared?: boolean | null;
  operatorType?: string | null;
  orderId: string;
  scheduledAt?: Date | null;
  status: string;
}

export interface EvidenceFileStreamResult {
  filename: string;
  mimeType: null | string;
  sizeBytes: null | number;
  stream: Readable;
}

export interface AssignExternalOperatorInput {
  expiresAt?: Date | string | null;
  name: string;
  organization?: string | null;
  phone?: string | null;
}

export interface UpdateFieldFactsInput {
  accessoryChecklist?: unknown;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  fieldNotes?: string | null;
  fuelLevelText?: string | null;
  handoverMileageKm?: number | null;
  noVisibleDamageDeclared?: boolean | null;
  scheduledAt?: Date | string | null;
}

export interface AttachFieldEvidenceFileInput {
  fileId: string;
  mediaType: DeliveryEvidenceMediaType;
}

export interface UploadedFieldEvidenceFile {
  buffer: Buffer;
  mimetype?: string;
  originalname: string;
  size: number;
}

@Injectable()
export class HandoverWorkOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryEvidenceService: DeliveryEvidenceService,
    @Optional() private readonly deliveryHandoverService?: DeliveryHandoverService,
    @Optional() private readonly storageService?: StorageService
  ) {}

  async createDraft(orderId: string, handoverType: HandoverType = "DELIVERY_OUTBOUND", actorId?: string) {
    if (handoverType !== "DELIVERY_OUTBOUND") {
      throw new BadRequestException("RETURN_INBOUND 工单流程尚未启用。");
    }

    await this.assertNoActiveWorkOrder(orderId, handoverType);
    const handover = await this.getOrCreateDraftHandover(orderId, actorId);
    const delivery = await this.prisma.vehicleDelivery.findUnique({ where: { orderId } });
    await this.deliveryEvidenceService.initializeChecklist(orderId, handover.id);

    return this.prisma.vehicleHandoverWorkOrder.create({
      data: {
        deliveryLocation: delivery && !delivery.deletedAt ? delivery.deliveryLocation : null,
        handoverId: handover.id,
        handoverType,
        operatorType: "INTERNAL",
        orderId,
        scheduledAt: delivery && !delivery.deletedAt ? delivery.scheduledAt : null,
        status: "DRAFT",
        vehicleDeliveryId: handover.vehicleDeliveryId ?? (delivery && !delivery.deletedAt ? delivery.id : null)
      }
    });
  }

  async listByOrder(orderId: string) {
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: { createdAt: "desc" },
      where: { orderId }
    });
    return Promise.all(workOrders.map((workOrder) => this.toAdminWorkOrderSummary(workOrder)));
  }

  async getById(id: string) {
    return this.toAdminWorkOrderDetail(await this.getWorkOrderOrThrow(id));
  }

  async assignInternalOperator(id: string, userId: string, actorId?: string) {
    await this.assertUserExists(userId);
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      accessTokenExpiresAt: null,
      accessTokenHash: null,
      accessTokenRevokedAt: null,
      assignedInternalUserId: userId,
      externalOperatorName: null,
      externalOperatorOrganization: null,
      externalOperatorPhone: null,
      metadata: mergeMetadata(workOrder.metadata, { assignedBy: actorId ?? null }),
      operatorType: "INTERNAL",
      status: nextStatus(workOrder.status, "ASSIGNED")
    });
  }

  async assignExternalOperator(id: string, input: AssignExternalOperatorInput, actorId?: string) {
    const name = normalizeRequiredText(input.name, "请填写外部交付员姓名。");
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    const accessToken = randomBytes(32).toString("base64url");
    const accessTokenHash = hashAccessToken(accessToken);
    const expiresAt = input.expiresAt ? parseDate(input.expiresAt, "accessTokenExpiresAt") : defaultTokenExpiry();

    const updated = await this.updateWorkOrder(id, {
      accessTokenExpiresAt: expiresAt,
      accessTokenHash,
      accessTokenRevokedAt: null,
      assignedInternalUserId: null,
      externalOperatorName: name,
      externalOperatorOrganization: normalizeOptionalText(input.organization),
      externalOperatorPhone: normalizeOptionalFieldOperatorPhone(input.phone),
      metadata: mergeMetadata(workOrder.metadata, { assignedBy: actorId ?? null }),
      operatorType: "EXTERNAL",
      status: nextStatus(workOrder.status, "ASSIGNED")
    });

    return {
      accessToken,
      workOrder: updated
    };
  }

  async revokeExternalAccess(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    return this.updateWorkOrder(id, {
      accessTokenRevokedAt: new Date(),
      metadata: mergeMetadata(workOrder.metadata, { revokedBy: actorId ?? null })
    });
  }

  async verifyExternalAccess(token: string) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    return this.toLimitedTaskView(workOrder);
  }

  async countFieldAccessibleWorkOrders(phone: string) {
    return (await this.listFieldAccessibleWorkOrders(phone)).length;
  }

  async listFieldAccessibleWorkOrders(phone: string) {
    const normalizedPhone = normalizeFieldOperatorPhone(phone);
    const now = new Date();
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: [
        { scheduledAt: "asc" },
        { createdAt: "desc" }
      ],
      where: {
        OR: [
          { accessTokenExpiresAt: null },
          { accessTokenExpiresAt: { gt: now } }
        ],
        accessTokenRevokedAt: null,
        externalOperatorPhone: normalizedPhone,
        operatorType: "EXTERNAL",
        status: { notIn: [...FIELD_HIDDEN_WORK_ORDER_STATUSES] }
      }
    });

    const sorted = [...workOrders].sort(compareFieldWorkOrders);
    return Promise.all(sorted.map((workOrder) => this.toFieldTaskListItem(workOrder)));
  }

  async getFieldAccessibleWorkOrder(id: string, phone: string) {
    return this.toFieldTaskDetail(await this.getFieldAccessibleWorkOrderRecord(id, phone));
  }

  async getFieldAccessibleReadiness(id: string, phone: string) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    const evidenceReadiness = await this.deliveryEvidenceService.validateFieldEvidenceComplete(
      workOrder.orderId,
      workOrder.handoverId ?? null,
      toFieldEvidenceState(workOrder)
    );
    const fieldFactBlockingReasons = getFieldFactsBlockingReasons(workOrder);

    return {
      ...evidenceReadiness,
      blockingReasons: [...fieldFactBlockingReasons, ...evidenceReadiness.blockingReasons],
      ready: fieldFactBlockingReasons.length === 0 && evidenceReadiness.ready
    };
  }

  async startFieldAccessibleWorkOrder(id: string, phone: string, actorId?: string) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    if (workOrder.status === "CUSTOMER_OBJECTED") {
      return workOrder;
    }
    return this.updateWorkOrder(id, {
      fieldStartedAt: workOrder.fieldStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { fieldStartedBy: actorId ?? null }),
      status: "FIELD_IN_PROGRESS"
    });
  }

  async updateFieldAccessibleFacts(
    id: string,
    phone: string,
    input: UpdateFieldFactsInput,
    actorId?: string
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    return this.updateFieldFacts(id, input, actorId);
  }

  async uploadFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    files: UploadedFieldEvidenceFile[] | undefined
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    const file = (files ?? []).find((item) => item.buffer?.length);
    if (!file) {
      throw new BadRequestException("请上传现场证据文件。");
    }
    assertSupportedFieldEvidenceFile(file);

    const stored = await this.getStorageService().putDeliveryEvidenceFile({
      buffer: file.buffer,
      contentType: file.mimetype,
      metadata: { originalName: file.originalname },
      orderId: workOrder.orderId,
      originalName: file.originalname,
      workOrderId: id
    });
    const fileObject = await this.prisma.fileObject.create({
      data: {
        bucket: stored.bucket,
        mimeType: file.mimetype ?? null,
        objectKey: stored.objectKey,
        originalName: file.originalname,
        sizeBytes: BigInt(file.size),
        uploadedBy: null
      }
    });

    return {
      fileId: fileObject.id,
      fileName: fileObject.originalName,
      mimeType: fileObject.mimeType,
      sizeBytes: Number(fileObject.sizeBytes)
    };
  }

  async attachFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    itemId: string,
    input: AttachFieldEvidenceFileInput
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    return this.attachEvidenceFileForWorkOrder(workOrder, itemId, input);
  }

  async declareFieldAccessibleNoVisibleDamage(id: string, phone: string, remark?: string) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    await this.deliveryEvidenceService.declareNoVisibleDamage(
      workOrder.orderId,
      undefined,
      workOrder.handoverId ?? null,
      remark
    );
    return this.updateWorkOrder(id, {
      damageDeclared: false,
      metadata: mergeMetadata(workOrder.metadata, { noVisibleDamageDeclaredBy: null }),
      noVisibleDamageDeclared: true
    });
  }

  async previewEvidenceFile(id: string, evidenceFileId: string): Promise<EvidenceFileStreamResult> {
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: true });
  }

  async downloadEvidenceFile(id: string, evidenceFileId: string): Promise<EvidenceFileStreamResult> {
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: false });
  }

  async submitFieldAccessibleEvidence(id: string, phone: string, actorId?: string) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    return this.submitEvidence(id, actorId);
  }

  async startFieldWork(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      fieldStartedAt: workOrder.fieldStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { fieldStartedBy: actorId ?? null }),
      status: "FIELD_IN_PROGRESS"
    });
  }

  async startFieldWorkByToken(token: string) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    if (workOrder.status === "CUSTOMER_OBJECTED") {
      return workOrder;
    }
    return this.startFieldWork(workOrder.id, workOrder.externalOperatorName ?? "external");
  }

  async updateFieldFacts(id: string, input: UpdateFieldFactsInput, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertDamageState(input.damageDeclared, input.noVisibleDamageDeclared);
    const switchesToDamage = input.damageDeclared === true && input.noVisibleDamageDeclared !== true;
    if (switchesToDamage) {
      await this.deliveryEvidenceService.retractNoVisibleDamageDeclaration(
        workOrder.orderId,
        actorId,
        workOrder.handoverId ?? null
      );
    }

    return this.updateWorkOrder(id, compactUndefined({
      accessoryChecklist: input.accessoryChecklist === undefined ? undefined : toJsonValue(input.accessoryChecklist),
      damageDeclared: input.noVisibleDamageDeclared === true ? false : input.damageDeclared,
      deliveryLocation: input.deliveryLocation === undefined ? undefined : normalizeOptionalText(input.deliveryLocation),
      energyLevelText: input.energyLevelText === undefined ? undefined : normalizeOptionalText(input.energyLevelText),
      fieldNotes: input.fieldNotes === undefined ? undefined : normalizeOptionalText(input.fieldNotes),
      fuelLevelText: input.fuelLevelText === undefined ? undefined : normalizeOptionalText(input.fuelLevelText),
      handoverMileageKm: input.handoverMileageKm,
      metadata: mergeMetadata(workOrder.metadata, { fieldFactsUpdatedBy: actorId ?? null }),
      noVisibleDamageDeclared: input.damageDeclared === true ? false : input.noVisibleDamageDeclared,
      scheduledAt: input.scheduledAt === undefined ? undefined : (
        input.scheduledAt ? parseDate(input.scheduledAt, "scheduledAt") : null
      ),
      status: workOrder.status === "DRAFT" ? "FIELD_IN_PROGRESS" : workOrder.status
    }));
  }

  async updateFieldFactsByToken(token: string, input: UpdateFieldFactsInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    return this.updateFieldFacts(workOrder.id, input, workOrder.externalOperatorName ?? "external");
  }

  async attachEvidenceFileWithExternalToken(token: string, itemId: string, input: AttachFieldEvidenceFileInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    return this.attachEvidenceFileForWorkOrder(workOrder, itemId, input);
  }

  async acknowledgeCustomerObjection(id: string, actorId: string, note?: string | null) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    const now = new Date();
    await this.upsertLatestReviewAttempt(workOrder, "CUSTOMER_OBJECTED", {
      adminAcknowledgedAt: now,
      adminAcknowledgedById: actorId,
      adminNotes: normalizeOptionalText(note),
      adminStatus: ADMIN_REVIEW_STATUS_ACKNOWLEDGED
    });
    const updated = await this.updateWorkOrder(id, {
      metadata: mergeMetadata(workOrder.metadata, {
        handoverReviewAdminAcknowledgedAt: now.toISOString(),
        handoverReviewAdminAcknowledgedBy: actorId,
        handoverReviewAdminNote: normalizeOptionalText(note),
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_ACKNOWLEDGED
      })
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  async requestCustomerObjectionResubmission(id: string, actorId: string, note?: string | null) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    const now = new Date();
    await this.upsertLatestReviewAttempt(workOrder, "RESUBMISSION_REQUESTED", {
      adminNotes: normalizeOptionalText(note),
      adminStatus: ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED,
      resubmissionRequestedAt: now,
      resubmissionRequestedById: actorId
    });
    const updated = await this.updateWorkOrder(id, {
      metadata: mergeMetadata(workOrder.metadata, {
        handoverReviewAdminNote: normalizeOptionalText(note),
        handoverReviewResubmissionRequestedAt: now.toISOString(),
        handoverReviewResubmissionRequestedBy: actorId,
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED
      })
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  async sendCustomerObjectionBackToReview(id: string, actorId: string, note?: string | null) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    if (getHandoverReviewAdminStatus(workOrder.metadata) !== ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN) {
      throw new BadRequestException("现场资料重新提交后，后台才能送回客户复核。");
    }
    const now = new Date();
    const updated = await this.updateWorkOrder(id, {
      customerConfirmedAt: null,
      customerObjectedAt: null,
      customerObjectionReason: null,
      customerReviewStartedAt: now,
      metadata: mergeMetadata(workOrder.metadata, {
        customerObjectionDetails: null,
        handoverReviewAdminNote: normalizeOptionalText(note),
        handoverReviewSentBackToCustomerReviewAt: now.toISOString(),
        handoverReviewSentBackToCustomerReviewBy: actorId,
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_SENT_BACK_TO_CUSTOMER_REVIEW
      }),
      status: "CUSTOMER_REVIEWING"
    });
    await this.createReviewAttempt(updated, "CUSTOMER_REVIEWING", {
      adminNotes: normalizeOptionalText(note),
      adminStatus: ADMIN_REVIEW_STATUS_SENT_BACK_TO_CUSTOMER_REVIEW,
      customerReviewStartedAt: now,
      sentBackToCustomerReviewAt: now,
      sentBackToCustomerReviewById: actorId
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  private async attachEvidenceFileForWorkOrder(
    workOrder: WorkOrderRecord,
    itemId: string,
    input: AttachFieldEvidenceFileInput
  ) {
    const item = await this.prisma.vehicleDeliveryEvidenceItem.findFirst({
      where: {
        id: itemId,
        orderId: workOrder.orderId,
        ...(workOrder.handoverId
          ? { OR: [{ handoverId: null }, { handoverId: workOrder.handoverId }] }
          : {})
      }
    });
    if (!item) {
      throw new NotFoundException("交付证据项不存在。");
    }
    return this.deliveryEvidenceService.attachEvidenceFile(
      itemId,
      input.fileId,
      input.mediaType,
      undefined
    );
  }

  async submitEvidence(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertFieldFactsComplete(workOrder);
    await this.deliveryEvidenceService.assertFieldEvidenceComplete(
      workOrder.orderId,
      workOrder.handoverId ?? null,
      toFieldEvidenceState(workOrder)
    );
    const now = new Date();
    if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
      if (!isFieldResubmissionRequested(workOrder)) {
        throw new BadRequestException("客户已提交异议，需后台要求现场重提后才能继续。");
      }
      const updated = await this.updateWorkOrder(id, {
        fieldSubmittedAt: now,
        metadata: mergeMetadata(workOrder.metadata, {
          fieldSubmittedBy: actorId ?? null,
          handoverReviewResubmittedAt: now.toISOString(),
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN
        }),
        status: "CUSTOMER_OBJECTED"
      });
      await this.upsertLatestReviewAttempt(updated, "RESUBMITTED_PENDING_ADMIN", {
        adminStatus: ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN,
        fieldSubmittedAt: now
      });
      return updated;
    }
    const updated = await this.updateWorkOrder(id, {
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? now,
      fieldSubmittedAt: workOrder.fieldSubmittedAt ?? now,
      metadata: mergeMetadata(workOrder.metadata, {
        fieldSubmittedBy: actorId ?? null,
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: null
      }),
      status: "CUSTOMER_REVIEWING"
    });
    await this.upsertLatestReviewAttempt(updated, "CUSTOMER_REVIEWING", {
      adminStatus: null,
      customerReviewStartedAt: updated.customerReviewStartedAt ?? now,
      fieldSubmittedAt: updated.fieldSubmittedAt ?? now
    });
    return updated;
  }

  async submitEvidenceByToken(token: string) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    return this.submitEvidence(workOrder.id, workOrder.externalOperatorName ?? "external");
  }

  async startCustomerReview(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { customerReviewStartedBy: actorId ?? null }),
      status: "CUSTOMER_REVIEWING"
    });
  }

  async customerConfirmNoObjection(id: string, customerId: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertCustomerOwnsWorkOrder(workOrder, customerId);
    this.assertMutable(workOrder);
    if (workOrder.status === "CUSTOMER_CONFIRMED") {
      throw new BadRequestException("客户已确认无异议。");
    }
    if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
      throw new BadRequestException("客户已提交异议，需后台介入。");
    }
    if (!CUSTOMER_REVIEW_ACTIONABLE_STATUSES.has(String(workOrder.status))) {
      throw new BadRequestException("客户尚未进入交付复核。");
    }
    assertFieldFactsComplete(workOrder);
    await this.deliveryEvidenceService.assertFieldEvidenceComplete(
      workOrder.orderId,
      workOrder.handoverId ?? null,
      toFieldEvidenceState(workOrder)
    );
    const confirmedAt = workOrder.customerConfirmedAt ?? new Date();
    const updated = await this.updateWorkOrder(id, {
      customerConfirmedAt: confirmedAt,
      customerObjectedAt: null,
      customerObjectionReason: null,
      metadata: mergeMetadata(workOrder.metadata, {
        customerConfirmedBy: customerId,
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESOLVED
      }),
      status: "CUSTOMER_CONFIRMED"
    });
    await this.upsertLatestReviewAttempt(updated, "CUSTOMER_CONFIRMED", {
      adminStatus: ADMIN_REVIEW_STATUS_RESOLVED,
      customerConfirmedAt: confirmedAt,
      resolvedAt: confirmedAt,
      resolvedById: null
    });
    return updated;
  }

  async customerObject(id: string, customerId: string, reason: string, details?: string | null) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertCustomerOwnsWorkOrder(workOrder, customerId);
    this.assertMutable(workOrder);
    if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
      throw new BadRequestException("客户已提交异议，需后台介入。");
    }
    if (workOrder.status === "CUSTOMER_CONFIRMED" || workOrder.customerConfirmedAt) {
      throw new BadRequestException("客户已确认无异议，需后台介入后再提交异议。");
    }
    if (!CUSTOMER_REVIEW_ACTIONABLE_STATUSES.has(String(workOrder.status))) {
      throw new BadRequestException("客户尚未进入交付复核。");
    }
    const now = new Date();
    const objectionReason = normalizeRequiredText(reason, "请填写客户异议原因。");
    const objectionDetails = normalizeOptionalText(details);
    const updated = await this.updateWorkOrder(id, {
      customerObjectedAt: now,
      customerObjectionReason: objectionReason,
      metadata: mergeMetadata(workOrder.metadata, {
        customerObjectedBy: customerId,
        customerObjectionDetails: objectionDetails,
        [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: null
      }),
      status: "CUSTOMER_OBJECTED"
    });
    await this.upsertLatestReviewAttempt(updated, "CUSTOMER_OBJECTED", {
      adminStatus: null,
      customerObjectedAt: now,
      customerObjectionDetails: objectionDetails,
      customerObjectionReason: objectionReason
    });
    return updated;
  }

  async markCustomerSigned(id: string, signedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      fieldCompletedAt: workOrder.fieldCompletedAt ?? signedAt,
      metadata: mergeMetadata(workOrder.metadata, { customerSignedMarkedBy: actorId ?? null }),
      status: "CUSTOMER_SIGNED"
    });
  }

  async markPlatformSealed(id: string, sealedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      metadata: mergeMetadata(workOrder.metadata, {
        platformSealedAt: sealedAt.toISOString(),
        platformSealedMarkedBy: actorId ?? null
      }),
      status: "PLATFORM_SEALED"
    });
  }

  async markFieldCompleted(id: string, completedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      fieldCompletedAt: workOrder.fieldCompletedAt ?? completedAt,
      metadata: mergeMetadata(workOrder.metadata, { fieldCompletedBy: actorId ?? null }),
      status: "FIELD_COMPLETED"
    });
  }

  async markOpsReviewPending(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    assertCanMarkOpsReviewPending(workOrder);
    return this.updateWorkOrder(id, {
      metadata: mergeMetadata(workOrder.metadata, { opsReviewRequestedBy: actorId ?? null }),
      opsReviewStatus: "PENDING",
      status: "OPS_REVIEW_PENDING"
    });
  }

  async markOpsReviewApproved(id: string, reviewerId: string, notes?: string | null) {
    return this.updateWorkOrder(id, {
      opsReviewNotes: normalizeOptionalText(notes),
      opsReviewStatus: "APPROVED",
      opsReviewedAt: new Date(),
      opsReviewedBy: reviewerId,
      status: "OPS_REVIEWED"
    });
  }

  async markOpsReviewRejected(id: string, reviewerId: string, notes?: string | null) {
    return this.updateWorkOrder(id, {
      opsReviewNotes: normalizeOptionalText(notes),
      opsReviewStatus: "REJECTED",
      opsReviewedAt: new Date(),
      opsReviewedBy: reviewerId,
      status: "OPS_REVIEWED"
    });
  }

  async voidOrCancel(id: string, status: Extract<WorkOrderStatus, "VOIDED" | "FAILED" | "CANCELLED">, actorId?: string, reason?: string | null) {
    return this.updateWorkOrder(id, {
      metadata: mergeMetadata((await this.getWorkOrderOrThrow(id)).metadata, {
        terminalReason: normalizeOptionalText(reason),
        terminalUpdatedBy: actorId ?? null
      }),
      status
    });
  }

  async getReadiness(id: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    const blockingReasons: string[] = [];
    try {
      await this.assertWorkOrderReadyForStage2(workOrder);
    } catch (error) {
      blockingReasons.push(error instanceof Error ? error.message : "交付工单尚未就绪。");
    }
    return {
      blockingReasons,
      readyForDeliveryConfirmation: blockingReasons.length === 0,
      readyForStage2ESign: blockingReasons.length === 0,
      readyForStage2Pdf: blockingReasons.length === 0,
      workOrderId: id
    };
  }

  async assertReadyForStage2Pdf(orderId: string, handoverId?: string | null) {
    await this.assertWorkOrderReadyForStage2(await this.findActiveWorkOrderOrThrow(orderId, handoverId));
  }

  async assertReadyForStage2ESign(orderId: string, handoverId?: string | null) {
    await this.assertWorkOrderReadyForStage2(await this.findActiveWorkOrderOrThrow(orderId, handoverId));
  }

  async assertDeliveryCanBeConfirmed(orderId: string, handoverId?: string | null) {
    const workOrder = await this.findActiveWorkOrderOrThrow(orderId, handoverId);
    await this.assertWorkOrderReadyForStage2(workOrder);
    if (this.deliveryHandoverService) {
      await this.deliveryHandoverService.assertDeliveryCanBeConfirmed(orderId);
      return;
    }
    const handover = await this.prisma.vehicleDeliveryHandover.findFirst({
      where: {
        deletedAt: null,
        id: workOrder.handoverId ?? undefined,
        orderId
      }
    });
    if (!handover || !["SIGNED", "ARCHIVED"].includes(handover.status)) {
      throw new BadRequestException("交付交接确认书尚未完成签署。");
    }
  }

  private async assertWorkOrderReadyForStage2(workOrder: WorkOrderRecord) {
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new BadRequestException("交付工单已终止。");
    }
    if (getHandoverReviewAdminStatus(workOrder.metadata) === ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN) {
      throw new BadRequestException("现场资料已重新提交，等待后台送回客户复核。");
    }
    if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
      throw new BadRequestException("客户存在异议，需后台介入。");
    }
    if (!workOrder.customerConfirmedAt && !isReadyForStage2Status(workOrder.status)) {
      throw new BadRequestException("客户尚未确认交付无异议。");
    }
    assertFieldFactsComplete(workOrder);
    await this.deliveryEvidenceService.assertFieldEvidenceComplete(
      workOrder.orderId,
      workOrder.handoverId ?? null,
      toFieldEvidenceState(workOrder)
    );
  }

  private async findActiveWorkOrderOrThrow(orderId: string, handoverId?: string | null) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        ...(handoverId ? { handoverId } : {}),
        orderId,
        status: { notIn: [...TERMINAL_WORK_ORDER_STATUSES] }
      }
    });
    if (!workOrder) {
      const latest = await this.prisma.vehicleHandoverWorkOrder.findFirst({
        orderBy: { createdAt: "desc" },
        where: {
          ...(handoverId ? { handoverId } : {}),
          orderId
        }
      });
      if (latest && isTerminalWorkOrderStatus(latest.status)) {
        throw new BadRequestException("交付工单已终止。");
      }
      throw new BadRequestException("交付工单尚未创建。");
    }
    return workOrder;
  }

  private async assertNoActiveWorkOrder(orderId: string, handoverType: HandoverType) {
    const existing = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      where: {
        handoverType,
        orderId,
        status: { notIn: [...TERMINAL_WORK_ORDER_STATUSES] }
      }
    });
    if (existing) {
      throw new BadRequestException("该订单已存在进行中的交付工单。");
    }
  }

  private async getWorkOrderOrThrow(id: string) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({ where: { id } });
    if (!workOrder) {
      throw new NotFoundException("交付工单不存在。");
    }
    return workOrder;
  }

  private async getOrderOrThrow(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: {
        customer: true,
        vehicle: true
      },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }
    return order;
  }

  private async assertCustomerOwnsWorkOrder(workOrder: WorkOrderRecord, customerId: string) {
    const order = await this.getOrderOrThrow(workOrder.orderId);
    if (order.customerId !== customerId) {
      throw new UnauthorizedException("无权访问该交付工单。");
    }
  }

  private async getObjectedWorkOrderOrThrow(id: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    if (workOrder.status !== "CUSTOMER_OBJECTED" && !workOrder.customerObjectedAt) {
      throw new BadRequestException("当前交接工单没有待处理客户异议。");
    }
    return workOrder;
  }

  private async getEvidenceFileStream(
    id: string,
    evidenceFileId: string,
    options: { preview: boolean }
  ): Promise<EvidenceFileStreamResult> {
    const workOrder = await this.getWorkOrderOrThrow(id);
    const evidenceFile = await this.prisma.vehicleDeliveryEvidenceFile.findFirst({
      include: {
        evidenceItem: true,
        file: true
      },
      where: {
        id: evidenceFileId,
        evidenceItem: {
          orderId: workOrder.orderId,
          ...(workOrder.handoverId
            ? { OR: [{ handoverId: null }, { handoverId: workOrder.handoverId }] }
            : {})
        }
      }
    });
    const fileObject = evidenceFile?.file;
    if (!evidenceFile || !fileObject?.bucket || !fileObject.objectKey) {
      throw new NotFoundException("交接资料文件不存在。");
    }
    const mimeType = fileObject.mimeType ?? null;
    if (options.preview && !isPreviewableEvidenceMime(mimeType)) {
      throw new UnsupportedMediaTypeException("该资料类型暂不支持预览，请下载后查看。");
    }
    const downloaded = await this.getStorageService().getObject(fileObject.bucket, fileObject.objectKey);
    return {
      filename: fileObject.originalName ?? "evidence-file",
      mimeType: downloaded.contentType ?? mimeType,
      sizeBytes: toNumberOrNull(fileObject.sizeBytes ?? downloaded.contentLength ?? null),
      stream: downloaded.stream
    };
  }

  private async toAdminWorkOrderSummary(workOrder: WorkOrderRecord) {
    const [order, evidenceChecklist, reviewAttempts] = await Promise.all([
      this.getOrderOrThrow(workOrder.orderId),
      this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }),
      this.listReviewAttempts(workOrder.id)
    ]);

    return {
      adminReview: toAdminReviewView(workOrder, reviewAttempts),
      customer: {
        displayName: order.customer?.name ?? null,
        mobileMasked: maskPhone(order.customer?.mobile)
      },
      customerConfirmedAt: workOrder.customerConfirmedAt,
      customerObjectedAt: workOrder.customerObjectedAt,
      customerReviewStartedAt: workOrder.customerReviewStartedAt,
      deliveryLocation: workOrder.deliveryLocation,
      evidenceProgress: summarizeEvidenceChecklist(evidenceChecklist),
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      fieldSubmittedAt: workOrder.fieldSubmittedAt,
      handoverId: workOrder.handoverId,
      handoverType: workOrder.handoverType,
      id: workOrder.id,
      objection: toObjectionView(workOrder),
      operator: {
        name: workOrder.externalOperatorName ?? null,
        phoneMasked: maskPhone(workOrder.externalOperatorPhone),
        type: workOrder.operatorType ?? null
      },
      orderNo: order.orderNo,
      reviewAttempts: reviewAttempts.map(toSafeReviewAttempt),
      scheduledAt: workOrder.scheduledAt,
      status: workOrder.status,
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      }
    };
  }

  private async toAdminWorkOrderDetail(workOrder: WorkOrderRecord) {
    const [summary, evidenceChecklist, readiness] = await Promise.all([
      this.toAdminWorkOrderSummary(workOrder),
      this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }),
      this.getReadiness(workOrder.id)
    ]);

    return {
      ...summary,
      evidenceChecklist: toSafeEvidenceChecklist(
        evidenceChecklist,
        `/api/handover-work-orders/${encodeURIComponent(workOrder.id)}/evidence-files`
      ),
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
      readiness
    };
  }

  private getReviewAttemptModel() {
    return (this.prisma as unknown as {
      vehicleHandoverReviewAttempt?: {
        create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
        findFirst: (args: Record<string, unknown>) => Promise<null | Record<string, unknown>>;
        findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
        update: (args: { data: Record<string, unknown>; where: { id: string } }) => Promise<Record<string, unknown>>;
      };
    }).vehicleHandoverReviewAttempt;
  }

  private async listReviewAttempts(workOrderId: string) {
    const model = this.getReviewAttemptModel();
    if (!model) {
      return [];
    }
    return model.findMany({
      orderBy: { attemptNo: "asc" },
      where: { workOrderId }
    });
  }

  private async findLatestReviewAttempt(workOrderId: string) {
    const model = this.getReviewAttemptModel();
    if (!model) {
      return null;
    }
    return model.findFirst({
      orderBy: { attemptNo: "desc" },
      where: { workOrderId }
    });
  }

  private async createReviewAttempt(
    workOrder: WorkOrderRecord,
    status: string,
    data: Record<string, unknown> = {}
  ) {
    const model = this.getReviewAttemptModel();
    if (!model) {
      return null;
    }
    const latest = await this.findLatestReviewAttempt(workOrder.id);
    return model.create({
      data: compactUndefined({
        ...(await this.buildReviewAttemptSnapshot(workOrder)),
        ...data,
        attemptNo: nextAttemptNo(latest),
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId,
        status,
        workOrderId: workOrder.id
      })
    });
  }

  private async upsertLatestReviewAttempt(
    workOrder: WorkOrderRecord,
    status: string,
    data: Record<string, unknown> = {}
  ) {
    const model = this.getReviewAttemptModel();
    if (!model) {
      return null;
    }
    const latest = await this.findLatestReviewAttempt(workOrder.id);
    if (!latest) {
      return this.createReviewAttempt(workOrder, status, data);
    }
    return model.update({
      data: compactUndefined({
        ...(await this.buildReviewAttemptSnapshot(workOrder)),
        ...data,
        status
      }),
      where: { id: String(latest.id) }
    });
  }

  private async buildReviewAttemptSnapshot(workOrder: WorkOrderRecord) {
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });
    return {
      customerConfirmedAt: workOrder.customerConfirmedAt ?? null,
      customerObjectedAt: workOrder.customerObjectedAt ?? null,
      customerObjectionDetails: readMetadataString(workOrder.metadata, "customerObjectionDetails"),
      customerObjectionReason: workOrder.customerObjectionReason ?? null,
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? null,
      evidenceSnapshot: toJsonValue(toSafeEvidenceChecklist(evidenceChecklist)),
      fieldFactsSnapshot: toJsonValue({
        accessoryChecklist: workOrder.accessoryChecklist ?? null,
        damageDeclared: workOrder.damageDeclared ?? null,
        deliveryLocation: workOrder.deliveryLocation ?? null,
        energyLevelText: workOrder.energyLevelText ?? null,
        fieldNotes: workOrder.fieldNotes ?? null,
        fuelLevelText: workOrder.fuelLevelText ?? null,
        handoverMileageKm: workOrder.handoverMileageKm ?? null,
        noVisibleDamageDeclared: workOrder.noVisibleDamageDeclared ?? null,
        scheduledAt: workOrder.scheduledAt?.toISOString?.() ?? null
      }),
      fieldSubmittedAt: workOrder.fieldSubmittedAt ?? null,
      metadata: toJsonValue({
        adminStatus: getHandoverReviewAdminStatus(workOrder.metadata),
        sourceWorkOrderStatus: workOrder.status
      })
    };
  }

  private async assertUserExists(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        id: userId
      }
    });
    if (!user) {
      throw new NotFoundException("内部交付员不存在。");
    }
  }

  private assertMutable(workOrder: WorkOrderRecord) {
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new BadRequestException("交付工单已终止。");
    }
  }

  private async getFieldAccessibleWorkOrderRecord(id: string, phone: string) {
    const normalizedPhone = normalizeFieldOperatorPhone(phone);
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({ where: { id } });

    if (!workOrder || !isFieldAccessibleWorkOrder(workOrder, normalizedPhone)) {
      throw new UnauthorizedException("No access to this field handover work order.");
    }

    return workOrder;
  }

  private getStorageService() {
    if (!this.storageService) {
      throw new BadRequestException("现场证据上传存储服务未配置。");
    }
    return this.storageService;
  }

  private async getOrCreateDraftHandover(orderId: string, actorId?: string) {
    if (this.deliveryHandoverService) {
      return this.deliveryHandoverService.getOrCreateDraftHandover(orderId, actorId);
    }
    const handover = await this.prisma.vehicleDeliveryHandover.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        orderId,
        status: { notIn: ["CANCELLED", "FAILED"] }
      }
    });
    if (handover) {
      return handover;
    }
    throw new BadRequestException("Stage 2 交接记录尚未创建。");
  }

  private async resolveExternalWorkOrder(token: string) {
    const normalized = normalizeRequiredText(token, "缺少外部访问 token。");
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      where: { accessTokenHash: hashAccessToken(normalized) }
    });
    if (!workOrder || workOrder.operatorType !== "EXTERNAL" || !workOrder.accessTokenExpiresAt) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    if (workOrder.accessTokenRevokedAt || workOrder.accessTokenExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    this.assertMutable(workOrder);
    const now = new Date();
    return this.updateWorkOrder(workOrder.id, {
      firstAccessedAt: workOrder.firstAccessedAt ?? now,
      lastAccessedAt: now
    });
  }

  private async toLimitedTaskView(workOrder: WorkOrderRecord) {
    const order = await this.getOrderOrThrow(workOrder.orderId);
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });
    return {
      customer: {
        displayName: order.customer?.name ?? null,
        mobileMasked: maskPhone(order.customer?.mobile)
      },
      deliveryLocation: workOrder.deliveryLocation,
      evidenceChecklist: toSafeEvidenceChecklist(evidenceChecklist),
      handoverId: workOrder.handoverId,
      id: workOrder.id,
      orderNo: order.orderNo,
      scheduledAt: workOrder.scheduledAt,
      status: workOrder.status,
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      }
    };
  }

  private async toFieldTaskListItem(workOrder: WorkOrderRecord) {
    const order = await this.getOrderOrThrow(workOrder.orderId);
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });

    return {
      customer: {
        displayName: order.customer?.name ?? null,
        mobileMasked: maskPhone(order.customer?.mobile)
      },
      adminReviewStatus: getHandoverReviewAdminStatus(workOrder.metadata),
      deliveryLocation: workOrder.deliveryLocation,
      evidenceProgress: summarizeEvidenceChecklist(evidenceChecklist),
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      handoverId: workOrder.handoverId,
      handoverType: workOrder.handoverType,
      id: workOrder.id,
      orderNo: order.orderNo,
      scheduledAt: workOrder.scheduledAt,
      status: workOrder.status,
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      }
    };
  }

  private async toFieldTaskDetail(workOrder: WorkOrderRecord) {
    const listItem = await this.toFieldTaskListItem(workOrder);
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });

    return {
      ...listItem,
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      evidenceChecklist: toSafeEvidenceChecklist(evidenceChecklist),
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
      }
    };
  }

  private updateWorkOrder(id: string, data: Record<string, unknown>) {
    return this.prisma.vehicleHandoverWorkOrder.update({
      data: compactUndefined(data),
      where: { id }
    });
  }
}

function assertFieldFactsComplete(workOrder: WorkOrderRecord) {
  const blockingReasons = getFieldFactsBlockingReasons(workOrder);
  if (blockingReasons.length > 0) {
    throw new BadRequestException(blockingReasons[0]);
  }
}

function getFieldFactsBlockingReasons(workOrder: WorkOrderRecord) {
  const reasons: string[] = [];
  if (workOrder.handoverMileageKm === null || workOrder.handoverMileageKm === undefined) {
    reasons.push("请填写交付里程。");
  } else if (typeof workOrder.handoverMileageKm !== "number" || workOrder.handoverMileageKm <= 0) {
    reasons.push("交付里程不合法。");
  }
  if (!normalizeOptionalText(workOrder.energyLevelText) && !normalizeOptionalText(workOrder.fuelLevelText)) {
    reasons.push("请填写能源/油量状态。");
  }
  if (!hasAccessoryChecklist(workOrder.accessoryChecklist)) {
    reasons.push("请填写随车物品清单。");
  }
  if (workOrder.damageDeclared === true && workOrder.noVisibleDamageDeclared === true) {
    reasons.push("损伤状态冲突，请选择存在损伤或无可见损伤。");
  } else if (workOrder.damageDeclared !== true && workOrder.noVisibleDamageDeclared !== true) {
    reasons.push("请处理车辆损伤状态。");
  }
  return reasons;
}

function assertFieldSessionEditable(workOrder: WorkOrderRecord) {
  if (workOrder.status === "CUSTOMER_OBJECTED" && isFieldResubmissionRequested(workOrder)) {
    return;
  }
  if (FIELD_SESSION_LOCKED_STATUSES.has(String(workOrder.status))) {
    throw new BadRequestException("当前交接任务已提交或不可继续编辑。");
  }
}

function isFieldAccessibleWorkOrder(workOrder: null | WorkOrderRecord, phone: string) {
  if (!workOrder || workOrder.operatorType !== "EXTERNAL") {
    return false;
  }
  if (workOrder.externalOperatorPhone !== phone) {
    return false;
  }
  if (workOrder.accessTokenRevokedAt) {
    return false;
  }
  if (FIELD_HIDDEN_WORK_ORDER_STATUSES.includes(workOrder.status as typeof FIELD_HIDDEN_WORK_ORDER_STATUSES[number])) {
    return false;
  }
  return !workOrder.accessTokenExpiresAt || workOrder.accessTokenExpiresAt.getTime() > Date.now();
}

function compareFieldWorkOrders(left: WorkOrderRecord, right: WorkOrderRecord) {
  const leftScheduled = left.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightScheduled = right.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftScheduled !== rightScheduled) {
    return leftScheduled - rightScheduled;
  }

  const leftCreated = left.createdAt?.getTime() ?? 0;
  const rightCreated = right.createdAt?.getTime() ?? 0;
  return rightCreated - leftCreated;
}

function summarizeEvidenceChecklist(checklist: unknown) {
  const items = getChecklistItems(checklist);
  const uploaded = items.filter((item) => {
    const status = readString(item, "status");
    return getFileCount(item) > 0 || Boolean(status && status !== "NOT_STARTED");
  }).length;
  const approved = items.filter((item) =>
    readString(item, "status") === "APPROVED" || readString(item, "reviewStatus") === "APPROVED"
  ).length;
  return {
    approved,
    required: items.filter((item) => readBoolean(item, "isRequired")).length,
    total: items.length,
    uploaded
  };
}

function toSafeEvidenceChecklist(checklist: unknown, routeBase?: string) {
  return {
    blockingReasons: readStringArray(checklist, "blockingReasons"),
    items: getChecklistItems(checklist).map((item) => toSafeEvidenceItem(item, routeBase)),
    ready: readBoolean(checklist, "ready") ?? false
  };
}

function toSafeEvidenceItem(item: Record<string, unknown>, routeBase?: string) {
  return {
    allowedMediaTypes: readStringArray(item, "allowedMediaTypes"),
    conditionKey: readNullableString(item, "conditionKey"),
    conditionValue: readNullableString(item, "conditionValue"),
    declaredNoDamage: readNullableBoolean(item, "declaredNoDamage"),
    description: readNullableString(item, "description"),
    evidenceType: readString(item, "evidenceType"),
    fileCount: getFileCount(item),
    fileRequired: readNullableBoolean(item, "fileRequired"),
    files: getEvidenceFiles(item).map((file) => toSafeEvidenceFile(file, routeBase)),
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

function toSafeEvidenceFile(file: Record<string, unknown>, routeBase?: string) {
  const linkedFile = readRecord(file, "file");
  const evidenceFileId = readString(file, "id");
  const mimeType = linkedFile ? readNullableString(linkedFile, "mimeType") : null;
  const displayName = linkedFile ? readNullableString(linkedFile, "originalName") : null;
  const sizeBytes = linkedFile ? readNumberLike(linkedFile, "sizeBytes") : null;
  const previewAvailable = isPreviewableEvidenceMime(mimeType);
  return {
    displayName,
    downloadUrl: routeBase && evidenceFileId ? `${routeBase}/${encodeURIComponent(evidenceFileId)}/download` : null,
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
    previewUrl: routeBase && evidenceFileId && previewAvailable ? `${routeBase}/${encodeURIComponent(evidenceFileId)}/preview` : null,
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
  return toNumberOrNull(record[key]);
}

function readMetadataString(metadata: unknown, key: string) {
  const record = asRecord(metadata);
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function toObjectionView(workOrder: WorkOrderRecord) {
  return {
    adminStatus: getHandoverReviewAdminStatus(workOrder.metadata),
    details: readMetadataString(workOrder.metadata, "customerObjectionDetails"),
    objectedAt: workOrder.customerObjectedAt ?? null,
    reason: workOrder.customerObjectionReason ?? null
  };
}

function toAdminReviewView(workOrder: WorkOrderRecord, reviewAttempts: Array<Record<string, unknown>>) {
  return {
    canRequestResubmission: workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt),
    canSendBackToCustomerReview:
      (workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt)) &&
      getHandoverReviewAdminStatus(workOrder.metadata) === ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN,
    currentAttemptNo: reviewAttempts.length > 0 ? toNumberOrNull(reviewAttempts[reviewAttempts.length - 1]?.attemptNo) : null,
    status: getHandoverReviewAdminStatus(workOrder.metadata),
    totalAttempts: reviewAttempts.length
  };
}

function toSafeReviewAttempt(attempt: Record<string, unknown>) {
  return {
    adminAcknowledgedAt: readUnknown(attempt, "adminAcknowledgedAt"),
    adminNotes: readNullableString(attempt, "adminNotes"),
    adminStatus: readNullableString(attempt, "adminStatus"),
    attemptNo: toNumberOrNull(attempt.attemptNo),
    createdAt: readUnknown(attempt, "createdAt"),
    customerConfirmedAt: readUnknown(attempt, "customerConfirmedAt"),
    customerObjectedAt: readUnknown(attempt, "customerObjectedAt"),
    customerObjectionDetails: readNullableString(attempt, "customerObjectionDetails"),
    customerObjectionReason: readNullableString(attempt, "customerObjectionReason"),
    customerReviewStartedAt: readUnknown(attempt, "customerReviewStartedAt"),
    fieldSubmittedAt: readUnknown(attempt, "fieldSubmittedAt"),
    id: readString(attempt, "id"),
    resubmissionRequestedAt: readUnknown(attempt, "resubmissionRequestedAt"),
    sentBackToCustomerReviewAt: readUnknown(attempt, "sentBackToCustomerReviewAt"),
    status: readString(attempt, "status")
  };
}

function nextAttemptNo(latest: null | Record<string, unknown>) {
  const current = latest ? toNumberOrNull(latest.attemptNo) : null;
  return (current ?? 0) + 1;
}

function getHandoverReviewAdminStatus(metadata: unknown) {
  const status = readMetadataString(metadata, HANDOVER_REVIEW_ADMIN_STATUS_KEY);
  return status ?? null;
}

function isFieldResubmissionRequested(workOrder: WorkOrderRecord) {
  return getHandoverReviewAdminStatus(workOrder.metadata) === ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED;
}

function isPreviewableEvidenceMime(mimeType: null | string | undefined) {
  return Boolean(mimeType && PREVIEWABLE_EVIDENCE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)));
}

function toNumberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
}

function isTerminalWorkOrderStatus(status: unknown): status is typeof TERMINAL_WORK_ORDER_STATUSES[number] {
  return TERMINAL_WORK_ORDER_STATUSES.includes(status as typeof TERMINAL_WORK_ORDER_STATUSES[number]);
}

function isReadyForStage2Status(status: unknown): status is typeof READY_FOR_STAGE2_STATUSES[number] {
  return READY_FOR_STAGE2_STATUSES.includes(status as typeof READY_FOR_STAGE2_STATUSES[number]);
}

function assertCanMarkOpsReviewPending(workOrder: WorkOrderRecord) {
  if (isTerminalWorkOrderStatus(workOrder.status)) {
    throw new BadRequestException("交付工单已终止，不能发起运营复核。");
  }
  if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
    throw new BadRequestException("客户存在异议，需后台介入后再发起运营复核。");
  }
  if (!OPS_REVIEW_PENDING_ALLOWED_STATUSES.has(String(workOrder.status))) {
    throw new BadRequestException("运营复核只能在客户签署、平台盖章或现场完成后发起。");
  }
}

function assertDamageState(damageDeclared: unknown, noVisibleDamageDeclared: unknown) {
  if (damageDeclared === true && noVisibleDamageDeclared === true) {
    throw new BadRequestException("损伤状态冲突，请选择存在损伤或无可见损伤。");
  }
}

function assertSupportedFieldEvidenceFile(file: UploadedFieldEvidenceFile) {
  if (!file.buffer?.length) {
    throw new BadRequestException("请上传现场证据文件。");
  }
  if (!file.mimetype?.startsWith("image/") && !file.mimetype?.startsWith("video/")) {
    throw new BadRequestException("现场证据仅支持图片或视频文件。");
  }
}

function toFieldEvidenceState(workOrder: WorkOrderRecord): DeliveryEvidenceFieldState {
  return {
    damageDeclared: workOrder.damageDeclared,
    noVisibleDamageDeclared: workOrder.noVisibleDamageDeclared
  };
}

function hasAccessoryChecklist(value: unknown) {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return false;
}

function nextStatus(current: WorkOrderStatus, next: WorkOrderStatus) {
  return current === "DRAFT" || current === "ASSIGNED" ? next : current;
}

function defaultTokenExpiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

function hashAccessToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseDate(value: Date | string, fieldName: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${fieldName} 时间格式不正确。`);
  }
  return date;
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

function mergeMetadata(existing: unknown, patch: Record<string, unknown>) {
  return toJsonValue({
    ...(isPlainObject(existing) ? existing : {}),
    ...patch
  });
}

function compactUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function toJsonValue(value: unknown) {
  return value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
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
