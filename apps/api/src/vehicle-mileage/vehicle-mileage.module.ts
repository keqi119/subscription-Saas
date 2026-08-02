import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleMileageController } from "./vehicle-mileage.controller";
import { VehicleMileageService } from "./vehicle-mileage.service";

@Module({
  controllers: [VehicleMileageController],
  exports: [VehicleMileageService],
  imports: [AuthModule, PrismaModule],
  providers: [VehicleMileageService]
})
export class VehicleMileageModule {}
