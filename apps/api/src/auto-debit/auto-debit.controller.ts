import {
  Controller,
  Body,
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
import {
  AdminDebitAttemptQueryDto,
  AdminMandateQueryDto,
  AutoDebitActionReasonDto,
  SetMockDebitResultDto
} from "./auto-debit.dto";
import { AutoDebitAdminService } from "./auto-debit.admin.service";
import { PaymentMandateService } from "./payment-mandate.service";

@Controller("billing/automation")
@UseGuards(AuthGuard, PermissionsGuard)
export class AutoDebitController {
  constructor(
    private readonly service: PaymentMandateService,
    private readonly admin: AutoDebitAdminService
  ) {}

  @Get("mandates")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_VIEW)
  listMandates(@Query() query: AdminMandateQueryDto) {
    return this.service.listAdminMandates(query);
  }

  @Get("attempts")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_VIEW)
  listAttempts(@Query() query: AdminDebitAttemptQueryDto) {
    return this.admin.listAttempts(query);
  }

  @Post("attempts/:id/query")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_EXECUTE)
  queryAttempt(
    @Param("id") id: string,
    @Body() dto: AutoDebitActionReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.admin.queryAttempt(id, dto, request.user, requestContext(request));
  }

  @Post("bills/:id/debit")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_EXECUTE)
  requestManualDebit(
    @Param("id") id: string,
    @Body() dto: AutoDebitActionReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.admin.requestManualDebit(id, dto, request.user, requestContext(request));
  }

  @Post("jobs/:id/cancel")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_EXECUTE)
  cancelJob(
    @Param("id") id: string,
    @Body() dto: AutoDebitActionReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.admin.cancelJob(id, dto, request.user, requestContext(request));
  }

  @Post("mock/attempts/:id/next-result")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_EXECUTE)
  setMockNextResult(
    @Param("id") id: string,
    @Body() dto: SetMockDebitResultDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.admin.setMockNextResult(id, dto, request.user, requestContext(request));
  }

  @Post("mandates/:id/sync")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_MANAGE)
  syncMandate(
    @Param("id") id: string,
    @Body() dto: AutoDebitActionReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.syncAdminMandate(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post("mandates/:id/revoke")
  @RequirePermissions(PermissionCode.AUTO_DEBIT_MANAGE)
  revokeMandate(
    @Param("id") id: string,
    @Body() dto: AutoDebitActionReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.revokeAdminMandate(
      id,
      dto,
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
