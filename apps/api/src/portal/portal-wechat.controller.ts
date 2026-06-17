import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";

import { WeChatOAuthService } from "../wechat/wechat-oauth.service";
import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";

@Controller("portal/wechat")
@UseGuards(CustomerAuthGuard)
export class PortalWechatController {
  constructor(private readonly wechatOAuthService: WeChatOAuthService) {}

  @Get("oauth-url")
  createOAuthUrl(
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Query("redirect") redirect?: string
  ) {
    return this.wechatOAuthService.createOAuthUrl(currentCustomer, redirect);
  }

  @Get("binding")
  getBinding(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.wechatOAuthService.getBinding(currentCustomer);
  }
}

@Controller("portal/wechat")
export class PortalWechatCallbackController {
  constructor(private readonly wechatOAuthService: WeChatOAuthService) {}

  @Get("oauth/callback")
  async handleCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() response: Response
  ) {
    const result = await this.wechatOAuthService.handleCallback(code, state);
    response.redirect(result.redirectUrl);
  }
}
