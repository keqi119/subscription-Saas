import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthenticatedRequest, AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import {
  AddVehicleAssetPoolVehicleDto,
  ArchiveVehicleAssetPoolDto,
  BatchAddVehicleAssetPoolVehiclesDto,
  CreateVehicleAssetPoolDto,
  RemoveVehicleAssetPoolVehicleDto,
  UpdateVehicleAssetPoolDto,
  VehicleAssetPoolsQueryDto
} from "./dto/vehicle-asset-pool.dto";
import { VehicleAssetPoolService } from "./vehicle-asset-pool.service";

const VEHICLE_ASSET_POOL_VIEW_PERMISSION = "vehicle_asset_pool:view";
const VEHICLE_ASSET_POOL_MANAGE_PERMISSION = "vehicle_asset_pool:manage";

@Controller("vehicle-asset-pools")
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleAssetPoolController {
  constructor(private readonly vehicleAssetPoolService: VehicleAssetPoolService) {}

  @Get()
  @RequirePermissions(VEHICLE_ASSET_POOL_VIEW_PERMISSION)
  listPools(@Query() query: VehicleAssetPoolsQueryDto) {
    return this.vehicleAssetPoolService.listPools(query);
  }

  @Get(":id")
  @RequirePermissions(VEHICLE_ASSET_POOL_VIEW_PERMISSION)
  getPool(@Param("id") id: string) {
    return this.vehicleAssetPoolService.getPool(id);
  }

  @Post()
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  createPool(@Body() dto: CreateVehicleAssetPoolDto, @Req() request: AuthenticatedRequest) {
    return this.vehicleAssetPoolService.createPool(dto, request.user, requestContext(request));
  }

  @Put(":id")
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  updatePool(
    @Param("id") id: string,
    @Body() dto: UpdateVehicleAssetPoolDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleAssetPoolService.updatePool(id, dto, request.user, requestContext(request));
  }

  @Post(":id/archive")
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  archivePool(
    @Param("id") id: string,
    @Body() dto: ArchiveVehicleAssetPoolDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleAssetPoolService.archivePool(id, dto, request.user, requestContext(request));
  }

  @Post(":id/vehicles")
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  addVehicleToPool(
    @Param("id") id: string,
    @Body() dto: AddVehicleAssetPoolVehicleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleAssetPoolService.addVehicleToPool(id, dto, request.user, requestContext(request));
  }

  @Post(":id/vehicles/batch")
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  batchAddVehiclesToPool(
    @Param("id") id: string,
    @Body() dto: BatchAddVehicleAssetPoolVehiclesDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleAssetPoolService.batchAddVehiclesToPool(id, dto, request.user, requestContext(request));
  }

  @Post(":id/vehicles/:membershipId/remove")
  @RequirePermissions(VEHICLE_ASSET_POOL_MANAGE_PERMISSION)
  removeVehicleFromPool(
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @Body() dto: RemoveVehicleAssetPoolVehicleDto,
    @Req() request: AuthenticatedRequest
  ) {
    return this.vehicleAssetPoolService.removeVehicleFromPool(
      id,
      membershipId,
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
