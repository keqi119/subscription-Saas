import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AuditAction,
  ESignDocumentType,
  ESignProviderType,
  ESignSignerStatus,
  ESignSignerType,
  ESignSigningStage,
  ESignSlotId,
  ESignTaskStatus,
  Prisma
} from "@prisma/client";
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import {
  canonicalSubscriptionClosureJson,
  hashSubscriptionClosureSnapshot
} from "../subscription-closure/subscription-closure.domain";
import {
  SubscriptionClosureRepository,
  subscriptionClosureDocumentAuthorityRequirement,
  type AppendSubscriptionClosureDocumentCommand,
  type SubscriptionClosureAuthorityLock,
  type SubscriptionClosureMutationAuditHook
} from "../subscription-closure/subscription-closure.repository";
import { validateExactReturnManifestSuccessorChain } from "../subscription-closure/subscription-closure.service";
import type { SubscriptionClosureSource } from "../subscription-closure/subscription-closure.types";
import { extractReturnManifestPdfFacts } from "../subscription-closure/subscription-return-manifest-model";
import {
  ESIGN_PROVIDER_CLIENT,
  type ESignProvider,
  type ReturnManifestProviderTaskInput,
  type ReturnManifestProviderTaskResult,
  type VerifyCallbackResult
} from "./esign.provider";
import { loadFadadaConfig, selectedESignProvider } from "./fadada/fadada.config";

export type ReturnManifestESignInput = Readonly<{
  actorId: string;
  closureCaseId: string;
  idempotencyKey: string;
}>;

export type ReturnManifestESignStart = Readonly<{
  signUrl: string | null;
  taskId: string;
  wrote: boolean;
}>;

export type ReturnManifestESignFinalization = Readonly<{
  archivedRevisionId: string;
  signedFileHash: string;
  signedFileId: string;
  signedRevisionId: string;
  taskId: string;
  wrote: boolean;
}>;

export type ReturnManifestVerifiedCallback = Readonly<{
  eventType: string | null;
  payload: unknown;
  provider: ESignProviderType;
  providerContractId: string | null;
  providerTaskId: string | null;
  resultCode: string | null;
  verification: VerifyCallbackResult;
}>;

type ResolvedManifestAuthority = Awaited<ReturnType<typeof resolveManifestAuthority>>;

const CONTRACT_PDF_CJK_FONT_PATH_ENV = "CONTRACT_PDF_CJK_FONT_PATH";

@Injectable()
export class ReturnManifestESignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: SubscriptionClosureRepository,
    private readonly auditService: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    @Inject(ESIGN_PROVIDER_CLIENT) private readonly provider: ESignProvider
  ) {}

  async getPortalSigning(closureCaseId: string, customerId: string) {
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      select: { customerId: true },
      where: { id: closureCaseId }
    });
    if (!closureCase || closureCase.customerId !== customerId) {
      throw new NotFoundException("Return manifest signing task not found.");
    }
    const task = await this.prisma.contractESignTask.findFirst({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        provider: true,
        signUrl: true,
        signUrlExpiresAt: true,
        taskStatus: true
      },
      where: {
        customerId,
        deletedAt: null,
        documentType: ESignDocumentType.RETURN_MANIFEST,
        signingStage: ESignSigningStage.STAGE6_RETURN_MANIFEST,
        sourceId: closureCaseId,
        sourceKey: { startsWith: "return-manifest-esign" },
        sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
      }
    });
    return task
      ? Object.freeze({
          expiresAt: task.signUrlExpiresAt,
          mock: task.provider === ESignProviderType.MOCK,
          provider: task.provider,
          signUrl: task.signUrl,
          taskId: task.id,
          taskStatus: task.taskStatus
        })
      : null;
  }

  async mockSignForPortal(closureCaseId: string, taskId: string, customerId: string) {
    if (
      this.providerType() !== ESignProviderType.MOCK ||
      this.config.get<string>("ESIGN_MOCK_ENABLED") !== "true"
    ) {
      throw new ForbiddenException("当前环境未开启 Mock 退车清单电子签署。");
    }
    const signing = await this.getPortalSigning(closureCaseId, customerId);
    if (!signing || signing.taskId !== taskId) {
      throw new NotFoundException("Return manifest signing task not found.");
    }
    if (signing.taskStatus === ESignTaskStatus.COMPLETED) {
      return Object.freeze({ taskId, taskStatus: signing.taskStatus, wrote: false });
    }
    if (!signing.signUrl) {
      throw new BadRequestException("退车清单电子签署链接尚未就绪。");
    }
    const task = await this.prisma.contractESignTask.findUnique({
      select: { providerTaskId: true },
      where: { id: taskId }
    });
    if (!task?.providerTaskId) throw sourceConflict();
    const payload = {
      eventType: "RETURN_MANIFEST_SIGN_COMPLETED",
      providerTaskId: task.providerTaskId,
      taskId
    };
    const result = await this.handleVerifiedCallback({
      eventType: payload.eventType,
      payload,
      provider: ESignProviderType.MOCK,
      providerContractId: null,
      providerTaskId: task.providerTaskId,
      resultCode: "SUCCESS",
      verification: {
        eventType: payload.eventType,
        payload,
        providerTaskId: task.providerTaskId,
        resultCode: "SUCCESS",
        verified: true
      }
    });
    return Object.freeze({ ...result, taskStatus: ESignTaskStatus.COMPLETED });
  }

  async reconcile(input: ReturnManifestESignInput) {
    const closureCase = await this.prisma.subscriptionClosureCase.findUnique({
      select: { currentChecklistRevisionId: true, orderId: true },
      where: { id: input.closureCaseId }
    });
    if (
      this.config.get<string>("SUBSCRIPTION_RETURN_THREE_STAGE_ENABLED") === "true" ||
      Boolean(closureCase?.currentChecklistRevisionId)
    ) {
      if (!closureCase?.currentChecklistRevisionId) {
        return Object.freeze({
          action: "WAITING_RETURN_CHECKLIST",
          reason: "退车清单尚未完成。",
          wrote: false
        });
      }
      const checklist = await this.prisma.vehicleReturnChecklistRevision.findUnique({
        include: { items: true },
        where: { id: closureCase.currentChecklistRevisionId }
      });
      if (!checklist) throw sourceConflict();
      const currentAttemptJob = await this.prisma.subscriptionAutomationJob.findFirst({
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        where: {
          jobType: "CLOSURE_RETURN_MANIFEST_ESIGN",
          orderId: closureCase.orderId,
          payload: { path: ["checklistRevisionId"], equals: checklist.id }
        }
      });
      const currentAttemptKey = stringValue(objectValue(currentAttemptJob?.payload).idempotencyKey);
      if (currentAttemptKey && currentAttemptKey !== input.idempotencyKey) {
        return Object.freeze({
          action: "SUPERSEDED_RETURN_MANIFEST_ESIGN_ATTEMPT",
          checklistRevisionId: checklist.id,
          wrote: false
        });
      }
      const evidenceLinks = await this.prisma.vehicleReturnEvidenceLink.findMany({
        where: {
          closureCaseId: input.closureCaseId,
          evidenceId: { not: null },
          visibility: "CUSTOMER_VISIBLE"
        }
      });
      const registrationItem = checklist.items.find(
        (item) => item.itemCode === "REGISTRATION_CERTIFICATE"
      );
      const registrationApproval = registrationItem
        ? await this.prisma.businessExceptionApproval.findFirst({
            orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
            where: {
              decision: "APPROVED",
              exceptionType: "VEHICLE_REGISTRATION_DOCUMENT_MISSING",
              expiredAt: null,
              status: "APPROVED",
              subjectField: `returnRegistrationDocument:${registrationItem.id}`,
              subjectId: input.closureCaseId,
              subjectType: "SETTLEMENT_CASE"
            }
          })
        : null;
      const approvedRegistrationExceptionItemIds = new Set<string>();
      if (
        registrationItem &&
        registrationApproval &&
        isCurrentRegistrationDocumentApproval({
          approval: registrationApproval,
          checklist,
          closureCaseId: input.closureCaseId,
          evidenceLinks,
          registrationItem
        })
      ) {
        approvedRegistrationExceptionItemIds.add(registrationItem.id);
      }
      const missingEvidenceCodes = returnManifestMissingEvidenceCodes(
        checklist.items,
        evidenceLinks,
        approvedRegistrationExceptionItemIds
      );
      if (missingEvidenceCodes.length > 0) {
        return Object.freeze({
          action: "WAITING_RETURN_EVIDENCE",
          missingEvidenceCodes,
          wrote: false
        });
      }
      if (checklist.attestationMode !== "CUSTOMER_SIGNED") {
        return this.sealUnilateralAttestation(input);
      }
    }
    const started = await this.start(input);
    const task = await this.prisma.contractESignTask.findUnique({
      select: { taskStatus: true },
      where: { id: started.taskId }
    });
    if (task?.taskStatus !== ESignTaskStatus.COMPLETED) return started;
    return this.finalize(input);
  }

  private async sealUnilateralAttestation(input: ReturnManifestESignInput) {
    const authority = await this.prisma.subscriptionClosureCase.findUnique({
      include: {
        currentChecklistRevision: { include: { items: { orderBy: { itemCode: "asc" } } } }
      },
      where: { id: input.closureCaseId }
    });
    const checklist = authority?.currentChecklistRevision;
    if (
      !authority?.returnAssetWorkOrderId ||
      !checklist ||
      checklist.attestationMode === "CUSTOMER_SIGNED"
    ) {
      throw sourceConflict();
    }
    const returnAssetWorkOrderId = authority.returnAssetWorkOrderId;
    const source = {
      id: authority.id,
      key: `unilateral-attestation:${checklist.id}`,
      type: "SUBSCRIPTION_CLOSURE_RETURN"
    };
    const existing = await this.prisma.vehicleReturnEvidenceLink.findUnique({
      include: { evidence: true },
      where: {
        sourceType_sourceId_sourceKey: {
          sourceId: source.id,
          sourceKey: source.key,
          sourceType: source.type
        }
      }
    });
    if (existing?.evidence) {
      return Object.freeze({
        action: "UNILATERAL_ATTESTATION_SEALED",
        checklistRevisionId: checklist.id,
        evidenceId: existing.evidence.id,
        evidenceLinkId: existing.id,
        wrote: false
      });
    }
    const snapshot = {
      attestationMode: checklist.attestationMode,
      attestationSnapshot: checklist.attestationSnapshot,
      capturedAt: checklist.capturedAt.toISOString(),
      checklistItems: checklist.items.map((item) => ({
        expectedQuantity: item.expectedQuantity,
        itemCode: item.itemCode,
        remark: item.remark,
        returnedQuantity: item.returnedQuantity,
        state: item.state
      })),
      checklistManifestHash: checklist.manifestHash,
      checklistRevisionId: checklist.id,
      checklistRevisionNumber: checklist.revisionNumber,
      closureCaseId: authority.id,
      sealType: "PLATFORM_UNILATERAL_RETURN_ATTESTATION",
      sealVersion: 1
    };
    const snapshotHash = sha256(
      Buffer.from(canonicalSubscriptionClosureJson(snapshot as never), "utf8")
    );
    const pdf = await renderUnilateralAttestationPdf(
      snapshot,
      snapshotHash,
      checklist.capturedAt,
      this.config.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV)
    );
    const contentSha256 = sha256(pdf);
    const stableCommand = { ...input, idempotencyKey: checklist.id };
    const originalName = `${authority.caseNo}-return-unilateral-attestation-r${checklist.revisionNumber}.pdf`;
    const stored = await this.storage.putReturnManifestArtifact({
      buffer: pdf,
      closureCaseId: authority.id,
      contentType: "application/pdf",
      metadata: {
        checklistManifestHash: checklist.manifestHash,
        contentSha256,
        snapshotHash,
        type: "RETURN_UNILATERAL_ATTESTATION"
      },
      objectIdentity: stableId(stableCommand, "unilateral-attestation-pdf"),
      originalName
    });
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const replay = await tx.vehicleReturnEvidenceLink.findUnique({
          include: { evidence: true },
          where: {
            sourceType_sourceId_sourceKey: {
              sourceId: source.id,
              sourceKey: source.key,
              sourceType: source.type
            }
          }
        });
        if (replay?.evidence) return { evidence: replay.evidence, link: replay, wrote: false };
        const file =
          (await tx.fileObject.findFirst({
            where: { bucket: stored.bucket, objectKey: stored.objectKey }
          })) ??
          (await tx.fileObject.create({
            data: {
              bucket: stored.bucket,
              id: stableId(stableCommand, "unilateral-attestation-file"),
              mimeType: "application/pdf",
              objectKey: stored.objectKey,
              originalName,
              sizeBytes: BigInt(pdf.length),
              uploadedBy: input.actorId
            }
          }));
        if (
          file.mimeType !== "application/pdf" ||
          file.sizeBytes !== BigInt(pdf.length)
        ) {
          throw sourceConflict();
        }
        const evidence = await tx.assetWorkOrderEvidence.create({
          data: {
            action: "ATTACH",
            actorId: input.actorId,
            captureMetadata: {
              checklistManifestHash: checklist.manifestHash,
              platformSeal: true,
              snapshotHash
            },
            capturedAt: checklist.capturedAt,
            contentSha256,
            evidenceType: "DOCUMENT",
            fileBucket: stored.bucket,
            fileId: file.id,
            fileMimeType: "application/pdf",
            fileObjectKey: stored.objectKey,
            fileSizeBytes: BigInt(pdf.length),
            id: stableId(stableCommand, "unilateral-attestation-evidence"),
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type,
            workOrderId: returnAssetWorkOrderId
          }
        });
        const link = await tx.vehicleReturnEvidenceLink.create({
          data: {
            closureCaseId: authority.id,
            evidenceId: evidence.id,
            evidencePurpose: "UNILATERAL_ATTESTATION_SEAL",
            id: stableId(stableCommand, "unilateral-attestation-link"),
            recordedBy: input.actorId,
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type,
            visibility: "CUSTOMER_VISIBLE"
          }
        });
        return { evidence, link, wrote: true };
      });
      return Object.freeze({
        action: "UNILATERAL_ATTESTATION_SEALED",
        checklistRevisionId: checklist.id,
        evidenceId: created.evidence.id,
        evidenceLinkId: created.link.id,
        wrote: created.wrote
      });
    } catch (error) {
      const winner = await this.prisma.vehicleReturnEvidenceLink.findUnique({
        include: { evidence: true },
        where: {
          sourceType_sourceId_sourceKey: {
            sourceId: source.id,
            sourceKey: source.key,
            sourceType: source.type
          }
        }
      });
      if (winner?.evidence?.contentSha256 === contentSha256) {
        return Object.freeze({
          action: "UNILATERAL_ATTESTATION_SEALED",
          checklistRevisionId: checklist.id,
          evidenceId: winner.evidence.id,
          evidenceLinkId: winner.id,
          wrote: false
        });
      }
      throw error;
    }
  }

  async start(input: ReturnManifestESignInput): Promise<ReturnManifestESignStart> {
    const command = normalizeInput(input);
    const sources = returnManifestSources(command);
    const observed = await resolveManifestAuthority(this.prisma, command, sources);
    if (observed.task) {
      assertReservedAuthority(observed, command, sources, this.providerType());
      const artifacts = await this.ensureReservedArtifacts(command, observed);
      if (observed.task.providerTaskId) {
        assertStartedAuthority(observed, command, sources, this.providerType());
        return Object.freeze({
          signUrl: observed.task.signUrl,
          taskId: observed.task.id,
          wrote: false
        });
      }
      return this.startProviderTask(
        command,
        sources,
        observed,
        artifacts.providerPdf,
        artifacts.providerPdfHash
      );
    }

    const documentSnapshot = returnManifestSuccessorSnapshot(observed);
    const sourceBytes = Buffer.from(canonicalSubscriptionClosureJson(documentSnapshot), "utf8");
    const providerPdf = await renderReturnManifestPdf(
      documentSnapshot,
      observed.vehicleReturn.checklistSnapshot,
      observed.generated.generatedAt,
      this.config.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV)
    );
    const sourceFileHash = sha256(sourceBytes);
    const providerPdfHash = sha256(providerPdf);
    const sourceName = `${observed.closureCase.caseNo}-return-manifest-r2.json`;
    const providerName = `${observed.closureCase.caseNo}-return-manifest-r2-provider.pdf`;
    const storedSource = this.storage.resolveReturnManifestArtifactIdentity({
      closureCaseId: command.closureCaseId,
      objectIdentity: stableId(command, "source"),
      originalName: sourceName
    });
    const storedProvider = this.storage.resolveReturnManifestArtifactIdentity({
      closureCaseId: command.closureCaseId,
      objectIdentity: stableId(command, "provider-source"),
      originalName: providerName
    });

    const reservation = await this.prisma.$transaction(
      async (tx) => {
        await lockSources(this.repository, tx, sources);
        const current = await resolveManifestAuthority(tx, command, sources);
        if (current.task) {
          assertReservedAuthority(current, command, sources, this.providerType());
          return current;
        }
        const clock = await databaseClock(tx);
        await this.repository.lockAuthorityRows(tx, startLocks(current, command));
        const locked = await resolveManifestAuthority(tx, command, sources);
        if (locked.task) {
          assertReservedAuthority(locked, command, sources, this.providerType());
          return locked;
        }
        const activeTaskForCase = await tx.contractESignTask.findFirst({
          select: { id: true },
          where: {
            deletedAt: null,
            documentType: ESignDocumentType.RETURN_MANIFEST,
            signingStage: ESignSigningStage.STAGE6_RETURN_MANIFEST,
            sourceId: locked.closureCase.id,
            sourceType: sources.task.type
          }
        });
        if (activeTaskForCase) throw sourceConflict();
        if (
          !sameJson(returnManifestSuccessorSnapshot(locked), documentSnapshot) ||
          !sameJson(
            locked.vehicleReturn.checklistSnapshot ?? {},
            observed.vehicleReturn.checklistSnapshot ?? {}
          )
        ) {
          throw sourceConflict();
        }
        const sourceFileId = stableId(command, "source-file");
        const providerSourceFileId = stableId(command, "provider-source-file");
        const taskId = stableId(command, "task");
        const customerSignerId = stableId(command, "customer-signer");
        const platformSignerId = stableId(command, "platform-signer");
        const taskNo = createBusinessNo("ESG");
        const sourceFile = fileShape({
          bucket: storedSource.bucket,
          createdAt: clock,
          id: sourceFileId,
          mimeType: "application/json",
          objectKey: storedSource.objectKey,
          originalName: sourceName,
          sizeBytes: BigInt(sourceBytes.length),
          uploadedBy: command.actorId
        });
        const providerSourceFile = fileShape({
          bucket: storedProvider.bucket,
          createdAt: clock,
          id: providerSourceFileId,
          mimeType: "application/pdf",
          objectKey: storedProvider.objectKey,
          originalName: providerName,
          sizeBytes: BigInt(providerPdf.length),
          uploadedBy: command.actorId
        });
        await tx.fileObject.createMany({
          data: [fileCreate(sourceFile), fileCreate(providerSourceFile)]
        });
        await tx.contractESignTask.create({
          data: {
            contractId: locked.closureCase.contractId,
            createdAt: clock,
            createdBy: command.actorId,
            customerId: locked.closureCase.customerId,
            documentName: providerName,
            documentObjectKey: providerSourceFile.objectKey,
            documentType: ESignDocumentType.RETURN_MANIFEST,
            id: taskId,
            orderId: locked.closureCase.orderId,
            provider: this.providerType(),
            requestSnapshot: asJson(
              requestSnapshot({
                archivedSource: sources.archived,
                checklistSnapshot: observed.vehicleReturn.checklistSnapshot ?? {},
                documentSnapshot,
                generatedRevisionId: locked.generated.id,
                idempotencyKey: command.idempotencyKey,
                providerSourceFile,
                providerSourceFileHash: providerPdfHash,
                renderedAt: observed.generated.generatedAt,
                signedSource: sources.signed,
                sourceFile,
                sourceFileHash,
                taskSource: sources.task
              })
            ),
            signingStage: ESignSigningStage.STAGE6_RETURN_MANIFEST,
            sourceId: sources.task.id,
            sourceKey: sources.task.key,
            sourceType: sources.task.type,
            taskNo,
            taskStatus: ESignTaskStatus.CREATED,
            updatedAt: clock,
            updatedBy: command.actorId,
            signers: {
              create: [
                {
                  createdAt: clock,
                  customerId: locked.closureCase.customerId,
                  documentType: ESignDocumentType.RETURN_MANIFEST,
                  id: customerSignerId,
                  providerActionType: "CUSTOMER_MANUAL_SIGN",
                  required: true,
                  signerName: locked.customer.name,
                  signerPhone: locked.customer.mobile,
                  signerStatus: ESignSignerStatus.PENDING,
                  signerType: ESignSignerType.CUSTOMER,
                  slotId: ESignSlotId.RETURN_MANIFEST_CUSTOMER,
                  snapshot: asJson({
                    documentType: "RETURN_MANIFEST",
                    source: sources.task
                  }),
                  updatedAt: clock
                },
                {
                  createdAt: clock,
                  documentType: ESignDocumentType.RETURN_MANIFEST,
                  id: platformSignerId,
                  providerActionType: "PLATFORM_AUTO_SEAL",
                  required: true,
                  signerName: "Subscription platform",
                  signerStatus: ESignSignerStatus.PENDING,
                  signerType: ESignSignerType.PLATFORM,
                  slotId: ESignSlotId.RETURN_MANIFEST_PLATFORM,
                  snapshot: asJson({
                    documentType: "RETURN_MANIFEST",
                    source: sources.task
                  }),
                  updatedAt: clock
                }
              ]
            }
          }
        });
        const reservedTask = await tx.contractESignTask.findUniqueOrThrow({
          include: { signers: true },
          where: { id: taskId }
        });
        for (const audit of [
          {
            after: jsonFileShape(sourceFile),
            entityId: sourceFile.id,
            entityType: "file_object"
          },
          {
            after: jsonFileShape(providerSourceFile),
            entityId: providerSourceFile.id,
            entityType: "file_object"
          },
          {
            after: taskAuditSnapshot(reservedTask),
            entityId: reservedTask.id,
            entityType: "contract_esign_task"
          },
          ...reservedTask.signers.map((signer) => ({
            after: signerAuditSnapshot(signer),
            entityId: signer.id,
            entityType: "contract_esign_signer"
          }))
        ]) {
          await this.auditService.write(
            {
              action: AuditAction.CREATE,
              after: audit.after,
              createdAt: clock,
              entityId: audit.entityId,
              entityType: audit.entityType,
              module: "subscription_closure",
              operatorId: command.actorId
            },
            tx
          );
        }
        return resolveManifestAuthority(tx, command, sources);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );

    const artifacts = await this.ensureReservedArtifacts(command, reservation);
    return this.startProviderTask(
      command,
      sources,
      reservation,
      artifacts.providerPdf,
      artifacts.providerPdfHash
    );
  }

  async matchesVerifiedCallback(input: ReturnManifestVerifiedCallback): Promise<boolean> {
    if (!input.verification.verified || (!input.providerTaskId && !input.providerContractId)) {
      return false;
    }
    const task = await this.prisma.contractESignTask.findFirst({
      where: {
        OR: [
          ...(input.providerTaskId ? [{ providerTaskId: input.providerTaskId }] : []),
          ...(input.providerContractId
            ? [
                { providerEnvelopeId: input.providerContractId },
                { taskNo: input.providerContractId }
              ]
            : [])
        ],
        deletedAt: null,
        documentType: ESignDocumentType.RETURN_MANIFEST,
        provider: input.provider,
        requestSnapshot: { equals: "RETURN_MANIFEST", path: ["documentType"] },
        signingStage: ESignSigningStage.STAGE6_RETURN_MANIFEST,
        sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
      }
    });
    return Boolean(task);
  }

  async handleVerifiedCallback(input: ReturnManifestVerifiedCallback) {
    if (!(await this.matchesVerifiedCallback(input))) throw sourceConflict();
    const task = await this.prisma.contractESignTask.findFirstOrThrow({
      include: { signers: true },
      where: {
        OR: [
          ...(input.providerTaskId ? [{ providerTaskId: input.providerTaskId }] : []),
          ...(input.providerContractId
            ? [
                { providerEnvelopeId: input.providerContractId },
                { taskNo: input.providerContractId }
              ]
            : [])
        ],
        deletedAt: null,
        provider: input.provider,
        requestSnapshot: { equals: "RETURN_MANIFEST", path: ["documentType"] },
        sourceType: "SUBSCRIPTION_CLOSURE_ESIGN"
      }
    });
    const request = objectValue(task.requestSnapshot);
    const closureCaseId = stringValue(request.closureCaseId);
    const idempotencyKey = stringValue(request.idempotencyKey);
    const actorId = stringValue(request.actorId);
    const command = normalizeInput({ actorId, closureCaseId, idempotencyKey });
    const sources = returnManifestSources(command);
    const payloadHash = sha256(
      Buffer.from(canonicalSubscriptionClosureJson(input.payload as never))
    );
    const operationKey = `return-manifest:${task.id}:customer-signed`;
    const callback = await claimSemanticCallback(this.prisma, {
      create: {
        eventType: input.eventType,
        operationKey,
        payload: asJson(input.payload),
        payloadHash,
        provider: input.provider,
        providerTaskId: input.providerTaskId,
        providerTransactionId: input.providerTaskId,
        taskId: task.id,
        verified: true
      },
      operationKey,
      provider: input.provider,
      taskId: task.id
    });
    if (task.taskStatus === ESignTaskStatus.COMPLETED) {
      const finalized = await this.finalize(command);
      return Object.freeze({
        finalization: finalized,
        finalized: true,
        handled: true,
        idempotent: true,
        taskId: task.id
      });
    }
    await this.prisma.$transaction(
      async (tx) => {
        await lockSources(this.repository, tx, sources);
        const current = await resolveManifestAuthority(tx, command, sources);
        await this.repository.lockAuthorityRows(tx, callbackLocks(current, command));
        const lockedTask = await tx.contractESignTask.findUnique({
          include: { signers: true },
          where: { id: task.id }
        });
        if (!lockedTask) throw sourceConflict();
        if (lockedTask.taskStatus === ESignTaskStatus.COMPLETED) {
          return;
        }
        if (lockedTask.taskStatus !== ESignTaskStatus.WAITING_CUSTOMER) throw sourceConflict();
        if (!this.provider.completeReturnManifestTask) throw providerCapabilityMissing();
        const lockedRequest = objectValue(lockedTask.requestSnapshot);
        const customer = requiredSigner(lockedTask, ESignSignerType.CUSTOMER);
        const platform = requiredSigner(lockedTask, ESignSignerType.PLATFORM);
        if (
          !lockedTask.providerEnvelopeId ||
          !lockedTask.providerTaskId ||
          !customer.providerTransactionId ||
          !customer.providerSignerId
        ) {
          throw sourceConflict();
        }
        const providerFile = fileSnapshot(lockedRequest.providerSourceFile);
        const providerDownload = await this.storage.getObject(
          providerFile.bucket,
          providerFile.objectKey
        );
        const providerSourcePdf = await streamBuffer(providerDownload.stream);
        if (
          BigInt(providerSourcePdf.length) !== providerFile.sizeBytes ||
          sha256(providerSourcePdf) !== stringValue(lockedRequest.providerSourceFileHash)
        ) {
          throw sourceConflict();
        }
        const completed = await this.provider.completeReturnManifestTask({
          contractId: lockedTask.contractId,
          customer: {
            providerCustomerId: customer.providerSignerId,
            providerTransactionId: customer.providerTransactionId,
            signerId: customer.id
          },
          documentName: lockedTask.documentName!,
          platform: {
            signerId: platform.id,
            transactionId: providerTransactionId(lockedTask.taskNo, "P1")
          },
          providerEnvelopeId: lockedTask.providerEnvelopeId,
          providerTaskId: lockedTask.providerTaskId,
          providerSourcePdf,
          taskId: lockedTask.id,
          taskNo: lockedTask.taskNo
        });
        const signedHash = sha256(completed.signedPdf.buffer);
        const originalName = `${stringValue(lockedRequest.caseNo)}-return-manifest-r2-signed.pdf`;
        const storedSigned = await this.storage.putReturnManifestArtifact({
          buffer: completed.signedPdf.buffer,
          closureCaseId,
          contentType: "application/pdf",
          metadata: { sha256: signedHash, type: "RETURN_MANIFEST_SIGNED" },
          objectIdentity: stableId(command, "signed"),
          originalName
        });
        const clock = await databaseClock(tx);
        const pendingSignedFile = {
          bucket: storedSigned.bucket,
          hash: signedHash,
          mimeType: "application/pdf",
          objectKey: storedSigned.objectKey,
          originalName,
          sizeBytes: completed.signedPdf.buffer.length.toString(),
          uploadedBy: command.actorId
        };
        await tx.contractESignSigner.update({
          data: {
            signedAt: clock,
            signerStatus: ESignSignerStatus.SIGNED,
            updatedAt: clock
          },
          where: { id: customer.id }
        });
        await tx.contractESignSigner.update({
          data: {
            providerSignerId: completed.platform.providerSignerId,
            providerTransactionId: completed.platform.providerTransactionId,
            signedAt: clock,
            signerStatus: ESignSignerStatus.SIGNED,
            updatedAt: clock
          },
          where: { id: platform.id }
        });
        const before = taskAuditSnapshot(lockedTask);
        const updated = await tx.contractESignTask.update({
          data: {
            callbackSnapshot: asJson(input.payload),
            completedAt: clock,
            responseSnapshot: asJson({
              providerCompletion: providerCompletionSnapshot(completed),
              providerStart: objectValue(lockedTask.responseSnapshot).providerStart,
              pendingSignedFile
            }),
            signedDocumentObjectKey: storedSigned.objectKey,
            taskStatus: ESignTaskStatus.COMPLETED,
            updatedAt: clock,
            updatedBy: command.actorId
          },
          where: { id: lockedTask.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: taskAuditSnapshot(updated),
            before,
            createdAt: clock,
            entityId: task.id,
            entityType: "contract_esign_task",
            module: "subscription_closure",
            operatorId: command.actorId
          },
          tx
        );
        await tx.contractESignCallbackLog.update({
          data: { handled: false, handledAt: null, taskId: task.id },
          where: { id: callback.id }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
    const finalized = await this.finalize(command);
    return Object.freeze({
      finalization: finalized,
      finalized: true,
      handled: true,
      taskId: task.id
    });
  }

  async finalize(input: ReturnManifestESignInput): Promise<ReturnManifestESignFinalization> {
    const command = normalizeInput(input);
    const sources = returnManifestSources(command);
    const observed = await resolveManifestAuthority(this.prisma, command, sources);
    assertStartedAuthority(observed, command, sources, this.providerType());
    if (observed.revisions.length === 3) {
      const signed = observed.revisions[1]!;
      return this.prisma.$transaction(async (tx) => {
        await lockSources(this.repository, tx, sources);
        const current = await resolveManifestAuthority(tx, command, sources);
        if (!signed.signedFileId) throw sourceConflict();
        await this.repository.lockAuthorityRows(
          tx,
          finalizeLocks(current, command, signed.signedFileId)
        );
        const locked = await resolveManifestAuthority(tx, command, sources);
        if (!(await validateCurrentManifestChain(tx, locked))) throw sourceConflict();
        return Object.freeze({
          archivedRevisionId: locked.revisions[2]!.id,
          signedFileHash: locked.revisions[1]!.signedFileHash!,
          signedFileId: locked.revisions[1]!.signedFileId!,
          signedRevisionId: locked.revisions[1]!.id,
          taskId: locked.task!.id,
          wrote: false
        });
      });
    }
    assertCompletedAuthority(observed, command, sources, this.providerType());
    const task = observed.task!;
    const response = objectValue(task.responseSnapshot);
    const pending = pendingFileSnapshot(response.pendingSignedFile);
    const downloaded = await this.storage.getObject(pending.bucket, pending.objectKey);
    const signedPdf = await streamBuffer(downloaded.stream);
    const signedHash = sha256(signedPdf);
    if (signedHash !== stringValue(objectValue(response.pendingSignedFile).hash)) {
      throw sourceConflict();
    }
    return this.prisma.$transaction(
      async (tx) => {
        const signedCapability = await this.repository.prepareSourceInTransaction(
          tx,
          sources.signed
        );
        const archivedCapability = await this.repository.prepareSourceInTransaction(
          tx,
          sources.archived
        );
        const current = await resolveManifestAuthority(tx, command, sources);
        assertCompletedAuthority(current, command, sources, this.providerType());
        if (current.revisions.length === 3) {
          if (!(await validateCurrentManifestChain(tx, current))) throw sourceConflict();
          const signed = current.revisions[1]!;
          const archived = current.revisions[2]!;
          return Object.freeze({
            archivedRevisionId: archived.id,
            signedFileHash: signed.signedFileHash!,
            signedFileId: signed.signedFileId!,
            signedRevisionId: signed.id,
            taskId: current.task!.id,
            wrote: false
          });
        }
        if (
          current.revisions.length !== 1 ||
          current.current.documentRevisionId !== current.generated.id
        ) {
          throw sourceConflict();
        }
        const clock = await databaseClock(tx);
        const signedFileId = stableId(command, "signed-file");
        const signedRevisionId = stableId(command, "signed-revision");
        const archivedRevisionId = stableId(command, "archived-revision");
        const request = objectValue(current.task!.requestSnapshot);
        const sourceFile = fileSnapshot(request.sourceFile);
        const snapshot = request.documentSnapshot as Prisma.JsonObject;
        const signedCommand = documentCommand({
          actorId: command.actorId,
          archivedAt: null,
          archivedBy: null,
          closureCase: current.closureCase,
          documentRevisionId: signedRevisionId,
          documentSnapshot: snapshot,
          expectedCurrentRevisionId: current.generated.id,
          expectedVersion: current.closureCase.version,
          generatedAt: clock,
          signedAt: clock,
          signedBy: command.actorId,
          signedFileHash: signedHash,
          signedFileId,
          source: sources.signed,
          sourceFileHash: stringValue(request.sourceFileHash),
          sourceFileId: sourceFile.id,
          stage: "SIGNED",
          taskId: current.task!.id
        });
        const archivedCommand = documentCommand({
          actorId: command.actorId,
          archivedAt: clock,
          archivedBy: command.actorId,
          closureCase: current.closureCase,
          documentRevisionId: archivedRevisionId,
          documentSnapshot: snapshot,
          expectedCurrentRevisionId: signedRevisionId,
          expectedVersion: current.closureCase.version + 1,
          generatedAt: clock,
          signedAt: clock,
          signedBy: command.actorId,
          signedFileHash: signedHash,
          signedFileId,
          source: sources.archived,
          sourceFileHash: stringValue(request.sourceFileHash),
          sourceFileId: sourceFile.id,
          stage: "ARCHIVED",
          taskId: current.task!.id
        });
        const extraLocks = finalizeLocks(current, command, signedFileId);
        const session = this.repository.createAuthoritySessionInTransaction(tx);
        const signedRequirement = this.repository.bindAuthorityRequirement(
          session,
          subscriptionClosureDocumentAuthorityRequirement(
            signedCommand,
            "return-manifest-signed",
            extraLocks
          )
        );
        const archivedRequirement = this.repository.bindAuthorityRequirement(
          session,
          subscriptionClosureDocumentAuthorityRequirement(
            archivedCommand,
            "return-manifest-archived",
            extraLocks
          )
        );
        const attestations = await this.repository.prepareAuthorityInTransaction(
          tx,
          session,
          [...signedRequirement.locks, ...archivedRequirement.locks],
          [signedRequirement, archivedRequirement]
        );
        await tx.fileObject.create({
          data: {
            bucket: pending.bucket,
            createdAt: clock,
            id: signedFileId,
            mimeType: "application/pdf",
            objectKey: pending.objectKey,
            originalName: pending.originalName,
            sizeBytes: BigInt(signedPdf.length),
            uploadedBy: command.actorId
          }
        });
        const lockedTask = await tx.contractESignTask.findUniqueOrThrow({
          where: { id: current.task!.id }
        });
        const signedFile = fileShape({
          bucket: pending.bucket,
          createdAt: clock,
          id: signedFileId,
          mimeType: "application/pdf",
          objectKey: pending.objectKey,
          originalName: pending.originalName,
          sizeBytes: BigInt(signedPdf.length),
          uploadedBy: command.actorId
        });
        await this.auditService.write(
          {
            action: AuditAction.CREATE,
            after: jsonFileShape(signedFile),
            createdAt: clock,
            entityId: signedFile.id,
            entityType: "file_object",
            module: "subscription_closure",
            operatorId: command.actorId
          },
          tx
        );
        const beforeTask = taskAuditSnapshot(lockedTask);
        const finalizedTask = await tx.contractESignTask.update({
          data: {
            responseSnapshot: asJson({
              providerCompletion: response.providerCompletion,
              providerStart: response.providerStart,
              signedFile: jsonFileShape(signedFile),
              signedFileHash: signedHash,
              signedFileId
            }),
            updatedAt: clock,
            updatedBy: command.actorId
          },
          where: { id: lockedTask.id }
        });
        await this.auditService.write(
          {
            action: AuditAction.UPDATE,
            after: taskAuditSnapshot(finalizedTask),
            before: beforeTask,
            createdAt: clock,
            entityId: finalizedTask.id,
            entityType: "contract_esign_task",
            module: "subscription_closure",
            operatorId: command.actorId
          },
          tx
        );
        const audit = this.documentAudit(command.actorId);
        await this.repository.appendPreparedDocumentRevisionInTransaction(
          tx,
          session,
          signedCommand,
          signedCapability,
          requiredAttestation(attestations, "return-manifest-signed"),
          audit,
          "return-manifest-signed",
          extraLocks
        );
        await this.repository.appendPreparedDocumentRevisionInTransaction(
          tx,
          session,
          archivedCommand,
          archivedCapability,
          requiredAttestation(attestations, "return-manifest-archived"),
          audit,
          "return-manifest-archived",
          extraLocks
        );
        if (!lockedTask.completedAt) throw sourceConflict();
        const handledCallback = await tx.contractESignCallbackLog.updateMany({
          data: { handled: true, handledAt: lockedTask.completedAt },
          where: {
            operationKey: `return-manifest:${lockedTask.id}:customer-signed`,
            provider: lockedTask.provider,
            taskId: lockedTask.id,
            verified: true
          }
        });
        if (handledCallback.count !== 1) throw sourceConflict();
        const finalized = await resolveManifestAuthority(tx, command, sources);
        if (!(await validateCurrentManifestChain(tx, finalized))) throw sourceConflict();
        return Object.freeze({
          archivedRevisionId,
          signedFileHash: signedHash,
          signedFileId,
          signedRevisionId,
          taskId: finalizedTask.id,
          wrote: true
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private async ensureReservedArtifacts(
    command: ReturnManifestESignInput,
    authority: ResolvedManifestAuthority
  ) {
    const artifacts = await materializeReservedArtifacts(
      authority,
      this.config.get<string>(CONTRACT_PDF_CJK_FONT_PATH_ENV)
    );
    const storedSource = await this.storage.putReturnManifestArtifact({
      buffer: artifacts.sourceBytes,
      closureCaseId: command.closureCaseId,
      contentType: "application/json",
      metadata: { sha256: artifacts.sourceFileHash, type: "RETURN_MANIFEST_SOURCE" },
      objectIdentity: stableId(command, "source"),
      originalName: artifacts.sourceFile.originalName
    });
    const storedProvider = await this.storage.putReturnManifestArtifact({
      buffer: artifacts.providerPdf,
      closureCaseId: command.closureCaseId,
      contentType: "application/pdf",
      metadata: { sha256: artifacts.providerPdfHash, type: "RETURN_MANIFEST_PROVIDER_SOURCE" },
      objectIdentity: stableId(command, "provider-source"),
      originalName: artifacts.providerFile.originalName
    });
    if (
      storedSource.bucket !== artifacts.sourceFile.bucket ||
      storedSource.objectKey !== artifacts.sourceFile.objectKey ||
      storedProvider.bucket !== artifacts.providerFile.bucket ||
      storedProvider.objectKey !== artifacts.providerFile.objectKey
    ) {
      throw sourceConflict();
    }
    return artifacts;
  }

  private async persistStartedProviderTask(
    tx: Prisma.TransactionClient,
    command: ReturnManifestESignInput,
    task: NonNullable<ResolvedManifestAuthority["task"]>,
    providerResult: ReturnManifestProviderTaskResult
  ): Promise<ReturnManifestESignStart> {
    if (task.providerTaskId) {
      if (
        task.providerTaskId !== providerResult.providerTaskId ||
        task.providerEnvelopeId !== providerResult.providerEnvelopeId
      ) {
        throw sourceConflict();
      }
      return Object.freeze({ signUrl: task.signUrl, taskId: task.id, wrote: false });
    }
    if (task.taskStatus !== ESignTaskStatus.CREATED) throw sourceConflict();
    const customer = requiredSigner(task, ESignSignerType.CUSTOMER);
    const clock = await databaseClock(tx);
    const before = taskAuditSnapshot(task);
    await tx.contractESignSigner.update({
      data: {
        providerSignerId: providerResult.customer.providerCustomerId,
        providerTransactionId: providerResult.customer.providerTransactionId,
        signUrl: providerResult.customer.signUrl,
        signUrlExpiresAt: providerResult.customer.signUrlExpiresAt,
        signerStatus: ESignSignerStatus.SIGNING,
        updatedAt: clock
      },
      where: { id: customer.id }
    });
    const updated = await tx.contractESignTask.update({
      data: {
        providerEnvelopeId: providerResult.providerEnvelopeId,
        providerTaskId: providerResult.providerTaskId,
        responseSnapshot: asJson({
          providerStart: providerStartSnapshot(providerResult)
        }),
        signUrl: providerResult.customer.signUrl,
        signUrlExpiresAt: providerResult.customer.signUrlExpiresAt,
        startedAt: clock,
        taskStatus: ESignTaskStatus.WAITING_CUSTOMER,
        updatedAt: clock,
        updatedBy: command.actorId
      },
      where: { id: task.id }
    });
    await this.auditService.write(
      {
        action: AuditAction.UPDATE,
        after: taskAuditSnapshot(updated),
        before,
        createdAt: clock,
        entityId: task.id,
        entityType: "contract_esign_task",
        module: "subscription_closure",
        operatorId: command.actorId
      },
      tx
    );
    return Object.freeze({
      signUrl: updated.signUrl,
      taskId: updated.id,
      wrote: true
    });
  }

  private async startProviderTask(
    command: ReturnManifestESignInput,
    sources: ReturnType<typeof returnManifestSources>,
    authority: ResolvedManifestAuthority,
    providerPdf: Buffer,
    providerPdfHash: string
  ): Promise<ReturnManifestESignStart> {
    assertReservedAuthority(authority, command, sources, this.providerType());
    return this.prisma.$transaction(
      async (tx) => {
        await lockSources(this.repository, tx, sources);
        const current = await resolveManifestAuthority(tx, command, sources);
        await this.repository.lockAuthorityRows(tx, startLocks(current, command));
        const locked = await resolveManifestAuthority(tx, command, sources);
        assertReservedAuthority(locked, command, sources, this.providerType());
        const task = locked.task!;
        if (task.providerTaskId) {
          assertStartedAuthority(locked, command, sources, this.providerType());
          return Object.freeze({ signUrl: task.signUrl, taskId: task.id, wrote: false });
        }
        const request = objectValue(task.requestSnapshot);
        if (stringValue(request.providerSourceFileHash) !== providerPdfHash) {
          throw sourceConflict();
        }
        const customerSigner = requiredSigner(task, ESignSignerType.CUSTOMER);
        const providerInput = {
          callbackUrl: this.callbackUrl(),
          contractId: locked.closureCase.contractId,
          customer: {
            customerId: locked.closureCase.customerId,
            name: locked.customer.name,
            phone: locked.customer.mobile,
            signerId: customerSigner.id
          },
          documentName: task.documentName!,
          providerSourcePdf: {
            buffer: providerPdf,
            fileName: task.documentName!,
            sha256: providerPdfHash
          },
          taskId: task.id,
          taskNo: task.taskNo,
          transactionId: providerTransactionId(task.taskNo, "C1")
        } satisfies ReturnManifestProviderTaskInput;
        const reconciled = await this.provider.reconcileReturnManifestTask?.(providerInput);
        if (reconciled) {
          return this.persistStartedProviderTask(tx, command, task, reconciled);
        }
        if (!this.provider.createReturnManifestTask) throw providerCapabilityMissing();
        const providerResult = await this.provider.createReturnManifestTask(providerInput);
        return this.persistStartedProviderTask(tx, command, task, providerResult);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }
    );
  }

  private providerType() {
    const selected = selectedESignProvider(this.config);
    if (selected === "mock") return ESignProviderType.MOCK;
    if (selected === "fadada") return ESignProviderType.FADADA;
    throw new ConflictException({
      code: "RETURN_MANIFEST_ESIGN_PROVIDER_UNSUPPORTED",
      message: `Unsupported return-manifest e-sign provider: ${selected}`
    });
  }

  private callbackUrl() {
    return resolveReturnManifestCallbackUrl(this.config);
  }

  private documentAudit(actorId: string): SubscriptionClosureMutationAuditHook {
    return async (tx, mutation) => {
      await this.auditService.write(
        {
          action: AuditAction.CREATE,
          after: mutation,
          entityId: mutation.eventId,
          entityType: "subscription_closure_event",
          module: "subscription_closure",
          operatorId: actorId
        },
        tx
      );
    };
  }
}

export function resolveReturnManifestCallbackUrl(config: ConfigService) {
  const provider = selectedESignProvider(config);
  const configuredBase = config.get<string>("API_BASE_URL")?.trim();
  const base = (configuredBase || "http://localhost:4000").replace(/\/+$/, "");
  if (provider === "fadada" && loadFadadaConfig(config).env === "production") {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw callbackUrlInvalid();
    }
    if (parsed.protocol !== "https:" || isLocalOrPrivateHostname(parsed.hostname)) {
      throw callbackUrlInvalid();
    }
  }
  return `${base}/esign/callback/${provider}`;
}

function isLocalOrPrivateHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const octets = normalized.split(".").map((value) => Number.parseInt(value, 10));
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function callbackUrlInvalid() {
  return new ConflictException({
    code: "RETURN_MANIFEST_ESIGN_CALLBACK_URL_INVALID",
    message: "Production Fadada return-manifest callbacks require a public HTTPS API base URL."
  });
}

function normalizeInput(input: ReturnManifestESignInput): ReturnManifestESignInput {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new ConflictException({
        code: "RETURN_MANIFEST_ESIGN_INPUT_INVALID",
        message: `${name} is required`
      });
    }
  }
  return Object.freeze({
    actorId: input.actorId.trim().toLowerCase(),
    closureCaseId: input.closureCaseId.trim().toLowerCase(),
    idempotencyKey: input.idempotencyKey.trim()
  });
}

function returnManifestSources(command: ReturnManifestESignInput) {
  const legacyGeneratedRevisionId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      command.idempotencyKey
    );
  const attemptSuffix = legacyGeneratedRevisionId
    ? ""
    : `:${createHash("sha256").update(command.idempotencyKey).digest("hex").slice(0, 24)}`;
  const baseKey = `return-manifest-esign${attemptSuffix}`;
  const make = (key: string): SubscriptionClosureSource =>
    Object.freeze({
      id: command.closureCaseId,
      key,
      type: "SUBSCRIPTION_CLOSURE_ESIGN"
    });
  return Object.freeze({
    archived: make(`${baseKey}:archived`),
    signed: make(`${baseKey}:signed`),
    task: make(baseKey)
  });
}

async function resolveManifestAuthority(
  tx: Prisma.TransactionClient | PrismaService,
  command: ReturnManifestESignInput,
  sources: ReturnType<typeof returnManifestSources>
) {
  const [closureCase, revisions, current, task, actor] = await Promise.all([
    tx.subscriptionClosureCase.findUnique({ where: { id: command.closureCaseId } }),
    tx.subscriptionClosureDocumentRevision.findMany({
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
      where: { closureCaseId: command.closureCaseId, documentType: "RETURN_MANIFEST" }
    }),
    tx.subscriptionClosureCurrentDocument.findUnique({
      where: {
        closureCaseId_documentType: {
          closureCaseId: command.closureCaseId,
          documentType: "RETURN_MANIFEST"
        }
      }
    }),
    tx.contractESignTask.findFirst({
      include: { signers: true },
      where: {
        sourceId: sources.task.id,
        sourceKey: sources.task.key,
        sourceType: sources.task.type
      }
    }),
    tx.user.findUnique({ where: { id: command.actorId } })
  ]);
  const generated = revisions[0];
  if (
    !closureCase ||
    !generated ||
    !current ||
    !actor ||
    closureCase.retiredAt ||
    closureCase.retiredBy ||
    !closureCase.vehicleReturnId ||
    !closureCase.returnHandoverWorkOrderId ||
    generated.stage !== "GENERATED" ||
    generated.revisionNumber !== 1 ||
    generated.supersedesRevisionId !== null ||
    generated.closureCaseId !== closureCase.id
  ) {
    throw sourceConflict();
  }
  const [
    vehicleReturn,
    customer,
    sourceFile,
    order,
    contract,
    currentChecklist,
    evidenceLinks
  ] = await Promise.all([
    tx.vehicleReturn.findUniqueOrThrow({ where: { id: closureCase.vehicleReturnId } }),
    tx.customer.findUniqueOrThrow({ where: { id: closureCase.customerId } }),
    tx.fileObject.findUniqueOrThrow({ where: { id: generated.sourceFileId } }),
    tx.subscriptionOrder.findUniqueOrThrow({ where: { id: closureCase.orderId } }),
    tx.contract.findUniqueOrThrow({ where: { id: closureCase.contractId } }),
    closureCase.currentChecklistRevisionId
      ? tx.vehicleReturnChecklistRevision.findUnique({
          include: { items: { orderBy: { itemCode: "asc" } } },
          where: { id: closureCase.currentChecklistRevisionId }
        })
      : null,
    tx.vehicleReturnEvidenceLink.findMany({
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
      where: { closureCaseId: closureCase.id, evidenceId: { not: null } }
    })
  ]);
  const evidence = await tx.assetWorkOrderEvidence.findMany({
    orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    where: {
      id: {
        in: evidenceLinks
          .map(({ evidenceId }) => evidenceId)
          .filter((id): id is string => Boolean(id))
      }
    }
  });
  return Object.freeze({
    actor,
    closureCase,
    contract,
    current,
    currentChecklist,
    customer,
    evidence,
    evidenceLinks,
    generated,
    order,
    revisions,
    sourceFile,
    task,
    vehicleReturn
  });
}

const RETURN_MANIFEST_REQUIRED_EVIDENCE_CODES = new Set([
  "KEY",
  "REGISTRATION_CERTIFICATE",
  "VEHICLE_EXTERIOR",
  "VEHICLE_INTERIOR"
]);

function returnManifestMissingEvidenceCodes(
  items: readonly Readonly<{ id: string; itemCode: string; state: string }>[],
  links: readonly Readonly<{
    checklistItemId: string | null;
    id: string;
    supersedesLinkId: string | null;
  }>[],
  approvedExceptionItemIds: ReadonlySet<string> = new Set()
) {
  const superseded = new Set(
    links.map(({ supersedesLinkId }) => supersedesLinkId).filter((id): id is string => Boolean(id))
  );
  const activeItemIds = new Set(
    links
      .filter(({ id }) => !superseded.has(id))
      .map(({ checklistItemId }) => checklistItemId)
      .filter((id): id is string => Boolean(id))
  );
  return items
    .filter(({ id, itemCode, state }) => {
      if (
        itemCode === "REGISTRATION_CERTIFICATE" &&
        ["MISSING", "DAMAGED", "PENDING_VERIFICATION"].includes(state)
      ) {
        return !approvedExceptionItemIds.has(id);
      }
      return (
        (RETURN_MANIFEST_REQUIRED_EVIDENCE_CODES.has(itemCode) ||
          state === "MISSING" ||
          state === "DAMAGED") &&
        !activeItemIds.has(id)
      );
    })
    .map(({ itemCode }) => itemCode);
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function returnManifestSuccessorSnapshot(authority: ResolvedManifestAuthority) {
  const supersededLinkIds = new Set(
    authority.evidenceLinks
      .map(({ supersedesLinkId }) => supersedesLinkId)
      .filter((id): id is string => Boolean(id))
  );
  const evidenceById = new Map(authority.evidence.map((item) => [item.id, item]));
  const evidence = authority.evidenceLinks
    .filter(({ id, visibility }) => !supersededLinkIds.has(id) && visibility === "CUSTOMER_VISIBLE")
    .map((link) => {
      const item = link.evidenceId ? evidenceById.get(link.evidenceId) : null;
      if (!item?.contentSha256 || !item.fileId) throw sourceConflict();
      return {
        capturedAt: item.capturedAt?.toISOString() ?? null,
        checklistItemId: link.checklistItemId,
        contentSha256: item.contentSha256,
        damageId: link.damageId,
        evidenceId: item.id,
        evidencePurpose: link.evidencePurpose,
        evidenceType: item.evidenceType,
        fileId: item.fileId,
        linkId: link.id
      };
    });
  return Object.freeze({
    ...(authority.generated.documentSnapshot as Prisma.JsonObject),
    ...(authority.currentChecklist
      ? {
          returnChecklistAttestationMode: authority.currentChecklist.attestationMode,
          returnChecklistManifestHash: authority.currentChecklist.manifestHash,
          returnChecklistRevisionId: authority.currentChecklist.id,
          returnChecklistRevisionNumber: authority.currentChecklist.revisionNumber,
          returnEvidence: evidence
        }
      : {}),
    returnChecklistSnapshot: authority.vehicleReturn.checklistSnapshot ?? {},
    returnChecklistSnapshotHash: hashSubscriptionClosureSnapshot(
      authority.vehicleReturn.checklistSnapshot ?? {}
    ),
    returnLocation: authority.vehicleReturn.returnLocation,
    returnScheduledAt: authority.vehicleReturn.scheduledAt?.toISOString() ?? null
  });
}

function requestSnapshot(input: {
  archivedSource: SubscriptionClosureSource;
  checklistSnapshot: unknown;
  documentSnapshot: Readonly<Record<string, unknown>>;
  generatedRevisionId: string;
  idempotencyKey: string;
  providerSourceFile: FileShape;
  providerSourceFileHash: string;
  renderedAt: Date;
  signedSource: SubscriptionClosureSource;
  sourceFile: FileShape;
  sourceFileHash: string;
  taskSource: SubscriptionClosureSource;
}) {
  return {
    actorId: input.sourceFile.uploadedBy,
    archivedSource: input.archivedSource,
    checklistSnapshot: input.checklistSnapshot,
    caseNo: stringValue(input.documentSnapshot.caseNo),
    closureCaseId: input.taskSource.id,
    documentSnapshot: input.documentSnapshot,
    documentSnapshotHash: hashSubscriptionClosureSnapshot(input.documentSnapshot as never),
    documentType: "RETURN_MANIFEST",
    generatedRevisionId: input.generatedRevisionId,
    idempotencyKey: input.idempotencyKey,
    providerSourceFile: jsonFileShape(input.providerSourceFile),
    providerSourceFileHash: input.providerSourceFileHash,
    renderedAt: input.renderedAt.toISOString(),
    signedSource: input.signedSource,
    sourceFile: jsonFileShape(input.sourceFile),
    sourceFileHash: input.sourceFileHash,
    taskSource: input.taskSource,
    version: 1
  } as const;
}

export function isCurrentRegistrationDocumentApproval(input: Readonly<{
  approval: Readonly<Record<string, unknown>>;
  checklist: Readonly<{ id: string; manifestHash: string }>;
  closureCaseId: string;
  evidenceLinks: readonly Readonly<{
    checklistItemId: string | null;
    evidenceId: string | null;
  }>[];
  registrationItem: Readonly<{ id: string; state: string }>;
}>) {
  const snapshot = objectValue(input.approval.subjectSnapshot);
  const evidenceIds = arrayOfStrings(snapshot.evidenceIds);
  const exactEvidenceIds = new Set(
    input.evidenceLinks
      .filter((link) => link.checklistItemId === input.registrationItem.id)
      .map((link) => link.evidenceId)
      .filter((id): id is string => typeof id === "string")
  );
  const expectedSnapshotHash = createHash("sha256")
    .update(canonicalSubscriptionClosureJson(snapshot as never))
    .digest("hex");
  return (
    input.approval.status === "APPROVED" &&
    input.approval.decision === "APPROVED" &&
    input.approval.exceptionType === "VEHICLE_REGISTRATION_DOCUMENT_MISSING" &&
    input.approval.subjectType === "SETTLEMENT_CASE" &&
    input.approval.subjectId === input.closureCaseId &&
    input.approval.subjectField === `returnRegistrationDocument:${input.registrationItem.id}` &&
    input.approval.expiredAt == null &&
    input.approval.decidedAt != null &&
    input.approval.requestedBy !== input.approval.decidedBy &&
    input.approval.subjectSnapshotHash === expectedSnapshotHash &&
    snapshot.closureCaseId === input.closureCaseId &&
    snapshot.checklistRevisionId === input.checklist.id &&
    snapshot.checklistManifestHash === input.checklist.manifestHash &&
    snapshot.checklistItemId === input.registrationItem.id &&
    snapshot.checklistItemState === input.registrationItem.state &&
    evidenceIds.length > 0 &&
    evidenceIds.every((id) => exactEvidenceIds.has(id))
  );
}

function assertReservedAuthority(
  authority: ResolvedManifestAuthority,
  command: ReturnManifestESignInput,
  sources: ReturnType<typeof returnManifestSources>,
  provider: ESignProviderType
) {
  const task = authority.task;
  if (!task || task.id !== stableId(command, "task") || task.provider !== provider) {
    throw sourceConflict();
  }
  const request = objectValue(task.requestSnapshot);
  if (
    request.documentType !== "RETURN_MANIFEST" ||
    request.actorId !== command.actorId ||
    request.idempotencyKey !== command.idempotencyKey ||
    !sameJson(request.taskSource, sources.task) ||
    !sameJson(request.signedSource, sources.signed) ||
    !sameJson(request.archivedSource, sources.archived) ||
    task.documentType !== ESignDocumentType.RETURN_MANIFEST ||
    task.signingStage !== ESignSigningStage.STAGE6_RETURN_MANIFEST ||
    task.sourceType !== sources.task.type ||
    task.sourceId !== sources.task.id ||
    task.sourceKey !== sources.task.key ||
    task.signers.length !== 2
  ) {
    throw sourceConflict();
  }
  requiredSigner(task, ESignSignerType.CUSTOMER);
  requiredSigner(task, ESignSignerType.PLATFORM);
}

function assertStartedAuthority(
  authority: ResolvedManifestAuthority,
  command: ReturnManifestESignInput,
  sources: ReturnType<typeof returnManifestSources>,
  provider: ESignProviderType
) {
  assertReservedAuthority(authority, command, sources, provider);
  if (
    !authority.task?.providerTaskId ||
    !authority.task.providerEnvelopeId ||
    (authority.task.taskStatus !== ESignTaskStatus.WAITING_CUSTOMER &&
      authority.task.taskStatus !== ESignTaskStatus.COMPLETED)
  ) {
    throw sourceConflict();
  }
}

function assertCompletedAuthority(
  authority: ResolvedManifestAuthority,
  command: ReturnManifestESignInput,
  sources: ReturnType<typeof returnManifestSources>,
  provider: ESignProviderType
) {
  assertStartedAuthority(authority, command, sources, provider);
  if (
    authority.task?.taskStatus !== ESignTaskStatus.COMPLETED ||
    !authority.task.completedAt ||
    !authority.task.signedDocumentObjectKey ||
    !objectValue(authority.task.responseSnapshot).pendingSignedFile
  ) {
    throw sourceConflict();
  }
}

function startLocks(
  authority: ResolvedManifestAuthority,
  command: ReturnManifestESignInput
): SubscriptionClosureAuthorityLock[] {
  const locks: SubscriptionClosureAuthorityLock[] = [
    { id: authority.closureCase.id, mode: "UPDATE", table: "subscription_closure_case" },
    { id: authority.order.id, mode: "SHARE", table: "subscription_order" },
    { id: authority.contract.id, mode: "SHARE", table: "contract" },
    { id: authority.vehicleReturn.id, mode: "SHARE", table: "vehicle_return" },
    {
      id: authority.closureCase.returnHandoverWorkOrderId!,
      mode: "SHARE",
      table: "vehicle_handover_work_order"
    },
    {
      id: authority.closureCase.id,
      mode: "UPDATE",
      table: "subscription_closure_current_document"
    },
    {
      id: authority.generated.id,
      mode: "SHARE",
      table: "subscription_closure_document_revision"
    },
    { id: authority.generated.sourceFileId, mode: "SHARE", table: "file_object" },
    { id: authority.customer.id, mode: "SHARE", table: "customer" },
    { id: command.actorId, mode: "SHARE", table: "user" }
  ];
  if (authority.task) {
    locks.push({ id: authority.task.id, mode: "UPDATE", table: "contract_esign_task" });
    const request = objectValue(authority.task.requestSnapshot);
    for (const file of [request.sourceFile, request.providerSourceFile]) {
      if (file) locks.push({ id: fileSnapshot(file).id, mode: "SHARE", table: "file_object" });
    }
  }
  return locks;
}

function callbackLocks(authority: ResolvedManifestAuthority, command: ReturnManifestESignInput) {
  return startLocks(authority, command);
}

function finalizeLocks(
  authority: ResolvedManifestAuthority,
  command: ReturnManifestESignInput,
  signedFileId: string
): SubscriptionClosureAuthorityLock[] {
  return [
    ...startLocks(authority, command),
    { id: signedFileId, mode: "SHARE", table: "file_object" }
  ];
}

async function lockSources(
  repository: SubscriptionClosureRepository,
  tx: Prisma.TransactionClient,
  sources: ReturnType<typeof returnManifestSources>
) {
  for (const source of [sources.task, sources.signed, sources.archived]) {
    await repository.lockSourceOwnership(tx, source);
  }
}

function documentCommand(input: {
  actorId: string;
  archivedAt: Date | null;
  archivedBy: string | null;
  closureCase: ResolvedManifestAuthority["closureCase"];
  documentRevisionId: string;
  documentSnapshot: Prisma.JsonObject;
  expectedCurrentRevisionId: string;
  expectedVersion: number;
  generatedAt: Date;
  signedAt: Date;
  signedBy: string;
  signedFileHash: string;
  signedFileId: string;
  source: SubscriptionClosureSource;
  sourceFileHash: string;
  sourceFileId: string;
  stage: "SIGNED" | "ARCHIVED";
  taskId: string;
}): AppendSubscriptionClosureDocumentCommand {
  return {
    actorId: input.actorId,
    archivedAt: input.archivedAt,
    archivedBy: input.archivedBy,
    closureCaseId: input.closureCase.id,
    contractESignTaskId: input.taskId,
    documentRevisionId: input.documentRevisionId,
    documentSnapshot: input.documentSnapshot as never,
    documentType: "RETURN_MANIFEST",
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    expectedVersion: input.expectedVersion,
    generatedAt: input.generatedAt,
    handoverWorkOrderId: input.closureCase.returnHandoverWorkOrderId,
    signedAt: input.signedAt,
    signedBy: input.signedBy,
    signedFileHash: input.signedFileHash,
    signedFileId: input.signedFileId,
    source: input.source,
    sourceFileHash: input.sourceFileHash,
    sourceFileId: input.sourceFileId,
    stage: input.stage,
    vehicleReturnId: input.closureCase.vehicleReturnId
  };
}

async function validateCurrentManifestChain(
  tx: Prisma.TransactionClient,
  authority: ResolvedManifestAuthority
) {
  return validateExactReturnManifestSuccessorChain(
    tx,
    authority.closureCase,
    authority.revisions,
    authority.current
  );
}

function requiredSigner(
  task: Readonly<{ signers: readonly { signerType: ESignSignerType }[] }>,
  type: ESignSignerType
) {
  const signers = task.signers.filter(({ signerType }) => signerType === type);
  if (signers.length !== 1) throw sourceConflict();
  return signers[0] as (typeof task.signers)[number] & {
    id: string;
    providerSignerId: string | null;
    providerTransactionId: string | null;
  };
}

async function claimSemanticCallback(
  tx: PrismaService,
  input: Readonly<{
    create: Prisma.ContractESignCallbackLogUncheckedCreateInput;
    operationKey: string;
    provider: ESignProviderType;
    taskId: string;
  }>
) {
  const find = () =>
    tx.contractESignCallbackLog.findFirst({
      where: { operationKey: input.operationKey, provider: input.provider }
    });
  const existing = await find();
  if (existing) {
    if (existing.taskId !== input.taskId || !existing.verified) throw sourceConflict();
    return existing;
  }
  try {
    return await tx.contractESignCallbackLog.create({ data: input.create });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error;
    const winner = await find();
    if (!winner || winner.taskId !== input.taskId || !winner.verified) {
      throw sourceConflict();
    }
    return winner;
  }
}

function providerStartSnapshot(result: ReturnManifestProviderTaskResult) {
  return {
    customer: {
      providerCustomerId: result.customer.providerCustomerId,
      providerSignerId: result.customer.providerSignerId,
      providerTransactionId: result.customer.providerTransactionId,
      signUrlExpiresAt: result.customer.signUrlExpiresAt?.toISOString() ?? null
    },
    providerEnvelopeId: result.providerEnvelopeId,
    providerTaskId: result.providerTaskId
  };
}

function providerCompletionSnapshot(
  result: Awaited<ReturnType<NonNullable<ESignProvider["completeReturnManifestTask"]>>>
) {
  return {
    customer: result.customer,
    platform: result.platform,
    signedPdf: {
      contentType: result.signedPdf.contentType,
      fileName: result.signedPdf.fileName,
      sha256: sha256(result.signedPdf.buffer),
      sizeBytes: result.signedPdf.buffer.length.toString()
    }
  };
}

function taskAuditSnapshot(task: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    [
      "callbackSnapshot",
      "completedAt",
      "contractId",
      "createdAt",
      "createdBy",
      "customerId",
      "deletedAt",
      "documentName",
      "documentObjectKey",
      "documentType",
      "errorSnapshot",
      "id",
      "orderId",
      "provider",
      "providerEnvelopeId",
      "providerTaskId",
      "requestSnapshot",
      "responseSnapshot",
      "signedDocumentObjectKey",
      "signingStage",
      "sourceId",
      "sourceKey",
      "sourceType",
      "startedAt",
      "taskNo",
      "taskStatus",
      "updatedAt",
      "updatedBy"
    ].map((key) => [key, jsonScalar(task[key])])
  );
}

function signerAuditSnapshot(signer: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(signer)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, jsonScalar(value)])
  );
}

type FileShape = Readonly<{
  bucket: string;
  createdAt: Date;
  id: string;
  mimeType: string;
  objectKey: string;
  originalName: string;
  sizeBytes: bigint;
  uploadedBy: string;
}>;

function fileShape(value: FileShape): FileShape {
  return Object.freeze(value);
}

function jsonFileShape(value: FileShape) {
  return {
    bucket: value.bucket,
    createdAt: value.createdAt.toISOString(),
    id: value.id,
    mimeType: value.mimeType,
    objectKey: value.objectKey,
    originalName: value.originalName,
    sizeBytes: value.sizeBytes.toString(),
    uploadedBy: value.uploadedBy
  };
}

function fileSnapshot(value: unknown): FileShape {
  const object = objectValue(value);
  const createdAt = object.createdAt ? new Date(stringValue(object.createdAt)) : new Date(0);
  const result = fileShape({
    bucket: stringValue(object.bucket),
    createdAt,
    id: stringValue(object.id),
    mimeType: stringValue(object.mimeType),
    objectKey: stringValue(object.objectKey),
    originalName: stringValue(object.originalName),
    sizeBytes: BigInt(stringValue(object.sizeBytes)),
    uploadedBy: stringValue(object.uploadedBy)
  });
  if (!result.bucket || !result.id || !result.objectKey || !Number.isFinite(createdAt.getTime())) {
    throw sourceConflict();
  }
  return result;
}

function pendingFileSnapshot(value: unknown) {
  const object = objectValue(value);
  const result = {
    bucket: stringValue(object.bucket),
    mimeType: stringValue(object.mimeType),
    objectKey: stringValue(object.objectKey),
    originalName: stringValue(object.originalName),
    sizeBytes: BigInt(stringValue(object.sizeBytes)),
    uploadedBy: stringValue(object.uploadedBy)
  };
  if (
    !result.bucket ||
    result.mimeType !== "application/pdf" ||
    !result.objectKey ||
    !result.originalName ||
    result.sizeBytes <= 0n ||
    !result.uploadedBy
  ) {
    throw sourceConflict();
  }
  return Object.freeze(result);
}

function fileCreate(value: FileShape) {
  return {
    bucket: value.bucket,
    createdAt: value.createdAt,
    id: value.id,
    mimeType: value.mimeType,
    objectKey: value.objectKey,
    originalName: value.originalName,
    sizeBytes: value.sizeBytes,
    uploadedBy: value.uploadedBy
  };
}

function stableId(command: ReturnManifestESignInput, label: string) {
  const hex = createHash("sha256")
    .update(`return-manifest-esign\0${command.closureCaseId}\0${command.idempotencyKey}\0${label}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function providerTransactionId(taskNo: string, suffix: "C1" | "P1") {
  const normalized = taskNo.replace(/[^A-Za-z0-9]/g, "");
  return `${normalized.slice(0, 32 - suffix.length)}${suffix}`;
}

async function databaseClock(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ clock: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS "clock"`
  );
  if (!row?.clock) throw sourceConflict();
  return row.clock;
}

async function materializeReservedArtifacts(
  authority: ResolvedManifestAuthority,
  cjkFontPath?: string
) {
  if (!authority.task) throw sourceConflict();
  const request = objectValue(authority.task.requestSnapshot);
  const sourceFile = fileSnapshot(request.sourceFile);
  const providerFile = fileSnapshot(request.providerSourceFile);
  const renderedAt = new Date(stringValue(request.renderedAt));
  if (!Number.isFinite(renderedAt.getTime())) throw sourceConflict();
  const sourceBytes = Buffer.from(
    canonicalSubscriptionClosureJson(request.documentSnapshot as never),
    "utf8"
  );
  const providerPdf = await renderReturnManifestPdf(
    request.documentSnapshot,
    request.checklistSnapshot,
    renderedAt,
    cjkFontPath
  );
  const sourceFileHash = sha256(sourceBytes);
  const providerPdfHash = sha256(providerPdf);
  if (
    BigInt(sourceBytes.length) !== sourceFile.sizeBytes ||
    BigInt(providerPdf.length) !== providerFile.sizeBytes ||
    sourceFileHash !== stringValue(request.sourceFileHash) ||
    providerPdfHash !== stringValue(request.providerSourceFileHash)
  ) {
    throw sourceConflict();
  }
  return Object.freeze({
    providerFile,
    providerPdf,
    providerPdfHash,
    sourceBytes,
    sourceFile,
    sourceFileHash
  });
}

async function renderReturnManifestPdf(
  documentSnapshot: unknown,
  checklistSnapshot: unknown,
  renderedAt: Date,
  cjkFontPath?: string
) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    compress: false,
    info: {
      CreationDate: renderedAt,
      Creator: "subscription-closure",
      ModDate: renderedAt,
      Producer: "subscription-closure",
      Title: "Return Manifest"
    },
    margin: 48,
    size: "A4"
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  if (cjkFontPath?.trim()) doc.font(cjkFontPath.trim());
  const facts = extractReturnManifestPdfFacts(documentSnapshot, checklistSnapshot);
  const writeField = (label: string, value: string | number | null) => {
    doc.fontSize(9).text(`${label}: ${value === null || value === "" ? "-" : value}`);
  };
  doc.fontSize(18).text("Return Manifest", { align: "center" });
  doc.moveDown().fontSize(12).text("Return and attestation summary");
  writeField("Return location", facts.returnLocation);
  writeField("Scheduled return time", facts.returnScheduledAt);
  writeField("Checklist revision", facts.checklistRevisionNumber);
  writeField("Checklist revision ID", facts.checklistRevisionId);
  writeField("Checklist manifest SHA-256", facts.checklistManifestHash);
  writeField("Attestation mode", facts.attestationMode);
  writeField("Customer comments", facts.customerComments);

  doc.moveDown().fontSize(12).text("Vehicle condition and returned property");
  if (facts.items.length === 0) {
    doc.fontSize(9).text("No governed return checklist was recorded.");
  }
  for (const item of facts.items) {
    doc.moveDown(0.35).fontSize(10).text(item.itemCode || "UNKNOWN_ITEM");
    writeField("State", item.state);
    writeField("Expected quantity", item.expectedQuantity);
    writeField("Returned quantity", item.returnedQuantity);
    writeField("Remark", item.remark);
  }

  doc.moveDown().fontSize(12).text("Evidence integrity index");
  if (facts.evidence.length === 0) doc.fontSize(9).text("No customer-visible evidence.");
  for (const evidence of facts.evidence) {
    doc.moveDown(0.35).fontSize(9).text(
      `${evidence.evidencePurpose || "EVIDENCE"} / ${evidence.evidenceType || "UNKNOWN"}`
    );
    writeField("File ID", evidence.fileId);
    writeField("SHA-256", evidence.contentSha256);
  }

  doc.moveDown().fontSize(7).text("Canonical signed snapshot (audit copy)");
  doc.text(canonicalSubscriptionClosureJson(documentSnapshot as never));
  doc.moveDown(2).text("RETURN_MANIFEST_CUSTOMER_SIGNATURE");
  doc.moveDown(2).text("RETURN_MANIFEST_PLATFORM_SEAL");
  doc.end();
  return completed;
}

async function renderUnilateralAttestationPdf(
  snapshot: unknown,
  snapshotHash: string,
  sealedAt: Date,
  cjkFontPath?: string
) {
  const doc = new PDFDocument({
    autoFirstPage: true,
    compress: false,
    info: {
      CreationDate: sealedAt,
      Creator: "subscription-closure",
      ModDate: sealedAt,
      Producer: "subscription-closure",
      Title: "Platform Unilateral Return Attestation"
    },
    margin: 48,
    size: "A4"
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  if (cjkFontPath?.trim()) doc.font(cjkFontPath.trim());
  const facts = objectValue(snapshot);
  doc.fontSize(17).text("Platform Unilateral Return Attestation", { align: "center" });
  doc.moveDown().fontSize(10).text(
    "Customer refusal or absence was recorded under the governed return process. " +
      "This platform-sealed copy preserves the checklist, witness attestation and evidence authority without representing customer agreement."
  );
  doc.moveDown().fontSize(9).text(`Closure case ID: ${stringValue(facts.closureCaseId)}`);
  doc.text(`Checklist revision ID: ${stringValue(facts.checklistRevisionId)}`);
  doc.text(`Checklist manifest SHA-256: ${stringValue(facts.checklistManifestHash)}`);
  doc.text(`Attestation mode: ${stringValue(facts.attestationMode)}`);
  doc.text(`Canonical snapshot SHA-256: ${snapshotHash}`);
  doc.moveDown().fontSize(8).text("Canonical platform-sealed snapshot");
  doc.fontSize(7).text(canonicalSubscriptionClosureJson(snapshot as never));
  doc.moveDown(2).fontSize(9).text("RETURN_MANIFEST_PLATFORM_UNILATERAL_SEAL");
  doc.text(`Seal timestamp authority: ${sealedAt.toISOString()}`);
  doc.end();
  return completed;
}

async function streamBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sameJson(left: unknown, right: unknown) {
  return (
    canonicalSubscriptionClosureJson(left as never) ===
    canonicalSubscriptionClosureJson(right as never)
  );
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonScalar(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

function requiredAttestation<T>(map: ReadonlyMap<string, T>, key: string) {
  const value = map.get(key);
  if (!value) throw sourceConflict();
  return value;
}

function providerCapabilityMissing() {
  return new ConflictException({
    code: "RETURN_MANIFEST_ESIGN_PROVIDER_CAPABILITY_MISSING",
    message: "The configured e-sign provider does not support return manifests."
  });
}

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "P2002"
  );
}

function sourceConflict() {
  return new ConflictException({
    code: "SUBSCRIPTION_CLOSURE_SOURCE_CONFLICT",
    message: "Return-manifest authority conflicts with its immutable source."
  });
}
