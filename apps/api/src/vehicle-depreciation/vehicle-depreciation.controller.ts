import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateVehicleDepreciationPolicyDto,
  CreateVehicleDepreciationRecordDto,
  GenerateVehicleDepreciationSchedulesDto,
  UpdateVehicleDepreciationPolicyDto,
  UpdateVehicleDepreciationRecordDto,
  VehicleDepreciationPoliciesQueryDto,
  VehicleDepreciationRecordActionDto,
  VehicleDepreciationRecordsQueryDto,
  VehicleDepreciationScheduleActionDto
} from "./dto/vehicle-depreciation.dto";
import { VehicleDepreciationService } from "./vehicle-depreciation.service";

@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleDepreciationController {
  constructor(private readonly vehicleDepreciationService: VehicleDepreciationService) {}

  @Get("vehicle-depreciation-policies")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  listPolicies(@Query() query: VehicleDepreciationPoliciesQueryDto) {
    return this.vehicleDepreciationService.listPolicies(query);
  }

  @Get("vehicle-depreciation-policies/:id")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  getPolicy(@Param("id") id: string) {
    return this.vehicleDepreciationService.getPolicy(id);
  }

  @Get("vehicles/:id/depreciation-policies")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  listVehiclePolicies(
    @Param("id") id: string,
    @Query() query: VehicleDepreciationPoliciesQueryDto
  ) {
    return this.vehicleDepreciationService.listVehiclePolicies(id, query);
  }

  @Get("vehicles/:id/depreciation-summary")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  getVehicleDepreciationSummary(@Param("id") id: string) {
    return this.vehicleDepreciationService.getVehicleDepreciationSummary(id);
  }

  @Post("vehicles/:id/depreciation-policies")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  createPolicy(
    @Param("id") id: string,
    @Body() dto: CreateVehicleDepreciationPolicyDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.createPolicy(id, dto, request.user);
  }

  @Patch("vehicle-depreciation-policies/:id")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  updatePolicy(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleDepreciationPolicyDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.updatePolicy(id, dto, request.user);
  }

  @Post("vehicle-depreciation-policies/:id/activate")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  activatePolicy(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleDepreciationService.activatePolicy(id, request.user);
  }

  @Post("vehicle-depreciation-policies/:id/suspend")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  suspendPolicy(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleDepreciationService.suspendPolicy(id, request.user);
  }

  @Post("vehicle-depreciation-policies/:id/terminate")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  terminatePolicy(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleDepreciationService.terminatePolicy(id, request.user);
  }

  @Post("vehicle-depreciation-policies/:id/archive")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  archivePolicy(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleDepreciationService.archivePolicy(id, request.user);
  }

  @Get("vehicle-depreciation-policies/:id/schedules")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  listPolicySchedules(@Param("id") id: string) {
    return this.vehicleDepreciationService.listPolicySchedules(id);
  }

  @Post("vehicle-depreciation-policies/:id/schedules/generate")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  generateSchedules(
    @Param("id") id: string,
    @Body() dto: GenerateVehicleDepreciationSchedulesDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.generateSchedules(id, dto, request.user);
  }

  @Post("vehicle-depreciation-schedules/:id/confirm")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  confirmSchedule(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationScheduleActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.confirmSchedule(id, dto, request.user);
  }

  @Post("vehicle-depreciation-schedules/:id/void")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  voidSchedule(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationScheduleActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.voidSchedule(id, dto, request.user);
  }

  @Post("vehicle-depreciation-schedules/:id/lock")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  lockSchedule(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationScheduleActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.lockSchedule(id, dto, request.user);
  }

  @Get("vehicle-depreciation-records")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  listRecords(@Query() query: VehicleDepreciationRecordsQueryDto) {
    return this.vehicleDepreciationService.listRecords(query);
  }

  @Get("vehicle-depreciation-policies/:id/records")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_VIEW)
  listPolicyRecords(
    @Param("id") id: string,
    @Query() query: VehicleDepreciationRecordsQueryDto
  ) {
    return this.vehicleDepreciationService.listPolicyRecords(id, query);
  }

  @Post("vehicle-depreciation-policies/:id/records")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  createRecord(
    @Param("id") id: string,
    @Body() dto: CreateVehicleDepreciationRecordDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.createRecord(id, dto, request.user);
  }

  @Patch("vehicle-depreciation-records/:id")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  updateRecord(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleDepreciationRecordDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.updateRecord(id, dto, request.user);
  }

  @Post("vehicle-depreciation-records/:id/confirm")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  confirmRecord(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.confirmRecord(id, dto, request.user);
  }

  @Post("vehicle-depreciation-records/:id/void")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  voidRecord(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.voidRecord(id, dto, request.user);
  }

  @Post("vehicle-depreciation-records/:id/lock")
  @RequirePermissions(PermissionCode.VEHICLE_DEPRECIATION_MANAGE)
  lockRecord(
    @Param("id") id: string,
    @Body() dto: VehicleDepreciationRecordActionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleDepreciationService.lockRecord(id, dto, request.user);
  }
}
