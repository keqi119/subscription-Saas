import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";

import {
  CustomerESignOnboardingTriggerSource,
  StartCustomerESignOnboardingRealNameDto
} from "../esign/customer-esign-onboarding.dto";
import { CustomerESignOnboardingService } from "../esign/customer-esign-onboarding.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal/esign-onboarding")
export class PortalESignOnboardingController {
  constructor(private readonly onboardingService: CustomerESignOnboardingService) {}

  @Get("status")
  @UseGuards(CustomerAuthGuard)
  getOnboardingStatus(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.onboardingService.getOnboardingStatus(currentCustomer.customerId, {
      source: CustomerESignOnboardingTriggerSource.PORTAL
    });
  }

  @Post("real-name")
  @UseGuards(CustomerAuthGuard)
  startRealNameVerification(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Body() dto: StartCustomerESignOnboardingRealNameDto
  ) {
    return this.onboardingService.startPortalRealNameVerification(
      currentCustomer.customerId,
      dto,
      currentCustomer.customerAccountId
    );
  }

  @Post("refresh")
  @UseGuards(CustomerAuthGuard)
  refreshProviderBackedReadiness(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.onboardingService.refreshProviderBackedReadiness(
      currentCustomer.customerId,
      currentCustomer.customerAccountId,
      { source: CustomerESignOnboardingTriggerSource.PORTAL }
    );
  }
}
