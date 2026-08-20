import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AuthModule } from "../auth/auth.module";
import { BillingAutomationModule } from "../billing-automation/billing-automation.module";
import { DeliveryEvidenceModule } from "../delivery-evidence/delivery-evidence.module";
import { FinanceModule } from "../finance/finance.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { MileageReviewModule } from "../mileage-review/mileage-review.module";
import { OrderEntitlementService } from "../order/order-entitlement.service";
import { SubscriptionJourneyRepository } from "../subscription-journey/subscription-journey.repository";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { LeaseActivationEngine } from "./lease-activation.engine";
import { LeaseController } from "./lease.controller";

@Module({
  controllers: [LeaseController],
  exports: [LeaseActivationEngine],
  imports: [
    AuditModule,
    AssetOperationsModule,
    AuthModule,
    BillingAutomationModule,
    DeliveryEvidenceModule,
    FinanceModule,
    HandoverWorkOrderModule,
    MileageReviewModule,
    VehicleMileageModule
  ],
  providers: [
    LeaseActivationEngine,
    OrderEntitlementService,
    SubscriptionJourneyRepository
  ]
})
export class LeaseModule {}
