import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SubscriptionJourneySignalModule } from "../subscription-journey/subscription-journey-signal.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";

@Module({
  controllers: [FinanceController],
  exports: [FinanceService],
  imports: [AuditModule, AuthModule, SubscriptionJourneySignalModule],
  providers: [FinanceService]
})
export class FinanceModule {}
