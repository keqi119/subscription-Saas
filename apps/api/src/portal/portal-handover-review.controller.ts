import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";

import { CustomerAuthGuard } from "./portal-auth.guard";
import { CurrentCustomer } from "./portal-auth.types";
import { CurrentPortalCustomer } from "./portal-current-customer.decorator";
import {
  ConfirmPortalHandoverReviewDto,
  ObjectPortalHandoverReviewDto
} from "./portal-handover-review.dto";
import { PortalHandoverReviewService } from "./portal-handover-review.service";

@Controller("portal/handover-reviews")
@UseGuards(CustomerAuthGuard)
export class PortalHandoverReviewController {
  constructor(private readonly portalHandoverReviewService: PortalHandoverReviewService) {}

  @Get()
  listReviews(@CurrentPortalCustomer() currentCustomer: CurrentCustomer) {
    return this.portalHandoverReviewService.listReviews(currentCustomer);
  }

  @Get(":id")
  getReview(
    @Param("id") id: string,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.getReview(id, currentCustomer);
  }

  @Post(":id/confirm")
  confirmNoObjection(
    @Param("id") id: string,
    @Body() dto: ConfirmPortalHandoverReviewDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.confirmNoObjection(id, dto, currentCustomer);
  }

  @Post(":id/object")
  objectReview(
    @Param("id") id: string,
    @Body() dto: ObjectPortalHandoverReviewDto,
    @CurrentPortalCustomer() currentCustomer: CurrentCustomer
  ) {
    return this.portalHandoverReviewService.objectReview(id, dto, currentCustomer);
  }
}
