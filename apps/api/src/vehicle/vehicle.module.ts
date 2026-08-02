import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { VehicleConditionReportController } from "./vehicle-condition-report.controller";
import { VehicleConditionReportService } from "./vehicle-condition-report.service";
import { VehicleListingController } from "./vehicle-listing.controller";
import { VehicleListingService } from "./vehicle-listing.service";
import { VehicleController } from "./vehicle.controller";
import { VehicleService } from "./vehicle.service";

@Module({
  controllers: [VehicleController, VehicleListingController, VehicleConditionReportController],
  imports: [PrismaModule, AuditModule, AuthModule, StorageModule, VehicleMileageModule],
  providers: [VehicleService, VehicleListingService, VehicleConditionReportService]
})
export class VehicleModule {}
