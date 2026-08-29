import {
  Body,
  Controller,
  Get,
  Header,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { type AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import type { AppendCostServiceCommand } from "../asset-accounting/asset-accounting.service";
import type { AssetAccountingSnapshotObject } from "../asset-accounting/asset-accounting.types";
import type { AppendEvidenceServiceCommand } from "../asset-operations/asset-operations.service";
import type { AssetOperationSnapshot } from "../asset-operations/asset-operations.types";
import type { UploadedMaterialFile } from "../customer/customer.service";
import { createUtf8MultipartOptions } from "../upload/multipart-upload-options";
import {
  CaptureReturnChecklistDto,
  CancelReturnManifestSigningDto,
  CancelEarlyTerminationDto,
  ClosureCaseQueryDto,
  CompleteClosureOperationsDto,
  CreateClosurePricingDto,
  ClosureInspectionDto,
  ConfirmReturnDeltaDto,
  ConfirmClosurePhysicalReceiptDto,
  DecideRecoveryApprovalDto,
  DecideClosureApprovalDto,
  DecideClosureDisputeDto,
  ExecuteEarlyTerminationDto,
  ExecuteRecoveryDto,
  GenerateReturnDeltaDto,
  InitiateEarlyTerminationDto,
  ManagedSettlementDto,
  RecordRecoveryExecutionDto,
  RecordClosureDispositionDto,
  RecordClosureLegalEventDto,
  RecordClosureNoResponseDto,
  RecoveryActionDto,
  ReleaseClosureInventoryDto,
  RequestRecoveryApprovalDto,
  RequestClosureApprovalDto,
  TransferClosureLegalCollectionDto,
  UploadReturnEvidenceDto
} from "./subscription-closure.dto";
import { SubscriptionClosureEvidencePackageService } from "./subscription-closure-evidence-package.service";
import { SubscriptionClosureProjectionService } from "./subscription-closure.projection";
import { SubscriptionClosureService } from "./subscription-closure.service";
import { SubscriptionReturnGovernanceService } from "./subscription-return-governance.service";

@Controller("subscription-closures")
@UseGuards(AuthGuard, PermissionsGuard)
@UsePipes(new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }))
export class SubscriptionClosureController {
  constructor(
    private readonly service: SubscriptionClosureService,
    private readonly projection: SubscriptionClosureProjectionService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly returnGovernance?: SubscriptionReturnGovernanceService,
    @Optional() private readonly evidencePackages?: SubscriptionClosureEvidencePackageService
  ) {}

  @Get(":id")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  getCase(@Param("id", uuidPipe()) id: string) {
    return this.projection.getAdminById(id);
  }

  @Get("by-order/:orderId")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  getByOrder(@Param("orderId", uuidPipe()) orderId: string) {
    return this.projection.getAdminByOrder(orderId);
  }

  @Get()
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  listCases(@Query() query: ClosureCaseQueryDto) {
    return this.projection.listAdmin(query);
  }

  @Post(":id/return-checklists")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE)
  captureReturnChecklist(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: CaptureReturnChecklistDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().captureChecklist(
      closureCaseId,
      {
        attestationEvidenceIds: dto.attestationEvidenceIds ?? [],
        attestationMode: dto.attestationMode,
        attestationReason: dto.attestationReason ?? null,
        capturedAt: new Date(dto.capturedAt),
        customerComments: dto.customerComments ?? null,
        idempotencyKey: dto.idempotencyKey,
        items: dto.items,
        witnesses: dto.witnesses ?? []
      },
      request.user.id
    );
  }

  @Post(":id/return-manifest-signing/cancel")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE)
  cancelReturnManifestSigning(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: CancelReturnManifestSigningDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().cancelReturnManifestSigning(
      closureCaseId,
      {
        idempotencyKey: dto.idempotencyKey,
        reason: dto.reason
      },
      request.user.id
    );
  }

  @Post(":id/return-evidence/upload")
  @UseInterceptors(
    AnyFilesInterceptor(createUtf8MultipartOptions({ limits: { files: 1, fileSize: 20 * 1024 * 1024 } }))
  )
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE)
  uploadReturnEvidence(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: UploadReturnEvidenceDto,
    @UploadedFiles() files: UploadedMaterialFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    const uploaded = (files ?? [])[0];
    const file =
      uploaded?.buffer && uploaded.mimetype && uploaded.originalname && uploaded.size !== undefined
        ? {
            buffer: uploaded.buffer,
            mimetype: uploaded.mimetype,
            originalname: uploaded.originalname,
            size: uploaded.size
          }
        : undefined;
    return this.governance().uploadEvidence(
      closureCaseId,
      {
        capturedAt: new Date(dto.capturedAt),
        evidenceType: dto.evidenceType,
        idempotencyKey: dto.idempotencyKey,
        supersedesEvidenceId: dto.supersedesEvidenceId ?? null,
        targetId: dto.targetId,
        targetType: dto.targetType,
        visibility: dto.visibility
      },
      file,
      request.user.id
    );
  }

  @Post(":id/financial-proofs/upload")
  @UseInterceptors(
    AnyFilesInterceptor(createUtf8MultipartOptions({ limits: { files: 1, fileSize: 20 * 1024 * 1024 } }))
  )
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  uploadFinancialProof(
    @Param("id", uuidPipe()) closureCaseId: string,
    @UploadedFiles() files: UploadedMaterialFile[] | undefined,
    @Req() request: AuthenticatedRequest
  ) {
    const uploaded = (files ?? [])[0];
    const file =
      uploaded?.buffer && uploaded.mimetype && uploaded.originalname && uploaded.size !== undefined
        ? {
            buffer: uploaded.buffer,
            mimetype: uploaded.mimetype,
            originalname: uploaded.originalname,
            size: uploaded.size
          }
        : undefined;
    return this.governance().uploadFinancialProof(
      closureCaseId,
      file,
      request.user.id
    );
  }

  @Get(":id/return-evidence/:linkId/preview")
  @Header("X-Content-Type-Options", "nosniff")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  async previewReturnEvidence(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("linkId", uuidPipe()) linkId: string
  ) {
    const file = await this.governance().getEvidenceObject(closureCaseId, linkId);
    return streamFile(file, "inline");
  }

  @Get(":id/return-evidence/:linkId/download")
  @Header("X-Content-Type-Options", "nosniff")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  async downloadReturnEvidence(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("linkId", uuidPipe()) linkId: string
  ) {
    const file = await this.governance().getEvidenceObject(closureCaseId, linkId);
    return streamFile(file, "attachment");
  }

  @Post(":id/return-deltas")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_INSPECT)
  generateReturnDelta(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: GenerateReturnDeltaDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().generateDelta(
      closureCaseId,
      {
        idempotencyKey: dto.idempotencyKey
      },
      request.user.id
    );
  }

  @Post(":id/return-deltas/confirm")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_INSPECT)
  confirmReturnDelta(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ConfirmReturnDeltaDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().confirmDelta(
      closureCaseId,
      {
        baseRevisionId: dto.baseRevisionId,
        decisions: dto.decisions,
        idempotencyKey: dto.idempotencyKey
      },
      request.user.id
    );
  }

  @Post(":id/pricing")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  createPricing(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: CreateClosurePricingDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().createPricing(
      closureCaseId,
      {
        finalize: dto.finalize,
        idempotencyKey: dto.idempotencyKey,
        lines: dto.lines.map((line) => ({
          chargeType: line.chargeType,
          clauseSnapshotId: line.clauseSnapshotId ?? null,
          deltaItemId: line.deltaItemId ?? null,
          evidenceIds: line.evidenceIds,
          exceptionApprovalId: line.exceptionApprovalId ?? null,
          lineCode: line.lineCode,
          manualBasis: line.manualBasis ?? null,
          manualUnitPriceCents: line.manualUnitPriceCents ?? null,
          quantity: line.quantity,
          responsibility: line.responsibility
        })),
        settlementRevisionId: dto.settlementRevisionId
      },
      request.user.id
    );
  }

  @Post(":id/approval-requests")
  @RequirePermissions(PermissionCode.BUSINESS_EXCEPTION_REQUEST)
  requestClosureApproval(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RequestClosureApprovalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().requestApproval(
      closureCaseId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/approvals/:approvalId/decision")
  @RequirePermissions(PermissionCode.BUSINESS_EXCEPTION_APPROVE)
  decideClosureApproval(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("approvalId", uuidPipe()) approvalId: string,
    @Body() dto: DecideClosureApprovalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().decideApproval(
      closureCaseId,
      approvalId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/receivable-dispositions")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  recordDisposition(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RecordClosureDispositionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().recordDisposition(
      closureCaseId,
      {
        approvalId: dto.approvalId ?? null,
        billId: dto.billId,
        chargeLineId: dto.chargeLineId ?? null,
        detail: dto.detail,
        disposition: dto.disposition,
        idempotencyKey: dto.idempotencyKey,
        ownerId: dto.ownerId ?? null,
        ownerType: dto.ownerType,
        proofFileId: dto.proofFileId ?? null
      },
      request.user.id
    );
  }

  @Post(":id/customer-no-response")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  recordCustomerNoResponse(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RecordClosureNoResponseDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().recordNoResponse(
      closureCaseId,
      {
        deadlineAt: new Date(dto.deadlineAt),
        idempotencyKey: dto.idempotencyKey,
        settlementHash: dto.settlementHash,
        settlementRevisionId: dto.settlementRevisionId
      },
      request.user.id
    );
  }

  @Post(":id/disputes/:disputeId/decision")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  decideChargeDispute(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("disputeId", uuidPipe()) disputeId: string,
    @Body() dto: DecideClosureDisputeDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().decideDispute(
      closureCaseId,
      disputeId,
      {
        decision: dto.decision,
        evidenceIds: dto.evidenceIds,
        idempotencyKey: dto.idempotencyKey,
        occurredAt: new Date(dto.occurredAt),
        rationale: dto.rationale
      },
      request.user.id
    );
  }

  @Post(":id/legal-collection")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  transferLegalCollection(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: TransferClosureLegalCollectionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().transferLegalCollection(
      closureCaseId,
      {
        billId: dto.billId,
        evidencePackageHash: dto.evidencePackageHash,
        externalReference: dto.externalReference ?? null,
        idempotencyKey: dto.idempotencyKey,
        openedAt: new Date(dto.openedAt),
        ownerId: dto.ownerId,
        ownerType: dto.ownerType
      },
      request.user.id
    );
  }

  @Post(":id/legal-collection/events")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  recordLegalCollectionEvent(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RecordClosureLegalEventDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().recordLegalCollectionEvent(
      closureCaseId,
      {
        amountCents: dto.amountCents ? BigInt(dto.amountCents) : null,
        detail: dto.detail,
        eventType: dto.eventType,
        idempotencyKey: dto.idempotencyKey,
        legalCaseId: dto.legalCaseId,
        occurredAt: new Date(dto.occurredAt),
        proofFileId: dto.proofFileId ?? null
      },
      request.user.id
    );
  }

  @Post(":id/operational-completion")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  completeOperations(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: CompleteClosureOperationsDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.governance().completeOperations(
      closureCaseId,
      { idempotencyKey: dto.idempotencyKey, occurredAt: new Date(dto.occurredAt) },
      request.user.id
    );
  }

  @Post(":id/evidence-packages")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  async exportEvidencePackage(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(closureCaseId);
    return this.packages().export(closureCaseId, request.user.id);
  }

  @Get(":id/evidence-packages/:exportId/download")
  @Header("X-Content-Type-Options", "nosniff")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  async downloadEvidencePackage(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("exportId", uuidPipe()) exportId: string
  ) {
    const file = await this.packages().getObject(closureCaseId, exportId);
    return streamFile(file, "attachment");
  }

  @Get(":id/return-manifest/signed-document/preview")
  @Header("X-Content-Type-Options", "nosniff")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_VIEW)
  async previewSignedReturnManifest(@Param("id", uuidPipe()) closureCaseId: string) {
    const file = await this.governance().getSignedReturnManifestObject(closureCaseId);
    return streamFile(file, "inline");
  }

  @Post("orders/:orderId/physical-receipt")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE)
  async confirmPhysicalReceipt(
    @Param("orderId", uuidPipe()) orderId: string,
    @Body() dto: ConfirmClosurePhysicalReceiptDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowedByOrder(orderId);
    return this.service.confirmManagedPhysicalReceipt(
      {
        actorId: request.user.id,
        checklistManifestHash: dto.checklistManifestHash,
        checklistRevisionId: dto.checklistRevisionId,
        damages: dto.damages,
        orderId,
        physicalControlMode: dto.physicalControlMode,
        remark: dto.remark ?? null,
        returnMileageKm: dto.returnMileageKm,
        returnType: dto.returnType,
        returnedAt: new Date(dto.returnedAt)
      },
      requestContext(request)
    );
  }

  @Post(":id/inspection")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_INSPECT)
  async recordInspection(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ClosureInspectionDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(closureCaseId);
    return this.service.recordManagedReturnInspection(
      {
        accepted: dto.accepted,
        actorId: request.user.id,
        closureCaseId,
        costs: dto.costs.map(costCommand),
        evidence: dto.evidence.map((item) => evidenceCommand(item, new Date(dto.occurredAt))),
        occurredAt: new Date(dto.occurredAt),
        reconditioningRequired: dto.reconditioningRequired
      },
      requestContext(request)
    );
  }

  @Post(":id/inventory-release")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  async releaseInventory(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ReleaseClosureInventoryDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(closureCaseId);
    return this.service.releaseManagedReturnInventory(
      {
        actorId: request.user.id,
        closureCaseId,
        occurredAt: new Date(dto.occurredAt),
        releaseReason: dto.releaseReason
      },
      requestContext(request)
    );
  }

  @Post(":id/settlements/propose")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  async proposeSettlement(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(id);
    return this.service.proposeManagedSettlement(settlementInput(id, dto, request));
  }

  @Post(":id/settlements/finalize")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  async finalizeSettlement(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(id);
    return this.service.finalizeManagedSettlement(settlementInput(id, dto, request));
  }

  @Post(":id/settlements/settle")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  async settle(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    await this.governance().assertThreeStageWriteAllowed(id);
    return this.service.settleManagedSettlement(settlementInput(id, dto, request));
  }

  @Post(":id/recovery/actions")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_RECOVERY_ASSESS)
  actOnRecovery(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RecoveryActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.actOnRecovery({
      ...dto,
      actorId: request.user.id,
      closureCaseId,
      occurredAt: new Date(dto.occurredAt)
    });
  }

  @Post(":id/recovery/approval-requests")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_RECOVERY_ASSESS)
  requestRecoveryApproval(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RequestRecoveryApprovalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.requestRecoveryExecutionApproval({
      ...dto,
      actorId: request.user.id,
      closureCaseId,
      requestedAt: new Date(dto.requestedAt)
    });
  }

  @Post(":id/recovery/approvals/:approvalId/decision")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_RECOVERY_APPROVE)
  decideRecoveryApproval(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Param("approvalId", uuidPipe()) approvalId: string,
    @Body() dto: DecideRecoveryApprovalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.decideRecoveryExecutionApproval({
      ...dto,
      actorId: request.user.id,
      approvalId,
      closureCaseId,
      decidedAt: new Date(dto.decidedAt)
    });
  }

  @Post(":id/recovery/execute")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_RECOVERY_EXECUTE)
  executeRecovery(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ExecuteRecoveryDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.executeApprovedRecovery({
      ...dto,
      actorId: request.user.id,
      closureCaseId,
      occurredAt: new Date(dto.occurredAt)
    });
  }

  @Post(":id/recovery/execution-records")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_RECOVERY_EXECUTE)
  recordRecoveryExecution(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: RecordRecoveryExecutionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.recordRecoveryExecution({
      actorId: request.user.id,
      closureCaseId,
      costs: dto.costs.map(costCommand),
      evidence: dto.evidence.map((item) => evidenceCommand(item, new Date(dto.occurredAt))),
      idempotencyKey: dto.idempotencyKey,
      occurredAt: new Date(dto.occurredAt)
    });
  }

  @Post("early-terminations")
  @RequirePermissions(
    PermissionCode.SUBSCRIPTION_CLOSURE_PREPARE,
    PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_CREATE
  )
  initiateEarlyTermination(
    @Body() dto: InitiateEarlyTerminationDto,
    @Req() request: AuthenticatedRequest
  ) {
    assertLegacyEarlyTerminationEnabled(this.config);
    return this.service.initiateEarlyTermination({
      ...dto,
      actorId: request.user.id,
      effectiveAt: new Date(dto.effectiveAt)
    });
  }

  @Post(":id/early-termination/cancel")
  @RequirePermissions(
    PermissionCode.SUBSCRIPTION_CLOSURE_PREPARE,
    PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_CREATE
  )
  cancelEarlyTermination(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: CancelEarlyTerminationDto,
    @Req() request: AuthenticatedRequest
  ) {
    assertLegacyEarlyTerminationEnabled(this.config);
    return this.service.cancelEarlyTermination({ ...dto, actorId: request.user.id, closureCaseId });
  }

  @Post(":id/early-termination/execute")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_EARLY_TERMINATION_EXECUTE)
  executeEarlyTermination(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ExecuteEarlyTerminationDto,
    @Req() request: AuthenticatedRequest
  ) {
    assertLegacyEarlyTerminationEnabled(this.config);
    return this.service.executeEarlyTermination({
      ...dto,
      actorId: request.user.id,
      closureCaseId
    });
  }

  private governance() {
    if (!this.returnGovernance) throw new ServiceUnavailableException("Return governance unavailable.");
    return this.returnGovernance;
  }

  private packages() {
    if (!this.evidencePackages) throw new ServiceUnavailableException("Evidence package unavailable.");
    return this.evidencePackages;
  }
}

function assertLegacyEarlyTerminationEnabled(config?: ConfigService) {
  if (config?.get<string>("SUBSCRIPTION_EARLY_TERMINATION_ENABLED") === "true") return;
  throw new ServiceUnavailableException({
    code: "SUBSCRIPTION_EARLY_TERMINATION_DISABLED",
    message: "Early termination is disabled in this environment."
  });
}

function settlementInput(
  closureCaseId: string,
  dto: ManagedSettlementDto,
  request: AuthenticatedRequest
) {
  return {
    actorId: request.user.id,
    closureCaseId,
    idempotencyKey: dto.idempotencyKey,
    occurredAt: new Date(dto.occurredAt),
    waiverApprovalId: dto.waiverApprovalId ?? null,
    writeOffApprovalId: dto.writeOffApprovalId ?? null
  };
}

function evidenceCommand(
  dto: import("./subscription-closure.dto").ClosureEvidenceDto,
  occurredAt: Date
): Omit<AppendEvidenceServiceCommand, "source" | "workOrderId"> {
  return {
    action: dto.action,
    capturedAt: dto.capturedAt ? new Date(dto.capturedAt) : null,
    captureMetadata: (dto.captureMetadata as AssetOperationSnapshot | undefined) ?? null,
    contentSha256: dto.contentSha256 ?? null,
    eventId: dto.eventId ?? null,
    evidenceType: dto.evidenceType,
    fileId: dto.fileId ?? null,
    occurredAt,
    supersedesEvidenceId: dto.supersedesEvidenceId ?? null
  };
}

function costCommand(
  dto: import("./subscription-closure.dto").ClosureCostDto
): Omit<
  AppendCostServiceCommand,
  "contractId" | "customerId" | "orderId" | "source" | "vehicleId" | "workOrderId"
> {
  return {
    actionType: dto.actionType,
    accountingPeriod: dto.accountingPeriod,
    amountCents: BigInt(dto.amountCents),
    assetOwnerId: dto.assetOwnerId ?? null,
    assetOwnerSnapshot:
      (dto.assetOwnerSnapshot as AssetAccountingSnapshotObject | undefined) ?? null,
    confirmedAt: new Date(dto.confirmedAt),
    costCategory: dto.costCategory,
    evidenceId: dto.evidenceId ?? null,
    evidenceSnapshot: (dto.evidenceSnapshot as AssetAccountingSnapshotObject | undefined) ?? null,
    occurredOn: new Date(dto.occurredOn),
    reason: dto.reason,
    responsiblePartyId: dto.responsiblePartyId ?? null,
    responsiblePartyType: dto.responsiblePartyType,
    responsibilitySnapshot: dto.responsibilitySnapshot as AssetAccountingSnapshotObject
  };
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent:
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined
  };
}

function uuidPipe() {
  return new ParseUUIDPipe({ version: "4" });
}

function streamFile(
  file: Readonly<{
    contentLength: number;
    mimeType: string;
    originalName: string;
    stream: import("node:stream").Readable;
  }>,
  disposition: "attachment" | "inline"
) {
  return new StreamableFile(file.stream, {
    disposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    length: file.contentLength,
    type: file.mimeType
  });
}
