import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleMileageController } from "./vehicle-mileage.controller";
import { VehicleMileageRepository } from "./vehicle-mileage.repository";
import { VehicleMileageService } from "./vehicle-mileage.service";

@Module({
  controllers: [VehicleMileageController],
  exports: [VehicleMileageService],
  imports: [AuthModule, PrismaModule],
  providers: [VehicleMileageRepository, VehicleMileageService]
})
export class VehicleMileageModule {}
