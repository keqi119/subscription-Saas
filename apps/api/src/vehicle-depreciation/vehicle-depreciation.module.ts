import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleDepreciationController } from "./vehicle-depreciation.controller";
import { VehicleDepreciationService } from "./vehicle-depreciation.service";

@Module({
  controllers: [VehicleDepreciationController],
  exports: [VehicleDepreciationService],
  imports: [AuthModule, PrismaModule],
  providers: [VehicleDepreciationService]
})
export class VehicleDepreciationModule {}
