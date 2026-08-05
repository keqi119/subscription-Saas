import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingAutomationModule } from "../billing-automation/billing-automation.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SmsModule } from "../sms/sms.module";
import { ContractSegmentModule } from "./contract-segment.module";
import { RenewalConsiderationController } from "./renewal-consideration.controller";
import { RenewalConsiderationService } from "./renewal-consideration.service";
import {
  SUBSCRIPTION_CHANGE_CONFIG,
  loadSubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeController } from "./subscription-change.controller";
import { SubscriptionChangeJobService } from "./subscription-change-job.service";
import { SubscriptionChangeWorker } from "./subscription-change.worker";
import { SubscriptionExtensionPricingService } from "./subscription-extension-pricing.service";
import { SubscriptionExtensionService } from "./subscription-extension.service";

@Module({
  controllers: [RenewalConsiderationController, SubscriptionChangeController],
  exports: [
    RenewalConsiderationService,
    SubscriptionExtensionPricingService,
    SubscriptionExtensionService
  ],
  imports: [
    AuditModule,
    AuthModule,
    BillingAutomationModule,
    ContractSegmentModule,
    NotificationModule,
    PrismaModule,
    SmsModule
  ],
  providers: [
    RenewalConsiderationService,
    SubscriptionChangeJobService,
    SubscriptionChangeWorker,
    SubscriptionExtensionPricingService,
    SubscriptionExtensionService,
    {
      provide: SUBSCRIPTION_CHANGE_CONFIG,
      useFactory: loadSubscriptionChangeConfig
    }
  ]
})
export class SubscriptionChangeModule {}
