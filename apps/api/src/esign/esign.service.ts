import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import {
  AuditAction,
  ContractStatus,
  DeliveryHandoverArchiveStatus,
  DeliveryHandoverStatus,
  ESignDocumentType as PrismaESignDocumentType,
  ESignProviderActionType as PrismaESignProviderActionType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage as PrismaESignSigningStage,
  ESignSlotId as PrismaESignSlotId,
  ESignTaskStatus,
  NotificationEventType,
  NotificationType,
  OrderStatus,
  Prisma,
  VehicleHandoverWorkflowJobStatus,
  VehicleHandoverWorkflowJobType
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { RequestContext, RequestUser } from "../auth/auth.types";
import { createBusinessNo, withUniqueBusinessNoRetry } from "../common/business-number";
import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentCustomer, PortalRequestContext } from "../portal/portal-auth.types";
import { STAGE2_DELIVERY_HANDOVER_SIGNING_STAGE } from "../delivery-handover/delivery-handover.service";
import {
  CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING,
  ContractPdfArtifactService
} from "./contract-pdf-artifact.service";
import {
  AutoSealPlacement,
  AutoSealTaskResult,
  CreateSignTaskResult,
  ESIGN_PROVIDER_CLIENT,
  ESignProvider,
  ESignProviderActionResult,
  ESignProviderActionType,
  ESignSignerRole,
  ESignSigningSlot,
  ESignSigningSlotCoordinate,
  ESignSigningStage,
  ESignSlotId
} from "./esign.provider";
import type { ApprovedSigningPlanRef } from "./enterprise-seal/enterprise-seal.types";
import { FadadaCustomerReadinessService } from "./fadada-customer-readiness.service";

const contractForESignInclude = {
  customer: { select: { id: true, mobile: true, name: true } },
  esignTasks: {
    include: {
      signers: {
        orderBy: { createdAt: "asc" as const },
        where: { deletedAt: null }
      }
    },
    orderBy: { createdAt: "desc" as const },
    where: { deletedAt: null }
  },
  handoverDeliveryHandover: {
    select: {
      archiveStatus: true,
      id: true,
      signedDocumentFileId: true,
      signedPdfHash: true,
      workOrders: {
        orderBy: { createdAt: "desc" as const },
        select: {
          createdAt: true,
          id: true,
          status: true
        },
        take: 2
      }
    }
  },
  order: {
    include: {
      application: { select: { applicationNo: true, id: true, salesUserId: true } },
      quote: { select: { id: true, quoteNo: true } },
      vehicle: true
    }
  }
} satisfies Prisma.ContractInclude;

const esignTaskInclude = {
  callbacks: {
    orderBy: { receivedAt: "desc" as const },
    take: 10
  },
  contract: {
    include: {
      customer: { select: { id: true, mobile: true, name: true } },
      order: {
        include: {
          application: { select: { applicationNo: true, id: true, salesUserId: true } },
          quote: { select: { id: true, quoteNo: true } },
          vehicle: true
        }
      }
    }
  },
  deliveryHandover: {
    select: {
      archiveLastError: true,
      archiveStatus: true,
      signedDocumentFileId: true,
      signedPdfHash: true,
      workOrders: {
        orderBy: { createdAt: "desc" as const },
        select: { id: true },
        take: 1
      }
    }
  },
  signers: {
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  }
} satisfies Prisma.ContractESignTaskInclude;

type ContractForESign = Prisma.ContractGetPayload<{ include: typeof contractForESignInclude }>;
type ESignTaskWithDetails = Prisma.ContractESignTaskGetPayload<{ include: typeof esignTaskInclude }>;

const ACTIVE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING,
  ESignTaskStatus.COMPLETED
];

const SIGNABLE_CONTRACT_STATUSES: ContractStatus[] = [
  ContractStatus.GENERATED,
  ContractStatus.SIGNING
];

const BLOCKED_COMPLETE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CANCELLED,
  ESignTaskStatus.FAILED,
  ESignTaskStatus.EXPIRED
];

const PORTAL_SIGNABLE_ESIGN_TASK_STATUSES: ESignTaskStatus[] = [
  ESignTaskStatus.CREATED,
  ESignTaskStatus.WAITING_CUSTOMER,
  ESignTaskStatus.SIGNING
];

const CALLBACK_COMPLETED_EVENTS = new Set([
  "COMPLETED",
  "SIGN_COMPLETED",
  "SIGNATURE_COMPLETED",
  "TASK_COMPLETED",
  "FADADA_SIGN_COMPLETED",
  "MOCK_SIGN_COMPLETED",
  "mock.sign.completed"
]);

const FADADA_FAILED_EVENT = "FADADA_SIGN_FAILED";
const FADADA_REJECTED_EVENT = "FADADA_SIGN_REJECTED";
const FADADA_UNKNOWN_EVENT = "FADADA_SIGN_UNKNOWN";
const STAGE2_CALLBACK_TRANSACTION_ATTEMPTS = 3;
const ENTERPRISE_AUTO_SEAL_ENABLED_ENV = "ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED";
const STAGE1_MULTI_SLOT_ENABLED_ENV = "ESIGN_STAGE1_MULTI_SLOT_ENABLED";
const PLATFORM_SEAL_KEYWORD_ENV = "ESIGN_PLATFORM_SEAL_KEYWORD";
const FADADA_CUSTOMER_SIGNING_NOT_READY = "FADADA_CUSTOMER_SIGNING_NOT_READY";
const STAGE1_SIGNING_STAGE: ESignSigningStage = "STAGE1_CONTRACT";
type Stage2SignedReconciliationInput = {
  completedAt: Date;
  eSignTaskId: string;
  providerTransactionId: string;
} & (
  | {
    queryResult: {
      resultCode: string;
      status: "SIGNED";
    };
    source: "QUERY";
  }
  | {
    queryResult?: never;
    source: "CALLBACK";
  }
);

const STAGE1_SIGNING_SLOTS: readonly ESignSigningSlot[] = [
  {
    documentType: "CONTRACT_BODY",
    keyword: "合同正文-订阅方签字",
    providerActionType: "CUSTOMER_MANUAL_SIGN",
    required: true,
    signerRole: "CUSTOMER",
    signingStage: STAGE1_SIGNING_STAGE,
    slotId: "STAGE1_BODY_CUSTOMER"
  },
  {
    documentType: "CONTRACT_BODY",
    keyword: "合同正文-服务提供方盖章",
    providerActionType: "PLATFORM_AUTO_SEAL",
    required: true,
    signerRole: "PLATFORM",
    signingStage: STAGE1_SIGNING_STAGE,
    slotId: "STAGE1_BODY_PLATFORM"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "附件1订阅方案-订阅方签字",
    providerActionType: "CUSTOMER_MANUAL_SIGN",
    required: true,
    signerRole: "CUSTOMER",
    signingStage: STAGE1_SIGNING_STAGE,
    slotId: "STAGE1_ATTACHMENT1_CUSTOMER"
  },
  {
    documentType: "ATTACHMENT1_SUBSCRIPTION_PLAN",
    keyword: "附件1订阅方案-服务提供方盖章",
    providerActionType: "PLATFORM_AUTO_SEAL",
    required: true,
    signerRole: "PLATFORM",
    signingStage: STAGE1_SIGNING_STAGE,
    slotId: "STAGE1_ATTACHMENT1_PLATFORM"
  }
] as const;

@Injectable()
export class ESignService {
  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    @Inject(ESIGN_PROVIDER_CLIENT)
    private readonly provider: ESignProvider,
    private readonly prisma: PrismaService,
    @Optional() private readonly notificationService?: NotificationService,
    @Optional() private readonly contractPdfArtifactService?: ContractPdfArtifactService,
    @Optional() private readonly fadadaReadinessService?: FadadaCustomerReadinessService
  ) {}

  async createTaskForContract(
    contractId: string,
    user: RequestUser,
    context: RequestContext,
    approvedSigningPlan?: ApprovedSigningPlanRef
  ) {
    const contract = await this.findContractForESign(contractId);
    this.assertContractCanStartESign(contract);

    const existingTask = contract.esignTasks.find((task) =>
      ACTIVE_ESIGN_TASK_STATUSES.includes(task.taskStatus)
    );
    if (existingTask) {
      const task = await this.findTaskOrThrow(existingTask.id);
      return toESignTaskView(task);
    }
    await this.assertCustomerReadyForProviderSigning(contract.customerId);
    const signingPdfArtifact = await this.preflightSigningPdfArtifact(contract.id);

    const documentName = contract.contractTitle || `合同 ${contract.contractNo}`;
    const requestSnapshotInput: Record<string, unknown> = {
      contractId: contract.id,
      contractNo: contract.contractNo,
      customerId: contract.customerId,
      documentName,
      orderId: contract.orderId,
      orderNo: contract.order.orderNo,
      provider: this.providerType
    };
    if (approvedSigningPlan) {
      requestSnapshotInput.enterpriseSigningPlan = toEnterpriseSigningPlanSnapshot(approvedSigningPlan);
    }
    const enterpriseAutoSealEnabled = this.isEnterpriseAutoSealEnabled();
    const stage1MultiSlotEnabled = this.isStage1MultiSlotEnabled();
    if (enterpriseAutoSealEnabled) {
      requestSnapshotInput.enterpriseAutoSeal = { enabled: true };
    }
    if (stage1MultiSlotEnabled) {
      requestSnapshotInput.stage1MultiSlot = {
        enabled: true,
        signingStage: STAGE1_SIGNING_STAGE,
        slotIds: STAGE1_SIGNING_SLOTS.map((slot) => slot.slotId)
      };
    }
    const platformStep = findPlatformSigningStep(approvedSigningPlan);
    const requestSnapshot = toJsonValue(requestSnapshotInput);
    const signingSlots = stage1MultiSlotEnabled ? [...STAGE1_SIGNING_SLOTS] : undefined;
    const signerCreates: Prisma.ContractESignSignerCreateWithoutTaskInput[] = stage1MultiSlotEnabled
      ? buildStage1SignerCreates(contract, signingSlots ?? [], platformStep)
      : [{
          customerId: contract.customerId,
          signerName: contract.customer.name,
          signerPhone: contract.customer.mobile,
          signerStatus: ESignSignerStatus.PENDING,
          signerType: ESignSignerType.CUSTOMER,
          snapshot: toJsonValue({
            customerId: contract.customerId,
            mobileMasked: maskPhone(contract.customer.mobile),
            name: contract.customer.name
          })
        }];
    if (!stage1MultiSlotEnabled && enterpriseAutoSealEnabled) {
      signerCreates.push({
        signerName: "Platform",
        signerStatus: ESignSignerStatus.PENDING,
        signerType: ESignSignerType.PLATFORM,
        snapshot: toJsonValue({
          required: true,
          sealId: platformStep?.sealId,
          signerRole: platformStep?.signerRole ?? "ENTERPRISE_SEAL",
          stepOrder: platformStep?.stepOrder ?? 2
        })
      });
    }

    const task = await withUniqueBusinessNoRetry(() =>
      this.prisma.contractESignTask.create({
        data: {
          contractId: contract.id,
          createdBy: user.id,
          customerId: contract.customerId,
          documentName,
          orderId: contract.orderId,
          provider: this.providerType,
          requestSnapshot,
          signers: {
            create: signerCreates
          },
          taskNo: createBusinessNo("ESG"),
          taskStatus: ESignTaskStatus.CREATED,
          updatedBy: user.id
        },
        include: esignTaskInclude
      })
    );

    try {
      const providerResult = await this.provider.createSignTask({
        approvedSigningPlan,
        callbackUrl: this.buildCallbackUrl(),
        contractId: contract.id,
        documentName,
        redirectUrl: this.buildPortalContractUrl(contract.id),
        signers: [{
          customerId: contract.customerId,
          name: contract.customer.name,
          phone: contract.customer.mobile,
          signerType: "CUSTOMER"
        }],
        ...(stage1MultiSlotEnabled
          ? {
              signingSlotCoordinates: signingPdfArtifact?.slotCoordinates?.map((coordinate) => ({
                pageNumber: coordinate.pageNumber,
                slotId: coordinate.slotId,
                x: coordinate.x,
                y: coordinate.y
              })),
              signingSlots,
              signingStage: STAGE1_SIGNING_STAGE
            }
          : {}),
        taskId: task.id,
        taskNo: task.taskNo
      });
      const customerActionResult = findCustomerActionResult(providerResult);
      const customerSignerResult = providerResult.signers?.find((signer) => signer.signerType === "CUSTOMER");
      const customerSignUrl = customerSignerResult?.signUrl ?? providerResult.signUrl;
      const customerSignUrlExpiresAt = customerSignerResult?.signUrlExpiresAt ?? providerResult.signUrlExpiresAt;
      const customerSignerUpdate: Prisma.ContractESignSignerUpdateManyMutationInput = {
        signUrl: customerSignUrl,
        signUrlExpiresAt: customerSignUrlExpiresAt,
        signerStatus: customerSignUrl
          ? ESignSignerStatus.SIGNING
          : ESignSignerStatus.PENDING
      };
      if (customerSignerResult?.providerSignerId) {
        customerSignerUpdate.providerSignerId = customerSignerResult.providerSignerId;
      }
      if (customerSignerResult?.providerCustomerId) {
        customerSignerUpdate.snapshot = toJsonValue({
          customerId: contract.customerId,
          mobileMasked: maskPhone(contract.customer.mobile),
          name: contract.customer.name,
          providerCustomerId: customerSignerResult.providerCustomerId
        });
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.contractESignTask.update({
          data: {
            documentObjectKey: providerResult.documentObjectKey,
            providerEnvelopeId: providerResult.providerEnvelopeId,
            providerTaskId: providerResult.providerTaskId,
            responseSnapshot: toJsonValue(providerResult.rawResponse ?? providerResult),
            signUrl: providerResult.signUrl,
            signUrlExpiresAt: providerResult.signUrlExpiresAt,
            startedAt: new Date(),
            taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
            updatedBy: user.id
          },
          where: { id: task.id }
        });
        if (stage1MultiSlotEnabled) {
          await this.applyStage1ProviderActions({
            providerResult,
            signingSlotCoordinates: signingPdfArtifact?.slotCoordinates?.map((coordinate) => ({
              pageNumber: coordinate.pageNumber,
              slotId: coordinate.slotId,
              x: coordinate.x,
              y: coordinate.y
            })),
            signingSlots: signingSlots ?? [],
            task,
            tx
          });
          if (customerActionResult?.signUrl) {
            await tx.contractESignTask.update({
              data: {
                signUrl: customerActionResult.signUrl,
                signUrlExpiresAt: customerActionResult.signUrlExpiresAt
              },
              where: { id: task.id }
            });
          }
        } else {
          await tx.contractESignSigner.updateMany({
            data: customerSignerUpdate,
            where: { deletedAt: null, signerType: ESignSignerType.CUSTOMER, taskId: task.id }
          });
        }
        if (contract.status === ContractStatus.GENERATED) {
          await tx.contract.update({
            data: { status: ContractStatus.SIGNING, updatedBy: user.id },
            where: { id: contract.id }
          });
        }
        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: task.id }
        });
      });

      await this.auditService.write({
        action: AuditAction.CREATE,
        after: toESignTaskView(updated),
        entityId: updated.id,
        entityType: "contract_esign_task",
        ipAddress: context.ipAddress,
        module: "esign",
        operatorId: user.id,
        userAgent: context.userAgent
      });

      await this.safeNotifyCustomer({
        aggregateId: updated.contractId,
        aggregateNo: updated.contract.contractNo,
        aggregateType: "contract",
        content: "您的合同已生成，请完成电子签署。",
        customerId: updated.customerId ?? contract.customerId,
        eventType: NotificationEventType.CONTRACT_PENDING,
        notificationType: NotificationType.CONTRACT_PENDING,
        status: updated.taskStatus,
        title: "合同待签署",
        url: `/portal/contracts/${updated.contractId}`
      });

      return toESignTaskView(updated);
    } catch (error) {
      await this.prisma.contractESignTask.update({
        data: {
          errorSnapshot: toJsonValue({ message: error instanceof Error ? error.message : String(error) }),
          failedAt: new Date(),
          taskStatus: ESignTaskStatus.FAILED,
          updatedBy: user.id
        },
        where: { id: task.id }
      });
      throw error;
    }
  }

  async listTasksForContract(contractId: string, user: RequestUser) {
    const contract = await this.findContractForESign(contractId);
    ensureCanAccessContractByOwner(contract, user);
    const tasks = await this.prisma.contractESignTask.findMany({
      include: esignTaskInclude,
      orderBy: { createdAt: "desc" },
      where: { contractId, deletedAt: null }
    });
    return tasks.map(toESignTaskView);
  }

  private async applyStage1ProviderActions(input: {
    providerResult: CreateSignTaskResult;
    signingSlotCoordinates?: ESignSigningSlotCoordinate[];
    signingSlots: ESignSigningSlot[];
    task: ESignTaskWithDetails;
    tx: Prisma.TransactionClient;
  }) {
    const actions = collectProviderActions(input.providerResult);
    if (actions.length === 0) {
      throw new Error("ESIGN_STAGE1_SLOT_PROVIDER_RESULT_MISSING: provider must return slot-capable actions");
    }

    const slotsById = new Map(input.signingSlots.map((slot) => [slot.slotId, slot]));
    const coveredRequiredSlotIds = new Set<ESignSlotId>();

    for (const action of actions) {
      const providerTransactionId = action.providerTransactionId ?? action.providerSignerId;
      const coveredSlotIds = action.coveredSlotIds ?? [];
      if (!providerTransactionId || coveredSlotIds.length === 0) {
        throw new Error("ESIGN_STAGE1_SLOT_PROVIDER_RESULT_INVALID: action requires transaction id and covered slots");
      }

      for (const slotId of coveredSlotIds) {
        const slot = slotsById.get(slotId);
        if (!slot) {
          throw new Error(`ESIGN_STAGE1_SLOT_PROVIDER_RESULT_INVALID: unknown slot ${slotId}`);
        }
        const signer = input.task.signers.find((row) => readSnapshotString(row.snapshot, "slotId") === slotId);
        if (!signer) {
          throw new Error(`ESIGN_STAGE1_SLOT_SIGNER_MISSING: missing signer row for ${slotId}`);
        }

        const signUrl = action.signUrl;
        const signUrlExpiresAt = action.signUrlExpiresAt;
        const providerActionType: ESignProviderActionType = action.providerActionType ?? slot.providerActionType;
        const coordinate = findStage1SlotCoordinate(input.signingSlotCoordinates, slot.slotId);
        const snapshotPatch: Record<string, unknown> = {
          coveredSlotIds,
          documentType: slot.documentType,
          keyword: slot.keyword,
          providerActionType,
          providerTransactionId,
          required: slot.required !== false,
          signerRole: slot.signerRole,
          signingStage: slot.signingStage,
          slotId: slot.slotId
        };
        if (coordinate) {
          snapshotPatch.slotCoordinate = coordinate;
        }
        await input.tx.contractESignSigner.update({
          data: {
            providerSignerId: providerTransactionId,
            signUrl,
            signUrlExpiresAt,
            signerStatus: signUrl ? ESignSignerStatus.SIGNING : ESignSignerStatus.PENDING,
            snapshot: toJsonValue(mergeSnapshot(signer.snapshot, snapshotPatch))
          },
          where: { id: signer.id }
        });

        if (slot.required !== false) {
          coveredRequiredSlotIds.add(slot.slotId);
        }
      }
    }

    const missingRequiredSlot = input.signingSlots.find((slot) =>
      slot.required !== false && !coveredRequiredSlotIds.has(slot.slotId)
    );
    if (missingRequiredSlot) {
      const missingSlots = input.signingSlots.filter((slot) =>
        slot.required !== false && !coveredRequiredSlotIds.has(slot.slotId)
      );
      for (const slot of missingSlots) {
        if (slot.providerActionType !== "PLATFORM_AUTO_SEAL" || slot.signerRole !== "PLATFORM") {
          throw new Error(`ESIGN_STAGE1_SLOT_PROVIDER_RESULT_MISSING: ${slot.slotId}`);
        }
        const signer = input.task.signers.find((row) => readSnapshotString(row.snapshot, "slotId") === slot.slotId);
        if (!signer) {
          throw new Error(`ESIGN_STAGE1_SLOT_SIGNER_MISSING: missing signer row for ${slot.slotId}`);
        }
        const coordinate = findStage1SlotCoordinate(input.signingSlotCoordinates, slot.slotId);
        const snapshotPatch: Record<string, unknown> = {
          documentType: slot.documentType,
          keyword: slot.keyword,
          pendingReason: "PLATFORM_AUTO_SEAL_PENDING",
          providerActionType: slot.providerActionType,
          providerTransactionId: null,
          required: slot.required !== false,
          signerRole: slot.signerRole,
          signingStage: slot.signingStage,
          slotId: slot.slotId
        };
        if (coordinate) {
          snapshotPatch.slotCoordinate = coordinate;
        }
        await input.tx.contractESignSigner.update({
          data: {
            providerSignerId: null,
            signerStatus: ESignSignerStatus.PENDING,
            snapshot: toJsonValue(mergeSnapshot(signer.snapshot, snapshotPatch))
          },
          where: { id: signer.id }
        });
      }
    }
  }

  async getTask(id: string, user: RequestUser) {
    const task = await this.findTaskOrThrow(id);
    ensureCanAccessContractByOwner(task.contract, user);
    return toESignTaskView(task);
  }

  async listPortalContracts(currentCustomer: CurrentCustomer) {
    const contracts = await this.prisma.contract.findMany({
      include: contractForESignInclude,
      orderBy: { createdAt: "desc" },
      where: {
        customerId: currentCustomer.customerId,
        deletedAt: null
      }
    });

    return contracts.map(toPortalContractListItem);
  }

  async getPortalContract(id: string, currentCustomer: CurrentCustomer) {
    const contract = await this.findPortalContractOrThrow(id, currentCustomer.customerId);
    return toPortalContractDetail(contract);
  }

  async startPortalSigning(id: string, currentCustomer: CurrentCustomer) {
    const contract = await this.findPortalContractOrThrow(id, currentCustomer.customerId);
    const identity = getPortalContractSigningIdentity(contract);
    if (identity.signingStage === "STAGE2_DELIVERY_HANDOVER") {
      throw new BadRequestException(
        "车辆交接确认单必须从交接复核页面发起签署。"
      );
    }
    const task = findCurrentPortalStage1SigningTask(contract);

    if (!task) {
      throw new BadRequestException("合同尚未发起电子签，请等待平台处理。");
    }
    if (task.taskStatus === ESignTaskStatus.COMPLETED) {
      throw new BadRequestException("合同已签署完成。");
    }

    await this.assertCustomerReadyForProviderSigning(contract.customerId);

    let signUrl = task.signUrl;
    let signUrlExpiresAt = task.signUrlExpiresAt;
    if (!signUrl || isExpired(signUrlExpiresAt)) {
      const refreshed = await this.provider.getSignerUrl({
        contractId: contract.id,
        providerTaskId: task.providerTaskId ?? task.taskNo,
        redirectUrl: this.buildPortalContractUrl(contract.id),
        signingStage: "STAGE1_CONTRACT",
        taskId: task.id
      });
      signUrl = refreshed.signUrl;
      signUrlExpiresAt = refreshed.expiresAt ?? null;
      await this.prisma.$transaction([
        this.prisma.contractESignTask.update({
          data: {
            signUrl,
            signUrlExpiresAt,
            taskStatus: ESignTaskStatus.SIGNING
          },
          where: { id: task.id }
        }),
        this.prisma.contractESignSigner.updateMany({
          data: {
            signUrl,
            signUrlExpiresAt,
            signerStatus: ESignSignerStatus.SIGNING
          },
          where: { deletedAt: null, signerType: ESignSignerType.CUSTOMER, taskId: task.id }
        })
      ]);
    }

    return {
      expiresAt: signUrlExpiresAt,
      mock: task.provider === ESignProviderType.MOCK,
      provider: task.provider,
      signUrl,
      taskId: task.id,
      taskStatus: task.taskStatus
    };
  }

  async mockSignTask(taskId: string, currentCustomer: CurrentCustomer, context: PortalRequestContext) {
    if (this.providerType !== ESignProviderType.MOCK || !this.isMockEnabled()) {
      throw new ForbiddenException("当前环境未开启 Mock 电子签署。");
    }

    const task = await this.findTaskOrThrow(taskId);
    ensureTaskOwnedByCustomer(task, currentCustomer.customerId);

    const completed = await this.completeTask(task.id, {
      actorId: currentCustomer.customerAccountId,
      callbackPayload: {
        eventType: "mock.sign.completed",
        providerTaskId: task.providerTaskId,
        taskId: task.id
      },
      context,
      eventType: "mock.sign.completed",
      providerTaskId: task.providerTaskId,
      source: "portal_mock"
    });

    return {
      contract: toPortalContractDetail(await this.findPortalContractOrThrow(completed.contractId, currentCustomer.customerId)),
      task: toESignTaskView(completed)
    };
  }

  async reconcileCustomerSigned(
    input: Stage2SignedReconciliationInput
  ): Promise<void> {
    if (
      !Number.isFinite(input.completedAt.getTime()) ||
      !normalizeProviderTransactionId(input.providerTransactionId) ||
      !hasValidStage2QueryResult(input)
    ) {
      throw new BadRequestException(
        "ESIGN_STAGE2_CUSTOMER_RECONCILIATION_INVALID"
      );
    }
    await this.runStage2CallbackReconciliation((tx) =>
      this.reconcileCustomerSignedInTransaction(tx, input)
    );
  }

  async reconcilePlatformSigned(
    input: Stage2SignedReconciliationInput
  ): Promise<void> {
    if (
      !Number.isFinite(input.completedAt.getTime()) ||
      !normalizeProviderTransactionId(input.providerTransactionId) ||
      !hasValidStage2QueryResult(input)
    ) {
      throw new BadRequestException(
        "ESIGN_STAGE2_PLATFORM_RECONCILIATION_INVALID"
      );
    }
    await this.runStage2CallbackReconciliation((tx) =>
      this.reconcilePlatformSignedInTransaction(tx, input)
    );
  }

  async handleCallback(providerParam: string, payload: unknown, headers?: Record<string, unknown>) {
    const provider = parseProvider(providerParam);
    const verified = await this.provider.verifyCallback(payload, headers);
    const record = asRecord(verified.payload);
    const providerTaskId =
      verified.providerTaskId ??
      stringOrNull(record.providerTaskId) ??
      stringOrNull(record.taskNo) ??
      stringOrNull(record.transaction_id);
    const providerContractId =
      verified.providerContractId ??
      stringOrNull(record.providerContractId) ??
      stringOrNull(record.contract_id);
    const resultCode = verified.resultCode ?? stringOrNull(record.result_code);
    const resultDescription = verified.resultDescription ?? stringOrNull(record.result_desc);
    const eventType = verified.eventType ?? stringOrNull(record.eventType);
    const sanitizedPayload = sanitizeCallbackPayloadForLog(verified.payload);

    if (!verified.verified) {
      await this.recordUnverifiedCallback({
        eventType,
        payload: sanitizedPayload,
        provider,
        providerTaskId
      });
      return { handled: false, reason: "UNVERIFIED" };
    }

    const normalizedProviderTransactionId = normalizeProviderTransactionId(providerTaskId);
    const stage2Context = await this.findTypedStage2CallbackContext(
      provider,
      normalizedProviderTransactionId,
      providerContractId
    );
    if (stage2Context) {
      if (!stage2Context.signer || !normalizedProviderTransactionId) {
        return this.recordUnknownVerifiedCallback({
          eventType,
          payload: sanitizedPayload,
          provider,
          providerTransactionId: normalizedProviderTransactionId,
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          taskId: stage2Context.task.id
        });
      }
      const payloadHash = hashCanonicalPayload(sanitizedPayload);
      const callbackClaim = await this.claimStage2CallbackLog({
        eventType,
        payload: sanitizedPayload,
        payloadHash,
        provider,
        providerTransactionId: normalizedProviderTransactionId,
        taskId: stage2Context.task.id
      });
      if (callbackClaim.duplicate) {
        return {
          handled: true,
          idempotent: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER",
          taskId: stage2Context.task.id
        };
      }
      return this.handleTypedStage2FadadaCallback({
        callbackLogId: callbackClaim.id,
        eventType,
        resultCode,
        sanitizedPayload,
        signerId: stage2Context.signer.id,
        taskId: stage2Context.task.id,
        providerTransactionId: normalizedProviderTransactionId
      });
    }

    const task = await this.findCallbackTask(provider, providerTaskId, providerContractId);
    if (task && isTypedStage2Task(task)) {
      return this.recordUnknownVerifiedCallback({
        eventType,
        payload: sanitizedPayload,
        provider,
        providerTransactionId: normalizedProviderTransactionId,
        signingStage: "STAGE2_DELIVERY_HANDOVER",
        taskId: task.id
      });
    }
    if (!task) {
      return this.recordUnknownVerifiedCallback({
        eventType,
        payload: sanitizedPayload,
        provider,
        providerTransactionId: normalizedProviderTransactionId
      });
    }

    const callbackLog = await this.prisma.contractESignCallbackLog.create({
      data: {
        eventType,
        payload: toJsonValue(sanitizedPayload),
        provider,
        providerTaskId,
        taskId: task.id,
        verified: verified.verified
      }
    });

    if (provider === ESignProviderType.FADADA) {
      return this.handleFadadaCallback({
        callbackLogId: callbackLog.id,
        eventType,
        providerContractId,
        providerTaskId,
        resultCode,
        resultDescription,
        sanitizedPayload,
        task
      });
    }

    if (eventType && CALLBACK_COMPLETED_EVENTS.has(eventType)) {
      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        await this.prisma.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: new Date()
          },
          where: { id: callbackLog.id }
        });
        return {
          handled: true,
          idempotent: true,
          task: toESignTaskView(task)
        };
      }
      const completed = await this.completeTask(task.id, {
        callbackLogId: callbackLog.id,
        callbackPayload: sanitizedPayload,
        eventType,
        providerTaskId,
        source: "provider_callback"
      });
      return {
        handled: true,
        task: toESignTaskView(completed)
      };
    }

    await this.prisma.contractESignCallbackLog.update({
      data: {
        handled: true,
        handledAt: new Date()
      },
      where: { id: callbackLog.id }
    });

    return { handled: true };
  }

  private async recordUnknownVerifiedCallback(input: {
    eventType?: string | null;
    payload: unknown;
    provider: ESignProviderType;
    providerTransactionId?: string | null;
    signingStage?: "STAGE2_DELIVERY_HANDOVER";
    taskId?: string;
  }) {
    const callbackClaim = await this.claimStage2CallbackLog({
      eventType: input.eventType,
      payload: input.payload,
      payloadHash: hashCanonicalPayload(input.payload),
      provider: input.provider,
      providerTransactionId: input.providerTransactionId,
      taskId: input.taskId
    });
    if (callbackClaim.duplicate) {
      return {
        handled: true,
        idempotent: true,
        ...(input.signingStage ? { signingStage: input.signingStage } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {})
      };
    }
    await this.prisma.contractESignCallbackLog.update({
      data: {
        errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
        handled: true,
        handledAt: new Date()
      },
      where: { id: callbackClaim.id }
    });
    return { handled: false, reason: "TASK_NOT_FOUND" as const };
  }

  private async findTypedStage2CallbackContext(
    provider: ESignProviderType,
    providerTransactionId?: string | null,
    providerContractId?: string | null
  ) {
    if (providerTransactionId) {
      const signer = await this.prisma.contractESignSigner.findFirst({
        include: {
          task: {
            include: esignTaskInclude
          }
        },
        where: {
          deletedAt: null,
          documentType: PrismaESignDocumentType.DELIVERY_HANDOVER,
          providerTransactionId,
          slotId: {
            in: [
              PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER,
              PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM
            ]
          }
        }
      });
      if (
        signer?.task &&
        signer.task.provider === provider &&
        isTypedStage2Task(signer.task) &&
        isTypedStage2SignerStructure(signer) &&
        normalizeProviderTransactionId(signer.providerTransactionId) ===
          providerTransactionId &&
        taskMatchesProviderContract(signer.task, providerContractId)
      ) {
        return {
          signer,
          task: signer.task
        };
      }
    }

    if (!providerContractId) {
      return null;
    }
    const task = await this.prisma.contractESignTask.findFirst({
      include: esignTaskInclude,
      where: {
        OR: [
          { providerEnvelopeId: providerContractId },
          { taskNo: providerContractId }
        ],
        deletedAt: null,
        documentType: PrismaESignDocumentType.DELIVERY_HANDOVER,
        provider,
        signingStage: PrismaESignSigningStage.STAGE2_DELIVERY_HANDOVER
      }
    });
    return task
      ? {
          signer: null,
          task
        }
      : null;
  }

  private async claimStage2CallbackLog(input: {
    eventType?: string | null;
    payload: unknown;
    payloadHash: string;
    provider: ESignProviderType;
    providerTransactionId?: string | null;
    taskId?: string;
  }): Promise<{ duplicate: boolean; id: string }> {
    try {
      const callbackLog = await this.prisma.contractESignCallbackLog.create({
        data: {
          eventType: input.eventType,
          payload: toJsonValue(input.payload),
          payloadHash: input.payloadHash,
          provider: input.provider,
          providerTaskId: input.providerTransactionId,
          providerTransactionId: input.providerTransactionId,
          taskId: input.taskId,
          verified: true
        }
      });
      return {
        duplicate: false,
        id: callbackLog.id
      };
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }
      const existing = await this.prisma.contractESignCallbackLog.findUnique({
        where: {
          provider_payloadHash: {
            payloadHash: input.payloadHash,
            provider: input.provider
          }
        }
      });
      if (!existing) {
        throw error;
      }
      return {
        duplicate: existing.handled,
        id: existing.id
      };
    }
  }

  private async handleTypedStage2FadadaCallback(input: {
    callbackLogId: string;
    eventType?: string | null;
    resultCode?: string | null;
    sanitizedPayload: unknown;
    signerId: string;
    taskId: string;
    providerTransactionId: string;
  }) {
    const now = new Date();
    return this.runStage2CallbackReconciliation(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: input.taskId }
      });
      if (!task || task.deletedAt || !isTypedStage2Task(task)) {
        await tx.contractESignCallbackLog.update({
          data: {
            errorMessage: "ESIGN_CALLBACK_TRANSACTION_NOT_FOUND",
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return { handled: false, reason: "TASK_NOT_FOUND" };
      }

      const requiredSigners = requireTypedStage2RequiredSigners(task);
      const signer = requiredSigners.find((item) => item.id === input.signerId);
      if (
        !signer ||
        normalizeProviderTransactionId(signer.providerTransactionId) !==
          input.providerTransactionId
      ) {
        throw new BadRequestException(
          "ESIGN_STAGE2_CALLBACK_SIGNER_TRANSACTION_INVALID"
        );
      }

      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        await tx.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: true,
          idempotent: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }
      if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
        await tx.contractESignCallbackLog.update({
          data: {
            errorMessage: "FADADA_TERMINAL_CONFLICT_IGNORED",
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: true,
          ignored: true,
          reason: "TERMINAL_TASK_CONFLICT",
          signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }

      const isFailureObservation =
        input.eventType === FADADA_FAILED_EVENT ||
        input.eventType === FADADA_REJECTED_EVENT;
      if (
        isFailureObservation &&
        (
          signer.signerStatus === ESignSignerStatus.SIGNED ||
          signer.signedAt !== null
        )
      ) {
        await tx.contractESignCallbackLog.update({
          data: {
            errorMessage: "FADADA_SIGNED_STATE_CONFLICT_IGNORED",
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: true,
          ignored: true,
          reason: "SIGNED_STATE_CONFLICT",
          signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }

      if (
        isFailureObservation
      ) {
        if (
          signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM &&
          signer.providerActionType ===
            PrismaESignProviderActionType.PLATFORM_AUTO_SEAL
        ) {
          await tx.contractESignSigner.update({
            data: {
              lastErrorCode: "FADADA_STAGE2_PLATFORM_SEAL_FAILED",
              lastErrorMessage:
                "The Stage 2 platform seal was not completed and can be retried.",
              nextRetryAt: now,
              rejectReason: null,
              rejectedAt: null,
              signerStatus: ESignSignerStatus.PENDING
            },
            where: { id: signer.id }
          });
          await tx.contractESignTask.update({
            data: {
              callbackSnapshot: toJsonValue(input.sanitizedPayload),
              errorSnapshot: toJsonValue({
                code: "FADADA_STAGE2_PLATFORM_SEAL_FAILED",
                slotId: signer.slotId
              }),
              failedAt: null,
              taskStatus: ESignTaskStatus.SIGNING
            },
            where: { id: task.id }
          });
          await tx.vehicleDeliveryHandover.updateMany({
            data: {
              failedAt: null,
              failureReason:
                "Stage 2 platform seal failed and can be retried.",
              status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
            },
            where: {
              deletedAt: null,
              handoverContractId: task.contractId,
              handoverESignTaskId: task.id
            }
          });
          await tx.contractESignCallbackLog.update({
            data: {
              handled: true,
              handledAt: now
            },
            where: { id: input.callbackLogId }
          });
          return {
            handled: true,
            signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
            taskId: task.id
          };
        }
        await tx.contractESignSigner.update({
          data: {
            lastErrorCode:
              input.eventType === FADADA_REJECTED_EVENT
                ? "FADADA_STAGE2_SIGN_REJECTED"
                : "FADADA_STAGE2_SIGN_FAILED",
            lastErrorMessage: "The Stage 2 signing action was not completed.",
            ...(input.eventType === FADADA_REJECTED_EVENT
              ? {
                  rejectReason: "The provider rejected the Stage 2 signing action.",
                  rejectedAt: now,
                  signerStatus: ESignSignerStatus.REJECTED
                }
              : {})
          },
          where: { id: signer.id }
        });
        await tx.contractESignTask.update({
          data: {
            callbackSnapshot: toJsonValue(input.sanitizedPayload),
            errorSnapshot: toJsonValue({
              code:
                input.eventType === FADADA_REJECTED_EVENT
                  ? "FADADA_STAGE2_SIGN_REJECTED"
                  : "FADADA_STAGE2_SIGN_FAILED",
              slotId: signer.slotId
            }),
            failedAt: task.failedAt ?? now,
            taskStatus: ESignTaskStatus.FAILED
          },
          where: { id: task.id }
        });
        await tx.vehicleDeliveryHandover.updateMany({
          data: {
            failedAt: now,
            failureReason: "Stage 2 eSign provider action failed.",
            status: DeliveryHandoverStatus.FAILED
          },
          where: {
            deletedAt: null,
            handoverContractId: task.contractId,
            handoverESignTaskId: task.id
          }
        });
        await tx.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: true,
          signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }

      if (
        input.eventType !== "FADADA_SIGN_COMPLETED" ||
        input.resultCode !== "3000"
      ) {
        if (
          signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM &&
          signer.providerActionType ===
            PrismaESignProviderActionType.PLATFORM_AUTO_SEAL
        ) {
          await tx.contractESignSigner.update({
            data: {
              lastErrorCode: "FADADA_STAGE2_PLATFORM_RESULT_UNKNOWN",
              lastErrorMessage:
                "The Stage 2 platform seal result is unknown and can be retried.",
              nextRetryAt: now,
              signerStatus: ESignSignerStatus.PENDING
            },
            where: { id: signer.id }
          });
          await tx.contractESignTask.update({
            data: {
              callbackSnapshot: toJsonValue(input.sanitizedPayload),
              errorSnapshot: toJsonValue({
                code: "FADADA_STAGE2_PLATFORM_RESULT_UNKNOWN",
                resultCode: sanitizeCallbackCode(input.resultCode),
                slotId: signer.slotId
              }),
              failedAt: null,
              taskStatus: ESignTaskStatus.SIGNING
            },
            where: { id: task.id }
          });
          await tx.vehicleDeliveryHandover.updateMany({
            data: {
              failedAt: null,
              failureReason:
                "Stage 2 platform seal result is unknown and can be retried.",
              status: DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
            },
            where: {
              deletedAt: null,
              handoverContractId: task.contractId,
              handoverESignTaskId: task.id
            }
          });
        }
        await tx.contractESignCallbackLog.update({
          data: {
            errorMessage: `FADADA_UNKNOWN_RESULT_CODE:${sanitizeCallbackCode(input.resultCode)}`,
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: false,
          reason: "UNKNOWN_RESULT_CODE",
          signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }

      if (
        signer.slotId ===
          PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER &&
        signer.providerActionType ===
          PrismaESignProviderActionType.CUSTOMER_MANUAL_SIGN
      ) {
        await this.reconcileCustomerSignedInTransaction(tx, {
          completedAt: now,
          eSignTaskId: task.id,
          providerTransactionId:
            input.providerTransactionId,
          source: "CALLBACK"
        });
        await tx.contractESignTask.update({
          data: {
            callbackSnapshot: toJsonValue(
              input.sanitizedPayload
            )
          },
          where: { id: task.id }
        });
        await tx.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: now
          },
          where: { id: input.callbackLogId }
        });
        return {
          handled: true,
          signingStage:
            "STAGE2_DELIVERY_HANDOVER" as const,
          taskId: task.id
        };
      }

      if (
        signer.slotId !==
          PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM ||
        signer.providerActionType !==
          PrismaESignProviderActionType.PLATFORM_AUTO_SEAL
      ) {
        throw new BadRequestException(
          "ESIGN_STAGE2_CALLBACK_SIGNER_SLOT_INVALID"
        );
      }
      await this.reconcilePlatformSignedInTransaction(tx, {
        completedAt: now,
        eSignTaskId: task.id,
        providerTransactionId: input.providerTransactionId,
        source: "CALLBACK"
      });
      await tx.contractESignTask.update({
        data: {
          callbackSnapshot: toJsonValue(
            input.sanitizedPayload
          )
        },
        where: { id: task.id }
      });
      await tx.contractESignCallbackLog.update({
        data: {
          handled: true,
          handledAt: now
        },
        where: { id: input.callbackLogId }
      });

      return {
        handled: true,
        signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
        taskId: task.id
      };
    });
  }

  private async runStage2CallbackReconciliation<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= STAGE2_CALLBACK_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        });
      } catch (error) {
        if (
          !isPrismaSerializationConflict(error) ||
          attempt === STAGE2_CALLBACK_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error("ESIGN_STAGE2_CALLBACK_RECONCILIATION_EXHAUSTED");
  }

  private async reconcileCustomerSignedInTransaction(
    tx: Prisma.TransactionClient,
    input: Stage2SignedReconciliationInput
  ) {
    const task = await tx.contractESignTask.findUnique({
      include: esignTaskInclude,
      where: { id: input.eSignTaskId }
    });
    if (!task || task.deletedAt || !isTypedStage2Task(task)) {
      throw new BadRequestException(
        "ESIGN_STAGE2_CUSTOMER_TASK_INVALID"
      );
    }
    if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
      throw new BadRequestException(
        "ESIGN_STAGE2_CUSTOMER_TASK_TERMINAL"
      );
    }

    const requiredSigners = requireTypedStage2RequiredSigners(task);
    const customerSigner = requiredSigners.find(
      (signer) =>
        signer.slotId ===
        PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER
    )!;
    const platformSigner = requiredSigners.find(
      (signer) =>
        signer.slotId ===
        PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM
    )!;
    const expectedCustomerTransactionId =
      buildStage2ProviderTransactionId(task.taskNo, "H1");
    const normalizedInputTransactionId =
      normalizeProviderTransactionId(input.providerTransactionId);
    if (
      normalizedInputTransactionId !== expectedCustomerTransactionId ||
      normalizeProviderTransactionId(
        customerSigner.providerTransactionId
      ) !== expectedCustomerTransactionId ||
      normalizeProviderTransactionId(task.providerTaskId) !==
        expectedCustomerTransactionId ||
      normalizeProviderTransactionId(task.providerEnvelopeId) !==
        task.taskNo
    ) {
      throw new BadRequestException(
        "ESIGN_STAGE2_CUSTOMER_TRANSACTION_INVALID"
      );
    }

    const handover =
      await tx.vehicleDeliveryHandover.findFirst({
        where: {
          deletedAt: null,
          handoverContractId: task.contractId,
          handoverESignTaskId: task.id
        }
      });
    if (!handover) {
      throw new BadRequestException(
        "ESIGN_STAGE2_HANDOVER_POINTER_INVALID"
      );
    }
    const workOrders =
      await tx.vehicleHandoverWorkOrder.findMany({
        select: {
          handoverId: true,
          id: true
        },
        take: 2,
        where: {
          handoverId: handover.id
        }
      });
    if (workOrders.length !== 1) {
      throw new BadRequestException(
        "ESIGN_STAGE2_WORK_ORDER_POINTER_INVALID"
      );
    }
    const workOrder = workOrders[0]!;

    await this.recordStage2ProviderQueryAudit(
      tx,
      task,
      PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER,
      expectedCustomerTransactionId,
      input
    );
    if (handover.status === DeliveryHandoverStatus.ARCHIVED) {
      return;
    }

    if (customerSigner.signerStatus !== ESignSignerStatus.SIGNED) {
      const signerUpdated =
        await tx.contractESignSigner.updateMany({
          data: {
            claimExpiresAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            nextRetryAt: null,
            signedAt: input.completedAt,
            signerStatus: ESignSignerStatus.SIGNED
          },
          where: {
            id: customerSigner.id,
            providerTransactionId:
              expectedCustomerTransactionId,
            signerStatus: {
              in: [
                ESignSignerStatus.PENDING,
                ESignSignerStatus.SIGNING
              ]
            },
            slotId:
              PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER,
            taskId: task.id
          }
        });
      if (signerUpdated.count !== 1) {
        throw new BadRequestException(
          "ESIGN_STAGE2_CUSTOMER_TRANSITION_STALE"
        );
      }
    }

    const handoverAlreadyCompleted =
      handover.status === DeliveryHandoverStatus.SIGNED;
    if (!handoverAlreadyCompleted) {
      await tx.contractESignTask.update({
        data: {
          completedAt: null,
          taskStatus: ESignTaskStatus.SIGNING
        },
        where: { id: task.id }
      });
      const handoverUpdated =
        await tx.vehicleDeliveryHandover.updateMany({
          data: {
            completedAt: null,
            customerSignedAt:
              customerSigner.signedAt ?? input.completedAt,
            status:
              DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
          },
          where: {
            deletedAt: null,
            handoverContractId: task.contractId,
            handoverESignTaskId: task.id,
            id: handover.id
          }
        });
      if (handoverUpdated.count !== 1) {
        throw new BadRequestException(
          "ESIGN_STAGE2_HANDOVER_POINTER_INVALID"
        );
      }
    }

    const platformTransactionId =
      buildStage2ProviderTransactionId(task.taskNo, "H2");
    await tx.vehicleHandoverWorkflowJob.upsert({
      create: {
        eSignTaskId: task.id,
        handoverId: handover.id,
        idempotencyKey:
          `platform-seal:${task.id}:${platformTransactionId}`,
        jobType:
          VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
        payload: {
          platformTransactionId
        },
        workOrderId: workOrder.id
      },
      update: {},
      where: {
        idempotencyKey:
          `platform-seal:${task.id}:${platformTransactionId}`
      }
    });
    await tx.vehicleHandoverWorkflowJob.updateMany({
      data: {
        completedAt: input.completedAt,
        jobStatus:
          VehicleHandoverWorkflowJobStatus.CANCELLED
      },
      where: {
        eSignTaskId: task.id,
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType: {
          in: [
            VehicleHandoverWorkflowJobType
              .RECONCILE_CUSTOMER_SIGNATURE
          ]
        },
        workOrderId: workOrder.id
      }
    });

    void platformSigner;
  }

  private async reconcilePlatformSignedInTransaction(
    tx: Prisma.TransactionClient,
    input: Stage2SignedReconciliationInput
  ) {
    const task = await tx.contractESignTask.findUnique({
      include: esignTaskInclude,
      where: { id: input.eSignTaskId }
    });
    if (!task || task.deletedAt || !isTypedStage2Task(task)) {
      throw new BadRequestException(
        "ESIGN_STAGE2_PLATFORM_TASK_INVALID"
      );
    }
    if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
      throw new BadRequestException(
        "ESIGN_STAGE2_PLATFORM_TASK_TERMINAL"
      );
    }

    const requiredSigners = requireTypedStage2RequiredSigners(task);
    const customerSigner = requiredSigners.find(
      (signer) =>
        signer.slotId ===
        PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER
    )!;
    const platformSigner = requiredSigners.find(
      (signer) =>
        signer.slotId ===
        PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM
    )!;
    const expectedCustomerTransactionId =
      buildStage2ProviderTransactionId(task.taskNo, "H1");
    const expectedPlatformTransactionId =
      buildStage2ProviderTransactionId(task.taskNo, "H2");
    if (
      normalizeProviderTransactionId(input.providerTransactionId) !==
        expectedPlatformTransactionId ||
      normalizeProviderTransactionId(
        platformSigner.providerTransactionId
      ) !== expectedPlatformTransactionId ||
      normalizeProviderTransactionId(task.providerTaskId) !==
        expectedCustomerTransactionId ||
      normalizeProviderTransactionId(task.providerEnvelopeId) !==
        task.taskNo
    ) {
      throw new BadRequestException(
        "ESIGN_STAGE2_PLATFORM_TRANSACTION_INVALID"
      );
    }

    const handover =
      await tx.vehicleDeliveryHandover.findFirst({
        where: {
          deletedAt: null,
          handoverContractId: task.contractId,
          handoverESignTaskId: task.id
        }
      });
    if (
      !handover ||
      !Number.isSafeInteger(handover.artifactVersion) ||
      handover.artifactVersion < 1
    ) {
      throw new BadRequestException(
        "ESIGN_STAGE2_HANDOVER_POINTER_INVALID"
      );
    }
    const workOrders =
      await tx.vehicleHandoverWorkOrder.findMany({
        select: {
          handoverId: true,
          id: true
        },
        take: 2,
        where: {
          handoverId: handover.id
        }
      });
    if (workOrders.length !== 1) {
      throw new BadRequestException(
        "ESIGN_STAGE2_WORK_ORDER_POINTER_INVALID"
      );
    }
    const workOrder = workOrders[0]!;

    await this.recordStage2ProviderQueryAudit(
      tx,
      task,
      PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM,
      expectedPlatformTransactionId,
      input
    );
    if (handover.status === DeliveryHandoverStatus.ARCHIVED) {
      return;
    }

    if (platformSigner.signerStatus !== ESignSignerStatus.SIGNED) {
      const signerUpdated =
        await tx.contractESignSigner.updateMany({
          data: {
            claimExpiresAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            nextRetryAt: null,
            signedAt: input.completedAt,
            signerStatus: ESignSignerStatus.SIGNED
          },
          where: {
            id: platformSigner.id,
            providerTransactionId:
              expectedPlatformTransactionId,
            signerStatus: {
              in: [
                ESignSignerStatus.PENDING,
                ESignSignerStatus.SIGNING
              ]
            },
            slotId:
              PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM,
            taskId: task.id
          }
        });
      if (signerUpdated.count !== 1) {
        throw new BadRequestException(
          "ESIGN_STAGE2_PLATFORM_TRANSITION_STALE"
        );
      }
    }

    const customerSigned =
      customerSigner.signerStatus === ESignSignerStatus.SIGNED;
    const completedAt = task.completedAt ?? input.completedAt;
    await tx.contractESignTask.update({
      data: {
        completedAt: customerSigned ? completedAt : null,
        taskStatus: customerSigned
          ? ESignTaskStatus.COMPLETED
          : ESignTaskStatus.SIGNING
      },
      where: { id: task.id }
    });
    const handoverUpdated =
      await tx.vehicleDeliveryHandover.updateMany({
        data: {
          completedAt: customerSigned ? completedAt : null,
          customerSignedAt: customerSigned
            ? customerSigner.signedAt ?? input.completedAt
            : null,
          platformSignedAt:
            platformSigner.signedAt ?? input.completedAt,
          status: customerSigned
            ? DeliveryHandoverStatus.SIGNED
            : DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE
        },
        where: {
          deletedAt: null,
          handoverContractId: task.contractId,
          handoverESignTaskId: task.id,
          id: handover.id,
          status: {
            in: [
              DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
              DeliveryHandoverStatus.PENDING_PLATFORM_SEAL,
              DeliveryHandoverStatus.SIGNED
            ]
          }
        }
      });
    if (handoverUpdated.count !== 1) {
      throw new BadRequestException(
        "ESIGN_STAGE2_HANDOVER_POINTER_INVALID"
      );
    }

    if (customerSigned) {
      await tx.contract.update({
        data: {
          signedAt: task.contract.signedAt ?? completedAt,
          status: ContractStatus.SIGNED
        },
        where: { id: task.contractId }
      });
      const archiveKey =
        `archive:${task.id}:${handover.artifactVersion}`;
      await tx.vehicleHandoverWorkflowJob.upsert({
        create: {
          eSignTaskId: task.id,
          handoverId: handover.id,
          idempotencyKey: archiveKey,
          jobType:
            VehicleHandoverWorkflowJobType.ARCHIVE_SIGNED_PDF,
          payload: {
            artifactVersion: handover.artifactVersion
          },
          workOrderId: workOrder.id
        },
        update: {},
        where: {
          idempotencyKey: archiveKey
        }
      });
    }
    await tx.vehicleHandoverWorkflowJob.updateMany({
      data: {
        completedAt: input.completedAt,
        jobStatus:
          VehicleHandoverWorkflowJobStatus.CANCELLED
      },
      where: {
        eSignTaskId: task.id,
        jobStatus: VehicleHandoverWorkflowJobStatus.PENDING,
        jobType: {
          in: [
            VehicleHandoverWorkflowJobType.AUTO_SEAL_PLATFORM,
            VehicleHandoverWorkflowJobType.RECONCILE_PLATFORM_SEAL
          ]
        },
        workOrderId: workOrder.id
      }
    });

  }

  private async recordStage2ProviderQueryAudit(
    tx: Prisma.TransactionClient,
    task: ESignTaskWithDetails,
    slotId: PrismaESignSlotId,
    providerTransactionId: string,
    input: Stage2SignedReconciliationInput
  ) {
    if (input.source !== "QUERY") {
      return;
    }
    const afterSnapshot = toJsonValue({
      eventType: "STAGE2_PROVIDER_SIGNER_STATUS_QUERY",
      observedAt: input.completedAt.toISOString(),
      provider: task.provider,
      providerContractId: task.providerEnvelopeId,
      providerTaskId: task.providerTaskId,
      providerTransactionId,
      resultCode: input.queryResult.resultCode,
      providerStatus: input.queryResult.status,
      signingStage: task.signingStage,
      slotId,
      source: input.source
    });
    const id = buildStage2ProviderQueryAuditId(
      task.id,
      slotId,
      providerTransactionId
    );
    await tx.auditLog.upsert({
      create: {
        action: AuditAction.UPDATE,
        afterSnapshot,
        entityId: task.id,
        entityType: "ContractESignTaskProviderQuery",
        id,
        module: "esign"
      },
      update: {
        afterSnapshot
      },
      where: { id }
    });
  }

  private async recordUnverifiedCallback(input: {
    eventType?: string | null;
    payload: unknown;
    provider: ESignProviderType;
    providerTaskId?: string | null;
  }) {
    try {
      const callbackLog = await this.prisma.contractESignCallbackLog.create({
        data: {
          eventType: input.eventType,
          payload: toJsonValue(input.payload),
          provider: input.provider,
          providerTaskId: input.providerTaskId,
          verified: false
        }
      });
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: "ESIGN_CALLBACK_VERIFY_FAILED",
          handled: true,
          handledAt: new Date()
        },
        where: { id: callbackLog.id }
      });
    } catch {
      return;
    }
  }

  private async handleFadadaCallback(input: {
    callbackLogId: string;
    eventType?: string | null;
    providerContractId?: string | null;
    providerTaskId?: string | null;
    resultCode?: string | null;
    resultDescription?: string | null;
    sanitizedPayload: unknown;
    task: ESignTaskWithDetails;
  }) {
    if (input.eventType === FADADA_UNKNOWN_EVENT || !input.resultCode) {
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: `FADADA_UNKNOWN_RESULT_CODE:${input.resultCode ?? "missing"}`
        },
        where: { id: input.callbackLogId }
      });
      return {
        handled: false,
        reason: "UNKNOWN_RESULT_CODE",
        resultCode: input.resultCode
      };
    }

    if (input.task.taskStatus === ESignTaskStatus.COMPLETED) {
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: input.eventType === "FADADA_SIGN_COMPLETED"
            ? undefined
            : "FADADA_TERMINAL_COMPLETED_IGNORED",
          handled: true,
          handledAt: new Date(),
          taskId: input.task.id
        },
        where: { id: input.callbackLogId }
      });
      return {
        handled: true,
        idempotent: true,
        resultCode: input.resultCode,
        task: toESignTaskView(input.task)
      };
    }

    if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(input.task.taskStatus)) {
      await this.prisma.contractESignCallbackLog.update({
        data: {
          errorMessage: "FADADA_TERMINAL_CONFLICT_IGNORED",
          handled: true,
          handledAt: new Date(),
          taskId: input.task.id
        },
        where: { id: input.callbackLogId }
      });
      return {
        handled: true,
        ignored: true,
        reason: "TERMINAL_TASK_CONFLICT",
        resultCode: input.resultCode,
        task: toESignTaskView(input.task)
      };
    }

    if (input.eventType === "FADADA_SIGN_COMPLETED") {
      const completed = await this.completeTask(input.task.id, {
        callbackLogId: input.callbackLogId,
        callbackPayload: input.sanitizedPayload,
        eventType: input.eventType,
        providerTaskId: input.providerTaskId,
        source: "provider_callback"
      });
      return {
        handled: true,
        resultCode: input.resultCode,
        task: toESignTaskView(completed)
      };
    }

    if (input.eventType === FADADA_FAILED_EVENT || input.eventType === FADADA_REJECTED_EVENT) {
      const failed = await this.markFadadaCallbackFailed({
        callbackLogId: input.callbackLogId,
        eventType: input.eventType,
        providerContractId: input.providerContractId,
        providerTaskId: input.providerTaskId,
        resultCode: input.resultCode,
        resultDescription: input.resultDescription,
        sanitizedPayload: input.sanitizedPayload,
        taskId: input.task.id
      });
      return {
        handled: true,
        resultCode: input.resultCode,
        task: toESignTaskView(failed)
      };
    }

    await this.prisma.contractESignCallbackLog.update({
      data: {
        errorMessage: `FADADA_UNHANDLED_EVENT:${input.eventType ?? "missing"}`
      },
      where: { id: input.callbackLogId }
    });
    return {
      handled: false,
      reason: "UNKNOWN_RESULT_CODE",
      resultCode: input.resultCode
    };
  }

  private async markFadadaCallbackFailed(input: {
    callbackLogId: string;
    eventType: string;
    providerContractId?: string | null;
    providerTaskId?: string | null;
    resultCode: string;
    resultDescription?: string | null;
    sanitizedPayload: unknown;
    taskId: string;
  }) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: input.taskId }
      });

      if (!task || task.deletedAt) {
        throw new NotFoundException("E-sign task not found.");
      }

      if (task.taskStatus === ESignTaskStatus.COMPLETED || BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
        await tx.contractESignCallbackLog.update({
          data: {
            errorMessage: "FADADA_TERMINAL_CONFLICT_IGNORED",
            handled: true,
            handledAt: now,
            taskId: task.id
          },
          where: { id: input.callbackLogId }
        });
        return task;
      }

      if (input.eventType === FADADA_REJECTED_EVENT) {
        if (isStage1SlotAwareTask(task) && input.providerTaskId) {
          await tx.contractESignSigner.updateMany({
            data: {
              rejectedAt: now,
              rejectReason: input.resultDescription,
              signerStatus: ESignSignerStatus.REJECTED
            },
            where: {
              deletedAt: null,
              providerSignerId: input.providerTaskId,
              taskId: task.id
            }
          });
        } else {
          await tx.contractESignSigner.updateMany({
            data: {
              rejectedAt: now,
              rejectReason: input.resultDescription,
              signerStatus: ESignSignerStatus.REJECTED
            },
            where: {
              deletedAt: null,
              signerType: ESignSignerType.CUSTOMER,
              taskId: task.id
            }
          });
        }
      }

      await tx.contractESignTask.update({
        data: {
          callbackSnapshot: toJsonValue(input.sanitizedPayload),
          errorSnapshot: toJsonValue({
            eventType: input.eventType,
            providerContractId: input.providerContractId,
            providerTaskId: input.providerTaskId,
            resultCode: input.resultCode,
            resultDescription: input.resultDescription
          }),
          failedAt: task.failedAt ?? now,
          taskStatus: ESignTaskStatus.FAILED
        },
        where: { id: task.id }
      });

      await tx.contractESignCallbackLog.update({
        data: {
          handled: true,
          handledAt: now,
          taskId: task.id
        },
        where: { id: input.callbackLogId }
      });

      return tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: task.id }
      });
    });
  }

  private async findCallbackTask(
    provider: ESignProviderType,
    providerTaskId?: string | null,
    providerContractId?: string | null
  ) {
    if (providerTaskId) {
      const signer = await this.prisma.contractESignSigner.findFirst({
        include: {
          task: {
            include: esignTaskInclude
          }
        },
        where: {
          deletedAt: null,
          providerSignerId: providerTaskId,
          task: {
            deletedAt: null,
            provider
          }
        }
      });

      if (signer?.task) {
        if (!taskMatchesProviderContract(signer.task, providerContractId)) {
          return null;
        }
        return signer.task;
      }

      const task = await this.prisma.contractESignTask.findFirst({
        include: esignTaskInclude,
        where: {
          deletedAt: null,
          provider,
          providerTaskId
        }
      });

      if (task) {
        if (!taskMatchesProviderContract(task, providerContractId)) {
          return null;
        }
        return task;
      }
    }

    if (provider === ESignProviderType.FADADA) {
      return null;
    }

    if (providerContractId) {
      return this.prisma.contractESignTask.findFirst({
        include: esignTaskInclude,
        where: {
          OR: [
            { providerEnvelopeId: providerContractId },
            { taskNo: providerContractId }
          ],
          deletedAt: null,
          provider
        }
      });
    }

    return null;
  }

  private async completeTask(taskId: string, options: {
    actorId?: string;
    callbackLogId?: string;
    callbackPayload?: unknown;
    context?: PortalRequestContext;
    eventType?: string;
    providerTaskId?: string | null;
    source: "portal_mock" | "provider_callback";
  }) {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: taskId }
      });

      if (!task || task.deletedAt) {
        throw new NotFoundException("电子签任务不存在。");
      }

      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        if (options.callbackLogId) {
          await tx.contractESignCallbackLog.update({
            data: {
              handled: true,
              handledAt: now
            },
            where: { id: options.callbackLogId }
          });
        }
        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: task.id }
        });
      }

      if (BLOCKED_COMPLETE_ESIGN_TASK_STATUSES.includes(task.taskStatus)) {
        throw new BadRequestException("当前电子签任务状态不允许签署完成。");
      }

      if (isStage1SlotAwareTask(task)) {
        return this.completeStage1SlotRows({
          now,
          options,
          task,
          tx
        });
      }
      if (isStage2HandoverTask(task)) {
        return this.completeStage2HandoverSlotRows({
          now,
          options,
          task,
          tx
        });
      }

      const requiresPlatformAutoSeal = this.requiresPlatformAutoSeal(task);
      await tx.contractESignSigner.updateMany({
        data: {
          signedAt: now,
          signerStatus: ESignSignerStatus.SIGNED
        },
        where: {
          deletedAt: null,
          signerType: ESignSignerType.CUSTOMER,
          taskId: task.id
        }
      });
      if (requiresPlatformAutoSeal) {
        await tx.contractESignTask.update({
          data: {
            callbackSnapshot: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
            taskStatus: ESignTaskStatus.SIGNING,
            updatedBy: options.actorId
          },
          where: { id: task.id }
        });
        if (options.callbackLogId) {
          await tx.contractESignCallbackLog.update({
            data: {
              handled: true,
              handledAt: now,
              taskId: task.id
            },
            where: { id: options.callbackLogId }
          });
        } else {
          await tx.contractESignCallbackLog.create({
            data: {
              eventType: options.eventType,
              handled: true,
              handledAt: now,
              payload: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
              provider: task.provider,
              providerTaskId: options.providerTaskId ?? task.providerTaskId,
              taskId: task.id,
              verified: true
            }
          });
        }

        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: task.id }
        });
      }
      await tx.contractESignTask.update({
        data: {
          callbackSnapshot: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
          completedAt: now,
          taskStatus: ESignTaskStatus.COMPLETED,
          updatedBy: options.actorId
        },
        where: { id: task.id }
      });
      await tx.contract.update({
        data: {
          signedAt: task.contract.signedAt ?? now,
          status: ContractStatus.SIGNED,
          updatedBy: options.actorId
        },
        where: { id: task.contractId }
      });
      await tx.subscriptionOrder.updateMany({
        data: {
          orderStatus: OrderStatus.PENDING_PAYMENT,
          updatedBy: options.actorId
        },
        where: {
          contractId: task.contractId,
          deletedAt: null,
          id: task.orderId ?? task.contract.orderId,
          orderStatus: OrderStatus.PENDING_SIGN
        }
      });
      if (options.callbackLogId) {
        await tx.contractESignCallbackLog.update({
          data: {
            handled: true,
            handledAt: now,
            taskId: task.id
          },
          where: { id: options.callbackLogId }
        });
      } else {
        await tx.contractESignCallbackLog.create({
          data: {
            eventType: options.eventType,
            handled: true,
            handledAt: now,
            payload: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
            provider: task.provider,
            providerTaskId: options.providerTaskId ?? task.providerTaskId,
            taskId: task.id,
            verified: true
          }
        });
      }

      return tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: task.id }
      });
    });

    const finalResult = this.shouldTriggerPlatformAutoSeal(result)
      ? await this.triggerPlatformAutoSeal(result, options)
      : result;

    if (finalResult.taskStatus !== ESignTaskStatus.COMPLETED) {
      return finalResult;
    }

    await this.auditService.write({
      action: AuditAction.APPROVE,
      after: toESignTaskView(finalResult),
      entityId: finalResult.id,
      entityType: "contract_esign_task",
      ipAddress: options.context?.ipAddress,
      module: "esign",
      operatorId: options.actorId,
      userAgent: options.context?.userAgent
    });

    if (isStage2HandoverTask(finalResult)) {
      return finalResult;
    }

    await this.safeNotifyCustomer({
      aggregateId: finalResult.orderId ?? finalResult.contract.orderId,
      aggregateNo: finalResult.contract.order.orderNo,
      aggregateType: "order",
      content: "合同已签署完成，订单进入待支付状态。",
      customerId: finalResult.customerId ?? finalResult.contract.customerId,
      eventType: NotificationEventType.PAYMENT_PENDING,
      notificationType: NotificationType.PAYMENT_PENDING,
      status: OrderStatus.PENDING_PAYMENT,
      title: "订单待支付",
      url: `/portal/orders/${finalResult.orderId ?? finalResult.contract.orderId}`
    });

    return finalResult;
  }

  private async completeStage1SlotRows(input: {
    now: Date;
    options: {
      actorId?: string;
      callbackLogId?: string;
      callbackPayload?: unknown;
      context?: PortalRequestContext;
      eventType?: string;
      providerTaskId?: string | null;
      source: "portal_mock" | "provider_callback";
    };
    task: ESignTaskWithDetails;
    tx: Prisma.TransactionClient;
  }) {
    const providerTransactionId = input.options.providerTaskId ?? input.task.providerTaskId;
    if (!providerTransactionId) {
      throw new BadRequestException("ESIGN_STAGE1_SLOT_CALLBACK_TRANSACTION_MISSING");
    }

    const matchingSigners = input.task.signers.filter((signer) => signer.providerSignerId === providerTransactionId);
    if (matchingSigners.length === 0) {
      throw new BadRequestException("ESIGN_STAGE1_SLOT_CALLBACK_TRANSACTION_NOT_FOUND");
    }

    for (const signer of matchingSigners) {
      if (signer.signerStatus === ESignSignerStatus.SIGNED) {
        continue;
      }
      await input.tx.contractESignSigner.update({
        data: {
          signedAt: input.now,
          signerStatus: ESignSignerStatus.SIGNED
        },
        where: { id: signer.id }
      });
    }

    await input.tx.contractESignTask.update({
      data: {
        callbackSnapshot: input.options.callbackPayload === undefined
          ? undefined
          : toJsonValue(input.options.callbackPayload),
        taskStatus: ESignTaskStatus.SIGNING,
        updatedBy: input.options.actorId
      },
      where: { id: input.task.id }
    });

    const signedTask = await input.tx.contractESignTask.findUniqueOrThrow({
      include: esignTaskInclude,
      where: { id: input.task.id }
    });

    if (!allRequiredSignersSigned(signedTask)) {
      await this.recordCompletionCallback(input.tx, signedTask, input.options, input.now);
      return input.tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: signedTask.id }
      });
    }

    await input.tx.contractESignTask.update({
      data: {
        callbackSnapshot: input.options.callbackPayload === undefined
          ? undefined
          : toJsonValue(input.options.callbackPayload),
        completedAt: signedTask.completedAt ?? input.now,
        taskStatus: ESignTaskStatus.COMPLETED,
        updatedBy: input.options.actorId
      },
      where: { id: signedTask.id }
    });
    await input.tx.contract.update({
      data: {
        signedAt: signedTask.contract.signedAt ?? input.now,
        status: ContractStatus.SIGNED,
        updatedBy: input.options.actorId
      },
      where: { id: signedTask.contractId }
    });
    await input.tx.subscriptionOrder.updateMany({
      data: {
        orderStatus: OrderStatus.PENDING_PAYMENT,
        updatedBy: input.options.actorId
      },
      where: {
        contractId: signedTask.contractId,
        deletedAt: null,
        id: signedTask.orderId ?? signedTask.contract.orderId,
        orderStatus: OrderStatus.PENDING_SIGN
      }
    });
    await this.recordCompletionCallback(input.tx, signedTask, input.options, input.now);

    return input.tx.contractESignTask.findUniqueOrThrow({
      include: esignTaskInclude,
      where: { id: signedTask.id }
    });
  }

  private async completeStage2HandoverSlotRows(input: {
    now: Date;
    options: {
      actorId?: string;
      callbackLogId?: string;
      callbackPayload?: unknown;
      context?: PortalRequestContext;
      eventType?: string;
      providerTaskId?: string | null;
      source: "portal_mock" | "provider_callback";
    };
    task: ESignTaskWithDetails;
    tx: Prisma.TransactionClient;
  }) {
    const providerTransactionId = input.options.providerTaskId ?? input.task.providerTaskId;
    if (!providerTransactionId) {
      throw new BadRequestException("ESIGN_STAGE2_HANDOVER_CALLBACK_TRANSACTION_MISSING");
    }

    const matchingSigners = input.task.signers.filter((signer) => signer.providerSignerId === providerTransactionId);
    if (matchingSigners.length === 0) {
      throw new BadRequestException("ESIGN_STAGE2_HANDOVER_CALLBACK_TRANSACTION_NOT_FOUND");
    }

    for (const signer of matchingSigners) {
      if (signer.signerStatus === ESignSignerStatus.SIGNED) {
        continue;
      }
      await input.tx.contractESignSigner.update({
        data: {
          signedAt: input.now,
          signerStatus: ESignSignerStatus.SIGNED
        },
        where: { id: signer.id }
      });
    }

    await input.tx.contractESignTask.update({
      data: {
        callbackSnapshot: input.options.callbackPayload === undefined
          ? undefined
          : toJsonValue(input.options.callbackPayload),
        taskStatus: ESignTaskStatus.SIGNING,
        updatedBy: input.options.actorId
      },
      where: { id: input.task.id }
    });

    const signedTask = await input.tx.contractESignTask.findUniqueOrThrow({
      include: esignTaskInclude,
      where: { id: input.task.id }
    });
    const customerSignedAt = firstSignerSignedAt(signedTask, ESignSignerType.CUSTOMER);
    const platformSignedAt = firstSignerSignedAt(signedTask, ESignSignerType.PLATFORM);

    await input.tx.vehicleDeliveryHandover.updateMany({
      data: {
        customerSignedAt: customerSignedAt ?? undefined,
        platformSignedAt: platformSignedAt ?? undefined,
        status: customerSignedAt && !platformSignedAt
          ? DeliveryHandoverStatus.PENDING_PLATFORM_SEAL
          : DeliveryHandoverStatus.PENDING_CUSTOMER_SIGNATURE,
        updatedBy: input.options.actorId
      },
      where: stage2HandoverWhere(signedTask)
    });

    if (!allRequiredSignersSigned(signedTask)) {
      await this.recordCompletionCallback(input.tx, signedTask, input.options, input.now);
      return input.tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: signedTask.id }
      });
    }

    await input.tx.contractESignTask.update({
      data: {
        callbackSnapshot: input.options.callbackPayload === undefined
          ? undefined
          : toJsonValue(input.options.callbackPayload),
        completedAt: signedTask.completedAt ?? input.now,
        taskStatus: ESignTaskStatus.COMPLETED,
        updatedBy: input.options.actorId
      },
      where: { id: signedTask.id }
    });
    await input.tx.contract.update({
      data: {
        signedAt: signedTask.contract.signedAt ?? input.now,
        status: ContractStatus.SIGNED,
        updatedBy: input.options.actorId
      },
      where: { id: signedTask.contractId }
    });
    await input.tx.vehicleDeliveryHandover.updateMany({
      data: {
        completedAt: signedTask.completedAt ?? input.now,
        customerSignedAt: customerSignedAt ?? input.now,
        platformSignedAt: platformSignedAt ?? input.now,
        status: DeliveryHandoverStatus.SIGNED,
        updatedBy: input.options.actorId
      },
      where: stage2HandoverWhere(signedTask)
    });
    await this.recordCompletionCallback(input.tx, signedTask, input.options, input.now);

    return input.tx.contractESignTask.findUniqueOrThrow({
      include: esignTaskInclude,
      where: { id: signedTask.id }
    });
  }

  private async recordCompletionCallback(
    tx: Prisma.TransactionClient,
    task: ESignTaskWithDetails,
    options: {
      callbackLogId?: string;
      callbackPayload?: unknown;
      eventType?: string;
      providerTaskId?: string | null;
    },
    now: Date
  ) {
    if (options.callbackLogId) {
      await tx.contractESignCallbackLog.update({
        data: {
          handled: true,
          handledAt: now,
          taskId: task.id
        },
        where: { id: options.callbackLogId }
      });
      return;
    }

    await tx.contractESignCallbackLog.create({
      data: {
        eventType: options.eventType,
        handled: true,
        handledAt: now,
        payload: options.callbackPayload === undefined ? undefined : toJsonValue(options.callbackPayload),
        provider: task.provider,
        providerTaskId: options.providerTaskId ?? task.providerTaskId,
        taskId: task.id,
        verified: true
      }
    });
  }

  private requiresPlatformAutoSeal(task: ESignTaskWithDetails) {
    return !isStage1SlotAwareTask(task) && this.isEnterpriseAutoSealEnabled() && hasPlatformSigner(task);
  }

  private shouldTriggerPlatformAutoSeal(task: ESignTaskWithDetails) {
    if (this.requiresPlatformAutoSeal(task)) {
      return task.taskStatus !== ESignTaskStatus.COMPLETED &&
        hasSignedCustomerSigner(task) &&
        !hasSignedPlatformSigner(task);
    }

    return this.requiresStage1PlatformAutoSeal(task);
  }

  private requiresStage1PlatformAutoSeal(task: ESignTaskWithDetails) {
    return isStage1SlotAwareTask(task) &&
      this.isStage1MultiSlotEnabled() &&
      this.isEnterpriseAutoSealEnabled() &&
      task.taskStatus !== ESignTaskStatus.COMPLETED &&
      hasAllStage1CustomerSlotsSigned(task) &&
      hasUnsignedStage1PlatformSlots(task) &&
      !hasStage1PlatformAutoSealTransaction(task);
  }

  private async triggerPlatformAutoSeal(
    task: ESignTaskWithDetails,
    options: {
      actorId?: string;
      context?: PortalRequestContext;
      source: "portal_mock" | "provider_callback";
    }
  ) {
    if (isStage1SlotAwareTask(task)) {
      return this.triggerStage1PlatformAutoSeal(task, options);
    }

    const platformSigner = getPlatformSigner(task);
    const transactionId = platformSigner?.providerSignerId ?? buildProviderTransactionId(task.taskNo, 2);
    if (
      !this.provider.autoSealTask ||
      task.provider === ESignProviderType.MOCK
    ) {
      return this.recordPlatformAutoSealFailure(task.id, {
        errorMessage: "ESIGN_PLATFORM_AUTO_SEAL_UNSUPPORTED",
        providerSignerId: transactionId,
        status: "FAILED"
      }, options.actorId);
    }

    const placement = this.resolvePlatformSealPlacement();
    if (!placement) {
      return this.recordPlatformAutoSealFailure(task.id, {
        errorMessage: "ESIGN_PLATFORM_SEAL_KEYWORD_MISSING",
        providerSignerId: transactionId,
        resultCode: "PLATFORM_SEAL_POSITIONING_MISSING",
        resultDescription: "Platform seal keyword is missing.",
        status: "FAILED"
      }, options.actorId);
    }

    try {
      const result = await this.provider.autoSealTask({
        callbackUrl: this.buildCallbackUrl(),
        contractId: task.contractId,
        documentName: task.documentName ?? undefined,
        placement,
        providerEnvelopeId: task.providerEnvelopeId ?? undefined,
        sealId: readSealId(platformSigner?.snapshot),
        taskId: task.id,
        taskNo: task.taskNo,
        transactionId
      });
      if (result.status === "COMPLETED") {
        return this.finalizePlatformAutoSeal(task.id, result, options.actorId);
      }

      return this.recordPlatformAutoSealFailure(task.id, result, options.actorId);
    } catch (error) {
      return this.recordPlatformAutoSealFailure(task.id, {
        errorMessage: error instanceof Error ? error.message : String(error),
        providerSignerId: transactionId,
        status: "FAILED"
      }, options.actorId);
    }
  }

  private async triggerStage1PlatformAutoSeal(
    task: ESignTaskWithDetails,
    options: {
      actorId?: string;
      context?: PortalRequestContext;
      source: "portal_mock" | "provider_callback";
    }
  ) {
    const platformSigners = getStage1PlatformSlotSigners(task);
    const transactionId = buildProviderTransactionId(task.taskNo, 2);
    if (
      !this.provider.autoSealTask ||
      task.provider === ESignProviderType.MOCK
    ) {
      return this.recordPlatformAutoSealFailure(task.id, {
        errorMessage: "ESIGN_PLATFORM_AUTO_SEAL_UNSUPPORTED",
        providerSignerId: transactionId,
        status: "FAILED"
      }, options.actorId);
    }

    const signingSlotCoordinates = platformSigners.map((signer) => {
      const slotId = readSnapshotString(signer.snapshot, "slotId") as ESignSlotId | undefined;
      const coordinate = slotId ? readStage1SlotCoordinate(signer.snapshot, slotId) : undefined;
      if (!slotId || !coordinate) {
        throw new Error(`${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING}: platform Stage 1 slot coordinate is missing`);
      }
      return coordinate;
    });

    try {
      const result = await this.provider.autoSealTask({
        callbackUrl: this.buildCallbackUrl(),
        contractId: task.contractId,
        documentName: task.documentName ?? undefined,
        providerEnvelopeId: task.providerEnvelopeId ?? undefined,
        sealId: readSealId(platformSigners[0]?.snapshot),
        signingSlotCoordinates,
        signingSlots: STAGE1_SIGNING_SLOTS.filter((slot) => slot.providerActionType === "PLATFORM_AUTO_SEAL"),
        signingStage: STAGE1_SIGNING_STAGE,
        taskId: task.id,
        taskNo: task.taskNo,
        transactionId
      });
      if (result.status === "COMPLETED") {
        return this.finalizePlatformAutoSeal(task.id, result, options.actorId);
      }

      return this.recordPlatformAutoSealFailure(task.id, result, options.actorId);
    } catch (error) {
      return this.recordPlatformAutoSealFailure(task.id, {
        errorMessage: error instanceof Error ? error.message : String(error),
        providerSignerId: transactionId,
        status: "FAILED"
      }, options.actorId);
    }
  }

  private async finalizePlatformAutoSeal(taskId: string, result: AutoSealTaskResult, actorId?: string) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: taskId }
      });
      if (!task || task.deletedAt) {
        throw new NotFoundException("E-sign task not found.");
      }
      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        return task;
      }

      if (isStage1SlotAwareTask(task)) {
        for (const signer of getStage1PlatformSlotSigners(task)) {
          await tx.contractESignSigner.update({
            data: {
              providerSignerId: result.providerSignerId,
              signedAt: now,
              signerStatus: ESignSignerStatus.SIGNED,
              snapshot: toJsonValue(mergeSnapshot(signer.snapshot, {
                coveredSlotIds: result.coveredSlotIds ?? getStage1PlatformSlotIds(task),
                providerActionType: result.providerActionType ?? "PLATFORM_AUTO_SEAL",
                providerTransactionId: result.providerTransactionId ?? result.providerSignerId,
                signingStage: result.signingStage ?? STAGE1_SIGNING_STAGE
              }))
            },
            where: { id: signer.id }
          });
        }
      } else {
        await tx.contractESignSigner.updateMany({
          data: {
            providerSignerId: result.providerSignerId,
            signedAt: now,
            signerStatus: ESignSignerStatus.SIGNED
          },
          where: {
            deletedAt: null,
            signerType: ESignSignerType.PLATFORM,
            taskId: task.id
          }
        });
      }
      await tx.contractESignTask.update({
        data: {
          errorSnapshot: Prisma.JsonNull,
          responseSnapshot: toJsonValue(mergeSnapshot(task.responseSnapshot, {
            enterpriseAutoSeal: {
              providerSignerId: result.providerSignerId,
              resultCode: result.resultCode,
              resultDescription: result.resultDescription,
              status: result.status
            }
          })),
          taskStatus: ESignTaskStatus.SIGNING,
          updatedBy: actorId
        },
        where: { id: task.id }
      });

      const signedTask = await tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: task.id }
      });
      if (!allRequiredSignersSigned(signedTask)) {
        return signedTask;
      }

      await tx.contractESignTask.update({
        data: {
          completedAt: signedTask.completedAt ?? now,
          taskStatus: ESignTaskStatus.COMPLETED,
          updatedBy: actorId
        },
        where: { id: signedTask.id }
      });
      await tx.contract.update({
        data: {
          signedAt: signedTask.contract.signedAt ?? now,
          status: ContractStatus.SIGNED,
          updatedBy: actorId
        },
        where: { id: signedTask.contractId }
      });
      if (isStage2HandoverTask(signedTask)) {
        await tx.vehicleDeliveryHandover.updateMany({
          data: {
            completedAt: signedTask.completedAt ?? now,
            customerSignedAt: firstSignerSignedAt(signedTask, ESignSignerType.CUSTOMER) ?? now,
            platformSignedAt: firstSignerSignedAt(signedTask, ESignSignerType.PLATFORM) ?? now,
            status: DeliveryHandoverStatus.SIGNED,
            updatedBy: actorId
          },
          where: stage2HandoverWhere(signedTask)
        });

        return tx.contractESignTask.findUniqueOrThrow({
          include: esignTaskInclude,
          where: { id: signedTask.id }
        });
      }
      await tx.subscriptionOrder.updateMany({
        data: {
          orderStatus: OrderStatus.PENDING_PAYMENT,
          updatedBy: actorId
        },
        where: {
          contractId: signedTask.contractId,
          deletedAt: null,
          id: signedTask.orderId ?? signedTask.contract.orderId,
          orderStatus: OrderStatus.PENDING_SIGN
        }
      });

      return tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: signedTask.id }
      });
    });
  }

  private async recordPlatformAutoSealFailure(
    taskId: string,
    result: AutoSealTaskResult & { errorMessage?: string },
    actorId?: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.contractESignTask.findUnique({
        include: esignTaskInclude,
        where: { id: taskId }
      });
      if (!task || task.deletedAt) {
        throw new NotFoundException("E-sign task not found.");
      }
      if (task.taskStatus === ESignTaskStatus.COMPLETED) {
        return task;
      }

      await tx.contractESignSigner.updateMany({
        data: {
          providerSignerId: result.providerSignerId,
          signerStatus: result.status === "PENDING" ? ESignSignerStatus.SIGNING : ESignSignerStatus.PENDING
        },
        where: {
          deletedAt: null,
          signerType: ESignSignerType.PLATFORM,
          taskId: task.id
        }
      });
      await tx.contractESignTask.update({
        data: {
          errorSnapshot: toJsonValue({
            errorMessage: result.errorMessage,
            providerSignerId: result.providerSignerId,
            resultCode: result.resultCode,
            resultDescription: result.resultDescription,
            status: result.status
          }),
          responseSnapshot: toJsonValue(mergeSnapshot(task.responseSnapshot, {
            enterpriseAutoSeal: {
              providerSignerId: result.providerSignerId,
              resultCode: result.resultCode,
              resultDescription: result.resultDescription,
              status: result.status
            }
          })),
          taskStatus: ESignTaskStatus.SIGNING,
          updatedBy: actorId
        },
        where: { id: task.id }
      });

      return tx.contractESignTask.findUniqueOrThrow({
        include: esignTaskInclude,
        where: { id: task.id }
      });
    });
  }

  private isEnterpriseAutoSealEnabled() {
    return parseBoolean(this.configService.get<string>(ENTERPRISE_AUTO_SEAL_ENABLED_ENV));
  }

  private isStage1MultiSlotEnabled() {
    return parseBoolean(this.configService.get<string>(STAGE1_MULTI_SLOT_ENABLED_ENV));
  }

  private async preflightSigningPdfArtifact(contractId: string) {
    const fadadaEnabled = parseBoolean(this.configService.get<string>("FADADA_ENABLED"));
    const enterpriseAutoSealEnabled = this.isEnterpriseAutoSealEnabled();
    const stage1MultiSlotEnabled = this.isStage1MultiSlotEnabled();
    if (!fadadaEnabled && !enterpriseAutoSealEnabled && !stage1MultiSlotEnabled) {
      return;
    }
    if (!this.contractPdfArtifactService) {
      throw new Error("CONTRACT_PDF_ARTIFACT_REQUIRED: signing PDF artifact preflight service is unavailable");
    }

    const artifact = await this.contractPdfArtifactService.preflightContractPdfArtifact(contractId, {
      enterpriseAutoSealEnabled,
      fadadaEnabled,
      purpose: "FADADA_UPLOAD",
      requireGeneratedContractArtifact: enterpriseAutoSealEnabled || stage1MultiSlotEnabled,
      requireStage1SlotCoordinates: stage1MultiSlotEnabled
    });
    if (stage1MultiSlotEnabled && artifact && !hasRequiredStage1SlotCoordinates(artifact.slotCoordinates)) {
      throw new Error(
        `${CONTRACT_PDF_ARTIFACT_SLOT_COORDINATES_MISSING}: generated Stage 1 slot coordinates are required`
      );
    }
    return artifact;
  }

  private async assertCustomerReadyForProviderSigning(customerId: string) {
    if (this.providerType !== ESignProviderType.FADADA) {
      return;
    }

    const readinessService = this.fadadaReadinessService ??
      new FadadaCustomerReadinessService(this.prisma, this.configService);
    const readiness = await readinessService.getReadiness(customerId);
    if (!readiness.readyForSigning) {
      const blockingCode = readiness.blockingCode ?? "FADADA_PROVIDER_STATUS_UNKNOWN";
      const blockingMessage = readiness.blockingMessage ?? "请先完成法大大实名认证并绑定实名证书";
      throw new BadRequestException(
        `${FADADA_CUSTOMER_SIGNING_NOT_READY}: ${blockingCode}: ${blockingMessage}`
      );
    }
  }

  private resolvePlatformSealPlacement(): AutoSealPlacement | undefined {
    const keyword = this.configService.get<string>(PLATFORM_SEAL_KEYWORD_ENV)?.trim();
    if (!keyword) {
      return undefined;
    }
    return {
      keyword,
      type: "KEYWORD"
    };
  }

  private async safeNotifyCustomer(input: {
    aggregateId: string;
    aggregateNo: string;
    aggregateType: string;
    content: string;
    customerId: string;
    eventType: NotificationEventType;
    notificationType: NotificationType;
    status: string;
    title: string;
    url: string;
  }) {
    if (!this.notificationService) return;
    try {
      await this.notificationService.notifyCustomer({
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        content: input.content,
        customerId: input.customerId,
        data: {
          aggregateNo: input.aggregateNo,
          status: input.status
        },
        eventType: input.eventType,
        notificationType: input.notificationType,
        title: input.title,
        url: input.url
      });
    } catch {
      // Notification delivery must not block e-sign completion.
    }
  }

  private assertContractCanStartESign(contract: ContractForESign) {
    if (contract.deletedAt) {
      throw new NotFoundException("合同不存在。");
    }
    if (!SIGNABLE_CONTRACT_STATUSES.includes(contract.status)) {
      throw new BadRequestException("当前合同状态不允许发起电子签。");
    }
    if (!contract.order || contract.order.deletedAt) {
      throw new BadRequestException("合同所属订单无效。");
    }
    if (contract.order.contractId !== contract.id) {
      throw new BadRequestException("当前合同不是订单的当前有效合同。");
    }
  }

  private async findContractForESign(id: string) {
    const contract = await this.prisma.contract.findFirst({
      include: contractForESignInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!contract) {
      throw new NotFoundException("合同不存在。");
    }

    return contract;
  }

  private async findPortalContractOrThrow(id: string, customerId: string) {
    const contract = await this.prisma.contract.findFirst({
      include: contractForESignInclude,
      where: {
        customerId,
        deletedAt: null,
        id
      }
    });

    if (!contract) {
      throw new NotFoundException("合同不存在。");
    }

    return contract;
  }

  private async findTaskOrThrow(id: string) {
    const task = await this.prisma.contractESignTask.findFirst({
      include: esignTaskInclude,
      where: {
        deletedAt: null,
        id
      }
    });

    if (!task) {
      throw new NotFoundException("电子签任务不存在。");
    }

    return task;
  }

  private buildCallbackUrl() {
    const apiBaseUrl = trimTrailingSlash(
      this.configService.get<string>("API_BASE_URL") ?? "http://localhost:3001/api"
    );
    return `${apiBaseUrl}/esign/callback/${this.providerType.toLowerCase()}`;
  }

  private buildPortalContractUrl(contractId: string) {
    const portalBaseUrl = trimTrailingSlash(
      this.configService.get<string>("PORTAL_BASE_URL") ?? "http://localhost:3000"
    );
    return `${portalBaseUrl}/portal/contracts/${encodeURIComponent(contractId)}`;
  }

  private get providerType() {
    return parseProvider(this.configService.get<string>("ESIGN_PROVIDER") ?? "mock");
  }

  private isMockEnabled() {
    return (this.configService.get<string>("ESIGN_MOCK_ENABLED") ?? "true").toLowerCase() === "true";
  }
}

function findCurrentPortalSigningTask(contract: ContractForESign) {
  return contract.esignTasks.find((task) =>
    ACTIVE_ESIGN_TASK_STATUSES.includes(task.taskStatus)
  );
}

function findCurrentPortalStage1SigningTask(contract: ContractForESign) {
  return contract.esignTasks.find(
    (task) =>
      ACTIVE_ESIGN_TASK_STATUSES.includes(task.taskStatus) &&
      task.signingStage ===
        PrismaESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT &&
      task.documentType ===
        PrismaESignDocumentType.SUBSCRIPTION_CONTRACT
  );
}

function findStage2PortalSigningTask(contract: ContractForESign) {
  return contract.esignTasks.find(
    (task) =>
      task.signingStage ===
        PrismaESignSigningStage.STAGE2_DELIVERY_HANDOVER ||
      task.documentType === PrismaESignDocumentType.DELIVERY_HANDOVER
  );
}

function ensureTaskOwnedByCustomer(task: ESignTaskWithDetails, customerId: string) {
  if (task.customerId !== customerId || task.contract.customerId !== customerId) {
    throw new NotFoundException("电子签任务不存在。");
  }
}

function ensureCanAccessContractByOwner(
  contract: ContractForESign | ESignTaskWithDetails["contract"],
  user: RequestUser
) {
  if (canViewAllOrders(user)) {
    return;
  }
  if (contract.order.application.salesUserId !== user.id) {
    throw new NotFoundException("合同不存在。");
  }
}

function canViewAllOrders(user: RequestUser) {
  return user.roles.includes("admin") || user.permissions.includes("order:view:all");
}

function findPlatformSigningStep(plan?: ApprovedSigningPlanRef) {
  return plan?.steps.find((step) => step.signerType === "PLATFORM" && step.required !== false);
}

function buildStage1SignerCreates(
  contract: ContractForESign,
  slots: ESignSigningSlot[],
  platformStep?: ApprovedSigningPlanRef["steps"][number]
): Prisma.ContractESignSignerCreateWithoutTaskInput[] {
  return slots.map((slot) => {
    const signerType = toPrismaSignerType(slot.signerRole);
    return {
      customerId: signerType === ESignSignerType.CUSTOMER ? contract.customerId : undefined,
      signerName: signerType === ESignSignerType.CUSTOMER ? contract.customer.name : "Platform",
      signerPhone: signerType === ESignSignerType.CUSTOMER ? contract.customer.mobile : undefined,
      signerStatus: ESignSignerStatus.PENDING,
      signerType,
      snapshot: toJsonValue(buildStage1SlotSnapshot(slot, platformStep))
    };
  });
}

function buildStage1SlotSnapshot(
  slot: ESignSigningSlot,
  platformStep?: ApprovedSigningPlanRef["steps"][number]
) {
  const snapshot: Record<string, unknown> = {
    documentType: slot.documentType,
    keyword: slot.keyword,
    providerActionType: slot.providerActionType,
    required: slot.required !== false,
    signerRole: slot.signerRole,
    signingStage: slot.signingStage,
    slotId: slot.slotId
  };
  if (slot.keyx !== undefined) snapshot.keyx = slot.keyx;
  if (slot.keyy !== undefined) snapshot.keyy = slot.keyy;
  if (slot.positionType !== undefined) snapshot.positionType = slot.positionType;
  if (slot.signerRole === "PLATFORM") {
    if (platformStep?.sealId) snapshot.sealId = platformStep.sealId;
    snapshot.providerSignerRole = platformStep?.signerRole ?? "ENTERPRISE_SEAL";
    snapshot.stepOrder = platformStep?.stepOrder ?? 2;
  }
  return snapshot;
}

function toPrismaSignerType(role: ESignSignerRole) {
  return role === "PLATFORM" ? ESignSignerType.PLATFORM : ESignSignerType.CUSTOMER;
}

function collectProviderActions(providerResult: CreateSignTaskResult): ESignProviderActionResult[] {
  if (providerResult.actions?.length) {
    return providerResult.actions;
  }

  return (providerResult.signers ?? []).flatMap((signer) => {
    const coveredSlotIds = signer.coveredSlotIds ?? (signer.slotId ? [signer.slotId] : undefined);
    if (!coveredSlotIds?.length) {
      return [];
    }
    return [{
      coveredSlotIds,
      providerActionType: signer.providerActionType,
      providerSignerId: signer.providerSignerId,
      providerTransactionId: signer.providerTransactionId,
      signUrl: signer.signUrl,
      signUrlExpiresAt: signer.signUrlExpiresAt,
      signerType: signer.signerType,
      signingStage: signer.signingStage
    }];
  });
}

function findCustomerActionResult(providerResult: CreateSignTaskResult) {
  return collectProviderActions(providerResult).find((action) =>
    action.providerActionType === "CUSTOMER_MANUAL_SIGN" || action.signerType === "CUSTOMER"
  );
}

function getPlatformSigner(task: ESignTaskWithDetails) {
  return task.signers.find((signer) => signer.signerType === ESignSignerType.PLATFORM);
}

function hasPlatformSigner(task: ESignTaskWithDetails) {
  return Boolean(getPlatformSigner(task));
}

function hasSignedCustomerSigner(task: ESignTaskWithDetails) {
  return task.signers.some((signer) =>
    signer.signerType === ESignSignerType.CUSTOMER &&
    signer.signerStatus === ESignSignerStatus.SIGNED
  );
}

function hasSignedPlatformSigner(task: ESignTaskWithDetails) {
  return task.signers.some((signer) =>
    signer.signerType === ESignSignerType.PLATFORM &&
    signer.signerStatus === ESignSignerStatus.SIGNED
  );
}

function hasAllStage1CustomerSlotsSigned(task: ESignTaskWithDetails) {
  const customerSlots = task.signers.filter((signer) =>
    readSnapshotString(signer.snapshot, "signingStage") === STAGE1_SIGNING_STAGE &&
    readSnapshotString(signer.snapshot, "providerActionType") === "CUSTOMER_MANUAL_SIGN" &&
    isRequiredSignerRow(signer)
  );
  return customerSlots.length > 0 &&
    customerSlots.every((signer) => signer.signerStatus === ESignSignerStatus.SIGNED);
}

function hasUnsignedStage1PlatformSlots(task: ESignTaskWithDetails) {
  return getStage1PlatformSlotSigners(task).some((signer) =>
    isRequiredSignerRow(signer) && signer.signerStatus !== ESignSignerStatus.SIGNED
  );
}

function hasStage1PlatformAutoSealTransaction(task: ESignTaskWithDetails) {
  return getStage1PlatformSlotSigners(task).some((signer) => Boolean(signer.providerSignerId));
}

function getStage1PlatformSlotSigners(task: ESignTaskWithDetails) {
  return task.signers.filter((signer) =>
    readSnapshotString(signer.snapshot, "signingStage") === STAGE1_SIGNING_STAGE &&
    readSnapshotString(signer.snapshot, "providerActionType") === "PLATFORM_AUTO_SEAL" &&
    signer.signerType === ESignSignerType.PLATFORM
  );
}

function getStage1PlatformSlotIds(task: ESignTaskWithDetails): ESignSlotId[] {
  return getStage1PlatformSlotSigners(task)
    .map((signer) => readSnapshotString(signer.snapshot, "slotId"))
    .filter((slotId): slotId is ESignSlotId => Boolean(slotId));
}

function allRequiredSignersSigned(task: ESignTaskWithDetails) {
  const requiredSigners = task.signers.filter(isRequiredSignerRow);
  return requiredSigners.length > 0 &&
    requiredSigners.every((signer) => signer.signerStatus === ESignSignerStatus.SIGNED);
}

function isRequiredSignerRow(signer: { snapshot: unknown }) {
  return readSnapshotValue(signer.snapshot, "required") !== false;
}

function isStage1SlotAwareTask(task: ESignTaskWithDetails) {
  return readSnapshotValue(task.requestSnapshot, "stage1MultiSlot") !== undefined ||
    task.signers.some((signer) => readSnapshotString(signer.snapshot, "signingStage") === STAGE1_SIGNING_STAGE);
}

function isStage2HandoverTask(task: ESignTaskWithDetails) {
  return readSnapshotString(task.requestSnapshot, "signingStage") === STAGE2_DELIVERY_HANDOVER_SIGNING_STAGE ||
    task.signers.some((signer) =>
      readSnapshotString(signer.snapshot, "signingStage") === STAGE2_DELIVERY_HANDOVER_SIGNING_STAGE
    );
}

function firstSignerSignedAt(task: ESignTaskWithDetails, signerType: ESignSignerType) {
  return task.signers.find((signer) =>
    signer.signerType === signerType &&
    signer.signerStatus === ESignSignerStatus.SIGNED &&
    signer.signedAt
  )?.signedAt ?? null;
}

function stage2HandoverWhere(task: ESignTaskWithDetails): Prisma.VehicleDeliveryHandoverWhereInput {
  return {
    deletedAt: null,
    OR: [
      { handoverESignTaskId: task.id },
      { handoverContractId: task.contractId }
    ]
  };
}

function hasRequiredStage1SlotCoordinates(coordinates: unknown) {
  if (!Array.isArray(coordinates)) {
    return false;
  }
  return STAGE1_SIGNING_SLOTS.every((slot) =>
    coordinates.some((coordinate) =>
      Boolean(coordinate) &&
      typeof coordinate === "object" &&
      !Array.isArray(coordinate) &&
      (coordinate as Record<string, unknown>).slotId === slot.slotId
    )
  );
}

function findStage1SlotCoordinate(
  coordinates: ESignSigningSlotCoordinate[] | undefined,
  slotId: ESignSlotId
): ESignSigningSlotCoordinate | undefined {
  return coordinates?.find((coordinate) =>
    coordinate.slotId === slotId &&
    Number.isInteger(coordinate.pageNumber) &&
    coordinate.pageNumber >= 0 &&
    isFiniteNumberInRange(coordinate.x, 0, 800) &&
    isFiniteNumberInRange(coordinate.y, 0, 1131)
  );
}

function readStage1SlotCoordinate(snapshot: unknown, slotId: ESignSlotId): ESignSigningSlotCoordinate | undefined {
  const coordinate = readSnapshotValue(snapshot, "slotCoordinate");
  if (!coordinate || typeof coordinate !== "object" || Array.isArray(coordinate)) {
    return undefined;
  }
  return findStage1SlotCoordinate([coordinate as ESignSigningSlotCoordinate], slotId);
}

function readSnapshotString(snapshot: unknown, key: string) {
  const value = readSnapshotValue(snapshot, key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSnapshotValue(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  return (snapshot as Record<string, unknown>)[key];
}

function isTypedStage2Task(task: ESignTaskWithDetails) {
  return (
    task.signingStage === PrismaESignSigningStage.STAGE2_DELIVERY_HANDOVER &&
    task.documentType === PrismaESignDocumentType.DELIVERY_HANDOVER
  );
}

function isTypedStage2SignerStructure(
  signer: ESignTaskWithDetails["signers"][number]
) {
  if (
    signer.deletedAt ||
    !signer.required ||
    signer.documentType !== PrismaESignDocumentType.DELIVERY_HANDOVER
  ) {
    return false;
  }
  if (signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER) {
    return (
      signer.providerActionType ===
        PrismaESignProviderActionType.CUSTOMER_MANUAL_SIGN &&
      signer.signerType === ESignSignerType.CUSTOMER
    );
  }
  if (signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM) {
    return (
      signer.providerActionType ===
        PrismaESignProviderActionType.PLATFORM_AUTO_SEAL &&
      signer.signerType === ESignSignerType.PLATFORM
    );
  }
  return false;
}

function requireTypedStage2RequiredSigners(task: ESignTaskWithDetails) {
  const signers = task.signers.filter(
    (signer) =>
      signer.required &&
      signer.documentType === PrismaESignDocumentType.DELIVERY_HANDOVER
  );
  const customerSigners = signers.filter(
    (signer) =>
      signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_CUSTOMER &&
      isTypedStage2SignerStructure(signer)
  );
  const platformSigners = signers.filter(
    (signer) =>
      signer.slotId === PrismaESignSlotId.STAGE2_HANDOVER_PLATFORM &&
      isTypedStage2SignerStructure(signer)
  );
  if (
    signers.length !== 2 ||
    customerSigners.length !== 1 ||
    platformSigners.length !== 1 ||
    [...customerSigners, ...platformSigners].some(
      (signer) =>
        signer.signerStatus === ESignSignerStatus.SIGNED &&
        !normalizeProviderTransactionId(signer.providerTransactionId)
    )
  ) {
    throw new BadRequestException("ESIGN_STAGE2_HANDOVER_TYPED_SIGNERS_INVALID");
  }
  return [customerSigners[0]!, platformSigners[0]!];
}

function normalizeProviderTransactionId(value?: string | null) {
  const normalized = value?.trim();
  return normalized || null;
}

function buildStage2ProviderTransactionId(
  taskNo: string,
  suffix: "H1" | "H2"
) {
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  if (!normalized) {
    throw new BadRequestException(
      "ESIGN_STAGE2_PROVIDER_TRANSACTION_INVALID"
    );
  }
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

function hasValidStage2QueryResult(
  input: Stage2SignedReconciliationInput
) {
  if (input.source === "CALLBACK") {
    return input.queryResult === undefined;
  }
  return input.source === "QUERY" &&
    input.queryResult?.status === "SIGNED" &&
    input.queryResult.resultCode === "3000";
}

function buildStage2ProviderQueryAuditId(
  taskId: string,
  slotId: PrismaESignSlotId,
  providerTransactionId: string
) {
  const hash = createHash("sha256")
    .update(
      [
        "stage2-provider-query",
        taskId,
        slotId,
        providerTransactionId
      ].join(":"),
      "utf8"
    )
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function sanitizeCallbackPayloadForLog(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeCallbackPayloadForLog);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, item]) => {
        if (isSensitiveCallbackField(key)) {
          return [];
        }
        if (/result_?desc(?:ription)?$/i.test(key)) {
          return [[key, "[redacted-provider-description]"]];
        }
        if (/url$/i.test(key)) {
          return [[key, "[redacted-url]"]];
        }
        return [[key, sanitizeCallbackPayloadForLog(item)]];
      });
    return Object.fromEntries(entries);
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return "[redacted-url]";
  }
  return value;
}

function isSensitiveCallbackField(key: string) {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return /(^|_)(authorization|bucket|cert_?no|cert_?number|certificate_?no|certificate_?number|cookie|credential_?no|credential_?number|digest|id_?card|id_no|id_number|identity_?no|identity_?number|jwt|mobile|object_key|otp|password|phone|provider_customer_id|secret|session|token)($|_)/
    .test(normalized);
}

function hashCanonicalPayload(payload: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function isPrismaSerializationConflict(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "P2034"
  );
}

function sanitizeCallbackCode(value?: string | null) {
  if (!value) {
    return "missing";
  }
  return value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";
}

function isFiniteNumberInRange(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function taskMatchesProviderContract(task: ESignTaskWithDetails, providerContractId?: string | null) {
  if (!providerContractId) {
    return true;
  }
  return task.providerEnvelopeId === providerContractId || task.taskNo === providerContractId;
}

function buildProviderTransactionId(taskNo: string, index: number) {
  const suffix = `S${index}`;
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  if (!normalized) {
    throw new Error("ESIGN_PROVIDER_TRANSACTION_ID_INVALID: taskNo cannot produce a safe transaction_id");
  }
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

function readSealId(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return undefined;
  }
  const sealId = (snapshot as Record<string, unknown>).sealId;
  return typeof sealId === "string" && sealId.trim() ? sealId : undefined;
}

function mergeSnapshot(existing: unknown, patch: Record<string, unknown>) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return patch;
  }
  return {
    ...(existing as Record<string, unknown>),
    ...patch
  };
}

function toESignTaskView(task: ESignTaskWithDetails) {
  const isStage2Handover =
    task.signingStage ===
      PrismaESignSigningStage.STAGE2_DELIVERY_HANDOVER &&
    task.documentType === PrismaESignDocumentType.DELIVERY_HANDOVER;
  const stage2Handover = isStage2Handover
    ? task.deliveryHandover
    : null;
  const signedArtifactAvailable = isStage2Handover
    ? Boolean(
        stage2Handover?.archiveStatus ===
          DeliveryHandoverArchiveStatus.ARCHIVED &&
        stage2Handover.signedDocumentFileId &&
        stage2Handover.signedPdfHash
      )
    : Boolean(task.signedDocumentObjectKey);

  return {
    archiveError: stage2Handover?.archiveLastError ?? null,
    archiveStatus: stage2Handover?.archiveStatus ?? null,
    callbacks: task.callbacks.map((callback) => ({
      eventType: callback.eventType,
      handled: callback.handled,
      id: callback.id,
      providerTaskId: callback.providerTaskId,
      receivedAt: callback.receivedAt,
      verified: callback.verified
    })),
    completedAt: task.completedAt,
    contractId: task.contractId,
    contractNo: task.contract.contractNo,
    createdAt: task.createdAt,
    customerId: task.customerId,
    documentType: task.documentType,
    documentName: task.documentName,
    hasEvidenceDocument: Boolean(task.evidenceObjectKey),
    hasSignedDocument: signedArtifactAvailable,
    id: task.id,
    orderId: task.orderId,
    provider: task.provider,
    providerTaskId: task.providerTaskId,
    signedArtifactAvailable,
    signUrl: task.signUrl,
    signUrlExpiresAt: task.signUrlExpiresAt,
    signers: task.signers.map((signer) => ({
      customerId: signer.customerId,
      id: signer.id,
      providerActionType: readSnapshotString(signer.snapshot, "providerActionType") ?? null,
      providerSignerId: signer.providerSignerId,
      signedAt: signer.signedAt,
      signerName: signer.signerName,
      signerPhone: signer.signerPhone ? maskPhone(signer.signerPhone) : null,
      signerStatus: signer.signerStatus,
      signerType: signer.signerType,
      slotId: readSnapshotString(signer.snapshot, "slotId") ?? null
    })),
    startedAt: task.startedAt,
    signingStage: task.signingStage,
    taskNo: task.taskNo,
    taskStatus: task.taskStatus,
    workOrderId: stage2Handover?.workOrders[0]?.id ?? null
  };
}

function toPortalContractListItem(contract: ContractForESign) {
  const task = findCurrentPortalSigningTask(contract);
  const identity = getPortalContractSigningIdentity(contract);
  const hasSignedDocument =
    identity.signingStage === "STAGE2_DELIVERY_HANDOVER"
      ? Boolean(
          contract.handoverDeliveryHandover?.archiveStatus ===
            DeliveryHandoverArchiveStatus.ARCHIVED &&
          contract.handoverDeliveryHandover.signedDocumentFileId &&
          contract.handoverDeliveryHandover.signedPdfHash
        )
      : Boolean(task?.signedDocumentObjectKey);

  return {
    contractNo: contract.contractNo,
    contractStatus: contract.status,
    createdAt: contract.createdAt,
    documentType: identity.documentType,
    id: contract.id,
    hasSignedDocument,
    orderNo: contract.order.orderNo,
    signedAt: contract.signedAt,
    signingStage: identity.signingStage,
    signStatus: task?.taskStatus ?? null,
    workOrderId: identity.workOrderId
  };
}

function toPortalContractDetail(contract: ContractForESign) {
  const task = findCurrentPortalSigningTask(contract);
  const identity = getPortalContractSigningIdentity(contract);
  const hasSignedDocument =
    identity.signingStage === "STAGE2_DELIVERY_HANDOVER"
      ? Boolean(
          contract.handoverDeliveryHandover?.archiveStatus ===
            DeliveryHandoverArchiveStatus.ARCHIVED &&
          contract.handoverDeliveryHandover.signedDocumentFileId &&
          contract.handoverDeliveryHandover.signedPdfHash
        )
      : Boolean(task?.signedDocumentObjectKey);

  return {
    ...toPortalContractListItem(contract),
    canSign: Boolean(
      task &&
      identity.signingStage === "STAGE1_SUBSCRIPTION_CONTRACT" &&
      identity.documentType === "SUBSCRIPTION_CONTRACT" &&
      PORTAL_SIGNABLE_ESIGN_TASK_STATUSES.includes(task.taskStatus)
    ),
    customer: {
      mobile: maskPhone(contract.customer.mobile),
      name: contract.customer.name
    },
    order: {
      id: contract.order.id,
      orderNo: contract.order.orderNo,
      orderStatus: contract.order.orderStatus
    },
    signTask: task
      ? {
          completedAt: task.completedAt,
          hasEvidenceDocument: Boolean(task.evidenceObjectKey),
          hasSignedDocument,
          id: task.id,
          provider: task.provider,
          documentType: identity.documentType,
          signers: task.signers.map((signer) => ({
            signedAt: signer.signedAt,
            signerName: signer.signerName,
            signerPhone: signer.signerPhone ? maskPhone(signer.signerPhone) : null,
            signerStatus: signer.signerStatus,
            signerType: signer.signerType
          })),
          signingStage: identity.signingStage,
          signUrlExpiresAt: task.signUrlExpiresAt,
          taskNo: task.taskNo,
          taskStatus: task.taskStatus,
          workOrderId: identity.workOrderId
        }
      : null,
    vehicle: toPortalVehicleSummary(contract.order.vehicle)
  };
}

function getPortalContractSigningIdentity(contract: ContractForESign) {
  const stage2Task = findStage2PortalSigningTask(contract);
  const task = findCurrentPortalSigningTask(contract);
  const handover = contract.handoverDeliveryHandover;
  const stage2Typed =
    Boolean(handover) ||
    Boolean(stage2Task);
  if (stage2Typed) {
    const activeWorkOrders = (handover?.workOrders ?? []).filter(
      (workOrder) =>
        !["CANCELLED", "FAILED", "VOIDED"].includes(
          String(workOrder.status)
        )
    );
    return {
      documentType: "DELIVERY_HANDOVER" as const,
      signingStage: "STAGE2_DELIVERY_HANDOVER" as const,
      workOrderId:
        activeWorkOrders.length === 1
          ? activeWorkOrders[0]!.id
          : null
    };
  }
  if (
    task?.signingStage ===
      PrismaESignSigningStage.STAGE1_SUBSCRIPTION_CONTRACT &&
    task.documentType ===
      PrismaESignDocumentType.SUBSCRIPTION_CONTRACT
  ) {
    return {
      documentType: "SUBSCRIPTION_CONTRACT" as const,
      signingStage: "STAGE1_SUBSCRIPTION_CONTRACT" as const,
      workOrderId: null
    };
  }
  return {
    documentType: null,
    signingStage: null,
    workOrderId: null
  };
}

function toPortalVehicleSummary(vehicle: ContractForESign["order"]["vehicle"]) {
  if (!vehicle) {
    return null;
  }

  return {
    batteryCapacityKwh: vehicle.batteryCapacityKwh === null ? null : Number(vehicle.batteryCapacityKwh),
    batteryUsageType: vehicle.batteryUsageType,
    brand: vehicle.brand,
    city: vehicle.assetLocation,
    currentMileageKm: vehicle.currentMileageKm,
    displayName: [vehicle.brand, vehicle.series, vehicle.vehicleModel, vehicle.modelYear ? `${vehicle.modelYear}款` : null]
      .filter(Boolean)
      .join(" "),
    model: vehicle.vehicleModel,
    modelYear: vehicle.modelYear,
    series: vehicle.series
  };
}

function isExpired(value?: Date | null) {
  return value ? value.getTime() <= Date.now() : false;
}

function parseProvider(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized === "MOCK") {
    return ESignProviderType.MOCK;
  }
  if (normalized === "FADADA") {
    return ESignProviderType.FADADA;
  }
  if (normalized === "ESIGN") {
    return ESignProviderType.ESIGN;
  }
  if (normalized === "TENCENT_ESIGN") {
    return ESignProviderType.TENCENT_ESIGN;
  }
  if (normalized === "OTHER") {
    return ESignProviderType.OTHER;
  }
  throw new BadRequestException("不支持的电子签 provider。");
}

function parseBoolean(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function maskPhone(phone: string) {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

function toEnterpriseSigningPlanSnapshot(plan: ApprovedSigningPlanRef) {
  return {
    executionMode: plan.executionMode,
    planHash: plan.planHash,
    policyId: plan.policyId,
    signingPlanId: plan.signingPlanId,
    stepSummary: plan.steps.map((step) => ({
      required: step.required,
      signerRole: step.signerRole,
      stepOrder: step.stepOrder
    }))
  };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return toPlain(value) as Prisma.InputJsonValue;
}

function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Prisma.Decimal) {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPlain);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}
