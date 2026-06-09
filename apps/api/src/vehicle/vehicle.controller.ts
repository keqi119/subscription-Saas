import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequireAnyPermissions, RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateVehicleCapitalEventDto,
  CreateVehicleDto,
  InitializeSalePriceDto,
  ReviewSalePriceDto,
  UpdateVehicleDto,
  UpdateVehicleStatusDto,
  UpsertVehicleAssetCostProfileDto
} from "./dto/vehicle.dto";
import { VehicleService } from "./vehicle.service";

const CAPITAL_STRUCTURE_VIEW_PERMISSION = "capital_structure:view";
const CAPITAL_STRUCTURE_MANAGE_PERMISSION = "capital_structure:manage";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleController {
  constructor(private readonly vehicleService: VehicleService) {}

  @Get("vehicles")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  listVehicles() {
    return this.vehicleService.listVehicles();
  }

  @Post("vehicles")
  @RequirePermissions(PermissionCode.VEHICLE_CREATE)
  createVehicle(@Body() dto: CreateVehicleDto, @Req() request: AuthenticatedRequest) {
    return this.vehicleService.createVehicle(dto, request.user, requestContext(request));
  }

  @Get("vehicles/available")
  @RequireAnyPermissions(PermissionCode.VEHICLE_VIEW, PermissionCode.QUOTE_CREATE)
  listAvailableVehicles() {
    return this.vehicleService.listAvailableVehicles();
  }

  @Get("vehicles/sale-price-reviews/due")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  listDueSalePriceReviews() {
    return this.vehicleService.listDueSalePriceReviews();
  }

  @Get("vehicles/:id/sale-price-history")
  @RequirePermissions(PermissionCode.VEHICLE_HISTORY_VIEW)
  listSalePriceHistory(@Param("id") id: string) {
    return this.vehicleService.listSalePriceHistory(id);
  }

  @Get("vehicles/:id/asset-cost-profile")
  @RequireAnyPermissions(PermissionCode.VEHICLE_VIEW, PermissionCode.REPORT_ASSET)
  getAssetCostProfile(@Param("id") id: string) {
    return this.vehicleService.getAssetCostProfile(id);
  }

  @Put("vehicles/:id/asset-cost-profile")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  upsertAssetCostProfile(
    @Param("id") id: string,
    @Body() dto: UpsertVehicleAssetCostProfileDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.upsertAssetCostProfile(id, dto, request.user, requestContext(request));
  }

  @Get("vehicles/:id/asset-cost-profile/preview")
  @RequireAnyPermissions(PermissionCode.VEHICLE_VIEW, PermissionCode.REPORT_ASSET)
  getAssetCostProfilePreview(@Param("id") id: string) {
    return this.vehicleService.getAssetCostProfilePreview(id);
  }

  @Get("vehicles/:id/capital-events")
  @RequireAnyPermissions(
    CAPITAL_STRUCTURE_VIEW_PERMISSION,
    PermissionCode.VEHICLE_VIEW,
    PermissionCode.REPORT_ASSET
  )
  listCapitalEvents(@Param("id") id: string) {
    return this.vehicleService.listCapitalEvents(id);
  }

  @Post("vehicles/:id/capital-events")
  @RequirePermissions(CAPITAL_STRUCTURE_MANAGE_PERMISSION)
  createCapitalEvent(
    @Param("id") id: string,
    @Body() dto: CreateVehicleCapitalEventDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.createCapitalEvent(id, dto, request.user, requestContext(request));
  }

  @Get("vehicles/:id/capital-structure")
  @RequireAnyPermissions(
    CAPITAL_STRUCTURE_VIEW_PERMISSION,
    PermissionCode.VEHICLE_VIEW,
    PermissionCode.REPORT_ASSET
  )
  getCapitalStructure(@Param("id") id: string) {
    return this.vehicleService.getCapitalStructure(id);
  }

  @Get("vehicles/:id")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  getVehicle(@Param("id") id: string) {
    return this.vehicleService.getVehicle(id);
  }

  @Patch("vehicles/:id")
  @RequirePermissions(PermissionCode.VEHICLE_UPDATE)
  updateVehicle(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.updateVehicle(id, dto, request.user, requestContext(request));
  }

  @Post("vehicles/:id/initialize-sale-price")
  @RequirePermissions(PermissionCode.VEHICLE_INITIALIZE_SALE_PRICE)
  initializeSalePrice(
    @Param("id") id: string,
    @Body() dto: InitializeSalePriceDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.initializeSalePrice(id, dto, request.user, requestContext(request));
  }

  @Post("vehicles/:id/review-sale-price")
  @RequirePermissions(PermissionCode.VEHICLE_REVIEW_SALE_PRICE)
  reviewSalePrice(
    @Param("id") id: string,
    @Body() dto: ReviewSalePriceDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.reviewSalePrice(id, dto, request.user, requestContext(request));
  }

  @Post("vehicles/:id/update-status")
  @RequirePermissions(PermissionCode.VEHICLE_UPDATE_STATUS)
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleStatusDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleService.updateStatus(id, dto, request.user, requestContext(request));
  }
}

function requestContext(request: AuthenticatedRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]
  };
}
