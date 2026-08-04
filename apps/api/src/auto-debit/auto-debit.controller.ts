import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { AdminMandateQueryDto } from "./auto-debit.dto";
import { PaymentMandateService } from "./payment-mandate.service";

@Controller("billing/automation")
@UseGuards(AuthGuard, PermissionsGuard)
export class AutoDebitController {
  constructor(private readonly service: PaymentMandateService) {}

  @Get("mandates")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_VIEW)
  listMandates(@Query() query: AdminMandateQueryDto) {
    return this.service.listAdminMandates(query);
  }

  @Post("mandates/:id/sync")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_MANAGE)
  syncMandate(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.syncAdminMandate(
      id,
      request.user,
      requestContext(request)
    );
  }

  @Post("mandates/:id/revoke")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_MANAGE)
  revokeMandate(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.revokeAdminMandate(
      id,
      request.user,
      requestContext(request)
    );
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
