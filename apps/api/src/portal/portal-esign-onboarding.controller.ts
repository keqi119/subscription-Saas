import { Controller, Get, UseGuards } from "@nestjs/common";

import { CustomerESignOnboardingTriggerSource } from "../esign/customer-esign-onboarding.dto";
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
}
