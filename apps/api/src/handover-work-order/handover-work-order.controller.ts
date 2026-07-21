import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AssignExternalOperatorDto,
  AssignInternalOperatorDto,
  AttachFieldEvidenceFileDto,
  CreateHandoverWorkOrderDto,
  OpsReviewDto,
  UpdateHandoverFieldFactsDto,
  VoidHandoverWorkOrderDto
} from "./handover-work-order.dto";
import { HandoverWorkOrderService } from "./handover-work-order.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class HandoverWorkOrderAdminController {
  constructor(private readonly handoverWorkOrderService: HandoverWorkOrderService) {}

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

  @Get("handover-work-orders/:id")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getWorkOrder(@Param("id") id: string) {
    return this.handoverWorkOrderService.getById(id);
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
