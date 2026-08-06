import { Controller, Get, Param, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "../portal/portal-auth.guard";
import { CurrentCustomer } from "../portal/portal-auth.types";
import { CurrentPortalCustomer } from "../portal/portal-current-customer.decorator";
import { SubscriptionJourneyService } from "./subscription-journey.service";

@Controller("portal/subscription-journeys")
@UseGuards(CustomerAuthGuard)
export class PortalSubscriptionJourneyController {
  constructor(private readonly service: SubscriptionJourneyService) {}

  @Get("by-application/:applicationId")
  getByApplication(
    @Param("applicationId") applicationId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.service.getPortalByApplication(applicationId, currentCustomer);
  }

  @Get("by-order/:orderId")
  getByOrder(
    @Param("orderId") orderId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.service.getPortalByOrder(orderId, currentCustomer);
  }
}
