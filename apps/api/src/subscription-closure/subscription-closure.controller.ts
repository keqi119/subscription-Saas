import {
  Body,
  Controller,
  Get,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
  UsePipes,
  ValidationPipe
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { type AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import type { AppendCostServiceCommand } from "../asset-accounting/asset-accounting.service";
import type { AssetAccountingSnapshotObject } from "../asset-accounting/asset-accounting.types";
import type { AppendEvidenceServiceCommand } from "../asset-operations/asset-operations.service";
import type { AssetOperationSnapshot } from "../asset-operations/asset-operations.types";
import {
  CancelEarlyTerminationDto,
  ClosureCaseQueryDto,
  ClosureInspectionDto,
  ConfirmClosurePhysicalReceiptDto,
  DecideRecoveryApprovalDto,
  ExecuteEarlyTerminationDto,
  ExecuteRecoveryDto,
  InitiateEarlyTerminationDto,
  ManagedSettlementDto,
  RecordRecoveryExecutionDto,
  RecoveryActionDto,
  ReleaseClosureInventoryDto,
  RequestRecoveryApprovalDto
} from "./subscription-closure.dto";
import { SubscriptionClosureProjectionService } from "./subscription-closure.projection";
import { SubscriptionClosureService } from "./subscription-closure.service";

@Controller("subscription-closures")
@UseGuards(AuthGuard, PermissionsGuard)
@UsePipes(new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }))
export class SubscriptionClosureController {
  constructor(
    private readonly service: SubscriptionClosureService,
    private readonly projection: SubscriptionClosureProjectionService,
    @Optional() private readonly config?: ConfigService
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

  @Post("orders/:orderId/physical-receipt")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_RECEIVE)
  confirmPhysicalReceipt(
    @Param("orderId", uuidPipe()) orderId: string,
    @Body() dto: ConfirmClosurePhysicalReceiptDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.confirmManagedPhysicalReceipt(
      {
        actorId: request.user.id,
        checklist: dto.checklist,
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
  recordInspection(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ClosureInspectionDto,
    @Req() request: AuthenticatedRequest
  ) {
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
  releaseInventory(
    @Param("id", uuidPipe()) closureCaseId: string,
    @Body() dto: ReleaseClosureInventoryDto,
    @Req() request: AuthenticatedRequest
  ) {
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
  proposeSettlement(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.proposeManagedSettlement(settlementInput(id, dto, request));
  }

  @Post(":id/settlements/finalize")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  finalizeSettlement(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.finalizeManagedSettlement(settlementInput(id, dto, request));
  }

  @Post(":id/settlements/settle")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_CLOSURE_SETTLE)
  settle(
    @Param("id", uuidPipe()) id: string,
    @Body() dto: ManagedSettlementDto,
    @Req() request: AuthenticatedRequest
  ) {
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
