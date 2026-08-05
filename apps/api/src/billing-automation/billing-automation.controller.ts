import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { BillingAutomationAdminService } from "./billing-automation.admin.service";
import {
  BillingAutomationJobQueryDto,
  BillingScheduleQueryDto,
  PauseBillingScheduleDto,
  ReconcileBillingSchedulesDto
} from "./billing-automation.dto";

@Controller("billing/automation")
@UseGuards(AuthGuard, PermissionsGuard)
export class BillingAutomationController {
  constructor(private readonly service: BillingAutomationAdminService) {}

  @Get("summary")
  @RequireAnyPermissions(PermissionCode.BILLING_VIEW, PermissionCode.AUTO_DEBIT_VIEW)
  summary() {
    return this.service.summary();
  }

  @Get("schedules")
  @RequirePermissions(PermissionCode.BILLING_VIEW)
  listSchedules(@Query() query: BillingScheduleQueryDto) {
    return this.service.listSchedules(query);
  }

  @Get("jobs")
  @RequirePermissions(PermissionCode.BILLING_VIEW)
  listJobs(@Query() query: BillingAutomationJobQueryDto) {
    return this.service.listJobs(query);
  }

  @Post("reconcile")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  reconcile(@Body() dto: ReconcileBillingSchedulesDto, @Req() request: AuthenticatedRequest) {
    return this.service.reconcile(dto.dryRun ?? true, request.user, requestContext(request));
  }

  @Post("schedules/:id/pause")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  pauseSchedule(
    @Param("id") id: string,
    @Body() dto: PauseBillingScheduleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.pauseSchedule(id, dto.reason, request.user, requestContext(request));
  }

  @Post("schedules/:id/resume")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  resumeSchedule(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.service.resumeSchedule(id, request.user, requestContext(request));
  }

  @Post("jobs/:id/retry")
  @RequirePermissions(PermissionCode.BILLING_GENERATE)
  retryJob(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.service.retryJob(id, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
