import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe
} from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  DeliveryEvidenceDecisionDto,
  FinalPlanDecisionDto,
  JourneyReasonDto,
  ListSubscriptionJourneysQueryDto,
  VehicleAllocationDecisionDto
} from "./subscription-journey.dto";
import { SubscriptionJourneyService } from "./subscription-journey.service";

@Controller("subscription-journeys")
@UseGuards(AuthGuard, PermissionsGuard)
@UsePipes(
  new ValidationPipe({
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true
  })
)
export class SubscriptionJourneyController {
  constructor(private readonly service: SubscriptionJourneyService) {}

  @Get("by-application/:applicationId")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW)
  getByApplication(
    @Param("applicationId") applicationId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.getByApplication(applicationId, request.user);
  }

  @Get("by-order/:orderId")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW)
  getByOrder(
    @Param("orderId") orderId: string,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.getByOrder(orderId, request.user);
  }

  @Get()
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW)
  list(
    @Query() query: ListSubscriptionJourneysQueryDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.listJourneys(query, request.user);
  }

  @Get("metrics")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_VIEW)
  metrics() {
    return this.service.getAdminMetrics();
  }

  @Post(":id/final-plan-decision")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_PLAN_DECIDE)
  decideFinalPlan(
    @Param("id") id: string,
    @Body() dto: FinalPlanDecisionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.decideFinalPlan(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/vehicle-allocation")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_VEHICLE_ALLOCATE)
  allocateVehicle(
    @Param("id") id: string,
    @Body() dto: VehicleAllocationDecisionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.allocateVehicle(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/delivery-evidence-decision")
  @RequirePermissions(
    PermissionCode.SUBSCRIPTION_JOURNEY_DELIVERY_EVIDENCE_DECIDE
  )
  decideDeliveryEvidence(
    @Param("id") id: string,
    @Body() dto: DeliveryEvidenceDecisionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.decideDeliveryEvidence(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/retry")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER)
  retry(
    @Param("id") id: string,
    @Body() dto: JourneyReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.retryJourney(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/pause")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER)
  pause(
    @Param("id") id: string,
    @Body() dto: JourneyReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.pauseJourney(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/resume")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_RECOVER)
  resume(
    @Param("id") id: string,
    @Body() dto: JourneyReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.resumeJourney(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Post(":id/cancel")
  @RequirePermissions(PermissionCode.SUBSCRIPTION_JOURNEY_CANCEL)
  cancel(
    @Param("id") id: string,
    @Body() dto: JourneyReasonDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.service.cancelJourney(
      id,
      dto,
      request.user,
      requestContext(request)
    );
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
