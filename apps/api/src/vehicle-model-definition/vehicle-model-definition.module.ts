import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleModelDefinitionController } from "./vehicle-model-definition.controller";
import { VehicleModelDefinitionService } from "./vehicle-model-definition.service";

@Module({
  controllers: [VehicleModelDefinitionController],
  exports: [VehicleModelDefinitionService],
  imports: [AuthModule, PrismaModule],
  providers: [VehicleModelDefinitionService]
})
export class VehicleModelDefinitionModule {}
