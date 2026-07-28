import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Response } from "express";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AddDamageCloseupDto,
  AttachDeliveryEvidenceFileDto,
  DeclareNoVisibleDamageDto,
  RejectDeliveryEvidenceDto
} from "../delivery-evidence/delivery-evidence.dto";
import { CustomerESignOnboardingService } from "../esign/customer-esign-onboarding.service";
import {
  ArchiveContractDto,
  CancelOrderDto,
  ConsumeEntitlementDto,
  CreateContractVersionDto,
  CreateCustomerOrderDto,
  CreateOrderChangeDto,
  CreateOrderFromQuoteDto,
  ConfirmDeliveryDto,
  ConfirmReturnDto,
  EntitlementMonthlyRenewalDto,
  ExpireEntitlementsDto,
  ListContractsQueryDto,
  ListEntitlementUsagesQueryDto,
  PrepareDeliveryDto,
  PrepareReturnDto,
  ReviewOrderDto,
  UpdateContractVersionDto
} from "./dto/order.dto";
import { OrderWorkspaceService } from "./order-workspace.service";
import { OrderService } from "./order.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly onboardingService: CustomerESignOnboardingService,
    private readonly orderWorkspaceService?: OrderWorkspaceService
  ) {}

  @Get("orders")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  listOrders(@Req() request: AuthenticatedRequest) {
    return this.orderService.listOrders(request.user);
  }

  @Get("orders/review-queue")
  @RequirePermissions(PermissionCode.ORDER_REVIEW)
  listReviewQueue(@Req() request: AuthenticatedRequest) {
    return this.orderService.listReviewQueue(request.user);
  }

  @Get("orders/:id/change-options/subscription-plans")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_CREATE)
  listPlanChangeSubscriptionPlans(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.listPlanChangeSubscriptionPlans(id, request.user);
  }

  @Get("orders/:id/delivery-check")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getDeliveryCheck(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getDeliveryCheck(id, request.user);
  }

  @Get("orders/:id/delivery")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getDelivery(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getDelivery(id, request.user);
  }

  @Get("orders/:id/delivery-evidence/checklist")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getDeliveryEvidenceChecklist(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getDeliveryEvidenceChecklist(id, request.user);
  }

  @Post("orders/:id/delivery-evidence/checklist/initialize")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  initializeDeliveryEvidenceChecklist(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.initializeDeliveryEvidenceChecklist(id, request.user);
  }

  @Post("delivery-evidence/:itemId/files")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  attachDeliveryEvidenceFile(
    @Param("itemId") itemId: string,
    @Body() dto: AttachDeliveryEvidenceFileDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.attachDeliveryEvidenceFile(itemId, dto, request.user);
  }

  @Post("delivery-evidence/:itemId/approve")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  approveDeliveryEvidenceItem(@Param("itemId") itemId: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.approveDeliveryEvidenceItem(itemId, request.user);
  }

  @Post("delivery-evidence/:itemId/reject")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  rejectDeliveryEvidenceItem(
    @Param("itemId") itemId: string,
    @Body() dto: RejectDeliveryEvidenceDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.rejectDeliveryEvidenceItem(itemId, dto, request.user);
  }

  @Post("orders/:id/delivery-evidence/no-visible-damage")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  declareNoVisibleDamage(
    @Param("id") id: string,
    @Body() dto: DeclareNoVisibleDamageDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.declareNoVisibleDamage(id, dto, request.user);
  }

  @Post("orders/:id/delivery-evidence/damage-closeups")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  addDamageCloseup(
    @Param("id") id: string,
    @Body() dto: AddDamageCloseupDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.addDamageCloseup(id, dto, request.user);
  }

  @Get("orders/:id/delivery-evidence/readiness")
  @RequirePermissions(PermissionCode.DELIVERY_VIEW)
  getDeliveryEvidenceReadiness(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getDeliveryEvidenceReadiness(id, request.user);
  }

  @Get("orders/:id/return-check")
  @RequirePermissions(PermissionCode.VEHICLE_RETURN_VIEW)
  getReturnCheck(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getReturnCheck(id, request.user);
  }

  @Get("orders/:id/return")
  @RequirePermissions(PermissionCode.VEHICLE_RETURN_VIEW)
  getReturn(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getReturn(id, request.user);
  }

  @Get("orders/:id/entitlements")
  @RequirePermissions(PermissionCode.ENTITLEMENT_VIEW)
  getOrderEntitlements(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getOrderEntitlements(id, request.user);
  }

  @Get("orders/:id/entitlement-usages")
  @RequirePermissions(PermissionCode.ENTITLEMENT_VIEW)
  listOrderEntitlementUsages(
    @Param("id") id: string,
    @Query() query: ListEntitlementUsagesQueryDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.listOrderEntitlementUsages(id, query, request.user);
  }

  @Post("orders/:id/entitlements/generate")
  @RequirePermissions(PermissionCode.ENTITLEMENT_GENERATE)
  generateOrderEntitlements(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.generateOrderEntitlements(id, request.user, requestContext(request));
  }

  @Post("orders/:id/entitlements/renew-monthly")
  @RequirePermissions(PermissionCode.ENTITLEMENT_GENERATE)
  renewOrderMonthlyEntitlements(
    @Param("id") id: string,
    @Body() dto: EntitlementMonthlyRenewalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.renewOrderMonthlyEntitlements(id, dto, request.user, requestContext(request));
  }

  @Post("entitlements/monthly-renewal/generate")
  @RequirePermissions(PermissionCode.ENTITLEMENT_GENERATE)
  generateMonthlyEntitlements(
    @Body() dto: EntitlementMonthlyRenewalDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.generateMonthlyEntitlements(dto, request.user, requestContext(request));
  }

  @Post("entitlements/expire")
  @RequirePermissions(PermissionCode.ENTITLEMENT_ADJUST)
  expireEntitlements(@Body() dto: ExpireEntitlementsDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.expireEntitlements(dto, request.user, requestContext(request));
  }

  @Post("orders/:id/entitlements/:grantId/consume")
  @RequirePermissions(PermissionCode.ENTITLEMENT_CONSUME)
  consumeOrderEntitlement(
    @Param("id") id: string,
    @Param("grantId") grantId: string,
    @Body() dto: ConsumeEntitlementDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.consumeOrderEntitlement(id, grantId, dto, request.user, requestContext(request));
  }

  @Get("orders/:id")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  getOrder(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getOrder(id, request.user);
  }

  @Get("orders/:id/workspace/summary")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  getOrderWorkspaceSummary(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderWorkspaceService!.getSummary(id, request.user);
  }

  @Post("customer-orders")
  @RequirePermissions(PermissionCode.ORDER_CREATE)
  createCustomerOrder(
    @Body() dto: CreateCustomerOrderDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.createCustomerOrder(dto, request.user, requestContext(request));
  }

  @Post("orders/:id/reviews/credit")
  @RequirePermissions(PermissionCode.ORDER_REVIEW)
  reviewCredit(@Param("id") id: string, @Body() dto: ReviewOrderDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.reviewOrder(id, "credit", dto, request.user, requestContext(request));
  }

  @Post("orders/:id/reviews/product")
  @RequirePermissions(PermissionCode.ORDER_REVIEW)
  reviewProduct(@Param("id") id: string, @Body() dto: ReviewOrderDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.reviewOrder(id, "product", dto, request.user, requestContext(request));
  }

  @Post("orders/:id/reviews/vehicle")
  @RequirePermissions(PermissionCode.ORDER_REVIEW)
  reviewVehicle(@Param("id") id: string, @Body() dto: ReviewOrderDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.reviewOrder(id, "vehicle", dto, request.user, requestContext(request));
  }

  @Post("orders/:id/finalize-plan")
  @RequirePermissions(PermissionCode.ORDER_CONFIRM_FINAL_PLAN)
  finalizePlan(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.finalizePlan(id, request.user, requestContext(request));
  }

  @Post("orders/:id/reject")
  @RequirePermissions(PermissionCode.ORDER_REJECT)
  rejectCustomerOrder(@Param("id") id: string, @Body() dto: ReviewOrderDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.rejectCustomerOrder(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/customer-confirm")
  @RequirePermissions(PermissionCode.ORDER_CONFIRM_FINAL_PLAN)
  confirmCustomerOrder(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.confirmCustomerOrder(id, request.user, requestContext(request));
  }

  @Post("orders/:id/esign-onboarding/start")
  @RequirePermissions(PermissionCode.ORDER_CONFIRM_FINAL_PLAN)
  startOrderESignOnboarding(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.onboardingService.startOnboardingForOrder(id, request.user.id);
  }

  @Post("orders/from-quote/:quoteId")
  @RequirePermissions(PermissionCode.ORDER_CREATE)
  createOrderFromQuote(
    @Param("quoteId") quoteId: string,
    @Body() dto: CreateOrderFromQuoteDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.createOrderFromQuote(quoteId, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/cancel")
  @RequirePermissions(PermissionCode.ORDER_CANCEL)
  cancelOrder(@Param("id") id: string, @Body() dto: CancelOrderDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.cancelOrder(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/prepare-delivery")
  @RequirePermissions(PermissionCode.DELIVERY_PREPARE)
  prepareDelivery(@Param("id") id: string, @Body() dto: PrepareDeliveryDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.prepareDelivery(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/confirm-delivery")
  @RequirePermissions(PermissionCode.DELIVERY_CONFIRM)
  confirmDelivery(@Param("id") id: string, @Body() dto: ConfirmDeliveryDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.confirmDelivery(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/prepare-return")
  @RequirePermissions(PermissionCode.VEHICLE_RETURN_PREPARE)
  prepareReturn(@Param("id") id: string, @Body() dto: PrepareReturnDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.prepareReturn(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:id/confirm-return")
  @RequirePermissions(PermissionCode.VEHICLE_RETURN_CONFIRM)
  confirmReturn(@Param("id") id: string, @Body() dto: ConfirmReturnDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.confirmReturn(id, dto, request.user, requestContext(request));
  }

  @Post("orders/:orderId/generate-contract")
  @RequirePermissions(PermissionCode.CONTRACT_GENERATE)
  generateContract(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.generateContract(orderId, request.user, requestContext(request));
  }

  @Get("contracts")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  listContracts(@Query() query: ListContractsQueryDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.listContracts(request.user, query);
  }

  @Get("contracts/:id")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  getContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getContract(id, request.user);
  }

  @Get("contracts/:id/generated-pdf/preview")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  async previewGeneratedContractPdf(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ) {
    const preview = await this.orderService.previewGeneratedContractPdf(id, request.user);
    response.setHeader("Content-Type", preview.mimeType ?? "application/pdf");
    response.setHeader("Content-Length", String(preview.sizeBytes));
    response.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(preview.filename)}`
    );
    return new StreamableFile(preview.stream);
  }

  @Post("contracts/:id/sign")
  @RequirePermissions(PermissionCode.CONTRACT_SIGN)
  signContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.signContract(id, request.user, requestContext(request));
  }

  @Post("contracts/:id/archive")
  @RequirePermissions(PermissionCode.CONTRACT_ARCHIVE)
  archiveContract(
    @Param("id") id: string,
    @Body() dto: ArchiveContractDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.archiveContract(id, dto, request.user, requestContext(request));
  }

  @Post("contracts/:id/cancel")
  @RequirePermissions(PermissionCode.CONTRACT_CANCEL)
  cancelContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.cancelContract(id, request.user, requestContext(request));
  }

  @Get("contract-versions")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_VIEW)
  listContractVersions() {
    return this.orderService.listContractVersions();
  }

  @Post("contract-versions")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_CREATE)
  createContractVersion(@Body() dto: CreateContractVersionDto, @Req() request: AuthenticatedRequest) {
    return this.orderService.createContractVersion(dto, request.user, requestContext(request));
  }

  @Get("contract-versions/:id")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_VIEW)
  getContractVersion(@Param("id") id: string) {
    return this.orderService.getContractVersion(id);
  }

  @Patch("contract-versions/:id")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_UPDATE)
  updateContractVersion(
    @Param("id") id: string,
    @Body() dto: UpdateContractVersionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.updateContractVersion(id, dto, request.user, requestContext(request));
  }

  @Post("contract-versions/:id/activate")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_ACTIVATE)
  activateContractVersion(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.setContractVersionStatus(id, "ACTIVE", request.user, requestContext(request));
  }

  @Post("contract-versions/:id/deactivate")
  @RequirePermissions(PermissionCode.CONTRACT_TEMPLATE_ACTIVATE)
  deactivateContractVersion(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.setContractVersionStatus(id, "INACTIVE", request.user, requestContext(request));
  }

  @Get("orders/:orderId/changes")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_VIEW)
  listOrderChanges(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.listOrderChanges(orderId, request.user);
  }

  @Post("orders/:orderId/changes")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_CREATE)
  createOrderChange(
    @Param("orderId") orderId: string,
    @Body() dto: CreateOrderChangeDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.orderService.createOrderChange(orderId, dto, request.user, requestContext(request));
  }

  @Post("order-changes/:id/approve")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_APPROVE)
  approveOrderChange(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.setOrderChangeStatus(id, "APPROVED", request.user, requestContext(request));
  }

  @Post("order-changes/:id/cancel")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_CREATE)
  cancelOrderChange(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.cancelOrderChange(id, request.user, requestContext(request));
  }

  @Post("order-changes/:id/reject")
  @RequireAnyPermissions(PermissionCode.ORDER_CHANGE_REJECT, PermissionCode.ORDER_CHANGE_APPROVE)
  rejectOrderChange(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.setOrderChangeStatus(id, "REJECTED", request.user, requestContext(request));
  }

  @Post("order-changes/:id/execute")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_EXECUTE)
  executeOrderChange(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.executeOrderChange(id, request.user, requestContext(request));
  }

  @Post("order-changes/:id/return-to-plan")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_EXECUTE)
  returnOrderChangeToPlan(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.returnOrderChangeToPlan(id, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
