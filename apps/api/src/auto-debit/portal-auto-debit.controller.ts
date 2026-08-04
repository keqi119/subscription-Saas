import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";

import { CustomerAuthGuard } from "../portal/portal-auth.guard";
import { CurrentCustomer } from "../portal/portal-auth.types";
import { CurrentPortalCustomer } from "../portal/portal-current-customer.decorator";
import {
  CreatePortalMandateDto,
  PortalDebitAttemptQueryDto,
  PortalMandateQueryDto
} from "./auto-debit.dto";
import { PaymentMandateService } from "./payment-mandate.service";

@Controller("portal/auto-debit")
@UseGuards(CustomerAuthGuard)
export class PortalAutoDebitController {
  constructor(private readonly service: PaymentMandateService) {}

  @Get("availability")
  availability() {
    return this.service.getPortalAvailability();
  }

  @Get("mandates")
  listMandates(
    @Query() query: PortalMandateQueryDto,
    @CurrentPortalCustomer() customer: CurrentCustomer
  ) {
    return this.service.listPortalMandates(query, customer);
  }

  @Post("mandates")
  createMandate(
    @Body() dto: CreatePortalMandateDto,
    @CurrentPortalCustomer() customer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.service.createPortalMandate(dto.orderId, customer, requestContext(request));
  }

  @Post("mandates/:id/revoke")
  revokeMandate(
    @Param("id") id: string,
    @CurrentPortalCustomer() customer: CurrentCustomer,
    @Req() request: Request
  ) {
    return this.service.revokePortalMandate(id, customer, requestContext(request));
  }

  @Get("attempts")
  listAttempts(
    @Query() query: PortalDebitAttemptQueryDto,
    @CurrentPortalCustomer() customer: CurrentCustomer
  ) {
    return this.service.listPortalAttempts(query, customer);
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
