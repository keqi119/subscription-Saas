import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  ApproveVehicleValuationReviewDto,
  CancelVehicleValuationReviewDto,
  CreateValuationReviewFromResidualForecastDto,
  RejectVehicleValuationReviewDto,
  VehicleValuationReviewQueryDto
} from "./dto/vehicle-valuation-review.dto";
import { VehicleValuationReviewService } from "./vehicle-valuation-review.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleValuationReviewController {
  constructor(private readonly valuationReviewService: VehicleValuationReviewService) {}

  @Post("vehicles/:id/valuation-reviews/from-residual-forecast")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_CREATE)
  createFromResidualForecast(
    @Param("id") id: string,
    @Body() dto: CreateValuationReviewFromResidualForecastDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.valuationReviewService.createFromResidualForecast(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Get("vehicles/:id/valuation-reviews")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_VIEW)
  listVehicleReviews(@Param("id") id: string, @Query() query: VehicleValuationReviewQueryDto) {
    return this.valuationReviewService.listVehicleReviews(id, query);
  }

  @Get("vehicle-valuation-reviews")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_VIEW)
  listReviews(@Query() query: VehicleValuationReviewQueryDto) {
    return this.valuationReviewService.listReviews(query);
  }

  @Get("vehicle-valuation-reviews/:id")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_VIEW)
  getReview(@Param("id") id: string) {
    return this.valuationReviewService.getReview(id);
  }

  @Post("vehicle-valuation-reviews/:id/approve")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_APPROVE)
  approveReview(
    @Param("id") id: string,
    @Body() dto: ApproveVehicleValuationReviewDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.valuationReviewService.approveReview(id, dto, request.user, requestContext(request));
  }

  @Post("vehicle-valuation-reviews/:id/reject")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_APPROVE)
  rejectReview(
    @Param("id") id: string,
    @Body() dto: RejectVehicleValuationReviewDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.valuationReviewService.rejectReview(id, dto, request.user, requestContext(request));
  }

  @Post("vehicle-valuation-reviews/:id/cancel")
  @RequirePermissions(PermissionCode.VEHICLE_VALUATION_REVIEW_CREATE)
  cancelReview(
    @Param("id") id: string,
    @Body() dto: CancelVehicleValuationReviewDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.valuationReviewService.cancelReview(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
