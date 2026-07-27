import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  Prisma
} from "@prisma/client";

import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import {
  ESIGN_PROVIDER_CLIENT,
  ESignProvider,
  ESignProviderActionResult,
  ESignSigningSlot,
  ESignSigningSlotCoordinate
} from "../esign/esign.provider";
import { FadadaSignedArtifactService } from "../esign/fadada/fadada-signed-artifact.service";
import { normalizeFieldOperatorPhone } from "../field-operator/field-operator-phone";
import { PrismaService } from "../prisma/prisma.service";
import {
  Stage2HandoverESignBlocker,
  Stage2HandoverESignReadiness,
  Stage2HandoverESignReadinessService,
  STAGE2_HANDOVER_ESIGN_NOT_READY
} from "./stage2-handover-esign-readiness.service";
import { Stage2HandoverWorkflowService } from "./stage2-handover-workflow.service";

export const STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED =
  "STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED";
export const STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED =
  "STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED";
export const STAGE2_HANDOVER_ESIGN_ORPHAN_CONFLICT =
  "STAGE2_HANDOVER_ESIGN_ORPHAN_CONFLICT";
export const STAGE2_PLATFORM_SEAL_PROVIDER_FAILED =
  "STAGE2_PLATFORM_SEAL_PROVIDER_FAILED";
export const STAGE2_HANDOVER_ESIGN_RESULT_STALE =
  "STAGE2_HANDOVER_ESIGN_RESULT_STALE";
export const STAGE2_PLATFORM_SEAL_CLAIM_LOST =
  "STAGE2_PLATFORM_SEAL_CLAIM_LOST";

const CUSTOMER_SLOT_ID = ESignSlotId.STAGE2_HANDOVER_CUSTOMER;
const PLATFORM_SLOT_ID = ESignSlotId.STAGE2_HANDOVER_PLATFORM;
const PLATFORM_CLAIM_MS = 5 * 60 * 1000;
const STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV =
  "STAGE2_HANDOVER_WORKFLOW_ENABLED";
const ACTIVE_TASK_STATUSES = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING
] as const;
const TERMINAL_REBUILD_STATUSES = new Set<ESignTaskStatus>([
  ESignTaskStatus.CANCELLED,
  ESignTaskStatus.EXPIRED,
  ESignTaskStatus.FAILED
]);
const VOIDABLE_TASK_STATUSES = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.FAILED,
  ESignTaskStatus.CANCELLED,
  ESignTaskStatus.EXPIRED
] as const;
const VOIDABLE_HANDOVER_STATUSES = new Set<DeliveryHandoverStatus>([
  DeliveryHandoverStatus.SOURCE_GENERATED,
  DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
  DeliveryHandoverStatus.PENDING_PLATFORM_SEAL,
  DeliveryHandoverStatus.FAILED,
  DeliveryHandoverStatus.CANCELLED
]);
const PORTAL_START_EXPECTED_READINESS_BLOCKERS = new Set([
  "ACTIVE_ESIGN_TASK_CONFLICT",
  "HANDOVER_SOURCE_NOT_GENERATED",
  "SOURCE_CONTRACT_INVALID"
]);
const PORTAL_START_TASK_STATUSES = new Set<ESignTaskStatus>([
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.WAITING_CUSTOMER
]);
const PORTAL_START_CUSTOMER_SIGNER_STATUSES = new Set<ESignSignerStatus>([
  ESignSignerStatus.PENDING,
  ESignSignerStatus.SIGNING
]);

const CUSTOMER_SIGNING_SLOT: ESignSigningSlot = {
  documentType: "DELIVERY_HANDOVER",
  keyword: "stage2-handover-customer",
  positionType: "COORDINATE",
  providerActionType: "CUSTOMER_MANUAL_SIGN",
  required: true,
  signerRole: "CUSTOMER",
  signingStage: "STAGE2_DELIVERY_HANDOVER",
  slotId: "STAGE2_HANDOVER_CUSTOMER"
};

const PLATFORM_SIGNING_SLOT: ESignSigningSlot = {
  documentType: "DELIVERY_HANDOVER",
  keyword: "stage2-handover-platform",
  positionType: "COORDINATE",
  providerActionType: "PLATFORM_AUTO_SEAL",
  required: true,
  signerRole: "PLATFORM",
  signingStage: "STAGE2_DELIVERY_HANDOVER",
  slotId: "STAGE2_HANDOVER_PLATFORM"
};

const stage2LifecycleInclude = {
  handover: {
    include: {
      handoverContract: {
        select: {
          contractSnapshot: true,
          contractTitle: true,
          createdAt: true,
          fileId: true,
          id: true,
          status: true,
          updatedAt: true
        }
      },
      handoverESignTask: {
        include: {
          signers: true
        }
      }
    }
  },
  order: {
    select: {
      customer: {
        select: {
          id: true,
          mobile: true,
          name: true
        }
      },
      customerId: true,
      id: true,
      orderNo: true,
      orderStatus: true
    }
  }
} satisfies Prisma.VehicleHandoverWorkOrderInclude;

const stage2TaskInclude = {
  signers: true
} satisfies Prisma.ContractESignTaskInclude;

type Stage2LifecycleWorkOrder = Prisma.VehicleHandoverWorkOrderGetPayload<{
  include: typeof stage2LifecycleInclude;
}>;
type Stage2Task = Prisma.ContractESignTaskGetPayload<{
  include: typeof stage2TaskInclude;
}>;

export interface Stage2HandoverESignSignerView {
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  nextRetryAt: Date | null;
  retryAvailable: boolean;
  signedAt: Date | null;
  slotId: ESignSlotId;
  status: ESignSignerStatus | null;
}

export interface Stage2HandoverESignView {
  archiveStatus: DeliveryHandoverArchiveStatus | null;
  blockers: Stage2HandoverESignBlocker[];
  canVoid: boolean;
  createdAt: Date | null;
  customerSigner: Stage2HandoverESignSignerView;
  documentType: typeof ESignDocumentType.DELIVERY_HANDOVER;
  handoverId: string | null;
  platformSigner: Stage2HandoverESignSignerView;
  ready: boolean;
  rebuildRequired: boolean;
  signedArtifactAvailable: boolean;
  signingStage: typeof ESignSigningStage.STAGE2_DELIVERY_HANDOVER;
  status: ESignTaskStatus | null;
  taskId: string | null;
  updatedAt: Date | null;
  workOrderId: string;
}

export interface Stage2SignedDocumentState {
  archiveLastAttemptAt: Date | null;
  archiveLastError: string | null;
  archiveRetryCount: number;
  archiveStatus: DeliveryHandoverArchiveStatus | null;
  archivedAt: Date | null;
  available: boolean;
  completedAt: Date | null;
  handoverId: string | null;
  retryAvailable: boolean;
  taskId: string | null;
  workOrderId: string;
}

export interface Stage2PortalESignSignerView {
  signedAt: Date | null;
  slotId: ESignSlotId;
  status: ESignSignerStatus | null;
}

export type Stage2PortalESignBlockerCode =
  | "CUSTOMER_CONFIRMATION_MISSING"
  | "CUSTOMER_OBJECTION_ACTIVE"
  | "EVIDENCE_NOT_READY"
  | "STAGE2_SIGNING_NOT_AVAILABLE";

export interface Stage2PortalESignBlocker {
  code: Stage2PortalESignBlockerCode;
  message: string;
}

export interface Stage2PortalESignView {
  archiveStatus: DeliveryHandoverArchiveStatus | null;
  blockers: Stage2PortalESignBlocker[];
  capability: {
    canStartSigning: boolean;
  };
  createdAt: Date | null;
  customerSigner: Stage2PortalESignSignerView;
  documentType: typeof ESignDocumentType.DELIVERY_HANDOVER;
  handoverId: string | null;
  platformSigner: Stage2PortalESignSignerView;
  ready: boolean;
  signedArtifactAvailable: boolean;
  signingStage: typeof ESignSigningStage.STAGE2_DELIVERY_HANDOVER;
  status: ESignTaskStatus | null;
  taskId: string | null;
  updatedAt: Date | null;
  workOrderId: string;
}

export interface Stage2PortalSigningStartResult {
  expiresAt: Date | null;
  signUrl: string;
}

export interface Stage2ESignInitiator {
  actorId?: string;
  actorType: "ADMIN" | "FIELD_OPERATOR";
  fieldOperatorSessionId?: string;
  fieldOperatorPhone?: string;
}

export interface Stage2ESignReviewAcknowledgement {
  acknowledgement: true;
  artifactVersion: number;
  reviewedAt?: Date;
  sourcePdfHash: string;
}

@Injectable()
export class Stage2HandoverESignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readinessService: Stage2HandoverESignReadinessService,
    @Inject(ESIGN_PROVIDER_CLIENT)
    private readonly provider: ESignProvider,
    private readonly configService: ConfigService,
    @Optional()
    private readonly signedArtifactService?: FadadaSignedArtifactService,
    @Optional()
    private readonly workflowService?: Stage2HandoverWorkflowService
  ) {}

  async getStatus(workOrderId: string): Promise<Stage2HandoverESignView> {
    const [workOrder, readiness] = await Promise.all([
      this.loadWorkOrder(workOrderId),
      this.readinessService.getReadiness(workOrderId)
    ]);
    const task = await this.resolveCurrentTask(workOrder);
    return this.toView(workOrder, task, readiness);
  }

  async getPortalStatus(
    workOrderId: string,
    customerId: string
  ): Promise<Stage2PortalESignView> {
    const [workOrder, readiness] = await Promise.all([
      this.loadOwnedWorkOrder(workOrderId, customerId),
      this.readinessService.getReadiness(workOrderId)
    ]);
    const task = await this.resolveCurrentTask(workOrder);
    const signers = task ? requireTypedSigners(task) : null;
    const canStartSigning = canStartPortalSigning(
      workOrder,
      task,
      readiness,
      customerId
    );
    return {
      archiveStatus: workOrder.handover?.archiveStatus ?? null,
      blockers: canStartSigning ? [] : toPortalBlockers(readiness.blockers),
      capability: {
        canStartSigning
      },
      createdAt:
        task?.createdAt ??
        workOrder.handover?.handoverContract?.createdAt ??
        null,
      customerSigner: toPortalSignerView(
        signers?.customerSigner ?? null,
        CUSTOMER_SLOT_ID
      ),
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      handoverId: workOrder.handover?.id ?? null,
      platformSigner: toPortalSignerView(
        signers?.platformSigner ?? null,
        PLATFORM_SLOT_ID
      ),
      ready: readiness.ready,
      signedArtifactAvailable: Boolean(
        workOrder.handover?.signedDocumentFileId
      ),
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      status: task?.taskStatus ?? null,
      taskId: task?.id ?? null,
      updatedAt:
        task?.updatedAt ?? workOrder.handover?.updatedAt ?? null,
      workOrderId: workOrder.id
    };
  }

  async startPortalSigning(
    workOrderId: string,
    customerId: string
  ): Promise<Stage2PortalSigningStartResult> {
    const workOrder = await this.loadOwnedWorkOrder(workOrderId, customerId);
    const handover = workOrder.handover;
    const task = this.pointerTask(workOrder);
    if (!handover || !task) {
      throw portalSigningNotReady();
    }
    const { customerSigner, platformSigner } = requireTypedSigners(task);
    assertPortalSigningTask(
      workOrder,
      task,
      customerSigner,
      platformSigner,
      customerId
    );
    assertTaskSourceBinding(task, handover);

    const readiness = await this.readinessService.getReadiness(workOrderId);
    assertPortalStartReadiness(workOrder, task, readiness);

    try {
      const refreshed = await this.provider.getSignerUrl({
        contractId: task.contractId,
        providerTaskId: task.providerTaskId ?? task.taskNo,
        redirectUrl: this.buildPortalHandoverUrl(workOrderId),
        signerId: customerSigner.id,
        taskId: task.id
      });
      const signUrl = assertSafeProviderSigningUrl(
        refreshed.signUrl,
        task.provider,
        this.configService
      );
      return {
        expiresAt: refreshed.expiresAt ?? null,
        signUrl
      };
    } catch {
      throw portalSigningUrlUnavailable();
    }
  }

  async create(
    workOrderId: string,
    initiator: Stage2ESignInitiator,
    review?: Stage2ESignReviewAcknowledgement
  ): Promise<Stage2HandoverESignView> {
    const initialWorkOrder = await this.loadWorkOrder(workOrderId);
    const initiation = this.assertCreateInitiator(
      initialWorkOrder,
      initiator,
      review
    );
    const existingActiveTask = await this.findActiveTask(initialWorkOrder);
    if (existingActiveTask) {
      requireTypedSigners(existingActiveTask);
      assertTaskSourceBinding(existingActiveTask, initialWorkOrder.handover);
      return this.toView(initialWorkOrder, existingActiveTask, emptyReadiness(workOrderId));
    }

    const pointerTask = this.pointerTask(initialWorkOrder);
    if (
      pointerTask &&
      TERMINAL_REBUILD_STATUSES.has(pointerTask.taskStatus)
    ) {
      throw new ConflictException({
        code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED,
        message: "The terminal Stage 2 eSign task must be explicitly voided before rebuilding."
      });
    }

    await this.readinessService.assertReady(workOrderId);
    const workOrder = await this.loadWorkOrder(workOrderId);
    const context = this.requireCreationContext(workOrder);
    const coordinates = readStage2Coordinates(
      context.handover.handoverContract.contractSnapshot,
      context.handover.sourceDocumentFileId!
    );
    const customerCoordinate = coordinates.find(
      (coordinate) => coordinate.slotId === "STAGE2_HANDOVER_CUSTOMER"
    )!;
    const providerType = parseProvider(
      this.configService.get<string>("ESIGN_PROVIDER") ?? "mock"
    );
    const now = new Date();

    const task = await withUniqueBusinessNoRetry(() => {
      const taskNo = createBusinessNo("ESG");
      return this.prisma.$transaction(async (tx) => {
        const created = await tx.contractESignTask.create({
          data: {
            contractId: context.handover.handoverContract.id,
            createdBy: initiation.actorUserId,
            customerId: context.order.customer.id,
            documentName:
              context.handover.handoverContract.contractTitle ||
              "Delivery handover confirmation",
            documentType: ESignDocumentType.DELIVERY_HANDOVER,
            orderId: context.order.id,
            provider: providerType,
            requestSnapshot: toJson({
              artifactVersion: context.handover.artifactVersion,
              contractId: context.handover.handoverContract.id,
              documentType: "DELIVERY_HANDOVER",
              handoverId: context.handover.id,
              manifestHash: context.handover.manifestHash,
              ...(initiation.fieldAudit
                ? {
                    initiator: initiation.fieldAudit.initiator,
                    reviewAcknowledgement:
                      initiation.fieldAudit.reviewAcknowledgement
                  }
                : {}),
              signingStage: "STAGE2_DELIVERY_HANDOVER",
              slotIds: [
                "STAGE2_HANDOVER_CUSTOMER",
                "STAGE2_HANDOVER_PLATFORM"
              ],
              sourceDocumentFileId: context.handover.sourceDocumentFileId,
              sourcePdfHash: context.handover.sourcePdfHash
            }),
            signers: {
              create: [
                {
                  customerId: context.order.customer.id,
                  documentType: ESignDocumentType.DELIVERY_HANDOVER,
                  providerActionType:
                    ESignProviderActionType.CUSTOMER_MANUAL_SIGN,
                  required: true,
                  signerName: context.order.customer.name,
                  signerStatus: ESignSignerStatus.PENDING,
                  signerType: ESignSignerType.CUSTOMER,
                  slotId: CUSTOMER_SLOT_ID
                },
                {
                  documentType: ESignDocumentType.DELIVERY_HANDOVER,
                  providerActionType:
                    ESignProviderActionType.PLATFORM_AUTO_SEAL,
                  required: true,
                  signerName: "Platform",
                  signerStatus: ESignSignerStatus.PENDING,
                  signerType: ESignSignerType.PLATFORM,
                  slotId: PLATFORM_SLOT_ID
                }
              ]
            },
            signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
            taskNo,
            taskStatus: ESignTaskStatus.CREATED,
            updatedBy: initiation.actorUserId
          },
          include: stage2TaskInclude
        });
        const claimed = await tx.vehicleDeliveryHandover.updateMany({
          data: {
            failureReason: null,
            handoverESignTaskId: created.id,
            status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
            updatedBy: initiation.actorUserId
          },
          where: {
            handoverContractId: context.handover.handoverContract.id,
            handoverESignTaskId: null,
            id: context.handover.id,
            sourceDocumentFileId: context.handover.sourceDocumentFileId,
            status: DeliveryHandoverStatus.SOURCE_GENERATED
          }
        });
        if (claimed.count !== 1) {
          throw new ConflictException({
            code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
            message: "Another Stage 2 eSign create action already claimed this handover."
          });
        }
        return created;
      });
    });

    const { customerSigner } = requireTypedSigners(task);
    const customerTransactionId = buildTransactionId(task.taskNo, "H1");
    const customerClaimExpiresAt = new Date(now.getTime() + PLATFORM_CLAIM_MS);
    await this.claimCustomerProviderAction({
      actorId: initiation.actorUserId,
      claimExpiresAt: customerClaimExpiresAt,
      contractId: task.contractId,
      customerSignerId: customerSigner.id,
      taskId: task.id,
      taskNo: task.taskNo,
      transactionId: customerTransactionId,
      when: now
    });
    try {
      const providerResult = await this.provider.createSignTask({
        callbackUrl: this.buildCallbackUrl(providerType),
        contractId: context.handover.handoverContract.id,
        documentName:
          context.handover.handoverContract.contractTitle ||
          "Delivery handover confirmation",
        documentType: "DELIVERY_HANDOVER",
        signers: [{
          customerId: context.order.customer.id,
          name: context.order.customer.name,
          phone: context.order.customer.mobile,
          signerType: "CUSTOMER"
        }],
        signingSlotCoordinates: [customerCoordinate],
        signingSlots: [CUSTOMER_SIGNING_SLOT],
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        sourcePdfHash: context.handover.sourcePdfHash!,
        taskId: task.id,
        taskNo: task.taskNo,
        transactionId: customerTransactionId
      });
      const action = requireCustomerProviderAction(providerResult.actions);
      const providerTransactionId = requireProviderTransactionId(
        action.providerTransactionId ?? action.providerSignerId
      );
      if (providerTransactionId !== customerTransactionId) {
        throw new Error("Stage 2 customer provider transaction does not match the local claim.");
      }
      const signUrl = action.signUrl
        ? assertSafeProviderSigningUrl(
            action.signUrl,
            providerType,
            this.configService
          )
        : undefined;
      const startedAt = new Date();

      await this.persistCustomerProviderResult({
        actorId: initiation.actorUserId,
        claimExpiresAt: customerClaimExpiresAt,
        customerSignerId: customerSigner.id,
        handoverId: context.handover.id,
        providerEnvelopeId:
          providerResult.providerEnvelopeId ?? task.taskNo,
        providerSignerId:
          action.providerSignerId ?? providerTransactionId,
        providerTaskId: providerResult.providerTaskId,
        signUrl,
        signUrlExpiresAt: action.signUrlExpiresAt,
        taskId: task.id,
        transactionId: providerTransactionId,
        when: startedAt,
        workOrderId
      });
    } catch (error) {
      if (
        await this.customerProviderActionWasReconciled(
          workOrderId,
          task.id,
          customerSigner.id,
          customerTransactionId
        )
      ) {
        return this.getStatus(workOrderId);
      }
      if (
        error instanceof ConflictException &&
        exceptionCode(error) === STAGE2_HANDOVER_ESIGN_RESULT_STALE
      ) {
        throw error;
      }
      await this.recordCreateFailure(
        context.handover.id,
        task.id,
        customerSigner.id,
        initiation.actorUserId,
        now,
        customerClaimExpiresAt,
        customerTransactionId
      );
      throw new BadGatewayException({
        code: "STAGE2_HANDOVER_ESIGN_PROVIDER_FAILED",
        message: "The Stage 2 customer signing request was not accepted."
      });
    }

    return this.getStatus(workOrderId);
  }

  async retryPlatformSeal(
    workOrderId: string,
    actorId: string
  ): Promise<Stage2HandoverESignView> {
    const workOrder = await this.loadWorkOrder(workOrderId);
    const context = this.requireCreationContext(workOrder);
    const task = this.pointerTask(workOrder);
    if (!task) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_ESIGN_TASK_MISSING",
        message: "A Stage 2 eSign task is required before platform sealing."
      });
    }
    if (
      task.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
      task.documentType !== ESignDocumentType.DELIVERY_HANDOVER
    ) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_ESIGN_TASK_INVALID",
        message: "The linked eSign task is not a typed Stage 2 handover task."
      });
    }
    assertTaskSourceBinding(task, context.handover);

    const { customerSigner, platformSigner } = requireTypedSigners(task);
    if (customerSigner.signerStatus !== ESignSignerStatus.SIGNED) {
      throw new BadRequestException({
        code: "STAGE2_CUSTOMER_SIGNATURE_REQUIRED",
        message: "The customer must sign before the platform seal can be retried."
      });
    }
    if (
      platformSigner.signerStatus !== ESignSignerStatus.PENDING ||
      task.taskStatus === ESignTaskStatus.COMPLETED ||
      TERMINAL_REBUILD_STATUSES.has(task.taskStatus)
    ) {
      throw new BadRequestException({
        code: "STAGE2_PLATFORM_SEAL_NOT_RETRYABLE",
        message: "The platform seal is not in a retryable state."
      });
    }

    const now = new Date();
    if (
      platformSigner.nextRetryAt &&
      platformSigner.nextRetryAt.getTime() > now.getTime()
    ) {
      throw new BadRequestException({
        code: "STAGE2_PLATFORM_SEAL_RETRY_NOT_DUE",
        message: "The platform seal retry is not due yet."
      });
    }
    const claimExpiresAt = new Date(now.getTime() + PLATFORM_CLAIM_MS);
    const platformTransactionId = buildTransactionId(task.taskNo, "H2");
    const claimed = await this.prisma.contractESignSigner.updateMany({
      data: {
        attemptCount: { increment: 1 },
        claimExpiresAt,
        lastAttemptAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        nextRetryAt: null,
        providerTransactionId: platformTransactionId
      },
      where: {
        AND: [
          {
            OR: [
              { claimExpiresAt: null },
              { claimExpiresAt: { lt: now } }
            ]
          },
          {
            OR: [
              { providerTransactionId: null },
              { providerTransactionId: platformTransactionId }
            ]
          }
        ],
        id: platformSigner.id,
        signerStatus: ESignSignerStatus.PENDING,
        slotId: PLATFORM_SLOT_ID,
        taskId: task.id
      }
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
        message: "The platform seal retry is already in progress."
      });
    }

    const platformCoordinate = readStage2Coordinates(
      context.handover.handoverContract.contractSnapshot,
      context.handover.sourceDocumentFileId!
    ).find((coordinate) => coordinate.slotId === "STAGE2_HANDOVER_PLATFORM")!;

    try {
      if (!this.provider.autoSealTask) {
        throw new Error("provider auto seal is unavailable");
      }
      const result = await this.provider.autoSealTask({
        callbackUrl: this.buildCallbackUrl(task.provider),
        contractId: task.contractId,
        documentName:
          context.handover.handoverContract.contractTitle ||
          "Delivery handover confirmation",
        documentType: "DELIVERY_HANDOVER",
        platformCustomerId: requiredConfig(
          this.configService,
          "FADADA_PLATFORM_CUSTOMER_ID"
        ),
        platformSignatureId: requiredConfig(
          this.configService,
          "FADADA_PLATFORM_SIGNATURE_ID"
        ),
        providerEnvelopeId: task.providerEnvelopeId ?? task.taskNo,
        signingSlotCoordinates: [platformCoordinate],
        signingSlots: [PLATFORM_SIGNING_SLOT],
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        taskId: task.id,
        taskNo: task.taskNo,
        transactionId: platformTransactionId
      });
      const providerTransactionId = requireProviderTransactionId(
        result.providerTransactionId ?? result.providerSignerId
      );
      if (providerTransactionId !== platformTransactionId) {
        throw new Error("Stage 2 platform provider transaction does not match the local claim.");
      }
      if (
        result.coveredSlotIds?.length !== 1 ||
        result.coveredSlotIds[0] !== "STAGE2_HANDOVER_PLATFORM" ||
        result.providerActionType !== "PLATFORM_AUTO_SEAL" ||
        result.signingStage !== "STAGE2_DELIVERY_HANDOVER"
      ) {
        throw new Error("invalid Stage 2 platform provider result");
      }
      if (result.status === "FAILED") {
        await this.recordPlatformFailure(
        platformSigner.id,
        result.resultCode ?? STAGE2_PLATFORM_SEAL_PROVIDER_FAILED,
        now,
        claimExpiresAt,
        providerTransactionId
      );
        throw new BadGatewayException({
          code: STAGE2_PLATFORM_SEAL_PROVIDER_FAILED,
          message: "The Stage 2 platform seal request failed and can be retried."
        });
      }

      await this.persistPlatformResult({
        actorId,
        handoverId: context.handover.id,
        platformSignerId: platformSigner.id,
        providerSignerId: result.providerSignerId ?? providerTransactionId,
        providerTransactionId,
        status: result.status,
        task,
        claimExpiresAt,
        when: now
      });
    } catch (error) {
      if (
        await this.platformProviderActionWasReconciled(
          workOrderId,
          task.id,
          platformSigner.id,
          platformTransactionId
        )
      ) {
        return this.getStatus(workOrderId);
      }
      if (
        error instanceof BadGatewayException &&
        exceptionCode(error) === STAGE2_PLATFORM_SEAL_PROVIDER_FAILED
      ) {
        throw error;
      }
      if (
        error instanceof ConflictException &&
        exceptionCode(error) === STAGE2_PLATFORM_SEAL_CLAIM_LOST
      ) {
        throw error;
      }
      await this.recordPlatformFailure(
        platformSigner.id,
        STAGE2_PLATFORM_SEAL_PROVIDER_FAILED,
        now,
        claimExpiresAt
      );
      throw new BadGatewayException({
        code: STAGE2_PLATFORM_SEAL_PROVIDER_FAILED,
        message: "The Stage 2 platform seal request failed and can be retried."
      });
    }

    return this.getStatus(workOrderId);
  }

  async voidTask(
    workOrderId: string,
    actorId: string,
    reason: string
  ): Promise<Stage2HandoverESignView> {
    const normalizedReason = normalizeVoidReason(reason);
    const workOrder = await this.loadWorkOrder(workOrderId);
    const task = this.pointerTask(workOrder);
    const handover = workOrder.handover;
    if (!handover || !task) {
      throw new NotFoundException({
        code: "STAGE2_HANDOVER_ESIGN_TASK_MISSING",
        message: "The Stage 2 eSign task does not exist."
      });
    }
    requireTypedSigners(task);
    if (task.taskStatus === ESignTaskStatus.COMPLETED) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_ESIGN_VOID_NOT_ALLOWED",
        message: "A completed Stage 2 signing task cannot be voided for rebuild."
      });
    }
    if (!VOIDABLE_HANDOVER_STATUSES.has(handover.status)) {
      throw voidNotAllowed();
    }

    const now = new Date();
    const hadFreshProviderClaim = task.signers.some(
      (signer) =>
        signer.required &&
        signer.deletedAt === null &&
        signer.claimExpiresAt &&
        signer.claimExpiresAt.getTime() > now.getTime()
    );
    const hadAcceptedProviderAction =
      !TERMINAL_REBUILD_STATUSES.has(task.taskStatus) &&
      task.signers.some(
        (signer) =>
          signer.required &&
          signer.deletedAt === null &&
          Boolean(signer.providerTransactionId)
      );
    const signerBlockers = [
      { claimExpiresAt: { gt: now } },
      ...(!TERMINAL_REBUILD_STATUSES.has(task.taskStatus)
        ? [{ providerTransactionId: { not: null } }]
        : [])
    ];
    await this.prisma.$transaction(async (tx) => {
      const taskVoided = await tx.contractESignTask.updateMany({
        data: {
          cancelledAt: now,
          errorSnapshot: toJson({
            code: "STAGE2_HANDOVER_ESIGN_VOIDED",
            reason: normalizedReason
          }),
          signUrl: null,
          signUrlExpiresAt: null,
          taskStatus: ESignTaskStatus.CANCELLED,
          updatedBy: actorId
        },
        where: {
          completedAt: null,
          documentType: ESignDocumentType.DELIVERY_HANDOVER,
          id: task.id,
          signers: {
            none: {
              deletedAt: null,
              OR: signerBlockers,
              required: true
            }
          },
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: { in: [...VOIDABLE_TASK_STATUSES] }
        }
      });
      if (taskVoided.count !== 1) {
        if (hadFreshProviderClaim || hadAcceptedProviderAction) {
          throw new ConflictException({
            code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
            message:
              "A required Stage 2 provider action is active or still in progress."
          });
        }
        throw voidNotAllowed();
      }
      await tx.contractESignSigner.updateMany({
        data: {
          claimExpiresAt: null,
          lastErrorCode: "STAGE2_HANDOVER_ESIGN_VOIDED",
          lastErrorMessage: normalizedReason,
          nextRetryAt: null,
          signUrl: null,
          signUrlExpiresAt: null
        },
        where: {
          taskId: task.id
        }
      });
      if (handover.handoverContractId) {
        await tx.contract.updateMany({
          data: {
            signedAt: null,
            status: ContractStatus.GENERATED,
            updatedBy: actorId
          },
          where: {
            id: handover.handoverContractId,
            status: ContractStatus.SIGNING
          }
        });
      }
      const released = await tx.vehicleDeliveryHandover.updateMany({
        data: {
          failureReason: `Stage 2 eSign voided: ${normalizedReason}`,
          handoverESignTaskId: null,
          status: DeliveryHandoverStatus.SOURCE_GENERATED,
          updatedBy: actorId
        },
        where: {
          handoverESignTaskId: task.id,
          id: handover.id,
          status: handover.status
        }
      });
      if (released.count !== 1) {
        throw new ConflictException({
          code: STAGE2_HANDOVER_ESIGN_ALREADY_CLAIMED,
          message: "The Stage 2 eSign pointer changed before it could be voided."
        });
      }
    });

    return this.getStatus(workOrderId);
  }

  async getSignedDocumentState(
    workOrderId: string
  ): Promise<Stage2SignedDocumentState> {
    const workOrder = await this.loadWorkOrder(workOrderId);
    const handover = workOrder.handover;
    const task = await this.resolveCurrentTask(workOrder);
    if (task) {
      requireTypedSigners(task);
    }
    return {
      archiveLastAttemptAt: handover?.archiveLastAttemptAt ?? null,
      archiveLastError: sanitizeArchiveError(handover?.archiveLastError),
      archiveRetryCount: handover?.archiveRetryCount ?? 0,
      archiveStatus: handover?.archiveStatus ?? null,
      archivedAt: handover?.archivedAt ?? null,
      available: Boolean(handover?.signedDocumentFileId),
      completedAt: handover?.completedAt ?? null,
      handoverId: handover?.id ?? null,
      retryAvailable: Boolean(
        handover &&
        task?.taskStatus === ESignTaskStatus.COMPLETED &&
        handover.status === DeliveryHandoverStatus.SIGNED &&
        (
          handover.archiveStatus === DeliveryHandoverArchiveStatus.NOT_STARTED ||
          handover.archiveStatus === DeliveryHandoverArchiveStatus.FAILED
        )
      ),
      taskId: task?.id ?? null,
      workOrderId
    };
  }

  async retryArchive(
    workOrderId: string,
    actorId: string
  ): Promise<Stage2SignedDocumentState> {
    const workOrder = await this.loadWorkOrder(workOrderId);
    const handover = workOrder.handover;
    const task = this.pointerTask(workOrder);
    if (!handover || !task) {
      throw new NotFoundException({
        code: "STAGE2_HANDOVER_ESIGN_TASK_MISSING",
        message: "The Stage 2 eSign task does not exist."
      });
    }
    const { customerSigner, platformSigner } = requireTypedSigners(task);
    if (
      task.taskStatus !== ESignTaskStatus.COMPLETED ||
      !task.completedAt ||
      customerSigner.signerStatus !== ESignSignerStatus.SIGNED ||
      platformSigner.signerStatus !== ESignSignerStatus.SIGNED ||
      (
        handover.status !== DeliveryHandoverStatus.SIGNED &&
        handover.status !== DeliveryHandoverStatus.ARCHIVED
      )
    ) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_ARCHIVE_NOT_READY",
        message: "Both required Stage 2 signers must complete before archive retry."
      });
    }
    assertTaskSourceBinding(task, handover);
    if (!this.signedArtifactService) {
      throw new BadGatewayException({
        code: "STAGE2_HANDOVER_ARCHIVE_UNAVAILABLE",
        message: "The Stage 2 signed artifact service is unavailable."
      });
    }

    await this.signedArtifactService.archiveSignedStage2Handover({
      actorId,
      taskId: task.id
    });
    return this.getSignedDocumentState(workOrderId);
  }

  private async loadWorkOrder(workOrderId: string) {
    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({
      include: stage2LifecycleInclude,
      where: { id: workOrderId }
    });
    if (!workOrder) {
      throw new NotFoundException({
        code: "STAGE2_HANDOVER_WORK_ORDER_MISSING",
        message: "The handover work order does not exist."
      });
    }
    return workOrder;
  }

  private async loadOwnedWorkOrder(workOrderId: string, customerId: string) {
    const workOrder = await this.loadWorkOrder(workOrderId);
    if (
      workOrder.order.customerId !== customerId ||
      workOrder.order.customer.id !== customerId
    ) {
      throw new NotFoundException({
        code: "STAGE2_HANDOVER_WORK_ORDER_MISSING",
        message: "The handover work order does not exist."
      });
    }
    return workOrder;
  }

  private pointerTask(workOrder: Stage2LifecycleWorkOrder) {
    const handover = workOrder.handover;
    if (
      !handover?.handoverESignTaskId ||
      handover.handoverESignTask?.id !== handover.handoverESignTaskId ||
      Boolean(handover.handoverESignTask.deletedAt) ||
      handover.handoverESignTask.signingStage !==
        ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
      handover.handoverESignTask.documentType !==
        ESignDocumentType.DELIVERY_HANDOVER
    ) {
      return null;
    }
    return handover.handoverESignTask;
  }

  private async findActiveTask(workOrder: Stage2LifecycleWorkOrder) {
    const pointer = this.pointerTask(workOrder);
    const contractId = workOrder.handover?.handoverContractId;
    if (!contractId) {
      return null;
    }
    const contractTask = await this.prisma.contractESignTask.findFirst({
      include: stage2TaskInclude,
      orderBy: { createdAt: "desc" },
      where: {
        contractId,
        deletedAt: null,
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
        taskStatus: { in: [...ACTIVE_TASK_STATUSES] }
      }
    });
    if (contractTask && pointer?.id !== contractTask.id) {
      throw orphanConflict();
    }
    if (
      pointer &&
      ACTIVE_TASK_STATUSES.includes(pointer.taskStatus as typeof ACTIVE_TASK_STATUSES[number])
    ) {
      return pointer;
    }
    return null;
  }

  private async resolveCurrentTask(workOrder: Stage2LifecycleWorkOrder) {
    const pointer = this.pointerTask(workOrder);
    const contractId = workOrder.handover?.handoverContractId;
    if (!contractId) {
      return pointer;
    }
    const contractTask = await this.prisma.contractESignTask.findFirst({
      include: stage2TaskInclude,
      orderBy: { createdAt: "desc" },
      where: {
        contractId,
        deletedAt: null,
        signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER
      }
    });
    if (
      contractTask &&
      ACTIVE_TASK_STATUSES.includes(
        contractTask.taskStatus as typeof ACTIVE_TASK_STATUSES[number]
      ) &&
      pointer?.id !== contractTask.id
    ) {
      throw orphanConflict();
    }
    return pointer ?? contractTask;
  }

  private requireCreationContext(workOrder: Stage2LifecycleWorkOrder) {
    const handover = workOrder.handover;
    if (
      !handover ||
      !handover.handoverContract ||
      !handover.handoverContractId ||
      handover.handoverContract.id !== handover.handoverContractId ||
      !handover.sourceDocumentFileId ||
      handover.handoverContract.fileId !== handover.sourceDocumentFileId ||
      !isSha256Digest(handover.sourcePdfHash)
    ) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_SOURCE_INVALID",
        message: "The generated Stage 2 source PDF is not available."
      });
    }
    return {
      handover: {
        ...handover,
        handoverContract: handover.handoverContract
      },
      order: workOrder.order
    };
  }

  private assertCreateInitiator(
    workOrder: Stage2LifecycleWorkOrder,
    initiator: Stage2ESignInitiator,
    review?: Stage2ESignReviewAcknowledgement
  ) {
    const workflowEnabled = this.isStage2HandoverWorkflowEnabled();
    if (workflowEnabled && initiator.actorType !== "FIELD_OPERATOR") {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_FIELD_INITIATOR_REQUIRED",
        message: "The Stage 2 workflow must be initiated by the assigned Field operator."
      });
    }
    if (!workflowEnabled && initiator.actorType !== "ADMIN") {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_FIELD_WORKFLOW_DISABLED",
        message: "Field Stage 2 eSign initiation is disabled."
      });
    }
    if (initiator.actorType === "ADMIN") {
      const actorId = initiator.actorId?.trim();
      if (!actorId) {
        throw new BadRequestException("An Admin initiator is required.");
      }
      return {
        actorUserId: actorId,
        fieldAudit: null
      };
    }

    const fieldOperatorSessionId = initiator.fieldOperatorSessionId?.trim();
    const fieldOperatorPhone = initiator.fieldOperatorPhone
      ? normalizeFieldOperatorPhone(initiator.fieldOperatorPhone)
      : null;
    if (
      !fieldOperatorSessionId ||
      !fieldOperatorPhone ||
      workOrder.fieldOperatorPhone !== fieldOperatorPhone
    ) {
      throw new UnauthorizedException(
        "No access to this field handover work order."
      );
    }
    const handover = workOrder.handover;
    const sourcePdfHash =
      typeof review?.sourcePdfHash === "string"
        ? review.sourcePdfHash.trim().toLowerCase()
        : null;
    if (
      review?.acknowledgement !== true ||
      !handover ||
      !Number.isSafeInteger(review.artifactVersion) ||
      review.artifactVersion <= 0 ||
      review.artifactVersion !== handover.artifactVersion ||
      !isSha256Digest(sourcePdfHash) ||
      sourcePdfHash !== handover.sourcePdfHash
    ) {
      throw new ConflictException({
        code: "STAGE2_HANDOVER_FIELD_REVIEW_STALE",
        message: "The reviewed Stage 2 source PDF is stale."
      });
    }
    const reviewedAt =
      review.reviewedAt === undefined ? new Date() : review.reviewedAt;
    if (
      !(reviewedAt instanceof Date) ||
      !Number.isFinite(reviewedAt.getTime())
    ) {
      throw new BadRequestException(
        "The Stage 2 source PDF review timestamp is invalid."
      );
    }
    return {
      actorUserId: null,
      fieldAudit: {
        initiator: {
          actorType: "FIELD_OPERATOR" as const,
          fieldOperatorPhone,
          fieldOperatorSessionId
        },
        reviewAcknowledgement: {
          acknowledgement: true as const,
          artifactVersion: review.artifactVersion,
          reviewedAt: reviewedAt.toISOString(),
          sourcePdfHash
        }
      }
    };
  }

  private isStage2HandoverWorkflowEnabled() {
    return this.configService
      .get<string>(STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV)
      ?.trim()
      .toLowerCase() === "true";
  }

  private async claimCustomerProviderAction(input: {
    actorId: string | null;
    claimExpiresAt: Date;
    contractId: string;
    customerSignerId: string;
    taskId: string;
    taskNo: string;
    transactionId: string;
    when: Date;
  }) {
    await this.prisma.$transaction(async (tx) => {
      const signerClaimed = await tx.contractESignSigner.updateMany({
        data: {
          attemptCount: { increment: 1 },
          claimExpiresAt: input.claimExpiresAt,
          lastAttemptAt: input.when,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          providerTransactionId: input.transactionId
        },
        where: {
          claimExpiresAt: null,
          id: input.customerSignerId,
          providerTransactionId: null,
          signerStatus: ESignSignerStatus.PENDING,
          slotId: CUSTOMER_SLOT_ID,
          taskId: input.taskId
        }
      });
      if (signerClaimed.count !== 1) {
        throw staleCreateResult();
      }
      const taskClaimed = await tx.contractESignTask.updateMany({
        data: {
          providerEnvelopeId: input.taskNo,
          providerTaskId: input.transactionId,
          startedAt: input.when,
          taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
          updatedBy: input.actorId
        },
        where: {
          id: input.taskId,
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: ESignTaskStatus.CREATED
        }
      });
      if (taskClaimed.count !== 1) {
        throw staleCreateResult();
      }
      const contractClaimed = await tx.contract.updateMany({
        data: {
          status: ContractStatus.SIGNING,
          updatedBy: input.actorId
        },
        where: {
          id: input.contractId,
          status: ContractStatus.GENERATED
        }
      });
      if (contractClaimed.count !== 1) {
        throw staleCreateResult();
      }
    });
  }

  private async persistCustomerProviderResult(input: {
    actorId: string | null;
    claimExpiresAt: Date;
    customerSignerId: string;
    handoverId: string;
    providerEnvelopeId: string;
    providerSignerId: string;
    providerTaskId: string;
    signUrl?: string;
    signUrlExpiresAt?: Date;
    taskId: string;
    transactionId: string;
    when: Date;
    workOrderId: string;
  }) {
    await this.prisma.$transaction(async (tx) => {
      const signerUpdated = await tx.contractESignSigner.updateMany({
        data: {
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          providerSignerId: input.providerSignerId,
          signUrl: input.signUrl,
          signUrlExpiresAt: input.signUrlExpiresAt,
          signerStatus: input.signUrl
            ? ESignSignerStatus.SIGNING
            : ESignSignerStatus.PENDING
        },
        where: {
          claimExpiresAt: input.claimExpiresAt,
          id: input.customerSignerId,
          providerTransactionId: input.transactionId,
          signerStatus: ESignSignerStatus.PENDING,
          slotId: CUSTOMER_SLOT_ID,
          taskId: input.taskId
        }
      });
      if (signerUpdated.count !== 1) {
        throw staleCreateResult();
      }
      const taskUpdated = await tx.contractESignTask.updateMany({
        data: {
          providerEnvelopeId: input.providerEnvelopeId,
          providerTaskId: input.providerTaskId,
          responseSnapshot: toJson({
            accepted: true,
            action: "CUSTOMER_MANUAL_SIGN",
            coveredSlotIds: ["STAGE2_HANDOVER_CUSTOMER"],
            signUrlExpiresAt: input.signUrlExpiresAt?.toISOString() ?? null,
            signingStage: "STAGE2_DELIVERY_HANDOVER"
          }),
          startedAt: input.when,
          updatedBy: input.actorId
        },
        where: {
          id: input.taskId,
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: ESignTaskStatus.WAITING_CUSTOMER
        }
      });
      if (taskUpdated.count !== 1) {
        throw staleCreateResult();
      }
      const handoverUpdated = await tx.vehicleDeliveryHandover.updateMany({
        data: {
          status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
          updatedBy: input.actorId
        },
        where: {
          handoverESignTaskId: input.taskId,
          id: input.handoverId
        }
      });
      if (handoverUpdated.count !== 1) {
        throw staleCreateResult();
      }
      if (this.isStage2HandoverWorkflowEnabled()) {
        if (!this.workflowService) {
          throw new Error("STAGE2_HANDOVER_WORKFLOW_SERVICE_UNAVAILABLE");
        }
        await this.workflowService.enqueueCustomerESignJobs(tx, {
          customerTransactionId: input.transactionId,
          eSignTaskId: input.taskId,
          handoverId: input.handoverId,
          initiatedAt: input.when,
          workOrderId: input.workOrderId
        });
      }
    });
  }

  private async customerProviderActionWasReconciled(
    workOrderId: string,
    taskId: string,
    signerId: string,
    transactionId: string
  ) {
    const current = await this.loadWorkOrder(workOrderId);
    const task = this.pointerTask(current);
    if (!task || task.id !== taskId) {
      return false;
    }
    const signer = task.signers.find((item) => item.id === signerId);
    return Boolean(
      signer &&
      signer.providerTransactionId === transactionId &&
      signer.signerStatus === ESignSignerStatus.SIGNED
    );
  }

  private async platformProviderActionWasReconciled(
    workOrderId: string,
    taskId: string,
    signerId: string,
    transactionId: string
  ) {
    const current = await this.loadWorkOrder(workOrderId);
    const task = this.pointerTask(current);
    if (!task || task.id !== taskId) {
      return false;
    }
    const signer = task.signers.find((item) => item.id === signerId);
    return Boolean(
      signer &&
      signer.providerTransactionId === transactionId &&
      signer.signerStatus === ESignSignerStatus.SIGNED
    );
  }

  private async recordCreateFailure(
    handoverId: string,
    taskId: string,
    customerSignerId: string,
    actorId: string | null,
    attemptedAt: Date,
    claimExpiresAt: Date,
    transactionId: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      const taskUpdated = await tx.contractESignTask.updateMany({
        data: {
          errorSnapshot: toJson({
            code: "STAGE2_HANDOVER_ESIGN_PROVIDER_RESULT_AMBIGUOUS"
          }),
          updatedBy: actorId
        },
        where: {
          id: taskId,
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: ESignTaskStatus.WAITING_CUSTOMER
        }
      });
      if (taskUpdated.count !== 1) {
        throw staleCreateResult();
      }
      const handoverUpdated = await tx.vehicleDeliveryHandover.updateMany({
        data: {
          failureReason:
            "Stage 2 customer signing initiation has an ambiguous provider result.",
          status: DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
          updatedBy: actorId
        },
        where: {
          handoverESignTaskId: taskId,
          id: handoverId
        }
      });
      if (handoverUpdated.count !== 1) {
        throw staleCreateResult();
      }
      const signerUpdated = await tx.contractESignSigner.updateMany({
        data: {
          lastErrorCode: "STAGE2_HANDOVER_ESIGN_PROVIDER_RESULT_AMBIGUOUS",
          lastErrorMessage:
            "Customer signing initiation has an ambiguous provider result.",
          nextRetryAt: claimExpiresAt,
          signerStatus: ESignSignerStatus.PENDING
        },
        where: {
          claimExpiresAt,
          id: customerSignerId,
          providerTransactionId: transactionId,
          signerStatus: ESignSignerStatus.PENDING
        }
      });
      if (signerUpdated.count !== 1) {
        throw staleCreateResult();
      }
    });
  }

  private async recordPlatformFailure(
    platformSignerId: string,
    code: string,
    attemptedAt: Date,
    claimExpiresAt: Date,
    providerTransactionId?: string
  ) {
    const updated = await this.prisma.contractESignSigner.updateMany({
      data: {
        claimExpiresAt: null,
        lastErrorCode: sanitizeCode(code),
        lastErrorMessage: "Platform seal request failed and can be retried.",
        nextRetryAt: attemptedAt,
        ...(providerTransactionId ? { providerTransactionId } : {}),
        signerStatus: ESignSignerStatus.PENDING
      },
      where: {
        claimExpiresAt,
        id: platformSignerId,
        signerStatus: ESignSignerStatus.PENDING,
        slotId: PLATFORM_SLOT_ID
      }
    });
    if (updated.count !== 1) {
      throw lostPlatformClaim();
    }
  }

  private async persistPlatformResult(input: {
    actorId: string;
    handoverId: string;
    platformSignerId: string;
    providerSignerId: string;
    providerTransactionId: string;
    status: "COMPLETED" | "PENDING";
    task: Stage2Task;
    claimExpiresAt: Date;
    when: Date;
  }) {
    const completed = input.status === "COMPLETED";
    await this.prisma.$transaction(async (tx) => {
      const signerUpdated = await tx.contractESignSigner.updateMany({
        data: {
          claimExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextRetryAt: null,
          providerSignerId: input.providerSignerId,
          providerTransactionId: input.providerTransactionId,
          signedAt: completed ? input.when : null,
          signerStatus: completed
            ? ESignSignerStatus.SIGNED
            : ESignSignerStatus.SIGNING
        },
        where: {
          claimExpiresAt: input.claimExpiresAt,
          id: input.platformSignerId,
          signerStatus: ESignSignerStatus.PENDING,
          slotId: PLATFORM_SLOT_ID,
          taskId: input.task.id
        }
      });
      if (signerUpdated.count !== 1) {
        throw lostPlatformClaim();
      }
      const taskUpdated = await tx.contractESignTask.updateMany({
        data: {
          completedAt: completed ? input.when : null,
          taskStatus: completed
            ? ESignTaskStatus.COMPLETED
            : ESignTaskStatus.SIGNING,
          updatedBy: input.actorId
        },
        where: {
          id: input.task.id,
          signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
          taskStatus: {
            in: [
              ESignTaskStatus.WAITING_CUSTOMER,
              ESignTaskStatus.SIGNING
            ]
          }
        }
      });
      if (taskUpdated.count !== 1) {
        throw lostPlatformClaim();
      }
      const handoverUpdated = await tx.vehicleDeliveryHandover.updateMany({
        data: {
          completedAt: completed ? input.when : null,
          platformSignedAt: completed ? input.when : null,
          status: completed
            ? DeliveryHandoverStatus.SIGNED
            : DeliveryHandoverStatus.PENDING_PLATFORM_SEAL,
          updatedBy: input.actorId
        },
        where: {
          handoverESignTaskId: input.task.id,
          id: input.handoverId
        }
      });
      if (handoverUpdated.count !== 1) {
        throw lostPlatformClaim();
      }
      if (completed) {
        await tx.contract.update({
          data: {
            signedAt: input.when,
            status: ContractStatus.SIGNED,
            updatedBy: input.actorId
          },
          where: { id: input.task.contractId }
        });
      }
    });
  }

  private toView(
    workOrder: Stage2LifecycleWorkOrder,
    task: Stage2Task | null,
    readiness: Stage2HandoverESignReadiness
  ): Stage2HandoverESignView {
    const handover = workOrder.handover;
    const signers = task ? requireTypedSigners(task) : null;
    const customerSigner = signers?.customerSigner ?? null;
    const platformSigner = signers?.platformSigner ?? null;
    const customerSigned =
      customerSigner?.signerStatus === ESignSignerStatus.SIGNED;
    return {
      archiveStatus: handover?.archiveStatus ?? null,
      blockers: readiness.blockers,
      canVoid: Boolean(
        task &&
        task.taskStatus !== ESignTaskStatus.COMPLETED &&
        (
          TERMINAL_REBUILD_STATUSES.has(task.taskStatus) ||
          !task.signers.some(
            (signer) =>
              signer.required &&
              signer.deletedAt === null &&
              Boolean(signer.providerTransactionId)
          )
        ) &&
        !task.signers.some(
          (signer) =>
            signer.required &&
            signer.deletedAt === null &&
            signer.claimExpiresAt &&
            signer.claimExpiresAt.getTime() > Date.now()
        )
      ),
      createdAt: task?.createdAt ?? handover?.handoverContract?.createdAt ?? null,
      customerSigner: toSignerView(
        customerSigner,
        CUSTOMER_SLOT_ID,
        false
      ),
      documentType: ESignDocumentType.DELIVERY_HANDOVER,
      handoverId: handover?.id ?? null,
      platformSigner: toSignerView(
        platformSigner,
        PLATFORM_SLOT_ID,
        Boolean(
          customerSigned &&
          platformSigner?.signerStatus === ESignSignerStatus.PENDING &&
          (!platformSigner.claimExpiresAt ||
            platformSigner.claimExpiresAt.getTime() <= Date.now()) &&
          (!platformSigner.nextRetryAt ||
            platformSigner.nextRetryAt.getTime() <= Date.now())
        )
      ),
      ready: readiness.ready,
      rebuildRequired: Boolean(
        task &&
        (
          (
            handover?.handoverESignTaskId === task.id &&
            TERMINAL_REBUILD_STATUSES.has(task.taskStatus)
          ) ||
          !taskMatchesSourceBinding(task, handover)
        )
      ),
      signedArtifactAvailable: Boolean(handover?.signedDocumentFileId),
      signingStage: ESignSigningStage.STAGE2_DELIVERY_HANDOVER,
      status: task?.taskStatus ?? null,
      taskId: task?.id ?? null,
      updatedAt: task?.updatedAt ?? handover?.updatedAt ?? null,
      workOrderId: workOrder.id
    };
  }

  private buildCallbackUrl(provider: ESignProviderType) {
    const apiBaseUrl = (
      this.configService.get<string>("API_BASE_URL") ??
      "http://localhost:3001/api"
    ).replace(/\/+$/, "");
    return `${apiBaseUrl}/esign/callback/${provider.toLowerCase()}`;
  }

  private buildPortalHandoverUrl(workOrderId: string) {
    const portalBaseUrl = (
      this.configService.get<string>("PORTAL_BASE_URL") ??
      "http://localhost:3000"
    ).replace(/\/+$/, "");
    return `${portalBaseUrl}/portal/handover-reviews/${encodeURIComponent(workOrderId)}`;
  }
}

type Stage2Signer = Stage2Task["signers"][number];

function requireTypedSigners(task: Stage2Task) {
  if (
    task.signers.length !== 2 ||
    task.signers.some((signer) => signer.deletedAt !== null)
  ) {
    throw invalidSignerSet();
  }
  const customerMatches = task.signers.filter((signer) =>
    signerMatchesTuple(
      signer,
      CUSTOMER_SLOT_ID,
      ESignSignerType.CUSTOMER,
      ESignProviderActionType.CUSTOMER_MANUAL_SIGN
    )
  );
  const platformMatches = task.signers.filter((signer) =>
    signerMatchesTuple(
      signer,
      PLATFORM_SLOT_ID,
      ESignSignerType.PLATFORM,
      ESignProviderActionType.PLATFORM_AUTO_SEAL
    )
  );
  if (customerMatches.length !== 1 || platformMatches.length !== 1) {
    throw invalidSignerSet();
  }
  return {
    customerSigner: customerMatches[0]!,
    platformSigner: platformMatches[0]!
  };
}

function signerMatchesTuple(
  signer: Stage2Signer,
  slotId: ESignSlotId,
  signerType: ESignSignerType,
  providerActionType: ESignProviderActionType
) {
  return (
    signer.deletedAt === null &&
    signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
    signer.providerActionType === providerActionType &&
    signer.required === true &&
    signer.signerType === signerType &&
    signer.slotId === slotId
  );
}

function invalidSignerSet() {
  return new BadRequestException({
    code: "STAGE2_HANDOVER_ESIGN_SIGNERS_INVALID",
    message: "Exactly two complete typed Stage 2 signers are required."
  });
}

function assertPortalSigningTask(
  workOrder: Stage2LifecycleWorkOrder,
  task: Stage2Task,
  customerSigner: Stage2Signer,
  platformSigner: Stage2Signer,
  customerId: string
) {
  if (
    !PORTAL_START_TASK_STATUSES.has(task.taskStatus) ||
    task.customerId !== customerId ||
    task.orderId !== workOrder.order.id ||
    task.contractId !== workOrder.handover?.handoverContractId ||
    workOrder.handover?.status !==
      DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE ||
    workOrder.handover.handoverContract?.status !== ContractStatus.SIGNING ||
    customerSigner.customerId !== customerId ||
    !PORTAL_START_CUSTOMER_SIGNER_STATUSES.has(
      customerSigner.signerStatus
    ) ||
    platformSigner.signerStatus !== ESignSignerStatus.PENDING ||
    !requireProviderTransactionIdOrNull(customerSigner.providerTransactionId)
  ) {
    throw portalSigningNotReady();
  }
}

function assertPortalStartReadiness(
  workOrder: Stage2LifecycleWorkOrder,
  task: Stage2Task,
  readiness: Stage2HandoverESignReadiness
) {
  const stateMatches =
    readiness.state.esignTaskId === task.id &&
    readiness.state.esignTaskStatus === task.taskStatus &&
    readiness.state.handoverContractId ===
      workOrder.handover?.handoverContractId &&
    readiness.state.handoverId === workOrder.handover?.id &&
    readiness.state.handoverStatus === workOrder.handover?.status &&
    readiness.state.orderId === workOrder.order.id &&
    readiness.state.orderStatus === workOrder.order.orderStatus &&
    readiness.state.workOrderId === workOrder.id &&
    readiness.state.workOrderStatus === workOrder.status;
  const hasUnexpectedBlocker = readiness.blockers.some(
    (blocker) => !PORTAL_START_EXPECTED_READINESS_BLOCKERS.has(blocker.code)
  );
  if (!stateMatches || hasUnexpectedBlocker) {
    throw new BadRequestException({
      blockers: toPortalBlockers(readiness.blockers),
      code: STAGE2_HANDOVER_ESIGN_NOT_READY,
      message: "Stage 2 handover eSign is not ready.",
      ready: false,
      state: readiness.state
    });
  }
}

function canStartPortalSigning(
  workOrder: Stage2LifecycleWorkOrder,
  task: Stage2Task | null,
  readiness: Stage2HandoverESignReadiness,
  customerId: string
) {
  if (!task) {
    return false;
  }
  try {
    const { customerSigner, platformSigner } = requireTypedSigners(task);
    assertPortalSigningTask(
      workOrder,
      task,
      customerSigner,
      platformSigner,
      customerId
    );
    assertTaskSourceBinding(task, workOrder.handover);
    assertPortalStartReadiness(workOrder, task, readiness);
    return true;
  } catch {
    return false;
  }
}

function requireProviderTransactionIdOrNull(value: string | null | undefined) {
  return Boolean(value && /^[A-Za-z0-9]{1,32}$/.test(value));
}

function portalSigningNotReady() {
  return new BadRequestException({
    code: "STAGE2_PORTAL_SIGNING_NOT_READY",
    message: "The customer Stage 2 signing action is not available."
  });
}

function portalSigningUrlUnavailable() {
  return new BadGatewayException({
    code: "STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE",
    message: "The customer signing link is temporarily unavailable."
  });
}

const PORTAL_BLOCKER_MESSAGES: Record<
  Exclude<
    Stage2PortalESignBlockerCode,
    "STAGE2_SIGNING_NOT_AVAILABLE"
  >,
  string
> = {
  CUSTOMER_CONFIRMATION_MISSING:
    "Customer no-objection confirmation is required.",
  CUSTOMER_OBJECTION_ACTIVE:
    "The customer has an active handover objection.",
  EVIDENCE_NOT_READY: "Required handover evidence is not ready."
};

const PORTAL_GENERIC_BLOCKER: Stage2PortalESignBlocker = {
  code: "STAGE2_SIGNING_NOT_AVAILABLE",
  message: "Stage 2 signing is not currently available."
};

function toPortalBlockers(
  blockers: Stage2HandoverESignBlocker[]
): Stage2PortalESignBlocker[] {
  const portalBlockers: Stage2PortalESignBlocker[] = [];
  for (const blocker of blockers) {
    const safeMessage =
      blocker.code in PORTAL_BLOCKER_MESSAGES
        ? PORTAL_BLOCKER_MESSAGES[
            blocker.code as keyof typeof PORTAL_BLOCKER_MESSAGES
          ]
        : null;
    const mapped: Stage2PortalESignBlocker = safeMessage
      ? {
          code: blocker.code as keyof typeof PORTAL_BLOCKER_MESSAGES,
          message: safeMessage
        }
      : PORTAL_GENERIC_BLOCKER;
    if (!portalBlockers.some((existing) => existing.code === mapped.code)) {
      portalBlockers.push(mapped);
    }
  }
  return portalBlockers;
}

function toPortalSignerView(
  signer: Stage2Signer | null,
  slotId: ESignSlotId
): Stage2PortalESignSignerView {
  return {
    signedAt: signer?.signedAt ?? null,
    slotId,
    status: signer?.signerStatus ?? null
  };
}

function toSignerView(
  signer: Stage2Signer | null,
  slotId: ESignSlotId,
  retryAvailable: boolean
): Stage2HandoverESignSignerView {
  return {
    attemptCount: signer?.attemptCount ?? 0,
    lastAttemptAt: signer?.lastAttemptAt ?? null,
    lastErrorCode: signer?.lastErrorCode ?? null,
    nextRetryAt: signer?.nextRetryAt ?? null,
    retryAvailable,
    signedAt: signer?.signedAt ?? null,
    slotId,
    status: signer?.signerStatus ?? null
  };
}

function requireCustomerProviderAction(
  actions: ESignProviderActionResult[] | undefined
) {
  const matches = (actions ?? []).filter(
    (action) =>
      action.coveredSlotIds?.length === 1 &&
      action.coveredSlotIds[0] === "STAGE2_HANDOVER_CUSTOMER" &&
      action.providerActionType === "CUSTOMER_MANUAL_SIGN" &&
      action.signerType === "CUSTOMER" &&
      action.signingStage === "STAGE2_DELIVERY_HANDOVER" &&
      Boolean(action.providerTransactionId ?? action.providerSignerId)
  );
  if (matches.length !== 1) {
    throw new Error("invalid Stage 2 customer provider result");
  }
  return matches[0]!;
}

function readStage2Coordinates(
  snapshot: Prisma.JsonValue,
  expectedFileId: string
) {
  const root = asRecord(snapshot);
  const artifact = asRecord(root?.stage2HandoverPdfArtifact);
  const pageCount = artifact?.pageCount;
  const rawCoordinates = artifact?.slotCoordinates;
  if (
    artifact?.artifactKind !== "stage2-handover-pdf-source" ||
    artifact?.documentType !== "DELIVERY_HANDOVER" ||
    artifact?.fileId !== expectedFileId ||
    artifact?.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
    !Number.isInteger(pageCount) ||
    (pageCount as number) <= 0 ||
    !Array.isArray(rawCoordinates) ||
    rawCoordinates.length !== 2
  ) {
    throw new BadRequestException({
      code: "STAGE2_HANDOVER_SIGNING_SLOTS_INVALID",
      message: "The persisted Stage 2 signing slots are invalid."
    });
  }

  const coordinates = rawCoordinates.map((value) => {
    const coordinate = asRecord(value);
    if (
      !coordinate ||
      coordinate.documentType !== "DELIVERY_HANDOVER" ||
      coordinate.signingStage !== "STAGE2_DELIVERY_HANDOVER" ||
      coordinate.coordinateSystem !== "FADADA_800_1131_TOP_LEFT" ||
      coordinate.pageNumber !== (pageCount as number) - 1 ||
      !isCoordinateNumber(coordinate.x, 0, 800) ||
      !isCoordinateNumber(coordinate.y, 0, 1131) ||
      (
        coordinate.slotId !== "STAGE2_HANDOVER_CUSTOMER" &&
        coordinate.slotId !== "STAGE2_HANDOVER_PLATFORM"
      )
    ) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_SIGNING_SLOTS_INVALID",
        message: "The persisted Stage 2 signing slots are invalid."
      });
    }
    return {
      pageNumber: coordinate.pageNumber as number,
      slotId: coordinate.slotId,
      x: coordinate.x as number,
      y: coordinate.y as number
    } satisfies ESignSigningSlotCoordinate;
  });

  for (const slotId of [
    "STAGE2_HANDOVER_CUSTOMER",
    "STAGE2_HANDOVER_PLATFORM"
  ] as const) {
    if (coordinates.filter((coordinate) => coordinate.slotId === slotId).length !== 1) {
      throw new BadRequestException({
        code: "STAGE2_HANDOVER_SIGNING_SLOTS_INVALID",
        message: "The persisted Stage 2 signing slots are invalid."
      });
    }
  }
  return coordinates;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isCoordinateNumber(value: unknown, min: number, max: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function parseProvider(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized in ESignProviderType) {
    return ESignProviderType[normalized as keyof typeof ESignProviderType];
  }
  throw new BadRequestException({
    code: "STAGE2_HANDOVER_ESIGN_PROVIDER_UNSUPPORTED",
    message: "The configured eSign provider is unsupported."
  });
}

function requiredConfig(config: ConfigService, key: string) {
  const value = config.get<string>(key)?.trim();
  if (!value) {
    throw new Error("required platform eSign configuration is missing");
  }
  return value;
}

function requireProviderTransactionId(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9]{1,32}$/.test(value)) {
    throw new Error("Stage 2 provider transaction ID is invalid.");
  }
  return value;
}

function isSha256Digest(value: string | null | undefined) {
  return Boolean(value && /^[a-f0-9]{64}$/i.test(value.trim()));
}

function buildTransactionId(taskNo: string, suffix: "H1" | "H2") {
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  if (!normalized) {
    throw new Error("Stage 2 task number cannot produce a provider transaction ID.");
  }
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

function assertSafeProviderSigningUrl(
  value: string,
  provider: ESignProviderType,
  config: ConfigService
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stage 2 provider signing URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Stage 2 provider signing URL is invalid.");
  }
  const production =
    config.get<string>("NODE_ENV")?.trim().toLowerCase() === "production" ||
    config.get<string>("FADADA_ENV")?.trim().toLowerCase() === "production";
  if (production && url.protocol !== "https:") {
    throw new Error("Stage 2 provider signing URL is invalid.");
  }

  const configuredHosts = [
    ...(config.get<string>("ESIGN_SIGN_URL_ALLOWED_HOSTS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    ...(provider === ESignProviderType.FADADA
      ? [config.get<string>("FADADA_BASE_URL") ?? ""]
      : []),
    ...(provider === ESignProviderType.MOCK
      ? [config.get<string>("PORTAL_BASE_URL") ?? ""]
      : [])
  ];
  const allowedHosts = new Set(
    configuredHosts
      .map(normalizeAllowedSigningHost)
      .filter((item): item is string => Boolean(item))
  );
  if (
    allowedHosts.size === 0 ||
    (!allowedHosts.has(url.host.toLowerCase()) &&
      !allowedHosts.has(url.hostname.toLowerCase()))
  ) {
    throw new Error("Stage 2 provider signing URL is invalid.");
  }
  return url.toString();
}

function normalizeAllowedSigningHost(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  try {
    return new URL(
      normalized.includes("://") ? normalized : `https://${normalized}`
    ).host.toLowerCase();
  } catch {
    return null;
  }
}

function sanitizeCode(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return normalized || STAGE2_PLATFORM_SEAL_PROVIDER_FAILED;
}

function sanitizeArchiveError(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  return /^[A-Z0-9_]{1,128}$/.test(value)
    ? value
    : "STAGE2_HANDOVER_ARCHIVE_FAILED";
}

function normalizeVoidReason(value: string) {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length < 3 || normalized.length > 500) {
    throw new BadRequestException({
      code: "STAGE2_HANDOVER_ESIGN_VOID_REASON_INVALID",
      message: "A void reason between 3 and 500 characters is required."
    });
  }
  return normalized;
}

function exceptionCode(error: { getResponse(): object | string }) {
  const response = error.getResponse();
  return typeof response === "object" && response && "code" in response
    ? (response as { code?: unknown }).code
    : undefined;
}

function staleCreateResult() {
  return new ConflictException({
    code: STAGE2_HANDOVER_ESIGN_RESULT_STALE,
    message: "The Stage 2 eSign task changed before the provider result was applied."
  });
}

function lostPlatformClaim() {
  return new ConflictException({
    code: STAGE2_PLATFORM_SEAL_CLAIM_LOST,
    message: "The platform seal claim changed before the provider result was applied."
  });
}

function orphanConflict() {
  return new ConflictException({
    code: STAGE2_HANDOVER_ESIGN_ORPHAN_CONFLICT,
    message: "The active Stage 2 eSign task is not linked by the handover pointer."
  });
}

function voidNotAllowed() {
  return new BadRequestException({
    code: "STAGE2_HANDOVER_ESIGN_VOID_NOT_ALLOWED",
    message: "A completed or changed Stage 2 signing task cannot be voided for rebuild."
  });
}

function toJson(value: Record<string, unknown>) {
  return value as Prisma.InputJsonValue;
}

function emptyReadiness(workOrderId: string): Stage2HandoverESignReadiness {
  return {
    blockers: [],
    ready: false,
    state: {
      esignTaskId: null,
      esignTaskStatus: null,
      handoverContractId: null,
      handoverId: null,
      handoverStatus: null,
      orderId: null,
      orderStatus: null,
      workOrderId,
      workOrderStatus: null
    }
  };
}

function assertTaskSourceBinding(
  task: Stage2Task,
  handover: Stage2LifecycleWorkOrder["handover"]
) {
  if (!taskMatchesSourceBinding(task, handover)) {
    throw new ConflictException({
      code: STAGE2_HANDOVER_ESIGN_REBUILD_REQUIRED,
      message: "The Stage 2 eSign task is not bound to the current source artifact."
    });
  }
}

function taskMatchesSourceBinding(
  task: Stage2Task,
  handover: Stage2LifecycleWorkOrder["handover"]
) {
  if (!handover) {
    return false;
  }
  const snapshot = asRecord(task.requestSnapshot);
  const contract = handover.handoverContract;
  return (
    task.contractId === handover.handoverContractId &&
    contract?.id === handover.handoverContractId &&
    contract.fileId === handover.sourceDocumentFileId &&
    snapshot?.artifactVersion === handover.artifactVersion &&
    snapshot?.contractId === task.contractId &&
    snapshot.contractId === contract.id &&
    snapshot?.handoverId === handover.id &&
    snapshot?.manifestHash === handover.manifestHash &&
    snapshot?.sourceDocumentFileId === handover.sourceDocumentFileId &&
    snapshot.sourceDocumentFileId === contract.fileId &&
    snapshot?.sourcePdfHash === handover.sourcePdfHash
  );
}
