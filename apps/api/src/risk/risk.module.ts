import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RiskController } from "./risk.controller";
import { RiskService } from "./risk.service";

@Module({
  controllers: [RiskController],
  exports: [RiskService],
  imports: [PrismaModule, AuditModule, AuthModule],
  providers: [RiskService]
})
export class RiskModule {}
