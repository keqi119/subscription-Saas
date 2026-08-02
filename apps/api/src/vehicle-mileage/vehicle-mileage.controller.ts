import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { PermissionCode } from "@subscription-saas/shared";

import { RequirePermissions } from "../auth/auth.decorators";
import { AuthGuard } from "../auth/auth.guard";
import { PermissionsGuard } from "../auth/permissions.guard";
import { VehicleMileageService } from "./vehicle-mileage.service";

@Controller("vehicles")
@UseGuards(AuthGuard, PermissionsGuard)
export class VehicleMileageController {
  constructor(private readonly vehicleMileageService: VehicleMileageService) {}

  @Get(":id/mileage-readings")
  @RequirePermissions(PermissionCode.VEHICLE_MILEAGE_VIEW)
  listVehicleReadings(@Param("id") id: string) {
    return this.vehicleMileageService.listVehicleReadings(id);
  }
}
