import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { PortalAuthService } from "./portal-auth.service";
import { PortalLoginDto, RequestPortalCodeDto } from "./portal-auth.dto";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import { CurrentCustomer } from "./portal-auth.types";

@Controller("portal/auth")
export class PortalAuthController {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  @Post("request-code")
  requestCode(@Body() dto: RequestPortalCodeDto, @Req() request: Request) {
    return this.portalAuthService.requestCode(dto, requestContext(request));
  }

  @Post("login")
  async login(
    @Body() dto: PortalLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.portalAuthService.login(dto, requestContext(request));
    response.cookie(this.portalAuthService.getCookieName(), result.token, {
      httpOnly: true,
      maxAge: this.portalAuthService.getCookieMaxAgeMs(),
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return result.customer;
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(this.portalAuthService.getCookieName());
    return { success: true };
  }

  @Get("me")
  @UseGuards(CustomerAuthGuard)
  getMe(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return currentCustomer;
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
