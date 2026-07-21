import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";

import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { FieldOperatorAuthGuard } from "./field-operator-auth.guard";
import { FieldOperatorAuthService } from "./field-operator-auth.service";
import { FieldOperatorLoginDto, RequestFieldOperatorCodeDto } from "./field-operator-auth.dto";
import { CurrentFieldOperator } from "./field-operator-auth.types";
import { CurrentFieldOperatorSession } from "./field-operator-current.decorator";

@Controller("field/handover")
export class FieldOperatorAuthController {
  constructor(
    private readonly fieldOperatorAuthService: FieldOperatorAuthService,
    private readonly handoverWorkOrderService: HandoverWorkOrderService
  ) {}

  @Post("send-code")
  sendCode(@Body() dto: RequestFieldOperatorCodeDto, @Req() request: Request) {
    return this.fieldOperatorAuthService.requestCode(dto, requestContext(request));
  }

  @Post("login")
  async login(
    @Body() dto: FieldOperatorLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.fieldOperatorAuthService.login(dto, requestContext(request));
    response.cookie(this.fieldOperatorAuthService.getCookieName(), result.token, {
      httpOnly: true,
      maxAge: this.fieldOperatorAuthService.getCookieMaxAgeMs(),
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    return result.session;
  }

  @Get("session")
  @UseGuards(FieldOperatorAuthGuard)
  getSession(@CurrentFieldOperatorSession() current: CurrentFieldOperator) {
    return this.fieldOperatorAuthService.getSession(current);
  }

  @Post("logout")
  @UseGuards(FieldOperatorAuthGuard)
  async logout(
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.fieldOperatorAuthService.logout(current.sessionId);
    response.clearCookie(this.fieldOperatorAuthService.getCookieName());
    return result;
  }

  @Get("work-orders")
  @UseGuards(FieldOperatorAuthGuard)
  async listWorkOrders(@CurrentFieldOperatorSession() current: CurrentFieldOperator, @Req() request: Request) {
    await this.fieldOperatorAuthService.recordTaskListViewed(current, requestContext(request));
    return this.handoverWorkOrderService.listFieldAccessibleWorkOrders(current.phone);
  }

  @Get("work-orders/:id")
  @UseGuards(FieldOperatorAuthGuard)
  async getWorkOrder(
    @Param("id") id: string,
    @CurrentFieldOperatorSession() current: CurrentFieldOperator,
    @Req() request: Request
  ) {
    const task = await this.handoverWorkOrderService.getFieldAccessibleWorkOrder(id, current.phone);
    await this.fieldOperatorAuthService.recordTaskViewed(current, id, requestContext(request));
    return task;
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
