import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  CreateVehicleModelDefinitionDto,
  UpdateVehicleModelDefinitionDto,
  VehicleModelDefinitionsQueryDto
} from "./dto/vehicle-model-definition.dto";
import { VehicleModelDefinitionService } from "./vehicle-model-definition.service";

@Controller("vehicle-model-definitions")
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleModelDefinitionController {
  constructor(private readonly vehicleModelDefinitionService: VehicleModelDefinitionService) {}

  @Get()
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_VIEW)
  listDefinitions(@Query() query: VehicleModelDefinitionsQueryDto) {
    return this.vehicleModelDefinitionService.listDefinitions(query);
  }

  @Get(":id")
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_VIEW)
  getDefinition(@Param("id") id: string) {
    return this.vehicleModelDefinitionService.getDefinition(id);
  }

  @Post()
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_MANAGE)
  createDefinition(
    @Body() dto: CreateVehicleModelDefinitionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleModelDefinitionService.createDefinition(dto, request.user);
  }

  @Patch(":id")
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_MANAGE)
  updateDefinition(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleModelDefinitionDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleModelDefinitionService.updateDefinition(id, dto, request.user);
  }

  @Post(":id/enable")
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_MANAGE)
  enableDefinition(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleModelDefinitionService.enableDefinition(id, request.user);
  }

  @Post(":id/disable")
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_MANAGE)
  disableDefinition(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleModelDefinitionService.disableDefinition(id, request.user);
  }

  @Delete(":id")
  @RequirePermissions(PermissionCode.VEHICLE_MODEL_MANAGE)
  deleteDefinition(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    return this.vehicleModelDefinitionService.deleteDefinition(id, request.user);
  }
}
