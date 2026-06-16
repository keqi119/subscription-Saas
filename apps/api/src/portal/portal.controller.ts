import { Controller, Get, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal")
export class PortalController {
  @Get("me")
  @UseGuards(CustomerAuthGuard)
  getMe(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return currentCustomer;
  }
}
