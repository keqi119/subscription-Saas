import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer, PortalAuthenticatedRequest } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import {
  PortalConfirmExtensionQuoteDto,
  PortalRejectExtensionQuoteDto,
  PortalRenewalDecisionDto
} from "./portal-renewal.dto";
import { PortalRenewalService } from "./portal-renewal.service";
import { PortalSubscriptionChangeService } from "./portal-subscription-change.service";

@Controller("portal/renewal-considerations")
@UseGuards(CustomerAuthGuard)
export class PortalRenewalController {
  constructor(private readonly service: PortalRenewalService) {}

  @Get()
  list(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.service.list(currentCustomer);
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.service.get(id, currentCustomer);
  }

  @Post(":id/decision")
  decide(
    @Param("id") id: string,
    @Body() dto: PortalRenewalDecisionDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: PortalAuthenticatedRequest
  ) {
    return this.service.decide(
      id,
      { ...dto, idempotencyKey },
      currentCustomer,
      requestContext(request)
    );
  }
}

@Controller("portal/subscription-changes")
@UseGuards(CustomerAuthGuard)
export class PortalSubscriptionChangeController {
  constructor(private readonly service: PortalSubscriptionChangeService) {}

  @Get(":id")
  get(@Param("id") id: string, @CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.service.getChange(id, currentCustomer);
  }

  @Post(":id/quote/confirm")
  confirmQuote(
    @Param("id") id: string,
    @Body() dto: PortalConfirmExtensionQuoteDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: PortalAuthenticatedRequest
  ) {
    return this.service.confirmQuote(
      id,
      { ...dto, idempotencyKey },
      currentCustomer,
      requestContext(request)
    );
  }

  @Post(":id/quote/reject")
  rejectQuote(
    @Param("id") id: string,
    @Body() dto: PortalRejectExtensionQuoteDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer,
    @Req() request: PortalAuthenticatedRequest
  ) {
    return this.service.rejectQuote(
      id,
      { ...dto, idempotencyKey },
      currentCustomer,
      requestContext(request)
    );
  }
}

@Controller("portal/orders")
@UseGuards(CustomerAuthGuard)
export class PortalContractSegmentController {
  constructor(private readonly service: PortalRenewalService) {}

  @Get(":orderId/contract-segments")
  listContractSegments(
    @Param("orderId") orderId: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.service.listContractSegments(orderId, currentCustomer);
  }
}

function requestContext(request: PortalAuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
