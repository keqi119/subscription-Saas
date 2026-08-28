import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Req, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AssignExternalOperatorDto,
  AssignInternalOperatorDto,
  AttachFieldEvidenceFileDto,
  CreateHandoverWorkOrderDto,
  DecideStage2RegistrationExceptionDto,
  HandoverObjectionActionDto,
  HandoverObjectionResubmissionDto,
  OpsReviewDto,
  RequestStage2RegistrationExceptionDto,
  StartAdminStage2ESignDto,
  Stage2WorkflowRecoveryResultDto,
  UpdateHandoverFieldFactsDto,
  VoidStage2HandoverESignDto,
  VoidHandoverWorkOrderDto
} from "./handover-work-order.dto";
import { HandoverWorkOrderService } from "./handover-work-order.service";
import { Stage2HandoverESignService } from "./stage2-handover-esign.service";
import { Stage2HandoverRegistrationExceptionService } from "./stage2-handover-registration-exception.service";
import { Stage2HandoverWorkflowService } from "./stage2-handover-workflow.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class HandoverWorkOrderAdminController {
  constructor(
    private readonly handoverWorkOrderService: HandoverWorkOrderService,
    private readonly stage2HandoverESignService: Stage2HandoverESignService,
    private readonly registrationExceptionService: Stage2HandoverRegistrationExceptionService,
    private readonly stage2HandoverWorkflowService: Stage2HandoverWorkflowService
  ) {}

  @Post("orders/:orderId/handover-work-orders")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  createWorkOrder(
    @Param("orderId") orderId: string,
    @Body() dto: CreateHandoverWorkOrderDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.createDraft(
      orderId,
      dto.handoverType ?? "DELIVERY_OUTBOUND",
      request.user.id
    );
  }

  @Get("orders/:orderId/handover-work-orders")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  listWorkOrders(@Param("orderId") orderId: string) {
    return this.handoverWorkOrderService.listByOrder(orderId);
  }

  @Get("handover-work-orders/review-queue")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  listAdminReviewQueue() {
    return this.handoverWorkOrderService.listAdminReviewQueue();
  }

  @Get("handover-work-orders/:id")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getWorkOrder(@Param("id") id: string) {
    return this.handoverWorkOrderService.getById(id);
  }

  @Get("handover-work-orders/:id/evidence-files/:evidenceFileId/preview")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  async previewEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.handoverWorkOrderService.previewEvidenceFile(id, evidenceFileId);
    setEvidenceFileHeaders(response, preview, "inline");
    return new StreamableFile(preview.stream);
  }

  @Get("handover-work-orders/:id/evidence-files/:evidenceFileId/download")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  async downloadEvidenceFile(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.handoverWorkOrderService.downloadEvidenceFile(id, evidenceFileId);
    setEvidenceFileHeaders(response, file, "attachment");
    return new StreamableFile(file.stream);
  }

  @Post("handover-work-orders/:id/evidence-files/:evidenceFileId/prepare-artifacts")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  prepareEvidenceFileArtifacts(
    @Param("id") id: string,
    @Param("evidenceFileId") evidenceFileId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.prepareExistingEvidenceFileArtifacts(
      id,
      evidenceFileId,
      request.user.id
    );
  }

  @Post("handover-work-orders/:id/assign-internal")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  assignInternal(
    @Param("id") id: string,
    @Body() dto: AssignInternalOperatorDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.assignInternalOperator(id, dto.userId, request.user.id);
  }

  @Post("handover-work-orders/:id/assign-external")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  assignExternal(
    @Param("id") id: string,
    @Body() dto: AssignExternalOperatorDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.assignExternalOperator(id, dto, request.user.id);
  }

  @Post("handover-work-orders/:id/revoke-external-access")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  revokeExternal(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.handoverWorkOrderService.revokeExternalAccess(id, request.user.id);
  }

  @Post("handover-work-orders/:id/void")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  voidWorkOrder(
    @Param("id") id: string,
    @Body() dto: VoidHandoverWorkOrderDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.voidOrCancel(
      id,
      dto.status ?? "VOIDED",
      request.user.id,
      dto.reason
    );
  }

  @Get("handover-work-orders/:id/readiness")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getReadiness(@Param("id") id: string) {
    return this.handoverWorkOrderService.getReadiness(id);
  }

  @Get("handover-work-orders/:id/registration-exception")
  @RequirePermissions(
    PermissionCode.DELIVERY_VIEW,
    PermissionCode.BUSINESS_EXCEPTION_VIEW
  )
  getRegistrationException(@Param("id") id: string) {
    return this.registrationExceptionService.getState(id);
  }

  @Post("handover-work-orders/:id/registration-exception/request")
  @RequirePermissions(
    PermissionCode.DELIVERY_PREPARE,
    PermissionCode.BUSINESS_EXCEPTION_REQUEST
  )
  requestRegistrationException(
    @Param("id") id: string,
    @Body() dto: RequestStage2RegistrationExceptionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.registrationExceptionService.request(
      id,
      dto.reason,
      registrationExceptionContext(request)
    );
  }

  @Post("handover-work-orders/:id/registration-exception/:approvalId/decide")
  @RequirePermissions(
    PermissionCode.DELIVERY_CONFIRM,
    PermissionCode.BUSINESS_EXCEPTION_APPROVE
  )
  decideRegistrationException(
    @Param("id") id: string,
    @Param("approvalId") approvalId: string,
    @Body() dto: DecideStage2RegistrationExceptionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.registrationExceptionService.decide(
      id,
      approvalId,
      dto,
      registrationExceptionContext(request)
    );
  }

  @Get("handover-work-orders/:id/pdf")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getStage2HandoverPdf(@Param("id") id: string) {
    return this.handoverWorkOrderService.getStage2HandoverPdf(id);
  }

  @Post("handover-work-orders/:id/pdf")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  generateStage2HandoverPdf(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.handoverWorkOrderService.generateStage2HandoverPdf(id, request.user.id);
  }

  @Get("handover-work-orders/:id/pdf/download")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  async downloadStage2HandoverPdf(
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const file = await this.handoverWorkOrderService.downloadStage2HandoverPdf(id);
    setEvidenceFileHeaders(response, file, "attachment");
    return new StreamableFile(file.stream);
  }

  @Get("handover-work-orders/:id/esign")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getStage2ESign(@Param("id") id: string) {
    return this.stage2HandoverESignService.getStatus(id);
  }

  @Post("handover-work-orders/:id/esign")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  createStage2ESign(
    @Param("id") id: string,
    @Body() dto: StartAdminStage2ESignDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.stage2HandoverESignService.create(
      id,
      {
        actorId: request.user.id,
        actorType: "ADMIN_FALLBACK"
      },
      dto
    );
  }

  @Post("handover-work-orders/:id/esign/platform-seal/retry")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  retryStage2PlatformSeal(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.stage2HandoverESignService.retryPlatformSeal(id, request.user.id);
  }

  @Post("handover-work-orders/:id/esign/archive/retry")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  retryStage2Archive(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.stage2HandoverESignService.retryArchive(id, request.user.id);
  }

  @Post("handover-work-orders/:id/esign/void")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  voidStage2ESign(
    @Param("id") id: string,
    @Body() dto: VoidStage2HandoverESignDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.stage2HandoverESignService.voidTask(
      id,
      request.user.id,
      dto.reason
    );
  }

  @Get("handover-work-orders/:id/esign/signed-document")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getStage2SignedDocument(@Param("id") id: string) {
    return this.stage2HandoverESignService.getSignedDocumentState(id);
  }

  @Get("handover-work-orders/:id/esign/signed-document/download")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  async downloadStage2SignedDocument(
    @Param("id") id: string,
    @Res({ passthrough: true }) response: Response
  ) {
    const file =
      await this.handoverWorkOrderService.downloadStage2SignedHandoverPdf(id);
    setEvidenceFileHeaders(response, file, "attachment");
    return new StreamableFile(file.stream);
  }

  @Post("handover-work-orders/:id/workflow-jobs/:jobId/retry")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  retryStage2WorkflowJob(
    @Param("id") id: string,
    @Param("jobId") jobId: string,
    @Req() request: AuthenticatedRequest
  ): Promise<Stage2WorkflowRecoveryResultDto> {
    return this.stage2HandoverWorkflowService.retryDeadLetterJob(id, jobId, request.user.id);
  }

  @Post("handover-work-orders/:id/workflow/reconcile-customer")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  reconcileStage2CustomerSignature(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ): Promise<Stage2WorkflowRecoveryResultDto> {
    return this.stage2HandoverWorkflowService.reconcileCustomerSignature(id, request.user.id);
  }

  @Post("handover-work-orders/:id/ops-review/pending")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  markOpsReviewPending(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.handoverWorkOrderService.markOpsReviewPending(id, request.user.id);
  }

  @Post("handover-work-orders/:id/ops-review/approve")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  approveOpsReview(@Param("id") id: string, @Body() dto: OpsReviewDto, @Req() request: AuthenticatedRequest) {
    return this.handoverWorkOrderService.markOpsReviewApproved(id, request.user.id, dto.notes);
  }

  @Post("handover-work-orders/:id/ops-review/reject")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  rejectOpsReview(@Param("id") id: string, @Body() dto: OpsReviewDto, @Req() request: AuthenticatedRequest) {
    return this.handoverWorkOrderService.markOpsReviewRejected(id, request.user.id, dto.notes);
  }

  @Post("handover-work-orders/:id/objection/acknowledge")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  acknowledgeCustomerObjection(
    @Param("id") id: string,
    @Body() dto: HandoverObjectionActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.acknowledgeCustomerObjection(id, request.user.id, dto.note);
  }

  @Post("handover-work-orders/:id/objection/request-resubmission")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  requestCustomerObjectionResubmission(
    @Param("id") id: string,
    @Body() dto: HandoverObjectionResubmissionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.requestCustomerObjectionResubmission(id, request.user.id, dto);
  }

  @Post("handover-work-orders/:id/objection/send-customer-review")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  sendCustomerObjectionBackToReview(
    @Param("id") id: string,
    @Body() dto: HandoverObjectionActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.sendCustomerObjectionBackToReview(id, request.user.id, dto.note);
  }

  @Post("handover-work-orders/:id/reopen-confirmed-review")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  reopenConfirmedReview(
    @Param("id") id: string,
    @Body() dto: HandoverObjectionActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.handoverWorkOrderService.reopenConfirmedReview(
      id,
      request.user.id,
      dto.note
    );
  }
}

@Controller()
export class HandoverWorkOrderFieldController {
  constructor(private readonly handoverWorkOrderService: HandoverWorkOrderService) {}

  @Get("field/handover/:token")
  getExternalTask(@Param("token") token: string) {
    return this.handoverWorkOrderService.verifyExternalAccess(token);
  }

  @Post("field/handover/:token/start")
  startExternalTask(@Param("token") token: string) {
    return this.handoverWorkOrderService.startFieldWorkByToken(token);
  }

  @Patch("field/handover/:token/facts")
  updateExternalFacts(@Param("token") token: string, @Body() dto: UpdateHandoverFieldFactsDto) {
    return this.handoverWorkOrderService.updateFieldFactsByToken(token, dto);
  }

  @Post("field/handover/:token/evidence/:itemId/files")
  attachExternalEvidenceFile(
    @Param("token") token: string,
    @Param("itemId") itemId: string,
    @Body() dto: AttachFieldEvidenceFileDto
  ) {
    return this.handoverWorkOrderService.attachEvidenceFileWithExternalToken(token, itemId, dto);
  }

  @Post("field/handover/:token/submit")
  submitExternalEvidence(@Param("token") token: string) {
    return this.handoverWorkOrderService.submitEvidenceByToken(token);
  }
}

function setEvidenceFileHeaders(
  response: Response,
  file: { filename: string; mimeType: null | string; sizeBytes: null | number },
  disposition: "attachment" | "inline"
) {
  if (file.mimeType) {
    response.setHeader("Content-Type", file.mimeType);
  }
  if (file.sizeBytes !== null) {
    response.setHeader("Content-Length", String(file.sizeBytes));
  }
  response.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
}

function registrationExceptionContext(request: AuthenticatedRequest) {
  const keys: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      keys.push(request.rawHeaders[index + 1]!);
    }
  }
  if (keys.length !== 1 || keys[0]!.trim().length === 0) {
    throw new BadRequestException({
      code: "STAGE2_REGISTRATION_IDEMPOTENCY_KEY_REQUIRED",
      message: "Exactly one nonblank Idempotency-Key header is required."
    });
  }
  const userAgent = request.headers["user-agent"];
  return {
    actorId: request.user.id,
    idempotencyKey: keys[0]!,
    ipAddress: request.ip,
    permissions: [...request.user.permissions],
    userAgent: typeof userAgent === "string" ? userAgent : undefined
  };
}
