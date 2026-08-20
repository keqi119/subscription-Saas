import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AssetAccountingController } from "./asset-accounting.controller";
import { AssetAccountingRepository } from "./asset-accounting.repository";
import { AssetAccountingService } from "./asset-accounting.service";

@Module({
  controllers: [AssetAccountingController],
  exports: [AssetAccountingService],
  imports: [AuditModule, AuthModule, PrismaModule],
  providers: [AssetAccountingRepository, AssetAccountingService]
})
export class AssetAccountingModule {}
