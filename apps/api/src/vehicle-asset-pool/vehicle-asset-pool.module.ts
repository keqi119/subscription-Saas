import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { VehicleAssetPoolController } from "./vehicle-asset-pool.controller";
import { VehicleAssetPoolService } from "./vehicle-asset-pool.service";

@Module({
  controllers: [VehicleAssetPoolController],
  imports: [AuditModule, AuthModule],
  providers: [VehicleAssetPoolService]
})
export class VehicleAssetPoolModule {}
