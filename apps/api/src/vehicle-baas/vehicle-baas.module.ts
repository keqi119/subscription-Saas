import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleBaasController } from "./vehicle-baas.controller";
import { VehicleBaasService } from "./vehicle-baas.service";

@Module({
  controllers: [VehicleBaasController],
  exports: [VehicleBaasService],
  imports: [AuthModule, PrismaModule, StorageModule],
  providers: [VehicleBaasService]
})
export class VehicleBaasModule {}
