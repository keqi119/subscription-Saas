import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AcceptServiceCaseDto,
  AddServiceCaseActionDto,
  AdminServiceCasesQueryDto,
  CloseServiceCaseDto,
  UpdateServiceCaseStatusDto
} from "./dto/service-case.dto";
import { ServiceCaseService } from "./service-case.service";

@Controller("service-cases")
@UseGuards(AuthGuard, PermissionsGuard)
export class ServiceCaseController {
  constructor(private readonly serviceCaseService: ServiceCaseService) {}

  @Get()
  @RequirePermissions(PermissionCode.SERVICE_CASE_VIEW)
  listServiceCases(@Query() query: AdminServiceCasesQueryDto) {
    return this.serviceCaseService.listAdminServiceCases(query);
  }

  @Get(":id")
  @RequirePermissions(PermissionCode.SERVICE_CASE_VIEW)
  getServiceCase(@Param("id") id: string) {
    return this.serviceCaseService.getAdminServiceCase(id);
  }

  @Post(":id/accept")
  @RequirePermissions(PermissionCode.SERVICE_CASE_MANAGE)
  acceptServiceCase(
    @Param("id") id: string,
    @Body() dto: AcceptServiceCaseDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.serviceCaseService.acceptServiceCase(id, dto, request.user, requestContext(request));
  }

  @Post(":id/status")
  @RequirePermissions(PermissionCode.SERVICE_CASE_MANAGE)
  updateServiceCaseStatus(
    @Param("id") id: string,
    @Body() dto: UpdateServiceCaseStatusDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.serviceCaseService.updateServiceCaseStatus(id, dto, request.user, requestContext(request));
  }

  @Post(":id/actions")
  @RequirePermissions(PermissionCode.SERVICE_CASE_MANAGE)
  addServiceCaseAction(
    @Param("id") id: string,
    @Body() dto: AddServiceCaseActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.serviceCaseService.addServiceCaseAction(id, dto, request.user, requestContext(request));
  }

  @Post(":id/close")
  @RequirePermissions(PermissionCode.SERVICE_CASE_MANAGE)
  closeServiceCase(
    @Param("id") id: string,
    @Body() dto: CloseServiceCaseDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.serviceCaseService.closeServiceCase(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
