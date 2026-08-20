import { Module } from "@nestjs/common";

import { AssetAccountingModule } from "../asset-accounting/asset-accounting.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AssetOperationsController } from "./asset-operations.controller";
import { AssetOperationsRepository } from "./asset-operations.repository";
import { AssetOperationsService } from "./asset-operations.service";

@Module({
  controllers: [AssetOperationsController],
  imports: [AssetAccountingModule, AuditModule, AuthModule, PrismaModule],
  providers: [AssetOperationsRepository, AssetOperationsService],
  exports: [AssetOperationsService]
})
export class AssetOperationsModule {}
