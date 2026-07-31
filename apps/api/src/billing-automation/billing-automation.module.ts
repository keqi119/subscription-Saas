import { Module } from "@nestjs/common";

import { FinanceModule } from "../finance/finance.module";
import { NotificationModule } from "../notification/notification.module";
import { BillingAutomationHandlers } from "./billing-automation.handlers";
import { BillingAutomationRepository } from "./billing-automation.repository";
import { BillingAutomationService } from "./billing-automation.service";
import { BillingAutomationWorker } from "./billing-automation.worker";

@Module({
  exports: [BillingAutomationRepository, BillingAutomationService],
  imports: [FinanceModule, NotificationModule],
  providers: [
    BillingAutomationHandlers,
    BillingAutomationRepository,
    BillingAutomationService,
    BillingAutomationWorker
  ]
})
export class BillingAutomationModule {}
