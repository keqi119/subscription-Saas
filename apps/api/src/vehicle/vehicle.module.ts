import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleListingController } from "./vehicle-listing.controller";
import { VehicleListingService } from "./vehicle-listing.service";
import { VehicleController } from "./vehicle.controller";
import { VehicleService } from "./vehicle.service";

@Module({
  controllers: [VehicleController, VehicleListingController],
  imports: [PrismaModule, AuditModule, AuthModule, StorageModule],
  providers: [VehicleService, VehicleListingService]
})
export class VehicleModule {}
