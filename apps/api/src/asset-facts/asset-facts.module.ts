import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AssetFactsController } from "./asset-facts.controller";
import { AssetFactsRepository } from "./asset-facts.repository";
import { AssetFactsService } from "./asset-facts.service";

@Module({
  controllers: [AssetFactsController],
  exports: [AssetFactsService],
  imports: [AuditModule, AuthModule, PrismaModule],
  providers: [AssetFactsRepository, AssetFactsService]
})
export class AssetFactsModule {}
