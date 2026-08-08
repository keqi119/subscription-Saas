import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleInsuranceController } from "./vehicle-insurance.controller";
import { VehicleInsuranceService } from "./vehicle-insurance.service";

@Module({
  controllers: [VehicleInsuranceController],
  exports: [VehicleInsuranceService],
  imports: [AuditModule, AuthModule, PrismaModule, StorageModule],
  providers: [VehicleInsuranceService]
})
export class VehicleInsuranceModule {}
