import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AutoDebitModule } from "../auto-debit/auto-debit.module";
import { AuthModule } from "../auth/auth.module";
import { FinanceModule } from "../finance/finance.module";
import { NotificationModule } from "../notification/notification.module";
import { BillingAutomationAdminService } from "./billing-automation.admin.service";
import { BillingAutomationController } from "./billing-automation.controller";
import { BillingAutomationHandlers } from "./billing-automation.handlers";
import { BillingAutomationRepository } from "./billing-automation.repository";
import { BillingAutomationService } from "./billing-automation.service";
import { BillingAutomationWorker } from "./billing-automation.worker";

@Module({
  controllers: [BillingAutomationController],
  exports: [BillingAutomationRepository, BillingAutomationService],
  imports: [
    AuditModule,
    AutoDebitModule,
    AuthModule,
    FinanceModule,
    NotificationModule
  ],
  providers: [
    BillingAutomationAdminService,
    BillingAutomationHandlers,
    BillingAutomationRepository,
    BillingAutomationService,
    BillingAutomationWorker
  ]
})
export class BillingAutomationModule {}
