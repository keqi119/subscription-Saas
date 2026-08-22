import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { BillingAutomationModule } from "../billing-automation/billing-automation.module";
import { ContractModule } from "../contract/contract.module";
import { ESignModule } from "../esign/esign.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SmsModule } from "../sms/sms.module";
import { SubscriptionClosureModule } from "../subscription-closure/subscription-closure.module";
import { VehicleInsuranceModule } from "../vehicle-insurance/vehicle-insurance.module";
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
import { SubscriptionExtensionContractService } from "./subscription-extension-contract.service";
import { SubscriptionExtensionService } from "./subscription-extension.service";
import { SubscriptionExtensionActivationService } from "./subscription-extension-activation.service";
import { SubscriptionExpiryService } from "./subscription-expiry.service";

@Module({
  controllers: [RenewalConsiderationController, SubscriptionChangeController],
  exports: [
    RenewalConsiderationService,
    SUBSCRIPTION_CHANGE_CONFIG,
    SubscriptionExtensionPricingService,
    SubscriptionExtensionContractService,
    SubscriptionExtensionActivationService,
    SubscriptionExpiryService,
    SubscriptionExtensionService
  ],
  imports: [
    AuditModule,
    AuthModule,
    BillingAutomationModule,
    ContractSegmentModule,
    ContractModule,
    ESignModule,
    NotificationModule,
    PrismaModule,
    SmsModule,
    SubscriptionClosureModule,
    VehicleInsuranceModule
  ],
  providers: [
    RenewalConsiderationService,
    SubscriptionChangeJobService,
    SubscriptionChangeWorker,
    SubscriptionExtensionPricingService,
    SubscriptionExtensionContractService,
    SubscriptionExtensionActivationService,
    SubscriptionExpiryService,
    SubscriptionExtensionService,
    {
      provide: SUBSCRIPTION_CHANGE_CONFIG,
      useFactory: loadSubscriptionChangeConfig
    }
  ]
})
export class SubscriptionChangeModule {}
