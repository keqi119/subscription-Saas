import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { RetryCustomerESignOnboardingDto } from "./customer-esign-onboarding.dto";
import { CustomerESignOnboardingService } from "./customer-esign-onboarding.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomerESignOnboardingController {
  constructor(private readonly onboardingService: CustomerESignOnboardingService) {}

  @Get("customers/:id/esign-onboarding/status")
  @RequirePermissions(PermissionCode.CUSTOMER_VIEW)
  getOnboardingStatus(@Param("id") id: string) {
    return this.onboardingService.getOnboardingStatus(id);
  }

  @Post("customers/:id/esign-onboarding/start")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  startOnboarding(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.onboardingService.startOnboarding(id, request.user.id);
  }

  @Post("customers/:id/esign-onboarding/retry")
  @RequirePermissions(PermissionCode.CUSTOMER_MANAGE)
  retryOnboarding(
    @Param("id") id: string,
    @Body() dto: RetryCustomerESignOnboardingDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.onboardingService.retryOnboarding(id, dto, request.user.id);
  }
}
