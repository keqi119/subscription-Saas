import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleController } from "./vehicle.controller";
import { VehicleService } from "./vehicle.service";

@Module({
  controllers: [VehicleController],
  imports: [PrismaModule, AuditModule, AuthModule],
  providers: [VehicleService]
})
export class VehicleModule {}
