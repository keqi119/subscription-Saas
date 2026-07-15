import { Body, Controller, Get, Patch, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
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
    @Req() request: Request
  ) {
    return this.portalProfileService.updateProfile(dto, currentCustomer, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
  }
}
