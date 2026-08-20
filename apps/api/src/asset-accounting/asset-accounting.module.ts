import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AssetAccountingRepository } from "./asset-accounting.repository";
import { AssetAccountingService } from "./asset-accounting.service";

@Module({
  exports: [AssetAccountingService],
  imports: [AuditModule, PrismaModule],
  providers: [AssetAccountingRepository, AssetAccountingService]
})
export class AssetAccountingModule {}
