import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { DeliveryEvidenceMediaType, Prisma } from "@prisma/client";

import {
  DeliveryEvidenceFieldState,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import { PrismaService } from "../prisma/prisma.service";

const TERMINAL_WORK_ORDER_STATUSES = ["VOIDED", "FAILED", "CANCELLED"] as const;
const READY_FOR_STAGE2_STATUSES = [
  "CUSTOMER_CONFIRMED",
  "SIGNING",
  "CUSTOMER_SIGNED",
  "PLATFORM_SEALED",
  "FIELD_COMPLETED",
  "OPS_REVIEW_PENDING",
  "OPS_REVIEWED"
] as const;
const CUSTOMER_REVIEW_STATUSES = new Set(["CUSTOMER_REVIEWING", "EVIDENCE_SUBMITTED", "CUSTOMER_CONFIRMED"]);

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
  customerConfirmedAt?: Date | null;
  customerObjectedAt?: Date | null;
  customerReviewStartedAt?: Date | null;
  damageDeclared?: boolean | null;
  deliveryLocation?: string | null;
  energyLevelText?: string | null;
  externalOperatorName?: string | null;
  fieldCompletedAt?: Date | null;
  fieldStartedAt?: Date | null;
  fieldSubmittedAt?: Date | null;
  fuelLevelText?: string | null;
  handoverId?: string | null;
  handoverMileageKm?: number | null;
  id: string;
  metadata?: unknown;
  noVisibleDamageDeclared?: boolean | null;
  operatorType?: string | null;
  orderId: string;
  scheduledAt?: Date | null;
  status: string;
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

@Injectable()
export class HandoverWorkOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryEvidenceService: DeliveryEvidenceService,
    @Optional() private readonly deliveryHandoverService?: DeliveryHandoverService
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
    return this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: { createdAt: "desc" },
      where: { orderId }
    });
  }

  async getById(id: string) {
    return this.getWorkOrderOrThrow(id);
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
      externalOperatorPhone: normalizeOptionalText(input.phone),
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
    return this.startFieldWork(workOrder.id, workOrder.externalOperatorName ?? "external");
  }

  async updateFieldFacts(id: string, input: UpdateFieldFactsInput, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertDamageState(input.damageDeclared, input.noVisibleDamageDeclared);

    return this.updateWorkOrder(id, compactUndefined({
      accessoryChecklist: input.accessoryChecklist === undefined ? undefined : toJsonValue(input.accessoryChecklist),
      damageDeclared: input.damageDeclared,
      deliveryLocation: normalizeOptionalText(input.deliveryLocation),
      energyLevelText: normalizeOptionalText(input.energyLevelText),
      fieldNotes: normalizeOptionalText(input.fieldNotes),
      fuelLevelText: normalizeOptionalText(input.fuelLevelText),
      handoverMileageKm: input.handoverMileageKm,
      metadata: mergeMetadata(workOrder.metadata, { fieldFactsUpdatedBy: actorId ?? null }),
      noVisibleDamageDeclared: input.noVisibleDamageDeclared,
      scheduledAt: input.scheduledAt === undefined ? undefined : (
        input.scheduledAt ? parseDate(input.scheduledAt, "scheduledAt") : null
      ),
      status: workOrder.status === "DRAFT" ? "FIELD_IN_PROGRESS" : workOrder.status
    }));
  }

  async updateFieldFactsByToken(token: string, input: UpdateFieldFactsInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    return this.updateFieldFacts(workOrder.id, input, workOrder.externalOperatorName ?? "external");
  }

  async attachEvidenceFileWithExternalToken(token: string, itemId: string, input: AttachFieldEvidenceFileInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    const item = await this.prisma.vehicleDeliveryEvidenceItem.findFirst({
      where: {
        id: itemId,
        orderId: workOrder.orderId
      }
    });
    if (!item) {
      throw new NotFoundException("交付证据项不存在。");
    }
    return this.deliveryEvidenceService.attachEvidenceFile(
      itemId,
      input.fileId,
      input.mediaType,
      workOrder.externalOperatorName ?? "external"
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
    return this.updateWorkOrder(id, {
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? now,
      fieldSubmittedAt: workOrder.fieldSubmittedAt ?? now,
      metadata: mergeMetadata(workOrder.metadata, { fieldSubmittedBy: actorId ?? null }),
      status: "CUSTOMER_REVIEWING"
    });
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
    if (!CUSTOMER_REVIEW_STATUSES.has(String(workOrder.status))) {
      throw new BadRequestException("客户尚未进入交付复核。");
    }
    assertFieldFactsComplete(workOrder);
    await this.deliveryEvidenceService.assertFieldEvidenceComplete(
      workOrder.orderId,
      workOrder.handoverId ?? null,
      toFieldEvidenceState(workOrder)
    );
    return this.updateWorkOrder(id, {
      customerConfirmedAt: workOrder.customerConfirmedAt ?? new Date(),
      customerObjectedAt: null,
      customerObjectionReason: null,
      status: "CUSTOMER_CONFIRMED"
    });
  }

  async customerObject(id: string, customerId: string, reason: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertCustomerOwnsWorkOrder(workOrder, customerId);
    this.assertMutable(workOrder);
    return this.updateWorkOrder(id, {
      customerObjectedAt: new Date(),
      customerObjectionReason: normalizeRequiredText(reason, "请填写客户异议原因。"),
      status: "CUSTOMER_OBJECTED"
    });
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
    return {
      customer: {
        displayName: order.customer?.name ?? null,
        mobileMasked: maskPhone(order.customer?.mobile)
      },
      deliveryLocation: workOrder.deliveryLocation,
      evidenceChecklist: await this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }),
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

  private updateWorkOrder(id: string, data: Record<string, unknown>) {
    return this.prisma.vehicleHandoverWorkOrder.update({
      data: compactUndefined(data),
      where: { id }
    });
  }
}

function assertFieldFactsComplete(workOrder: WorkOrderRecord) {
  if (workOrder.handoverMileageKm === null || workOrder.handoverMileageKm === undefined) {
    throw new BadRequestException("请填写交付里程。");
  }
  if (typeof workOrder.handoverMileageKm !== "number" || workOrder.handoverMileageKm < 0) {
    throw new BadRequestException("交付里程不合法。");
  }
  if (!normalizeOptionalText(workOrder.energyLevelText) && !normalizeOptionalText(workOrder.fuelLevelText)) {
    throw new BadRequestException("请填写能源/油量状态。");
  }
  if (!hasAccessoryChecklist(workOrder.accessoryChecklist)) {
    throw new BadRequestException("请填写随车物品清单。");
  }
  assertDamageState(workOrder.damageDeclared, workOrder.noVisibleDamageDeclared);
  if (workOrder.damageDeclared !== true && workOrder.noVisibleDamageDeclared !== true) {
    throw new BadRequestException("请处理车辆损伤状态。");
  }
}

function isTerminalWorkOrderStatus(status: unknown): status is typeof TERMINAL_WORK_ORDER_STATUSES[number] {
  return TERMINAL_WORK_ORDER_STATUSES.includes(status as typeof TERMINAL_WORK_ORDER_STATUSES[number]);
}

function isReadyForStage2Status(status: unknown): status is typeof READY_FOR_STAGE2_STATUSES[number] {
  return READY_FOR_STAGE2_STATUSES.includes(status as typeof READY_FOR_STAGE2_STATUSES[number]);
}

function assertDamageState(damageDeclared: unknown, noVisibleDamageDeclared: unknown) {
  if (damageDeclared === true && noVisibleDamageDeclared === true) {
    throw new BadRequestException("损伤状态冲突，请选择存在损伤或无可见损伤。");
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
