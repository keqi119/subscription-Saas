import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { FinancingController } from "./financing.controller";
import { FinancingService } from "./financing.service";

@Module({
  controllers: [FinancingController],
  imports: [AuditModule, AuthModule],
  providers: [FinancingService]
})
export class FinancingModule {}
