import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateVehicleConditionReportDto,
  CreateVehicleConditionReportItemDto,
  UpdateVehicleConditionReportDto,
  UpdateVehicleConditionReportItemDto
} from "./dto/vehicle-condition-report.dto";
import { VehicleConditionReportService } from "./vehicle-condition-report.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleConditionReportController {
  constructor(private readonly conditionReportService: VehicleConditionReportService) {}

  @Get("vehicles/:id/condition-reports")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  listReports(@Param("id") id: string) {
    return this.conditionReportService.listReports(id);
  }

  @Post("vehicles/:id/condition-reports")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  createReport(
    @Param("id") id: string,
    @Body() dto: CreateVehicleConditionReportDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.conditionReportService.createReport(id, dto, request.user);
  }

  @Get("vehicle-condition-reports/:id")
  @RequirePermissions(PermissionCode.VEHICLE_VIEW)
  getReport(@Param("id") id: string) {
    return this.conditionReportService.getReport(id);
  }

  @Patch("vehicle-condition-reports/:id")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  updateReport(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleConditionReportDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.conditionReportService.updateReport(id, dto, request.user);
  }

  @Post("vehicle-condition-reports/:id/publish")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  publishReport(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.conditionReportService.publishReport(id, request.user);
  }

  @Post("vehicle-condition-reports/:id/archive")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  archiveReport(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.conditionReportService.archiveReport(id, request.user);
  }

  @Post("vehicle-condition-reports/:id/items")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  createItem(@Param("id") id: string, @Body() dto: CreateVehicleConditionReportItemDto) {
    return this.conditionReportService.createItem(id, dto);
  }

  @Patch("vehicle-condition-report-items/:itemId")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  updateItem(@Param("itemId") itemId: string, @Body() dto: UpdateVehicleConditionReportItemDto) {
    return this.conditionReportService.updateItem(itemId, dto);
  }

  @Delete("vehicle-condition-report-items/:itemId")
  @RequirePermissions(PermissionCode.VEHICLE_MANAGE)
  deleteItem(@Param("itemId") itemId: string) {
    return this.conditionReportService.deleteItem(itemId);
  }
}
