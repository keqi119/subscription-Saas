import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  BillStatus,
  ContractStatus,
  ESignTaskStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionClosureStatus,
  VehicleStatus
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";

import { createBusinessNo } from "../common/business-number";
import { AssetAccountingService } from "../asset-accounting/asset-accounting.service";
import type { RequestContext, RequestUser } from "../auth/auth.types";
import { ESIGN_PROVIDER_CLIENT, type ESignProvider } from "../esign/esign.provider";
import { PaymentOrderService } from "../payment/payment-order.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { canonicalSubscriptionClosureJson } from "./subscription-closure.domain";
import { SubscriptionClosureEvidencePackageService } from "./subscription-closure-evidence-package.service";
import {
  acceptedDisputeRepricingDeltaItemIds,
  governedChargeFactsForDeltaItem,
  priceClosureCharge
} from "./subscription-closure-pricing.service";
import {
  deriveClosureFinancialState,
  mayCompleteOperations,
  type ClosureReceivableFact
} from "./subscription-closure-financial.service";
import {
  applyConditionDeltaDecisions,
  buildConditionDelta
} from "./subscription-return-delta.service";
import {
  hasSubscriptionReturnThreeStageContinuation,
  isSubscriptionReturnThreeStageEnabled
} from "./subscription-return-three-stage";

const REQUIRED_ITEM_CODES = [
  "ACCESSORIES",
  "BATTERY",
  "CHARGING_EQUIPMENT",
  "CUSTOMER_ITEMS",
  "KEY",
  "MILEAGE",
  "REGISTRATION_CERTIFICATE",
  "VEHICLE_EXTERIOR",
  "VEHICLE_INTERIOR"
] as const;
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

export type ReturnEvidenceUpload = Readonly<{
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}>;

@Injectable()
export class SubscriptionReturnGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Optional() private readonly evidencePackages?: SubscriptionClosureEvidencePackageService,
    @Inject(ESIGN_PROVIDER_CLIENT) @Optional() private readonly esignProvider?: ESignProvider,
    @Optional() private readonly paymentOrders?: PaymentOrderService,
    @Optional() private readonly assetAccounting?: AssetAccountingService,
    @Optional() private readonly config?: ConfigService
  ) {}

  async assertThreeStageWriteAllowed(closureCaseId: string) {
    if (!this.threeStageWriteGateActive()) {
      return;
    }
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      select: { currentChecklistRevisionId: true, currentDeltaRevisionId: true, id: true },
      where: { id: closureCaseId }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    const factCounts = await Promise.all([
      this.prisma.vehicleReturnEvidenceLink.count({ where: { closureCaseId } }),
      this.prisma.subscriptionClosureChargeLine.count({ where: { closureCaseId } }),
      this.prisma.subscriptionClosureCustomerResponse.count({ where: { closureCaseId } }),
      this.prisma.subscriptionClosureReceivableDisposition.count({ where: { closureCaseId } }),
      this.prisma.subscriptionClosureEvidencePackageExport.count({ where: { closureCaseId } }),
      this.prisma.subscriptionClosureLegalCollectionCase.count({ where: { closureCaseId } }),
      this.prisma.businessExceptionApproval.count({
        where: { subjectId: closureCaseId, subjectType: "SETTLEMENT_CASE" }
      }),
      this.prisma.contractESignTask.count({
        where: {
          deletedAt: null,
          documentType: "RETURN_MANIFEST",
          signingStage: "STAGE6_RETURN_MANIFEST",
          sourceId: closureCaseId,
          sourceKey: { startsWith: "return-manifest-esign" },
          sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
        }
      })
    ]);
    if (
      hasSubscriptionReturnThreeStageContinuation({
        businessExceptionApprovals: factCounts[6],
        chargeLines: factCounts[1],
        currentChecklistRevisionId: closureCase.currentChecklistRevisionId,
        currentDeltaRevisionId: closureCase.currentDeltaRevisionId,
        customerResponses: factCounts[2],
        evidenceLinks: factCounts[0],
        evidencePackages: factCounts[4],
        legalCases: factCounts[5],
        receivableDispositions: factCounts[3],
        returnManifestTasks: factCounts[7]
      })
    )
      return;
    throw conflict(
      "SUBSCRIPTION_RETURN_THREE_STAGE_DISABLED",
      "The three-stage return workflow is disabled for cases that have not entered the governed flow."
    );
  }

  async assertThreeStageWriteAllowedByOrder(orderId: string) {
    if (!this.threeStageWriteGateActive()) return;
    const closureCase = await this.prisma.subscriptionClosureCase.findFirst({
      select: { id: true },
      where: { orderId, retiredAt: null }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    await this.assertThreeStageWriteAllowed(closureCase.id);
  }

  private threeStageWriteGateActive() {
    return !isSubscriptionReturnThreeStageEnabled(
      this.config?.get<string>("SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED")
    );
  }

  async captureChecklist(
    closureCaseId: string,
    input: Readonly<{
      attestationEvidenceIds: readonly string[];
      attestationMode: "CUSTOMER_SIGNED" | "CUSTOMER_REFUSED" | "CUSTOMER_ABSENT";
      attestationReason: string | null;
      capturedAt: Date;
      customerComments: string | null;
      idempotencyKey: string;
      items: readonly Readonly<{
        expectedQuantity?: number | null;
        itemCode: string;
        remark?: string | null;
        returnedQuantity?: number | null;
        state: "NORMAL" | "MISSING" | "DAMAGED" | "NOT_APPLICABLE" | "PENDING_VERIFICATION";
      }>[];
      witnesses: readonly string[];
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const normalizedItems = normalizeChecklistItems(input.items);
    const sourceKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
    const attestationReason = input.attestationReason?.trim() || null;
    const witnesses = [...new Set(input.witnesses.map((value) => value.trim()).filter(Boolean))];
    const attestationEvidenceIds = [...new Set(input.attestationEvidenceIds)].sort();
    if (
      input.attestationMode !== "CUSTOMER_SIGNED" &&
      (!attestationReason || witnesses.length === 0 || attestationEvidenceIds.length === 0)
    ) {
      throw badRequest(
        "RETURN_ATTESTATION_EVIDENCE_REQUIRED",
        "客户拒签或缺席时，必须记录原因、现场见证人及受管证据。"
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      if (
        !closureCase ||
        !closureCase.vehicleReturnId ||
        closureCase.retiredAt ||
        closureCase.status !== "PREPARING_RETURN"
      ) {
        throw conflict("RETURN_CHECKLIST_NOT_EDITABLE", "当前退车流程不允许记录或修订清单。");
      }
      const source = {
        id: closureCase.id,
        key: `checklist:${sourceKey}`,
        type: "SUBSCRIPTION_CLOSURE_RETURN"
      } as const;
      const replay = await tx.vehicleReturnChecklistRevision.findUnique({
        include: { items: { orderBy: { itemCode: "asc" } } },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      const attestationSnapshot =
        input.attestationMode === "CUSTOMER_SIGNED"
          ? null
          : {
              evidenceIds: attestationEvidenceIds,
              reason: attestationReason,
              witnesses
            };
      const manifestSnapshot = {
        attestation: {
          evidenceIds: attestationEvidenceIds,
          mode: input.attestationMode,
          reason: attestationReason,
          witnesses
        },
        capturedAt: input.capturedAt.toISOString(),
        closureCaseId: closureCase.id,
        customerComments: input.customerComments?.trim() || null,
        items: normalizedItems,
        vehicleReturnId: closureCase.vehicleReturnId
      } as const;
      const manifestHash = sha256(canonicalSubscriptionClosureJson(manifestSnapshot as never));
      if (replay) {
        if (
          replay.manifestHash !== manifestHash ||
          canonicalSubscriptionClosureJson(replay.items as never) !==
            canonicalSubscriptionClosureJson(normalizedItems as never)
        ) {
          throw conflict("RETURN_CHECKLIST_IDEMPOTENCY_CONFLICT", "幂等键已用于其他退车清单。");
        }
        return projectChecklist(replay, true);
      }
      const existingManifestTask = await tx.contractESignTask.findFirst({
        select: { completedAt: true, id: true, taskStatus: true },
        where: {
          deletedAt: null,
          documentType: "RETURN_MANIFEST",
          sourceId: closureCase.id,
          sourceKey: { startsWith: "return-manifest-esign" },
          sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
        }
      });
      if (existingManifestTask) {
        if (
          existingManifestTask.taskStatus === ESignTaskStatus.COMPLETED ||
          existingManifestTask.completedAt
        ) {
          throw conflict(
            "RETURN_CHECKLIST_SIGNED_IMMUTABLE",
            "退车确认单已完成签署，清单作为不可变证据不能覆盖；请继续确认车辆取回，并在后续车况差异与费用核定中记录新发现事项。"
          );
        }
        throw conflict(
          "RETURN_CHECKLIST_ESIGN_LOCKED",
          "退车确认单已进入电子签，清单已锁定；如需更正，请先由管理员取消当前签署任务。"
        );
      }
      const [evidence, attestationLinks] = await Promise.all([
        tx.assetWorkOrderEvidence.findMany({ where: { id: { in: attestationEvidenceIds } } }),
        tx.vehicleReturnEvidenceLink.findMany({
          where: {
            closureCaseId: closureCase.id,
            evidencePurpose: "ATTESTATION_PROOF"
          }
        })
      ]);
      const allowedWorkOrderIds = new Set(
        [
          closureCase.returnAssetWorkOrderId,
          closureCase.recoveryAssetWorkOrderId,
          closureCase.reconditioningAssetWorkOrderId
        ].filter((id): id is string => Boolean(id))
      );
      const supersededAttestationLinkIds = new Set(
        attestationLinks
          .map(({ supersedesLinkId }) => supersedesLinkId)
          .filter((id): id is string => Boolean(id))
      );
      const activeAttestationEvidenceIds = new Set(
        attestationLinks
          .filter(({ id }) => !supersededAttestationLinkIds.has(id))
          .map(({ evidenceId }) => evidenceId)
          .filter((id): id is string => Boolean(id))
      );
      if (
        evidence.length !== attestationEvidenceIds.length ||
        attestationEvidenceIds.some((id) => !activeAttestationEvidenceIds.has(id)) ||
        evidence.some(({ workOrderId }) => !allowedWorkOrderIds.has(workOrderId))
      ) {
        throw conflict("RETURN_ATTESTATION_EVIDENCE_MISMATCH", "拒签/缺席证据不属于当前退车流程。");
      }
      const current = closureCase.currentChecklistRevisionId
        ? await tx.vehicleReturnChecklistRevision.findUnique({
            where: { id: closureCase.currentChecklistRevisionId }
          })
        : null;
      const checklistByCode = new Map(normalizedItems.map((item) => [item.itemCode, item]));
      const returnedInFull = (itemCode: string) => {
        const item = checklistByCode.get(itemCode);
        if (!item || item.state !== "NORMAL") return false;
        if (item.expectedQuantity === null || item.expectedQuantity === undefined) return true;
        return (item.returnedQuantity ?? 0) >= item.expectedQuantity;
      };
      const inspected = (itemCode: string) => {
        const item = checklistByCode.get(itemCode);
        return Boolean(item && item.state !== "PENDING_VERIFICATION");
      };
      const revision = await tx.vehicleReturnChecklistRevision.create({
        data: {
          attestationMode: input.attestationMode,
          attestationSnapshot: attestationSnapshot
            ? (attestationSnapshot as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          capturedAt: input.capturedAt,
          capturedBy: actorId,
          closureCaseId: closureCase.id,
          customerComments: input.customerComments?.trim() || null,
          items: {
            create: normalizedItems.map((item) => ({
              capturedAt: input.capturedAt,
              capturedBy: actorId,
              expectedQuantity: item.expectedQuantity,
              itemCode: item.itemCode,
              remark: item.remark,
              returnedQuantity: item.returnedQuantity,
              source: "ADMIN_CAPTURE",
              state: item.state
            }))
          },
          manifestHash,
          revisionNumber: (current?.revisionNumber ?? 0) + 1,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type,
          supersedesRevisionId: current?.id ?? null,
          vehicleReturnId: closureCase.vehicleReturnId
        },
        include: { items: { orderBy: { itemCode: "asc" } } }
      });
      await tx.vehicleReturn.update({
        data: {
          batteryCheckedConfirmed: inspected("BATTERY"),
          chargingEquipmentReturnedConfirmed: returnedInFull("CHARGING_EQUIPMENT"),
          checklistSnapshot: manifestSnapshot as Prisma.InputJsonValue,
          customerItemsClearedConfirmed: returnedInFull("CUSTOMER_ITEMS"),
          exteriorCheckedConfirmed: inspected("VEHICLE_EXTERIOR"),
          interiorCheckedConfirmed: inspected("VEHICLE_INTERIOR"),
          keysReturnedConfirmed: returnedInFull("KEY"),
          mileageConfirmed: inspected("MILEAGE"),
          updatedBy: actorId,
          vehicleDocumentsReturnedConfirmed: returnedInFull("REGISTRATION_CERTIFICATE"),
          violationCheckedConfirmed: true
        },
        where: { id: closureCase.vehicleReturnId }
      });
      await tx.subscriptionClosureCase.update({
        data: {
          currentChecklistRevisionId: revision.id,
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      const generatedManifest = await tx.subscriptionClosureDocumentRevision.findFirst({
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        where: {
          closureCaseId: closureCase.id,
          documentType: "RETURN_MANIFEST",
          stage: "GENERATED"
        }
      });
      if (!generatedManifest) {
        throw conflict(
          "RETURN_MANIFEST_GENERATED_DOCUMENT_REQUIRED",
          "退车确认单源文档尚未就绪，请稍后重试。"
        );
      }
      const attemptId = `${generatedManifest.id}:checklist:${revision.id}`;
      const jobIdempotencyKey = `closure-return-manifest-esign:${attemptId}`;
      const jobPayload = {
        actorId,
        checklistRevisionId: revision.id,
        closureCaseId: closureCase.id,
        generatedRevisionId: generatedManifest.id,
        idempotencyKey: attemptId,
        version: 2
      } as const;
      const retiredAt = new Date();
      await tx.subscriptionAutomationJob.updateMany({
        data: {
          completedAt: retiredAt,
          jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
          resultSnapshot: {
            action: "SUPERSEDED_BY_CHECKLIST_REVISION",
            checklistRevisionId: revision.id
          }
        },
        where: {
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.DEAD_LETTER,
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.COMPLETED
            ]
          },
          jobType: SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN,
          orderId: closureCase.orderId,
          payload: { path: ["closureCaseId"], equals: closureCase.id }
        }
      });
      await tx.subscriptionAutomationJob.upsert({
        create: {
          idempotencyKey: jobIdempotencyKey,
          jobType: SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN,
          orderId: closureCase.orderId,
          payload: jobPayload
        },
        update: {
          attemptCount: 0,
          availableAt: retiredAt,
          completedAt: null,
          jobStatus: SubscriptionAutomationJobStatus.PENDING,
          lastErrorCode: null,
          lastErrorMessage: null,
          leaseExpiresAt: null,
          leaseToken: null,
          resultSnapshot: Prisma.JsonNull,
          startedAt: null
        },
        where: { idempotencyKey: jobIdempotencyKey }
      });
      return projectChecklist(revision, false);
    });
  }

  async cancelReturnManifestSigning(
    closureCaseId: string,
    input: Readonly<{ idempotencyKey: string; reason: string }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
    const reason = requiredText(input.reason, "reason", 2000);
    const observedTask = await this.prisma.contractESignTask.findFirst({
      where: {
        deletedAt: null,
        documentType: "RETURN_MANIFEST",
        signingStage: "STAGE6_RETURN_MANIFEST",
        sourceId: closureCaseId,
        sourceKey: { startsWith: "return-manifest-esign" },
        sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
      }
    });
    const observedClosureCase = await this.prisma.subscriptionClosureCase.findUnique({
      where: { id: closureCaseId }
    });
    if (
      !observedClosureCase ||
      observedClosureCase.retiredAt ||
      observedClosureCase.status !== SubscriptionClosureStatus.PREPARING_RETURN
    ) {
      throw conflict(
        "RETURN_MANIFEST_SIGNING_NOT_CANCELLABLE",
        "当前退车流程不允许取消确认单签署。"
      );
    }
    if (observedTask?.taskStatus === ESignTaskStatus.COMPLETED || observedTask?.completedAt) {
      throw conflict(
        "RETURN_MANIFEST_SIGNING_ALREADY_COMPLETED",
        "退车确认单已经完成签署，不能取消或覆盖；请继续确认车辆取回，并在后续车况差异与费用核定中记录新发现事项。"
      );
    }
    let providerCancellation: unknown = null;
    if (observedTask?.providerTaskId) {
      if (!observedTask.providerEnvelopeId || !this.esignProvider?.cancelReturnManifestTask) {
        throw conflict(
          "RETURN_MANIFEST_PROVIDER_CANCELLATION_REQUIRED",
          "电子签平台任务已发出，但当前供应商未配置可核验的撤销能力；为避免双份有效文件，系统未取消本地任务。"
        );
      }
      try {
        providerCancellation = await this.esignProvider.cancelReturnManifestTask({
          providerEnvelopeId: observedTask.providerEnvelopeId,
          providerTaskId: observedTask.providerTaskId,
          taskId: observedTask.id,
          taskNo: observedTask.taskNo
        });
      } catch {
        throw conflict(
          "RETURN_MANIFEST_PROVIDER_CANCELLATION_FAILED",
          "电子签平台撤销未确认成功；本地任务保持有效，请稍后重试或人工核对。"
        );
      }
      if (!asRecord(providerCancellation).cancelled) {
        throw conflict(
          "RETURN_MANIFEST_PROVIDER_CANCELLATION_UNCONFIRMED",
          "电子签平台尚未确认撤销；请先由管理员在法大大后台撤销该未完成签署任务，再返回本页重试。本地任务在平台返回已撤销前保持有效。"
        );
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      if (
        !closureCase ||
        closureCase.retiredAt ||
        closureCase.status !== SubscriptionClosureStatus.PREPARING_RETURN
      ) {
        throw conflict(
          "RETURN_MANIFEST_SIGNING_NOT_CANCELLABLE",
          "当前退车流程不允许取消确认单签署。"
        );
      }
      const taskWhere = {
        documentType: "RETURN_MANIFEST" as const,
        signingStage: "STAGE6_RETURN_MANIFEST" as const,
        sourceId: closureCase.id,
        sourceKey: { startsWith: "return-manifest-esign" },
        sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
      };
      const activeTask = await tx.contractESignTask.findFirst({
        include: { signers: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        where: { ...taskWhere, deletedAt: null }
      });
      if (!activeTask) {
        const cancelled = await tx.contractESignTask.findFirst({
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          where: { ...taskWhere, deletedAt: { not: null }, taskStatus: ESignTaskStatus.CANCELLED }
        });
        const cancellation = asRecord(asRecord(cancelled?.errorSnapshot).adminCancellation);
        if (
          cancelled &&
          cancellation.idempotencyKey === idempotencyKey &&
          cancellation.reason === reason
        ) {
          return {
            cancelledAt: cancelled.cancelledAt,
            replayed: true,
            taskId: cancelled.id
          };
        }
        throw conflict(
          "RETURN_MANIFEST_SIGNING_TASK_NOT_FOUND",
          "当前没有可取消的退车确认单签署任务。"
        );
      }
      if (observedTask && activeTask.id !== observedTask.id) {
        throw conflict(
          "RETURN_MANIFEST_SIGNING_TASK_CHANGED",
          "退车确认单签署任务已变化，请刷新后重试。"
        );
      }
      if (activeTask.taskStatus === ESignTaskStatus.COMPLETED || activeTask.completedAt) {
        throw conflict(
          "RETURN_MANIFEST_SIGNING_ALREADY_COMPLETED",
          "退车确认单已经完成签署，不能取消或覆盖；请继续确认车辆取回，并在后续车况差异与费用核定中记录新发现事项。"
        );
      }
      const cancelledAt = new Date();
      const before = returnManifestTaskCancellationSnapshot(activeTask);
      const updated = await tx.contractESignTask.update({
        data: {
          cancelledAt,
          deletedAt: cancelledAt,
          errorSnapshot: {
            ...asRecord(activeTask.errorSnapshot),
            adminCancellation: {
              actorId,
              cancelledAt: cancelledAt.toISOString(),
              idempotencyKey,
              providerCancellation: toInputJson(providerCancellation),
              reason
            }
          },
          signUrl: null,
          signUrlExpiresAt: null,
          taskStatus: ESignTaskStatus.CANCELLED,
          updatedAt: cancelledAt,
          updatedBy: actorId
        },
        where: { id: activeTask.id }
      });
      await tx.contractESignSigner.updateMany({
        data: { deletedAt: cancelledAt, updatedAt: cancelledAt },
        where: { deletedAt: null, taskId: activeTask.id }
      });
      await tx.subscriptionAutomationJob.updateMany({
        data: {
          completedAt: cancelledAt,
          jobStatus: SubscriptionAutomationJobStatus.COMPLETED,
          resultSnapshot: {
            action: "CANCELLED_FOR_CHECKLIST_CORRECTION",
            taskId: activeTask.id
          }
        },
        where: {
          jobStatus: {
            in: [
              SubscriptionAutomationJobStatus.DEAD_LETTER,
              SubscriptionAutomationJobStatus.PENDING,
              SubscriptionAutomationJobStatus.COMPLETED
            ]
          },
          jobType: SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN,
          orderId: closureCase.orderId,
          payload: { path: ["closureCaseId"], equals: closureCase.id }
        }
      });
      await tx.auditLog.create({
        data: {
          action: AuditAction.UPDATE,
          afterSnapshot: returnManifestTaskCancellationSnapshot(updated),
          beforeSnapshot: before,
          createdAt: cancelledAt,
          entityId: updated.id,
          entityType: "contract_esign_task",
          module: "subscription_closure",
          operatorId: actorId
        }
      });
      return { cancelledAt, replayed: false, taskId: updated.id };
    });
  }

  async uploadEvidence(
    closureCaseId: string,
    input: Readonly<{
      capturedAt: Date;
      evidenceType: string;
      idempotencyKey: string;
      supersedesEvidenceId: string | null;
      targetId: string;
      targetType: "CHECKLIST_ITEM" | "DAMAGE" | "CASE_ATTESTATION" | "CUSTOMER_DISPUTE";
      visibility: "CUSTOMER_VISIBLE" | "INTERNAL_ONLY";
    }>,
    file: ReturnEvidenceUpload | undefined,
    actorId: string | null,
    customerActorId: string | null = null
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const acceptedMimeType = validateEvidenceFile(file);
    const contentSha256 = sha256(file!.buffer);
    const sourceKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
    const existing = await this.prisma.vehicleReturnEvidenceLink.findUnique({
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: closureCaseId,
          sourceKey: `bind:${sourceKey}`,
          sourceType: "SUBSCRIPTION_CLOSURE_RETURN_EVIDENCE"
        }
      }
    });
    if (existing) {
      const evidence = existing.evidenceId
        ? await this.prisma.assetWorkOrderEvidence.findUnique({
            where: { id: existing.evidenceId }
          })
        : null;
      const captureMetadata = asRecord(evidence?.captureMetadata);
      if (
        !evidence ||
        evidence.contentSha256 !== contentSha256 ||
        existing.checklistItemId !==
          (input.targetType === "CHECKLIST_ITEM" ? input.targetId : null) ||
        existing.damageId !== (input.targetType === "DAMAGE" ? input.targetId : null) ||
        captureMetadata.targetId !== input.targetId ||
        captureMetadata.targetType !== input.targetType
      ) {
        throw conflict("RETURN_EVIDENCE_IDEMPOTENCY_CONFLICT", "幂等键已用于其他退车证据。");
      }
      return this.projectEvidenceLink(existing, evidence, true);
    }
    const authority = await this.resolveEvidenceTarget(
      closureCaseId,
      input.targetType,
      input.targetId
    );
    const stored = await this.storage.putSubscriptionReturnEvidence({
      buffer: file!.buffer,
      closureCaseId,
      contentType: acceptedMimeType,
      metadata: {
        capturedAt: input.capturedAt.toISOString(),
        uploadedBy: actorId ?? `customer:${customerActorId ?? "unknown"}`
      },
      objectIdentity: sourceKey,
      originalName: file!.originalname
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
        );
        const activeManifestTask = await tx.contractESignTask.findFirst({
          select: { completedAt: true, id: true, taskStatus: true },
          where: {
            deletedAt: null,
            documentType: "RETURN_MANIFEST",
            sourceId: closureCaseId,
            sourceKey: { startsWith: "return-manifest-esign" },
            sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
          }
        });
        if (activeManifestTask && input.targetType !== "CUSTOMER_DISPUTE") {
          if (
            activeManifestTask.taskStatus === ESignTaskStatus.COMPLETED ||
            activeManifestTask.completedAt
          ) {
            throw conflict(
              "RETURN_EVIDENCE_SIGNED_IMMUTABLE",
              "退车确认单已完成签署，原证据不能替换；请继续确认车辆取回，并在后续车况差异与费用核定中追加新发现事项。"
            );
          }
          throw conflict(
            "RETURN_EVIDENCE_ESIGN_LOCKED",
            "退车确认单已进入电子签；如需补充或更换证据，请先取消当前签署任务。"
          );
        }
        const superseded = input.supersedesEvidenceId
          ? await tx.vehicleReturnEvidenceLink.findFirst({
              where: {
                closureCaseId,
                evidenceId: input.supersedesEvidenceId,
                ...(input.targetType === "CHECKLIST_ITEM"
                  ? { checklistItemId: input.targetId }
                  : input.targetType === "DAMAGE"
                    ? { damageId: input.targetId }
                    : { checklistItemId: null, damageId: null })
              }
            })
          : null;
        if (input.supersedesEvidenceId && !superseded) {
          throw conflict("RETURN_EVIDENCE_SUPERSESSION_MISMATCH", "被替换证据不属于当前确认项。");
        }
        const fileObject = await tx.fileObject.create({
          data: {
            bucket: stored.bucket,
            contentSha256,
            mimeType: acceptedMimeType,
            objectKey: stored.objectKey,
            originalName: file!.originalname,
            sizeBytes: BigInt(file!.size),
            uploadedBy: actorId
          }
        });
        const evidence = await tx.assetWorkOrderEvidence.create({
          data: {
            action: superseded ? "SUPERSEDE" : "ATTACH",
            capturedAt: input.capturedAt,
            captureMetadata: {
              closureCaseId,
              customerActorId,
              targetId: input.targetId,
              targetType: input.targetType,
              visibility: input.visibility
            },
            contentSha256,
            evidenceType: input.evidenceType as never,
            fileBucket: stored.bucket,
            fileId: fileObject.id,
            fileMimeType: acceptedMimeType,
            fileObjectKey: stored.objectKey,
            fileSizeBytes: BigInt(file!.size),
            sourceId: closureCaseId,
            sourceKey: `upload:${sourceKey}`,
            sourceType: "SUBSCRIPTION_CLOSURE_RETURN_EVIDENCE",
            supersedesEvidenceId: input.supersedesEvidenceId,
            actorId,
            workOrderId: authority.workOrderId
          }
        });
        const link = await tx.vehicleReturnEvidenceLink.create({
          data: {
            checklistItemId: input.targetType === "CHECKLIST_ITEM" ? input.targetId : null,
            closureCaseId,
            damageId: input.targetType === "DAMAGE" ? input.targetId : null,
            evidenceId: evidence.id,
            evidencePurpose:
              input.targetType === "DAMAGE"
                ? "DAMAGE_PROOF"
                : input.targetType === "CUSTOMER_DISPUTE"
                  ? "DISPUTE_PROOF"
                  : input.targetType === "CASE_ATTESTATION"
                    ? "ATTESTATION_PROOF"
                    : "CHECKLIST_PROOF",
            recordedBy: actorId,
            sourceId: closureCaseId,
            sourceKey: `bind:${sourceKey}`,
            sourceType: "SUBSCRIPTION_CLOSURE_RETURN_EVIDENCE",
            supersedesLinkId: superseded?.id ?? null,
            visibility: input.visibility
          }
        });
        if (authority.closureCase.currentChecklistRevisionId) {
          await tx.subscriptionAutomationJob.updateMany({
            data: {
              attemptCount: 0,
              availableAt: new Date(),
              completedAt: null,
              jobStatus: SubscriptionAutomationJobStatus.PENDING,
              lastErrorCode: null,
              lastErrorMessage: null,
              leaseExpiresAt: null,
              leaseToken: null,
              resultSnapshot: Prisma.JsonNull,
              startedAt: null
            },
            where: {
              jobStatus: {
                in: [
                  SubscriptionAutomationJobStatus.DEAD_LETTER,
                  SubscriptionAutomationJobStatus.PENDING,
                  SubscriptionAutomationJobStatus.COMPLETED
                ]
              },
              jobType: SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN,
              orderId: authority.closureCase.orderId,
              payload: {
                path: ["checklistRevisionId"],
                equals: authority.closureCase.currentChecklistRevisionId
              }
            }
          });
        }
        return this.projectEvidenceLink(link, evidence, false);
      });
    } catch (error) {
      const winner = await this.prisma.vehicleReturnEvidenceLink.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: closureCaseId,
            sourceKey: `bind:${sourceKey}`,
            sourceType: "SUBSCRIPTION_CLOSURE_RETURN_EVIDENCE"
          }
        }
      });
      const winnerEvidence = winner?.evidenceId
        ? await this.prisma.assetWorkOrderEvidence.findUnique({
            where: { id: winner.evidenceId }
          })
        : null;
      if (
        winner &&
        winnerEvidence?.contentSha256 === contentSha256 &&
        winner.checklistItemId ===
          (input.targetType === "CHECKLIST_ITEM" ? input.targetId : null) &&
        winner.damageId === (input.targetType === "DAMAGE" ? input.targetId : null) &&
        asRecord(winnerEvidence.captureMetadata).targetId === input.targetId &&
        asRecord(winnerEvidence.captureMetadata).targetType === input.targetType
      ) {
        return this.projectEvidenceLink(winner, winnerEvidence, true);
      }
      const committedFile = await this.prisma.fileObject.findFirst({
        where: { bucket: stored.bucket, objectKey: stored.objectKey }
      });
      if (!committedFile) {
        await this.storage.deleteObject(stored.bucket, stored.objectKey).catch(() => undefined);
      }
      throw error;
    }
  }

  async getEvidenceObject(closureCaseId: string, linkId: string, customerId?: string) {
    const [closureCase, link] = await Promise.all([
      this.prisma.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } }),
      this.prisma.vehicleReturnEvidenceLink.findUnique({ where: { id: linkId } })
    ]);
    if (
      !closureCase ||
      !link ||
      link.closureCaseId !== closureCase.id ||
      !link.evidenceId ||
      (customerId &&
        (closureCase.customerId !== customerId || link.visibility !== "CUSTOMER_VISIBLE"))
    ) {
      throw new NotFoundException("Return evidence not found.");
    }
    const evidence = await this.prisma.assetWorkOrderEvidence.findUnique({
      include: { file: true },
      where: { id: link.evidenceId }
    });
    if (!evidence?.file) throw new NotFoundException("Return evidence file not found.");
    const downloaded = await this.storage.getObject(evidence.file.bucket, evidence.file.objectKey);
    return {
      contentLength: downloaded.contentLength ?? Number(evidence.file.sizeBytes),
      mimeType: evidence.file.mimeType ?? "application/octet-stream",
      originalName: evidence.file.originalName,
      stream: downloaded.stream
    };
  }

  async getSignedReturnManifestObject(closureCaseId: string, customerId: string | null = null) {
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      select: { customerId: true },
      where: { id: closureCaseId }
    });
    if (!closureCase || (customerId && closureCase.customerId !== customerId)) {
      throw new NotFoundException("Signed return manifest not found.");
    }
    const current = await this.prisma.subscriptionClosureCurrentDocument.findUnique({
      include: { documentRevision: { include: { signedFile: true } } },
      where: {
        closureCaseId_documentType: {
          closureCaseId,
          documentType: "RETURN_MANIFEST"
        }
      }
    });
    const revision = current?.documentRevision;
    const file = revision?.stage === "ARCHIVED" ? revision.signedFile : null;
    if (!file || !revision?.signedFileHash) {
      throw new NotFoundException("Signed return manifest not found.");
    }
    const downloaded = await this.storage.getObject(file.bucket, file.objectKey);
    return {
      contentLength: downloaded.contentLength ?? Number(file.sizeBytes),
      mimeType: file.mimeType ?? downloaded.contentType ?? "application/pdf",
      originalName: file.originalName,
      signedFileHash: revision.signedFileHash,
      stream: downloaded.stream
    };
  }

  async uploadFinancialProof(
    closureCaseId: string,
    file: ReturnEvidenceUpload | undefined,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const acceptedMimeType = validateEvidenceFile(file);
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      select: { id: true },
      where: { id: closureCaseId }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    const objectIdentity = randomUUID();
    const stored = await this.storage.putSubscriptionClosureFinancialProof({
      buffer: file!.buffer,
      closureCaseId,
      contentType: acceptedMimeType,
      metadata: { uploadedBy: actorId },
      objectIdentity,
      originalName: file!.originalname
    });
    const contentSha256 = sha256(file!.buffer);
    try {
      const created = await this.prisma.fileObject.create({
        data: {
          bucket: stored.bucket,
          contentSha256,
          mimeType: acceptedMimeType,
          objectKey: stored.objectKey,
          originalName: file!.originalname,
          sizeBytes: BigInt(file!.size),
          uploadedBy: actorId
        }
      });
      return {
        contentSha256,
        fileId: created.id,
        mimeType: acceptedMimeType,
        originalName: created.originalName
      };
    } catch (error) {
      await this.storage.deleteObject(stored.bucket, stored.objectKey).catch(() => undefined);
      throw error;
    }
  }

  async generateDelta(
    closureCaseId: string,
    input: Readonly<{
      idempotencyKey: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    return this.prisma.$transaction(async (tx) => {
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      if (!closureCase?.currentChecklistRevisionId || closureCase.status !== "RETURN_INSPECTION") {
        throw conflict("RETURN_DELTA_CHECKLIST_REQUIRED", "请先完成退车清单确认。");
      }
      const delivery = await tx.vehicleDeliveryHandover.findFirst({
        orderBy: [{ archivedAt: "desc" }, { id: "asc" }],
        where: {
          archiveStatus: "ARCHIVED",
          orderId: closureCase.orderId,
          signedDocumentFileId: { not: null },
          signedPdfHash: { not: null },
          status: "ARCHIVED"
        }
      });
      if (!delivery?.signedPdfHash) {
        throw conflict("RETURN_DELTA_DELIVERY_AUTHORITY_MISMATCH", "交车归档基线不匹配。");
      }
      const deliveryWorkOrder = await tx.vehicleHandoverWorkOrder.findFirst({
        orderBy: [{ fieldCompletedAt: "desc" }, { id: "asc" }],
        where: {
          handoverId: delivery.id,
          handoverType: "DELIVERY_OUTBOUND",
          status: { in: ["FIELD_COMPLETED", "OPS_REVIEWED"] }
        }
      });
      if (!deliveryWorkOrder) {
        throw conflict("RETURN_DELTA_DELIVERY_AUTHORITY_MISMATCH", "交车现场事实不存在。");
      }
      const checklist = await tx.vehicleReturnChecklistRevision.findUnique({
        include: { items: true },
        where: { id: closureCase.currentChecklistRevisionId }
      });
      if (!checklist) throw conflict("RETURN_DELTA_CHECKLIST_REQUIRED", "退车清单不存在。");
      const checklistEvidenceLinks = await tx.vehicleReturnEvidenceLink.findMany({
        where: {
          checklistItemId: { in: checklist.items.map(({ id }) => id) },
          closureCaseId,
          evidenceId: { not: null }
        }
      });
      const supersededChecklistLinkIds = new Set(
        checklistEvidenceLinks
          .map(({ supersedesLinkId }) => supersedesLinkId)
          .filter((id): id is string => Boolean(id))
      );
      const activeChecklistEvidenceLinks = checklistEvidenceLinks.filter(
        ({ id }) => !supersededChecklistLinkIds.has(id)
      );
      const checklistItemByCode = new Map(checklist.items.map((item) => [item.itemCode, item]));
      const result = buildConditionDelta({
        delivery: deliveryConditionFacts(deliveryWorkOrder),
        return: checklist.items.map((item) => ({
          itemCode: item.itemCode,
          quantity: item.returnedQuantity ?? 0,
          state: item.state
        }))
      });
      const source = {
        id: closureCase.id,
        key: `delta:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`,
        type: "SUBSCRIPTION_CLOSURE_RETURN"
      };
      const replay = await tx.vehicleConditionDeltaRevision.findUnique({
        include: { items: { orderBy: { itemCode: "asc" } } },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      if (replay) {
        if (replay.resultHash !== result.resultHash) {
          throw conflict("RETURN_DELTA_IDEMPOTENCY_CONFLICT", "幂等键已用于其他车况差异。");
        }
        return { ...replay, replayed: true };
      }
      const current = closureCase.currentDeltaRevisionId
        ? await tx.vehicleConditionDeltaRevision.findUnique({
            where: { id: closureCase.currentDeltaRevisionId }
          })
        : null;
      const revision = await tx.vehicleConditionDeltaRevision.create({
        data: {
          closureCaseId,
          createdBy: actorId,
          deliveryDocumentHash: delivery.signedPdfHash,
          deliveryDocumentRevisionId: delivery.id,
          items: {
            create: result.items.map((item) => ({
              decisionReason: item.decisionReason,
              deliveryState: item.deliveryState,
              evidenceSnapshot: {
                evidenceIds: activeChecklistEvidenceLinks
                  .filter(
                    ({ checklistItemId }) =>
                      checklistItemId === checklistItemByCode.get(item.itemCode)?.id
                  )
                  .map(({ evidenceId }) => evidenceId)
                  .filter((id): id is string => Boolean(id))
                  .sort()
              },
              itemCode: item.itemCode,
              quantityDifference: item.quantityDifference,
              responsibility: item.responsibility,
              returnState: item.returnState,
              wearClassification: item.wearClassification
            }))
          },
          resultHash: result.resultHash,
          returnChecklistRevisionId: checklist.id,
          returnManifestHash: checklist.manifestHash,
          revisionNumber: (current?.revisionNumber ?? 0) + 1,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type,
          supersedesRevisionId: current?.id ?? null
        },
        include: { items: { orderBy: { itemCode: "asc" } } }
      });
      await tx.subscriptionClosureCase.update({
        data: {
          currentDeltaRevisionId: revision.id,
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      return { ...revision, replayed: false };
    });
  }

  async confirmDelta(
    closureCaseId: string,
    input: Readonly<{
      baseRevisionId: string;
      decisions: readonly Readonly<{
        decisionReason: string;
        itemId: string;
        responsibility: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR";
      }>[];
      idempotencyKey: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    return this.prisma.$transaction(async (tx) => {
      const [closureCase, base] = await Promise.all([
        tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } }),
        tx.vehicleConditionDeltaRevision.findUnique({
          include: { items: { orderBy: { itemCode: "asc" } } },
          where: { id: input.baseRevisionId }
        })
      ]);
      if (
        !closureCase ||
        !base ||
        base.closureCaseId !== closureCase.id ||
        closureCase.currentDeltaRevisionId !== base.id ||
        closureCase.status !== "RETURN_INSPECTION"
      ) {
        throw conflict("RETURN_DELTA_BASE_REVISION_MISMATCH", "责任判定必须绑定当前车况差异版本。");
      }
      const itemById = new Map(base.items.map((item) => [item.id, item]));
      let resolved: ReturnType<typeof applyConditionDeltaDecisions>;
      try {
        resolved = applyConditionDeltaDecisions(
          base.items.map((item) => ({
            decisionReason: item.decisionReason,
            deliveryState: item.deliveryState,
            itemCode: item.itemCode,
            quantityDifference: item.quantityDifference,
            responsibility: item.responsibility,
            returnState: item.returnState,
            wearClassification: item.wearClassification
          })),
          input.decisions.map((decision) => ({
            decisionReason: decision.decisionReason,
            itemCode: itemById.get(decision.itemId)?.itemCode ?? decision.itemId,
            responsibility: decision.responsibility
          }))
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "RETURN_DELTA_INVALID_DECISION";
        throw conflict(code, "责任判定不完整，或不属于当前车况差异版本。");
      }
      const sourceKey = `delta-confirm:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`;
      const replay = await tx.vehicleConditionDeltaRevision.findUnique({
        include: { items: { orderBy: { itemCode: "asc" } } },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: closureCase.id,
            sourceKey,
            sourceType: "SUBSCRIPTION_CLOSURE_RETURN"
          }
        }
      });
      if (replay) {
        if (replay.resultHash !== resolved.resultHash) {
          throw conflict("RETURN_DELTA_IDEMPOTENCY_CONFLICT", "幂等键已用于其他责任判定结果。");
        }
        return { ...replay, replayed: true };
      }
      const evidenceByCode = new Map(
        base.items.map((item) => [item.itemCode, item.evidenceSnapshot])
      );
      const revision = await tx.vehicleConditionDeltaRevision.create({
        data: {
          closureCaseId,
          createdBy: actorId,
          deliveryDocumentHash: base.deliveryDocumentHash,
          deliveryDocumentRevisionId: base.deliveryDocumentRevisionId,
          items: {
            create: resolved.items.map((item) => ({
              decisionReason: item.decisionReason,
              deliveryState: item.deliveryState,
              evidenceSnapshot: evidenceByCode.get(item.itemCode) ?? Prisma.JsonNull,
              itemCode: item.itemCode,
              quantityDifference: item.quantityDifference,
              responsibility: item.responsibility,
              returnState: item.returnState,
              wearClassification: item.wearClassification
            }))
          },
          resultHash: resolved.resultHash,
          returnChecklistRevisionId: base.returnChecklistRevisionId,
          returnManifestHash: base.returnManifestHash,
          revisionNumber: base.revisionNumber + 1,
          sourceId: closureCase.id,
          sourceKey,
          sourceType: "SUBSCRIPTION_CLOSURE_RETURN",
          supersedesRevisionId: base.id
        },
        include: { items: { orderBy: { itemCode: "asc" } } }
      });
      await tx.subscriptionClosureCase.update({
        data: {
          currentDeltaRevisionId: revision.id,
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      return { ...revision, replayed: false };
    });
  }

  async requestApproval(
    closureCaseId: string,
    input: Readonly<{
      approvalType: "PRICING_OVERRIDE" | "WAIVER" | "WRITE_OFF" | "REGISTRATION_DOCUMENT_MISSING";
      billId?: string;
      checklistItemId?: string;
      clauseSnapshotId?: string;
      deltaItemId?: string;
      evidenceIds: readonly string[];
      idempotencyKey: string;
      manualBasis?: string;
      manualUnitPriceCents?: string;
      requestReason: string;
      settlementRevisionId?: string;
    }>,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    if (!this.assetAccounting) {
      throw conflict("CLOSURE_APPROVAL_SERVICE_UNAVAILABLE", "例外审批服务不可用。");
    }
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
    return this.prisma.$transaction(async (tx) => {
      const authority = await resolveClosureApprovalAuthority(tx, closureCaseId, input);
      return this.assetAccounting!.requestApprovalInTransaction(
        tx,
        {
          exceptionType: authority.exceptionType,
          requestEvidenceSnapshot: { evidenceIds: authority.snapshot.evidenceIds },
          requestReason: requiredText(input.requestReason, "requestReason", 2000),
          requestedAt: new Date(),
          source: {
            id: closureCaseId,
            key: `closure-approval-request:${idempotencyKey}`,
            type: "SUBSCRIPTION_CLOSURE_APPROVAL"
          },
          subject: {
            subjectField: authority.subjectField,
            subjectId: closureCaseId,
            subjectType: "SETTLEMENT_CASE"
          }
        },
        {
          actorId: user.id,
          ipAddress: context.ipAddress,
          permissions: user.permissions,
          userAgent: context.userAgent
        },
        async () => authority.snapshot
      );
    });
  }

  async decideApproval(
    closureCaseId: string,
    approvalId: string,
    input: Readonly<{
      decision: "APPROVED" | "REJECTED";
      decisionComment: string;
      expectedVersion: number;
      idempotencyKey: string;
    }>,
    user: RequestUser,
    context: RequestContext
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    if (!this.assetAccounting) {
      throw conflict("CLOSURE_APPROVAL_SERVICE_UNAVAILABLE", "例外审批服务不可用。");
    }
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.businessExceptionApproval.findUnique({ where: { id: approvalId } });
      if (
        !approval ||
        approval.subjectId !== closureCaseId ||
        approval.subjectType !== "SETTLEMENT_CASE"
      ) {
        throw new NotFoundException("Subscription closure approval not found.");
      }
      const snapshot = asRecord(approval.subjectSnapshot);
      const approvalType = approvalTypeForException(approval.exceptionType);
      const authority = await resolveClosureApprovalAuthority(tx, closureCaseId, {
        approvalType,
        billId: stringOrUndefined(snapshot.billId),
        checklistItemId: stringOrUndefined(snapshot.checklistItemId),
        clauseSnapshotId: stringOrUndefined(snapshot.clauseSnapshotId),
        deltaItemId: stringOrUndefined(snapshot.deltaItemId),
        evidenceIds: stringArray(snapshot.evidenceIds),
        manualBasis: stringOrUndefined(snapshot.manualBasis),
        manualUnitPriceCents: stringOrUndefined(snapshot.manualUnitPriceCents),
        settlementRevisionId:
          approvalType === "REGISTRATION_DOCUMENT_MISSING"
            ? undefined
            : requiredSnapshotString(snapshot.settlementRevisionId)
      });
      if (
        approval.exceptionType !== authority.exceptionType ||
        approval.subjectField !== authority.subjectField
      ) {
        throw conflict("CLOSURE_APPROVAL_STALE", "审批绑定的退车结算事实已变化，请重新发起审批。");
      }
      const result = await this.assetAccounting!.decideApprovalInTransaction(
        tx,
        {
          approvalId,
          decidedAt: new Date(),
          decision: input.decision,
          decisionComment: requiredText(input.decisionComment, "decisionComment", 2000),
          exceptionType: authority.exceptionType,
          expectedVersion: input.expectedVersion,
          source: {
            id: closureCaseId,
            key: `closure-approval-decision:${idempotencyKey}`,
            type: "SUBSCRIPTION_CLOSURE_APPROVAL"
          },
          subject: {
            subjectField: authority.subjectField,
            subjectId: closureCaseId,
            subjectType: "SETTLEMENT_CASE"
          }
        },
        {
          actorId: user.id,
          ipAddress: context.ipAddress,
          permissions: user.permissions,
          userAgent: context.userAgent
        },
        async () => authority.snapshot
      );
      if (
        input.decision === "APPROVED" &&
        authority.exceptionType === "VEHICLE_REGISTRATION_DOCUMENT_MISSING"
      ) {
        const closureCase = await tx.subscriptionClosureCase.findUnique({
          select: { currentChecklistRevisionId: true, orderId: true },
          where: { id: closureCaseId }
        });
        if (closureCase?.currentChecklistRevisionId) {
          await tx.subscriptionAutomationJob.updateMany({
            data: {
              attemptCount: 0,
              availableAt: new Date(),
              completedAt: null,
              jobStatus: "PENDING",
              lastErrorCode: null,
              lastErrorMessage: null,
              leaseExpiresAt: null,
              leaseToken: null,
              resultSnapshot: Prisma.JsonNull,
              startedAt: null
            },
            where: {
              jobType: "CLOSURE_RETURN_MANIFEST_ESIGN",
              orderId: closureCase.orderId,
              payload: {
                path: ["checklistRevisionId"],
                equals: closureCase.currentChecklistRevisionId
              }
            }
          });
        }
      }
      return result;
    });
  }

  async createPricing(
    closureCaseId: string,
    input: Readonly<{
      finalize: boolean;
      idempotencyKey: string;
      lines: readonly Readonly<{
        chargeType: string;
        clauseSnapshotId: string | null;
        deltaItemId: string | null;
        evidenceIds: readonly string[];
        exceptionApprovalId: string | null;
        lineCode: string;
        manualBasis?: string | null;
        manualUnitPriceCents?: string | null;
        quantity: number;
        responsibility: "CUSTOMER" | "PLATFORM" | "THIRD_PARTY" | "NORMAL_WEAR" | "UNDETERMINED";
      }>[];
      settlementRevisionId: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_settlement_revision" WHERE "id" = ${input.settlementRevisionId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      const settlement = await tx.subscriptionClosureSettlementRevision.findUnique({
        where: { id: input.settlementRevisionId }
      });
      if (
        !closureCase ||
        !settlement ||
        closureCase.status !== "PENDING_SETTLEMENT" ||
        settlement.closureCaseId !== closureCase.id ||
        closureCase.currentSettlementRevisionId !== settlement.id ||
        settlement.stage !== "PROPOSED"
      ) {
        throw conflict("CLOSURE_PRICING_SETTLEMENT_MISMATCH", "收费明细必须绑定当前结算版本。");
      }
      const lineCodes = input.lines.map(({ lineCode }) => lineCode.trim().toUpperCase());
      if (new Set(lineCodes).size !== lineCodes.length) {
        throw badRequest("CLOSURE_PRICING_DUPLICATE_LINE", "收费项编码不可重复。");
      }
      const deltaItemIds = input.lines
        .map(({ deltaItemId }) => deltaItemId)
        .filter((id): id is string => Boolean(id));
      if (new Set(deltaItemIds).size !== deltaItemIds.length) {
        throw badRequest(
          "CLOSURE_PRICING_DUPLICATE_DELTA_ITEM",
          "同一车况差异项不能重复生成收费明细。"
        );
      }
      requiredText(input.idempotencyKey, "idempotencyKey", 180);
      const acceptedDisputeDecisions = await tx.subscriptionClosureChargeDisputeDecision.findMany({
        select: {
          dispute: { select: { chargeLine: { select: { deltaItemId: true } } } }
        },
        where: { closureCaseId, decision: "ACCEPTED_BY_PLATFORM" }
      });
      const repricedAcceptedDeltaItemIds = acceptedDisputeRepricingDeltaItemIds(
        deltaItemIds,
        acceptedDisputeDecisions
          .map(({ dispute }) => dispute.chargeLine.deltaItemId)
          .filter((id): id is string => Boolean(id))
      );
      if (repricedAcceptedDeltaItemIds.length > 0) {
        throw conflict(
          "CLOSURE_PRICING_ACCEPTED_DISPUTE",
          "平台已接受客户争议的车况差异项不得在后继结算方案中重新收费。"
        );
      }
      const existing = input.finalize
        ? await tx.subscriptionClosureChargeLine.findMany({
            where: {
              closureCaseId,
              settlementRevisionId: settlement.id,
              status: "FINAL"
            }
          })
        : [];
      if (existing.length > 0) {
        const requestedByCode = new Map(
          input.lines.map((line, index) => [lineCodes[index]!, line])
        );
        if (
          existing.length !== input.lines.length ||
          existing.some((line) => {
            const requested = requestedByCode.get(line.lineCode);
            const evidence = asRecord(line.evidenceSnapshot).evidenceIds;
            const calculation = asRecord(line.calculationSnapshot);
            return (
              !requested ||
              line.chargeType !== requested.chargeType ||
              line.clauseSnapshotId !== requested.clauseSnapshotId ||
              line.deltaItemId !== requested.deltaItemId ||
              line.exceptionApprovalId !== requested.exceptionApprovalId ||
              line.responsibility !== requested.responsibility ||
              Number(line.quantity) !== requested.quantity ||
              (requested.manualUnitPriceCents !== undefined &&
                requested.manualUnitPriceCents !== null &&
                line.unitPriceCents.toString() !== requested.manualUnitPriceCents) ||
              (requested.manualBasis?.trim() || null) !==
                (typeof calculation.manualBasis === "string" ? calculation.manualBasis : null) ||
              canonicalSubscriptionClosureJson(
                (Array.isArray(evidence) ? [...evidence].sort() : []) as never
              ) !== canonicalSubscriptionClosureJson([...requested.evidenceIds].sort() as never)
            );
          })
        ) {
          throw conflict("CLOSURE_PRICING_IDEMPOTENCY_CONFLICT", "结算版本已绑定其他收费明细。");
        }
        return existing;
      }
      const evidenceIds = [...new Set(input.lines.flatMap((line) => line.evidenceIds))];
      const evidenceLinks = await tx.vehicleReturnEvidenceLink.findMany({
        where: { closureCaseId, evidenceId: { in: evidenceIds } }
      });
      if (
        evidenceIds.length > 0 &&
        new Set(evidenceLinks.map(({ evidenceId }) => evidenceId)).size !== evidenceIds.length
      ) {
        throw conflict("CLOSURE_PRICING_EVIDENCE_MISMATCH", "收费证据不属于当前退车流程。");
      }
      if (input.finalize) {
        const clauseIds = input.lines
          .map(({ clauseSnapshotId }) => clauseSnapshotId)
          .filter((id): id is string => Boolean(id));
        const governedClauses = await tx.contractChargeClauseSnapshot.findMany({
          where: {
            contractId: closureCase.contractId,
            id: { in: clauseIds }
          }
        });
        const clauseById = new Map(governedClauses.map((clause) => [clause.id, clause]));
        if (
          clauseIds.length !== input.lines.length ||
          input.lines.some((line) => {
            const clause = clauseById.get(line.clauseSnapshotId ?? "");
            if (!clause || clause.chargeType !== line.chargeType) return true;
            if (clause.status === "EXECUTABLE") return Boolean(line.exceptionApprovalId);
            return (
              !line.exceptionApprovalId ||
              !line.manualBasis?.trim() ||
              !line.manualUnitPriceCents ||
              !/^(?:0|[1-9]\d*)$/.test(line.manualUnitPriceCents)
            );
          })
        ) {
          throw conflict(
            "CLOSURE_PRICING_EXECUTABLE_CLAUSE_REQUIRED",
            "正式收费必须绑定可执行合同条款；人工审查条款还需填写价格和合同/维修依据。"
          );
        }
      }
      const created = [];
      for (const [index, line] of input.lines.entries()) {
        const clause = line.clauseSnapshotId
          ? await tx.contractChargeClauseSnapshot.findUnique({
              where: { id: line.clauseSnapshotId }
            })
          : null;
        if (
          clause &&
          (clause.contractId !== closureCase.contractId || clause.chargeType !== line.chargeType)
        ) {
          throw conflict("CLOSURE_PRICING_CLAUSE_MISMATCH", "收费条款不属于当前合同。");
        }
        const deltaItem = line.deltaItemId
          ? await tx.vehicleConditionDeltaItem.findUnique({
              include: { revision: true },
              where: { id: line.deltaItemId }
            })
          : null;
        if (
          !deltaItem ||
          deltaItem.revision.closureCaseId !== closureCase.id ||
          deltaItem.revision.id !== closureCase.currentDeltaRevisionId ||
          deltaItem.responsibility !== line.responsibility
        ) {
          throw conflict("CLOSURE_PRICING_DELTA_MISMATCH", "收费项未绑定当前车况差异版本。");
        }
        const exceptionApprovalId =
          input.finalize && clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED"
            ? await requireCurrentPricingApproval(tx, closureCase.id, settlement.id, line)
            : null;
        let governedCharge: ReturnType<typeof governedChargeFactsForDeltaItem>;
        try {
          governedCharge = governedChargeFactsForDeltaItem(deltaItem);
        } catch {
          throw conflict("CLOSURE_PRICING_DELTA_MISMATCH", "收费类型或数量与当前车况差异不一致。");
        }
        if (
          line.chargeType !== governedCharge.chargeType ||
          line.quantity !== governedCharge.quantity
        ) {
          throw conflict("CLOSURE_PRICING_DELTA_MISMATCH", "收费类型或数量与当前车况差异不一致。");
        }
        const deltaEvidenceIds = new Set(
          Array.isArray(asRecord(deltaItem.evidenceSnapshot).evidenceIds)
            ? (asRecord(deltaItem.evidenceSnapshot).evidenceIds as unknown[]).filter(
                (value): value is string => typeof value === "string"
              )
            : []
        );
        if (line.evidenceIds.some((id) => !deltaEvidenceIds.has(id))) {
          throw conflict(
            "CLOSURE_PRICING_EVIDENCE_MISMATCH",
            "收费证据必须来自当前差异项的受管证据快照。"
          );
        }
        const priorFinalLine = input.finalize
          ? await tx.subscriptionClosureChargeLine.findFirst({
              include: { bill: true },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              where: {
                closureCaseId,
                deltaItemId: deltaItem.id,
                settlementRevisionId: { not: settlement.id },
                status: "FINAL",
                supersededBy: null
              }
            })
          : null;
        if (priorFinalLine?.bill && priorFinalLine.bill.billStatus !== BillStatus.CANCELLED) {
          const priorEvidence = asRecord(priorFinalLine.evidenceSnapshot).evidenceIds;
          const priorCalculation = asRecord(priorFinalLine.calculationSnapshot);
          if (
            priorFinalLine.chargeType !== line.chargeType ||
            priorFinalLine.clauseSnapshotId !== line.clauseSnapshotId ||
            Number(priorFinalLine.quantity) !== line.quantity ||
            priorFinalLine.responsibility !== line.responsibility ||
            canonicalSubscriptionClosureJson(
              (Array.isArray(priorEvidence) ? [...priorEvidence].sort() : []) as never
            ) !== canonicalSubscriptionClosureJson([...line.evidenceIds].sort() as never) ||
            (line.manualBasis?.trim() || null) !==
              (typeof priorCalculation.manualBasis === "string"
                ? priorCalculation.manualBasis
                : null)
          ) {
            throw conflict(
              "CLOSURE_PRICING_ACTIVE_BILL_REPLACEMENT_REQUIRED",
              "已有未清账单的收费项不能直接改价；请先形成争议接受或受管作废事实。"
            );
          }
          created.push(
            await tx.subscriptionClosureChargeLine.create({
              data: {
                amountCents: priorFinalLine.amountCents,
                billId: priorFinalLine.billId,
                calculationHash: priorFinalLine.calculationHash,
                calculationSnapshot:
                  priorFinalLine.calculationSnapshot === null
                    ? Prisma.JsonNull
                    : (priorFinalLine.calculationSnapshot as Prisma.InputJsonValue),
                chargeType: priorFinalLine.chargeType,
                clauseSnapshotId: priorFinalLine.clauseSnapshotId,
                closureCaseId,
                contractId: priorFinalLine.contractId,
                createdBy: actorId,
                deltaItemId: deltaItem.id,
                deltaRevisionId: deltaItem.revisionId,
                evidenceSnapshot:
                  priorFinalLine.evidenceSnapshot === null
                    ? Prisma.JsonNull
                    : (priorFinalLine.evidenceSnapshot as Prisma.InputJsonValue),
                exceptionApprovalId: priorFinalLine.exceptionApprovalId,
                id: randomUUID(),
                lineCode: lineCodes[index]!,
                quantity: priorFinalLine.quantity,
                responsibility: priorFinalLine.responsibility,
                settlementRevisionId: settlement.id,
                status: "FINAL",
                supersedesLineId: priorFinalLine.id,
                unitPriceCents: priorFinalLine.unitPriceCents
              }
            })
          );
          continue;
        }
        const priorMileageBills =
          line.chargeType === "OVER_MILEAGE"
            ? await tx.receivableBill.findMany({
                select: { amount: true, id: true },
                where: {
                  billStatus: { not: BillStatus.CANCELLED },
                  billType: "OVER_MILEAGE",
                  deletedAt: null,
                  orderId: closureCase.orderId,
                  NOT: { sourceKey: { startsWith: "closure-charge:" } }
                }
              })
            : [];
        const manualPricing =
          clause?.status === "MANUAL_CLAUSE_REVIEW_REQUIRED" &&
          line.manualUnitPriceCents &&
          line.manualBasis?.trim()
            ? {
                clauseCode: clause.clauseCode,
                pricingSnapshot: { unitPriceCents: line.manualUnitPriceCents },
                status: "EXECUTABLE" as const
              }
            : null;
        const priced = priceClosureCharge({
          chargeType: line.chargeType,
          clause:
            manualPricing ??
            (clause
              ? {
                  clauseCode: clause.clauseCode,
                  pricingSnapshot: asRecord(clause.pricingSnapshot),
                  status: clause.status
                }
              : null),
          evidenceIds: line.evidenceIds,
          manualBasis: line.manualBasis,
          priorBilledAmountCents: priorMileageBills.reduce((sum, bill) => sum + bill.amount, 0n),
          priorBillIds: priorMileageBills.map(({ id }) => id),
          quantity: line.quantity
        });
        const lineId = randomUUID();
        if (!input.finalize) {
          created.push({
            amountCents: priced.amountCents,
            billId: null,
            calculationHash: priced.calculationHash,
            calculationSnapshot: priced.calculationSnapshot,
            chargeType: line.chargeType,
            clauseSnapshotId: priced.status === "PRICING_EXCEPTION" ? null : (clause?.id ?? null),
            closureCaseId,
            contractId: closureCase.contractId,
            createdAt: new Date(),
            createdBy: actorId,
            deltaItemId: deltaItem.id,
            deltaRevisionId: deltaItem.revisionId,
            evidenceSnapshot: {
              evidenceIds: [...line.evidenceIds].sort(),
              evidenceLinkIds: evidenceLinks
                .filter(({ evidenceId }) => line.evidenceIds.includes(evidenceId ?? ""))
                .map(({ id }) => id)
                .sort()
            },
            exceptionApprovalId: line.exceptionApprovalId,
            id: lineId,
            lineCode: lineCodes[index]!,
            quantity: new Prisma.Decimal(line.quantity),
            responsibility: line.responsibility,
            settlementRevisionId: settlement.id,
            status: priced.status === "PRICING_EXCEPTION" ? "PRICING_EXCEPTION" : "PREVIEW",
            supersedesLineId: null,
            unitPriceCents: priced.unitPriceCents
          });
          continue;
        }
        let billId: string | null = null;
        if (
          input.finalize &&
          line.responsibility === "CUSTOMER" &&
          priced.status === "FINAL" &&
          priced.amountCents > 0n
        ) {
          billId = randomUUID();
          const dueDate = new Date();
          dueDate.setUTCDate(dueDate.getUTCDate() + 7);
          await tx.receivableBill.create({
            data: {
              amount: priced.amountCents,
              billNo: createBusinessNo("BIL"),
              billStatus: "PENDING",
              billType: line.chargeType === "OVER_MILEAGE" ? "OVER_MILEAGE" : "DAMAGE_FEE",
              createdBy: actorId,
              customerId: closureCase.customerId,
              dueDate,
              id: billId,
              orderId: closureCase.orderId,
              remainingAmount: priced.amountCents,
              remark: `退车结算收费项 ${line.lineCode}`,
              snapshot: {
                calculationHash: priced.calculationHash,
                chargeLineId: lineId,
                closureCaseId,
                settlementRevisionId: settlement.id
              },
              sourceKey: `closure-charge:${lineId}`
            }
          });
        }
        const supersededDraft =
          (await tx.subscriptionClosureChargeLine.findUnique({
            where: {
              settlementRevisionId_lineCode_status: {
                lineCode: lineCodes[index]!,
                settlementRevisionId: settlement.id,
                status: "PRICING_EXCEPTION"
              }
            }
          })) ??
          (await tx.subscriptionClosureChargeLine.findUnique({
            where: {
              settlementRevisionId_lineCode_status: {
                lineCode: lineCodes[index]!,
                settlementRevisionId: settlement.id,
                status: "PREVIEW"
              }
            }
          }));
        created.push(
          await tx.subscriptionClosureChargeLine.create({
            data: {
              amountCents: priced.amountCents,
              billId,
              calculationHash: priced.calculationHash,
              calculationSnapshot: priced.calculationSnapshot as Prisma.InputJsonValue,
              chargeType: line.chargeType,
              clauseSnapshotId: priced.status === "PRICING_EXCEPTION" ? null : (clause?.id ?? null),
              closureCaseId,
              contractId: closureCase.contractId,
              createdBy: actorId,
              deltaItemId: deltaItem?.id ?? null,
              deltaRevisionId: deltaItem?.revisionId ?? closureCase.currentDeltaRevisionId,
              evidenceSnapshot: {
                evidenceIds: [...line.evidenceIds].sort(),
                evidenceLinkIds: evidenceLinks
                  .filter(({ evidenceId }) => line.evidenceIds.includes(evidenceId ?? ""))
                  .map(({ id }) => id)
                  .sort()
              },
              exceptionApprovalId,
              id: lineId,
              lineCode: lineCodes[index]!,
              quantity: new Prisma.Decimal(line.quantity),
              responsibility: line.responsibility,
              settlementRevisionId: settlement.id,
              status:
                priced.status === "PRICING_EXCEPTION"
                  ? "PRICING_EXCEPTION"
                  : input.finalize
                    ? "FINAL"
                    : "PREVIEW",
              supersedesLineId: supersededDraft?.id ?? null,
              unitPriceCents: priced.unitPriceCents
            }
          })
        );
      }
      return created;
    });
  }

  async recordCustomerResponse(
    orderId: string,
    customerId: string,
    input: Readonly<{
      disputes: readonly Readonly<{
        chargeLineId: string;
        evidenceIds: readonly string[];
        reason: string;
      }>[];
      idempotencyKey: string;
      settlementHash: string;
      settlementRevisionId: string;
      status: "ACCEPTED" | "PARTIALLY_DISPUTED" | "DISPUTED";
    }>
  ) {
    if (this.threeStageWriteGateActive()) {
      const governedCase = await this.prisma.subscriptionClosureCase.findFirst({
        select: { id: true },
        where: { customerId, orderId, retiredAt: null }
      });
      if (!governedCase) throw new NotFoundException("Subscription closure case not found.");
      await this.assertThreeStageWriteAllowed(governedCase.id);
    }
    if (input.status !== "ACCEPTED" && this.paymentOrders) {
      const governedLines = await this.prisma.subscriptionClosureChargeLine.findMany({
        select: { billId: true },
        where: {
          billId: { not: null },
          closureCase: { customerId, orderId, retiredAt: null },
          id: { in: input.disputes.map(({ chargeLineId }) => chargeLineId) }
        }
      });
      await this.paymentOrders.closeActivePaymentOrdersForBills(
        governedLines.flatMap(({ billId }) => (billId ? [billId] : [])),
        "closure-customer-dispute"
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const observedClosureCase = await tx.subscriptionClosureCase.findFirst({
        select: { id: true },
        where: { customerId, orderId, retiredAt: null }
      });
      if (!observedClosureCase) {
        throw conflict("CLOSURE_RESPONSE_STALE_REVISION", "结算方案已更新，请刷新后重新确认。");
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${observedClosureCase.id}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_settlement_revision" WHERE "id" = ${input.settlementRevisionId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findFirst({
        where: { customerId, id: observedClosureCase.id, orderId, retiredAt: null }
      });
      if (!closureCase || closureCase.currentSettlementRevisionId !== input.settlementRevisionId) {
        throw conflict("CLOSURE_RESPONSE_STALE_REVISION", "结算方案已更新，请刷新后重新确认。");
      }
      const settlement = await tx.subscriptionClosureSettlementRevision.findUnique({
        where: { id: input.settlementRevisionId }
      });
      if (
        !settlement ||
        settlement.resultHash !== input.settlementHash ||
        settlement.stage !== "FINALIZED"
      ) {
        throw conflict("CLOSURE_RESPONSE_STALE_REVISION", "结算版本或哈希不匹配。");
      }
      const disputeIds = [...new Set(input.disputes.map(({ chargeLineId }) => chargeLineId))];
      if (
        (input.status === "ACCEPTED" && input.disputes.length > 0) ||
        (input.status !== "ACCEPTED" && input.disputes.length === 0) ||
        disputeIds.length !== input.disputes.length
      ) {
        throw badRequest("CLOSURE_RESPONSE_INVALID", "客户响应与争议明细不一致。");
      }
      const pricingSettlementRevisionId = settlement.supersedesRevisionId;
      if (!pricingSettlementRevisionId) {
        throw conflict("CLOSURE_RESPONSE_CHARGE_MISMATCH", "最终结算方案缺少受管定价前序版本。");
      }
      const finalChargeLines = await tx.subscriptionClosureChargeLine.findMany({
        where: {
          closureCaseId: closureCase.id,
          settlementRevisionId: pricingSettlementRevisionId,
          status: "FINAL"
        }
      });
      const finalChargeLineIds = new Set(finalChargeLines.map(({ id }) => id));
      if (disputeIds.some((id) => !finalChargeLineIds.has(id))) {
        throw conflict("CLOSURE_RESPONSE_CHARGE_MISMATCH", "争议收费项不属于当前结算版本。");
      }
      if (
        (input.status === "PARTIALLY_DISPUTED" &&
          (disputeIds.length === 0 || disputeIds.length >= finalChargeLines.length)) ||
        (input.status === "DISPUTED" &&
          (finalChargeLines.length === 0 || disputeIds.length !== finalChargeLines.length))
      ) {
        throw badRequest("CLOSURE_RESPONSE_INVALID", "部分争议与全部争议必须准确对应当前收费项。");
      }
      const disputedBillIds = finalChargeLines
        .filter(({ id }) => disputeIds.includes(id))
        .flatMap(({ billId }) => (billId ? [billId] : []))
        .sort();
      await lockBillsAndAssertNoActivePaymentOrders(
        tx,
        disputedBillIds,
        "CLOSURE_RESPONSE_ACTIVE_PAYMENT_ORDER"
      );
      const disputeEvidenceIds = [
        ...new Set(input.disputes.flatMap(({ evidenceIds }) => evidenceIds))
      ];
      const disputeEvidence = await tx.vehicleReturnEvidenceLink.findMany({
        where: {
          closureCaseId: closureCase.id,
          evidenceId: { in: disputeEvidenceIds },
          visibility: "CUSTOMER_VISIBLE"
        }
      });
      if (
        disputeEvidenceIds.length > 0 &&
        new Set(disputeEvidence.map(({ evidenceId }) => evidenceId)).size !==
          disputeEvidenceIds.length
      ) {
        throw conflict("CLOSURE_RESPONSE_EVIDENCE_MISMATCH", "争议证据不属于当前退车流程。");
      }
      const source = {
        id: closureCase.id,
        key: `customer-response:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`,
        type: "SUBSCRIPTION_CLOSURE_PORTAL"
      };
      const existing = await tx.subscriptionClosureCustomerResponse.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      const responseSnapshot = {
        disputes: input.disputes.map((item) => ({
          chargeLineId: item.chargeLineId,
          evidenceIds: [...item.evidenceIds].sort(),
          reason: item.reason.trim()
        })),
        settlementHash: input.settlementHash,
        settlementRevisionId: input.settlementRevisionId,
        status: input.status
      };
      if (existing) {
        if (
          existing.settlementHash !== input.settlementHash ||
          canonicalSubscriptionClosureJson(existing.responseSnapshot as never) !==
            canonicalSubscriptionClosureJson(responseSnapshot as never)
        ) {
          throw conflict("CLOSURE_RESPONSE_IDEMPOTENCY_CONFLICT", "幂等键已用于其他客户响应。");
        }
        return existing;
      }
      const previous = await latestCustomerResponse(tx, closureCase.id);
      if (previous?.settlementRevisionId === settlement.id) {
        if (
          previous.settlementHash === input.settlementHash &&
          canonicalSubscriptionClosureJson(previous.responseSnapshot as never) ===
            canonicalSubscriptionClosureJson(responseSnapshot as never)
        ) {
          return previous;
        }
        throw conflict(
          "CLOSURE_RESPONSE_ALREADY_RECORDED",
          "客户已对当前最终结算版本提交反馈；如金额变化，必须发布后继结算版本。"
        );
      }
      const now = new Date();
      const response = await tx.subscriptionClosureCustomerResponse.create({
        data: {
          closureCaseId: closureCase.id,
          notificationSnapshot: { channel: "PORTAL", delivered: true },
          respondedAt: now,
          respondedByCustomerId: customerId,
          responseSnapshot,
          settlementHash: input.settlementHash,
          settlementRevisionId: settlement.id,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type,
          status: input.status,
          supersedesResponseId: previous?.id ?? null
        }
      });
      if (input.disputes.length > 0) {
        await tx.subscriptionClosureChargeDispute.createMany({
          data: input.disputes.map((item) => ({
            chargeLineId: item.chargeLineId,
            closureCaseId: closureCase.id,
            customerEvidenceSnapshot: { evidenceIds: [...item.evidenceIds].sort() },
            customerReason: requiredText(item.reason, "reason", 2000),
            customerResponseId: response.id
          }))
        });
      }
      await tx.subscriptionClosureCase.update({
        data: {
          financialStatus: input.status === "ACCEPTED" ? "AWAITING_CUSTOMER" : "DISPUTED",
          updatedBy: closureCase.updatedBy,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      return response;
    });
  }

  async recordNoResponse(
    closureCaseId: string,
    input: Readonly<{
      deadlineAt: Date;
      idempotencyKey: string;
      settlementHash: string;
      settlementRevisionId: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_settlement_revision" WHERE "id" = ${input.settlementRevisionId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      const settlement = await tx.subscriptionClosureSettlementRevision.findUnique({
        where: { id: input.settlementRevisionId }
      });
      const previous = await tx.subscriptionClosureCustomerResponse.findFirst({
        orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
        where: { closureCaseId }
      });
      if (
        !closureCase ||
        !settlement ||
        settlement.closureCaseId !== closureCase.id ||
        closureCase.currentSettlementRevisionId !== settlement.id ||
        settlement.stage !== "FINALIZED" ||
        !settlement.finalizedAt ||
        !settlement.publishedAt ||
        settlement.resultHash !== input.settlementHash
      ) {
        throw conflict(
          "CLOSURE_RESPONSE_SETTLEMENT_MISMATCH",
          "未响应记录必须绑定当前最终结算版本。"
        );
      }
      const publication = asRecord(settlement.publicationSnapshot);
      if (
        publication.channel !== "PORTAL" ||
        publication.publicationId !== settlement.id ||
        publication.resultHash !== settlement.resultHash ||
        publication.publishedAt !== settlement.publishedAt.toISOString()
      ) {
        throw conflict(
          "CLOSURE_RESPONSE_PUBLICATION_FACT_REQUIRED",
          "无法核验最终结算方案的不可变发布事实，禁止代记客户未响应。"
        );
      }
      const serverDeadline = new Date(settlement.publishedAt.getTime() + 72 * 60 * 60 * 1000);
      if (
        Number.isNaN(input.deadlineAt.getTime()) ||
        input.deadlineAt.getTime() !== serverDeadline.getTime() ||
        now.getTime() < serverDeadline.getTime()
      ) {
        throw conflict(
          "CLOSURE_RESPONSE_DEADLINE_NOT_REACHED",
          `客户确认期尚未结束；服务端截止时间为 ${serverDeadline.toISOString()}。`
        );
      }
      if (previous?.settlementRevisionId === settlement.id && previous.status !== "NO_RESPONSE") {
        throw conflict("CLOSURE_RESPONSE_ALREADY_RECORDED", "客户已对当前最终方案作出反馈。");
      }
      if (
        previous?.settlementRevisionId === settlement.id &&
        previous.status === "NO_RESPONSE" &&
        previous.settlementHash === settlement.resultHash
      ) {
        return previous;
      }
      const source = {
        id: closureCase.id,
        key: `customer-no-response:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`,
        type: "SUBSCRIPTION_CLOSURE_CUSTOMER_RESPONSE"
      };
      const replay = await tx.subscriptionClosureCustomerResponse.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      if (replay) {
        if (
          replay.status !== "NO_RESPONSE" ||
          replay.settlementRevisionId !== settlement.id ||
          replay.settlementHash !== settlement.resultHash
        ) {
          throw conflict("CLOSURE_RESPONSE_IDEMPOTENCY_CONFLICT", "幂等键已用于其他客户反馈。");
        }
        return replay;
      }
      const created = await tx.subscriptionClosureCustomerResponse.create({
        data: {
          closureCaseId,
          notificationSnapshot: {
            ...publication,
            deliveredAt: settlement.publishedAt.toISOString(),
            deadlineAt: serverDeadline.toISOString(),
            recordedAt: now.toISOString(),
            recordedBy: actorId
          },
          respondedAt: now,
          responseSnapshot: {
            disputes: [],
            settlementHash: settlement.resultHash,
            settlementRevisionId: settlement.id,
            status: "NO_RESPONSE"
          },
          settlementHash: settlement.resultHash,
          settlementRevisionId: settlement.id,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type,
          status: "NO_RESPONSE",
          supersedesResponseId: previous?.id ?? null
        }
      });
      await tx.subscriptionClosureCase.update({
        data: {
          financialStatus: "COLLECTION_PENDING",
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      return created;
    });
  }

  async decideDispute(
    closureCaseId: string,
    disputeId: string,
    input: Readonly<{
      decision: "ACCEPTED_BY_PLATFORM" | "REJECTED_BY_PLATFORM";
      evidenceIds: readonly string[];
      idempotencyKey: string;
      occurredAt: Date;
      rationale: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    if (input.decision === "ACCEPTED_BY_PLATFORM" && this.paymentOrders) {
      const governedDispute = await this.prisma.subscriptionClosureChargeDispute.findFirst({
        select: { chargeLine: { select: { billId: true } } },
        where: { closureCaseId, id: disputeId }
      });
      await this.paymentOrders.closeActivePaymentOrdersForBills(
        governedDispute?.chargeLine.billId ? [governedDispute.chargeLine.billId] : [],
        "closure-dispute-accepted"
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      const dispute = await tx.subscriptionClosureChargeDispute.findUnique({
        include: { chargeLine: { include: { bill: true } }, decision: true },
        where: { id: disputeId }
      });
      if (!dispute || dispute.closureCaseId !== closureCaseId) {
        throw new NotFoundException("Subscription closure dispute not found.");
      }
      const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 180);
      if (dispute.decision) {
        if (
          dispute.decision.sourceKey === `dispute-decision:${idempotencyKey}` &&
          dispute.decision.decision === input.decision
        ) {
          return dispute.decision;
        }
        throw conflict("CLOSURE_DISPUTE_ALREADY_DECIDED", "该争议已形成不可重复修改的处理结论。");
      }
      const evidenceIds = [...new Set(input.evidenceIds)].sort();
      if (evidenceIds.length === 0) {
        throw badRequest(
          "CLOSURE_DISPUTE_DECISION_EVIDENCE_REQUIRED",
          "争议处理结论必须绑定受管证据。"
        );
      }
      const links = await tx.vehicleReturnEvidenceLink.findMany({
        where: { closureCaseId, evidenceId: { in: evidenceIds } }
      });
      if (new Set(links.map(({ evidenceId }) => evidenceId)).size !== evidenceIds.length) {
        throw conflict(
          "CLOSURE_DISPUTE_DECISION_EVIDENCE_MISMATCH",
          "争议处理证据不属于当前退车闭环。"
        );
      }
      const created = await tx.subscriptionClosureChargeDisputeDecision.create({
        data: {
          closureCaseId,
          decision: input.decision,
          decisionSnapshot: {
            decision: input.decision,
            idempotencyKey,
            rationale: requiredText(input.rationale, "rationale", 2000)
          },
          decidedAt: input.occurredAt,
          decidedBy: actorId,
          disputeId: dispute.id,
          evidenceSnapshot: { evidenceIds },
          sourceId: closureCaseId,
          sourceKey: `dispute-decision:${idempotencyKey}`,
          sourceType: "SUBSCRIPTION_CLOSURE_DISPUTE_DECISION"
        }
      });
      if (input.decision === "ACCEPTED_BY_PLATFORM") {
        const bill = dispute.chargeLine.bill;
        if (!bill) {
          throw conflict("CLOSURE_DISPUTE_BILL_REQUIRED", "被接受的收费争议缺少可调整账单。");
        }
        if (bill.paidAmount > 0n || bill.amount !== bill.remainingAmount) {
          throw conflict(
            "CLOSURE_DISPUTE_PAID_BILL_REVIEW_REQUIRED",
            "该争议账单已有收款，必须先走人工退款/冲正后才能接受争议。"
          );
        }
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${bill.id}::uuid FOR UPDATE`
        );
        const lockedBill = await tx.receivableBill.findUnique({ where: { id: bill.id } });
        await assertNoActivePaymentOrders(tx, [bill.id], "CLOSURE_DISPUTE_ACTIVE_PAYMENT_ORDER");
        if (
          !lockedBill ||
          lockedBill.paidAmount > 0n ||
          lockedBill.amount !== lockedBill.remainingAmount
        ) {
          throw conflict(
            "CLOSURE_DISPUTE_PAID_BILL_REVIEW_REQUIRED",
            "该争议账单已有收款或余额已变化，必须刷新后按当前事实处理。"
          );
        }
        if (lockedBill.remainingAmount > 0n && lockedBill.billStatus !== BillStatus.CANCELLED) {
          await tx.receivableBill.update({
            data: {
              billStatus: BillStatus.CANCELLED,
              cancelledAt: input.occurredAt,
              remainingAmount: 0n,
              snapshot: {
                ...asRecord(bill.snapshot),
                closureDisputeDecisionId: created.id,
                closureDisputeDisposition: "ACCEPTED_BY_PLATFORM"
              },
              updatedBy: actorId
            },
            where: { id: bill.id }
          });
        }
      }
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      if (closureCase) {
        const financial = await deriveFinancialFromDatabase(
          tx,
          closureCase.id,
          closureCase.orderId
        );
        await tx.subscriptionClosureCase.update({
          data: {
            financialStatus: financial.financialStatus,
            updatedBy: actorId,
            version: { increment: 1 }
          },
          where: { id: closureCase.id }
        });
      }
      return created;
    });
  }

  async recordDisposition(
    closureCaseId: string,
    input: Readonly<{
      approvalId: string | null;
      billId: string;
      chargeLineId: string | null;
      detail: Readonly<Record<string, unknown>>;
      disposition: ClosureReceivableFact["disposition"];
      idempotencyKey: string;
      ownerId: string | null;
      ownerType: string;
      proofFileId: string | null;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    if (
      ["MANUAL_PAYMENT_CONFIRMED", "WAIVED", "WRITTEN_OFF"].includes(input.disposition) &&
      this.paymentOrders
    ) {
      await this.paymentOrders.closeActivePaymentOrdersForBills(
        [input.billId],
        `closure-disposition-${input.disposition.toLowerCase()}`
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${input.billId}::uuid FOR UPDATE`
      );
      const [closureCase, bill] = await Promise.all([
        tx.subscriptionClosureCase.findUnique({
          include: { currentSettlementRevision: true },
          where: { id: closureCaseId }
        }),
        tx.receivableBill.findUnique({ where: { id: input.billId } })
      ]);
      if (!closureCase || !bill || bill.orderId !== closureCase.orderId) {
        throw conflict("CLOSURE_DISPOSITION_BILL_MISMATCH", "应收账单不属于当前退车流程。");
      }
      if (input.disposition === "PAID" || input.disposition === "LEGAL_COLLECTION") {
        throw badRequest(
          "CLOSURE_DISPOSITION_GOVERNED_PATH_REQUIRED",
          "已付款只能由实际核销事实产生；法催只能通过证据包转法催入口建立。"
        );
      }
      const chargeLine = input.chargeLineId
        ? await tx.subscriptionClosureChargeLine.findUnique({
            where: { id: input.chargeLineId }
          })
        : null;
      if (
        input.chargeLineId &&
        (!chargeLine ||
          chargeLine.closureCaseId !== closureCase.id ||
          chargeLine.billId !== bill.id)
      ) {
        throw conflict(
          "CLOSURE_DISPOSITION_CHARGE_LINE_MISMATCH",
          "收费项与当前退车流程或目标账单不一致。"
        );
      }
      if (input.disposition === "DISPUTED") {
        const unresolvedDispute = input.chargeLineId
          ? await tx.subscriptionClosureChargeDispute.findFirst({
              where: {
                chargeLineId: input.chargeLineId,
                closureCaseId: closureCase.id,
                decision: null,
                status: "OPEN"
              }
            })
          : null;
        if (!unresolvedDispute) {
          throw conflict(
            "CLOSURE_DISPOSITION_DISPUTE_REQUIRED",
            "争议归口必须绑定客户对当前收费项提交的未决争议。"
          );
        }
      }
      if (
        ["MANUAL_PAYMENT_CONFIRMED", "WAIVED", "WRITTEN_OFF"].includes(input.disposition) &&
        !input.proofFileId
      ) {
        throw badRequest(
          "CLOSURE_DISPOSITION_PROOF_REQUIRED",
          "人工核销、减免或核销必须上传证明。"
        );
      }
      if (input.proofFileId) {
        const proof = await tx.fileObject.findUnique({ where: { id: input.proofFileId } });
        if (
          !proof ||
          !proof.objectKey.startsWith(`subscription-closure/${closureCase.id}/financial-proof/`)
        ) {
          throw conflict("CLOSURE_DISPOSITION_PROOF_MISMATCH", "证明文件不属于当前退车闭环。");
        }
      }
      if (
        ["OPEN", "DISPUTED", "COLLECTION_PENDING", "LEGAL_COLLECTION"].includes(
          input.disposition
        ) &&
        !input.ownerType.trim()
      ) {
        throw badRequest("CLOSURE_DISPOSITION_OWNER_REQUIRED", "未清应收必须指定责任归口。");
      }
      const source = {
        id: closureCase.id,
        key: `disposition:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`,
        type: "SUBSCRIPTION_CLOSURE_FINANCIAL"
      };
      const replay = await tx.subscriptionClosureReceivableDisposition.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      if (replay) {
        if (
          replay.billId !== bill.id ||
          replay.approvalId !== input.approvalId ||
          replay.chargeLineId !== input.chargeLineId ||
          replay.disposition !== input.disposition ||
          replay.ownerId !== input.ownerId ||
          replay.ownerType !== (input.ownerType.trim() || "FINANCE") ||
          replay.proofFileId !== input.proofFileId ||
          canonicalSubscriptionClosureJson(replay.detailSnapshot as never) !==
            canonicalSubscriptionClosureJson(input.detail as never)
        ) {
          throw conflict(
            "CLOSURE_DISPOSITION_IDEMPOTENCY_CONFLICT",
            "幂等键已用于其他应收处理事实。"
          );
        }
        return replay;
      }
      if (
        ["COMPLETED", "TERMINATED", "CANCELLED", "REJECTED"].includes(closureCase.status) &&
        ["OPEN", "DISPUTED", "COLLECTION_PENDING"].includes(input.disposition)
      ) {
        throw conflict(
          "CLOSURE_DISPOSITION_OPERATIONAL_TERMINAL",
          "运营闭环完成后不得将应收退回开放或人工处置；实际法务回款仍通过法催案件记录。"
        );
      }
      const openLegalCase = await tx.subscriptionClosureLegalCollectionCase.findUnique({
        where: { closureCaseId_billId: { billId: bill.id, closureCaseId } }
      });
      if (openLegalCase && !openLegalCase.closedAt) {
        throw conflict(
          "CLOSURE_DISPOSITION_LEGAL_CASE_OPEN",
          "该应收已进入法催，通用归口不得覆盖；回款或结案请从法催案件处理。"
        );
      }
      if (["MANUAL_PAYMENT_CONFIRMED", "WAIVED", "WRITTEN_OFF"].includes(input.disposition)) {
        await assertNoActivePaymentOrders(
          tx,
          [bill.id],
          "CLOSURE_DISPOSITION_ACTIVE_PAYMENT_ORDER"
        );
      }
      const current = await latestDisposition(tx, closureCase.id, bill.id);
      const disposedAmount = bill.remainingAmount;
      if (input.disposition === "WAIVED" || input.disposition === "WRITTEN_OFF") {
        const settlement = closureCase.currentSettlementRevision;
        const expectedType =
          input.disposition === "WAIVED" ? "SETTLEMENT_WAIVER" : "SETTLEMENT_WRITE_OFF";
        const expectedField = `${
          input.disposition === "WAIVED" ? "settlementWaiver" : "settlementWriteOff"
        }:${bill.id}`;
        const approval = input.approvalId
          ? await tx.businessExceptionApproval.findUnique({ where: { id: input.approvalId } })
          : null;
        const approvalSnapshot = asRecord(approval?.subjectSnapshot);
        const approvedEvidenceIds = stringArray(approvalSnapshot.evidenceIds);
        if (
          !settlement ||
          !["FINALIZED", "SETTLED"].includes(settlement.stage) ||
          !input.approvalId ||
          !approval ||
          approval.status !== "APPROVED" ||
          approval.decision !== "APPROVED" ||
          approval.expiredAt ||
          approval.exceptionType !== expectedType ||
          approval.subjectType !== "SETTLEMENT_CASE" ||
          approval.subjectId !== closureCase.id ||
          approval.subjectField !== expectedField ||
          approvalSnapshot.closureCaseId !== closureCase.id ||
          approvalSnapshot.billId !== bill.id ||
          approvalSnapshot.settlementRevisionId !== settlement.id ||
          approvalSnapshot.settlementResultHash !== settlement.resultHash ||
          approvalSnapshot.amountCents !== disposedAmount.toString() ||
          approvalSnapshot.approvalType !==
            (input.disposition === "WAIVED" ? "WAIVER" : "WRITE_OFF") ||
          !input.proofFileId ||
          !approvedEvidenceIds.includes(input.proofFileId)
        ) {
          throw conflict(
            "CLOSURE_DISPOSITION_APPROVAL_REQUIRED",
            "减免或核销必须绑定当前结算版本、账单余额和证明文件均一致的已批准例外审批。"
          );
        }
        const consumed = await tx.subscriptionClosureReceivableDisposition.aggregate({
          _sum: { amountCents: true },
          where: { approvalId: input.approvalId }
        });
        if ((consumed._sum.amountCents ?? 0n) + disposedAmount > disposedAmount) {
          throw conflict(
            "CLOSURE_DISPOSITION_APPROVAL_AMOUNT_EXCEEDED",
            "本次处置将超过当前例外审批授权金额。"
          );
        }
      } else if (input.approvalId) {
        throw badRequest(
          "CLOSURE_DISPOSITION_APPROVAL_NOT_APPLICABLE",
          "当前处置类型不得携带减免或核销审批。"
        );
      }
      if (
        ["MANUAL_PAYMENT_CONFIRMED", "WAIVED", "WRITTEN_OFF"].includes(input.disposition) &&
        disposedAmount <= 0n
      ) {
        throw conflict("CLOSURE_DISPOSITION_ALREADY_RESOLVED", "该账单已无可处置余额。");
      }
      if (input.disposition === "MANUAL_PAYMENT_CONFIRMED") {
        const payment = await tx.paymentRecord.create({
          data: {
            createdBy: actorId,
            customerId: bill.customerId,
            orderId: bill.orderId,
            payerName: "Admin verified manual payment",
            paymentAmount: disposedAmount,
            paymentMethod: PaymentMethod.OTHER,
            paymentNo: createBusinessNo("PAY"),
            paymentProofUrls: input.proofFileId
              ? ({ fileIds: [input.proofFileId] } as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            paymentStatus: PaymentStatus.CONFIRMED,
            receivedAt: new Date(),
            remark: `Closure ${closureCase.caseNo} manual payment confirmation`,
            updatedBy: actorId
          }
        });
        await tx.paymentWriteOff.create({
          data: {
            billId: bill.id,
            createdBy: actorId,
            customerId: bill.customerId,
            orderId: bill.orderId,
            paymentId: payment.id,
            remark: `Closure ${closureCase.caseNo} manual payment confirmation`,
            writeOffAmount: disposedAmount
          }
        });
        const billUpdate = await tx.receivableBill.updateMany({
          data: {
            billStatus: BillStatus.PAID,
            paidAmount: { increment: disposedAmount },
            paidAt: new Date(),
            remainingAmount: 0n,
            updatedBy: actorId
          },
          where: { id: bill.id, remainingAmount: disposedAmount }
        });
        if (billUpdate.count !== 1) {
          throw conflict(
            "CLOSURE_DISPOSITION_CONCURRENT_BILL_CHANGE",
            "应收余额已发生变化，本次人工核销未生效，请刷新后重试。"
          );
        }
      } else if (input.disposition === "WAIVED" || input.disposition === "WRITTEN_OFF") {
        const billUpdate = await tx.receivableBill.updateMany({
          data: {
            billStatus: BillStatus.CANCELLED,
            cancelledAt: new Date(),
            remainingAmount: 0n,
            snapshot: {
              ...asRecord(bill.snapshot),
              closureDisposition: input.disposition,
              closureDispositionProofFileId: input.proofFileId
            },
            updatedBy: actorId
          },
          where: { id: bill.id, remainingAmount: disposedAmount }
        });
        if (billUpdate.count !== 1) {
          throw conflict(
            "CLOSURE_DISPOSITION_CONCURRENT_BILL_CHANGE",
            "应收余额已发生变化，本次减免或核销未生效，请刷新后重试。"
          );
        }
      }
      const created = await tx.subscriptionClosureReceivableDisposition.create({
        data: {
          approvalId: input.approvalId,
          amountCents: disposedAmount,
          billId: bill.id,
          chargeLineId: input.chargeLineId,
          closureCaseId: closureCase.id,
          createdBy: actorId,
          detailSnapshot: input.detail as Prisma.InputJsonValue,
          disposition: input.disposition,
          ownerId: input.ownerId,
          ownerType: input.ownerType.trim() || "FINANCE",
          proofFileId: input.proofFileId,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type,
          supersedesDispositionId: current?.id ?? null
        }
      });
      const financial = await deriveFinancialFromDatabase(tx, closureCase.id, closureCase.orderId);
      await tx.subscriptionClosureCase.update({
        data: {
          financialStatus: financial.financialStatus,
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCase.id }
      });
      return created;
    });
  }

  async transferLegalCollection(
    closureCaseId: string,
    input: Readonly<{
      billId: string;
      evidencePackageHash: string;
      externalReference: string | null;
      idempotencyKey: string;
      openedAt: Date;
      ownerId: string;
      ownerType: string;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const transferOwnerId = requiredText(input.ownerId, "ownerId", 64);
    const transferOwnerType = requiredText(input.ownerType, "ownerType", 32);
    const replay = await this.prisma.subscriptionClosureLegalCollectionCase.findUnique({
      include: { events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } },
      where: { closureCaseId_billId: { billId: input.billId, closureCaseId } }
    });
    if (replay) {
      const transferred = replay.events.find(({ eventType }) => eventType === "TRANSFERRED");
      const transferSnapshot = asRecord(transferred?.eventSnapshot);
      if (
        replay.evidencePackageHash !== input.evidencePackageHash ||
        replay.externalReference !== input.externalReference ||
        replay.openedAt.getTime() !== input.openedAt.getTime() ||
        replay.ownerId !== transferOwnerId ||
        replay.ownerType !== transferOwnerType ||
        transferSnapshot.idempotencyKey !== input.idempotencyKey
      ) {
        throw conflict("CLOSURE_LEGAL_IDEMPOTENCY_CONFLICT", "该应收已使用其他证据包转法催。");
      }
      return replay;
    }
    const evidencePackage = await this.prisma.subscriptionClosureEvidencePackageExport.findUnique({
      include: { file: true },
      where: {
        closureCaseId_manifestHash: {
          closureCaseId,
          manifestHash: input.evidencePackageHash
        }
      }
    });
    if (!evidencePackage?.file || !evidencePackage.fileSha256) {
      throw conflict("CLOSURE_LEGAL_PACKAGE_REQUIRED", "转法催前必须生成并锁定证据包。");
    }
    if (!this.evidencePackages) {
      throw conflict(
        "CLOSURE_LEGAL_PACKAGE_VERIFIER_UNAVAILABLE",
        "证据包校验服务不可用，禁止转法催。"
      );
    }
    await this.evidencePackages.verifyExport(closureCaseId, evidencePackage.id);
    const legalCase = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${input.billId}::uuid FOR UPDATE`
        );
        if (
          (await this.evidencePackages!.currentManifestHashInTransaction(tx, closureCaseId)) !==
          input.evidencePackageHash
        ) {
          throw conflict(
            "CLOSURE_LEGAL_PACKAGE_STALE",
            "闭环事实已变化，请重新导出证据包后转法催。"
          );
        }
        const [closureCase, bill] = await Promise.all([
          tx.subscriptionClosureCase.findUnique({ where: { id: closureCaseId } }),
          tx.receivableBill.findUnique({ where: { id: input.billId } })
        ]);
        if (
          !closureCase ||
          !bill ||
          bill.orderId !== closureCase.orderId ||
          bill.remainingAmount <= 0n
        ) {
          throw conflict("CLOSURE_LEGAL_BILL_MISMATCH", "仅当前订单未清应收可转法催。");
        }
        const packageManifest = asRecord(evidencePackage.manifestSnapshot);
        const packageCase = asRecord(packageManifest.case);
        const packageBills = Array.isArray(packageManifest.receivableBills)
          ? packageManifest.receivableBills.map(asRecord)
          : [];
        const packageSettlements = Array.isArray(packageManifest.settlementRevisions)
          ? packageManifest.settlementRevisions.map(asRecord)
          : [];
        const packageResponses = Array.isArray(packageManifest.customerResponses)
          ? packageManifest.customerResponses.map(asRecord)
          : [];
        const packageDispositions = Array.isArray(packageManifest.dispositions)
          ? packageManifest.dispositions.map(asRecord)
          : [];
        const packageDisputes = Array.isArray(packageManifest.disputes)
          ? packageManifest.disputes.map(asRecord)
          : [];
        const [currentSettlement, currentResponse, currentDisposition, billDisputes] =
          await Promise.all([
            closureCase.currentSettlementRevisionId
              ? tx.subscriptionClosureSettlementRevision.findUnique({
                  where: { id: closureCase.currentSettlementRevisionId }
                })
              : Promise.resolve(null),
            latestCustomerResponse(tx, closureCase.id),
            latestDisposition(tx, closureCase.id, bill.id),
            tx.subscriptionClosureChargeDispute.findMany({
              include: { decision: true },
              where: { chargeLine: { billId: bill.id }, closureCaseId: closureCase.id }
            })
          ]);
        assertLegalCollectionTransferReady({
          disposition: currentDisposition,
          hasBlockingDispute: hasBlockingLegalCollectionDispute(billDisputes),
          response: currentResponse,
          settlement: currentSettlement,
          transferOwnerId,
          transferOwnerType
        });
        const packageBill = packageBills.find((item) => item.id === bill.id);
        const packageSettlement = packageSettlements.find(
          (item) => item.id === currentSettlement!.id
        );
        if (
          packageCase.id !== closureCase.id ||
          Number(packageCase.version) !== closureCase.version ||
          packageCase.currentChecklistRevisionId !== closureCase.currentChecklistRevisionId ||
          packageCase.currentDeltaRevisionId !== closureCase.currentDeltaRevisionId ||
          packageCase.currentSettlementRevisionId !== closureCase.currentSettlementRevisionId ||
          !packageBill ||
          String(packageBill.remainingAmount) !== String(bill.remainingAmount) ||
          !packageSettlement ||
          packageSettlement.stage !== "FINALIZED" ||
          packageSettlement.resultHash !== currentSettlement!.resultHash ||
          !packageResponses.some((item) => item.id === currentResponse!.id) ||
          !packageDispositions.some(
            (item) =>
              item.id === currentDisposition!.id &&
              item.disposition === "COLLECTION_PENDING" &&
              item.ownerId === currentDisposition!.ownerId &&
              item.ownerType === currentDisposition!.ownerType
          ) ||
          billDisputes.some((dispute) => !packageDisputes.some((item) => item.id === dispute.id))
        ) {
          throw conflict(
            "CLOSURE_LEGAL_PACKAGE_STALE",
            "The evidence package does not contain the current settlement, response and bill balance; export a new package."
          );
        }
        if (this.paymentOrders) {
          await this.paymentOrders.closeActivePaymentOrdersForBills(
            [bill.id],
            "closure-legal-transfer"
          );
        }
        await assertNoActivePaymentOrders(tx, [bill.id], "CLOSURE_LEGAL_ACTIVE_PAYMENT_ORDER");
        const existing = await tx.subscriptionClosureLegalCollectionCase.findUnique({
          include: { events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } },
          where: { closureCaseId_billId: { billId: bill.id, closureCaseId } }
        });
        if (existing) {
          const transferred = existing.events.find(({ eventType }) => eventType === "TRANSFERRED");
          const transferSnapshot = asRecord(transferred?.eventSnapshot);
          if (
            existing.evidencePackageHash !== input.evidencePackageHash ||
            existing.externalReference !== input.externalReference ||
            existing.openedAt.getTime() !== input.openedAt.getTime() ||
            existing.ownerId !== transferOwnerId ||
            existing.ownerType !== transferOwnerType ||
            transferSnapshot.idempotencyKey !== input.idempotencyKey
          ) {
            throw conflict("CLOSURE_LEGAL_IDEMPOTENCY_CONFLICT", "该应收已使用其他证据包转法催。");
          }
          return existing;
        }
        const created = await tx.subscriptionClosureLegalCollectionCase.create({
          data: {
            billId: bill.id,
            closureCaseId,
            createdBy: actorId,
            evidencePackageHash: input.evidencePackageHash,
            externalReference: input.externalReference,
            openedAt: input.openedAt,
            ownerId: transferOwnerId,
            ownerType: transferOwnerType,
            transferredAmountCents: bill.remainingAmount,
            events: {
              create: {
                eventSnapshot: {
                  collectionDispositionId: currentDisposition!.id,
                  evidencePackageHash: input.evidencePackageHash,
                  idempotencyKey: input.idempotencyKey,
                  ownerId: transferOwnerId,
                  ownerType: transferOwnerType
                },
                eventType: "TRANSFERRED",
                occurredAt: input.openedAt,
                recordedBy: actorId,
                sourceId: closureCase.id,
                sourceKey: `legal-transfer:${input.idempotencyKey}`,
                sourceType: "SUBSCRIPTION_CLOSURE_LEGAL"
              }
            }
          }
        });
        const current = await latestDisposition(tx, closureCase.id, bill.id);
        await tx.subscriptionClosureReceivableDisposition.create({
          data: {
            amountCents: bill.remainingAmount,
            billId: bill.id,
            closureCaseId,
            createdBy: actorId,
            detailSnapshot: { evidencePackageHash: input.evidencePackageHash },
            disposition: "LEGAL_COLLECTION",
            ownerId: transferOwnerId,
            ownerType: transferOwnerType,
            sourceId: closureCase.id,
            sourceKey: `legal:${input.idempotencyKey}`,
            sourceType: "SUBSCRIPTION_CLOSURE_FINANCIAL",
            supersedesDispositionId: current?.id ?? null
          }
        });
        await tx.subscriptionClosureCase.update({
          data: {
            financialStatus: "LEGAL_COLLECTION",
            updatedBy: actorId,
            version: { increment: 1 }
          },
          where: { id: closureCase.id }
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    return legalCase;
  }

  async recordLegalCollectionEvent(
    closureCaseId: string,
    input: Readonly<{
      amountCents: bigint | null;
      detail: Record<string, unknown>;
      eventType:
        | "NOTICE_SENT"
        | "CLAIM_FILED"
        | "JUDGMENT_RECORDED"
        | "SETTLEMENT_RECORDED"
        | "EXECUTION_RECEIVED"
        | "CLOSED";
      idempotencyKey: string;
      legalCaseId: string;
      occurredAt: Date;
      proofFileId: string | null;
    }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    const source = {
      id: closureCaseId,
      key: `legal-event:${requiredText(input.idempotencyKey, "idempotencyKey", 180)}`,
      type: "SUBSCRIPTION_CLOSURE_LEGAL"
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_legal_collection_case" WHERE "id" = ${input.legalCaseId}::uuid FOR UPDATE`
      );
      const observedLegalCase = await tx.subscriptionClosureLegalCollectionCase.findUnique({
        select: { billId: true },
        where: { id: input.legalCaseId }
      });
      if (observedLegalCase) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${observedLegalCase.billId}::uuid FOR UPDATE`
        );
      }
      const legalCase = await tx.subscriptionClosureLegalCollectionCase.findUnique({
        include: { bill: true },
        where: { id: input.legalCaseId }
      });
      if (!legalCase || legalCase.closureCaseId !== closureCaseId) {
        throw conflict(
          "CLOSURE_LEGAL_CASE_MISMATCH",
          "Legal collection case does not belong to the current subscription closure."
        );
      }
      const eventSnapshot = {
        ...input.detail,
        proofFileId: input.proofFileId
      } as Prisma.InputJsonValue;
      const replay = await tx.subscriptionClosureLegalCollectionEvent.findUnique({
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      if (replay) {
        if (
          replay.legalCaseId !== legalCase.id ||
          replay.eventType !== input.eventType ||
          replay.amountCents !== input.amountCents ||
          replay.occurredAt.getTime() !== input.occurredAt.getTime() ||
          canonicalSubscriptionClosureJson(replay.eventSnapshot as never) !==
            canonicalSubscriptionClosureJson(eventSnapshot as never)
        ) {
          throw conflict(
            "CLOSURE_LEGAL_EVENT_IDEMPOTENCY_CONFLICT",
            "The idempotency key has already been used for another legal collection event."
          );
        }
        return replay;
      }
      if (legalCase.closedAt) {
        throw conflict(
          "CLOSURE_LEGAL_CASE_CLOSED",
          "A closed legal collection case cannot receive more events."
        );
      }
      if (input.occurredAt < legalCase.openedAt) {
        throw badRequest(
          "CLOSURE_LEGAL_EVENT_TIME_INVALID",
          "The legal event cannot occur before the collection case was opened."
        );
      }
      if (input.amountCents !== null && input.amountCents <= 0n) {
        throw badRequest(
          "CLOSURE_LEGAL_EVENT_AMOUNT_INVALID",
          "The legal event amount must be a positive integer."
        );
      }
      if (input.eventType === "EXECUTION_RECEIVED") {
        if (
          input.amountCents === null ||
          input.amountCents > legalCase.bill.remainingAmount ||
          !input.proofFileId
        ) {
          throw conflict(
            "CLOSURE_LEGAL_RECEIPT_PROOF_REQUIRED",
            "Execution receipts require an amount within the outstanding balance and a governed proof file."
          );
        }
        const proof = await tx.fileObject.findUnique({ where: { id: input.proofFileId } });
        if (
          !proof ||
          !proof.objectKey.startsWith(`subscription-closure/${closureCaseId}/financial-proof/`)
        ) {
          throw conflict(
            "CLOSURE_LEGAL_RECEIPT_PROOF_MISMATCH",
            "The execution receipt proof does not belong to this subscription closure."
          );
        }
      }
      if (input.eventType === "CLOSED" && legalCase.bill.remainingAmount > 0n) {
        throw conflict(
          "CLOSURE_LEGAL_BALANCE_OUTSTANDING",
          "The legal collection case cannot close while the receivable bill still has a balance."
        );
      }

      if (input.eventType === "EXECUTION_RECEIVED") {
        const receivedAmount = input.amountCents!;
        const remainingAmount = legalCase.bill.remainingAmount - receivedAmount;
        const payment = await tx.paymentRecord.create({
          data: {
            createdBy: actorId,
            customerId: legalCase.bill.customerId,
            orderId: legalCase.bill.orderId,
            payerName: "Legal collection execution receipt",
            paymentAmount: receivedAmount,
            paymentMethod: PaymentMethod.OTHER,
            paymentNo: createBusinessNo("PAY"),
            paymentProofUrls: { fileIds: [input.proofFileId!] },
            paymentStatus: PaymentStatus.CONFIRMED,
            receivedAt: input.occurredAt,
            remark: `Legal collection ${legalCase.id} execution receipt`,
            updatedBy: actorId
          }
        });
        await tx.paymentWriteOff.create({
          data: {
            billId: legalCase.bill.id,
            createdBy: actorId,
            customerId: legalCase.bill.customerId,
            orderId: legalCase.bill.orderId,
            paymentId: payment.id,
            remark: `Legal collection ${legalCase.id} execution receipt`,
            writeOffAmount: receivedAmount
          }
        });
        const billUpdate = await tx.receivableBill.updateMany({
          data: {
            billStatus: remainingAmount === 0n ? BillStatus.PAID : BillStatus.PARTIALLY_PAID,
            paidAmount: { increment: receivedAmount },
            paidAt: remainingAmount === 0n ? input.occurredAt : null,
            remainingAmount,
            updatedBy: actorId
          },
          where: { id: legalCase.bill.id, remainingAmount: legalCase.bill.remainingAmount }
        });
        if (billUpdate.count !== 1) {
          throw conflict(
            "CLOSURE_LEGAL_RECEIPT_CONCURRENT_BILL_CHANGE",
            "法催回款入账时应收余额已变化，请刷新案件后重试。"
          );
        }
        const currentDisposition = await latestDisposition(tx, closureCaseId, legalCase.bill.id);
        await tx.subscriptionClosureReceivableDisposition.create({
          data: {
            amountCents: receivedAmount,
            billId: legalCase.bill.id,
            closureCaseId,
            createdBy: actorId,
            detailSnapshot: {
              legalCaseId: legalCase.id,
              legalEventType: input.eventType,
              proofFileId: input.proofFileId
            },
            disposition: remainingAmount === 0n ? "PAID" : "LEGAL_COLLECTION",
            ownerId: null,
            ownerType: "LEGAL",
            proofFileId: input.proofFileId,
            sourceId: closureCaseId,
            sourceKey: `legal-receipt:${input.idempotencyKey}`,
            sourceType: "SUBSCRIPTION_CLOSURE_FINANCIAL",
            supersedesDispositionId: currentDisposition?.id ?? null
          }
        });
      }

      const created = await tx.subscriptionClosureLegalCollectionEvent.create({
        data: {
          amountCents: input.amountCents,
          eventSnapshot,
          eventType: input.eventType,
          legalCaseId: legalCase.id,
          occurredAt: input.occurredAt,
          recordedBy: actorId,
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type
        }
      });
      if (input.eventType === "CLOSED") {
        await tx.subscriptionClosureLegalCollectionCase.update({
          data: { closedAt: input.occurredAt },
          where: { id: legalCase.id }
        });
      }
      const financial = await deriveFinancialFromDatabase(
        tx,
        closureCaseId,
        legalCase.bill.orderId
      );
      await tx.subscriptionClosureCase.update({
        data: {
          financialStatus: financial.financialStatus,
          updatedBy: actorId,
          version: { increment: 1 }
        },
        where: { id: closureCaseId }
      });
      return created;
    });
  }

  async completeOperations(
    closureCaseId: string,
    input: Readonly<{ idempotencyKey: string; occurredAt: Date }>,
    actorId: string
  ) {
    await this.assertThreeStageWriteAllowed(closureCaseId);
    return this.prisma.$transaction(async (tx) => {
      requiredText(input.idempotencyKey, "idempotencyKey", 180);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
      );
      const closureCase = await tx.subscriptionClosureCase.findUnique({
        where: { id: closureCaseId }
      });
      if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
      if (["COMPLETED", "TERMINATED"].includes(closureCase.status)) {
        return { closureCaseId, replayed: true, status: closureCase.status };
      }
      if (closureCase.status !== "PENDING_SETTLEMENT" || !closureCase.physicalControlledAt) {
        throw conflict("CLOSURE_OPERATIONAL_NOT_READY", "车辆尚未完成接收和检查。");
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "subscription_order" WHERE "id" = ${closureCase.orderId}::uuid FOR UPDATE`
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "contract" WHERE "id" = ${closureCase.contractId}::uuid FOR UPDATE`
      );
      const billIds = (
        await tx.receivableBill.findMany({
          orderBy: { id: "asc" },
          select: { id: true },
          where: { deletedAt: null, orderId: closureCase.orderId }
        })
      ).map(({ id }) => id);
      for (const billId of billIds) {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${billId}::uuid FOR UPDATE`
        );
      }
      const [currentDelta, currentSettlement] = await Promise.all([
        closureCase.currentDeltaRevisionId
          ? tx.vehicleConditionDeltaRevision.findUnique({
              include: { items: true },
              where: { id: closureCase.currentDeltaRevisionId }
            })
          : null,
        closureCase.currentSettlementRevisionId
          ? tx.subscriptionClosureSettlementRevision.findUnique({
              where: { id: closureCase.currentSettlementRevisionId }
            })
          : null
      ]);
      if (
        !currentDelta ||
        currentDelta.closureCaseId !== closureCase.id ||
        currentDelta.items.some(({ responsibility }) => responsibility === "UNDETERMINED") ||
        !currentSettlement ||
        !["FINALIZED", "SETTLED"].includes(currentSettlement.stage)
      ) {
        throw conflict(
          "CLOSURE_OPERATIONAL_SETTLEMENT_REQUIRED",
          "完成运营闭环前必须完成车况差异责任判定并发布最终结算方案。"
        );
      }
      if (currentSettlement.stage === "FINALIZED") {
        const [response, openDisputeCount, acceptedDisputeCount] = await Promise.all([
          tx.subscriptionClosureCustomerResponse.findFirst({
            orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
            where: {
              closureCaseId: closureCase.id,
              settlementRevisionId: currentSettlement.id
            }
          }),
          tx.subscriptionClosureChargeDispute.count({
            where: {
              closureCaseId: closureCase.id,
              customerResponse: { settlementRevisionId: currentSettlement.id },
              decision: null,
              status: "OPEN"
            }
          }),
          tx.subscriptionClosureChargeDisputeDecision.count({
            where: {
              closureCaseId: closureCase.id,
              decision: "ACCEPTED_BY_PLATFORM",
              dispute: { customerResponse: { settlementRevisionId: currentSettlement.id } }
            }
          })
        ]);
        if (
          !response ||
          response.settlementHash !== currentSettlement.resultHash ||
          response.status === "PENDING" ||
          openDisputeCount > 0 ||
          acceptedDisputeCount > 0
        ) {
          throw conflict(
            "CLOSURE_OPERATIONAL_CUSTOMER_RESPONSE_REQUIRED",
            "最终结算必须已有客户响应或受管未响应事实，且争议已形成可执行结论。"
          );
        }
      }
      const vehicle = await tx.vehicle.findUnique({ where: { id: closureCase.vehicleId } });
      const activeRestrictions = await tx.vehicleOperationalRestriction.count({
        where: { status: "ACTIVE", vehicleId: closureCase.vehicleId }
      });
      const financial = await deriveFinancialFromDatabase(tx, closureCase.id, closureCase.orderId);
      if (
        !mayCompleteOperations(financial, {
          inventoryReleased:
            vehicle?.status === VehicleStatus.AVAILABLE && activeRestrictions === 0,
          physicalReceiptComplete: true
        })
      ) {
        throw conflict(
          "CLOSURE_OPERATIONAL_FINANCIAL_OWNER_REQUIRED",
          "每笔未清应收必须先明确争议、催收或法催归口，且车辆库存须已释放。"
        );
      }
      const targetStatus: SubscriptionClosureStatus =
        closureCase.finalDisposition === "TERMINATE"
          ? SubscriptionClosureStatus.TERMINATED
          : SubscriptionClosureStatus.COMPLETED;
      const orderStatus =
        closureCase.finalDisposition === "TERMINATE"
          ? OrderStatus.TERMINATED
          : OrderStatus.COMPLETED;
      const contractStatus =
        closureCase.finalDisposition === "TERMINATE"
          ? ContractStatus.TERMINATED
          : ContractStatus.COMPLETED;
      await Promise.all([
        tx.subscriptionOrder.update({
          data: { orderStatus, updatedBy: actorId },
          where: { id: closureCase.orderId }
        }),
        tx.contract.update({
          data: { status: contractStatus, updatedBy: actorId },
          where: { id: closureCase.contractId }
        }),
        tx.subscriptionClosureCase.update({
          data: {
            closedAt: input.occurredAt,
            financialStatus: financial.financialStatus,
            operationalCompletedAt: input.occurredAt,
            status: targetStatus,
            updatedBy: actorId,
            version: { increment: 1 }
          },
          where: { id: closureCase.id }
        })
      ]);
      return {
        closureCaseId,
        financialStatus: financial.financialStatus,
        replayed: false,
        status: targetStatus
      };
    });
  }

  private async resolveEvidenceTarget(
    closureCaseId: string,
    targetType: "CHECKLIST_ITEM" | "DAMAGE" | "CASE_ATTESTATION" | "CUSTOMER_DISPUTE",
    targetId: string
  ) {
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      where: { id: closureCaseId }
    });
    if (!closureCase) throw new NotFoundException("Subscription closure case not found.");
    const workOrderId =
      closureCase.reconditioningAssetWorkOrderId ??
      closureCase.recoveryAssetWorkOrderId ??
      closureCase.returnAssetWorkOrderId;
    if (!workOrderId) throw conflict("RETURN_EVIDENCE_WORK_ORDER_REQUIRED", "退车工单不存在。");
    if (targetType === "CHECKLIST_ITEM") {
      const item = await this.prisma.vehicleReturnChecklistItem.findUnique({
        include: { revision: true },
        where: { id: targetId }
      });
      if (!item || item.revision.closureCaseId !== closureCase.id) {
        throw conflict("RETURN_EVIDENCE_TARGET_MISMATCH", "清单项不属于当前退车流程。");
      }
    } else if (targetType === "DAMAGE") {
      const damage = await this.prisma.vehicleReturnDamage.findUnique({ where: { id: targetId } });
      if (!damage || damage.returnId !== closureCase.vehicleReturnId) {
        throw conflict("RETURN_EVIDENCE_TARGET_MISMATCH", "损伤记录不属于当前退车流程。");
      }
    } else if (targetType === "CUSTOMER_DISPUTE") {
      const chargeLine = await this.prisma.subscriptionClosureChargeLine.findUnique({
        where: { id: targetId }
      });
      if (
        !chargeLine ||
        chargeLine.closureCaseId !== closureCase.id ||
        chargeLine.status !== "FINAL"
      ) {
        throw conflict("RETURN_EVIDENCE_TARGET_MISMATCH", "争议证明必须绑定当前退车正式收费项。");
      }
    } else if (targetId !== closureCase.id) {
      throw conflict("RETURN_EVIDENCE_TARGET_MISMATCH", "见证证据必须绑定当前退车流程。");
    }
    return { closureCase, workOrderId };
  }

  private projectEvidenceLink(
    link: Readonly<Record<string, unknown>>,
    evidence: Readonly<Record<string, unknown>>,
    replayed: boolean
  ) {
    return {
      capturedAt: evidence.capturedAt,
      contentSha256: evidence.contentSha256,
      evidenceId: evidence.id,
      evidenceType: evidence.evidenceType,
      linkId: link.id,
      replayed,
      visibility: link.visibility
    };
  }
}

function deliveryConditionFacts(
  workOrder: Readonly<{
    accessoryItems: Prisma.JsonValue | null;
    handoverFactSnapshot: Prisma.JsonValue | null;
    handoverMileageKm: number | null;
    keyState: string | null;
    primaryKeyCount: number | null;
    registrationDocumentState: string | null;
    spareKeyCount: number | null;
    vehicleConditionConfirmed: boolean | null;
  }>
) {
  const snapshot = asRecord(workOrder.handoverFactSnapshot);
  const rawAccessories = Array.isArray(snapshot.accessoryItems)
    ? snapshot.accessoryItems
    : Array.isArray(workOrder.accessoryItems)
      ? workOrder.accessoryItems
      : [];
  const accessories = rawAccessories.map(asRecord);
  const chargingAccessories = accessories.filter((item) =>
    `${String(item.code ?? "")} ${String(item.name ?? "")}`.match(/CHARG|充电/i)
  );
  const accessoryState = conditionState(accessories.map((item) => String(item.state ?? "")));
  const chargingState = conditionState(chargingAccessories.map((item) => String(item.state ?? "")));
  const primaryKeyCount = integerFact(snapshot.primaryKeyCount, workOrder.primaryKeyCount);
  const spareKeyCount = integerFact(snapshot.spareKeyCount, workOrder.spareKeyCount);
  const keyState = String(snapshot.keyState ?? workOrder.keyState ?? "MISSING");
  const registrationState = String(
    snapshot.registrationDocumentState ?? workOrder.registrationDocumentState ?? "NOT_AVAILABLE"
  );
  return [
    {
      itemCode: "ACCESSORIES",
      quantity: sumAccessoryQuantity(accessories),
      state: accessoryState
    },
    { itemCode: "BATTERY", quantity: 1, state: "NORMAL" },
    {
      itemCode: "CHARGING_EQUIPMENT",
      quantity: sumAccessoryQuantity(chargingAccessories),
      state: chargingState
    },
    { itemCode: "CUSTOMER_ITEMS", quantity: 0, state: "NOT_APPLICABLE" },
    {
      itemCode: "KEY",
      quantity: primaryKeyCount + spareKeyCount,
      state: keyState === "DAMAGED" ? "DAMAGED" : keyState === "MISSING" ? "MISSING" : "NORMAL"
    },
    { itemCode: "MILEAGE", quantity: workOrder.handoverMileageKm ?? 0, state: "NORMAL" },
    {
      itemCode: "REGISTRATION_CERTIFICATE",
      quantity: registrationState === "HANDED_OVER" ? 1 : 0,
      state:
        registrationState === "DAMAGED"
          ? "DAMAGED"
          : registrationState === "HANDED_OVER"
            ? "NORMAL"
            : "MISSING"
    },
    {
      itemCode: "VEHICLE_EXTERIOR",
      quantity: 1,
      state: workOrder.vehicleConditionConfirmed ? "NORMAL" : "PENDING_VERIFICATION"
    },
    {
      itemCode: "VEHICLE_INTERIOR",
      quantity: 1,
      state: workOrder.vehicleConditionConfirmed ? "NORMAL" : "PENDING_VERIFICATION"
    }
  ];
}

function integerFact(preferred: unknown, fallback: number | null) {
  return typeof preferred === "number" && Number.isSafeInteger(preferred) && preferred >= 0
    ? preferred
    : (fallback ?? 0);
}

function sumAccessoryQuantity(items: readonly Record<string, unknown>[]) {
  return items.reduce(
    (sum, item) =>
      sum +
      (typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity > 0
        ? item.quantity
        : 0),
    0
  );
}

function conditionState(states: readonly string[]) {
  if (states.some((state) => state === "DAMAGED")) return "DAMAGED";
  if (states.some((state) => state === "MISSING")) return "MISSING";
  return states.length > 0 ? "NORMAL" : "NOT_APPLICABLE";
}

async function resolveClosureApprovalAuthority(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  input: Readonly<{
    approvalType: "PRICING_OVERRIDE" | "WAIVER" | "WRITE_OFF" | "REGISTRATION_DOCUMENT_MISSING";
    billId?: string;
    checklistItemId?: string;
    clauseSnapshotId?: string;
    deltaItemId?: string;
    evidenceIds: readonly string[];
    manualBasis?: string;
    manualUnitPriceCents?: string;
    settlementRevisionId?: string;
  }>
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "subscription_closure_case" WHERE "id" = ${closureCaseId}::uuid FOR UPDATE`
  );
  const closureCase = await tx.subscriptionClosureCase.findUnique({
    where: { id: closureCaseId }
  });
  if (
    !closureCase ||
    closureCase.retiredAt ||
    (input.settlementRevisionId !== undefined &&
      closureCase.currentSettlementRevisionId !== input.settlementRevisionId)
  ) {
    throw conflict("CLOSURE_APPROVAL_STALE", "审批必须绑定当前退车结算版本。");
  }
  if (input.settlementRevisionId) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "subscription_closure_settlement_revision" WHERE "id" = ${input.settlementRevisionId}::uuid FOR UPDATE`
    );
  }
  const settlement = input.settlementRevisionId
    ? await tx.subscriptionClosureSettlementRevision.findUnique({
        where: { id: input.settlementRevisionId }
      })
    : null;
  if (input.settlementRevisionId && (!settlement || settlement.closureCaseId !== closureCase.id)) {
    throw conflict("CLOSURE_APPROVAL_STALE", "审批结算版本不属于当前退车闭环。");
  }
  const evidenceIds = [...new Set(input.evidenceIds)].sort();
  if (evidenceIds.length === 0) {
    throw badRequest("CLOSURE_APPROVAL_EVIDENCE_REQUIRED", "例外审批必须绑定至少一项受管证据。");
  }

  if (input.approvalType === "REGISTRATION_DOCUMENT_MISSING") {
    if (!input.checklistItemId || !closureCase.currentChecklistRevisionId) {
      throw badRequest(
        "CLOSURE_REGISTRATION_APPROVAL_INPUT_INVALID",
        "行驶证缺失审批必须绑定当前退车清单中的行驶证确认项。"
      );
    }
    const [checklist, checklistItem, evidenceCount] = await Promise.all([
      tx.vehicleReturnChecklistRevision.findUnique({
        where: { id: closureCase.currentChecklistRevisionId }
      }),
      tx.vehicleReturnChecklistItem.findUnique({ where: { id: input.checklistItemId } }),
      tx.vehicleReturnEvidenceLink.count({
        where: {
          checklistItemId: input.checklistItemId,
          closureCaseId,
          evidenceId: { in: evidenceIds }
        }
      })
    ]);
    if (
      !checklist ||
      !checklistItem ||
      checklistItem.revisionId !== checklist.id ||
      checklistItem.itemCode !== "REGISTRATION_CERTIFICATE" ||
      !["MISSING", "DAMAGED", "PENDING_VERIFICATION"].includes(checklistItem.state) ||
      evidenceCount !== evidenceIds.length
    ) {
      throw conflict(
        "CLOSURE_REGISTRATION_APPROVAL_AUTHORITY_MISMATCH",
        "行驶证缺失审批与当前清单状态或受管证据不一致。"
      );
    }
    return {
      exceptionType: "VEHICLE_REGISTRATION_DOCUMENT_MISSING" as const,
      snapshot: {
        approvalType: input.approvalType,
        amountCents: null,
        billId: null,
        checklistItemId: checklistItem.id,
        checklistItemState: checklistItem.state,
        checklistManifestHash: checklist.manifestHash,
        checklistRevisionId: checklist.id,
        clauseSnapshotId: null,
        closureCaseId,
        deltaItemId: null,
        evidenceIds,
        manualBasis: null,
        manualUnitPriceCents: null,
        settlementResultHash: null,
        settlementRevisionId: null
      },
      subjectField: `returnRegistrationDocument:${checklistItem.id}`
    };
  }

  if (input.approvalType === "PRICING_OVERRIDE") {
    const manualBasis = input.manualBasis?.trim();
    const manualUnitPriceCents = input.manualUnitPriceCents;
    if (
      settlement?.stage !== "PROPOSED" ||
      !input.clauseSnapshotId ||
      !input.deltaItemId ||
      !manualBasis ||
      !manualUnitPriceCents ||
      !/^(?:0|[1-9]\d*)$/.test(manualUnitPriceCents)
    ) {
      throw badRequest(
        "CLOSURE_PRICING_APPROVAL_INPUT_INVALID",
        "人工定价审批必须绑定当前草案、差异项、人工审查条款、价格、依据和证据。"
      );
    }
    const [clause, deltaItem, evidenceCount] = await Promise.all([
      tx.contractChargeClauseSnapshot.findUnique({ where: { id: input.clauseSnapshotId } }),
      tx.vehicleConditionDeltaItem.findUnique({ where: { id: input.deltaItemId } }),
      tx.vehicleReturnEvidenceLink.count({
        where: { closureCaseId, evidenceId: { in: evidenceIds } }
      })
    ]);
    if (
      !clause ||
      clause.contractId !== closureCase.contractId ||
      clause.status !== "MANUAL_CLAUSE_REVIEW_REQUIRED" ||
      !deltaItem ||
      deltaItem.revisionId !== closureCase.currentDeltaRevisionId ||
      evidenceCount !== evidenceIds.length
    ) {
      throw conflict(
        "CLOSURE_PRICING_APPROVAL_AUTHORITY_MISMATCH",
        "人工定价审批材料与当前合同条款、差异或证据不一致。"
      );
    }
    return {
      exceptionType: "SETTLEMENT_PRICING_EXCEPTION" as const,
      snapshot: {
        approvalType: input.approvalType,
        amountCents: manualUnitPriceCents,
        billId: null,
        clauseSnapshotId: clause.id,
        closureCaseId,
        deltaItemId: deltaItem.id,
        evidenceIds,
        manualBasis,
        manualUnitPriceCents,
        settlementResultHash: settlement.resultHash,
        settlementRevisionId: settlement.id
      },
      subjectField: `pricingOverride:${deltaItem.id}`
    };
  }

  if (!input.billId || !settlement || !["FINALIZED", "SETTLED"].includes(settlement.stage)) {
    throw badRequest(
      "CLOSURE_FINANCIAL_APPROVAL_INPUT_INVALID",
      "减免或核销审批必须绑定当前已发布结算版本和未清账单。"
    );
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" = ${input.billId}::uuid FOR UPDATE`
  );
  const bill = await tx.receivableBill.findUnique({ where: { id: input.billId } });
  const [linkedEvidence, financialProofs] = await Promise.all([
    tx.vehicleReturnEvidenceLink.count({
      where: { closureCaseId, evidenceId: { in: evidenceIds } }
    }),
    tx.fileObject.count({
      where: {
        id: { in: evidenceIds },
        objectKey: { startsWith: `subscription-closure/${closureCaseId}/financial-proof/` }
      }
    })
  ]);
  if (
    !bill ||
    bill.orderId !== closureCase.orderId ||
    bill.remainingAmount <= 0n ||
    linkedEvidence + financialProofs < evidenceIds.length
  ) {
    throw conflict(
      "CLOSURE_FINANCIAL_APPROVAL_AUTHORITY_MISMATCH",
      "减免或核销审批材料与当前未清账单或受管证据不一致。"
    );
  }
  const isWaiver = input.approvalType === "WAIVER";
  return {
    exceptionType: isWaiver ? ("SETTLEMENT_WAIVER" as const) : ("SETTLEMENT_WRITE_OFF" as const),
    snapshot: {
      approvalType: input.approvalType,
      amountCents: bill.remainingAmount.toString(),
      billId: bill.id,
      clauseSnapshotId: null,
      closureCaseId,
      deltaItemId: null,
      evidenceIds,
      manualBasis: null,
      manualUnitPriceCents: null,
      settlementResultHash: settlement.resultHash,
      settlementRevisionId: settlement.id
    },
    subjectField: `${isWaiver ? "settlementWaiver" : "settlementWriteOff"}:${bill.id}`
  };
}

async function requireCurrentPricingApproval(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  settlementRevisionId: string,
  line: Readonly<{
    clauseSnapshotId: string | null;
    deltaItemId: string | null;
    evidenceIds: readonly string[];
    exceptionApprovalId: string | null;
    manualBasis?: string | null;
    manualUnitPriceCents?: string | null;
  }>
) {
  if (
    !line.exceptionApprovalId ||
    !line.clauseSnapshotId ||
    !line.deltaItemId ||
    !line.manualBasis ||
    !line.manualUnitPriceCents
  ) {
    throw conflict("CLOSURE_PRICING_APPROVAL_REQUIRED", "人工定价正式出账前必须完成独立例外审批。");
  }
  const authority = await resolveClosureApprovalAuthority(tx, closureCaseId, {
    approvalType: "PRICING_OVERRIDE",
    clauseSnapshotId: line.clauseSnapshotId,
    deltaItemId: line.deltaItemId,
    evidenceIds: line.evidenceIds,
    manualBasis: line.manualBasis,
    manualUnitPriceCents: line.manualUnitPriceCents,
    settlementRevisionId
  });
  const approval = await tx.businessExceptionApproval.findUnique({
    where: { id: line.exceptionApprovalId }
  });
  if (
    !approval ||
    approval.status !== "APPROVED" ||
    approval.decision !== "APPROVED" ||
    approval.expiredAt ||
    approval.exceptionType !== authority.exceptionType ||
    approval.subjectType !== "SETTLEMENT_CASE" ||
    approval.subjectId !== closureCaseId ||
    approval.subjectField !== authority.subjectField ||
    canonicalSubscriptionClosureJson(approval.subjectSnapshot as never) !==
      canonicalSubscriptionClosureJson(authority.snapshot as never)
  ) {
    throw conflict(
      "CLOSURE_PRICING_APPROVAL_REQUIRED",
      "人工定价审批未通过、已失效或与当前价格事实不一致。"
    );
  }
  return approval.id;
}

function approvalTypeForException(exceptionType: string) {
  if (exceptionType === "VEHICLE_REGISTRATION_DOCUMENT_MISSING") {
    return "REGISTRATION_DOCUMENT_MISSING" as const;
  }
  if (exceptionType === "SETTLEMENT_PRICING_EXCEPTION") return "PRICING_OVERRIDE" as const;
  if (exceptionType === "SETTLEMENT_WAIVER") return "WAIVER" as const;
  if (exceptionType === "SETTLEMENT_WRITE_OFF") return "WRITE_OFF" as const;
  throw conflict("CLOSURE_APPROVAL_TYPE_INVALID", "该审批不属于退车定价或财务处置。");
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredSnapshotString(value: unknown) {
  const result = stringOrUndefined(value);
  if (!result) throw conflict("CLOSURE_APPROVAL_STALE", "审批权威快照不完整。");
  return result;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function normalizeChecklistItems(
  items: readonly Readonly<{
    expectedQuantity?: number | null;
    itemCode: string;
    remark?: string | null;
    returnedQuantity?: number | null;
    state: "NORMAL" | "MISSING" | "DAMAGED" | "NOT_APPLICABLE" | "PENDING_VERIFICATION";
  }>[]
) {
  const normalized = items
    .map((item) => ({
      expectedQuantity: item.expectedQuantity ?? null,
      itemCode: requiredText(item.itemCode, "itemCode", 64).toUpperCase(),
      remark: item.remark?.trim() || null,
      returnedQuantity: item.returnedQuantity ?? null,
      state: item.state
    }))
    .sort((left, right) => Buffer.from(left.itemCode).compare(Buffer.from(right.itemCode)));
  if (new Set(normalized.map(({ itemCode }) => itemCode)).size !== normalized.length) {
    throw badRequest("RETURN_CHECKLIST_DUPLICATE_ITEM", "退车清单确认项不可重复。");
  }
  const codes = new Set(normalized.map(({ itemCode }) => itemCode));
  if (REQUIRED_ITEM_CODES.some((code) => !codes.has(code))) {
    throw badRequest(
      "RETURN_CHECKLIST_REQUIRED_ITEM_MISSING",
      `退车清单必须包含：${REQUIRED_ITEM_CODES.join("、")}。`
    );
  }
  return normalized;
}

function validateEvidenceFile(file: ReturnEvidenceUpload | undefined) {
  if (!file?.buffer?.length || file.size <= 0 || file.size > MAX_EVIDENCE_BYTES) {
    throw badRequest("RETURN_EVIDENCE_FILE_REQUIRED", "请选择不超过 20MB 的证据文件。");
  }
  const detected = detectMimeType(file.buffer);
  if (!detected || detected !== file.mimetype) {
    throw badRequest(
      "RETURN_EVIDENCE_FILE_INVALID",
      "仅支持真实的 JPEG、PNG、WebP、PDF 或 MP4 文件。"
    );
  }
  return detected;
}

function detectMimeType(buffer: Buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return null;
}

async function lockBillsAndAssertNoActivePaymentOrders(
  tx: Prisma.TransactionClient,
  billIds: readonly string[],
  code: string
) {
  const sortedBillIds = [...new Set(billIds)].sort();
  if (sortedBillIds.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "receivable_bill" WHERE "id" IN (${Prisma.join(
      sortedBillIds.map((id) => Prisma.sql`${id}::uuid`)
    )}) ORDER BY "id" FOR UPDATE`
  );
  await assertNoActivePaymentOrders(tx, sortedBillIds, code);
}

async function assertNoActivePaymentOrders(
  tx: Prisma.TransactionClient,
  billIds: readonly string[],
  code: string
) {
  if (billIds.length === 0) return;
  const activePayment = await tx.paymentOrderItem.findFirst({
    select: { id: true },
    where: {
      billId: { in: [...billIds] },
      deletedAt: null,
      paymentOrder: {
        deletedAt: null,
        paymentStatus: { in: ["CREATED", "PENDING"] }
      }
    }
  });
  if (activePayment) {
    throw conflict(code, "该应收仍有客户主动支付单，请关闭支付单后重试。");
  }
}

async function latestCustomerResponse(tx: Prisma.TransactionClient, closureCaseId: string) {
  const responses = await tx.subscriptionClosureCustomerResponse.findMany({
    orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
    where: { closureCaseId }
  });
  const superseded = new Set(
    responses
      .map(({ supersedesResponseId }) => supersedesResponseId)
      .filter((id): id is string => Boolean(id))
  );
  return responses.find(({ id }) => !superseded.has(id)) ?? null;
}

async function latestDisposition(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  billId: string
) {
  const dispositions = await tx.subscriptionClosureReceivableDisposition.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    where: { billId, closureCaseId }
  });
  const superseded = new Set(
    dispositions
      .map(({ supersedesDispositionId }) => supersedesDispositionId)
      .filter((id): id is string => Boolean(id))
  );
  return dispositions.find(({ id }) => !superseded.has(id)) ?? null;
}

async function deriveFinancialFromDatabase(
  tx: Prisma.TransactionClient,
  closureCaseId: string,
  orderId: string
) {
  const [bills, dispositions] = await Promise.all([
    tx.receivableBill.findMany({ where: { deletedAt: null, orderId } }),
    tx.subscriptionClosureReceivableDisposition.findMany({ where: { closureCaseId } })
  ]);
  const superseded = new Set(
    dispositions
      .map(({ supersedesDispositionId }) => supersedesDispositionId)
      .filter((id): id is string => Boolean(id))
  );
  const currentByBill = new Map(
    dispositions.filter(({ id }) => !superseded.has(id)).map((item) => [item.billId, item])
  );
  return deriveClosureFinancialState(
    bills.map((bill) => {
      const current = currentByBill.get(bill.id);
      return {
        billId: bill.id,
        disposition: (current?.disposition ??
          (bill.remainingAmount === 0n ? "PAID" : "OPEN")) as ClosureReceivableFact["disposition"],
        ownerId: current ? (current.ownerId ?? current.ownerType) : null,
        paidAmountCents: bill.paidAmount,
        remainingAmountCents: bill.remainingAmount
      };
    })
  );
}

function projectChecklist(
  revision: Readonly<Record<string, unknown>> & { items?: readonly unknown[] },
  replayed: boolean
) {
  return {
    attestationMode: revision.attestationMode,
    capturedAt: revision.capturedAt,
    items: revision.items ?? [],
    manifestHash: revision.manifestHash,
    replayed,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber
  };
}

function returnManifestTaskCancellationSnapshot(taskValue: unknown) {
  const task = asRecord(taskValue);
  const timestamp = (value: unknown) =>
    value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    cancelledAt: timestamp(task.cancelledAt),
    completedAt: timestamp(task.completedAt),
    deletedAt: timestamp(task.deletedAt),
    errorSnapshot: JSON.parse(JSON.stringify(task.errorSnapshot ?? null)) as Prisma.InputJsonValue,
    id: text(task.id),
    signUrlExpiresAt: timestamp(task.signUrlExpiresAt),
    sourceId: text(task.sourceId),
    sourceKey: text(task.sourceKey),
    sourceType: text(task.sourceType),
    taskStatus: text(task.taskStatus),
    updatedAt: timestamp(task.updatedAt),
    updatedBy: text(task.updatedBy)
  } satisfies Prisma.InputJsonObject;
}

function requiredText(value: string, field: string, max: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw badRequest("RETURN_INPUT_INVALID", `${field} 无效。`);
  }
  return normalized;
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function badRequest(code: string, message: string) {
  return new BadRequestException({ code, message });
}

export function assertLegalCollectionTransferReady(
  input: Readonly<{
    disposition: Readonly<{
      disposition: string;
      id: string;
      ownerId: string | null;
      ownerType: string;
    }> | null;
    hasBlockingDispute: boolean;
    response: Readonly<{
      settlementHash: string;
      settlementRevisionId: string;
      status: string;
    }> | null;
    settlement: Readonly<{
      id: string;
      resultHash: string;
      stage: string;
    }> | null;
    transferOwnerId: string;
    transferOwnerType: string;
  }>
) {
  if (!input.settlement || input.settlement.stage !== "FINALIZED") {
    throw conflict("CLOSURE_LEGAL_FINAL_SETTLEMENT_REQUIRED", "仅已发布的最终结算可转法催。");
  }
  if (
    !input.response ||
    input.response.status === "PENDING" ||
    input.response.settlementRevisionId !== input.settlement.id ||
    input.response.settlementHash !== input.settlement.resultHash
  ) {
    throw conflict(
      "CLOSURE_LEGAL_CUSTOMER_RESPONSE_REQUIRED",
      "转法催前必须形成与当前最终结算一致的客户响应或受管未响应事实。"
    );
  }
  if (input.hasBlockingDispute) {
    throw conflict(
      "CLOSURE_LEGAL_DISPUTE_BLOCKED",
      "目标应收存在未决或已接受的客户争议，不得转法催。"
    );
  }
  if (
    !input.disposition ||
    input.disposition.disposition !== "COLLECTION_PENDING" ||
    !input.disposition.ownerType.trim() ||
    !input.disposition.ownerId?.trim()
  ) {
    throw conflict(
      "CLOSURE_LEGAL_COLLECTION_DISPOSITION_REQUIRED",
      "转法催前必须先形成当前、未被替代且责任人明确的待催收归口。"
    );
  }
  if (
    input.disposition.ownerId !== input.transferOwnerId ||
    input.disposition.ownerType !== input.transferOwnerType
  ) {
    throw conflict(
      "CLOSURE_LEGAL_OWNER_MISMATCH",
      "法催移交负责人必须与已导出证据包中的当前催收归口一致；如需改派，请先新增归口并重新导出证据包。"
    );
  }
}

export function hasBlockingLegalCollectionDispute(
  disputes: readonly Readonly<{
    decision?: Readonly<{ decision: string }> | null;
    status: string;
  }>[]
) {
  return disputes.some(
    (dispute) =>
      (dispute.status === "OPEN" && !dispute.decision) ||
      dispute.decision?.decision === "ACCEPTED_BY_PLATFORM"
  );
}

function conflict(code: string, message: string) {
  return new ConflictException({ code, message });
}
