import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ContractSegmentModule } from "./contract-segment.module";
import {
  SUBSCRIPTION_CHANGE_CONFIG,
  loadSubscriptionChangeConfig
} from "./subscription-change.config";
import { SubscriptionChangeController } from "./subscription-change.controller";
import { SubscriptionExtensionPricingService } from "./subscription-extension-pricing.service";
import { SubscriptionExtensionService } from "./subscription-extension.service";

@Module({
  controllers: [SubscriptionChangeController],
  exports: [SubscriptionExtensionPricingService, SubscriptionExtensionService],
  imports: [AuditModule, AuthModule, ContractSegmentModule, PrismaModule],
  providers: [
    SubscriptionExtensionPricingService,
    SubscriptionExtensionService,
    {
      provide: SUBSCRIPTION_CHANGE_CONFIG,
      useFactory: loadSubscriptionChangeConfig
    }
  ]
})
export class SubscriptionChangeModule {}
