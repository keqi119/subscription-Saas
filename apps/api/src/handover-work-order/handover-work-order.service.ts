import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BusinessType,
  ContractStatus,
  ContractTemplateType,
  ContractVersionStatus,
  DeliveryEvidenceFileLifecycleStatus,
  DeliveryEvidenceMediaType,
  DeliveryEvidenceType,
  DeliveryStatus,
  FieldEvidenceVideoUploadStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignTaskStatus,
  FieldOperatorAuditEventType,
  Prisma,
  OrderStatus,
  SubscriptionJourneyStatus,
  SubscriptionJourneyStepCode,
  UserStatus,
  VehicleInspectionStatus,
  VehicleStatus,
  VehicleHandoverAdminReviewStatus,
  VehicleHandoverEventActorType,
  VehicleHandoverEventType,
  VehicleHandoverType,
  VehicleHandoverWorkOrderStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";

import {
  DeliveryEvidenceFieldState,
  DeliveryEvidenceService
} from "../delivery-evidence/delivery-evidence.service";
import { createBusinessNo } from "../common/business-number";
import { resolveVehicleInsuranceCoverage } from "../common/vehicle-insurance-coverage";
import {
  DeliveryHandoverEvidenceArtifactService,
  getDeliveryEvidenceVideoQualityPublicMessage,
  isDeliveryEvidenceArtifactProcessingError,
  PreparedDeliveryEvidenceArtifacts
} from "../delivery-handover/delivery-handover-evidence-artifact.service";
import {
  buildDeliveryHandoverEvidencePackage,
  DeliveryHandoverEvidencePackage
} from "../delivery-handover/delivery-handover-evidence-manifest";
import {
  buildDeliveryHandoverPdfRenderModel,
  DeliveryHandoverPdfRenderModelInput
} from "../delivery-handover/delivery-handover-pdf-render-model";
import {
  DeliveryHandoverPdfRenderFileResult,
  DeliveryHandoverPdfRendererService,
  STAGE2_HANDOVER_PDF_HARD_MAX_BYTES,
  STAGE2_HANDOVER_PDF_TARGET_BYTES
} from "../delivery-handover/delivery-handover-pdf-renderer.service";
import { DeliveryHandoverService } from "../delivery-handover/delivery-handover.service";
import {
  hasCompleteStage2HandoverArchive,
  Stage2HandoverArchiveState
} from "../delivery-handover/stage2-handover-archive-state";
import {
  MAX_FIELD_PHOTO_SIZE_BYTES,
  MAX_FIELD_VIDEO_SIZE_BYTES
} from "./handover-work-order.constants";
import {
  normalizeFieldOperatorPhone
} from "../field-operator/field-operator-phone";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { FinanceService } from "../finance/finance.service";
import { SubscriptionJourneySignalService } from "../subscription-journey/subscription-journey-signal.service";
import { AssetOperationsService } from "../asset-operations/asset-operations.service";
import { VehicleAvailabilityPurpose } from "../asset-operations/vehicle-availability";
import {
  hasStage2SourceArtifactState,
  normalizeStage2Sha256,
  STAGE2_HANDOVER_PDF_RENDERER_VERSION,
  STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
  validateStage2SourceArtifactBinding
} from "./stage2-handover-source-artifact";
import {
  buildAuthoritativeStage2TaskWhere
} from "./stage2-handover-task-binding";
import {
  getFieldHandoverDisplayPriority,
  projectFieldHandoverWorkflow,
  type FieldHandoverWorkflowProjection
} from "./field-handover-workflow-projection";
import { Stage2HandoverWorkflowRepository } from "./stage2-handover-workflow.repository";
import {
  bindSubscriptionClosureAuthorityConsumer,
  consumeSubscriptionClosureAuthorityAttestation,
  type ClosureAuthorityAttestation,
  type SubscriptionClosureAuthorityRequirement,
  type SubscriptionClosureAuthoritySession
} from "../subscription-closure/subscription-closure.repository";

const TERMINAL_WORK_ORDER_STATUSES = ["VOIDED", "FAILED", "CANCELLED"] as const;
const FIELD_ENDED_WORK_ORDER_STATUSES = [
  "VOIDED",
  "FAILED",
  "CANCELLED",
  "FIELD_COMPLETED",
  "OPS_REVIEWED"
] as const;
const FIELD_ENDED_WORK_ORDER_STATUS_SET = new Set<string>(FIELD_ENDED_WORK_ORDER_STATUSES);
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
const ARCHIVED_STAGE2_RECONCILABLE_STATUSES = new Set([
  "CUSTOMER_CONFIRMED",
  "SIGNING",
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
const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";
const STAGE2_SOURCE_PDF_FINALIZATION_ATTEMPTS = 3;
const STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL_ENV = "STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL";
const STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV = "STAGE2_HANDOVER_WORKFLOW_ENABLED";
const MAX_STAGE2_EVIDENCE_DERIVATIVE_BYTES = 1024 * 1024;
const MAX_STAGE2_ARCHIVE_RECONCILIATION_BATCH_SIZE = 10;
const SAFE_FIELD_PHOTO_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
]);
const SAFE_FIELD_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v"
]);
const PREVIEWABLE_EVIDENCE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  ...SAFE_FIELD_VIDEO_MIME_TYPES
]);
const HANDOVER_FIELD_FACT_KEYS = [
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

export type HandoverFieldFactKey = typeof HANDOVER_FIELD_FACT_KEYS[number];

type HandoverType = "DELIVERY_OUTBOUND" | "RETURN_INBOUND";
type WorkOrderStatus = typeof TERMINAL_WORK_ORDER_STATUSES[number] |
  typeof READY_FOR_STAGE2_STATUSES[number] |
  "DRAFT" |
  "ASSIGNED" |
  "FIELD_IN_PROGRESS" |
  "EVIDENCE_SUBMITTED" |
  "CUSTOMER_REVIEWING" |
  "CUSTOMER_OBJECTED";

export interface WorkOrderRecord {
  accessTokenExpiresAt?: Date | null;
  accessTokenRevokedAt?: Date | null;
  adminReviewStatus?: string | null;
  accessoryChecklist?: unknown;
  assignedInternalUserId?: string | null;
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
  fieldOperatorName?: string | null;
  fieldOperatorPhone?: string | null;
  fieldStartedAt?: Date | null;
  fieldSubmittedAt?: Date | null;
  firstAccessedAt?: Date | null;
  fuelLevelText?: string | null;
  handoverId?: string | null;
  handoverMileageKm?: number | null;
  handoverType?: string | null;
  id: string;
  lastAccessedAt?: Date | null;
  metadata?: unknown;
  noVisibleDamageDeclared?: boolean | null;
  operatorType?: string | null;
  orderId: string;
  opsReviewStatus?: string | null;
  reviewVersion?: number | null;
  scheduledAt?: Date | null;
  status: string;
  updatedAt?: Date | null;
  vehicleDeliveryId?: string | null;
}

export interface ArchivedStage2EvidenceReconciliationResult {
  manifestHash: string;
  outcome: "ALREADY_READY" | "SIGNALLED";
  workOrderId: string;
}

export interface EvidenceFileStreamResult {
  filename: string;
  mimeType: null | string;
  sizeBytes: null | number;
  stream: Readable;
}

export interface Stage2HandoverPdfArtifactView {
  archiveStatus: null | string;
  artifactId: null | string;
  artifactVersion: null | number;
  documentNo: null | string;
  downloadUrl: null | string;
  fileName: null | string;
  fileSize: null | number;
  generatedAt: Date | null;
  handoverStatus: null | string;
  orderNo: null | string;
  previewUrl: null | string;
  signedArtifactAvailable: boolean;
  sourcePdfHash: null | string;
  status: "GENERATED" | "NOT_GENERATED";
  workOrderId: string;
}

export interface FieldStage2ESignReviewInput {
  acknowledgement: true;
  artifactVersion: number;
  sourcePdfHash: string;
}

export interface FieldStage2ESignReview extends FieldStage2ESignReviewInput {
  reviewedAt: Date;
}

export interface Stage2HandoverPdfLease {
  assertLease(): Promise<void>;
  jobId: string;
  leaseMs: number;
  leaseToken: string;
}

interface EnsureStage2HandoverPdfOptions {
  actorId?: string;
  enqueueNextJob?: boolean;
  lease?: Stage2HandoverPdfLease;
}

interface Stage2SourcePdfReservation {
  artifactVersion: number;
  contractId: string;
  contractNo: string;
  generatedAt: Date;
  manifestHash: string;
  templateId: string;
}

class Stage2SourcePdfClaimLostError extends Error {
  constructor() {
    super("STAGE2_SOURCE_PDF_CLAIM_LOST");
  }
}

export interface AssignExternalOperatorInput {
  expiresAt?: Date | string | null;
  name: string;
  organization?: string | null;
  phone: string;
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
  buffer?: Buffer;
  mimetype?: string;
  originalname: string;
  path?: string;
  size: number;
}

export interface UploadAndAttachFieldEvidenceOptions {
  replaceEvidenceFileId?: string | null;
}

export interface AttachPreparedFieldVideoFromStoredSourceInput {
  actorId?: string;
  detectedMimeType: string;
  evidenceItemId: string;
  originalName: string;
  partCount: number;
  prepared: PreparedDeliveryEvidenceArtifacts;
  replaceEvidenceFileId?: string;
  sizeBytes: number;
  storedSource: { bucket: string; objectKey: string };
  uploadLeaseOwner: string;
  uploadSessionId: string;
  workOrderId: string;
}

export interface RequestCustomerObjectionResubmissionInput {
  note: string;
  targetEvidenceItemIds?: string[];
  targetFieldKeys?: HandoverFieldFactKey[];
}

export const HANDOVER_P0_CAPABILITY_ERROR_CODE = {
  ACTIVE_RETURN_INBOUND_EXISTS: "HANDOVER_P0_ACTIVE_RETURN_INBOUND_EXISTS",
  AUTHORITY_BUSY: "HANDOVER_P0_AUTHORITY_BUSY",
  AUTHORITY_NOT_FOUND: "HANDOVER_P0_AUTHORITY_NOT_FOUND",
  CAPABILITY_INVALID: "HANDOVER_P0_CAPABILITY_INVALID",
  SOURCE_CONFLICT: "HANDOVER_P0_SOURCE_CONFLICT",
  TRANSACTION_REQUIRED: "HANDOVER_P0_TRANSACTION_REQUIRED"
} as const;

export type ReturnInboundCommandSource = Readonly<{
  id: string;
  key: string;
  type: string;
}>;

export type CreateReturnInboundWorkOrderCommand = Readonly<{
  actorId: string;
  orderId: string;
  source: ReturnInboundCommandSource;
}>;

export type GovernedReturnInboundUpdateCommand = Readonly<{
  actorId: string;
  deliveryLocation: string | null;
  orderId: string;
  scheduledAt: Date | null;
  source: ReturnInboundCommandSource;
  workOrderId: string;
}>;

export function returnInboundCreateAuthorityRequirement(
  input: CreateReturnInboundWorkOrderCommand,
  workOrderId: string
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeReturnInboundCommand(input);
  return {
    command: {
      actorId: command.actorId,
      orderId: command.orderId,
      source: command.source,
      workOrderId
    },
    key: "handover-create",
    locks: [
      { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]
  };
}

export function governedReturnInboundAuthorityRequirement(
  input: GovernedReturnInboundUpdateCommand
): SubscriptionClosureAuthorityRequirement {
  const command = normalizeGovernedReturnInboundUpdateCommand(input);
  return {
    command: {
      actorId: command.actorId,
      deliveryLocation: command.deliveryLocation,
      orderId: command.orderId,
      scheduledAt: command.scheduledAt,
      source: command.source,
      workOrderId: command.workOrderId
    },
    key: "managed-return",
    locks: [
      { id: command.orderId, mode: "UPDATE", table: "subscription_order" },
      {
        id: command.workOrderId,
        mode: "UPDATE",
        table: "vehicle_handover_work_order"
      },
      { id: command.actorId, mode: "SHARE", table: "user" }
    ]
  };
}

declare const returnInboundTransactionCapabilityBrand: unique symbol;
export type ReturnInboundTransactionCapability = Readonly<{
  [returnInboundTransactionCapabilityBrand]: true;
}>;

type ReturnInboundTransactionCapabilityState = Readonly<{
  commandHash: string;
  source: ReturnInboundCommandSource;
  transaction: Prisma.TransactionClient;
}>;

declare const preparedReturnInboundCapabilityBrand: unique symbol;
export type PreparedReturnInboundCapability = Readonly<{
  [preparedReturnInboundCapabilityBrand]: true;
}>;

type PreparedReturnInboundCapabilityState = Readonly<{
  command: CreateReturnInboundWorkOrderCommand;
  sourceOwner: WorkOrderRecord | null;
  transaction: Prisma.TransactionClient;
  workOrderId: string;
}>;

declare const governedReturnInboundUpdateCapabilityBrand: unique symbol;
export type GovernedReturnInboundUpdateCapability = Readonly<{
  [governedReturnInboundUpdateCapabilityBrand]: true;
}>;

type GovernedReturnInboundUpdateCapabilityState = Readonly<{
  commandHash: string;
  transaction: Prisma.TransactionClient;
}>;

declare const preparedGovernedReturnInboundUpdateCapabilityBrand: unique symbol;
export type PreparedGovernedReturnInboundUpdateCapability = Readonly<{
  [preparedGovernedReturnInboundUpdateCapabilityBrand]: true;
}>;

type PreparedGovernedReturnInboundUpdateCapabilityState = Readonly<{
  command: GovernedReturnInboundUpdateCommand;
  transaction: Prisma.TransactionClient;
  workOrder: WorkOrderRecord;
}>;

@Injectable()
export class HandoverWorkOrderService {
  private readonly closureAuthorityConsumer = Object.freeze({});
  private readonly logger = new Logger(HandoverWorkOrderService.name);
  private readonly returnInboundCapabilities = new WeakMap<
    ReturnInboundTransactionCapability,
    ReturnInboundTransactionCapabilityState
  >();
  private readonly preparedReturnInboundCapabilities = new WeakMap<
    PreparedReturnInboundCapability,
    PreparedReturnInboundCapabilityState
  >();
  private readonly governedReturnInboundUpdateCapabilities = new WeakMap<
    GovernedReturnInboundUpdateCapability,
    GovernedReturnInboundUpdateCapabilityState
  >();
  private readonly preparedGovernedReturnInboundUpdateCapabilities = new WeakMap<
    PreparedGovernedReturnInboundUpdateCapability,
    PreparedGovernedReturnInboundUpdateCapabilityState
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryEvidenceService: DeliveryEvidenceService,
    @Optional() private readonly deliveryHandoverService?: DeliveryHandoverService,
    @Optional() private readonly storageService?: StorageService,
    @Optional() private readonly handoverPdfRenderer?: DeliveryHandoverPdfRendererService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly evidenceArtifactService?: DeliveryHandoverEvidenceArtifactService,
    @Optional() private readonly workflowRepository?: Stage2HandoverWorkflowRepository,
    @Optional() private readonly financeService?: FinanceService,
    @Optional() private readonly journeySignal?: SubscriptionJourneySignalService,
    @Optional() private readonly assetOperationsService?: AssetOperationsService
  ) {}

  async prepareReturnInboundInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateReturnInboundWorkOrderCommand
  ): Promise<ReturnInboundTransactionCapability> {
    const command = normalizeReturnInboundCommand(input);
    await assertReturnInboundTransaction(tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${returnInboundSourceLockKey(command.source)}, 0))`
    );
    const capability = Object.freeze({}) as ReturnInboundTransactionCapability;
    this.returnInboundCapabilities.set(
      capability,
      Object.freeze({
        commandHash: returnInboundCommandHash(command),
        source: command.source,
        transaction: tx
      })
    );
    return capability;
  }

  async createReturnInboundInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateReturnInboundWorkOrderCommand,
    capability: ReturnInboundTransactionCapability
  ): Promise<WorkOrderRecord> {
    const capabilityState = this.takeReturnInboundCapability(capability);
    const command = normalizeReturnInboundCommand(input);
    this.assertReturnInboundCapability(capabilityState, tx, command);
    const commandHash = returnInboundCommandHash(command);
    const sourceOwners = await findReturnInboundSourceOwners(tx, command.source);
    if (sourceOwners.length > 1) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.SOURCE_CONFLICT,
        "The return-inbound source has more than one persisted owner."
      );
    }
    const sourceOwner = sourceOwners[0];
    if (sourceOwner) {
      if (returnInboundMetadataHash(sourceOwner.metadata) !== commandHash) {
        throw handoverP0Conflict(
          HANDOVER_P0_CAPABILITY_ERROR_CODE.SOURCE_CONFLICT,
          "The return-inbound source is bound to a different payload."
        );
      }
      return sourceOwner;
    }
    await lockReturnInboundAuthority(tx, "subscription_order", command.orderId, "UPDATE");
    await lockReturnInboundSpecialistProbe(tx, command.orderId);
    await lockReturnInboundAuthority(tx, "user", command.actorId, "SHARE");

    const [order, actor, candidates] = await Promise.all([
      tx.subscriptionOrder.findUnique({ where: { id: command.orderId } }),
      tx.user.findFirst({
        where: { deletedAt: null, id: command.actorId, status: UserStatus.ACTIVE }
      }),
      tx.vehicleHandoverWorkOrder.findMany({
        where: { handoverType: "RETURN_INBOUND", orderId: command.orderId }
      })
    ]);
    if (!order || order.deletedAt || !actor) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The return-inbound work-order authority is unavailable."
      );
    }

    if (candidates.some(({ status }) => !isTerminalWorkOrderStatus(status))) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.ACTIVE_RETURN_INBOUND_EXISTS,
        "The order already has an active return-inbound work order."
      );
    }

    const workOrder = await tx.vehicleHandoverWorkOrder.create({
      data: {
        handoverId: null,
        handoverType: "RETURN_INBOUND",
        metadata: toJsonValue({
          p0ReturnInbound: {
            commandHash,
            source: command.source
          }
        }),
        operatorType: "INTERNAL",
        orderId: command.orderId,
        status: "DRAFT",
        vehicleDeliveryId: null
      }
    });
    await this.recordEvent(
      workOrder,
      VehicleHandoverEventType.WORK_ORDER_CREATED,
      {
        actorId: command.actorId,
        actorType: VehicleHandoverEventActorType.SYSTEM,
        detail: { commandHash, source: command.source }
      },
      tx
    );
    return workOrder;
  }

  async attestReturnInboundAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: CreateReturnInboundWorkOrderCommand,
    capability: ReturnInboundTransactionCapability,
    authorityAttestation: ClosureAuthorityAttestation,
    workOrderId: string
  ): Promise<PreparedReturnInboundCapability> {
    consumeHandoverAuthorityAttestation(tx, authoritySession, authorityAttestation, () =>
      this.createReturnInboundAuthorityRequirement(authoritySession, input, workOrderId)
    );
    const capabilityState = this.takeReturnInboundCapability(capability);
    const command = normalizeReturnInboundCommand(input);
    this.assertReturnInboundCapability(capabilityState, tx, command);
    const commandHash = returnInboundCommandHash(command);
    const sourceOwners = await findReturnInboundSourceOwners(tx, command.source);
    if (sourceOwners.length > 1) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.SOURCE_CONFLICT,
        "The return-inbound source has more than one persisted owner."
      );
    }
    const sourceOwner = sourceOwners[0] ?? null;
    if (sourceOwner) {
      if (returnInboundMetadataHash(sourceOwner.metadata) !== commandHash) {
        throw handoverP0Conflict(
          HANDOVER_P0_CAPABILITY_ERROR_CODE.SOURCE_CONFLICT,
          "The return-inbound source is bound to a different payload."
        );
      }
    } else {
      const [order, actor, candidates] = await Promise.all([
        tx.subscriptionOrder.findUnique({ where: { id: command.orderId } }),
        tx.user.findFirst({
          where: { deletedAt: null, id: command.actorId, status: UserStatus.ACTIVE }
        }),
        tx.vehicleHandoverWorkOrder.findMany({
          where: { handoverType: "RETURN_INBOUND", orderId: command.orderId }
        })
      ]);
      if (!order || order.deletedAt || !actor) {
        throw handoverP0Conflict(
          HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
          "The return-inbound work-order authority is unavailable."
        );
      }
      if (candidates.some(({ status }) => !isTerminalWorkOrderStatus(status))) {
        throw handoverP0Conflict(
          HANDOVER_P0_CAPABILITY_ERROR_CODE.ACTIVE_RETURN_INBOUND_EXISTS,
          "The order already has an active return-inbound work order."
        );
      }
    }
    const prepared = Object.freeze({}) as PreparedReturnInboundCapability;
    this.preparedReturnInboundCapabilities.set(
      prepared,
      Object.freeze({ command, sourceOwner, transaction: tx, workOrderId })
    );
    return prepared;
  }

  createReturnInboundAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    input: CreateReturnInboundWorkOrderCommand,
    workOrderId: string
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      returnInboundCreateAuthorityRequirement(input, workOrderId),
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  createGovernedReturnInboundAuthorityRequirement(
    authoritySession: SubscriptionClosureAuthoritySession,
    input: GovernedReturnInboundUpdateCommand
  ) {
    return bindSubscriptionClosureAuthorityConsumer(
      governedReturnInboundAuthorityRequirement(input),
      this.closureAuthorityConsumer,
      authoritySession
    );
  }

  async createPreparedReturnInboundInTransaction(
    tx: Prisma.TransactionClient,
    capability: PreparedReturnInboundCapability
  ): Promise<WorkOrderRecord> {
    const state = this.preparedReturnInboundCapabilities.get(capability);
    this.preparedReturnInboundCapabilities.delete(capability);
    if (!state || state.transaction !== tx) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The prepared return-inbound capability is invalid."
      );
    }
    if (state.sourceOwner) return state.sourceOwner;
    const commandHash = returnInboundCommandHash(state.command);
    const workOrder = await tx.vehicleHandoverWorkOrder.create({
      data: {
        handoverId: null,
        handoverType: "RETURN_INBOUND",
        id: state.workOrderId,
        metadata: toJsonValue({
          p0ReturnInbound: { commandHash, source: state.command.source }
        }),
        operatorType: "INTERNAL",
        orderId: state.command.orderId,
        status: "DRAFT",
        vehicleDeliveryId: null
      }
    });
    await this.recordEvent(
      workOrder,
      VehicleHandoverEventType.WORK_ORDER_CREATED,
      {
        actorId: state.command.actorId,
        actorType: VehicleHandoverEventActorType.SYSTEM,
        detail: { commandHash, source: state.command.source }
      },
      tx
    );
    return workOrder;
  }

  async prepareGovernedReturnInboundUpdateInTransaction(
    tx: Prisma.TransactionClient,
    input: GovernedReturnInboundUpdateCommand
  ): Promise<GovernedReturnInboundUpdateCapability> {
    const command = normalizeGovernedReturnInboundUpdateCommand(input);
    await assertReturnInboundTransaction(tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${returnInboundSourceLockKey(command.source)}, 0))`
    );
    await lockReturnInboundAuthority(tx, "subscription_order", command.orderId, "UPDATE");
    await lockReturnInboundWorkOrder(tx, command.workOrderId);
    await lockReturnInboundAuthority(tx, "user", command.actorId, "SHARE");
    const workOrder = await tx.vehicleHandoverWorkOrder.findUnique({
      where: { id: command.workOrderId }
    });
    if (
      !workOrder ||
      workOrder.orderId !== command.orderId ||
      workOrder.handoverType !== "RETURN_INBOUND" ||
      isTerminalWorkOrderStatus(workOrder.status)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The governed return-inbound work order is unavailable."
      );
    }
    const capability = Object.freeze({}) as GovernedReturnInboundUpdateCapability;
    this.governedReturnInboundUpdateCapabilities.set(
      capability,
      Object.freeze({
        commandHash: governedReturnInboundUpdateCommandHash(command),
        transaction: tx
      })
    );
    return capability;
  }

  async prepareGovernedReturnInboundSourceInTransaction(
    tx: Prisma.TransactionClient,
    input: GovernedReturnInboundUpdateCommand
  ): Promise<GovernedReturnInboundUpdateCapability> {
    const command = normalizeGovernedReturnInboundUpdateCommand(input);
    await assertReturnInboundTransaction(tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT TRUE AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${returnInboundSourceLockKey(command.source)}, 0))`
    );
    const capability = Object.freeze({}) as GovernedReturnInboundUpdateCapability;
    this.governedReturnInboundUpdateCapabilities.set(
      capability,
      Object.freeze({
        commandHash: governedReturnInboundUpdateCommandHash(command),
        transaction: tx
      })
    );
    return capability;
  }

  async attestGovernedReturnInboundAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    authoritySession: SubscriptionClosureAuthoritySession,
    input: GovernedReturnInboundUpdateCommand,
    capability: GovernedReturnInboundUpdateCapability,
    authorityAttestation: ClosureAuthorityAttestation
  ): Promise<PreparedGovernedReturnInboundUpdateCapability> {
    consumeHandoverAuthorityAttestation(tx, authoritySession, authorityAttestation, () =>
      this.createGovernedReturnInboundAuthorityRequirement(authoritySession, input)
    );
    const state = this.governedReturnInboundUpdateCapabilities.get(capability);
    this.governedReturnInboundUpdateCapabilities.delete(capability);
    const command = normalizeGovernedReturnInboundUpdateCommand(input);
    if (
      !state ||
      state.transaction !== tx ||
      state.commandHash !== governedReturnInboundUpdateCommandHash(command)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The governed return-inbound update capability is invalid."
      );
    }
    const workOrder = await tx.vehicleHandoverWorkOrder.findUnique({
      where: { id: command.workOrderId }
    });
    if (
      !workOrder ||
      workOrder.orderId !== command.orderId ||
      workOrder.handoverType !== "RETURN_INBOUND" ||
      isTerminalWorkOrderStatus(workOrder.status)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The governed return-inbound work order is unavailable."
      );
    }
    const prepared = Object.freeze({}) as PreparedGovernedReturnInboundUpdateCapability;
    this.preparedGovernedReturnInboundUpdateCapabilities.set(
      prepared,
      Object.freeze({ command, transaction: tx, workOrder })
    );
    return prepared;
  }

  async updatePreparedGovernedReturnInboundInTransaction(
    tx: Prisma.TransactionClient,
    capability: PreparedGovernedReturnInboundUpdateCapability
  ): Promise<WorkOrderRecord> {
    const state = this.preparedGovernedReturnInboundUpdateCapabilities.get(capability);
    this.preparedGovernedReturnInboundUpdateCapabilities.delete(capability);
    if (!state || state.transaction !== tx) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The prepared governed return-inbound update capability is invalid."
      );
    }
    const updated = await tx.vehicleHandoverWorkOrder.update({
      data: {
        deliveryLocation: state.command.deliveryLocation,
        scheduledAt: state.command.scheduledAt
      },
      where: { id: state.workOrder.id }
    });
    await this.recordEvent(
      updated,
      VehicleHandoverEventType.FIELD_FACTS_UPDATED,
      {
        actorId: state.command.actorId,
        actorType: VehicleHandoverEventActorType.ADMIN,
        detail: {
          changedFieldKeys: ["deliveryLocation", "scheduledAt"],
          governedBy: state.command.source
        }
      },
      tx
    );
    return updated;
  }

  async updateGovernedReturnInboundInTransaction(
    tx: Prisma.TransactionClient,
    input: GovernedReturnInboundUpdateCommand,
    capability: GovernedReturnInboundUpdateCapability
  ): Promise<WorkOrderRecord> {
    const state = this.governedReturnInboundUpdateCapabilities.get(capability);
    this.governedReturnInboundUpdateCapabilities.delete(capability);
    const command = normalizeGovernedReturnInboundUpdateCommand(input);
    if (
      !state ||
      state.transaction !== tx ||
      state.commandHash !== governedReturnInboundUpdateCommandHash(command)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The governed return-inbound update capability is invalid."
      );
    }
    const workOrder = await tx.vehicleHandoverWorkOrder.findUnique({
      where: { id: command.workOrderId }
    });
    if (
      !workOrder ||
      workOrder.orderId !== command.orderId ||
      workOrder.handoverType !== "RETURN_INBOUND" ||
      isTerminalWorkOrderStatus(workOrder.status)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The governed return-inbound work order is unavailable."
      );
    }
    const updated = await tx.vehicleHandoverWorkOrder.update({
      data: {
        deliveryLocation: command.deliveryLocation,
        scheduledAt: command.scheduledAt
      },
      where: { id: workOrder.id }
    });
    await this.recordEvent(updated, VehicleHandoverEventType.FIELD_FACTS_UPDATED, {
      actorId: command.actorId,
      actorType: VehicleHandoverEventActorType.ADMIN,
      detail: {
        changedFieldKeys: ["deliveryLocation", "scheduledAt"],
        governedBy: command.source
      }
    }, tx);
    return updated;
  }

  private takeReturnInboundCapability(
    capability: ReturnInboundTransactionCapability
  ): ReturnInboundTransactionCapabilityState {
    const state = this.returnInboundCapabilities.get(capability);
    this.returnInboundCapabilities.delete(capability);
    if (!state) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The caller-owned return-inbound capability is invalid."
      );
    }
    return state;
  }

  private assertReturnInboundCapability(
    state: ReturnInboundTransactionCapabilityState,
    tx: Prisma.TransactionClient,
    command: CreateReturnInboundWorkOrderCommand
  ) {
    if (
      state.transaction !== tx ||
      state.commandHash !== returnInboundCommandHash(command) ||
      !sameReturnInboundSource(state.source, command.source)
    ) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
        "The caller-owned return-inbound capability is invalid."
      );
    }
  }

  async createDraft(orderId: string, handoverType: HandoverType = "DELIVERY_OUTBOUND", actorId?: string) {
    if (handoverType !== "DELIVERY_OUTBOUND") {
      throw new BadRequestException("RETURN_INBOUND 工单流程尚未启用。");
    }

    const created = await this.runSerializableTransaction(async (tx) => {
      await this.assertNoActiveWorkOrder(orderId, handoverType, tx);
      const handover = await this.getOrCreateDraftHandover(orderId, actorId, tx);
      const delivery = await tx.vehicleDelivery.findUnique({ where: { orderId } });
      await this.deliveryEvidenceService.initializeChecklist(orderId, handover.id, tx);
      const workOrder = await tx.vehicleHandoverWorkOrder.create({
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
      await this.recordEvent(workOrder, VehicleHandoverEventType.WORK_ORDER_CREATED, {
        actorId,
        actorType: actorId ? VehicleHandoverEventActorType.ADMIN : VehicleHandoverEventActorType.SYSTEM
      }, tx);
      return workOrder;
    });
    return created;
  }

  async createJourneyHandoverInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorId: string,
    sourceKey: string
  ): Promise<WorkOrderRecord> {
    if (!this.financeService || !this.deliveryHandoverService) {
      throw new Error("Journey handover dependencies are unavailable.");
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "subscription_order"
      WHERE "id" = ${orderId}::uuid
      FOR UPDATE
    `);
    const settlement = await this.financeService.evaluateInitialBillSettlement(
      tx,
      orderId
    );
    if (!settlement.paid) {
      throw new BadRequestException("Initial bills must be fully settled before handover creation.");
    }
    const order = await tx.subscriptionOrder.findUnique({
      include: {
        contract: true,
        vehicle: { include: { insurancePolicies: true } }
      },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }
    if (
      !order.contract ||
      order.contract.deletedAt ||
      order.contract.status !== ContractStatus.ARCHIVED ||
      !order.contract.archivedAt ||
      !order.contract.fileId
    ) {
      throw new BadRequestException("Stage 1 contract must have an archived PDF before handover creation.");
    }
    if (
      !order.vehicleId ||
      !order.vehicle ||
      order.vehicle.deletedAt ||
      order.vehicle.status !== VehicleStatus.RESERVED
    ) {
      throw new BadRequestException("A reserved vehicle is required before handover creation.");
    }
    let delivery = await tx.vehicleDelivery.findUnique({ where: { orderId } });
    const evaluationDate =
      (delivery && !delivery.deletedAt ? delivery.scheduledAt : null) ??
      order.startDate ??
      new Date();
    const insurance = resolveVehicleInsuranceCoverage(
      order.vehicle.insurancePolicies,
      evaluationDate
    );
    if (!insurance.covered) {
      throw new BadRequestException("Valid compulsory and commercial insurance is required before handover creation.");
    }
    if (!delivery || delivery.deletedAt) {
      delivery = await tx.vehicleDelivery.create({
        data: {
          createdBy: actorId,
          customerId: order.customerId,
          deliveryNo: createBusinessNo("DLV"),
          deliveryStatus: DeliveryStatus.PENDING,
          orderId,
          scheduledAt: order.startDate,
          updatedBy: actorId,
          vehicleId: order.vehicleId
        }
      });
      if (order.orderStatus !== OrderStatus.PENDING_DELIVERY) {
        await tx.subscriptionOrder.update({
          data: {
            orderStatus: OrderStatus.PENDING_DELIVERY,
            updatedBy: actorId
          },
          where: { id: orderId }
        });
      }
    }
    const handover = await this.deliveryHandoverService.getOrCreateDraftHandover(
      orderId,
      actorId,
      tx
    );
    await this.deliveryEvidenceService.initializeChecklist(
      orderId,
      handover.id,
      tx
    );
    const existing = await tx.vehicleHandoverWorkOrder.findFirst({
      where: {
        handoverType: "DELIVERY_OUTBOUND",
        orderId,
        status: { notIn: [...TERMINAL_WORK_ORDER_STATUSES] }
      }
    });
    if (existing) {
      if (
        readMetadataString(existing.metadata, "journeySourceKey") &&
        existing.handoverId === handover.id &&
        existing.vehicleDeliveryId === delivery.id
      ) {
        return existing;
      }
      return this.updateWorkOrderVersioned(existing, {
        handoverId: existing.handoverId ?? handover.id,
        metadata: mergeMetadata(existing.metadata, {
          journeySourceKey:
            readMetadataString(existing.metadata, "journeySourceKey") ??
            sourceKey
        }),
        vehicleDeliveryId: existing.vehicleDeliveryId ?? delivery.id
      }, tx);
    }
    const workOrder = await tx.vehicleHandoverWorkOrder.create({
      data: {
        deliveryLocation: delivery.deliveryLocation,
        handoverId: handover.id,
        handoverType: "DELIVERY_OUTBOUND",
        metadata: toJsonValue({ journeySourceKey: sourceKey }),
        operatorType: "INTERNAL",
        orderId,
        scheduledAt: delivery.scheduledAt,
        status: "DRAFT",
        vehicleDeliveryId: delivery.id
      }
    });
    await this.recordEvent(
      workOrder,
      VehicleHandoverEventType.WORK_ORDER_CREATED,
      {
        actorId,
        actorType: VehicleHandoverEventActorType.SYSTEM,
        detail: { journeySourceKey: sourceKey }
      },
      tx
    );
    return workOrder;
  }

  async listByOrder(orderId: string) {
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: { createdAt: "desc" },
      where: { orderId }
    });
    return Promise.all(workOrders.map((workOrder) => this.toAdminWorkOrderSummary(workOrder)));
  }

  async listAdminReviewQueue() {
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: [{ customerObjectedAt: "asc" }, { createdAt: "asc" }],
      where: {
        customerObjectedAt: { not: null },
        status: "CUSTOMER_OBJECTED"
      }
    });
    return Promise.all(workOrders.map((workOrder) => this.toAdminWorkOrderSummary(workOrder)));
  }

  async getById(id: string) {
    return this.toAdminWorkOrderDetail(await this.getWorkOrderOrThrow(id));
  }

  async assignInternalOperator(id: string, userId: string, actorId?: string) {
    const operator = await this.getAssignableInternalUser(userId);
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertAssignmentMutable(workOrder);
    return this.updateWorkOrderWithEvent(workOrder, {
      accessTokenExpiresAt: null,
      accessTokenHash: null,
      accessTokenRevokedAt: null,
      assignedInternalUserId: userId,
      externalOperatorName: null,
      externalOperatorOrganization: null,
      externalOperatorPhone: null,
      fieldOperatorName: operator.name,
      fieldOperatorPhone: operator.phone,
      metadata: mergeMetadata(workOrder.metadata, { assignedBy: actorId ?? null }),
      operatorType: "INTERNAL",
      status: nextStatus(workOrder.status, "ASSIGNED")
    }, VehicleHandoverEventType.INTERNAL_OPERATOR_ASSIGNED, {
      actorId,
      actorType: VehicleHandoverEventActorType.ADMIN,
      detail: { assignedInternalUserId: userId }
    });
  }

  async assignExternalOperator(id: string, input: AssignExternalOperatorInput, actorId?: string) {
    const name = normalizeRequiredText(input.name, "请填写外部交付员姓名。");
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertAssignmentMutable(workOrder);
    const accessToken = randomBytes(32).toString("base64url");
    const accessTokenHash = hashAccessToken(accessToken);
    const expiresAt = input.expiresAt ? parseDate(input.expiresAt, "accessTokenExpiresAt") : defaultTokenExpiry();
    const phone = normalizeFieldOperatorPhone(input.phone ?? "");

    const updated = await this.runSerializableTransaction(async (tx) => {
      const assigned = await this.updateWorkOrderVersioned(workOrder, {
        accessTokenExpiresAt: expiresAt,
        accessTokenHash,
        accessTokenRevokedAt: null,
        assignedInternalUserId: null,
        externalOperatorName: name,
        externalOperatorOrganization: normalizeOptionalText(input.organization),
        externalOperatorPhone: phone,
        fieldOperatorName: name,
        fieldOperatorPhone: phone,
        metadata: mergeMetadata(workOrder.metadata, { assignedBy: actorId ?? null }),
        operatorType: "EXTERNAL",
        status: nextStatus(workOrder.status, "ASSIGNED")
      }, tx);
      const assignmentEvent = await this.recordEvent(
        assigned,
        VehicleHandoverEventType.EXTERNAL_OPERATOR_ASSIGNED,
        {
          actorId,
          actorType: VehicleHandoverEventActorType.ADMIN,
          detail: {
            expiresAt: expiresAt.toISOString(),
            operatorName: name,
            phoneMasked: maskPhone(phone)
          }
        },
        tx
      );
      const assignmentEventId = assignmentEvent
        ? readString(assignmentEvent, "id")
        : null;
      if (!assignmentEventId) {
        throw new Error("HANDOVER_ASSIGNMENT_EVENT_MISSING");
      }
      if (!this.workflowRepository) {
        throw new Error("HANDOVER_WORKFLOW_REPOSITORY_UNAVAILABLE");
      }
      await this.workflowRepository.enqueue(tx, {
        handoverId: assigned.handoverId ?? undefined,
        idempotencyKey: `field-assigned:${assigned.id}:${assignmentEventId}`,
        jobType:
          VehicleHandoverWorkflowJobType.NOTIFY_FIELD_HANDOVER_ASSIGNED,
        maxAttempts: 6,
        payload: { assignmentEventId },
        workOrderId: assigned.id
      });
      return assigned;
    });

    return {
      accessToken,
      workOrder: updated
    };
  }

  async revokeExternalAccess(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    return this.updateWorkOrderWithEvent(workOrder, {
      accessTokenRevokedAt: new Date(),
      metadata: mergeMetadata(workOrder.metadata, { revokedBy: actorId ?? null })
    }, VehicleHandoverEventType.EXTERNAL_ACCESS_REVOKED, {
      actorId,
      actorType: VehicleHandoverEventActorType.ADMIN
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
    const workOrders = await this.prisma.vehicleHandoverWorkOrder.findMany({
      where: {
        fieldOperatorPhone: normalizedPhone
      }
    });

    const authorizedWorkOrders = [];
    for (const workOrder of workOrders) {
      if (
        await this.hasCurrentFieldOperatorAssignment(
          workOrder,
          normalizedPhone
        )
      ) {
        authorizedWorkOrders.push(workOrder);
      }
    }
    const projected = await Promise.all(
      authorizedWorkOrders.map(async (workOrder) => ({
        item: await this.toFieldTaskListItem(workOrder),
        workOrder
      }))
    );
    projected.sort(compareProjectedFieldWorkOrders);
    return projected.map(({ item }) => item);
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
    if (hasActiveCustomerObjection(workOrder) && isFieldResubmissionRequested(workOrder)) {
      return workOrder;
    }
    return this.updateWorkOrderWithEvent(workOrder, {
      fieldStartedAt: workOrder.fieldStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { fieldStartedBy: actorId ?? null }),
      status: "FIELD_IN_PROGRESS"
    }, VehicleHandoverEventType.FIELD_STARTED, {
      actorId,
      actorType: VehicleHandoverEventActorType.FIELD_OPERATOR
    }, (tx) => this.assertDeliveryStartAvailable(tx, workOrder),
      Prisma.TransactionIsolationLevel.ReadCommitted
    );
  }

  async updateFieldAccessibleFacts(
    id: string,
    phone: string,
    input: UpdateFieldFactsInput,
    actorId?: string
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    return this.updateFieldFacts(
      id,
      input,
      actorId,
      undefined,
      workOrder,
      normalizeFieldOperatorPhone(phone)
    );
  }

  async uploadAndAttachFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    itemId: string,
    files: UploadedFieldEvidenceFile[] | undefined,
    options: UploadAndAttachFieldEvidenceOptions = {},
    actorId?: string
  ) {
    const uploadedFiles = files ?? [];
    const file = uploadedFiles.find(hasUploadedFieldEvidenceContent);
    let prepared: PreparedDeliveryEvidenceArtifacts | undefined;
    try {
      if (!file) {
        throw new BadRequestException("请上传现场证据文件。");
      }
      const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
      assertFieldSessionEditable(workOrder);
      const normalizedPhone = normalizeFieldOperatorPhone(phone);
      const mediaType = assertSupportedFieldEvidenceFile(file);
      const item = await this.assertEvidenceItemBelongsToWorkOrder(workOrder, itemId);
      const mutation = await this.deliveryEvidenceService.validateEvidenceFileMutation(
        item.id,
        mediaType,
        options.replaceEvidenceFileId
      );
      try {
        prepared = await this.getEvidenceArtifactService().prepareUpload({
          evidenceType: readString(mutation as unknown as Record<string, unknown>, "evidenceType") ?? "UNKNOWN",
          file,
          mediaType
        });
      } catch (error) {
        const qualityMessage = getDeliveryEvidenceVideoQualityPublicMessage(error);
        if (qualityMessage) {
          throw new UnprocessableEntityException(qualityMessage);
        }
        if (isDeliveryEvidenceArtifactProcessingError(error)) {
          throw new UnprocessableEntityException(
            "资料文件处理失败，请重新选择文件后重试。"
          );
        }
        throw error;
      }
      const detectedMimeType = prepared.metadata.detectedMimeType;
      const storedObjects: Array<{ bucket: string; objectKey: string }> = [];
      try {
        const stored = await this.storeFieldEvidenceFile(
          workOrder,
          file,
          detectedMimeType,
          prepared.metadata.sourceSizeBytes
        );
        storedObjects.push({ bucket: stored.bucket, objectKey: stored.objectKey });
        const storedDerivatives: Array<
          PreparedDeliveryEvidenceArtifacts["derivatives"][number] & {
            stored: Awaited<ReturnType<StorageService["putDeliveryEvidenceDerivativeFromPath"]>>;
          }
        > = [];
        for (const derivative of prepared.derivatives) {
          const derivativeStored = await this.getStorageService().putDeliveryEvidenceDerivativeFromPath({
            contentType: derivative.contentType,
            filePath: derivative.filePath,
            kind: derivative.kind,
            metadata: {
              artifactKind: derivative.kind,
              sourceOriginalName: file.originalname
            },
            orderId: workOrder.orderId,
            originalName: derivative.originalName,
            sizeBytes: derivative.sizeBytes,
            workOrderId: workOrder.id
          });
          storedObjects.push({
            bucket: derivativeStored.bucket,
            objectKey: derivativeStored.objectKey
          });
          storedDerivatives.push({ ...derivative, stored: derivativeStored });
        }
        return await this.runSerializableTransaction(async (tx) => {
          const current = await this.updateWorkOrderVersioned(workOrder, {}, tx);
          if (!isFieldAccessibleWorkOrder(current, normalizedPhone)) {
            throw new UnauthorizedException("No access to this field handover work order.");
          }
          assertFieldSessionEditable(current);
          const currentItem = await this.assertEvidenceItemBelongsToWorkOrder(current, item.id, tx);
          const fileObject = await tx.fileObject.create({
            data: {
              bucket: stored.bucket,
              mimeType: detectedMimeType,
              objectKey: stored.objectKey,
              originalName: file.originalname,
              sizeBytes: BigInt(prepared!.metadata.sourceSizeBytes),
              uploadedBy: null
            }
          });
          const derivativeFileObjects = [];
          for (const derivative of storedDerivatives) {
            derivativeFileObjects.push(await tx.fileObject.create({
              data: {
                bucket: derivative.stored.bucket,
                mimeType: derivative.contentType,
                objectKey: derivative.stored.objectKey,
                originalName: derivative.originalName,
                sizeBytes: BigInt(derivative.sizeBytes),
                uploadedBy: null
              }
            }));
          }
          const artifactMetadata = {
            ...prepared!.metadata,
            photoPreviewFileId:
              mediaType === DeliveryEvidenceMediaType.PHOTO
                ? readString(derivativeFileObjects[0] as unknown as Record<string, unknown>, "id")
                : null,
            videoFrameFileIds:
              mediaType === DeliveryEvidenceMediaType.VIDEO
                ? derivativeFileObjects
                    .map((entry) => readString(entry as unknown as Record<string, unknown>, "id"))
                    .filter((value): value is string => Boolean(value))
                : []
          } as Prisma.InputJsonValue;
          const result = options.replaceEvidenceFileId
            ? await this.deliveryEvidenceService.replaceEvidenceFile(
                currentItem.id,
                options.replaceEvidenceFileId,
                fileObject.id,
                mediaType,
                undefined,
                tx,
                actorId,
                artifactMetadata
              )
            : await this.deliveryEvidenceService.attachEvidenceFile(
                currentItem.id,
                fileObject.id,
                mediaType,
                undefined,
                tx,
                actorId,
                artifactMetadata
              );
          await this.recordEvent(
            current,
            options.replaceEvidenceFileId
              ? VehicleHandoverEventType.EVIDENCE_FILE_REPLACED
              : VehicleHandoverEventType.EVIDENCE_FILE_ADDED,
            {
              actorId,
              actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
              detail: {
                evidenceItemId: currentItem.id,
                fileName: file.originalname,
                mediaType,
                replacedEvidenceFileId: options.replaceEvidenceFileId ?? null,
                sizeBytes: file.size
              }
            },
            tx
          );
          return result;
        });
      } catch (error) {
        await this.deleteStoredObjectsWithRetry(storedObjects);
        throw error;
      }
    } finally {
      await prepared?.cleanup();
      await Promise.all(uploadedFiles.map(cleanupUploadedFieldEvidenceTempFile));
    }
  }

  async attachPreparedFieldVideoFromStoredSource(
    input: AttachPreparedFieldVideoFromStoredSourceInput
  ) {
    const workOrder = await this.getWorkOrderOrThrow(input.workOrderId);
    assertFieldSessionEditable(workOrder);
    const item = await this.assertEvidenceItemBelongsToWorkOrder(
      workOrder,
      input.evidenceItemId
    );
    const mutation = await this.deliveryEvidenceService.validateEvidenceFileMutation(
      item.id,
      DeliveryEvidenceMediaType.VIDEO,
      input.replaceEvidenceFileId
    );
    if (mutation.evidenceType !== DeliveryEvidenceType.WALKAROUND_VIDEO) {
      throw new BadRequestException({
        code: "FIELD_VIDEO_EVIDENCE_TYPE_REQUIRED",
        message: "仅车辆环绕视频资料支持断点续传。"
      });
    }

    const storedDerivatives: Array<
      PreparedDeliveryEvidenceArtifacts["derivatives"][number] & {
        stored: Awaited<ReturnType<StorageService["putDeliveryEvidenceDerivativeFromPath"]>>;
      }
    > = [];
    try {
      for (const derivative of input.prepared.derivatives) {
        const stored = await this.getStorageService().putDeliveryEvidenceDerivativeFromPath({
          contentType: derivative.contentType,
          filePath: derivative.filePath,
          kind: derivative.kind,
          metadata: {
            artifactKind: derivative.kind,
            sourceOriginalName: input.originalName
          },
          orderId: workOrder.orderId,
          originalName: derivative.originalName,
          sizeBytes: derivative.sizeBytes,
          workOrderId: workOrder.id
        });
        storedDerivatives.push({ ...derivative, stored });
      }

      return await this.runSerializableTransaction(async (tx) => {
        const current = await this.updateWorkOrderVersioned(workOrder, {}, tx);
        assertFieldSessionEditable(current);
        const currentItem = await this.assertEvidenceItemBelongsToWorkOrder(
          current,
          item.id,
          tx
        );
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: input.storedSource.bucket,
            mimeType: input.detectedMimeType,
            objectKey: input.storedSource.objectKey,
            originalName: input.originalName,
            sizeBytes: BigInt(input.sizeBytes),
            uploadedBy: null
          }
        });
        const derivativeFileObjects = [];
        for (const derivative of storedDerivatives) {
          derivativeFileObjects.push(
            await tx.fileObject.create({
              data: {
                bucket: derivative.stored.bucket,
                mimeType: derivative.contentType,
                objectKey: derivative.stored.objectKey,
                originalName: derivative.originalName,
                sizeBytes: BigInt(derivative.sizeBytes),
                uploadedBy: null
              }
            })
          );
        }
        const artifactMetadata = {
          ...input.prepared.metadata,
          photoPreviewFileId: null,
          videoFrameFileIds: derivativeFileObjects
            .map((entry) =>
              readString(entry as unknown as Record<string, unknown>, "id")
            )
            .filter((value): value is string => Boolean(value))
        } as Prisma.InputJsonValue;
        const result = input.replaceEvidenceFileId
          ? await this.deliveryEvidenceService.replaceEvidenceFile(
              currentItem.id,
              input.replaceEvidenceFileId,
              fileObject.id,
              DeliveryEvidenceMediaType.VIDEO,
              undefined,
              tx,
              input.actorId,
              artifactMetadata
            )
          : await this.deliveryEvidenceService.attachEvidenceFile(
              currentItem.id,
              fileObject.id,
              DeliveryEvidenceMediaType.VIDEO,
              undefined,
              tx,
              input.actorId,
              artifactMetadata
            );
        await this.recordEvent(
          current,
          input.replaceEvidenceFileId
            ? VehicleHandoverEventType.EVIDENCE_FILE_REPLACED
            : VehicleHandoverEventType.EVIDENCE_FILE_ADDED,
          {
            actorId: input.actorId,
            actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
            detail: {
              evidenceItemId: currentItem.id,
              fileName: input.originalName,
              mediaType: DeliveryEvidenceMediaType.VIDEO,
              replacedEvidenceFileId: input.replaceEvidenceFileId ?? null,
              sizeBytes: input.sizeBytes
            }
          },
          tx
        );
        await this.recordEvent(
          current,
          VehicleHandoverEventType.FIELD_VIDEO_UPLOAD_COMPLETED,
          {
            actorId: input.actorId,
            actorType: input.actorId
              ? VehicleHandoverEventActorType.FIELD_OPERATOR
              : VehicleHandoverEventActorType.SYSTEM,
            detail: {
              evidenceItemId: currentItem.id,
              partCount: input.partCount,
              sessionId: input.uploadSessionId,
              status: FieldEvidenceVideoUploadStatus.COMPLETED
            }
          },
          tx
        );
        const completedUpload = await tx.fieldEvidenceVideoUploadSession.updateMany({
          data: {
            completedAt: new Date(),
            failureCode: null,
            failureMessage: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            objectEtag: null,
            objectKey: null,
            ossUploadId: null,
            processingCompletedAt: new Date(),
            resumeStage: null,
            status: FieldEvidenceVideoUploadStatus.COMPLETED,
            version: { increment: 1 }
          },
          where: {
            id: input.uploadSessionId,
            leaseOwner: input.uploadLeaseOwner,
            status: FieldEvidenceVideoUploadStatus.PROCESSING
          }
        });
        if (completedUpload.count !== 1) {
          throw new ConflictException({
            code: "FIELD_VIDEO_UPLOAD_FINALIZE_CONFLICT",
            message: "视频上传状态已变化，请稍后重试。"
          });
        }
        return result;
      });
    } catch (error) {
      await this.deleteStoredObjectsWithRetry(
        storedDerivatives.map((derivative) => ({
          bucket: derivative.stored.bucket,
          objectKey: derivative.stored.objectKey
        }))
      );
      throw error;
    }
  }

  async authorizeFieldVideoUploadMutation(input: {
    evidenceItemId: string;
    phone: string;
    replaceEvidenceFileId?: string;
    workOrderId: string;
  }) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(
      input.workOrderId,
      input.phone
    );
    assertFieldSessionEditable(workOrder);
    const item = await this.assertEvidenceItemBelongsToWorkOrder(
      workOrder,
      input.evidenceItemId
    );
    const mutation = await this.deliveryEvidenceService.validateEvidenceFileMutation(
      item.id,
      DeliveryEvidenceMediaType.VIDEO,
      input.replaceEvidenceFileId
    );
    if (mutation.evidenceType !== DeliveryEvidenceType.WALKAROUND_VIDEO) {
      throw new BadRequestException({
        code: "FIELD_VIDEO_EVIDENCE_TYPE_REQUIRED",
        message: "仅车辆环绕视频资料支持断点续传。"
      });
    }
    return {
      evidenceType: mutation.evidenceType,
      itemId: mutation.itemId,
      orderId: workOrder.orderId,
      replaceEvidenceFileId: input.replaceEvidenceFileId ?? null,
      workOrderId: workOrder.id
    };
  }

  async authorizeFieldVideoUploadAccess(input: {
    evidenceItemId: string;
    phone: string;
    workOrderId: string;
  }) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(
      input.workOrderId,
      input.phone
    );
    const item = await this.assertEvidenceItemBelongsToWorkOrder(
      workOrder,
      input.evidenceItemId
    );
    if (item.evidenceType !== DeliveryEvidenceType.WALKAROUND_VIDEO) {
      throw new BadRequestException({
        code: "FIELD_VIDEO_EVIDENCE_TYPE_REQUIRED",
        message: "仅车辆环绕视频资料支持断点续传。"
      });
    }
    return {
      evidenceType: item.evidenceType,
      itemId: item.id,
      orderId: workOrder.orderId,
      workOrderId: workOrder.id
    };
  }

  async recordFieldVideoUploadEvent(input: {
    actorId?: string;
    elapsedMs?: number;
    errorCode?: string;
    eventType:
      | "FIELD_VIDEO_UPLOAD_CREATED"
      | "FIELD_VIDEO_UPLOAD_RESUMED"
      | "FIELD_VIDEO_UPLOAD_CANCELLED"
      | "FIELD_VIDEO_UPLOAD_COMPLETED"
      | "FIELD_VIDEO_UPLOAD_FAILED";
    evidenceItemId: string;
    partCount?: number;
    sessionId: string;
    status: string;
    workOrderId: string;
  }) {
    const workOrder = await this.getWorkOrderOrThrow(input.workOrderId);
    return this.recordEvent(workOrder, input.eventType, {
      actorId: input.actorId,
      actorType: input.actorId
        ? VehicleHandoverEventActorType.FIELD_OPERATOR
        : VehicleHandoverEventActorType.SYSTEM,
      detail: compactUndefined({
        elapsedMs: input.elapsedMs,
        errorCode: input.errorCode,
        evidenceItemId: input.evidenceItemId,
        partCount: input.partCount,
        sessionId: input.sessionId,
        status: input.status
      })
    });
  }

  async removeFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    itemId: string,
    evidenceFileId: string,
    actorId?: string
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    const normalizedPhone = normalizeFieldOperatorPhone(phone);
    return this.runSerializableTransaction(async (tx) => {
      const current = await this.updateWorkOrderVersioned(workOrder, {}, tx);
      if (!isFieldAccessibleWorkOrder(current, normalizedPhone)) {
        throw new UnauthorizedException("No access to this field handover work order.");
      }
      assertFieldSessionEditable(current);
      const item = await this.assertEvidenceItemBelongsToWorkOrder(current, itemId, tx);
      const result = await this.deliveryEvidenceService.removeEvidenceFile(
        item.id,
        evidenceFileId,
        actorId,
        tx
      );
      await this.recordEvent(current, VehicleHandoverEventType.EVIDENCE_FILE_REMOVED, {
        actorId,
        actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
        detail: {
          evidenceFileId,
          evidenceItemId: item.id
        }
      }, tx);
      return result;
    });
  }

  async declareFieldAccessibleNoVisibleDamage(
    id: string,
    phone: string,
    remark?: string,
    actorId?: string
  ) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    const normalizedPhone = normalizeFieldOperatorPhone(phone);
    return this.runSerializableTransaction(async (tx) => {
      const current = await this.updateWorkOrderVersioned(workOrder, {}, tx);
      if (!isFieldAccessibleWorkOrder(current, normalizedPhone)) {
        throw new UnauthorizedException("No access to this field handover work order.");
      }
      assertFieldSessionEditable(current);
      await this.deliveryEvidenceService.declareNoVisibleDamage(
        current.orderId,
        undefined,
        current.handoverId ?? null,
        remark,
        tx
      );
      const updated = await tx.vehicleHandoverWorkOrder.update({
        data: {
          damageDeclared: false,
          metadata: mergeMetadata(current.metadata, { noVisibleDamageDeclaredBy: null }),
          noVisibleDamageDeclared: true
        },
        where: { id: current.id }
      });
      await this.recordEvent(updated, VehicleHandoverEventType.NO_VISIBLE_DAMAGE_DECLARED, {
        actorId,
        actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
        detail: { remark: normalizeOptionalText(remark) }
      }, tx);
      return updated;
    });
  }

  async previewEvidenceFile(id: string, evidenceFileId: string): Promise<EvidenceFileStreamResult> {
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: true });
  }

  async downloadEvidenceFile(id: string, evidenceFileId: string): Promise<EvidenceFileStreamResult> {
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: false });
  }

  async prepareExistingEvidenceFileArtifacts(
    id: string,
    evidenceFileId: string,
    actorId?: string
  ) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertEvidenceArtifactRepairAllowed(workOrder);
    const evidenceFile = await this.findScopedActiveEvidenceFile(workOrder, evidenceFileId);
    if (await this.hasReadyEvidenceArtifacts(evidenceFile, this.prisma)) {
      return {
        evidenceFileId,
        metadata: evidenceFile.metadata,
        processingStatus: "READY"
      };
    }

    const mediaType = evidenceFile.mediaType === DeliveryEvidenceMediaType.VIDEO
      ? DeliveryEvidenceMediaType.VIDEO
      : DeliveryEvidenceMediaType.PHOTO;
    const maxBytes = mediaType === DeliveryEvidenceMediaType.VIDEO
      ? MAX_FIELD_VIDEO_SIZE_BYTES
      : MAX_FIELD_PHOTO_SIZE_BYTES;
    const sourceSizeBytes = toNumberOrNull(evidenceFile.file.sizeBytes);
    if (sourceSizeBytes !== null && sourceSizeBytes > maxBytes) {
      throw new BadRequestException("历史交接证据源文件超出当前处理大小限制。");
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "stage2-evidence-repair-"));
    const sourcePath = path.join(directory, sanitizeTempEvidenceFileName(evidenceFile.file.originalName));
    const storedDerivatives: Array<{ bucket: string; objectKey: string }> = [];
    let prepared: PreparedDeliveryEvidenceArtifacts | undefined;
    try {
      const downloaded = await this.getStorageService().getObject(
        evidenceFile.file.bucket,
        evidenceFile.file.objectKey
      );
      const actualSizeBytes = await writeStreamToBoundedFile(
        downloaded.stream,
        sourcePath,
        maxBytes,
        "历史交接证据源文件超出当前处理大小限制。"
      );
      prepared = await this.getEvidenceArtifactService().prepareUpload({
        evidenceType: String(evidenceFile.evidenceItem.evidenceType),
        file: {
          mimetype: evidenceFile.file.mimeType ?? downloaded.contentType ?? undefined,
          originalname: evidenceFile.file.originalName ?? "evidence-file",
          path: sourcePath,
          size: actualSizeBytes
        },
        mediaType,
        qualityPolicy: "LEGACY_REPAIR"
      });
      const derivatives: Array<{
        derivative: PreparedDeliveryEvidenceArtifacts["derivatives"][number];
        stored: Awaited<ReturnType<StorageService["putDeliveryEvidenceDerivativeFromPath"]>>;
      }> = [];
      for (const derivative of prepared.derivatives) {
        const stored = await this.getStorageService().putDeliveryEvidenceDerivativeFromPath({
          contentType: derivative.contentType,
          filePath: derivative.filePath,
          kind: derivative.kind,
          metadata: {
            artifactKind: derivative.kind,
            repairedEvidenceFileId: evidenceFileId
          },
          orderId: workOrder.orderId,
          originalName: derivative.originalName,
          sizeBytes: derivative.sizeBytes,
          workOrderId: workOrder.id
        });
        storedDerivatives.push({ bucket: stored.bucket, objectKey: stored.objectKey });
        derivatives.push({ derivative, stored });
      }

      const result = await this.runSerializableTransaction(async (tx) => {
        const current = await this.updateWorkOrderVersioned(workOrder, {}, tx);
        this.assertEvidenceArtifactRepairAllowed(current);
        const currentEvidenceFile = await tx.vehicleDeliveryEvidenceFile.findFirst({
          include: { evidenceItem: true, file: true },
          where: {
            id: evidenceFileId,
            lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE
          }
        });
        if (!currentEvidenceFile) {
          throw new NotFoundException("交接资料文件不存在。");
        }
        if (await this.hasReadyEvidenceArtifacts(currentEvidenceFile, tx)) {
          return {
            alreadyReady: true,
            evidenceFileId,
            metadata: currentEvidenceFile.metadata,
            processingStatus: "READY"
          };
        }
        const derivativeFileObjects = [];
        for (const item of derivatives) {
          derivativeFileObjects.push(await tx.fileObject.create({
            data: {
              bucket: item.stored.bucket,
              mimeType: item.derivative.contentType,
              objectKey: item.stored.objectKey,
              originalName: item.derivative.originalName,
              sizeBytes: BigInt(item.derivative.sizeBytes),
              uploadedBy: actorId ?? null
            }
          }));
        }
        const metadata = {
          ...prepared!.metadata,
          photoPreviewFileId:
            mediaType === DeliveryEvidenceMediaType.PHOTO
              ? derivativeFileObjects[0]?.id ?? null
              : null,
          videoFrameFileIds:
            mediaType === DeliveryEvidenceMediaType.VIDEO
              ? derivativeFileObjects.map((fileObject) => fileObject.id)
              : []
        } as Prisma.InputJsonValue;
        await tx.vehicleDeliveryEvidenceFile.update({
          data: { metadata },
          where: { id: evidenceFileId }
        });
        return {
          alreadyReady: false,
          evidenceFileId,
          metadata,
          processingStatus: "READY"
        };
      });
      if (result.alreadyReady) {
        await this.deleteStoredObjectsWithRetry(storedDerivatives);
      }
      return result;
    } catch (error) {
      await this.deleteStoredObjectsWithRetry(storedDerivatives);
      throw error;
    } finally {
      await Promise.allSettled([
        prepared?.cleanup() ?? Promise.resolve(),
        rm(directory, { force: true, recursive: true })
      ]);
    }
  }

  async previewFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    evidenceFileId: string
  ): Promise<EvidenceFileStreamResult> {
    await this.getFieldAccessibleWorkOrderRecord(id, phone);
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: true });
  }

  async downloadFieldAccessibleEvidenceFile(
    id: string,
    phone: string,
    evidenceFileId: string
  ): Promise<EvidenceFileStreamResult> {
    await this.getFieldAccessibleWorkOrderRecord(id, phone);
    return this.getEvidenceFileStream(id, evidenceFileId, { preview: false });
  }

  async previewFieldAccessibleStage2HandoverPdf(
    id: string,
    phone: string
  ): Promise<EvidenceFileStreamResult> {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    return this.getValidatedStage2HandoverPdfStream(workOrder);
  }

  async downloadFieldAccessibleStage2HandoverPdf(
    id: string,
    phone: string
  ): Promise<EvidenceFileStreamResult> {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    return this.getValidatedStage2HandoverPdfStream(workOrder);
  }

  async assertFieldStage2ESignReview(
    id: string,
    phone: string,
    input: FieldStage2ESignReviewInput
  ): Promise<FieldStage2ESignReview> {
    if (input.acknowledgement !== true) {
      throw new BadRequestException(
        "The Stage 2 source PDF review acknowledgement is required."
      );
    }
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    if (workOrder.status !== "CUSTOMER_CONFIRMED") {
      throw new BadRequestException(
        "The handover is not ready for Field eSign initiation."
      );
    }
    const binding = await this.resolveFieldStage2SourceArtifact(workOrder);
    const requestedHash = normalizeStage2Sha256(input.sourcePdfHash);
    if (
      input.artifactVersion !== binding.artifactVersion ||
      requestedHash !== binding.sourcePdfHash
    ) {
      throw new ConflictException(
        "The reviewed Stage 2 source PDF is stale."
      );
    }
    return {
      acknowledgement: true,
      artifactVersion: binding.artifactVersion,
      reviewedAt: new Date(),
      sourcePdfHash: binding.sourcePdfHash
    };
  }

  async submitFieldAccessibleEvidence(id: string, phone: string, actorId?: string) {
    const workOrder = await this.getFieldAccessibleWorkOrderRecord(id, phone);
    assertFieldSessionEditable(workOrder);
    return this.submitEvidence(
      id,
      actorId,
      undefined,
      workOrder,
      normalizeFieldOperatorPhone(phone)
    );
  }

  async startFieldWork(
    id: string,
    actorId?: string,
    actorDisplay?: string | null,
    expectedWorkOrder?: WorkOrderRecord
  ) {
    const workOrder = expectedWorkOrder ?? await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    return this.updateWorkOrderWithEvent(workOrder, {
      fieldStartedAt: workOrder.fieldStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { fieldStartedBy: actorId ?? null }),
      status: "FIELD_IN_PROGRESS"
    }, VehicleHandoverEventType.FIELD_STARTED, {
      actorDisplay,
      actorId,
      actorType: VehicleHandoverEventActorType.FIELD_OPERATOR
    }, (tx) => this.assertDeliveryStartAvailable(tx, workOrder),
      Prisma.TransactionIsolationLevel.ReadCommitted
    );
  }

  async startFieldWorkByToken(token: string) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    if (workOrder.status === "CUSTOMER_OBJECTED") {
      return workOrder;
    }
    return this.startFieldWork(
      workOrder.id,
      undefined,
      workOrder.externalOperatorName ?? "external",
      workOrder
    );
  }

  async updateFieldFacts(
    id: string,
    input: UpdateFieldFactsInput,
    actorId?: string,
    actorDisplay?: string | null,
    expectedWorkOrder?: WorkOrderRecord,
    expectedFieldPhone?: string
  ) {
    const workOrder = expectedWorkOrder ?? await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    if (expectedFieldPhone) {
      assertFieldSessionEditable(workOrder);
    }
    assertDamageState(input.damageDeclared, input.noVisibleDamageDeclared);
    const switchesToDamage = input.damageDeclared === true && input.noVisibleDamageDeclared !== true;
    return this.runTransaction(async (tx) => {
      if (workOrder.status === "DRAFT") {
        await this.assertDeliveryStartAvailable(tx, workOrder);
      }
      const updated = await this.updateWorkOrderVersioned(workOrder, compactUndefined({
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
      }), tx);
      if (expectedFieldPhone) {
        if (!isFieldAccessibleWorkOrder(updated, expectedFieldPhone)) {
          throw new UnauthorizedException("No access to this field handover work order.");
        }
        assertFieldSessionEditable(updated);
      }
      if (switchesToDamage) {
        await this.deliveryEvidenceService.retractNoVisibleDamageDeclaration(
          updated.orderId,
          actorId,
          updated.handoverId ?? null,
          tx
        );
      }
      await this.recordEvent(updated, VehicleHandoverEventType.FIELD_FACTS_UPDATED, {
        actorDisplay,
        actorId,
        actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
        detail: {
          changedFieldKeys: HANDOVER_FIELD_FACT_KEYS.filter((key) => input[key] !== undefined)
        }
      }, tx);
      return updated;
    },
      workOrder.status === "DRAFT"
        ? Prisma.TransactionIsolationLevel.ReadCommitted
        : Prisma.TransactionIsolationLevel.Serializable
    );
  }

  async updateFieldFactsByToken(token: string, input: UpdateFieldFactsInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    return this.updateFieldFacts(
      workOrder.id,
      input,
      undefined,
      workOrder.externalOperatorName ?? "external",
      workOrder
    );
  }

  async attachEvidenceFileWithExternalToken(token: string, itemId: string, input: AttachFieldEvidenceFileInput) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    assertFieldSessionEditable(workOrder);
    void itemId;
    void input;
    throw new BadRequestException("该文件绑定入口已停用，请使用现场证据文件上传接口完成预处理后再提交。");
  }

  async acknowledgeCustomerObjection(id: string, actorId: string, note?: string | null) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    if (getHandoverReviewAdminStatus(workOrder) !== VehicleHandoverAdminReviewStatus.NONE) {
      throw new BadRequestException("当前异议状态不能重复受理。");
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.ACKNOWLEDGED,
        metadata: mergeMetadata(workOrder.metadata, {
          handoverReviewAdminAcknowledgedAt: now.toISOString(),
          handoverReviewAdminAcknowledgedBy: actorId,
          handoverReviewAdminNote: normalizeOptionalText(note),
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_ACKNOWLEDGED
        })
      }, tx);
      await this.upsertLatestReviewAttempt(current, "CUSTOMER_OBJECTED", {
        adminAcknowledgedAt: now,
        adminAcknowledgedById: actorId,
        adminNotes: normalizeOptionalText(note),
        adminStatus: ADMIN_REVIEW_STATUS_ACKNOWLEDGED
      }, {}, tx);
      await this.recordEvent(current, VehicleHandoverEventType.OBJECTION_ACKNOWLEDGED, {
        actorId,
        actorType: VehicleHandoverEventActorType.ADMIN,
        detail: { note: normalizeOptionalText(note) }
      }, tx);
      return current;
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  async requestCustomerObjectionResubmission(
    id: string,
    actorId: string,
    input: RequestCustomerObjectionResubmissionInput
  ) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    if (getHandoverReviewAdminStatus(workOrder) !== VehicleHandoverAdminReviewStatus.ACKNOWLEDGED) {
      throw new BadRequestException("请先受理客户异议，再要求现场复检。");
    }
    const note = normalizeRequiredText(input.note, "请填写现场复检要求。");
    const targetEvidenceItemIds = uniqueStrings(input.targetEvidenceItemIds);
    const targetFieldKeys = uniqueFieldFactKeys(input.targetFieldKeys);
    await this.assertEvidenceItemTargetsBelongToWorkOrder(workOrder, targetEvidenceItemIds);
    const latestAttempt = await this.findLatestReviewAttempt(workOrder.id);
    const baseline = latestAttempt
      ? {
          evidenceSnapshot: readUnknownRecordValue(latestAttempt, "evidenceSnapshot"),
          fieldFactsSnapshot: readUnknownRecordValue(latestAttempt, "fieldFactsSnapshot")
        }
      : await this.buildReviewAttemptSnapshot(workOrder);
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.RESUBMISSION_REQUESTED,
        metadata: mergeMetadata(workOrder.metadata, {
          handoverReviewAdminNote: note,
          handoverReviewResubmissionRequestedAt: now.toISOString(),
          handoverReviewResubmissionRequestedBy: actorId,
          handoverReviewTargetEvidenceItemIds: targetEvidenceItemIds,
          handoverReviewTargetFieldKeys: targetFieldKeys,
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED
        }),
        status: "CUSTOMER_OBJECTED"
      }, tx);
      await this.upsertLatestReviewAttempt(current, "RESUBMISSION_REQUESTED", {
        adminNotes: note,
        adminStatus: ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED,
        metadata: toJsonValue(mergeMetadata(readUnknownRecordValue(latestAttempt, "metadata"), {
          resubmissionBaseline: baseline,
          resubmissionRequestedEvidenceItemIds: targetEvidenceItemIds,
          resubmissionRequestedFieldKeys: targetFieldKeys
        })),
        resubmissionRequestedAt: now,
        resubmissionRequestedById: actorId
      }, {}, tx);
      await this.recordEvent(current, VehicleHandoverEventType.RESUBMISSION_REQUESTED, {
        actorId,
        actorType: VehicleHandoverEventActorType.ADMIN,
        detail: {
          note,
          targetEvidenceItemIds,
          targetFieldKeys
        }
      }, tx);
      return current;
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  async sendCustomerObjectionBackToReview(id: string, actorId: string, note?: string | null) {
    const workOrder = await this.getObjectedWorkOrderOrThrow(id);
    if (getHandoverReviewAdminStatus(workOrder) !== ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN) {
      throw new BadRequestException("现场资料重新提交后，后台才能送回客户复核。");
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.SENT_BACK_TO_CUSTOMER_REVIEW,
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
      }, tx);
      const attempt = await this.createReviewAttempt(current, "CUSTOMER_REVIEWING", {
        adminNotes: normalizeOptionalText(note),
        adminStatus: ADMIN_REVIEW_STATUS_SENT_BACK_TO_CUSTOMER_REVIEW,
        customerReviewStartedAt: now,
        sentBackToCustomerReviewAt: now,
        sentBackToCustomerReviewById: actorId
      }, tx);
      await this.recordEvent(current, VehicleHandoverEventType.SENT_BACK_TO_CUSTOMER_REVIEW, {
        actorId,
        actorType: VehicleHandoverEventActorType.ADMIN,
        detail: { note: normalizeOptionalText(note) },
        reviewAttemptId: attempt ? String(attempt.id) : null
      }, tx);
      return current;
    });
    return this.toAdminWorkOrderDetail(updated);
  }

  private async attachEvidenceFileForWorkOrder(
    workOrder: WorkOrderRecord,
    itemId: string,
    input: AttachFieldEvidenceFileInput,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    uploadedBy?: string,
    lifecycleActorId?: string
  ) {
    await this.assertEvidenceItemBelongsToWorkOrder(workOrder, itemId, db);
    return this.deliveryEvidenceService.attachEvidenceFile(
      itemId,
      input.fileId,
      input.mediaType,
      uploadedBy,
      db,
      lifecycleActorId
    );
  }

  private async assertEvidenceItemBelongsToWorkOrder(
    workOrder: WorkOrderRecord,
    itemId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const item = await db.vehicleDeliveryEvidenceItem.findFirst({
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
    return item;
  }

  async submitEvidence(
    id: string,
    actorId?: string,
    actorDisplay?: string | null,
    expectedWorkOrder?: WorkOrderRecord,
    expectedFieldPhone?: string
  ) {
    const workOrder = expectedWorkOrder ?? await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    if (expectedFieldPhone) {
      assertFieldSessionEditable(workOrder);
    }
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
      const latestAttempt = await this.findLatestReviewAttempt(workOrder.id);
      const changeSummary = await this.buildResubmissionChangeSummary(workOrder, latestAttempt);
      if (!changeSummary.changed) {
        throw new BadRequestException("请至少更新一项后台要求复检的现场资料。");
      }
      return this.prisma.$transaction(async (tx) => {
        const updated = await this.updateWorkOrderVersioned(workOrder, {
          adminReviewStatus: VehicleHandoverAdminReviewStatus.RESUBMITTED_PENDING_ADMIN,
          fieldSubmittedAt: now,
          metadata: mergeMetadata(workOrder.metadata, {
            fieldSubmittedBy: actorId ?? null,
            handoverReviewResubmittedAt: now.toISOString(),
            handoverReviewResubmissionChangeSummary: changeSummary,
            [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN
          }),
          status: "CUSTOMER_OBJECTED"
        }, tx);
        if (expectedFieldPhone && !isFieldAccessibleWorkOrder(updated, expectedFieldPhone)) {
          throw new UnauthorizedException("No access to this field handover work order.");
        }
        const attempt = await this.upsertLatestReviewAttempt(updated, "RESUBMITTED_PENDING_ADMIN", {
          adminStatus: ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN,
          fieldSubmittedAt: now,
          metadata: toJsonValue(mergeMetadata(readUnknownRecordValue(latestAttempt, "metadata"), {
            resubmissionChangeSummary: changeSummary,
            resubmittedEvidenceSnapshot: changeSummary.currentEvidenceSnapshot,
            resubmittedFieldFactsSnapshot: changeSummary.currentFieldFactsSnapshot
          }))
        }, {}, tx);
        await this.recordEvent(updated, VehicleHandoverEventType.FIELD_RESUBMITTED, {
          actorDisplay,
          actorId,
          actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
          detail: {
            changedEvidenceItemIds: changeSummary.changedEvidenceItemIds,
            changedFieldKeys: changeSummary.changedFieldKeys
          },
          reviewAttemptId: attempt ? String(attempt.id) : null
        }, tx);
        return updated;
      });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.NONE,
        customerReviewStartedAt: workOrder.customerReviewStartedAt ?? now,
        fieldSubmittedAt: workOrder.fieldSubmittedAt ?? now,
        metadata: mergeMetadata(workOrder.metadata, {
          fieldSubmittedBy: actorId ?? null,
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: null
        }),
        status: "CUSTOMER_REVIEWING"
      }, tx);
      if (expectedFieldPhone && !isFieldAccessibleWorkOrder(updated, expectedFieldPhone)) {
        throw new UnauthorizedException("No access to this field handover work order.");
      }
      const attempt = await this.upsertLatestReviewAttempt(updated, "CUSTOMER_REVIEWING", {
        adminStatus: null,
        customerReviewStartedAt: updated.customerReviewStartedAt ?? now,
        fieldSubmittedAt: updated.fieldSubmittedAt ?? now
      }, { refreshSnapshot: true }, tx);
      await this.recordEvent(updated, VehicleHandoverEventType.FIELD_SUBMITTED, {
        actorDisplay,
        actorId,
        actorType: VehicleHandoverEventActorType.FIELD_OPERATOR,
        reviewAttemptId: attempt ? String(attempt.id) : null
      }, tx);
      return updated;
    });
  }

  async submitEvidenceByToken(token: string) {
    const workOrder = await this.resolveExternalWorkOrder(token);
    return this.submitEvidence(
      workOrder.id,
      undefined,
      workOrder.externalOperatorName ?? "external",
      workOrder
    );
  }

  async startCustomerReview(id: string, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertStatusIn(workOrder, ["EVIDENCE_SUBMITTED", "CUSTOMER_REVIEWING"], "当前工单尚不能进入客户复核。");
    return this.updateWorkOrderWithEvent(workOrder, {
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? new Date(),
      metadata: mergeMetadata(workOrder.metadata, { customerReviewStartedBy: actorId ?? null }),
      status: "CUSTOMER_REVIEWING"
    }, VehicleHandoverEventType.CUSTOMER_REVIEW_STARTED, {
      actorId,
      actorType: actorId ? VehicleHandoverEventActorType.ADMIN : VehicleHandoverEventActorType.SYSTEM
    });
  }

  async customerConfirmNoObjection(id: string, customerId: string, manifestHash: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertCustomerOwnsWorkOrder(workOrder, customerId);
    this.assertMutable(workOrder);
    if (workOrder.status === "CUSTOMER_CONFIRMED") {
      if (!this.isStage2HandoverWorkflowEnabled()) {
        throw new BadRequestException("客户已确认无异议。");
      }
      return this.replayCustomerConfirmation(workOrder, manifestHash);
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
    return this.runSerializableTransaction(async (tx) => {
      const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }, tx);
      const evidencePackage = await this.buildCurrentEvidencePackage(
        workOrder,
        evidenceChecklist,
        tx
      );
      if (evidencePackage.manifestHash !== manifestHash) {
        throw new ConflictException("交接证据已变化，请刷新并重新查看全部资料后再确认。");
      }
      const updated = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.RESOLVED,
        customerConfirmedAt: confirmedAt,
        customerObjectedAt: null,
        customerObjectionReason: null,
        metadata: mergeMetadata(workOrder.metadata, {
          customerConfirmedBy: customerId,
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: ADMIN_REVIEW_STATUS_RESOLVED
        }),
        status: "CUSTOMER_CONFIRMED"
      }, tx);
      const attempt = await this.upsertLatestReviewAttempt(updated, "CUSTOMER_CONFIRMED", {
        adminStatus: ADMIN_REVIEW_STATUS_RESOLVED,
        customerConfirmedAt: confirmedAt,
        resolvedAt: confirmedAt,
        resolvedById: null
      }, {
        snapshot: await this.buildReviewAttemptSnapshot(
          updated,
          tx,
          evidenceChecklist,
          evidencePackage
        )
      }, tx);
      await this.recordEvent(updated, VehicleHandoverEventType.CUSTOMER_CONFIRMED, {
        actorId: customerId,
        actorType: VehicleHandoverEventActorType.CUSTOMER,
        reviewAttemptId: attempt ? String(attempt.id) : null
      }, tx);
      if (!this.isStage2HandoverWorkflowEnabled()) {
        return updated;
      }
      const job = await this.enqueueStage2SourcePdf(
        tx,
        updated,
        requireReviewAttemptId(attempt),
        evidencePackage.manifestHash
      );
      return {
        ...updated,
        stage2Workflow: toPendingStage2WorkflowProjection(job.id)
      };
    });
  }

  private async replayCustomerConfirmation(
    workOrder: WorkOrderRecord,
    manifestHash: string
  ) {
    return this.runSerializableTransaction(async (tx) => {
      const attempt = await this.findLatestReviewAttempt(workOrder.id, tx);
      const confirmedManifestHash = readEvidencePackageManifestHash(
        readUnknownRecordValue(attempt, "evidenceSnapshot")
      );
      if (
        !attempt ||
        readString(attempt, "status") !== "CUSTOMER_CONFIRMED" ||
        confirmedManifestHash !== manifestHash
      ) {
        throw new ConflictException(
          "客户确认未绑定当前交接证据，请刷新后重试。"
        );
      }
      const job = await this.enqueueStage2SourcePdf(
        tx,
        workOrder,
        requireReviewAttemptId(attempt),
        manifestHash
      );
      return {
        ...workOrder,
        stage2Workflow: toPendingStage2WorkflowProjection(job.id)
      };
    });
  }

  private enqueueStage2SourcePdf(
    tx: Prisma.TransactionClient,
    workOrder: WorkOrderRecord,
    reviewAttemptId: string,
    manifestHash: string
  ) {
    if (!this.workflowRepository) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_REPOSITORY_UNAVAILABLE");
    }
    return this.workflowRepository.enqueue(tx, {
      handoverId: workOrder.handoverId ?? undefined,
      idempotencyKey:
        `pdf:${workOrder.id}:${reviewAttemptId}:${manifestHash}`,
      jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
      payload: {
        manifestHash,
        reviewAttemptId
      },
      workOrderId: workOrder.id
    });
  }

  private isStage2HandoverWorkflowEnabled() {
    return this.configService
      ?.get<string>(STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV)
      ?.trim()
      .toLowerCase() === "true";
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
    return this.prisma.$transaction(async (tx) => {
      const updated = await this.updateWorkOrderVersioned(workOrder, {
        adminReviewStatus: VehicleHandoverAdminReviewStatus.NONE,
        customerObjectedAt: now,
        customerObjectionReason: objectionReason,
        metadata: mergeMetadata(workOrder.metadata, {
          customerObjectedBy: customerId,
          customerObjectionDetails: objectionDetails,
          [HANDOVER_REVIEW_ADMIN_STATUS_KEY]: null
        }),
        status: "CUSTOMER_OBJECTED"
      }, tx);
      const attempt = await this.upsertLatestReviewAttempt(updated, "CUSTOMER_OBJECTED", {
        adminStatus: null,
        customerObjectedAt: now,
        customerObjectionDetails: objectionDetails,
        customerObjectionReason: objectionReason
      }, {}, tx);
      await this.recordEvent(updated, VehicleHandoverEventType.CUSTOMER_OBJECTED, {
        actorId: customerId,
        actorType: VehicleHandoverEventActorType.CUSTOMER,
        detail: {
          details: objectionDetails,
          reason: objectionReason
        },
        reviewAttemptId: attempt ? String(attempt.id) : null
      }, tx);
      return updated;
    });
  }

  async markCustomerSigned(id: string, signedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertStatusIn(workOrder, ["CUSTOMER_CONFIRMED", "SIGNING", "CUSTOMER_SIGNED"], "客户尚不能进入已签署状态。");
    return this.updateWorkOrderWithEvent(workOrder, {
      fieldCompletedAt: workOrder.fieldCompletedAt ?? signedAt,
      metadata: mergeMetadata(workOrder.metadata, { customerSignedMarkedBy: actorId ?? null }),
      status: "CUSTOMER_SIGNED"
    }, VehicleHandoverEventType.CUSTOMER_SIGNED, {
      actorId,
      actorType: actorId ? VehicleHandoverEventActorType.ADMIN : VehicleHandoverEventActorType.SYSTEM,
      detail: { signedAt: signedAt.toISOString() }
    });
  }

  async markPlatformSealed(id: string, sealedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertStatusIn(workOrder, ["CUSTOMER_SIGNED", "PLATFORM_SEALED"], "客户签署完成后才能执行平台盖章。");
    return this.updateWorkOrderWithEvent(workOrder, {
      metadata: mergeMetadata(workOrder.metadata, {
        platformSealedAt: sealedAt.toISOString(),
        platformSealedMarkedBy: actorId ?? null
      }),
      status: "PLATFORM_SEALED"
    }, VehicleHandoverEventType.PLATFORM_SEALED, {
      actorId,
      actorType: actorId ? VehicleHandoverEventActorType.ADMIN : VehicleHandoverEventActorType.SYSTEM,
      detail: { sealedAt: sealedAt.toISOString() }
    });
  }

  async markFieldCompleted(id: string, completedAt: Date, actorId?: string) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    this.assertMutable(workOrder);
    assertStatusIn(workOrder, ["PLATFORM_SEALED", "FIELD_COMPLETED"], "平台盖章完成后才能完成现场交接。");
    return this.updateWorkOrderWithEvent(workOrder, {
      fieldCompletedAt: workOrder.fieldCompletedAt ?? completedAt,
      metadata: mergeMetadata(workOrder.metadata, { fieldCompletedBy: actorId ?? null }),
      status: "FIELD_COMPLETED"
    }, VehicleHandoverEventType.FIELD_COMPLETED, {
      actorId,
      actorType: actorId ? VehicleHandoverEventActorType.ADMIN : VehicleHandoverEventActorType.SYSTEM,
      detail: { completedAt: completedAt.toISOString() }
    });
  }

  async reconcileArchivedStage2JourneyEvidence(
    workOrderId: string
  ): Promise<ArchivedStage2EvidenceReconciliationResult> {
    return this.runSerializableTransaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT work_order."id"
        FROM "vehicle_handover_work_order" AS work_order
        INNER JOIN "vehicle_delivery_handover" AS handover
          ON handover."id" = work_order."handover_id"
        WHERE work_order."id" = CAST(${workOrderId} AS uuid)
        FOR UPDATE OF work_order, handover
      `);

      const workOrder = await this.getWorkOrderOrThrow(workOrderId, tx);
      assertCanReconcileArchivedStage2Evidence(workOrder);
      if (!workOrder.handoverId) {
        throw new ConflictException("STAGE2_HANDOVER_ARCHIVE_BINDING_INVALID");
      }
      const handover = await tx.vehicleDeliveryHandover.findFirst({
        where: {
          deletedAt: null,
          id: workOrder.handoverId,
          orderId: workOrder.orderId
        }
      });
      if (
        !handover ||
        !handover.archivedAt ||
        !hasCompleteStage2HandoverArchive(handover)
      ) {
        throw new ConflictException("STAGE2_HANDOVER_ARCHIVE_INCOMPLETE");
      }

      const evidencePackage = await this.buildCurrentEvidencePackage(
        workOrder,
        undefined,
        tx
      );
      const persistedManifestHash = readMetadataString(
        workOrder.metadata,
        "journeyEvidenceManifestHash"
      );
      if (
        (workOrder.status === "OPS_REVIEW_PENDING" ||
          workOrder.status === "OPS_REVIEWED") &&
        persistedManifestHash &&
        persistedManifestHash !== evidencePackage.manifestHash
      ) {
        throw new ConflictException("JOURNEY_EVIDENCE_MANIFEST_STALE");
      }

      const alreadyReady =
        (workOrder.status === "OPS_REVIEW_PENDING" &&
          workOrder.opsReviewStatus === "PENDING" &&
          persistedManifestHash === evidencePackage.manifestHash) ||
        workOrder.status === "OPS_REVIEWED";
      if (!alreadyReady) {
        const updated = await this.updateWorkOrderVersioned(workOrder, {
          fieldCompletedAt:
            workOrder.fieldCompletedAt ??
            handover.completedAt ??
            handover.archivedAt,
          metadata: mergeMetadata(workOrder.metadata, {
            journeyEvidenceManifestHash: evidencePackage.manifestHash,
            opsReviewRequestedBy: null,
            opsReviewSource: "STAGE2_AUTHORITATIVE_ARCHIVE"
          }),
          opsReviewStatus: "PENDING",
          status: "OPS_REVIEW_PENDING"
        }, tx);
        await this.recordEvent(
          updated,
          VehicleHandoverEventType.OPS_REVIEW_UPDATED,
          {
            actorType: VehicleHandoverEventActorType.SYSTEM,
            detail: {
              manifestHash: evidencePackage.manifestHash,
              source: "STAGE2_AUTHORITATIVE_ARCHIVE",
              status: "PENDING"
            }
          },
          tx
        );
      }

      await this.deliveryEvidenceService.recordJourneyEvidenceReady(
        tx,
        {
          handoverId: workOrder.handoverId,
          manifestHash: evidencePackage.manifestHash,
          orderId: workOrder.orderId,
          workOrderId: workOrder.id
        },
        { readinessMode: "FIELD_COMPLETENESS" }
      );
      return {
        manifestHash: evidencePackage.manifestHash,
        outcome: alreadyReady ? "ALREADY_READY" : "SIGNALLED",
        workOrderId: workOrder.id
      };
    });
  }

  async reconcileArchivedStage2JourneyEvidenceBatch(
    limit = MAX_STAGE2_ARCHIVE_RECONCILIATION_BATCH_SIZE
  ): Promise<{ failed: number; processed: number; scanned: number }> {
    const safeLimit = Number.isSafeInteger(limit)
      ? Math.min(
          Math.max(limit, 1),
          MAX_STAGE2_ARCHIVE_RECONCILIATION_BATCH_SIZE
        )
      : MAX_STAGE2_ARCHIVE_RECONCILIATION_BATCH_SIZE;
    const candidates = await this.prisma.vehicleHandoverWorkOrder.findMany({
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: safeLimit,
      where: {
        handover: {
          is: {
            archiveStatus: DeliveryHandoverArchiveStatus.ARCHIVED,
            archivedAt: { not: null },
            deletedAt: null,
            signedDocumentFileId: { not: null },
            signedObjectKey: { not: null },
            signedPdfHash: { not: null },
            status: DeliveryHandoverStatus.ARCHIVED
          }
        },
        handoverType: VehicleHandoverType.DELIVERY_OUTBOUND,
        order: {
          is: {
            subscriptionJourney: {
              is: {
                currentStepCode:
                  SubscriptionJourneyStepCode.HANDOVER_AND_STAGE2_CREATION,
                status: {
                  notIn: [
                    SubscriptionJourneyStatus.COMPLETED,
                    SubscriptionJourneyStatus.CANCELLED
                  ]
                }
              }
            }
          }
        },
        status: {
          in: [
            VehicleHandoverWorkOrderStatus.CUSTOMER_CONFIRMED,
            VehicleHandoverWorkOrderStatus.SIGNING,
            VehicleHandoverWorkOrderStatus.CUSTOMER_SIGNED,
            VehicleHandoverWorkOrderStatus.PLATFORM_SEALED,
            VehicleHandoverWorkOrderStatus.FIELD_COMPLETED,
            VehicleHandoverWorkOrderStatus.OPS_REVIEW_PENDING
          ]
        }
      }
    });
    let failed = 0;
    let processed = 0;
    for (const candidate of candidates) {
      try {
        await this.reconcileArchivedStage2JourneyEvidence(candidate.id);
        processed += 1;
      } catch {
        failed += 1;
        this.logger.warn({
          errorCode: "STAGE2_ARCHIVE_CONVERGENCE_FAILED",
          operation: "RECONCILE_ARCHIVED_STAGE2_EVIDENCE",
          workOrderId: candidate.id
        });
      }
    }
    return {
      failed,
      processed,
      scanned: candidates.length
    };
  }

  async markOpsReviewPending(id: string, actorId?: string) {
    return this.runSerializableTransaction(async (tx) => {
      const workOrder = await this.getWorkOrderOrThrow(id, tx);
      assertCanMarkOpsReviewPending(workOrder);
      const evidencePackage = await this.buildCurrentEvidencePackage(
        workOrder,
        undefined,
        tx
      );
      const updated = await this.updateWorkOrderVersioned(workOrder, {
        metadata: mergeMetadata(workOrder.metadata, {
          journeyEvidenceManifestHash: evidencePackage.manifestHash,
          opsReviewRequestedBy: actorId ?? null
        }),
        opsReviewStatus: "PENDING",
        status: "OPS_REVIEW_PENDING"
      }, tx);
      await this.recordEvent(
        updated,
        VehicleHandoverEventType.OPS_REVIEW_UPDATED,
        {
          actorId,
          actorType: VehicleHandoverEventActorType.ADMIN,
          detail: {
            manifestHash: evidencePackage.manifestHash,
            status: "PENDING"
          }
        },
        tx
      );
      if (!updated.handoverId) {
        throw new BadRequestException("交接工单尚未关联车辆交接记录。");
      }
      await this.deliveryEvidenceService.recordJourneyEvidenceReady(tx, {
        handoverId: updated.handoverId,
        manifestHash: evidencePackage.manifestHash,
        orderId: updated.orderId,
        workOrderId: updated.id
      });
      return updated;
    });
  }

  async markOpsReviewApproved(id: string, reviewerId: string, notes?: string | null) {
    return this.runSerializableTransaction((tx) =>
      this.decideJourneyDeliveryEvidence(
        tx,
        id,
        "APPROVED",
        reviewerId,
        notes ?? undefined
      )
    );
  }

  async markOpsReviewRejected(id: string, reviewerId: string, notes?: string | null) {
    return this.runSerializableTransaction((tx) =>
      this.decideJourneyDeliveryEvidence(
        tx,
        id,
        "REJECTED",
        reviewerId,
        notes ?? undefined
      )
    );
  }

  async decideJourneyDeliveryEvidence(
    tx: Prisma.TransactionClient,
    workOrderId: string,
    decision: "APPROVED" | "REJECTED",
    actorId: string,
    notes?: string,
    decisionManifestHash?: string
  ): Promise<WorkOrderRecord> {
    const workOrder = await this.getWorkOrderOrThrow(workOrderId, tx);
    assertOpsReviewPending(workOrder);
    const evidencePackage = await this.buildCurrentEvidencePackage(
      workOrder,
      undefined,
      tx
    );
    if (
      decisionManifestHash &&
      decisionManifestHash !== evidencePackage.manifestHash
    ) {
      throw new BadRequestException("JOURNEY_EVIDENCE_MANIFEST_STALE");
    }
    const expectedManifestHash = readMetadataString(
      workOrder.metadata,
      "journeyEvidenceManifestHash"
    );
    if (
      expectedManifestHash &&
      expectedManifestHash !== evidencePackage.manifestHash
    ) {
      throw new BadRequestException(
        "交付证据已发生变化，请重新发起运营复核。"
      );
    }
    const normalizedNotes = normalizeOptionalText(notes);
    const manifestHash = expectedManifestHash ?? evidencePackage.manifestHash;
    const reviewedAt = new Date();
    const updated = await this.updateWorkOrderVersioned(workOrder, {
      customerConfirmedAt:
        decision === "REJECTED" ? null : workOrder.customerConfirmedAt,
      metadata: mergeMetadata(workOrder.metadata, {
        journeyEvidenceManifestHash: manifestHash,
        ...(decision === "REJECTED"
          ? { journeyRejectedManifestHash: manifestHash }
          : {})
      }),
      opsReviewNotes: normalizedNotes,
      opsReviewStatus: decision,
      opsReviewedAt: reviewedAt,
      opsReviewedBy: actorId,
      status: decision === "REJECTED" ? "FIELD_IN_PROGRESS" : "OPS_REVIEWED"
    }, tx);
    if (decision === "APPROVED") {
      await tx.vehicleInspection.upsert({
        create: {
          createdBy: actorId,
          inspectedAt: reviewedAt,
          orderId: updated.orderId,
          status: VehicleInspectionStatus.PASSED,
          updatedBy: actorId
        },
        update: {
          deletedAt: null,
          inspectedAt: reviewedAt,
          status: VehicleInspectionStatus.PASSED,
          updatedBy: actorId
        },
        where: { orderId: updated.orderId }
      });
    }
    await this.recordEvent(
      updated,
      VehicleHandoverEventType.OPS_REVIEW_UPDATED,
      {
        actorId,
        actorType: VehicleHandoverEventActorType.ADMIN,
        detail: {
          manifestHash,
          notes: normalizedNotes,
          status: decision
        }
      },
      tx
    );
    if (this.journeySignal) {
      await this.journeySignal.completeHandoverEvidenceDecision(tx, {
        actorId,
        decision,
        manifestHash,
        notes: normalizedNotes ?? undefined,
        orderId: updated.orderId,
        workOrderId: updated.id
      });
    }
    return updated;
  }

  async voidOrCancel(id: string, status: Extract<WorkOrderStatus, "VOIDED" | "FAILED" | "CANCELLED">, actorId?: string, reason?: string | null) {
    const workOrder = await this.getWorkOrderOrThrow(id);
    return this.updateWorkOrderWithEvent(workOrder, {
      metadata: mergeMetadata(workOrder.metadata, {
        terminalReason: normalizeOptionalText(reason),
        terminalUpdatedBy: actorId ?? null
      }),
      status
    }, VehicleHandoverEventType.WORK_ORDER_TERMINATED, {
      actorId,
      actorType: VehicleHandoverEventActorType.ADMIN,
      detail: {
        reason: normalizeOptionalText(reason),
        status
      }
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

  async getCurrentEvidencePackage(
    id: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const workOrder = await this.getWorkOrderOrThrow(id, db);
    return this.buildCurrentEvidencePackage(workOrder, undefined, db);
  }

  async getStage2HandoverPdf(id: string): Promise<Stage2HandoverPdfArtifactView> {
    const workOrder = await this.getWorkOrderOrThrow(id);
    const handover = await this.findStage2HandoverForWorkOrder(workOrder, { includeHandoverContract: true });
    if (handover && readString(handover, "sourceDocumentFileId")) {
      await this.assertGeneratedStage2PdfMatchesCurrentEvidence(workOrder, handover);
    }
    return this.toStage2HandoverPdfArtifactView(workOrder, handover);
  }

  async generateStage2HandoverPdf(id: string, actorId?: string): Promise<Stage2HandoverPdfArtifactView> {
    const evidencePackage = await this.getCurrentEvidencePackage(id);
    return this.ensureStage2HandoverPdf(id, evidencePackage.manifestHash, {
      actorId,
      enqueueNextJob: this.isStage2HandoverWorkflowEnabled()
    });
  }

  async ensureStage2HandoverPdf(
    id: string,
    expectedManifestHash: string,
    options: EnsureStage2HandoverPdfOptions = {}
  ): Promise<Stage2HandoverPdfArtifactView> {
    const workOrder = await this.getWorkOrderOrThrow(id);
    await this.assertWorkOrderReadyForStage2(workOrder);

    const handover = await this.findStage2HandoverForWorkOrderOrThrow(workOrder);
    const handoverId = readString(handover, "id");
    if (!handoverId) {
      throw new BadRequestException("车辆交接记录缺少有效 ID。");
    }
    const expectedManifestDigest = requireSha256Digest(expectedManifestHash);
    const evidenceChecklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });
    const evidencePackage = await this.buildCurrentEvidencePackage(
      workOrder,
      evidenceChecklist
    );
    await this.assertEvidencePackageMatchesLatestConfirmation(
      workOrder,
      evidencePackage
    );
    if (
      requireSha256Digest(evidencePackage.manifestHash) !==
      expectedManifestDigest
    ) {
      throw new ConflictException(
        "Current evidence does not match the queued manifest."
      );
    }

    const order = await this.getStage2PdfOrderOrThrow(workOrder.orderId);
    const reusable = await this.resolveReusableStage2HandoverPdf(
      workOrder,
      handover,
      expectedManifestDigest,
      order.customerId
    );
    if (reusable) {
      if (options.enqueueNextJob !== false) {
        await this.enqueueReadyStage2Pdf(
          workOrder,
          reusable.handover,
          expectedManifestHash,
          options.lease
        );
      }
      return this.toStage2HandoverPdfArtifactView(
        workOrder,
        reusable.handover,
        reusable.fileObject
      );
    }
    this.assertStage2HandoverPdfGenerationPrerequisites(handover);
    await options.lease?.assertLease();

    const activeTemplate = await this.findActiveStage2HandoverTemplate();
    const artifactVersion = STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION;
    const rendererVersion = STAGE2_HANDOVER_PDF_RENDERER_VERSION;
    const identity = buildStage2PdfArtifactIdentity(
      workOrder,
      expectedManifestDigest,
      artifactVersion,
      rendererVersion
    );
    const reservation = await this.reserveStage2SourcePdf(
      workOrder,
      handoverId,
      expectedManifestDigest,
      artifactVersion,
      identity.contractId,
      activeTemplate?.id ?? null,
      options.lease
    );
    const template = await this.findStage2HandoverTemplateById(
      reservation.templateId
    );
    if (!template) {
      throw new ConflictException("The reserved Stage 2 template is unavailable.");
    }
    const renderContract = {
      contractNo: reservation.contractNo,
      createdAt: reservation.generatedAt,
      id: reservation.contractId
    };

    let renderedFile: DeliveryHandoverPdfRenderFileResult | null = null;
    let stored:
      | Awaited<
          ReturnType<
            StorageService["putGeneratedContractPdfArtifactFromPath"]
          >
        >
      | null = null;
    try {
      const loadAsset = await this.buildStage2EvidenceAssetLoader(evidencePackage);
      const renderModel = buildDeliveryHandoverPdfRenderModel(
        this.buildStage2HandoverPdfRenderModelInput({
          createdContract: renderContract,
          evidenceChecklist,
          evidencePackage,
          handover,
          order,
          template,
          workOrder
        })
      );
      renderedFile = await this.getHandoverPdfRenderer().renderToFile(renderModel, {
        cjkFontPath: this.configService?.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV),
        evidencePackageUrl: this.buildStage2EvidencePackageUrl(workOrder.id),
        loadAsset
      });
      const sourcePdfHash = await calculateFileSha256(renderedFile.filePath);
      const storedIdentity = buildStage2PdfStoredIdentity(
        reservation.contractId,
        artifactVersion,
        sourcePdfHash
      );
      await options.lease?.assertLease();
      stored = await this.getStorageService().putGeneratedContractPdfArtifactFromPath({
        contentType: renderedFile.contentType,
        contractId: reservation.contractId,
        filePath: renderedFile.filePath,
        metadata: {
          artifactKind: "stage2-handover-pdf-source",
          documentNo: reservation.contractNo,
          evidenceManifestHash: evidencePackage.manifestHash,
          orderNo: order.orderNo,
          rendererVersion: String(rendererVersion),
          templateName: template.templateName,
          templateVersion: template.versionNo
        },
        objectKey: storedIdentity.objectKey,
        originalName: renderedFile.fileName,
        sizeBytes: renderedFile.sizeBytes
      });
      const storedArtifact = stored;
      await options.lease?.assertLease();
      const finalized = await this.runStage2SourcePdfFinalizationTransaction(async (tx) => {
        await this.assertStage2PdfLease(tx, options.lease);
        const lockedHandover = await this.lockStage2HandoverForSourcePdf(
          tx,
          handoverId
        );
        if (hasStage2SourceArtifactState(lockedHandover)) {
          throw new Stage2SourcePdfClaimLostError();
        }
        const createdFileObject = await tx.fileObject.create({
          data: {
            bucket: storedArtifact.bucket,
            id: storedIdentity.fileObjectId,
            mimeType: storedArtifact.contentType,
            objectKey: storedArtifact.objectKey,
            originalName: storedArtifact.originalName,
            sizeBytes: BigInt(storedArtifact.sizeBytes),
            uploadedBy: options.actorId ?? null
          }
      });
        const createdContract = await tx.contract.create({
          data: {
            businessType: BusinessType.SUBSCRIPTION,
            contractNo: reservation.contractNo,
            contractSnapshot: toJsonValue({
              artifactKind: "stage2-handover-pdf-source",
              diagnostics: renderedFile!.diagnostics,
              documentNo: reservation.contractNo,
              evidencePackage: {
                manifest: evidencePackage.manifest,
                manifestHash: evidencePackage.manifestHash,
                stats: evidencePackage.stats
              },
              fileId: createdFileObject.id,
              fileName: createdFileObject.originalName,
              handoverId,
              orderId: workOrder.orderId,
              orderNo: order.orderNo,
              stage2HandoverPdfArtifact: {
                artifactKind: "stage2-handover-pdf-source",
                artifactVersion,
                documentType: "DELIVERY_HANDOVER",
                fileId: createdFileObject.id,
                pageCount: renderedFile!.diagnostics.pageCount,
                rendererVersion,
                signingStage: "STAGE2_DELIVERY_HANDOVER",
                slotCoordinates: renderedFile!.slotCoordinates,
                sourcePdfHash
              },
              templateName: template.templateName,
              templateVersion: template.versionNo,
              workOrderId: workOrder.id
            }),
            contractTitle: `${template.templateName} ${template.versionNo}`,
            contractVersionId: template.id,
            createdAt: reservation.generatedAt,
            createdBy: options.actorId ?? null,
            customerId: order.customerId,
            fileId: createdFileObject.id,
            id: reservation.contractId,
            orderId: workOrder.orderId,
            status: ContractStatus.GENERATED,
            updatedBy: options.actorId ?? null
          }
        });
        await tx.vehicleDeliveryHandover.update({
          data: {
            artifactVersion,
            handoverContractId: createdContract.id,
            manifestHash: expectedManifestDigest,
            sourceDocumentFileId: createdFileObject.id,
            sourceObjectKey: storedArtifact.objectKey,
            sourcePdfHash,
            status: DeliveryHandoverStatus.SOURCE_GENERATED,
            updatedBy: options.actorId ?? null
          },
          where: { id: handoverId }
        });
        if (options.enqueueNextJob !== false) {
          await this.enqueueStage2FieldReady(
            tx,
            workOrder,
            handoverId,
            artifactVersion,
            expectedManifestHash,
            sourcePdfHash
          );
        }
        return { createdContract, createdFileObject };
        });

      return this.toStage2HandoverPdfArtifactView(
        workOrder,
        {
          ...handover,
          artifactVersion,
          handoverContractId: finalized.createdContract.id,
          handoverContract: finalized.createdContract,
          manifestHash: expectedManifestDigest,
          sourceDocumentFileId: finalized.createdFileObject.id,
          sourceObjectKey: storedArtifact.objectKey,
          sourcePdfHash,
          status: DeliveryHandoverStatus.SOURCE_GENERATED
        },
        finalized.createdFileObject
      );
    } catch (error) {
      const authoritative = stored
        ? await this.findStage2HandoverForWorkOrderOrThrow(workOrder)
        : null;
      if (
        error instanceof Stage2SourcePdfClaimLostError &&
        authoritative &&
        stored
      ) {
        const concurrentResult = await this.resolveReusableStage2HandoverPdf(
          workOrder,
          authoritative,
          expectedManifestDigest,
          order.customerId
        );
        if (!concurrentResult) {
          throw new ConflictException(
            "The source PDF was claimed without a valid artifact binding."
          );
        }
        await this.cleanupLosingStage2SourceObject(stored, authoritative);
        if (options.enqueueNextJob !== false) {
          await this.enqueueReadyStage2Pdf(
            workOrder,
            concurrentResult.handover,
            expectedManifestHash,
            options.lease
          );
        }
        return this.toStage2HandoverPdfArtifactView(
          workOrder,
          concurrentResult.handover,
          concurrentResult.fileObject
        );
      }
      if (stored && authoritative) {
        await this.cleanupLosingStage2SourceObject(stored, authoritative);
      }
      throw error;
    } finally {
      if (renderedFile) {
        await Promise.allSettled([renderedFile.cleanup()]);
      }
    }
  }

  async downloadStage2HandoverPdf(id: string): Promise<EvidenceFileStreamResult> {
    const workOrder = await this.getWorkOrderOrThrow(id);
    const handover = await this.findStage2HandoverForWorkOrderOrThrow(workOrder);
    await this.assertGeneratedStage2PdfMatchesCurrentEvidence(workOrder, handover);
    const fileId = readString(handover as unknown as Record<string, unknown>, "sourceDocumentFileId");
    if (!fileId) {
      throw new NotFoundException("车辆交接确认单 PDF 尚未生成。");
    }
    const fileObject = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!fileObject?.bucket || !fileObject.objectKey) {
      throw new NotFoundException("车辆交接确认单 PDF 文件不存在。");
    }
    const downloaded = await this.getStorageService().getObject(fileObject.bucket, fileObject.objectKey);
    return {
      filename: fileObject.originalName ?? "handover.pdf",
      mimeType: downloaded.contentType ?? fileObject.mimeType ?? "application/pdf",
      sizeBytes: toNumberOrNull(fileObject.sizeBytes ?? downloaded.contentLength ?? null),
      stream: downloaded.stream
    };
  }

  async downloadStage2SignedHandoverPdf(
    id: string
  ): Promise<EvidenceFileStreamResult> {
    const workOrder = await this.getWorkOrderOrThrow(id);
    const handover = await this.findStage2HandoverForWorkOrderOrThrow(workOrder);
    const handoverRecord = handover as unknown as Record<string, unknown>;
    const signedDocumentFileId = readString(
      handoverRecord,
      "signedDocumentFileId"
    );
    const signedObjectKey = readString(handoverRecord, "signedObjectKey");
    const signedPdfHash = normalizeStage2Sha256(
      readString(handoverRecord, "signedPdfHash")
    );
    const archiveState: Stage2HandoverArchiveState = {
      archiveStatus: readString(
        handoverRecord,
        "archiveStatus"
      ) as DeliveryHandoverArchiveStatus | null,
      signedDocumentFileId,
      signedObjectKey,
      signedPdfHash,
      status: readString(
        handoverRecord,
        "status"
      ) as DeliveryHandoverStatus | null
    };
    if (!hasCompleteStage2HandoverArchive(archiveState)) {
      throw new ConflictException({
        code: "STAGE2_HANDOVER_SIGNED_DOCUMENT_NOT_ARCHIVED",
        message: "The signed Stage 2 handover PDF has not completed authoritative archive."
      });
    }

    const fileObject = await this.prisma.fileObject.findUnique({
      where: { id: archiveState.signedDocumentFileId }
    });
    if (
      !fileObject?.bucket ||
      fileObject.objectKey !== archiveState.signedObjectKey ||
      fileObject.mimeType !== "application/pdf"
    ) {
      throw new NotFoundException({
        code: "STAGE2_HANDOVER_SIGNED_DOCUMENT_MISSING",
        message: "The archived signed Stage 2 handover PDF is unavailable."
      });
    }

    const downloaded = await this.getStorageService().getObject(
      fileObject.bucket,
      fileObject.objectKey
    );
    return {
      filename: fileObject.originalName ?? "handover-signed.pdf",
      mimeType: fileObject.mimeType,
      sizeBytes: toNumberOrNull(
        fileObject.sizeBytes ?? downloaded.contentLength ?? null
      ),
      stream: downloaded.stream
    };
  }

  private async getValidatedStage2HandoverPdfStream(
    workOrder: WorkOrderRecord
  ): Promise<EvidenceFileStreamResult> {
    const binding = await this.resolveFieldStage2SourceArtifact(workOrder);
    const bucket = readRequiredString(binding.fileObject, "bucket");
    const downloaded = await this.getStorageService().getObject(
      bucket,
      binding.sourceObjectKey
    );
    return {
      filename:
        readString(binding.fileObject, "originalName") ?? "handover.pdf",
      mimeType:
        downloaded.contentType ??
        readString(binding.fileObject, "mimeType") ??
        "application/pdf",
      sizeBytes: toNumberOrNull(
        binding.fileObject.sizeBytes ?? downloaded.contentLength ?? null
      ),
      stream: downloaded.stream
    };
  }

  private async resolveFieldStage2SourceArtifact(
    workOrder: WorkOrderRecord
  ) {
    const handover = await this.findStage2HandoverForWorkOrderOrThrow(
      workOrder
    );
    const currentPackage = await this.buildCurrentEvidencePackage(workOrder);
    const fileId = readString(handover, "sourceDocumentFileId");
    const fileObject = fileId
      ? await this.prisma.fileObject.findUnique({ where: { id: fileId } })
      : null;
    const order = await this.getOrderOrThrow(workOrder.orderId);
    const binding = validateStage2SourceArtifactBinding({
      allowedContractStatuses: [
        ContractStatus.GENERATED,
        ContractStatus.SIGNING
      ],
      allowedHandoverStatuses: [
        DeliveryHandoverStatus.SOURCE_GENERATED,
        DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
      ],
      expectedCustomerId:
        readString(order as unknown as Record<string, unknown>, "customerId"),
      expectedHandoverId: workOrder.handoverId ?? "",
      expectedManifestHash: currentPackage.manifestHash,
      expectedOrderId: workOrder.orderId,
      expectedWorkOrderId: workOrder.id,
      fileObject,
      handover,
      maxSizeBytes: STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
    });
    if (!binding) {
      throw new ConflictException(
        "The current Stage 2 source PDF binding is invalid."
      );
    }
    return binding;
  }

  async assertReadyForStage2Pdf(orderId: string, handoverId?: string | null) {
    await this.assertWorkOrderReadyForStage2(await this.findActiveWorkOrderOrThrow(orderId, handoverId));
  }

  async assertReadyForStage2ESign(
    orderId: string,
    handoverId?: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    await this.assertWorkOrderReadyForStage2(
      await this.findActiveWorkOrderOrThrow(orderId, handoverId, db),
      db
    );
  }

  async assertDeliveryCanBeConfirmed(
    orderId: string,
    handoverId?: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const workOrder = await this.findActiveWorkOrderOrThrow(
      orderId,
      handoverId,
      db
    );
    const confirmedEvidenceManifestHash =
      await this.assertWorkOrderReadyForStage2(workOrder, db) ??
      (
        await this.buildCurrentEvidencePackage(
          workOrder,
          undefined,
          db
        )
      ).manifestHash;
    const confirmedEvidenceManifestDigest = requireSha256Digest(
      confirmedEvidenceManifestHash
    );
    if (this.deliveryHandoverService) {
      await this.deliveryHandoverService.assertDeliveryCanBeConfirmed(
        orderId,
        db,
        confirmedEvidenceManifestDigest
      );
      return;
    }
    const handover = await db.vehicleDeliveryHandover.findFirst({
      where: {
        deletedAt: null,
        id: workOrder.handoverId ?? undefined,
        orderId
      }
    });
    if (
      !handover ||
      !["SIGNED", "ARCHIVED"].includes(handover.status) ||
      handover.manifestHash !== confirmedEvidenceManifestDigest
    ) {
      throw new BadRequestException("交付交接确认书尚未完成签署。");
    }
  }

  private async assertWorkOrderReadyForStage2(
    workOrder: WorkOrderRecord,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new BadRequestException("交付工单已终止。");
    }
    if (getHandoverReviewAdminStatus(workOrder) === ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN) {
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
      toFieldEvidenceState(workOrder),
      db
    );
    if (!this.getReviewAttemptModel(db)) {
      return null;
    }
    const evidencePackage = await this.buildCurrentEvidencePackage(
      workOrder,
      undefined,
      db
    );
    await this.assertEvidencePackageMatchesLatestConfirmation(
      workOrder,
      evidencePackage,
      db
    );
    return evidencePackage.manifestHash;
  }

  private async findActiveWorkOrderOrThrow(
    orderId: string,
    handoverId?: string | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const workOrder = await db.vehicleHandoverWorkOrder.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        ...(handoverId ? { handoverId } : {}),
        orderId,
        status: { notIn: [...TERMINAL_WORK_ORDER_STATUSES] }
      }
    });
    if (!workOrder) {
      const latest = await db.vehicleHandoverWorkOrder.findFirst({
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

  private async assertNoActiveWorkOrder(
    orderId: string,
    handoverType: HandoverType,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const existing = await db.vehicleHandoverWorkOrder.findFirst({
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

  private async getWorkOrderOrThrow(
    id: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const workOrder = await db.vehicleHandoverWorkOrder.findUnique({ where: { id } });
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

  private async getStage2PdfOrderOrThrow(orderId: string) {
    const order = await this.prisma.subscriptionOrder.findUnique({
      include: {
        customer: {
          include: {
            identity: true,
            profile: true
          }
        },
        vehicle: true
      },
      where: { id: orderId }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException("订单不存在。");
    }
    return order;
  }

  private async findActiveStage2HandoverTemplate() {
    const now = new Date();
    return this.prisma.contractVersion.findFirst({
      orderBy: { effectiveFrom: "desc" },
      where: {
        businessType: BusinessType.SUBSCRIPTION,
        deletedAt: null,
        effectiveFrom: { lte: now },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: now } }
        ],
        status: ContractVersionStatus.ACTIVE,
        templateType: ContractTemplateType.DELIVERY_HANDOVER
      }
    });
  }

  private async findStage2HandoverTemplateById(id: string) {
    return this.prisma.contractVersion.findFirst({
      where: {
        businessType: BusinessType.SUBSCRIPTION,
        deletedAt: null,
        id,
        templateType: ContractTemplateType.DELIVERY_HANDOVER
      }
    });
  }

  private async reserveStage2SourcePdf(
    workOrder: WorkOrderRecord,
    handoverId: string,
    manifestHash: string,
    artifactVersion: number,
    contractId: string,
    activeTemplateId: string | null,
    lease?: Stage2HandoverPdfLease
  ): Promise<Stage2SourcePdfReservation> {
    return this.runSerializableTransaction(async (tx) => {
      await this.assertStage2PdfLease(tx, lease);
      const handover = await this.lockStage2HandoverForSourcePdf(
        tx,
        handoverId
      );
      if (hasStage2SourceArtifactState(handover)) {
        throw new Stage2SourcePdfClaimLostError();
      }

      const metadata = asRecord(handover.metadata) ?? {};
      const existing = readStage2SourcePdfReservation(
        metadata.stage2SourcePdfReservation
      );
      if (existing) {
        if (
          existing.artifactVersion !== artifactVersion ||
          existing.contractId !== contractId ||
          existing.manifestHash !== manifestHash
        ) {
          throw new ConflictException(
            "The reserved Stage 2 source PDF identity is invalid."
          );
        }
        return existing;
      }

      const legacyContract = await tx.contract.findUnique({
        where: { id: contractId }
      });
      let contractNo: string;
      let generatedAt: Date;
      let templateId: string;
      if (legacyContract) {
        if (
          legacyContract.deletedAt ||
          legacyContract.fileId ||
          legacyContract.orderId !== workOrder.orderId ||
          legacyContract.status !== ContractStatus.CANCELLED
        ) {
          throw new ConflictException(
            "The legacy Stage 2 source Contract reservation is invalid."
          );
        }
        contractNo = legacyContract.contractNo;
        generatedAt = legacyContract.createdAt;
        templateId = legacyContract.contractVersionId;
        await tx.contract.delete({ where: { id: legacyContract.id } });
      } else {
        if (!activeTemplateId) {
          throw new BadRequestException("未找到生效中的车辆交接确认单模板。");
        }
        generatedAt = await readStage2DatabaseNow(tx);
        contractNo = createReservedStage2ContractNo(contractId);
        templateId = activeTemplateId;
      }

      const reservation: Stage2SourcePdfReservation = {
        artifactVersion,
        contractId,
        contractNo,
        generatedAt,
        manifestHash,
        templateId
      };
      await tx.vehicleDeliveryHandover.update({
        data: {
          metadata: toJsonValue({
            ...metadata,
            stage2SourcePdfReservation: {
              ...reservation,
              generatedAt: reservation.generatedAt.toISOString()
            }
          })
        },
        where: { id: handoverId }
      });
      return reservation;
    });
  }

  private async lockStage2HandoverForSourcePdf(
    tx: Prisma.TransactionClient,
    handoverId: string
  ) {
    const [handover] = await tx.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`
        SELECT
          "id",
          "order_id" AS "orderId",
          "handover_contract_id" AS "handoverContractId",
          "handover_esign_task_id" AS "handoverESignTaskId",
          "source_document_file_id" AS "sourceDocumentFileId",
          "source_object_key" AS "sourceObjectKey",
          "source_pdf_hash" AS "sourcePdfHash",
          "manifest_hash" AS "manifestHash",
          "artifact_version" AS "artifactVersion",
          "status",
          "metadata"
        FROM "vehicle_delivery_handover"
        WHERE "id" = ${handoverId}::uuid
          AND "deleted_at" IS NULL
        FOR UPDATE
      `
    );
    if (!handover) {
      throw new BadRequestException("车辆交接记录尚未创建或已终止。");
    }
    return handover;
  }

  private async cleanupLosingStage2SourceObject(
    stored: Awaited<
      ReturnType<StorageService["putGeneratedContractPdfArtifactFromPath"]>
    >,
    authoritative: Record<string, unknown>
  ) {
    const winnerKey = readString(authoritative, "sourceObjectKey");
    if (
      readString(authoritative, "status") !==
        DeliveryHandoverStatus.SOURCE_GENERATED ||
      !winnerKey ||
      winnerKey === stored.objectKey
    ) {
      return;
    }
    const references = await this.prisma.fileObject.count({
      where: {
        bucket: stored.bucket,
        objectKey: stored.objectKey
      }
    });
    if (references > 0) {
      return;
    }
    await Promise.allSettled([
      this.getStorageService().deleteObject(stored.bucket, stored.objectKey)
    ]);
  }

  private async findStage2HandoverForWorkOrder(
    workOrder: WorkOrderRecord,
    options: { includeHandoverContract?: boolean } = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const handoverModel = (db as unknown as {
      vehicleDeliveryHandover?: {
        findFirst: (args: Prisma.VehicleDeliveryHandoverFindFirstArgs) => Promise<null | Record<string, unknown>>;
      };
    }).vehicleDeliveryHandover;
    if (!handoverModel) {
      return null;
    }
    const args: Prisma.VehicleDeliveryHandoverFindFirstArgs = {
      where: {
        deletedAt: null,
        ...(workOrder.handoverId ? { id: workOrder.handoverId } : {}),
        orderId: workOrder.orderId,
        status: {
          notIn: [DeliveryHandoverStatus.FAILED, DeliveryHandoverStatus.CANCELLED]
        }
      }
    };
    if (options.includeHandoverContract) {
      args.include = {
        handoverContract: true,
        stage1Contract: true
      };
    }
    return handoverModel.findFirst(args);
  }

  private async findStage2HandoverForWorkOrderOrThrow(
    workOrder: WorkOrderRecord,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const handover = await this.findStage2HandoverForWorkOrder(
      workOrder,
      { includeHandoverContract: true },
      db
    );
    if (!handover) {
      throw new BadRequestException("车辆交接记录尚未创建或已终止。");
    }
    return handover;
  }

  private assertStage2HandoverPdfGenerationPrerequisites(handover: unknown) {
    const record = asRecord(handover);
    if (!record) {
      throw new BadRequestException("车辆交接记录尚未创建。");
    }
    const stage1Contract = asRecord(record.stage1Contract);
    const stage1ContractStatus = stage1Contract
      ? readString(stage1Contract, "status")
      : null;
    if (
      !stage1Contract ||
      (stage1ContractStatus !== ContractStatus.SIGNED &&
        stage1ContractStatus !== ContractStatus.ARCHIVED)
    ) {
      throw new BadRequestException("Stage 1 合同尚未完成签署，不能生成车辆交接确认单 PDF。");
    }
  }

  private async resolveReusableStage2HandoverPdf(
    workOrder: WorkOrderRecord,
    handover: Record<string, unknown>,
    expectedManifestDigest: string,
    expectedCustomerId: string
  ) {
    if (!hasStage2SourceArtifactState(handover)) {
      return null;
    }

    const fileId = readString(handover, "sourceDocumentFileId");
    const fileObject = fileId
      ? await this.prisma.fileObject.findUnique({ where: { id: fileId } })
      : null;
    const historicalBinding = validateStage2SourceArtifactBinding({
      expectedCustomerId,
      expectedHandoverId: workOrder.handoverId ?? "",
      expectedManifestHash: expectedManifestDigest,
      expectedOrderId: workOrder.orderId,
      expectedWorkOrderId: workOrder.id,
      fileObject,
      handover,
      maxSizeBytes: STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
    });
    if (!historicalBinding) {
      throw new ConflictException(
        "The persisted Stage 2 source PDF artifact binding is invalid."
      );
    }
    const binding = validateStage2SourceArtifactBinding({
      expectedArtifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
      expectedCustomerId,
      expectedHandoverId: workOrder.handoverId ?? "",
      expectedManifestHash: expectedManifestDigest,
      expectedOrderId: workOrder.orderId,
      expectedRendererVersion: STAGE2_HANDOVER_PDF_RENDERER_VERSION,
      expectedWorkOrderId: workOrder.id,
      fileObject,
      handover,
      maxSizeBytes: STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
    });
    if (!binding) {
      if (
        historicalBinding.artifactVersion >
          STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION ||
        (
          historicalBinding.rendererVersion !== null &&
          historicalBinding.rendererVersion >
            STAGE2_HANDOVER_PDF_RENDERER_VERSION
        )
      ) {
        throw new ConflictException(
          "The persisted Stage 2 source PDF uses a newer renderer."
        );
      }
      await this.supersedeLegacyUnsignedStage2Source(
        workOrder,
        handover,
        historicalBinding
      );
      return null;
    }

    const downloaded = await this.getStorageService().getObject(
      readString(binding.fileObject, "bucket")!,
      binding.sourceObjectKey
    );
    if (
      downloaded.contentType &&
      downloaded.contentType.trim().toLowerCase() !== "application/pdf"
    ) {
      throw new ConflictException(
        "The persisted Stage 2 source PDF storage binding is invalid."
      );
    }
    if (
      downloaded.contentLength !== undefined &&
      downloaded.contentLength !== toNumberOrNull(binding.fileObject.sizeBytes)
    ) {
      throw new ConflictException(
        "The persisted Stage 2 source PDF storage size is invalid."
      );
    }
    const storedSource = await calculateReadableSha256(
      downloaded.stream,
      STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
    );
    if (
      storedSource.sizeBytes !== toNumberOrNull(binding.fileObject.sizeBytes) ||
      storedSource.sha256 !== binding.sourcePdfHash
    ) {
      throw new ConflictException(
        "The persisted Stage 2 source PDF SHA-256 is invalid."
      );
    }
    return {
      fileObject: binding.fileObject,
      handover
    };
  }

  private async supersedeLegacyUnsignedStage2Source(
    workOrder: WorkOrderRecord,
    handover: Record<string, unknown>,
    binding: NonNullable<
      ReturnType<typeof validateStage2SourceArtifactBinding>
    >
  ) {
    await this.runSerializableTransaction(async (tx) => {
      const locked = await this.lockStage2HandoverForSourcePdf(
        tx,
        readRequiredString(handover, "id")
      );
      if (
        !sameStage2SourceBinding(locked, handover) ||
        readString(locked, "handoverESignTaskId") ||
        readString(locked, "status") !==
          DeliveryHandoverStatus.SOURCE_GENERATED
      ) {
        throw new ConflictException(
          "The legacy Stage 2 source PDF has already entered signing."
        );
      }
      const contract = await tx.contract.findUnique({
        where: { id: readRequiredString(locked, "handoverContractId") }
      });
      if (
        !contract ||
        contract.deletedAt ||
        contract.orderId !== workOrder.orderId ||
        contract.fileId !== binding.fileObject.id ||
        contract.status !== ContractStatus.GENERATED
      ) {
        throw new ConflictException(
          "The legacy Stage 2 source Contract cannot be superseded."
        );
      }
      await tx.contract.update({
        data: {
          status: ContractStatus.CANCELLED
        },
        where: { id: contract.id }
      });
      const metadata = asRecord(locked.metadata) ?? {};
      await tx.vehicleDeliveryHandover.update({
        data: {
          artifactVersion: STAGE2_HANDOVER_SOURCE_ARTIFACT_VERSION,
          handoverContractId: null,
          manifestHash: null,
          metadata: toJsonValue({
            ...metadata,
            stage2SourcePdfReservation: null,
            stage2SupersededSource: {
              artifactVersion: binding.artifactVersion,
              contractId: contract.id,
              fileId: binding.fileObject.id,
              rendererVersion: binding.rendererVersion
            }
          }),
          sourceDocumentFileId: null,
          sourceObjectKey: null,
          sourcePdfHash: null,
          status: DeliveryHandoverStatus.DRAFT
        },
        where: { id: readRequiredString(locked, "id") }
      });
    });
  }

  private async enqueueReadyStage2Pdf(
    workOrder: WorkOrderRecord,
    expectedHandover: Record<string, unknown>,
    manifestHash: string,
    lease?: Stage2HandoverPdfLease
  ) {
    await this.runSerializableTransaction(async (tx) => {
      await this.assertStage2PdfLease(tx, lease);
      const authoritative = await this.findStage2HandoverForWorkOrderOrThrow(
        workOrder,
        tx
      );
      if (!sameStage2SourceBinding(authoritative, expectedHandover)) {
        throw new ConflictException(
          "The Stage 2 source PDF binding changed before notification enqueue."
        );
      }
      await this.enqueueStage2FieldReady(
        tx,
        workOrder,
        readRequiredString(authoritative, "id"),
        readRequiredPositiveInteger(authoritative, "artifactVersion"),
        manifestHash,
        requireSha256Digest(readRequiredString(authoritative, "sourcePdfHash"))
      );
    });
  }

  private async enqueueStage2FieldReady(
    tx: Prisma.TransactionClient,
    workOrder: WorkOrderRecord,
    handoverId: string,
    artifactVersion: number,
    manifestHash: string,
    sourcePdfHash: string
  ) {
    if (!this.workflowRepository) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_REPOSITORY_UNAVAILABLE");
    }
    await this.workflowRepository.enqueue(tx, {
      handoverId,
      idempotencyKey: `field-notify:${workOrder.id}:${artifactVersion}`,
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
      payload: {
        artifactVersion,
        manifestHash,
        sourcePdfHash
      },
      workOrderId: workOrder.id
    });
  }

  private async assertStage2PdfLease(
    tx: Prisma.TransactionClient,
    lease?: Stage2HandoverPdfLease
  ) {
    if (!lease) {
      return;
    }
    if (!this.workflowRepository) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_REPOSITORY_UNAVAILABLE");
    }
    const renewed = await this.workflowRepository.renewLease(
      lease.jobId,
      lease.leaseToken,
      lease.leaseMs,
      tx
    );
    if (!renewed) {
      throw new Error("STAGE2_HANDOVER_WORKFLOW_LEASE_LOST");
    }
  }

  private async assertGeneratedStage2PdfMatchesCurrentEvidence(
    workOrder: WorkOrderRecord,
    handover: Record<string, unknown>
  ) {
    const contract = asRecord(handover.handoverContract);
    const contractSnapshot = asRecord(contract?.contractSnapshot);
    const evidencePackageSnapshot = asRecord(contractSnapshot?.evidencePackage);
    const generatedManifestHash = evidencePackageSnapshot
      ? readString(evidencePackageSnapshot, "manifestHash")
      : null;
    const currentPackage = await this.buildCurrentEvidencePackage(workOrder);
    if (!generatedManifestHash || generatedManifestHash !== currentPackage.manifestHash) {
      throw new ConflictException(
        "车辆交接确认单源 PDF 已因证据变化失效，必须重新确认全部资料并生成新版本。"
      );
    }
  }

  private buildStage2HandoverPdfRenderModelInput(input: {
    createdContract: Record<string, unknown>;
    evidenceChecklist: unknown;
    evidencePackage: DeliveryHandoverEvidencePackage;
    handover: unknown;
    order: unknown;
    template: unknown;
    workOrder: WorkOrderRecord;
  }): DeliveryHandoverPdfRenderModelInput {
    const handover = asRecord(input.handover);
    const stage1Contract = asRecord(handover?.stage1Contract);
    return {
      documentNo: readString(input.createdContract, "contractNo") ?? "",
      evidenceChecklist: input.evidenceChecklist,
      evidencePackage: input.evidencePackage,
      generatedAt: toDateOrNull(readUnknown(input.createdContract, "createdAt")),
      handover: {
        ...(handover ?? {}),
        stage1ContractNo: stage1Contract ? readString(stage1Contract, "contractNo") : null,
        stage1SignedAt: stage1Contract ? readUnknown(stage1Contract, "signedAt") : null
      },
      order: input.order,
      platform: {
        legalName:
          this.configService?.get<string>("STAGE2_HANDOVER_PLATFORM_LEGAL_NAME") ??
          this.configService?.get<string>("PLATFORM_LEGAL_NAME") ??
          null
      },
      template: input.template,
      workOrder: input.workOrder
    };
  }

  private async toStage2HandoverPdfArtifactView(
    workOrder: WorkOrderRecord,
    handover: null | Record<string, unknown>,
    fileObject?: null | Record<string, unknown>
  ): Promise<Stage2HandoverPdfArtifactView> {
    const order = await this.getOrderOrThrow(workOrder.orderId);
    const sourceDocumentFileId = handover ? readString(handover, "sourceDocumentFileId") : null;
    if (!handover || !sourceDocumentFileId) {
      return {
        archiveStatus: null,
        artifactId: null,
        artifactVersion: null,
        documentNo: null,
        downloadUrl: null,
        fileName: null,
        fileSize: null,
        generatedAt: null,
        handoverStatus: null,
        orderNo: order.orderNo,
        previewUrl: null,
        signedArtifactAvailable: false,
        sourcePdfHash: null,
        status: "NOT_GENERATED",
        workOrderId: workOrder.id
      };
    }

    const resolvedFileObject =
      fileObject ?? await this.prisma.fileObject.findUnique({ where: { id: sourceDocumentFileId } });
    const handoverContract = asRecord(handover.handoverContract);
    const fileRecord = asRecord(resolvedFileObject);

    return {
      archiveStatus: readString(handover, "archiveStatus"),
      artifactId: sourceDocumentFileId,
      artifactVersion: readPositiveInteger(handover, "artifactVersion"),
      documentNo: handoverContract ? readString(handoverContract, "contractNo") : null,
      downloadUrl: `/api/handover-work-orders/${encodeURIComponent(workOrder.id)}/pdf/download`,
      fileName: fileRecord ? readString(fileRecord, "originalName") ?? "handover.pdf" : "handover.pdf",
      fileSize: toNumberOrNull(fileRecord?.sizeBytes ?? null),
      generatedAt:
        toDateOrNull(fileRecord?.createdAt) ??
        toDateOrNull(handoverContract ? readUnknown(handoverContract, "createdAt") : null) ??
        null,
      handoverStatus: readString(handover, "status"),
      orderNo: order.orderNo,
      previewUrl: null,
      signedArtifactAvailable: hasCompleteStage2HandoverArchive({
        archiveStatus: readString(
          handover,
          "archiveStatus"
        ) as DeliveryHandoverArchiveStatus | null,
        signedDocumentFileId: readString(
          handover,
          "signedDocumentFileId"
        ),
        signedObjectKey: readString(handover, "signedObjectKey"),
        signedPdfHash: normalizeStage2Sha256(
          readString(handover, "signedPdfHash")
        ),
        status: readString(
          handover,
          "status"
        ) as DeliveryHandoverStatus | null
      }),
      sourcePdfHash: normalizeStage2Sha256(
        readString(handover, "sourcePdfHash")
      ),
      status: "GENERATED",
      workOrderId: workOrder.id
    };
  }

  private getHandoverPdfRenderer() {
    if (!this.handoverPdfRenderer) {
      throw new BadRequestException("车辆交接确认单 PDF 渲染服务未配置。");
    }
    return this.handoverPdfRenderer;
  }

  private buildStage2EvidencePackageUrl(workOrderId: string) {
    const configured = this.configService?.get<string>(STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL_ENV)?.trim();
    if (!configured) {
      throw new BadRequestException(
        `${STAGE2_HANDOVER_PUBLIC_WEB_BASE_URL_ENV} 未配置，无法生成稳定的证据包查阅地址。`
      );
    }
    return `${configured.replace(/\/+$/, "")}/portal/handover-reviews/${encodeURIComponent(workOrderId)}`;
  }

  private async buildStage2EvidenceAssetLoader(evidencePackage: DeliveryHandoverEvidencePackage) {
    const derivativeIds = Array.from(new Set(
      evidencePackage.manifest.files.flatMap((file) => file.derivativeFileIds)
    ));
    const allowedIds = new Set(derivativeIds);
    const fileObjects = await this.prisma.fileObject.findMany({
      where: { id: { in: derivativeIds } }
    });
    const fileObjectsById = new Map(fileObjects.map((fileObject) => [fileObject.id, fileObject]));
    const missingIds = derivativeIds.filter((fileId) => !fileObjectsById.has(fileId));
    if (missingIds.length > 0) {
      throw new BadRequestException(`交接证据衍生文件缺失：${missingIds.join(", ")}`);
    }
    const derivativeBytes = fileObjects.reduce(
      (total, fileObject) => total + (toNumberOrNull(fileObject.sizeBytes) ?? 0),
      0
    );
    const targetMediaBudget = STAGE2_HANDOVER_PDF_TARGET_BYTES - 1024 * 1024;
    if (derivativeBytes > targetMediaBudget) {
      throw new BadRequestException(
        "交接证据展示文件预计会使 PDF 超过 15 MiB 目标，请先按较低质量档位重新处理。"
      );
    }

    return async (fileId: string) => {
      if (!allowedIds.has(fileId)) {
        throw new BadRequestException("PDF 渲染仅允许读取当前证据包中的衍生文件。");
      }
      const fileObject = fileObjectsById.get(fileId);
      if (!fileObject?.bucket || !fileObject.objectKey) {
        throw new BadRequestException(`交接证据衍生文件不可用：${fileId}`);
      }
      if (fileObject.mimeType !== "image/jpeg") {
        throw new BadRequestException(`交接证据衍生文件格式无效：${fileId}`);
      }
      const downloaded = await this.getStorageService().getObject(fileObject.bucket, fileObject.objectKey);
      return readStreamToBoundedBuffer(
        downloaded.stream,
        MAX_STAGE2_EVIDENCE_DERIVATIVE_BYTES,
        `交接证据衍生文件超出大小限制：${fileId}`
      );
    };
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
        lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE,
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

  private async findScopedActiveEvidenceFile(workOrder: WorkOrderRecord, evidenceFileId: string) {
    const evidenceFile = await this.prisma.vehicleDeliveryEvidenceFile.findFirst({
      include: {
        evidenceItem: true,
        file: true
      },
      where: {
        id: evidenceFileId,
        lifecycleStatus: DeliveryEvidenceFileLifecycleStatus.ACTIVE,
        evidenceItem: {
          orderId: workOrder.orderId,
          ...(workOrder.handoverId
            ? { OR: [{ handoverId: null }, { handoverId: workOrder.handoverId }] }
            : {})
        }
      }
    });
    if (!evidenceFile?.file?.bucket || !evidenceFile.file.objectKey) {
      throw new NotFoundException("交接资料文件不存在。");
    }
    return evidenceFile;
  }

  private assertEvidenceArtifactRepairAllowed(workOrder: WorkOrderRecord) {
    if (workOrder.customerConfirmedAt || isReadyForStage2Status(workOrder.status)) {
      throw new BadRequestException("客户确认后不能重新处理证据，必须先发起新的复核版本。");
    }
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new BadRequestException("已终止的交接工单不能重新处理证据。");
    }
  }

  private async hasReadyEvidenceArtifacts(
    evidenceFile: {
      evidenceItem: { evidenceType: unknown };
      mediaType: unknown;
      metadata: unknown;
    },
    db: Pick<PrismaService, "fileObject">
  ) {
    if (!isEvidenceArtifactMetadataReady(
      evidenceFile.metadata,
      String(evidenceFile.mediaType),
      String(evidenceFile.evidenceItem.evidenceType)
    )) {
      return false;
    }
    const derivativeFileIds = getEvidenceArtifactDerivativeFileIds(
      evidenceFile.metadata,
      String(evidenceFile.mediaType)
    );
    const existingCount = await db.fileObject.count({
      where: { id: { in: derivativeFileIds } }
    });
    return existingCount === derivativeFileIds.length;
  }

  private async deleteStoredObjectsWithRetry(
    storedObjects: Array<{ bucket: string; objectKey: string }>
  ) {
    for (const storedObject of storedObjects) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await this.getStorageService().deleteObject(storedObject.bucket, storedObject.objectKey);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) {
        this.logger.error(
          `Failed to delete rolled-back storage object ${storedObject.bucket}/${storedObject.objectKey}`,
          lastError instanceof Error ? lastError.stack : String(lastError)
        );
      }
    }
  }

  private async toAdminWorkOrderSummary(workOrder: WorkOrderRecord) {
    const [
      order,
      evidenceChecklist,
      reviewAttempts,
      events,
      readiness,
      stage2Pdf,
      workflowJobs,
      fieldReceipt
    ] = await Promise.all([
        this.getOrderOrThrow(workOrder.orderId),
        this.deliveryEvidenceService.getChecklist({
          handoverId: workOrder.handoverId ?? null,
          orderId: workOrder.orderId
        }),
        this.listReviewAttempts(workOrder.id),
        this.listEvents(workOrder.id),
        this.getReadiness(workOrder.id),
        this.getStage2HandoverPdf(workOrder.id),
        this.listSafeStage2WorkflowJobs(workOrder.id),
        this.getFieldTaskReceipt(workOrder)
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
      events: events.map(toSafeHandoverEvent),
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      fieldReceipt,
      fieldSubmittedAt: workOrder.fieldSubmittedAt,
      handoverId: workOrder.handoverId,
      handoverType: workOrder.handoverType,
      id: workOrder.id,
      objection: toObjectionView(workOrder),
      operator: {
        name: workOrder.fieldOperatorName ?? workOrder.externalOperatorName ?? null,
        phone: workOrder.fieldOperatorPhone ?? workOrder.externalOperatorPhone ?? null,
        phoneMasked: maskPhone(workOrder.fieldOperatorPhone ?? workOrder.externalOperatorPhone),
        type: workOrder.operatorType ?? null
      },
      orderId: workOrder.orderId,
      orderNo: order.orderNo,
      readiness,
      reviewAttempts: reviewAttempts.map(toSafeReviewAttempt),
      reviewVersion: workOrder.reviewVersion ?? 0,
      scheduledAt: workOrder.scheduledAt,
      stage2Pdf,
      status: workOrder.status,
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      },
      workflowJobs
    };
  }

  private async getFieldTaskReceipt(workOrder: WorkOrderRecord) {
    let firstOpenedAt = workOrder.firstAccessedAt ?? null;
    let lastOpenedAt = workOrder.lastAccessedAt ?? null;
    if (!firstOpenedAt || !lastOpenedAt) {
      const historicalViews = await this.prisma.fieldOperatorAuditLog.aggregate({
        _max: { createdAt: true },
        _min: { createdAt: true },
        where: {
          eventType: FieldOperatorAuditEventType.TASK_VIEWED,
          workOrderId: workOrder.id
        }
      });
      firstOpenedAt ??= historicalViews._min.createdAt;
      lastOpenedAt ??= historicalViews._max.createdAt;
    }
    return {
      firstOpenedAt,
      lastOpenedAt,
      status: firstOpenedAt ? "OPENED" as const : "NOT_OPENED" as const
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

  private getReviewAttemptModel(db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return (db as unknown as {
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

  private async findLatestReviewAttempt(
    workOrderId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const model = this.getReviewAttemptModel(db);
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
    data: Record<string, unknown> = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const model = this.getReviewAttemptModel(db);
    if (!model) {
      return null;
    }
    const latest = await this.findLatestReviewAttempt(workOrder.id, db);
    return model.create({
      data: compactUndefined({
        ...(await this.buildReviewAttemptSnapshot(workOrder, db)),
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
    data: Record<string, unknown> = {},
    options: { refreshSnapshot?: boolean; snapshot?: Record<string, unknown> } = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const model = this.getReviewAttemptModel(db);
    if (!model) {
      return null;
    }
    const latest = await this.findLatestReviewAttempt(workOrder.id, db);
    if (!latest) {
      return this.createReviewAttempt(workOrder, status, {
        ...(options.snapshot ?? {}),
        ...data
      }, db);
    }
    return model.update({
      data: compactUndefined({
        ...(
          "snapshot" in options && options.snapshot
            ? options.snapshot
            : options.refreshSnapshot
              ? await this.buildReviewAttemptSnapshot(workOrder, db)
              : {}
        ),
        ...data,
        status
      }),
      where: { id: String(latest.id) }
    });
  }

  private async buildCurrentEvidencePackage(
    workOrder: WorkOrderRecord,
    evidenceChecklist?: unknown,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ): Promise<DeliveryHandoverEvidencePackage> {
    const checklist = evidenceChecklist ?? await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    }, db);
    if (!workOrder.handoverId) {
      throw new BadRequestException("交接工单尚未关联车辆交接记录。");
    }
    return buildDeliveryHandoverEvidencePackage({
      evidenceChecklist: checklist,
      handoverId: workOrder.handoverId,
      orderId: workOrder.orderId,
      workOrderId: workOrder.id
    });
  }

  private async buildReviewAttemptSnapshot(
    workOrder: WorkOrderRecord,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    suppliedEvidenceChecklist?: unknown,
    suppliedEvidencePackage?: DeliveryHandoverEvidencePackage
  ) {
    const evidenceChecklist = suppliedEvidenceChecklist ?? await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    }, db);
    const evidencePackage = suppliedEvidencePackage ??
      await this.buildCurrentEvidencePackage(workOrder, evidenceChecklist, db);
    return {
      customerConfirmedAt: workOrder.customerConfirmedAt ?? null,
      customerObjectedAt: workOrder.customerObjectedAt ?? null,
      customerObjectionDetails: readMetadataString(workOrder.metadata, "customerObjectionDetails"),
      customerObjectionReason: workOrder.customerObjectionReason ?? null,
      customerReviewStartedAt: workOrder.customerReviewStartedAt ?? null,
      evidenceSnapshot: toJsonValue({
        ...toSafeEvidenceChecklist(evidenceChecklist),
        evidencePackage: {
          manifest: evidencePackage.manifest,
          manifestHash: evidencePackage.manifestHash,
          stats: evidencePackage.stats
        }
      }),
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
        adminStatus: getHandoverReviewAdminStatus(workOrder),
        sourceWorkOrderStatus: workOrder.status
      })
    };
  }

  private async assertEvidencePackageMatchesLatestConfirmation(
    workOrder: WorkOrderRecord,
    evidencePackage: DeliveryHandoverEvidencePackage,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    if (!this.getReviewAttemptModel(db)) {
      return;
    }
    const latestAttempt = await this.findLatestReviewAttempt(workOrder.id, db);
    const confirmedManifestHash = readEvidencePackageManifestHash(
      readUnknownRecordValue(latestAttempt, "evidenceSnapshot")
    );
    if (
      !latestAttempt ||
      readString(latestAttempt, "status") !== "CUSTOMER_CONFIRMED" ||
      confirmedManifestHash !== evidencePackage.manifestHash
    ) {
      throw new BadRequestException("客户确认未绑定当前交接证据，请重新查看并确认全部资料。");
    }
  }

  private async buildResubmissionChangeSummary(
    workOrder: WorkOrderRecord,
    latestAttempt: null | Record<string, unknown>
  ) {
    if (!latestAttempt) {
      throw new BadRequestException("未找到本次客户复核记录，请后台重新发起复检。");
    }
    const attemptMetadata = asRecord(readUnknownRecordValue(latestAttempt, "metadata"));
    const baseline = asRecord(attemptMetadata?.resubmissionBaseline);
    const baselineEvidenceSnapshot = baseline?.evidenceSnapshot ?? latestAttempt.evidenceSnapshot ?? null;
    const baselineFieldFactsSnapshot = baseline?.fieldFactsSnapshot ?? latestAttempt.fieldFactsSnapshot ?? null;
    const requestedEvidenceItemIds = readStringArray(attemptMetadata, "resubmissionRequestedEvidenceItemIds");
    const requestedFieldKeys = readStringArray(attemptMetadata, "resubmissionRequestedFieldKeys")
      .filter(isHandoverFieldFactKey);
    const current = await this.buildReviewAttemptSnapshot(workOrder);
    const baselineEvidence = evidenceItemFingerprintMap(baselineEvidenceSnapshot);
    const currentEvidence = evidenceItemFingerprintMap(current.evidenceSnapshot);
    const evidenceScope = requestedEvidenceItemIds.length > 0
      ? requestedEvidenceItemIds
      : Array.from(new Set([...baselineEvidence.keys(), ...currentEvidence.keys()]));
    const changedEvidenceItemIds = evidenceScope.filter(
      (itemId) => baselineEvidence.get(itemId) !== currentEvidence.get(itemId)
    );
    const baselineFacts = asRecord(baselineFieldFactsSnapshot) ?? {};
    const currentFacts = asRecord(current.fieldFactsSnapshot) ?? {};
    const fieldScope = requestedFieldKeys.length > 0 ? requestedFieldKeys : [...HANDOVER_FIELD_FACT_KEYS];
    const changedFieldKeys = fieldScope.filter(
      (key) => stableSerialize(baselineFacts[key]) !== stableSerialize(currentFacts[key])
    );

    return {
      changed: changedEvidenceItemIds.length > 0 || changedFieldKeys.length > 0,
      changedEvidenceItemIds,
      changedFieldKeys,
      currentEvidenceSnapshot: current.evidenceSnapshot,
      currentFieldFactsSnapshot: current.fieldFactsSnapshot
    };
  }

  private async assertEvidenceItemTargetsBelongToWorkOrder(
    workOrder: WorkOrderRecord,
    targetEvidenceItemIds: string[]
  ) {
    if (targetEvidenceItemIds.length === 0) {
      return;
    }
    const checklist = await this.deliveryEvidenceService.getChecklist({
      handoverId: workOrder.handoverId ?? null,
      orderId: workOrder.orderId
    });
    const validIds = new Set(getChecklistItems(checklist).map((item) => readString(item, "id")).filter(Boolean));
    if (targetEvidenceItemIds.some((itemId) => !validIds.has(itemId))) {
      throw new BadRequestException("复检资料项不属于当前交接工单。");
    }
  }

  private getEventModel(db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return (db as unknown as {
      vehicleHandoverEvent?: {
        create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
        findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      };
    }).vehicleHandoverEvent;
  }

  private async recordEvent(
    workOrder: WorkOrderRecord,
    eventType: VehicleHandoverEventType,
    input: {
      actorId?: string | null;
      actorDisplay?: string | null;
      actorType: VehicleHandoverEventActorType;
      detail?: Record<string, unknown>;
      reviewAttemptId?: string | null;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const model = this.getEventModel(db);
    if (!model) {
      return null;
    }
    return model.create({
      data: compactUndefined({
        actorDisplay: normalizeOptionalText(input.actorDisplay),
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        detail: input.detail ? toJsonValue(input.detail) : undefined,
        eventType,
        orderId: workOrder.orderId,
        reviewAttemptId: input.reviewAttemptId ?? null,
        workOrderId: workOrder.id
      })
    });
  }

  private async listEvents(workOrderId: string) {
    const model = this.getEventModel();
    if (!model) {
      return [];
    }
    return model.findMany({
      orderBy: { createdAt: "asc" },
      where: { workOrderId }
    });
  }

  private async getAssignableInternalUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      select: {
        mobile: true,
        name: true
      },
      where: {
        deletedAt: null,
        id: userId,
        status: UserStatus.ACTIVE
      }
    });
    if (!user) {
      throw new NotFoundException("内部交付员不存在。");
    }
    return {
      name: normalizeRequiredText(user.name, "内部交付员姓名无效。"),
      phone: normalizeFieldOperatorPhone(user.mobile ?? "")
    };
  }

  private async assertAssignmentMutable(workOrder: WorkOrderRecord) {
    this.assertMutable(workOrder);
    const currentAttempt = await this.findLatestReviewAttempt(workOrder.id);
    if (
      workOrder.customerReviewStartedAt ||
      (currentAttempt && readUnknown(currentAttempt, "customerReviewStartedAt"))
    ) {
      throw new BadRequestException("Field operator assignment is frozen after customer review starts.");
    }
  }

  private assertMutable(workOrder: WorkOrderRecord) {
    if (isTerminalWorkOrderStatus(workOrder.status)) {
      throw new BadRequestException("交付工单已终止。");
    }
  }

  private async getFieldAccessibleWorkOrderRecord(id: string, phone: string) {
    const normalizedPhone = normalizeFieldOperatorPhone(phone);
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      where: {
        fieldOperatorPhone: normalizedPhone,
        id
      }
    });

    if (
      !workOrder ||
      !isFieldAccessibleWorkOrder(workOrder, normalizedPhone) ||
      !await this.hasCurrentFieldOperatorAssignment(
        workOrder,
        normalizedPhone
      )
    ) {
      throw new UnauthorizedException("No access to this field handover work order.");
    }

    return workOrder;
  }

  private async hasCurrentFieldOperatorAssignment(
    workOrder: WorkOrderRecord,
    normalizedPhone: string
  ) {
    if (workOrder.operatorType === "EXTERNAL") {
      return true;
    }
    if (
      workOrder.operatorType !== "INTERNAL" ||
      !workOrder.assignedInternalUserId
    ) {
      return false;
    }
    const user = await this.prisma.user.findFirst({
      select: {
        mobile: true,
        status: true
      },
      where: {
        deletedAt: null,
        id: workOrder.assignedInternalUserId,
        status: UserStatus.ACTIVE
      }
    });
    return Boolean(
      user &&
      user.status === UserStatus.ACTIVE &&
      user.mobile &&
      normalizeFieldOperatorPhone(user.mobile) === normalizedPhone
    );
  }

  private getStorageService() {
    if (!this.storageService) {
      throw new BadRequestException("现场证据上传存储服务未配置。");
    }
    return this.storageService;
  }

  private getEvidenceArtifactService() {
    if (!this.evidenceArtifactService) {
      throw new BadRequestException("交接证据媒体处理服务未配置。");
    }
    return this.evidenceArtifactService;
  }

  private storeFieldEvidenceFile(
    workOrder: WorkOrderRecord,
    file: UploadedFieldEvidenceFile,
    mimeType: string,
    sourceSizeBytes = file.size
  ) {
    const storage = this.getStorageService();
    const common = {
      contentType: mimeType,
      metadata: { originalName: file.originalname },
      orderId: workOrder.orderId,
      originalName: file.originalname,
      workOrderId: workOrder.id
    };
    if (file.path) {
      return storage.putDeliveryEvidenceFileFromPath({
        ...common,
        filePath: file.path,
        sizeBytes: sourceSizeBytes
      });
    }
    if (file.buffer?.length) {
      return storage.putDeliveryEvidenceFile({
        ...common,
        buffer: file.buffer
      });
    }
    throw new BadRequestException("请上传现场证据文件。");
  }

  private async getOrCreateDraftHandover(
    orderId: string,
    actorId?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    if (this.deliveryHandoverService) {
      return this.deliveryHandoverService.getOrCreateDraftHandover(orderId, actorId, db);
    }
    const handover = await db.vehicleDeliveryHandover.findFirst({
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
    const accessTokenHash = hashAccessToken(normalized);
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findFirst({
      where: { accessTokenHash }
    });
    if (!workOrder || workOrder.operatorType !== "EXTERNAL" || !workOrder.accessTokenExpiresAt) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    if (workOrder.accessTokenRevokedAt || workOrder.accessTokenExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    this.assertMutable(workOrder);
    const now = new Date();
    const result = await this.prisma.vehicleHandoverWorkOrder.updateMany({
      data: {
        firstAccessedAt: workOrder.firstAccessedAt ?? now,
        lastAccessedAt: now
      },
      where: {
        accessTokenExpiresAt: { gt: now },
        accessTokenHash,
        accessTokenRevokedAt: null,
        id: workOrder.id,
        operatorType: "EXTERNAL"
      }
    });
    if (result.count !== 1) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    const current = await this.prisma.vehicleHandoverWorkOrder.findUnique({
      where: { id: workOrder.id }
    });
    if (
      !current ||
      current.accessTokenHash !== accessTokenHash ||
      current.operatorType !== "EXTERNAL" ||
      current.accessTokenRevokedAt ||
      !current.accessTokenExpiresAt ||
      current.accessTokenExpiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException("外部交付访问已失效。");
    }
    this.assertMutable(current);
    return current;
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
      taskGroup: isFieldEndedWorkOrder(workOrder) ? "ENDED" : "ACTIVE",
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      }
    };
  }

  private async toFieldTaskListItem(workOrder: WorkOrderRecord) {
    const [order, evidenceChecklist, workflowProjection] = await Promise.all([
      this.getOrderOrThrow(workOrder.orderId),
      this.deliveryEvidenceService.getChecklist({
        handoverId: workOrder.handoverId ?? null,
        orderId: workOrder.orderId
      }),
      this.getFieldHandoverWorkflowProjection(workOrder)
    ]);

    return {
      customer: {
        displayName: order.customer?.name ?? null,
        mobileMasked: maskPhone(order.customer?.mobile)
      },
      adminReviewStatus: getHandoverReviewAdminStatus(workOrder),
      deliveryLocation: workOrder.deliveryLocation,
      evidenceProgress: summarizeEvidenceChecklist(evidenceChecklist),
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      handoverId: workOrder.handoverId,
      handoverType: workOrder.handoverType,
      id: workOrder.id,
      orderNo: order.orderNo,
      scheduledAt: workOrder.scheduledAt,
      status: workOrder.status,
      ...workflowProjection,
      vehicle: {
        brand: order.vehicle?.brand ?? null,
        model: order.vehicle?.model ?? null,
        plateMasked: maskPlate(order.vehicle?.plateNo),
        vinSuffix: suffix(order.vehicle?.vin, 6)
      }
    };
  }

  private async getFieldHandoverWorkflowProjection(
    workOrder: WorkOrderRecord
  ): Promise<FieldHandoverWorkflowProjection> {
    const handoverModel = (this.prisma as unknown as {
      vehicleDeliveryHandover?: {
        findFirst: (
          args: Prisma.VehicleDeliveryHandoverFindFirstArgs
        ) => Promise<null | Record<string, unknown>>;
      };
    }).vehicleDeliveryHandover;
    const handover = handoverModel
      ? await handoverModel.findFirst({
          select: {
            archiveStatus: true,
            archivedAt: true,
            handoverContractId: true,
            handoverESignTaskId: true,
            id: true,
            signedDocumentFileId: true,
            signedPdfHash: true,
            sourceDocumentFileId: true,
            status: true,
            updatedAt: true
          },
          where: {
            deletedAt: null,
            ...(workOrder.handoverId ? { id: workOrder.handoverId } : {}),
            orderId: workOrder.orderId
          }
        })
      : null;
    const handoverRecord = asRecord(handover);
    const activeTaskWhere = handoverRecord
      ? buildAuthoritativeStage2TaskWhere({
          contractId: readString(handoverRecord, "handoverContractId"),
          orderId: workOrder.orderId,
          taskId: readString(handoverRecord, "handoverESignTaskId")
        })
      : null;
    const taskWhere = activeTaskWhere
      ? {
          ...activeTaskWhere,
          taskStatus: {
            in: [
              ESignTaskStatus.CREATED,
              ESignTaskStatus.WAITING_CUSTOMER,
              ESignTaskStatus.SIGNING,
              ESignTaskStatus.COMPLETED,
              ESignTaskStatus.FAILED,
              ESignTaskStatus.CANCELLED,
              ESignTaskStatus.EXPIRED
            ]
          }
        }
      : null;
    const taskModel = (this.prisma as unknown as {
      contractESignTask?: {
        findFirst: (
          args: Prisma.ContractESignTaskFindFirstArgs
        ) => Promise<null | {
          signers: Array<{
            signedAt: Date | null;
            signerStatus: string;
            slotId: string;
          }>;
          taskStatus: string;
        }>;
      };
    }).contractESignTask;
    const task = taskWhere && taskModel
      ? await taskModel.findFirst({
          orderBy: { createdAt: "desc" },
          select: {
            signers: {
              select: {
                signedAt: true,
                signerStatus: true,
                slotId: true
              },
              where: {
                slotId: {
                  in: [
                    "STAGE2_HANDOVER_CUSTOMER",
                    "STAGE2_HANDOVER_PLATFORM"
                  ]
                }
              }
            },
            taskStatus: true
          },
          where: taskWhere
        })
      : null;
    const projection = projectFieldHandoverWorkflow({
      handover: handoverRecord
        ? {
            archiveStatus: readString(handoverRecord, "archiveStatus") ?? "",
            archivedAt: readDateValue(handoverRecord, "archivedAt"),
            signedDocumentFileId: readString(
              handoverRecord,
              "signedDocumentFileId"
            ),
            signedPdfHash: readString(handoverRecord, "signedPdfHash"),
            sourceDocumentFileId: readString(
              handoverRecord,
              "sourceDocumentFileId"
            ),
            status: readString(handoverRecord, "status") ?? "",
            updatedAt: readDateValue(handoverRecord, "updatedAt")
          }
        : null,
      task,
      workOrderStatus: workOrder.status
    });

    if (projection.displayStatus === "INCONSISTENT") {
      this.logger.warn(JSON.stringify({
        archiveStatus: handoverRecord
          ? readString(handoverRecord, "archiveStatus")
          : null,
        displayStatus: projection.displayStatus,
        handoverId: handoverRecord ? readString(handoverRecord, "id") : null,
        handoverStatus: handoverRecord
          ? readString(handoverRecord, "status")
          : null,
        taskStatus: task?.taskStatus ?? null,
        workOrderId: workOrder.id,
        workOrderStatus: workOrder.status
      }));
    }
    return projection;
  }

  private async toFieldTaskDetail(workOrder: WorkOrderRecord) {
    const evidenceRouteBase =
      `/api/field/handover/work-orders/${encodeURIComponent(workOrder.id)}/evidence-files`;
    const [
      listItem,
      evidenceChecklist,
      latestAttempt,
      stage2Pdf,
      stage2Workflow
    ] =
      await Promise.all([
        this.toFieldTaskListItem(workOrder),
        this.deliveryEvidenceService.getChecklist({
          handoverId: workOrder.handoverId ?? null,
          orderId: workOrder.orderId
        }),
        this.findLatestReviewAttempt(workOrder.id),
        this.getStage2HandoverPdf(workOrder.id),
        this.getFieldStage2WorkflowProjection(workOrder)
      ]);
    const fieldPdfRouteBase =
      `/api/field/handover/work-orders/${encodeURIComponent(workOrder.id)}/pdf`;

    return {
      ...listItem,
      fieldResubmissionRequested: isFieldResubmissionRequested(workOrder),
      evidenceChecklist: toSafeEvidenceChecklist(evidenceChecklist, evidenceRouteBase),
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
      reviewContext: toFieldReviewContext(
        workOrder,
        latestAttempt,
        evidenceChecklist
      ),
      stage2ESign: stage2Workflow.eSign,
      stage2Notification: stage2Workflow.notification,
      stage2Pdf: {
        ...stage2Pdf,
        downloadUrl:
          stage2Pdf.status === "GENERATED"
            ? `${fieldPdfRouteBase}/download`
            : null,
        previewUrl:
          stage2Pdf.status === "GENERATED"
            ? `${fieldPdfRouteBase}/preview`
            : null
      }
    };
  }

  private async getFieldStage2WorkflowProjection(
    workOrder: WorkOrderRecord
  ) {
    const handover = await this.findStage2HandoverForWorkOrder(workOrder);
    const handoverRecord = asRecord(handover);
    const taskModel = (this.prisma as unknown as {
      contractESignTask?: {
        findFirst: (
          args: Prisma.ContractESignTaskFindFirstArgs
        ) => Promise<null | {
          id: string;
          signers: Array<{
            claimExpiresAt: Date | null;
            providerTransactionId: string | null;
          }>;
          taskStatus: string;
        }>;
      };
    }).contractESignTask;
    const notificationModel = (this.prisma as unknown as {
      vehicleHandoverWorkflowJob?: {
        findFirst: (
          args: Prisma.VehicleHandoverWorkflowJobFindFirstArgs
        ) => Promise<null | { jobStatus: string }>;
        findMany?: (
          args: Prisma.VehicleHandoverWorkflowJobFindManyArgs
        ) => Promise<Array<{ jobType: VehicleHandoverWorkflowJobType }>>;
      };
    }).vehicleHandoverWorkflowJob;
    const handoverTaskId = handoverRecord
      ? readString(handoverRecord, "handoverESignTaskId")
      : null;
    const handoverContractId = handoverRecord
      ? readString(handoverRecord, "handoverContractId")
      : null;
    const taskWhere = buildAuthoritativeStage2TaskWhere({
      contractId: handoverContractId,
      orderId: workOrder.orderId,
      taskId: handoverTaskId
    });
    const task =
      typeof taskModel?.findFirst === "function" && taskWhere
        ? await taskModel.findFirst({
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              signers: {
                select: {
                  claimExpiresAt: true,
                  providerTransactionId: true
                },
                where: {
                  slotId: "STAGE2_HANDOVER_CUSTOMER"
                }
              },
              taskStatus: true
            },
            where: taskWhere
          })
        : null;
    const [notification, customerJobs] = await Promise.all([
      typeof notificationModel?.findFirst === "function"
        ? notificationModel.findFirst({
            orderBy: { createdAt: "desc" },
            select: { jobStatus: true },
            where: {
              jobType:
                VehicleHandoverWorkflowJobType
                  .NOTIFY_FIELD_ESIGN_READY,
              workOrderId: workOrder.id
            }
          })
        : Promise.resolve(null),
      task && typeof notificationModel?.findMany === "function"
        ? notificationModel.findMany({
            select: {
              jobType: true
            },
            where: {
              eSignTaskId: task.id,
              jobType: {
                in: [
                  VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
                  VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
                ]
              }
            }
          })
        : Promise.resolve([])
    ]);
    const customerSigner = task?.signers?.[0] ?? null;
    const customerJobTypes = new Set(
      customerJobs.map((job) => job.jobType)
    );
    const finalizationPending = Boolean(
      task?.taskStatus === "WAITING_CUSTOMER" &&
      customerSigner?.providerTransactionId &&
      (
        customerSigner.claimExpiresAt ||
        !customerJobTypes.has(
          VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY
        ) ||
        !customerJobTypes.has(
          VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE
        )
      )
    );
    return {
      eSign: {
        finalizationPending,
        status: task?.taskStatus ?? null,
        taskId: task?.id ?? null
      },
      notification: {
        status: notification?.jobStatus ?? null
      }
    };
  }

  private async listSafeStage2WorkflowJobs(workOrderId: string) {
    const model = (this.prisma as unknown as {
      vehicleHandoverWorkflowJob?: {
        findMany: (
          args: Prisma.VehicleHandoverWorkflowJobFindManyArgs
        ) => Promise<Array<{
          attemptCount: number;
          availableAt: Date;
          createdAt: Date;
          id: string;
          jobStatus: string;
          jobType: string;
          lastErrorCode: string | null;
          maxAttempts: number;
          updatedAt: Date;
        }>>;
      };
    }).vehicleHandoverWorkflowJob;
    if (typeof model?.findMany !== "function") {
      return [];
    }
    const jobs = await model.findMany({
      orderBy: [
        { updatedAt: "desc" },
        { createdAt: "desc" }
      ],
      select: {
        attemptCount: true,
        availableAt: true,
        createdAt: true,
        id: true,
        jobStatus: true,
        jobType: true,
        lastErrorCode: true,
        maxAttempts: true,
        updatedAt: true
      },
      where: { workOrderId }
    });
    return jobs.map((job) => ({
      attemptCount: job.attemptCount,
      availableAt: job.availableAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      id: job.id,
      jobStatus: job.jobStatus,
      jobType: job.jobType,
      lastErrorCode: job.lastErrorCode ?? null,
      maxAttempts: job.maxAttempts,
      updatedAt: job.updatedAt.toISOString()
    }));
  }

  private updateWorkOrder(id: string, data: Record<string, unknown>) {
    return this.prisma.vehicleHandoverWorkOrder.update({
      data: compactUndefined(data),
      where: { id }
    });
  }

  private updateWorkOrderWithEvent(
    workOrder: WorkOrderRecord,
    data: Record<string, unknown>,
    eventType: VehicleHandoverEventType,
    event: {
      actorId?: string | null;
      actorDisplay?: string | null;
      actorType: VehicleHandoverEventActorType;
      detail?: Record<string, unknown>;
      reviewAttemptId?: string | null;
    },
    beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>,
    isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.Serializable
  ) {
    return this.runTransaction(async (tx) => {
      await beforeWrite?.(tx);
      const updated = await this.updateWorkOrderVersioned(workOrder, data, tx);
      await this.recordEvent(updated, eventType, event, tx);
      return updated;
    }, isolationLevel);
  }

  private async assertDeliveryStartAvailable(
    tx: Prisma.TransactionClient,
    workOrder: WorkOrderRecord
  ) {
    if (!this.assetOperationsService) {
      return;
    }
    const vehicles = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT v."id"
      FROM "vehicle" v
      INNER JOIN "subscription_order" o ON o."vehicle_id" = v."id"
      WHERE o."id" = ${workOrder.orderId}::uuid
      FOR UPDATE OF v
    `);
    const vehicle = vehicles[0];
    if (!vehicle) {
      throw new NotFoundException("交付车辆不存在。");
    }
    await this.assetOperationsService.assertVehicleAvailable(
      tx,
      vehicle.id,
      VehicleAvailabilityPurpose.DELIVERY,
      new Date()
    );
  }

  private async runSerializableTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.runTransaction(callback, Prisma.TransactionIsolationLevel.Serializable);
  }

  private async runTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
    isolationLevel: Prisma.TransactionIsolationLevel
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(callback, {
        isolationLevel
      });
    } catch (error) {
      if (isPrismaSerializationConflict(error)) {
        throw new ConflictException("交接状态已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  private async runStage2SourcePdfFinalizationTransaction<T>(
    callback: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= STAGE2_SOURCE_PDF_FINALIZATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });
      } catch (error) {
        if (!isPrismaSerializationConflict(error)) {
          throw error;
        }
        if (
          attempt === STAGE2_SOURCE_PDF_FINALIZATION_ATTEMPTS
        ) {
          throw new Stage2SourcePdfClaimLostError();
        }
      }
    }
    throw new Stage2SourcePdfClaimLostError();
  }

  private async updateWorkOrderVersioned(
    workOrder: WorkOrderRecord,
    data: Record<string, unknown>,
    db: Prisma.TransactionClient | PrismaService = this.prisma
  ): Promise<WorkOrderRecord> {
    const expectedVersion = workOrder.reviewVersion ?? 0;
    const result = await db.vehicleHandoverWorkOrder.updateMany({
      data: compactUndefined({
        ...data,
        reviewVersion: { increment: 1 }
      }),
      where: {
        id: workOrder.id,
        reviewVersion: expectedVersion
      }
    });
    if (result.count !== 1) {
      throw new ConflictException("交接复核状态已更新，请刷新后重试。");
    }
    const updated = await db.vehicleHandoverWorkOrder.findUnique({
      where: { id: workOrder.id }
    });
    if (!updated) {
      throw new NotFoundException("交接工单不存在。");
    }
    return updated as WorkOrderRecord;
  }
}

function assertFieldFactsComplete(workOrder: WorkOrderRecord) {
  const blockingReasons = getFieldFactsBlockingReasons(workOrder);
  if (blockingReasons.length > 0) {
    throw new BadRequestException(blockingReasons[0]);
  }
}

function assertStatusIn(workOrder: WorkOrderRecord, allowed: string[], message: string) {
  if (!allowed.includes(workOrder.status)) {
    throw new BadRequestException(message);
  }
}

function normalizeReturnInboundCommand(
  input: CreateReturnInboundWorkOrderCommand
): CreateReturnInboundWorkOrderCommand {
  const source = {
    id: normalizeP0CapabilityText(input.source?.id, 64),
    key: normalizeP0CapabilityText(input.source?.key, 255),
    type: normalizeP0CapabilityText(input.source?.type, 64)
  };
  return Object.freeze({
    actorId: normalizeP0CapabilityText(input.actorId, 128),
    orderId: normalizeP0CapabilityText(input.orderId, 128),
    source: Object.freeze(source)
  });
}

function normalizeGovernedReturnInboundUpdateCommand(
  input: GovernedReturnInboundUpdateCommand
): GovernedReturnInboundUpdateCommand {
  const base = normalizeReturnInboundCommand(input);
  const deliveryLocation =
    input.deliveryLocation === null
      ? null
      : normalizeP0CapabilityText(input.deliveryLocation, 255);
  const scheduledAt =
    input.scheduledAt === null ? null : parseDate(input.scheduledAt, "scheduledAt");
  return Object.freeze({
    ...base,
    deliveryLocation,
    scheduledAt,
    workOrderId: normalizeP0CapabilityText(input.workOrderId, 128)
  });
}

function normalizeP0CapabilityText(value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > maxLength) {
    throw handoverP0Conflict(
      HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
      "The return-inbound capability input is invalid."
    );
  }
  return value;
}

function returnInboundSourceLockKey(source: ReturnInboundCommandSource) {
  return JSON.stringify([
    "handover-p0",
    "return-inbound",
    source.type,
    source.id,
    source.key
  ]);
}

function returnInboundCommandHash(command: CreateReturnInboundWorkOrderCommand) {
  return createHash("sha256")
    .update(
      stableSerialize({
        actorId: command.actorId,
        orderId: command.orderId,
        source: command.source
      })
    )
    .digest("hex");
}

function governedReturnInboundUpdateCommandHash(command: GovernedReturnInboundUpdateCommand) {
  return createHash("sha256")
    .update(
      stableSerialize({
        actorId: command.actorId,
        deliveryLocation: command.deliveryLocation,
        orderId: command.orderId,
        scheduledAt: command.scheduledAt,
        source: command.source,
        workOrderId: command.workOrderId
      })
    )
    .digest("hex");
}

function sameReturnInboundSource(
  left: ReturnInboundCommandSource,
  right: ReturnInboundCommandSource
) {
  return left.id === right.id && left.key === right.key && left.type === right.type;
}

async function assertReturnInboundTransaction(tx: Prisma.TransactionClient) {
  const [first] = await tx.$queryRaw<Array<{ isolationLevel: string; transactionId: string }>>(
    Prisma.sql`
      SELECT current_setting('transaction_isolation') AS "isolationLevel",
             txid_current()::text AS "transactionId"
    `
  );
  const [second] = await tx.$queryRaw<Array<{ transactionId: string }>>(
    Prisma.sql`SELECT txid_current()::text AS "transactionId"`
  );
  if (
    first?.isolationLevel !== "read committed" ||
    !first.transactionId ||
    first.transactionId !== second?.transactionId
  ) {
    throw handoverP0Conflict(
      HANDOVER_P0_CAPABILITY_ERROR_CODE.TRANSACTION_REQUIRED,
      "Return-inbound creation requires a caller-owned READ COMMITTED transaction."
    );
  }
}

async function lockReturnInboundAuthority(
  tx: Prisma.TransactionClient,
  table: "subscription_order" | "user",
  id: string,
  mode: "SHARE" | "UPDATE"
) {
  try {
    const query =
      mode === "UPDATE"
        ? Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR UPDATE NOWAIT`
        : Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id}::uuid FOR SHARE NOWAIT`;
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>(query);
    if (!locked) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The return-inbound work-order authority is unavailable."
      );
    }
  } catch (error) {
    if (isReturnInboundLockUnavailable(error)) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_BUSY,
        "The return-inbound work-order authority is busy."
      );
    }
    throw error;
  }
}

async function lockReturnInboundSpecialistProbe(
  tx: Prisma.TransactionClient,
  orderId: string
) {
  try {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "vehicle_handover_work_order"
      WHERE "order_id" = ${orderId}::uuid
        AND "handover_type" = 'RETURN_INBOUND'
      ORDER BY "id"
      FOR UPDATE NOWAIT
    `);
  } catch (error) {
    if (isReturnInboundLockUnavailable(error)) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_BUSY,
        "The return-inbound work-order authority is busy."
      );
    }
    throw error;
  }
}

async function lockReturnInboundWorkOrder(
  tx: Prisma.TransactionClient,
  workOrderId: string
) {
  try {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "vehicle_handover_work_order"
      WHERE "id" = ${workOrderId}::uuid
      FOR UPDATE NOWAIT
    `);
    if (!locked) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_NOT_FOUND,
        "The governed return-inbound work order is unavailable."
      );
    }
  } catch (error) {
    if (isReturnInboundLockUnavailable(error)) {
      throw handoverP0Conflict(
        HANDOVER_P0_CAPABILITY_ERROR_CODE.AUTHORITY_BUSY,
        "The governed return-inbound work order is busy."
      );
    }
    throw error;
  }
}

function findReturnInboundSourceOwners(
  tx: Prisma.TransactionClient,
  source: ReturnInboundCommandSource
) {
  return tx.vehicleHandoverWorkOrder.findMany({
    orderBy: { id: "asc" },
    take: 2,
    where: {
      AND: [
        { metadata: { equals: source.type, path: ["p0ReturnInbound", "source", "type"] } },
        { metadata: { equals: source.id, path: ["p0ReturnInbound", "source", "id"] } },
        { metadata: { equals: source.key, path: ["p0ReturnInbound", "source", "key"] } }
      ]
    }
  });
}

function returnInboundMetadataHash(metadata: unknown) {
  const envelope = asRecord(asRecord(metadata)?.p0ReturnInbound);
  return typeof envelope?.commandHash === "string" ? envelope.commandHash : null;
}

function isReturnInboundLockUnavailable(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.code === "55P03") return true;
  const meta = asRecord(record.meta);
  const adapter = asRecord(meta?.driverAdapterError);
  return asRecord(adapter?.cause)?.originalCode === "55P03";
}

function handoverP0Conflict(code: string, message: string) {
  return new ConflictException({ code, message });
}

function consumeHandoverAuthorityAttestation(
  tx: Prisma.TransactionClient,
  authoritySession: SubscriptionClosureAuthoritySession,
  attestation: ClosureAuthorityAttestation,
  requirementFactory: () => SubscriptionClosureAuthorityRequirement
) {
  try {
    consumeSubscriptionClosureAuthorityAttestation(
      tx,
      authoritySession,
      attestation,
      requirementFactory,
      null
    );
  } catch (error) {
    if (error instanceof ConflictException) {
      const response = error.getResponse();
      if (
        response &&
        typeof response === "object" &&
        "code" in response &&
        response.code === "SUBSCRIPTION_CLOSURE_CAPABILITY_INVALID"
      ) {
        throw handoverP0Conflict(
          HANDOVER_P0_CAPABILITY_ERROR_CODE.CAPABILITY_INVALID,
          "The coordinator authority attestation is invalid."
        );
      }
    }
    throw error;
  }
}

function isPrismaSerializationConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function assertOpsReviewPending(workOrder: WorkOrderRecord) {
  if (workOrder.status !== "OPS_REVIEW_PENDING" || workOrder.opsReviewStatus !== "PENDING") {
    throw new BadRequestException("工单尚未进入运营复核待处理状态。");
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
  if (hasActiveCustomerObjection(workOrder) && isFieldResubmissionRequested(workOrder)) {
    return;
  }
  if (FIELD_SESSION_LOCKED_STATUSES.has(String(workOrder.status))) {
    throw new BadRequestException("当前交接任务已提交或不可继续编辑。");
  }
}

function hasActiveCustomerObjection(workOrder: WorkOrderRecord) {
  return workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt);
}

function isFieldAccessibleWorkOrder(workOrder: null | WorkOrderRecord, phone: string) {
  if (!workOrder || workOrder.fieldOperatorPhone !== phone) {
    return false;
  }
  return true;
}

function compareProjectedFieldWorkOrders(
  left: {
    item: FieldHandoverWorkflowProjection;
    workOrder: WorkOrderRecord;
  },
  right: {
    item: FieldHandoverWorkflowProjection;
    workOrder: WorkOrderRecord;
  }
) {
  const leftEnded = left.item.taskGroup === "ENDED";
  const rightEnded = right.item.taskGroup === "ENDED";
  if (leftEnded !== rightEnded) {
    return leftEnded ? 1 : -1;
  }

  if (leftEnded && rightEnded) {
    const leftCompletedAt = left.item.completedAt
      ? Date.parse(left.item.completedAt)
      : left.workOrder.updatedAt?.getTime() ?? 0;
    const rightCompletedAt = right.item.completedAt
      ? Date.parse(right.item.completedAt)
      : right.workOrder.updatedAt?.getTime() ?? 0;
    if (leftCompletedAt !== rightCompletedAt) {
      return rightCompletedAt - leftCompletedAt;
    }
  } else {
    const priorityDifference =
      getFieldHandoverDisplayPriority(left.item.displayStatus) -
      getFieldHandoverDisplayPriority(right.item.displayStatus);
    if (priorityDifference !== 0) {
      return priorityDifference;
    }
  }

  const leftCreated = left.workOrder.createdAt?.getTime() ?? 0;
  const rightCreated = right.workOrder.createdAt?.getTime() ?? 0;
  if (leftCreated !== rightCreated) {
    return rightCreated - leftCreated;
  }

  const leftScheduled =
    left.workOrder.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightScheduled =
    right.workOrder.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftScheduled !== rightScheduled) {
    return leftScheduled - rightScheduled;
  }
  return left.workOrder.id.localeCompare(right.workOrder.id);
}

function isFieldEndedWorkOrder(workOrder: WorkOrderRecord) {
  return FIELD_ENDED_WORK_ORDER_STATUS_SET.has(workOrder.status);
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
    allowsMultiple: readNullableBoolean(item, "allowsMultiple"),
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
  const mediaType = readString(file, "mediaType");
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
    lifecycleStatus: readString(file, "lifecycleStatus"),
    mimeType,
    mediaType,
    metadata: mediaType === "VIDEO"
      ? toSafeEvidenceVideoQualityMetadata(readUnknown(file, "metadata"))
      : null,
    previewAvailable,
    previewUrl: routeBase && evidenceFileId && previewAvailable ? `${routeBase}/${encodeURIComponent(evidenceFileId)}/preview` : null,
    sizeBytes,
    uploadedAt: readUnknown(file, "uploadedAt")
  };
}

function toSafeEvidenceVideoQualityMetadata(metadata: unknown) {
  const record = asRecord(metadata);
  if (!record) {
    return null;
  }
  const videoHeightPx = toPositiveSafeInteger(record.videoHeightPx);
  const videoWidthPx = toPositiveSafeInteger(record.videoWidthPx);
  const videoQualityStatus = record.videoQualityStatus === "PASSED" ? "PASSED" : null;
  if (!videoHeightPx && !videoWidthPx && !videoQualityStatus) {
    return null;
  }
  return {
    videoHeightPx,
    videoQualityStatus,
    videoWidthPx
  };
}

function toPositiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
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

function readDateValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value instanceof Date ? value : null;
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

function readUnknownRecordValue(record: null | Record<string, unknown>, key: string) {
  return record?.[key] ?? null;
}

function readNumberLike(record: Record<string, unknown>, key: string) {
  return toNumberOrNull(record[key]);
}

function readMetadataString(metadata: unknown, key: string) {
  const record = asRecord(metadata);
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function uniqueStrings(values: unknown) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

function uniqueFieldFactKeys(values: unknown): HandoverFieldFactKey[] {
  return uniqueStrings(values).filter(isHandoverFieldFactKey);
}

function isHandoverFieldFactKey(value: string): value is HandoverFieldFactKey {
  return HANDOVER_FIELD_FACT_KEYS.includes(value as HandoverFieldFactKey);
}

function evidenceItemFingerprintMap(snapshot: unknown) {
  const map = new Map<string, string>();
  for (const item of getChecklistItems(snapshot)) {
    const itemId = readString(item, "id");
    if (!itemId) {
      continue;
    }
    const files = getEvidenceFiles(item)
      .map((file) => ({
        evidenceFileId: readString(file, "evidenceFileId") ?? readString(file, "id"),
        fileId: readString(file, "fileId"),
        mediaType: readString(file, "mediaType")
      }))
      .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
    map.set(itemId, stableSerialize({
      declaredNoDamage: readNullableBoolean(item, "declaredNoDamage"),
      files
    }));
  }
  return map;
}

function readEvidencePackageManifestHash(snapshot: unknown) {
  const evidencePackage = asRecord(asRecord(snapshot)?.evidencePackage);
  return evidencePackage ? readString(evidencePackage, "manifestHash") : null;
}

function requireReviewAttemptId(attempt: null | Record<string, unknown>) {
  const id = attempt ? readString(attempt, "id") : null;
  if (!id) {
    throw new Error("STAGE2_HANDOVER_REVIEW_ATTEMPT_UNAVAILABLE");
  }
  return id;
}

function toPendingStage2WorkflowProjection(jobId: string) {
  return {
    artifactVersion: null,
    errorCode: null,
    jobId,
    state: "PDF_PENDING" as const
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function asRecord(value: unknown) {
  return isPlainObject(value) ? value : null;
}

function toObjectionView(workOrder: WorkOrderRecord) {
  return {
    adminStatus: getHandoverReviewAdminStatus(workOrder),
    details: readMetadataString(workOrder.metadata, "customerObjectionDetails"),
    objectedAt: workOrder.customerObjectedAt ?? null,
    reason: workOrder.customerObjectionReason ?? null
  };
}

function toAdminReviewView(workOrder: WorkOrderRecord, reviewAttempts: Array<Record<string, unknown>>) {
  const status = getHandoverReviewAdminStatus(workOrder);
  return {
    canAcknowledge:
      (workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt)) &&
      status === VehicleHandoverAdminReviewStatus.NONE,
    canRequestResubmission:
      (workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt)) &&
      status === VehicleHandoverAdminReviewStatus.ACKNOWLEDGED,
    canSendBackToCustomerReview:
      (workOrder.status === "CUSTOMER_OBJECTED" || Boolean(workOrder.customerObjectedAt)) &&
      status === ADMIN_REVIEW_STATUS_RESUBMITTED_PENDING_ADMIN,
    currentAttemptNo: reviewAttempts.length > 0 ? toNumberOrNull(reviewAttempts[reviewAttempts.length - 1]?.attemptNo) : null,
    status,
    totalAttempts: reviewAttempts.length
  };
}

function toFieldReviewContext(
  workOrder: WorkOrderRecord,
  latestAttempt: null | Record<string, unknown>,
  checklist: unknown
) {
  if (!latestAttempt || !hasActiveCustomerObjection(workOrder)) {
    return null;
  }
  const metadata = asRecord(latestAttempt.metadata);
  const requestedEvidenceItemIds = readStringArray(metadata, "resubmissionRequestedEvidenceItemIds");
  const requestedFieldKeys = readStringArray(metadata, "resubmissionRequestedFieldKeys");
  const titleById = new Map(
    getChecklistItems(checklist)
      .map((item) => [readString(item, "id"), readString(item, "title")] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]))
  );
  return {
    adminNote: readNullableString(latestAttempt, "adminNotes"),
    adminStatus: getHandoverReviewAdminStatus(workOrder),
    attemptNo: toNumberOrNull(latestAttempt.attemptNo),
    customerObjectionDetails: readNullableString(latestAttempt, "customerObjectionDetails"),
    customerObjectionReason:
      readNullableString(latestAttempt, "customerObjectionReason") ?? workOrder.customerObjectionReason ?? null,
    requestedEvidenceItems: requestedEvidenceItemIds.map((itemId) => ({
      id: itemId,
      title: titleById.get(itemId) ?? "现场资料"
    })),
    requestedFieldKeys
  };
}

function toSafeReviewAttempt(attempt: Record<string, unknown>) {
  const metadata = asRecord(attempt.metadata);
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
    evidenceSnapshot: readUnknown(attempt, "evidenceSnapshot"),
    fieldSubmittedAt: readUnknown(attempt, "fieldSubmittedAt"),
    fieldFactsSnapshot: readUnknown(attempt, "fieldFactsSnapshot"),
    id: readString(attempt, "id"),
    resubmissionChangeSummary: metadata?.resubmissionChangeSummary ?? null,
    resubmissionRequestedEvidenceItemIds: readStringArray(metadata, "resubmissionRequestedEvidenceItemIds"),
    resubmissionRequestedFieldKeys: readStringArray(metadata, "resubmissionRequestedFieldKeys"),
    resubmissionRequestedAt: readUnknown(attempt, "resubmissionRequestedAt"),
    sentBackToCustomerReviewAt: readUnknown(attempt, "sentBackToCustomerReviewAt"),
    status: readString(attempt, "status")
  };
}

function toSafeHandoverEvent(event: Record<string, unknown>) {
  return {
    actorDisplay: readNullableString(event, "actorDisplay"),
    actorType: readString(event, "actorType"),
    createdAt: readUnknown(event, "createdAt"),
    detail: readUnknown(event, "detail"),
    eventType: readString(event, "eventType"),
    id: readString(event, "id")
  };
}

function nextAttemptNo(latest: null | Record<string, unknown>) {
  const current = latest ? toNumberOrNull(latest.attemptNo) : null;
  return (current ?? 0) + 1;
}

function getHandoverReviewAdminStatus(workOrder: WorkOrderRecord) {
  const persisted = normalizeOptionalText(workOrder.adminReviewStatus);
  if (persisted && persisted !== VehicleHandoverAdminReviewStatus.NONE) {
    return persisted;
  }
  const legacy = readMetadataString(workOrder.metadata, HANDOVER_REVIEW_ADMIN_STATUS_KEY);
  return legacy ?? persisted ?? VehicleHandoverAdminReviewStatus.NONE;
}

function isFieldResubmissionRequested(workOrder: WorkOrderRecord) {
  return getHandoverReviewAdminStatus(workOrder) === ADMIN_REVIEW_STATUS_RESUBMISSION_REQUESTED;
}

function isPreviewableEvidenceMime(mimeType: null | string | undefined) {
  return Boolean(mimeType && PREVIEWABLE_EVIDENCE_MIME_TYPES.has(normalizeMimeType(mimeType)));
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

function toDateOrNull(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
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

function assertCanReconcileArchivedStage2Evidence(
  workOrder: WorkOrderRecord
) {
  if (isTerminalWorkOrderStatus(workOrder.status)) {
    throw new BadRequestException("交付工单已终止，不能收敛归档证据。");
  }
  if (workOrder.status === "CUSTOMER_OBJECTED" || workOrder.customerObjectedAt) {
    throw new BadRequestException("客户存在异议，不能收敛归档证据。");
  }
  if (
    workOrder.handoverType !== "DELIVERY_OUTBOUND" ||
    !ARCHIVED_STAGE2_RECONCILABLE_STATUSES.has(String(workOrder.status))
  ) {
    throw new BadRequestException("交付工单状态不允许收敛 Stage 2 归档证据。");
  }
}

function assertDamageState(damageDeclared: unknown, noVisibleDamageDeclared: unknown) {
  if (damageDeclared === true && noVisibleDamageDeclared === true) {
    throw new BadRequestException("损伤状态冲突，请选择存在损伤或无可见损伤。");
  }
}

function assertSupportedFieldEvidenceFile(file: UploadedFieldEvidenceFile) {
  if (!hasUploadedFieldEvidenceContent(file)) {
    throw new BadRequestException("请上传现场证据文件。");
  }
  const mediaType = fieldEvidenceMediaType(file);
  if (!mediaType) {
    throw new BadRequestException("现场证据仅支持安全的图片或视频文件。");
  }
  const sizeBytes = Math.max(file.size, file.buffer?.length ?? 0);
  if (mediaType === DeliveryEvidenceMediaType.PHOTO && sizeBytes > MAX_FIELD_PHOTO_SIZE_BYTES) {
    throw new BadRequestException("图片不能超过 10MB。");
  }
  if (mediaType === DeliveryEvidenceMediaType.VIDEO && sizeBytes > MAX_FIELD_VIDEO_SIZE_BYTES) {
    throw new BadRequestException("视频不能超过 300MB。");
  }
  return mediaType;
}

function hasUploadedFieldEvidenceContent(file: UploadedFieldEvidenceFile) {
  return file.size > 0 && Boolean(file.path || file.buffer?.length);
}

async function cleanupUploadedFieldEvidenceTempFile(file: UploadedFieldEvidenceFile) {
  if (!file.path) {
    return;
  }
  try {
    await unlink(file.path);
  } catch {
    return;
  }
}

function fieldEvidenceMediaType(file: UploadedFieldEvidenceFile) {
  const mimeType = normalizeMimeType(file.mimetype);
  if (mimeType && mimeType !== "application/octet-stream") {
    if (SAFE_FIELD_PHOTO_MIME_TYPES.has(mimeType)) {
      return DeliveryEvidenceMediaType.PHOTO;
    }
    if (SAFE_FIELD_VIDEO_MIME_TYPES.has(mimeType)) {
      return DeliveryEvidenceMediaType.VIDEO;
    }
    return null;
  }
  if (/\.(heic|heif|jpe?g|png|webp)$/i.test(file.originalname)) {
    return DeliveryEvidenceMediaType.PHOTO;
  }
  if (/\.(m4v|mov|mp4|webm)$/i.test(file.originalname)) {
    return DeliveryEvidenceMediaType.VIDEO;
  }
  return null;
}

function normalizeMimeType(value: null | string | undefined) {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
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

async function calculateFileSha256(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function calculateReadableSha256(stream: Readable, maxBytes: number) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    if (sizeBytes > maxBytes) {
      stream.destroy();
      throw new ConflictException(
        "The persisted Stage 2 source PDF exceeds the size limit."
      );
    }
    hash.update(buffer);
  }
  return {
    sha256: hash.digest("hex"),
    sizeBytes
  };
}

function requireSha256Digest(value: string) {
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("STAGE2_HANDOVER_MANIFEST_HASH_INVALID");
  }
  return digest;
}

function normalizeSha256Digest(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function buildStage2PdfArtifactIdentity(
  workOrder: WorkOrderRecord,
  manifestDigest: string,
  artifactVersion: number,
  rendererVersion: number
) {
  const identity =
    `${workOrder.id}:${artifactVersion}:renderer-${rendererVersion}:` +
    manifestDigest;
  return {
    contractId: deterministicUuid(`stage2-contract:${identity}`)
  };
}

function buildStage2PdfStoredIdentity(
  contractId: string,
  artifactVersion: number,
  sourcePdfHash: string
) {
  return {
    fileObjectId: deterministicUuid(
      `stage2-file:${contractId}:${sourcePdfHash}`
    ),
    objectKey:
      `contracts/${contractId}/generated/handover-v${artifactVersion}-${sourcePdfHash}.pdf`
  };
}

function deterministicUuid(value: string) {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13)}`;
  const variant = (
    (Number.parseInt(versioned[16]!, 16) & 0x3) | 0x8
  ).toString(16);
  const normalized = `${versioned.slice(0, 16)}${variant}${versioned.slice(17)}`;
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20)
  ].join("-");
}

async function readStage2DatabaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT now() AS "now"`
  );
  if (!row?.now) {
    throw new Error("STAGE2_SOURCE_PDF_RESERVATION_TIME_UNAVAILABLE");
  }
  return row.now;
}

function readStage2SourcePdfReservation(
  value: unknown
): Stage2SourcePdfReservation | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const artifactVersion = readPositiveInteger(record, "artifactVersion");
  const contractId = readString(record, "contractId");
  const contractNo = readString(record, "contractNo");
  const generatedAt = toDateOrNull(record.generatedAt);
  const manifestHash = normalizeSha256Digest(record.manifestHash);
  const templateId = readString(record, "templateId");
  if (
    !artifactVersion ||
    !contractId ||
    !contractNo ||
    !generatedAt ||
    !manifestHash ||
    !templateId
  ) {
    throw new ConflictException(
      "The persisted Stage 2 source PDF reservation is invalid."
    );
  }
  return {
    artifactVersion,
    contractId,
    contractNo,
    generatedAt,
    manifestHash,
    templateId
  };
}

function createReservedStage2ContractNo(contractId: string) {
  return `HDV-${contractId.replaceAll("-", "").toLowerCase()}`;
}

function sameStage2SourceBinding(
  left: Record<string, unknown>,
  right: Record<string, unknown>
) {
  return [
    "artifactVersion",
    "handoverContractId",
    "manifestHash",
    "sourceDocumentFileId",
    "sourceObjectKey",
    "sourcePdfHash"
  ].every((key) => left[key] === right[key]);
}

function readPositiveInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function readRequiredPositiveInteger(
  record: Record<string, unknown>,
  key: string
) {
  const value = readPositiveInteger(record, key);
  if (value === null) {
    throw new ConflictException(`Invalid Stage 2 artifact ${key}.`);
  }
  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string) {
  const value = readString(record, key);
  if (!value) {
    throw new ConflictException(`Invalid Stage 2 artifact ${key}.`);
  }
  return value;
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

async function readStreamToBoundedBuffer(stream: Readable, maxBytes: number, errorMessage: string) {
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    if (sizeBytes > maxBytes) {
      stream.destroy();
      throw new BadRequestException(errorMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, sizeBytes);
}

async function writeStreamToBoundedFile(
  stream: Readable,
  filePath: string,
  maxBytes: number,
  errorMessage: string
) {
  let sizeBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        callback(new BadRequestException(errorMessage));
        return;
      }
      callback(null, chunk);
    }
  });
  await pipeline(stream, limiter, createWriteStream(filePath, { flags: "wx" }));
  return sizeBytes;
}

function sanitizeTempEvidenceFileName(value: null | string) {
  const extension = path.extname(value ?? "").replace(/[^\w.]+/g, "").slice(0, 12);
  return `source${extension && extension !== "." ? extension : ".bin"}`;
}

function isEvidenceArtifactMetadataReady(
  value: unknown,
  mediaType: string,
  evidenceType: string
) {
  const metadata = asRecord(value);
  if (
    metadata?.processingStatus !== "READY" ||
    typeof metadata.sourceSha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.sourceSha256)
  ) {
    return false;
  }
  if (mediaType === DeliveryEvidenceMediaType.PHOTO) {
    return Boolean(readString(metadata, "photoPreviewFileId"));
  }
  const frameIds = Array.isArray(metadata.videoFrameFileIds)
    ? metadata.videoFrameFileIds.filter((entry): entry is string =>
        typeof entry === "string" && Boolean(entry.trim())
      )
    : [];
  return frameIds.length === (evidenceType === "WALKAROUND_VIDEO" ? 4 : 2);
}

function getEvidenceArtifactDerivativeFileIds(value: unknown, mediaType: string) {
  const metadata = asRecord(value);
  if (!metadata) {
    return [];
  }
  if (mediaType === DeliveryEvidenceMediaType.PHOTO) {
    const photoPreviewFileId = readString(metadata, "photoPreviewFileId");
    return photoPreviewFileId ? [photoPreviewFileId] : [];
  }
  return Array.isArray(metadata?.videoFrameFileIds)
    ? metadata.videoFrameFileIds.filter((entry): entry is string =>
        typeof entry === "string" && Boolean(entry.trim())
      )
    : [];
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
