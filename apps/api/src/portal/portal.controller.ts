import { Body, Controller, Get, Patch, Req, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer, PortalAuthenticatedRequest } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import { UpdatePortalProfileDto } from "./portal-profile.dto";
import { PortalProfileService } from "./portal-profile.service";

@Controller("portal")
export class PortalController {
  constructor(private readonly portalProfileService: PortalProfileService) {}

  @Get("me")
  @UseGuards(CustomerAuthGuard)
  getMe(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return currentCustomer;
  }

  @Get("profile")
  @UseGuards(CustomerAuthGuard)
  getProfile(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalProfileService.getProfile(currentCustomer);
  }

  @Patch("profile")
  @UseGuards(CustomerAuthGuard)
  updateProfile(
    @Body() dto: UpdatePortalProfileDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: PortalAuthenticatedRequest
  ) {
    return this.portalProfileService.updateProfile(dto, currentCustomer, requestContext(request));
  }
}

function requestContext(request: PortalAuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
