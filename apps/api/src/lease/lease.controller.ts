import { Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { LeaseActivationEngine } from "./lease-activation.engine";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class LeaseController {
  constructor(private readonly activationEngine: LeaseActivationEngine) {}

  @Get("lease/activation/check/:orderId")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  checkActivation(@Param("orderId") orderId: string) {
    return this.activationEngine.evaluate(orderId);
  }

  @Post("lease/activation/activate/:orderId")
  @RequirePermissions(PermissionCode.ORDER_UPDATE)
  activate(@Param("orderId") orderId: string, @Req() request: AuthenticatedRequest) {
    return this.activationEngine.activate(orderId, request.user, requestContext(request));
  }

  @Get("lease/:orderId/status")
  @RequirePermissions(PermissionCode.ORDER_VIEW)
  getStatus(@Param("orderId") orderId: string) {
    return this.activationEngine.getStatus(orderId);
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
