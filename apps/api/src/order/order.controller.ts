import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ArchiveContractDto,
  CancelOrderDto,
  CreateContractVersionDto,
  CreateOrderChangeDto,
  CreateOrderFromQuoteDto,
  UpdateContractVersionDto
} from "./dto/order.dto";
import { OrderService } from "./order.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get("orders")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  listOrders(@Req() request: AuthenticatedRequest) {
    return this.orderService.listOrders(request.user);
  }

  @Get("orders/:id")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  getOrder(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getOrder(id, request.user);
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

  @Post("orders/:orderId/generate-contract")
  @RequirePermissions(PermissionCode.CONTRACT_GENERATE)
  generateContract(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.generateContract(orderId, request.user, requestContext(request));
  }

  @Get("contracts")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  listContracts(@Req() request: AuthenticatedRequest) {
    return this.orderService.listContracts(request.user);
  }

  @Get("contracts/:id")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  getContract(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.getContract(id, request.user);
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

  @Post("order-changes/:id/reject")
  @RequirePermissions(PermissionCode.ORDER_CHANGE_REJECT)
  rejectOrderChange(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.orderService.setOrderChangeStatus(id, "REJECTED", request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
