import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateRevenueRightAssignmentDto,
  CreateRevenueShareRuleDto,
  DeactivateRevenueShareRuleDto,
  ReleaseRevenueRightAssignmentDto,
  RevenueRightAssignmentsQueryDto,
  RevenueSharePreviewQueryDto
} from "./dto/revenue-right.dto";
import { RevenueRightService } from "./revenue-right.service";

const REVENUE_RIGHT_VIEW_PERMISSION = "revenue_right:view";
const REVENUE_RIGHT_MANAGE_PERMISSION = "revenue_right:manage";
const REVENUE_SHARE_VIEW_PERMISSION = "revenue_share:view";
const REVENUE_SHARE_MANAGE_PERMISSION = "revenue_share:manage";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class RevenueRightController {
  constructor(private readonly revenueRightService: RevenueRightService) {}

  @Get("revenue-right-assignments")
  @RequirePermissions(REVENUE_RIGHT_VIEW_PERMISSION)
  listAssignments(@Query() query: RevenueRightAssignmentsQueryDto) {
    return this.revenueRightService.listAssignments(query);
  }

  @Get("revenue-right-assignments/:id")
  @RequirePermissions(REVENUE_RIGHT_VIEW_PERMISSION)
  getAssignment(@Param("id") id: string) {
    return this.revenueRightService.getAssignment(id);
  }

  @Post("revenue-right-assignments")
  @RequirePermissions(REVENUE_RIGHT_MANAGE_PERMISSION)
  createAssignment(@Body() dto: CreateRevenueRightAssignmentDto, @Req() request: AuthenticatedRequest) {
    return this.revenueRightService.createAssignment(dto, request.user, requestContext(request));
  }

  @Post("revenue-right-assignments/:id/release")
  @RequirePermissions(REVENUE_RIGHT_MANAGE_PERMISSION)
  releaseAssignment(
    @Param("id") id: string,
    @Body() dto: ReleaseRevenueRightAssignmentDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.revenueRightService.releaseAssignment(id, dto, request.user, requestContext(request));
  }

  @Get("vehicles/:id/revenue-share-rules")
  @RequireAnyPermissions(REVENUE_SHARE_VIEW_PERMISSION, PermissionCode.VEHICLE_VIEW)
  listVehicleRevenueShareRules(@Param("id") id: string) {
    return this.revenueRightService.listVehicleRevenueShareRules(id);
  }

  @Post("vehicles/:id/revenue-share-rules")
  @RequirePermissions(REVENUE_SHARE_MANAGE_PERMISSION)
  createVehicleRevenueShareRule(
    @Param("id") id: string,
    @Body() dto: CreateRevenueShareRuleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.revenueRightService.createVehicleRevenueShareRule(id, dto, request.user, requestContext(request));
  }

  @Post("vehicles/:id/revenue-share-rules/:ruleId/deactivate")
  @RequirePermissions(REVENUE_SHARE_MANAGE_PERMISSION)
  deactivateVehicleRevenueShareRule(
    @Param("id") id: string,
    @Param("ruleId") ruleId: string,
    @Body() dto: DeactivateRevenueShareRuleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.revenueRightService.deactivateVehicleRevenueShareRule(
      id,
      ruleId,
      dto,
      request.user,
      requestContext(request)
    );
  }

  @Get("vehicles/:id/revenue-share-preview")
  @RequireAnyPermissions(REVENUE_SHARE_VIEW_PERMISSION, PermissionCode.REPORT_ASSET)
  getVehicleRevenueSharePreview(@Param("id") id: string, @Query() query: RevenueSharePreviewQueryDto) {
    return this.revenueRightService.getVehicleRevenueSharePreview(id, query);
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
