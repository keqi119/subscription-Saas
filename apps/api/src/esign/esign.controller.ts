import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";
import type { Request } from "express";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { ESignService } from "./esign.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class ESignAdminController {
  constructor(private readonly esignService: ESignService) {}

  @Post("contracts/:id/esign-tasks")
  @RequirePermissions(PermissionCode.CONTRACT_SIGN)
  createContractESignTask(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.esignService.createTaskForContract(id, request.user, requestContext(request));
  }

  @Get("contracts/:id/esign-tasks")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  listContractESignTasks(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.esignService.listTasksForContract(id, request.user);
  }

  @Get("esign-tasks/:id")
  @RequirePermissions(PermissionCode.CONTRACT_VIEW)
  getESignTask(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.esignService.getTask(id, request.user);
  }
}

@Controller("esign")
export class ESignCallbackController {
  constructor(private readonly esignService: ESignService) {}

  @Post("callback/:provider")
  handleCallback(
    @Param("provider") provider: string,
    @Body() payload: unknown,
    @Headers() headers: Record<string, unknown>
  ) {
    return this.esignService.handleCallback(provider, payload, headers);
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
