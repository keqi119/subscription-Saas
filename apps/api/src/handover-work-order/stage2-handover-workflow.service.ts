import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  CustomerAccountStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType,
  ESignProviderActionType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  NotificationStatus,
  Prisma,
  SmsSendStatus,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType,
  VehicleHandoverWorkOrderStatus
} from "@prisma/client";

import { STAGE2_HANDOVER_PDF_HARD_MAX_BYTES } from "../delivery-handover/delivery-handover-pdf-renderer.service";
import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { FadadaSignedArtifactService } from "../esign/fadada/fadada-signed-artifact.service";
import { SmsService } from "../sms/sms.service";
import { HandoverWorkOrderService } from "./handover-work-order.service";
import { Stage2HandoverESignService } from "./stage2-handover-esign.service";
import { validateStage2SourceArtifactBinding } from "./stage2-handover-source-artifact";
import { Stage2HandoverWorkflowRepository } from "./stage2-handover-workflow.repository";
import {
  ClaimedStage2WorkflowJob,
  Stage2HandoverWorkflowDb,
  Stage2HandoverWorkflowHandler,
  WorkflowHandlerResult
} from "./stage2-handover-workflow.types";

const STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV =
  "STAGE2_HANDOVER_WORKFLOW_ENABLED";
const DEFAULT_LEASE_MS = 120_000;
const FIRST_CUSTOMER_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const CUSTOMER_RECONCILIATION_DELAYS_MS = [
  10 * 60 * 1000,
  30 * 60 * 1000,
  6 * 60 * 60 * 1000
] as const;
const PLATFORM_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STAGE2_RECOVERY_AUDIT_MODULE = "stage2-handover-workflow";
const TERMINAL_WORK_ORDER_STATUSES =
  new Set<VehicleHandoverWorkOrderStatus>([
    VehicleHandoverWorkOrderStatus.CANCELLED,
    VehicleHandoverWorkOrderStatus.FAILED,
    VehicleHandoverWorkOrderStatus.VOIDED
  ]);

export interface EnqueueCustomerESignJobsInput {
  customerTransactionId: string;
  eSignTaskId: string;
  handoverId: string;
  initiatedAt: Date;
  workOrderId: string;
}

export type Stage2HandoverWorkflowProjectionState =
  | "PDF_PENDING"
  | "PDF_READY"
  | "WORKFLOW_EXCEPTION";

export interface Stage2HandoverWorkflowProjection {
  artifactVersion: number | null;
  errorCode: null | string;
  jobId: null | string;
  state: Stage2HandoverWorkflowProjectionState;
}

export interface Stage2HandoverWorkflowRecoveryResult {
  created: boolean;
  job: {
    id: string;
    jobStatus: VehicleHandoverWorkflowJobStatus;
    jobType: VehicleHandoverWorkflowJobType;
  };
}

const sourceProjectionSelect = {
  handover: {
    select: {
      artifactVersion: true,
      handoverContract: {
        select: {
          contractSnapshot: true,
          customerId: true,
          deletedAt: true,
          fileId: true,
          id: true,
          orderId: true,
          status: true
        }
      },
      handoverContractId: true,
      id: true,
      manifestHash: true,
      orderId: true,
      sourceDocumentFileId: true,
      sourceObjectKey: true,
      sourcePdfHash: true,
      status: true
    }
  },
  handoverId: true,
  id: true,
  order: {
    select: {
      customerId: true
    }
  },
  orderId: true
} as const;

const customerRecoveryWorkOrderSelect = {
  handover: {
    select: {
      archiveStatus: true,
      handoverESignTask: {
        select: {
          deletedAt: true,
          documentType: true,
          id: true,
          signers: {
            select: {
              deletedAt: true,
              documentType: true,
              providerActionType: true,
              providerTransactionId: true,
              required: true,
              signerStatus: true,
              signerType: true,
              slotId: true
            }
          },
          signingStage: true,
          taskNo: true,
          taskStatus: true
        }
      },
      handoverESignTaskId: true,
      id: true,
      status: true
    }
  },
  handoverId: true,
  id: true,
  status: true
} satisfies Prisma.VehicleHandoverWorkOrderSelect;

type CustomerRecoveryWorkOrder =
  Prisma.VehicleHandoverWorkOrderGetPayload<{
    select: typeof customerRecoveryWorkOrderSelect;
  }>;

@Injectable()
export class Stage2HandoverWorkflowService
  implements Stage2HandoverWorkflowHandler {
  readonly supportedJobTypes = [
    VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
    VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY,
    VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
    VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
    VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
    VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
    VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly repository: Stage2HandoverWorkflowRepository,
    private readonly handoverWorkOrderService: HandoverWorkOrderService,
    @Optional() private readonly smsService?: SmsService,
    @Optional() private readonly notificationService?: NotificationService,
    @Optional()
    @Inject(forwardRef(() => Stage2HandoverESignService))
    private readonly stage2ESignService?: Stage2HandoverESignService,
    @Optional()
    private readonly signedArtifactService?: FadadaSignedArtifactService
  ) {}

  isEnabled() {
    return this.config
      .get<string>(STAGE2_HANDOVER_WORKFLOW_ENABLED_ENV)
      ?.trim()
      .toLowerCase() === "true";
  }

  async retryDeadLetterJob(
    workOrderId: string,
    sourceJobId: string,
    actorId: string
  ): Promise<Stage2HandoverWorkflowRecoveryResult> {
    const idempotencyKey = `recovery:${sourceJobId}`;
    let sourceBinding: null | {
      eSignTaskId: null | string;
      handoverId: null | string;
      jobType: VehicleHandoverWorkflowJobType;
    } = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const source = await tx.vehicleHandoverWorkflowJob.findUnique({
          where: { id: sourceJobId }
        });
        if (!source || source.workOrderId !== workOrderId) {
          throw workflowJobNotFound();
        }
        if (source.jobStatus !== VehicleHandoverWorkflowJobStatus.DEAD_LETTER) {
          throw workflowJobNotDeadLetter();
        }
        const binding = {
          eSignTaskId: source.eSignTaskId,
          handoverId: source.handoverId,
          jobType: source.jobType
        };
        sourceBinding = binding;

        const existing = await tx.vehicleHandoverWorkflowJob.findUnique({
          where: { idempotencyKey }
        });
        if (existing) {
          if (!matchesRecoveryBinding(existing, workOrderId, binding)) {
            throw workflowRecoveryConflict();
          }
          return toRecoveryResult(existing, false);
        }

        const payload = boundedRecoveryPayload(source.jobType, source.payload);
        const replacement = await tx.vehicleHandoverWorkflowJob.create({
          data: {
            availableAt: new Date(),
            eSignTaskId: source.eSignTaskId,
            handoverId: source.handoverId,
            idempotencyKey,
            jobType: source.jobType,
            maxAttempts: readPositiveInteger(source.maxAttempts, 5),
            ...(payload === undefined ? {} : { payload }),
            workOrderId
          }
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.UPDATE,
            afterSnapshot: {
              jobType: source.jobType,
              recoveryAction: "RETRY_DEAD_LETTER",
              replacementJobId: replacement.id,
              sourceJobId
            },
            entityId: workOrderId,
            entityType: "VehicleHandoverWorkOrder",
            module: STAGE2_RECOVERY_AUDIT_MODULE,
            operatorId: actorId
          }
        });
        return toRecoveryResult(replacement, true);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.vehicleHandoverWorkflowJob.findUnique({
          where: { idempotencyKey }
        });
        if (
          existing &&
          sourceBinding &&
          matchesRecoveryBinding(existing, workOrderId, sourceBinding)
        ) {
          return toRecoveryResult(existing, false);
        }
        if (existing) {
          throw workflowRecoveryConflict();
        }
      }
      throw error;
    }
  }

  async reconcileCustomerSignature(
    workOrderId: string,
    actorId: string
  ): Promise<Stage2HandoverWorkflowRecoveryResult> {
    let idempotencyKey: null | string = null;
    let recoveryBinding: null | {
      customerTransactionId: string;
      eSignTaskId: string;
      handoverId: string;
    } = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workOrder = await tx.vehicleHandoverWorkOrder.findUnique({
          select: customerRecoveryWorkOrderSelect,
          where: { id: workOrderId }
        });
        const active = requireActiveCustomerRecoveryTransaction(workOrder);
        recoveryBinding = active;
        const sourceDeadLetter = await tx.vehicleHandoverWorkflowJob.findFirst({
          orderBy: { createdAt: "desc" },
          where: {
            eSignTaskId: active.eSignTaskId,
            handoverId: active.handoverId,
            jobStatus: VehicleHandoverWorkflowJobStatus.DEAD_LETTER,
            jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
            workOrderId
          }
        });
        const exactDeadLetter =
          sourceDeadLetter &&
          readCustomerTransactionId(sourceDeadLetter.payload) === active.customerTransactionId
            ? sourceDeadLetter
            : null;
        idempotencyKey = exactDeadLetter
          ? `recovery:${exactDeadLetter.id}`
          : `customer-reconcile-recovery:${active.eSignTaskId}:${active.customerTransactionId}`;

        const existing = await tx.vehicleHandoverWorkflowJob.findUnique({
          where: { idempotencyKey }
        });
        if (existing) {
          if (!matchesCustomerRecoveryBinding(existing, workOrderId, active)) {
            throw workflowRecoveryConflict();
          }
          return toRecoveryResult(existing, false);
        }

        const replacement = await tx.vehicleHandoverWorkflowJob.create({
          data: {
            availableAt: new Date(),
            eSignTaskId: active.eSignTaskId,
            handoverId: active.handoverId,
            idempotencyKey,
            jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
            payload: {
              customerTransactionId: active.customerTransactionId
            },
            workOrderId
          }
        });
        await tx.auditLog.create({
          data: {
            action: AuditAction.UPDATE,
            afterSnapshot: {
              eSignTaskId: active.eSignTaskId,
              recoveryAction: "RECONCILE_CUSTOMER_SIGNATURE",
              replacementJobId: replacement.id
            },
            entityId: workOrderId,
            entityType: "VehicleHandoverWorkOrder",
            module: STAGE2_RECOVERY_AUDIT_MODULE,
            operatorId: actorId
          }
        });
        return toRecoveryResult(replacement, true);
      });
    } catch (error) {
      if (idempotencyKey && isUniqueConstraintError(error)) {
        const existing = await this.prisma.vehicleHandoverWorkflowJob.findUnique({
          where: { idempotencyKey }
        });
        if (
          existing &&
          recoveryBinding &&
          matchesCustomerRecoveryBinding(existing, workOrderId, recoveryBinding)
        ) {
          return toRecoveryResult(existing, false);
        }
        if (existing) {
          throw workflowRecoveryConflict();
        }
      }
      throw error;
    }
  }

  async enqueueCustomerESignJobs(
    tx: Stage2HandoverWorkflowDb,
    input: EnqueueCustomerESignJobsInput
  ) {
    const payload = {
      customerTransactionId: input.customerTransactionId
    } satisfies Prisma.InputJsonObject;
    await this.repository.enqueue(tx, {
      eSignTaskId: input.eSignTaskId,
      handoverId: input.handoverId,
      idempotencyKey:
        `customer-notify:${input.eSignTaskId}:${input.customerTransactionId}`,
      jobType: VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY,
      payload,
      workOrderId: input.workOrderId
    });
    await this.repository.enqueue(tx, {
      availableAt: new Date(
        input.initiatedAt.getTime() +
          FIRST_CUSTOMER_RECONCILIATION_DELAY_MS
      ),
      eSignTaskId: input.eSignTaskId,
      handoverId: input.handoverId,
      idempotencyKey:
        `customer-reconcile:${input.eSignTaskId}:${input.customerTransactionId}`,
      jobType: VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE,
      payload,
      workOrderId: input.workOrderId
    });
  }

  async handle(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    switch (job.jobType) {
      case VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF:
        return this.handleGenerateSourcePdf(job);
      case VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY:
        return this.handleFieldNotification(job);
      case VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY:
        return this.handleCustomerNotification(job);
      case VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE:
        return this.handleCustomerSignatureReconciliation(job);
      case VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM:
        return this.handlePlatformAutoSeal(job);
      case VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL:
        return this.handlePlatformSealReconciliation(job);
      case VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF:
        return this.handleSignedPdfArchive(job);
      default:
        throw new Error("STAGE2_HANDOVER_WORKFLOW_JOB_NOT_IMPLEMENTED");
    }
  }

  private async handleGenerateSourcePdf(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const manifestHash = readRequiredManifestHash(job.payload);
    return this.withLeaseHeartbeat(job, async (lease) => {
      const artifact = await this.handoverWorkOrderService
        .ensureStage2HandoverPdf(job.workOrderId, manifestHash, { lease });
      return {
        kind: "COMPLETED",
        result: {
          artifactId: artifact.artifactId,
          artifactStatus: artifact.status
        }
      };
    });
  }

  private async handleFieldNotification(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const smsService = this.requireSmsService();
    return this.withLeaseHeartbeat(job, async (lease) => {
      const workOrder =
        await this.prisma.vehicleHandoverWorkOrder.findUnique({
          select: { fieldOperatorPhone: true },
          where: { id: job.workOrderId }
        });
      const phone = readRequiredString(
        workOrder?.fieldOperatorPhone,
        "FIELD_NOTIFICATION_RECIPIENT_MISSING"
      );
      const sms = await smsService.sendStage2FieldReady({
        idempotencyKey: job.idempotencyKey,
        phone
      });
      await lease.assertLease();
      if (sms.sendStatus !== SmsSendStatus.SENT) {
        throw new Error("FIELD_NOTIFICATION_INCOMPLETE");
      }
      return {
        kind: "COMPLETED",
        result: {
          sms: {
            recordId: sms.sendLogId ?? null,
            status: sms.sendStatus
          }
        }
      };
    });
  }

  private async handleCustomerNotification(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const smsService = this.requireSmsService();
    const notificationService = this.requireNotificationService();
    const eSignTaskId = readRequiredString(
      job.eSignTaskId,
      "CUSTOMER_NOTIFICATION_ESIGN_TASK_MISSING"
    );
    const customerTransactionId = readRequiredCustomerTransactionId(
      job.payload
    );
    return this.withLeaseHeartbeat(job, async (lease) => {
      const workOrder =
        await this.prisma.vehicleHandoverWorkOrder.findUnique({
          select: {
            order: {
              select: {
                customer: {
                  select: {
                    id: true,
                    mobile: true
                  }
                },
                customerId: true
              }
            }
          },
          where: { id: job.workOrderId }
        });
      if (!workOrder) {
        throw new Error("CUSTOMER_NOTIFICATION_WORK_ORDER_MISSING");
      }
      const customerId = workOrder.order.customerId;
      const account = await this.prisma.customerAccount.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { phone: true },
        where: {
          accountStatus: CustomerAccountStatus.ACTIVE,
          customerId,
          deletedAt: null
        }
      });
      const phone = readRequiredString(
        account?.phone ?? workOrder.order.customer.mobile,
        "CUSTOMER_NOTIFICATION_RECIPIENT_MISSING"
      );
      const smsKey =
        `customer-sms:${eSignTaskId}:${customerTransactionId}`;
      const inAppKey =
        `customer-in-app:${eSignTaskId}:${customerTransactionId}`;
      const [smsOutcome, inAppOutcome] = await Promise.allSettled([
        smsService.sendStage2CustomerReady({
          idempotencyKey: smsKey,
          phone
        }),
        notificationService.notifyStage2CustomerReady({
          customerId,
          idempotencyKey: inAppKey,
          workOrderId: job.workOrderId
        })
      ]);
      await lease.assertLease();

      const sms =
        smsOutcome.status === "fulfilled" ? smsOutcome.value : null;
      const inApp =
        inAppOutcome.status === "fulfilled" ? inAppOutcome.value : null;
      if (
        sms?.sendStatus !== SmsSendStatus.SENT ||
        (
          inApp?.notificationStatus !== NotificationStatus.SENT &&
          inApp?.notificationStatus !== NotificationStatus.READ
        )
      ) {
        throw new Error("CUSTOMER_NOTIFICATION_INCOMPLETE");
      }
      return {
        kind: "COMPLETED",
        result: {
          inApp: {
            recordId: inApp.id,
            status: inApp.notificationStatus
          },
          sms: {
            recordId: sms.sendLogId ?? null,
            status: sms.sendStatus
          }
        }
      };
    });
  }

  private async handleCustomerSignatureReconciliation(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const stage2ESignService = this.requireStage2ESignService();
    const eSignTaskId = readRequiredString(
      job.eSignTaskId,
      "CUSTOMER_RECONCILIATION_ESIGN_TASK_MISSING"
    );
    const customerTransactionId = readRequiredCustomerTransactionId(
      job.payload
    );
    return this.withLeaseHeartbeat(job, async (lease) => {
      const providerStatus =
        await stage2ESignService.reconcileCustomerSignature({
          eSignTaskId,
          providerTransactionId: customerTransactionId,
          workOrderId: job.workOrderId
        });
      await lease.assertLease();
      if (providerStatus.status === "SIGNED") {
        return {
          kind: "COMPLETED",
          result: {
            providerStatus: providerStatus.status,
            resultCode: providerStatus.resultCode ?? null
          }
        };
      }
      if (providerStatus.status !== "SIGNING") {
        throw new Error(
          "STAGE2_CUSTOMER_RECONCILIATION_PROVIDER_STATUS_INVALID"
        );
      }

      const pollCount = readPollCount(job.resultSnapshot);
      const delayIndex = Math.min(
        pollCount,
        CUSTOMER_RECONCILIATION_DELAYS_MS.length - 1
      );
      return {
        availableAt: new Date(
          Date.now() +
            CUSTOMER_RECONCILIATION_DELAYS_MS[delayIndex]!
        ),
        kind: "OBSERVED_SIGNING",
        result: {
          pollCount: pollCount + 1,
          providerStatus: providerStatus.status,
          resultCode: providerStatus.resultCode
        }
      };
    });
  }

  private async handlePlatformAutoSeal(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const stage2ESignService = this.requireStage2ESignService();
    const eSignTaskId = readRequiredString(
      job.eSignTaskId,
      "PLATFORM_AUTO_SEAL_ESIGN_TASK_MISSING"
    );
    const platformTransactionId =
      readRequiredPlatformTransactionId(job.payload);
    return this.withLeaseHeartbeat(job, async (lease) => {
      const view = await stage2ESignService.retryPlatformSeal(
        job.workOrderId,
        undefined,
        platformTransactionId
      );
      await lease.assertLease();
      if (
        view.platformSigner?.status === ESignSignerStatus.SIGNED &&
        view.status === ESignTaskStatus.COMPLETED
      ) {
        return {
          kind: "COMPLETED",
          result: {
            providerStatus: "SIGNED"
          }
        };
      }
      if (
        view.platformSigner?.status !== ESignSignerStatus.SIGNING
      ) {
        throw new Error(
          "STAGE2_PLATFORM_AUTO_SEAL_PROVIDER_STATUS_INVALID"
        );
      }
      await this.repository.enqueue(this.prisma, {
        eSignTaskId,
        handoverId: job.handoverId ?? undefined,
        idempotencyKey:
          `platform-reconcile:${eSignTaskId}:${platformTransactionId}`,
        jobType:
          VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL,
        payload: {
          platformTransactionId
        },
        workOrderId: job.workOrderId
      });
      return {
        kind: "COMPLETED",
        result: {
          providerStatus: "SIGNING",
          reconciliationEnqueued: true
        }
      };
    });
  }

  private async handlePlatformSealReconciliation(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const stage2ESignService = this.requireStage2ESignService();
    const eSignTaskId = readRequiredString(
      job.eSignTaskId,
      "PLATFORM_RECONCILIATION_ESIGN_TASK_MISSING"
    );
    const platformTransactionId =
      readRequiredPlatformTransactionId(job.payload);
    return this.withLeaseHeartbeat(job, async (lease) => {
      const providerStatus =
        await stage2ESignService.reconcilePlatformSeal({
          eSignTaskId,
          providerTransactionId: platformTransactionId,
          workOrderId: job.workOrderId
        });
      await lease.assertLease();
      if (providerStatus.status === "SIGNED") {
        return {
          kind: "COMPLETED",
          result: {
            providerStatus: providerStatus.status,
            resultCode: providerStatus.resultCode ?? null
          }
        };
      }
      if (providerStatus.status === "FAILED") {
        const view = await stage2ESignService.retryPlatformSeal(
          job.workOrderId,
          undefined,
          platformTransactionId
        );
        await lease.assertLease();
        if (
          view.platformSigner?.status === ESignSignerStatus.SIGNED &&
          view.status === ESignTaskStatus.COMPLETED
        ) {
          return {
            kind: "COMPLETED",
            result: {
              providerStatus: "SIGNED",
              recoveredFrom: "FAILED",
              resultCode: providerStatus.resultCode ?? null
            }
          };
        }
        if (
          view.platformSigner?.status !== ESignSignerStatus.SIGNING
        ) {
          throw new Error(
            "STAGE2_PLATFORM_RECONCILIATION_RECOVERY_STATUS_INVALID"
          );
        }
        return {
          availableAt: new Date(
            Date.now() + PLATFORM_RECONCILIATION_DELAY_MS
          ),
          kind: "OBSERVED_SIGNING",
          result: {
            providerStatus: "SIGNING",
            recoveredFrom: "FAILED",
            resultCode: providerStatus.resultCode ?? null
          }
        };
      }
      if (providerStatus.status !== "SIGNING") {
        throw new Error(
          "STAGE2_PLATFORM_RECONCILIATION_PROVIDER_STATUS_INVALID"
        );
      }
      return {
        availableAt: new Date(
          Date.now() + PLATFORM_RECONCILIATION_DELAY_MS
        ),
        kind: "OBSERVED_SIGNING",
        result: {
          providerStatus: providerStatus.status,
          resultCode: providerStatus.resultCode
        }
      };
    });
  }

  private async handleSignedPdfArchive(
    job: ClaimedStage2WorkflowJob
  ): Promise<WorkflowHandlerResult> {
    const signedArtifactService =
      this.requireSignedArtifactService();
    const eSignTaskId = readRequiredString(
      job.eSignTaskId,
      "STAGE2_ARCHIVE_ESIGN_TASK_MISSING"
    );
    const artifactVersion =
      readRequiredArtifactVersion(job.payload);
    return this.withLeaseHeartbeat(job, async (lease) => {
      const workOrder =
        await this.prisma.vehicleHandoverWorkOrder.findUnique({
          select: {
            handover: {
              select: {
                artifactVersion: true,
                handoverESignTaskId: true,
                id: true
              }
            },
            handoverId: true,
            id: true
          },
          where: { id: job.workOrderId }
        });
      if (
        !workOrder?.handover ||
        workOrder.handoverId !== job.handoverId ||
        workOrder.handover.id !== job.handoverId ||
        workOrder.handover.handoverESignTaskId !== eSignTaskId ||
        workOrder.handover.artifactVersion !== artifactVersion
      ) {
        throw new Error(
          "STAGE2_ARCHIVE_ARTIFACT_VERSION_INVALID"
        );
      }
      const result =
        await signedArtifactService.archiveSignedStage2Handover({
          taskId: eSignTaskId
        });
      await lease.assertLease();
      if (
        result.archiveStatus ===
        DeliveryHandoverArchiveStatus.ARCHIVED
      ) {
        return {
          kind: "COMPLETED",
          result: {
            archiveStatus: result.archiveStatus,
            archived: result.archived
          }
        };
      }
      if (
        result.archiveStatus ===
        DeliveryHandoverArchiveStatus.PENDING
      ) {
        return {
          availableAt: new Date(
            Date.now() + PLATFORM_RECONCILIATION_DELAY_MS
          ),
          kind: "OBSERVED_SIGNING",
          result: {
            archiveStatus: result.archiveStatus,
            archived: result.archived
          }
        };
      }
      throw new Error("STAGE2_ARCHIVE_INCOMPLETE");
    });
  }

  async getProjection(
    workOrderId: string
  ): Promise<null | Stage2HandoverWorkflowProjection> {
    if (!this.isEnabled()) {
      return null;
    }

    const job = await this.prisma.vehicleHandoverWorkflowJob.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        jobType: VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF,
        workOrderId
      }
    });
    if (!job) {
      return null;
    }
    if (job.jobStatus === VehicleHandoverWorkflowJobStatus.DEAD_LETTER) {
      return {
        artifactVersion: null,
        errorCode: job.lastErrorCode ?? "WORKFLOW_ERROR",
        jobId: job.id,
        state: "WORKFLOW_EXCEPTION"
      };
    }

    const workOrder = await this.prisma.vehicleHandoverWorkOrder.findUnique({
      select: sourceProjectionSelect,
      where: { id: workOrderId }
    });
    const source = workOrder?.handover ?? null;
    const fileObject = source?.sourceDocumentFileId
      ? await this.prisma.fileObject.findUnique({
          where: { id: source.sourceDocumentFileId }
        })
      : null;
    const expectedManifestHash = readManifestHash(job.payload);
    const binding = workOrder && source && expectedManifestHash
      ? validateStage2SourceArtifactBinding({
          expectedCustomerId: workOrder.order.customerId,
          expectedHandoverId: workOrder.handoverId ?? "",
          expectedManifestHash,
          expectedOrderId: workOrder.orderId,
          expectedWorkOrderId: workOrder.id,
          fileObject,
          handover: source,
          maxSizeBytes: STAGE2_HANDOVER_PDF_HARD_MAX_BYTES
        })
      : null;
    if (binding) {
      return {
        artifactVersion: binding.artifactVersion,
        errorCode: null,
        jobId: job.id,
        state: "PDF_READY"
      };
    }
    if (job.jobStatus === VehicleHandoverWorkflowJobStatus.COMPLETED) {
      return {
        artifactVersion: null,
        errorCode: "SOURCE_ARTIFACT_INVALID",
        jobId: job.id,
        state: "WORKFLOW_EXCEPTION"
      };
    }
    return {
      artifactVersion: null,
      errorCode: null,
      jobId: job.id,
      state: "PDF_PENDING"
    };
  }

  private async withLeaseHeartbeat<T>(
    job: ClaimedStage2WorkflowJob,
    operation: (lease: {
      assertLease(): Promise<void>;
      jobId: string;
      leaseMs: number;
      leaseToken: string;
    }) => Promise<T>
  ) {
    const leaseMs = readPositiveInteger(
      this.config.get<string>("STAGE2_HANDOVER_WORKER_LEASE_MS"),
      DEFAULT_LEASE_MS
    );
    const intervalMs = Math.max(10, Math.floor(leaseMs / 3));
    let heartbeat = Promise.resolve();
    let leaseLost = false;
    let stopped = false;
    const renew = () => {
      heartbeat = heartbeat.then(async () => {
        if (stopped || leaseLost) {
          return;
        }
        try {
          leaseLost = !await this.repository.renewLease(
            job.id,
            job.leaseToken,
            leaseMs
          );
        } catch {
          leaseLost = true;
        }
      });
      return heartbeat;
    };
    const assertLease = async () => {
      await renew();
      if (leaseLost) {
        throw new Error("STAGE2_HANDOVER_WORKFLOW_LEASE_LOST");
      }
    };

    await assertLease();
    const timer = setInterval(() => {
      void renew();
    }, intervalMs);
    timer.unref?.();
    try {
      return await operation({
        assertLease,
        jobId: job.id,
        leaseMs,
        leaseToken: job.leaseToken
      });
    } finally {
      clearInterval(timer);
      stopped = true;
      await heartbeat;
    }
  }

  private requireSmsService() {
    if (!this.smsService) {
      throw new Error("STAGE2_HANDOVER_SMS_SERVICE_UNAVAILABLE");
    }
    return this.smsService;
  }

  private requireNotificationService() {
    if (!this.notificationService) {
      throw new Error("STAGE2_HANDOVER_NOTIFICATION_SERVICE_UNAVAILABLE");
    }
    return this.notificationService;
  }

  private requireStage2ESignService() {
    if (!this.stage2ESignService) {
      throw new Error(
        "STAGE2_HANDOVER_ESIGN_SERVICE_UNAVAILABLE"
      );
    }
    return this.stage2ESignService;
  }

  private requireSignedArtifactService() {
    if (!this.signedArtifactService) {
      throw new Error(
        "STAGE2_HANDOVER_ARCHIVE_SERVICE_UNAVAILABLE"
      );
    }
    return this.signedArtifactService;
  }
}

function boundedRecoveryPayload(
  jobType: VehicleHandoverWorkflowJobType,
  payload: unknown
): Prisma.InputJsonObject | undefined {
  switch (jobType) {
    case VehicleHandoverWorkflowJobType.GENERATE_SOURCE_PDF: {
      const manifestHash = readManifestHash(payload);
      if (!manifestHash) {
        throw workflowJobPayloadInvalid();
      }
      return { manifestHash };
    }
    case VehicleHandoverWorkflowJobType.NOTIFY_FIELD_ESIGN_READY:
      return undefined;
    case VehicleHandoverWorkflowJobType.NOTIFY_CUSTOMER_ESIGN_READY:
    case VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE: {
      const customerTransactionId = readCustomerTransactionId(payload);
      if (!customerTransactionId) {
        throw workflowJobPayloadInvalid();
      }
      return { customerTransactionId };
    }
    case VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM:
    case VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL: {
      const platformTransactionId = readPlatformTransactionId(payload);
      if (!platformTransactionId) {
        throw workflowJobPayloadInvalid();
      }
      return { platformTransactionId };
    }
    case VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF: {
      const artifactVersion = readArtifactVersion(payload);
      if (!artifactVersion) {
        throw workflowJobPayloadInvalid();
      }
      return { artifactVersion };
    }
  }
}

function requireActiveCustomerRecoveryTransaction(workOrder: CustomerRecoveryWorkOrder | null) {
  const handover = workOrder?.handover;
  const task = handover?.handoverESignTask;
  if (
    !workOrder ||
    TERMINAL_WORK_ORDER_STATUSES.has(workOrder.status) ||
    !handover ||
    workOrder.handoverId !== handover.id ||
    handover.archiveStatus === DeliveryHandoverArchiveStatus.ARCHIVED ||
    handover.status !== DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE ||
    !task ||
    handover.handoverESignTaskId !== task.id ||
    task.deletedAt !== null ||
    task.signingStage !== ESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
    task.documentType !== ESignDocumentType.DELIVERY_HANDOVER ||
    (task.taskStatus !== ESignTaskStatus.WAITING_CUSTOMER &&
      task.taskStatus !== ESignTaskStatus.SIGNING)
  ) {
    throw customerReconciliationNotAvailable();
  }

  const customerSigners = task.signers.filter(
    (signer) =>
      signer.deletedAt === null &&
      signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
      signer.providerActionType === ESignProviderActionType.CUSTOMER_MANUAL_SIGN &&
      signer.required === true &&
      signer.signerType === ESignSignerType.CUSTOMER &&
      signer.slotId === ESignSlotId.STAGE2_HANDOVER_CUSTOMER
  );
  const platformSigners = task.signers.filter(
    (signer) =>
      signer.deletedAt === null &&
      signer.documentType === ESignDocumentType.DELIVERY_HANDOVER &&
      signer.providerActionType === ESignProviderActionType.PLATFORM_AUTO_SEAL &&
      signer.required === true &&
      signer.signerType === ESignSignerType.PLATFORM &&
      signer.slotId === ESignSlotId.STAGE2_HANDOVER_PLATFORM
  );
  const customerSigner = customerSigners[0];
  const platformSigner = platformSigners[0];
  const customerTransactionId = buildStage2ProviderTransactionId(task.taskNo, "H1");
  if (
    task.signers.length !== 2 ||
    customerSigners.length !== 1 ||
    platformSigners.length !== 1 ||
    !customerSigner ||
    !platformSigner ||
    (customerSigner.signerStatus !== ESignSignerStatus.PENDING &&
      customerSigner.signerStatus !== ESignSignerStatus.SIGNING) ||
    customerSigner.providerTransactionId !== customerTransactionId ||
    platformSigner.signerStatus !== ESignSignerStatus.PENDING
  ) {
    throw customerReconciliationNotAvailable();
  }
  return {
    customerTransactionId,
    eSignTaskId: task.id,
    handoverId: handover.id
  };
}

function buildStage2ProviderTransactionId(taskNo: string, suffix: "H1" | "H2") {
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  if (!normalized) {
    throw customerReconciliationNotAvailable();
  }
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

function readCustomerTransactionId(payload: unknown) {
  return readPayloadString(payload, "customerTransactionId");
}

function readPlatformTransactionId(payload: unknown) {
  return readPayloadString(payload, "platformTransactionId");
}

function readArtifactVersion(payload: unknown) {
  if (!isPlainRecord(payload)) {
    return null;
  }
  const value = payload.artifactVersion;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function readPayloadString(payload: unknown, key: string) {
  if (!isPlainRecord(payload)) {
    return null;
  }
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function matchesRecoveryBinding(
  job: {
    eSignTaskId: null | string;
    handoverId: null | string;
    jobType: VehicleHandoverWorkflowJobType;
    workOrderId: string;
  },
  workOrderId: string,
  binding: {
    eSignTaskId: null | string;
    handoverId: null | string;
    jobType: VehicleHandoverWorkflowJobType;
  }
) {
  return (
    job.workOrderId === workOrderId &&
    job.jobType === binding.jobType &&
    job.handoverId === binding.handoverId &&
    job.eSignTaskId === binding.eSignTaskId
  );
}

function matchesCustomerRecoveryBinding(
  job: {
    eSignTaskId: null | string;
    handoverId: null | string;
    jobType: VehicleHandoverWorkflowJobType;
    payload: Prisma.JsonValue;
    workOrderId: string;
  },
  workOrderId: string,
  binding: {
    customerTransactionId: string;
    eSignTaskId: string;
    handoverId: string;
  }
) {
  return (
    job.workOrderId === workOrderId &&
    job.jobType === VehicleHandoverWorkflowJobType.RECONCILE_CUSTOMER_SIGNATURE &&
    job.handoverId === binding.handoverId &&
    job.eSignTaskId === binding.eSignTaskId &&
    readCustomerTransactionId(job.payload) === binding.customerTransactionId
  );
}

function toRecoveryResult(
  job: {
    id: string;
    jobStatus: VehicleHandoverWorkflowJobStatus;
    jobType: VehicleHandoverWorkflowJobType;
  },
  created: boolean
): Stage2HandoverWorkflowRecoveryResult {
  return {
    created,
    job: {
      id: job.id,
      jobStatus: job.jobStatus,
      jobType: job.jobType
    }
  };
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function workflowJobNotFound() {
  return new NotFoundException({
    code: "STAGE2_WORKFLOW_JOB_NOT_FOUND",
    message: "The Stage 2 workflow job does not exist."
  });
}

function workflowJobNotDeadLetter() {
  return new BadRequestException({
    code: "STAGE2_WORKFLOW_JOB_NOT_DEAD_LETTER",
    message: "Only a dead-letter Stage 2 workflow job can be retried."
  });
}

function workflowJobPayloadInvalid() {
  return new BadRequestException({
    code: "STAGE2_WORKFLOW_JOB_PAYLOAD_INVALID",
    message: "The Stage 2 workflow job cannot be retried safely."
  });
}

function workflowRecoveryConflict() {
  return new ConflictException({
    code: "STAGE2_WORKFLOW_RECOVERY_CONFLICT",
    message: "The Stage 2 workflow recovery key is already bound to another operation."
  });
}

function customerReconciliationNotAvailable() {
  return new BadRequestException({
    code: "STAGE2_CUSTOMER_RECONCILIATION_NOT_AVAILABLE",
    message: "No active typed Stage 2 customer transaction is available for reconciliation."
  });
}

function readManifestHash(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return normalizeSha256((payload as Record<string, unknown>).manifestHash);
}

function normalizeSha256(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const digest = value.trim().toLowerCase().replace(/^sha256:/, "");
  return SHA256_DIGEST_PATTERN.test(digest) ? digest : null;
}

function readRequiredManifestHash(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_MANIFEST_HASH_INVALID");
  }
  const value = (payload as Record<string, unknown>).manifestHash;
  const digest = normalizeSha256(value);
  if (!digest) {
    throw new Error("STAGE2_HANDOVER_WORKFLOW_MANIFEST_HASH_INVALID");
  }
  return `sha256:${digest}`;
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPollCount(resultSnapshot: unknown) {
  if (
    !resultSnapshot ||
    typeof resultSnapshot !== "object" ||
    Array.isArray(resultSnapshot)
  ) {
    return 0;
  }
  const value = (resultSnapshot as Record<string, unknown>).pollCount;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function readRequiredCustomerTransactionId(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CUSTOMER_NOTIFICATION_TRANSACTION_MISSING");
  }
  return readRequiredString(
    (payload as Record<string, unknown>).customerTransactionId,
    "CUSTOMER_NOTIFICATION_TRANSACTION_MISSING"
  );
}

function readRequiredPlatformTransactionId(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PLATFORM_RECONCILIATION_TRANSACTION_MISSING");
  }
  return readRequiredString(
    (payload as Record<string, unknown>).platformTransactionId,
    "PLATFORM_RECONCILIATION_TRANSACTION_MISSING"
  );
}

function readRequiredArtifactVersion(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("STAGE2_ARCHIVE_ARTIFACT_VERSION_INVALID");
  }
  const value =
    (payload as Record<string, unknown>).artifactVersion;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("STAGE2_ARCHIVE_ARTIFACT_VERSION_INVALID");
  }
  return Number(value);
}

function readRequiredString(value: unknown, errorCode: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(errorCode);
  }
  return value.trim();
}
