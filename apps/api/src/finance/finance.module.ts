import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";

@Module({
  controllers: [FinanceController],
  exports: [FinanceService],
  imports: [AuditModule, AuthModule],
  providers: [FinanceService]
})
export class FinanceModule {}
