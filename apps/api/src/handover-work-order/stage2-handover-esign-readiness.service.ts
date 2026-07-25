import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryHandoverStatus,
  ESignSigningStage,
  ESignTaskStatus,
  OrderStatus,
  Prisma,
  VehicleHandoverAdminReviewStatus,
  VehicleHandoverReviewAttemptStatus,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";

import { DeliveryEvidenceService } from "../delivery-evidence/delivery-evidence.service";
import { STAGE2_HANDOVER_PDF_HARD_MAX_BYTES } from "../delivery-handover/delivery-handover-pdf-renderer.service";
import { FadadaCustomerReadinessService } from "../esign/fadada-customer-readiness.service";
import { PrismaService } from "../prisma/prisma.service";
import { HandoverWorkOrderService } from "./handover-work-order.service";

export const STAGE2_HANDOVER_ESIGN_NOT_READY = "STAGE2_HANDOVER_ESIGN_NOT_READY";

export type Stage2HandoverESignBlockerCode =
  | "ACTIVE_ESIGN_TASK_CONFLICT"
  | "ADMIN_REVIEW_PENDING"
  | "CONFIRMED_FIELD_FACTS_MISMATCH"
  | "CONFIRMED_MANIFEST_MISMATCH"
  | "CURRENT_MANIFEST_UNAVAILABLE"
  | "CUSTOMER_CERT_NOT_READY"
  | "CUSTOMER_CONFIRMATION_MISSING"
  | "CUSTOMER_ESIGN_NOT_READY"
  | "CUSTOMER_OBJECTION_ACTIVE"
  | "CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED"
  | "CUSTOMER_READINESS_STALE"
  | "CUSTOMER_READINESS_TIMESTAMP_INVALID"
  | "EVIDENCE_NOT_READY"
  | "FIELD_FACTS_INCOMPLETE"
  | "HANDOVER_MISSING"
  | "HANDOVER_SOURCE_NOT_GENERATED"
  | "LATEST_REVIEW_NOT_CONFIRMED"
  | "ORDER_MISSING"
  | "ORDER_NOT_READY_FOR_DELIVERY"
  | "ORDER_TERMINAL_OR_DELIVERED"
  | "PLATFORM_CUSTOMER_ID_MISSING"
  | "PLATFORM_SIGNATURE_ID_MISSING"
  | "SIGNING_SLOTS_INVALID"
  | "SOURCE_ARTIFACT_VERSION_INVALID"
  | "SOURCE_CONTRACT_INVALID"
  | "SOURCE_CONTRACT_MISSING"
  | "SOURCE_MANIFEST_MISMATCH"
  | "SOURCE_PDF_HASH_INVALID"
  | "SOURCE_PDF_INVALID"
  | "SOURCE_PDF_MISSING"
  | "SOURCE_PDF_TOO_LARGE"
  | "SOURCE_TEMPLATE_NOT_ACTIVE"
  | "STAGE1_CONTRACT_NOT_CURRENT"
  | "STAGE1_CONTRACT_NOT_SIGNED"
  | "WORK_ORDER_MISSING"
  | "WORK_ORDER_NOT_READY_FOR_ESIGN"
  | "WORK_ORDER_TERMINAL";

export interface Stage2HandoverESignBlocker {
  code: Stage2HandoverESignBlockerCode;
  message: string;
}

export interface Stage2HandoverESignReadinessState {
  esignTaskId: string | null;
  esignTaskStatus: ESignTaskStatus | null;
  handoverContractId: string | null;
  handoverId: string | null;
  handoverStatus: DeliveryHandoverStatus | null;
  orderId: string | null;
  orderStatus: OrderStatus | null;
  workOrderId: string;
  workOrderStatus: VehicleHandoverWorkOrderStatus | null;
}

export interface Stage2HandoverESignReadiness {
  blockers: Stage2HandoverESignBlocker[];
  ready: boolean;
  state: Stage2HandoverESignReadinessState;
}

const BLOCKER_MESSAGES: Record<Stage2HandoverESignBlockerCode, string> = {
  ACTIVE_ESIGN_TASK_CONFLICT: "An active Stage 2 signing task already exists.",
  ADMIN_REVIEW_PENDING: "The latest handover resubmission is pending Admin review.",
  CONFIRMED_FIELD_FACTS_MISMATCH: "Customer confirmation does not cover the current handover field facts.",
  CONFIRMED_MANIFEST_MISMATCH: "Customer confirmation does not cover the current evidence manifest.",
  CURRENT_MANIFEST_UNAVAILABLE: "The current evidence manifest is unavailable.",
  CUSTOMER_CERT_NOT_READY: "The customer signing certificate is not ready.",
  CUSTOMER_CONFIRMATION_MISSING: "Customer no-objection confirmation is required.",
  CUSTOMER_ESIGN_NOT_READY: "The customer Fadada account is not ready for signing.",
  CUSTOMER_OBJECTION_ACTIVE: "The customer has an active handover objection.",
  CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED: "Customer provider-readiness freshness is not configured.",
  CUSTOMER_READINESS_STALE: "Customer provider-readiness evidence is stale.",
  CUSTOMER_READINESS_TIMESTAMP_INVALID: "Customer provider-readiness evidence has an invalid timestamp.",
  EVIDENCE_NOT_READY: "Required Stage 2 evidence is not ready.",
  FIELD_FACTS_INCOMPLETE: "Required handover field facts are incomplete.",
  HANDOVER_MISSING: "The Stage 2 handover record is missing.",
  HANDOVER_SOURCE_NOT_GENERATED: "The Stage 2 handover source is not in SOURCE_GENERATED state.",
  LATEST_REVIEW_NOT_CONFIRMED: "The latest handover review attempt is not customer-confirmed.",
  ORDER_MISSING: "The subscription order is missing.",
  ORDER_NOT_READY_FOR_DELIVERY: "The order is not in the delivery-ready state.",
  ORDER_TERMINAL_OR_DELIVERED: "The order is terminal or already delivered.",
  PLATFORM_CUSTOMER_ID_MISSING: "The platform Fadada customer ID is not configured.",
  PLATFORM_SIGNATURE_ID_MISSING: "The platform Fadada signature ID is not configured.",
  SIGNING_SLOTS_INVALID: "The persisted Stage 2 signing slots are invalid.",
  SOURCE_ARTIFACT_VERSION_INVALID: "The Stage 2 source artifact version is invalid.",
  SOURCE_CONTRACT_INVALID: "The generated Stage 2 Contract is invalid.",
  SOURCE_CONTRACT_MISSING: "The generated Stage 2 Contract is missing.",
  SOURCE_MANIFEST_MISMATCH: "The generated source manifest does not match current evidence.",
  SOURCE_PDF_HASH_INVALID: "The Stage 2 source PDF hash is missing or invalid.",
  SOURCE_PDF_INVALID: "The Stage 2 source file is not a valid declared PDF artifact.",
  SOURCE_PDF_MISSING: "The Stage 2 source PDF FileObject is missing.",
  SOURCE_PDF_TOO_LARGE: "The Stage 2 source PDF exceeds the 18 MiB internal limit.",
  SOURCE_TEMPLATE_NOT_ACTIVE: "The Stage 2 Contract template is not an active delivery handover template.",
  STAGE1_CONTRACT_NOT_CURRENT: "The signed Stage 1 Contract is no longer current for the order.",
  STAGE1_CONTRACT_NOT_SIGNED: "The current Stage 1 subscription Contract is not signed.",
  WORK_ORDER_MISSING: "The Stage 2 handover work order is missing.",
  WORK_ORDER_NOT_READY_FOR_ESIGN: "The handover work order is not ready to start Stage 2 signing.",
  WORK_ORDER_TERMINAL: "The handover work order is terminal."
};

const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.ACTIVE,
  OrderStatus.CANCELLED,
  OrderStatus.COMPLETED,
  OrderStatus.REJECTED,
  OrderStatus.TERMINATED
]);
const TERMINAL_WORK_ORDER_STATUSES = new Set<VehicleHandoverWorkOrderStatus>([
  VehicleHandoverWorkOrderStatus.CANCELLED,
  VehicleHandoverWorkOrderStatus.FAILED,
  VehicleHandoverWorkOrderStatus.VOIDED
]);
const ACTIVE_ESIGN_TASK_STATUSES = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.WAITING_CUSTOMER
] as const;
const CUSTOMER_READINESS_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const VALID_STAGE1_CONTRACT_STATUSES = new Set<ContractStatus>([
  ContractStatus.SIGNED,
  ContractStatus.ARCHIVED
]);
const SIGNING_RELEVANT_FIELD_FACT_KEYS = [
  "accessoryChecklist",
  "damageDeclared",
  "deliveryLocation",
  "energyLevelText",
  "fieldNotes",
  "fuelLevelText",
  "handoverMileageKm",
  "noVisibleDamageDeclared",
  "scheduledAt"
] as const;
const REQUIRED_STAGE2_SLOT_IDS = [
  "STAGE2_HANDOVER_CUSTOMER",
  "STAGE2_HANDOVER_PLATFORM"
] as const;

const readinessWorkOrderInclude = {
  handover: {
    include: {
      handoverContract: {
        include: {
          contractVersion: true
        }
      },
      stage1Contract: true
    }
  },
  order: {
    select: {
      actualDeliveryAt: true,
      contractId: true,
      customerId: true,
      deletedAt: true,
      id: true,
      orderStatus: true
    }
  }
} satisfies Prisma.VehicleHandoverWorkOrderInclude;

type ReadinessWorkOrder = Prisma.VehicleHandoverWorkOrderGetPayload<{
  include: typeof readinessWorkOrderInclude;
}>;

@Injectable()
export class Stage2HandoverESignReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryEvidenceService: DeliveryEvidenceService,
    private readonly fadadaCustomerReadinessService: FadadaCustomerReadinessService,
    private readonly handoverWorkOrderService: HandoverWorkOrderService,
    private readonly configService: ConfigService
  ) {}

  async getReadiness(workOrderId: string): Promise<Stage2HandoverESignReadiness> {
    const blockers: Stage2HandoverESignBlocker[] = [];
    const addBlocker = (code: Stage2HandoverESignBlockerCode) => {
      if (!blockers.some((blocker) => blocker.code === code)) {
        blockers.push({ code, message: BLOCKER_MESSAGES[code] });
      }
    };
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({
      include: readinessWorkOrderInclude,
      where: { id: workOrderId }
    });

    if (!workOrder) {
      addBlocker("WORK_ORDER_MISSING");
      return buildResult(blockers, {
        esignTaskId: null,
        esignTaskStatus: null,
        handoverContractId: null,
        handoverId: null,
        handoverStatus: null,
        orderId: null,
        orderStatus: null,
        workOrderId,
        workOrderStatus: null
      });
    }

    this.checkOrder(workOrder, addBlocker);
    this.checkWorkOrder(workOrder, addBlocker);
    this.checkFieldFacts(workOrder, addBlocker);

    const handover = workOrder.handover;
    if (!handover || handover.deletedAt) {
      addBlocker("HANDOVER_MISSING");
    } else {
      this.checkHandoverSource(handover, addBlocker);
      this.checkStage1Contract(
        handover.stage1Contract,
        workOrder.order.contractId,
        addBlocker
      );
      this.checkSourceContract(handover, addBlocker);
    }

    const latestReviewAttempt = await this.prisma.vehicleHandoverReviewAttempt.findFirst({
      orderBy: { attemptNo: "desc" },
      where: { workOrderId }
    });
    this.checkLatestReviewAttempt(latestReviewAttempt, workOrder, addBlocker);

    let currentManifestHash: string | null = null;
    try {
      const currentPackage = await this.handoverWorkOrderService.getCurrentEvidencePackage(workOrderId);
      currentManifestHash = normalizeManifestHash(currentPackage.manifestHash);
      if (!currentManifestHash) {
        addBlocker("CURRENT_MANIFEST_UNAVAILABLE");
      }
    } catch {
      addBlocker("CURRENT_MANIFEST_UNAVAILABLE");
    }

    if (currentManifestHash) {
      this.checkManifestBindings(
        handover,
        latestReviewAttempt,
        currentManifestHash,
        addBlocker
      );
    }

    try {
      const evidenceReadiness =
        await this.deliveryEvidenceService.validateEvidenceReadyForStage2ESign(
          workOrder.orderId,
          workOrder.handoverId,
          {
            damageDeclared: workOrder.damageDeclared,
            noVisibleDamageDeclared: workOrder.noVisibleDamageDeclared
          }
        );
      if (!evidenceReadiness.ready) {
        addBlocker("EVIDENCE_NOT_READY");
      }
    } catch {
      addBlocker("EVIDENCE_NOT_READY");
    }

    await this.checkCustomerReadiness(workOrder.order.customerId, addBlocker);
    this.checkPlatformConfiguration(addBlocker);

    const sourceFile = handover?.sourceDocumentFileId
      ? await this.prisma.fileObject.findUnique({
          where: { id: handover.sourceDocumentFileId }
        })
      : null;
    this.checkSourceFile(handover, sourceFile, addBlocker);

    const activeTaskPointers: Prisma.ContractESignTaskWhereInput[] = [];
    if (handover?.handoverContractId) {
      activeTaskPointers.push({ contractId: handover.handoverContractId });
    }
    if (handover?.handoverESignTaskId) {
      activeTaskPointers.push({ id: handover.handoverESignTaskId });
    }
    const activeTask = activeTaskPointers.length > 0
      ? await this.prisma.contractESignTask.findFirst({
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            taskStatus: true
          },
          where: {
            deletedAt: null,
            OR: activeTaskPointers,
            signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
            taskStatus: { in: [...ACTIVE_ESIGN_TASK_STATUSES] }
          }
        })
      : null;
    if (activeTask) {
      addBlocker("ACTIVE_ESIGN_TASK_CONFLICT");
    }

    return buildResult(blockers, {
      esignTaskId: activeTask?.id ?? null,
      esignTaskStatus: activeTask?.taskStatus ?? null,
      handoverContractId: handover?.handoverContractId ?? null,
      handoverId: handover?.id ?? null,
      handoverStatus: handover?.status ?? null,
      orderId: workOrder.order.id,
      orderStatus: workOrder.order.orderStatus,
      workOrderId,
      workOrderStatus: workOrder.status
    });
  }

  async assertReady(workOrderId: string): Promise<Stage2HandoverESignReadiness> {
    const readiness = await this.getReadiness(workOrderId);
    if (!readiness.ready) {
      throw new BadRequestException({
        blockers: readiness.blockers,
        code: STAGE2_HANDOVER_ESIGN_NOT_READY,
        message: "Stage 2 handover eSign is not ready.",
        ready: false,
        state: readiness.state
      });
    }
    return readiness;
  }

  private checkOrder(
    workOrder: ReadinessWorkOrder,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    const order = workOrder.order;
    if (!order || order.deletedAt) {
      addBlocker("ORDER_MISSING");
      return;
    }
    if (
      order.actualDeliveryAt ||
      TERMINAL_ORDER_STATUSES.has(order.orderStatus)
    ) {
      addBlocker("ORDER_TERMINAL_OR_DELIVERED");
      return;
    }
    if (order.orderStatus !== OrderStatus.PENDING_DELIVERY) {
      addBlocker("ORDER_NOT_READY_FOR_DELIVERY");
    }
  }

  private checkWorkOrder(
    workOrder: ReadinessWorkOrder,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (TERMINAL_WORK_ORDER_STATUSES.has(workOrder.status)) {
      addBlocker("WORK_ORDER_TERMINAL");
      return;
    }
    if (workOrder.status !== VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED) {
      addBlocker("WORK_ORDER_NOT_READY_FOR_ESIGN");
    }
    if (!workOrder.customerConfirmedAt) {
      addBlocker("CUSTOMER_CONFIRMATION_MISSING");
    }
    if (
      workOrder.status === VehicleHandoverWorkOrderStatus.CUSTOMER_OBJECTED ||
      workOrder.customerObjectedAt
    ) {
      addBlocker("CUSTOMER_OBJECTION_ACTIVE");
    }
    if (
      workOrder.adminReviewStatus ===
      VehicleHandoverAdminReviewStatus.RESUBMITTED_PENDING_ADMIN
    ) {
      addBlocker("ADMIN_REVIEW_PENDING");
    }
  }

  private checkFieldFacts(
    workOrder: ReadinessWorkOrder,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (
      !workOrder.fieldSubmittedAt ||
      !Number.isSafeInteger(workOrder.handoverMileageKm) ||
      (workOrder.handoverMileageKm ?? 0) <= 0 ||
      (!hasText(workOrder.energyLevelText) && !hasText(workOrder.fuelLevelText)) ||
      !hasAccessoryChecklist(workOrder.accessoryChecklist) ||
      (workOrder.damageDeclared === true) ===
        (workOrder.noVisibleDamageDeclared === true)
    ) {
      addBlocker("FIELD_FACTS_INCOMPLETE");
    }
  }

  private checkHandoverSource(
    handover: NonNullable<ReadinessWorkOrder["handover"]>,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (handover.status !== DeliveryHandoverStatus.SOURCE_GENERATED) {
      addBlocker("HANDOVER_SOURCE_NOT_GENERATED");
    }
    if (handover.artifactVersion !== 1) {
      addBlocker("SOURCE_ARTIFACT_VERSION_INVALID");
    }
    if (!isSha256Digest(handover.sourcePdfHash)) {
      addBlocker("SOURCE_PDF_HASH_INVALID");
    }
  }

  private checkStage1Contract(
    stage1Contract: NonNullable<ReadinessWorkOrder["handover"]>["stage1Contract"],
    currentContractId: string | null,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (
      !stage1Contract ||
      stage1Contract.deletedAt ||
      !VALID_STAGE1_CONTRACT_STATUSES.has(stage1Contract.status)
    ) {
      addBlocker("STAGE1_CONTRACT_NOT_SIGNED");
    }
    if (!currentContractId || stage1Contract.id !== currentContractId) {
      addBlocker("STAGE1_CONTRACT_NOT_CURRENT");
    }
  }

  private checkSourceContract(
    handover: NonNullable<ReadinessWorkOrder["handover"]>,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    const contract = handover.handoverContract;
    if (!contract || contract.deletedAt) {
      addBlocker("SOURCE_CONTRACT_MISSING");
      return;
    }
    if (
      contract.id !== handover.handoverContractId ||
      contract.status !== ContractStatus.GENERATED ||
      !contract.fileId ||
      contract.fileId !== handover.sourceDocumentFileId
    ) {
      addBlocker("SOURCE_CONTRACT_INVALID");
    }
    if (!isActiveStage2Template(contract.contractVersion)) {
      addBlocker("SOURCE_TEMPLATE_NOT_ACTIVE");
    }
    if (!hasStrictStage2ArtifactMetadata(
      contract.contractSnapshot,
      contract.fileId
    )) {
      addBlocker("SIGNING_SLOTS_INVALID");
    }
  }

  private checkLatestReviewAttempt(
    latestReviewAttempt: null | {
      adminStatus: VehicleHandoverAdminReviewStatus | null;
      evidenceSnapshot: Prisma.JsonValue | null;
      fieldFactsSnapshot: Prisma.JsonValue | null;
      status: VehicleHandoverReviewAttemptStatus;
    },
    workOrder: ReadinessWorkOrder,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (
      !latestReviewAttempt ||
      latestReviewAttempt.status !==
        VehicleHandoverReviewAttemptStatus.CUSTOMER_CONFIRMED
    ) {
      addBlocker("LATEST_REVIEW_NOT_CONFIRMED");
    } else if (
      !matchesConfirmedFieldFacts(
        latestReviewAttempt.fieldFactsSnapshot,
        workOrder
      )
    ) {
      addBlocker("CONFIRMED_FIELD_FACTS_MISMATCH");
    }
    if (
      latestReviewAttempt?.adminStatus ===
      VehicleHandoverAdminReviewStatus.RESUBMITTED_PENDING_ADMIN
    ) {
      addBlocker("ADMIN_REVIEW_PENDING");
    }
  }

  private checkManifestBindings(
    handover: ReadinessWorkOrder["handover"],
    latestReviewAttempt: null | { evidenceSnapshot: Prisma.JsonValue | null },
    currentManifestHash: string,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    const confirmedManifestHash = normalizeManifestHash(
      readNestedString(latestReviewAttempt?.evidenceSnapshot, [
        "evidencePackage",
        "manifestHash"
      ])
    );
    if (confirmedManifestHash !== currentManifestHash) {
      addBlocker("CONFIRMED_MANIFEST_MISMATCH");
    }

    const sourceManifestHash = normalizeManifestHash(handover?.manifestHash);
    const contractManifestHash = normalizeManifestHash(
      readNestedString(handover?.handoverContract?.contractSnapshot, [
        "evidencePackage",
        "manifestHash"
      ])
    );
    if (
      sourceManifestHash !== currentManifestHash ||
      contractManifestHash !== currentManifestHash
    ) {
      addBlocker("SOURCE_MANIFEST_MISMATCH");
    }
  }

  private async checkCustomerReadiness(
    customerId: string,
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    const readiness =
      await this.fadadaCustomerReadinessService.getReadiness(customerId);
    if (
      !readiness.certBound ||
      !readiness.certSerialNoPresent
    ) {
      addBlocker("CUSTOMER_CERT_NOT_READY");
    }
    if (
      !readiness.readyForSigning ||
      !readiness.providerCustomerIdPresent ||
      !readiness.realNameProviderVerified
    ) {
      addBlocker("CUSTOMER_ESIGN_NOT_READY");
    }

    const freshnessDays = Number(
      this.configService.get<string>("FADADA_PROVIDER_STATUS_FRESHNESS_DAYS")
    );
    if (!Number.isFinite(freshnessDays) || freshnessDays <= 0) {
      addBlocker("CUSTOMER_READINESS_FRESHNESS_UNCONFIGURED");
      return;
    }
    if (!readiness.lastProviderCheckAt) {
      addBlocker("CUSTOMER_READINESS_STALE");
      return;
    }

    const providerCheckAtMs = readiness.lastProviderCheckAt instanceof Date
      ? readiness.lastProviderCheckAt.getTime()
      : Number.NaN;
    const providerCheckAgeMs = Date.now() - providerCheckAtMs;
    if (
      !Number.isFinite(providerCheckAtMs) ||
      providerCheckAgeMs < -CUSTOMER_READINESS_CLOCK_SKEW_MS
    ) {
      addBlocker("CUSTOMER_READINESS_TIMESTAMP_INVALID");
      return;
    }
    if (providerCheckAgeMs > freshnessDays * 24 * 60 * 60 * 1000) {
      addBlocker("CUSTOMER_READINESS_STALE");
    }
  }

  private checkPlatformConfiguration(
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (!hasText(this.configService.get<string>("FADADA_PLATFORM_CUSTOMER_ID"))) {
      addBlocker("PLATFORM_CUSTOMER_ID_MISSING");
    }
    if (!hasText(this.configService.get<string>("FADADA_PLATFORM_SIGNATURE_ID"))) {
      addBlocker("PLATFORM_SIGNATURE_ID_MISSING");
    }
  }

  private checkSourceFile(
    handover: ReadinessWorkOrder["handover"],
    fileObject: null | {
      id: string;
      mimeType: string | null;
      sizeBytes: bigint;
    },
    addBlocker: (code: Stage2HandoverESignBlockerCode) => void
  ) {
    if (!handover?.sourceDocumentFileId || !fileObject) {
      addBlocker("SOURCE_PDF_MISSING");
      return;
    }
    const declaredSize = Number(fileObject.sizeBytes);
    if (
      fileObject.id !== handover.sourceDocumentFileId ||
      fileObject.mimeType?.trim().toLowerCase() !== "application/pdf" ||
      !Number.isSafeInteger(declaredSize) ||
      declaredSize <= 0
    ) {
      addBlocker("SOURCE_PDF_INVALID");
      return;
    }
    if (declaredSize > STAGE2_HANDOVER_PDF_HARD_MAX_BYTES) {
      addBlocker("SOURCE_PDF_TOO_LARGE");
    }
  }
}

function buildResult(
  blockers: Stage2HandoverESignBlocker[],
  state: Stage2HandoverESignReadinessState
): Stage2HandoverESignReadiness {
  return {
    blockers,
    ready: blockers.length === 0,
    state
  };
}

function matchesConfirmedFieldFacts(
  fieldFactsSnapshot: Prisma.JsonValue | null,
  workOrder: ReadinessWorkOrder
) {
  const snapshot = asRecord(fieldFactsSnapshot);
  if (
    !snapshot ||
    SIGNING_RELEVANT_FIELD_FACT_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(snapshot, key)
    )
  ) {
    return false;
  }

  const snapshotScheduledAt = normalizeScheduledAt(snapshot.scheduledAt);
  const currentScheduledAt = normalizeScheduledAt(workOrder.scheduledAt);
  if (
    snapshotScheduledAt === INVALID_SCHEDULED_AT ||
    currentScheduledAt === INVALID_SCHEDULED_AT
  ) {
    return false;
  }

  const normalizedSnapshot = {
    accessoryChecklist: snapshot.accessoryChecklist,
    damageDeclared: snapshot.damageDeclared,
    deliveryLocation: snapshot.deliveryLocation,
    energyLevelText: snapshot.energyLevelText,
    fieldNotes: snapshot.fieldNotes,
    fuelLevelText: snapshot.fuelLevelText,
    handoverMileageKm: snapshot.handoverMileageKm,
    noVisibleDamageDeclared: snapshot.noVisibleDamageDeclared,
    scheduledAt: snapshotScheduledAt
  };
  const currentFacts = {
    accessoryChecklist: workOrder.accessoryChecklist ?? null,
    damageDeclared: workOrder.damageDeclared ?? null,
    deliveryLocation: workOrder.deliveryLocation ?? null,
    energyLevelText: workOrder.energyLevelText ?? null,
    fieldNotes: workOrder.fieldNotes ?? null,
    fuelLevelText: workOrder.fuelLevelText ?? null,
    handoverMileageKm: workOrder.handoverMileageKm ?? null,
    noVisibleDamageDeclared: workOrder.noVisibleDamageDeclared ?? null,
    scheduledAt: currentScheduledAt
  };

  return stableSerialize(normalizedSnapshot) === stableSerialize(currentFacts);
}

const INVALID_SCHEDULED_AT = Symbol("INVALID_SCHEDULED_AT");

function normalizeScheduledAt(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(value instanceof Date) && typeof value !== "string") {
    return INVALID_SCHEDULED_AT;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : INVALID_SCHEDULED_AT;
}

function stableSerialize(value: unknown) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJsonValue(record[key])])
  );
}

function isActiveStage2Template(
  version: {
    deletedAt: Date | null;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    status: ContractVersionStatus;
    templateType: ContractTemplateType;
  }
) {
  const now = Date.now();
  return (
    !version.deletedAt &&
    version.status === ContractVersionStatus.ACTIVE &&
    version.templateType === ContractTemplateType.DELIVERY_HANDOVER &&
    version.effectiveFrom.getTime() <= now &&
    (!version.effectiveTo || version.effectiveTo.getTime() >= now)
  );
}

function hasStrictStage2ArtifactMetadata(
  snapshot: Prisma.JsonValue,
  fileId: string | null
) {
  const artifact = asRecord(asRecord(snapshot)?.stage2HandoverPdfArtifact);
  if (
    !artifact ||
    artifact.artifactKind !== "stage2-handover-pdf-source" ||
    artifact.documentType !== "DELIVERY_HANDOVER_CONFIRMATION" ||
    artifact.fileId !== fileId ||
    artifact.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    !Number.isInteger(artifact.pageCount) ||
    (artifact.pageCount as number) <= 0 ||
    !Array.isArray(artifact.slotCoordinates) ||
    artifact.slotCoordinates.length !== REQUIRED_STAGE2_SLOT_IDS.length
  ) {
    return false;
  }

  const pageCount = artifact.pageCount as number;
  const slotCoordinates = artifact.slotCoordinates;
  return REQUIRED_STAGE2_SLOT_IDS.every((slotId) => {
    const matches = slotCoordinates.filter(
      (value: unknown) => asRecord(value)?.slotId === slotId
    );
    if (matches.length !== 1) {
      return false;
    }
    const coordinate = asRecord(matches[0]);
    return Boolean(
      coordinate &&
      coordinate.coordinateSource === "PDFKIT_RENDERER" &&
      coordinate.coordinateSystem === "FADADA_800_1131_TOP_LEFT" &&
      coordinate.documentType === "DELIVERY_HANDOVER_CONFIRMATION" &&
      coordinate.signingStage === "STAGE2_DELIVERY_HANDOVER" &&
      Number.isInteger(coordinate.pageNumber) &&
      coordinate.pageNumber === pageCount - 1 &&
      isFiniteNumberInRange(coordinate.x, 0, 800) &&
      isFiniteNumberInRange(coordinate.y, 0, 1131) &&
      isFinitePositiveNumber(coordinate.width) &&
      isFinitePositiveNumber(coordinate.height) &&
      isFinitePositiveNumber(coordinate.pdfPageWidth) &&
      isFinitePositiveNumber(coordinate.pdfPageHeight) &&
      (coordinate.x as number) - (coordinate.width as number) / 2 >= 0 &&
      (coordinate.x as number) + (coordinate.width as number) / 2 <= 800 &&
      (coordinate.y as number) - (coordinate.height as number) / 2 >= 0 &&
      (coordinate.y as number) + (coordinate.height as number) / 2 <= 1131
    );
  });
}

function normalizeManifestHash(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_DIGEST_PATTERN.test(normalized) ? normalized : null;
}

function isSha256Digest(value: unknown) {
  return (
    typeof value === "string" &&
    SHA256_DIGEST_PATTERN.test(value.trim())
  );
}

function readNestedString(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return typeof current === "string" ? current : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFiniteNumberInRange(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isFinitePositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasText(value: unknown) {
  return typeof value === "string" && Boolean(value.trim());
}

function hasAccessoryChecklist(value: unknown) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(asRecord(value) && Object.keys(asRecord(value)!).length > 0);
}
