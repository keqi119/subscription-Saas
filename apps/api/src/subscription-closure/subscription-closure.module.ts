import { Module } from "@nestjs/common";

import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AssetFactsModule } from "../asset-facts/asset-facts.module";
import { AssetAccountingModule } from "../asset-accounting/asset-accounting.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PaymentModule } from "../payment/payment.module";
import { StorageModule } from "../storage/storage.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { ESignModule } from "../esign/esign.module";
import { SubscriptionClosureRepository } from "./subscription-closure.repository";
import { SubscriptionClosureController } from "./subscription-closure.controller";
import { SubscriptionClosureProjectionService } from "./subscription-closure.projection";
import { SubscriptionClosureSettlementResolver } from "./subscription-closure.settlement-resolver";
import { SubscriptionClosureService } from "./subscription-closure.service";
import { SubscriptionClosureEvidencePackageService } from "./subscription-closure-evidence-package.service";
import { SubscriptionClosureFinancialService } from "./subscription-closure-financial.service";
import { SubscriptionClosurePricingService } from "./subscription-closure-pricing.service";
import { SubscriptionReturnDeltaService } from "./subscription-return-delta.service";
import { SubscriptionReturnGovernanceService } from "./subscription-return-governance.service";

@Module({
  controllers: [SubscriptionClosureController],
  exports: [
    SubscriptionClosureEvidencePackageService,
    SubscriptionClosureProjectionService,
    SubscriptionClosureService,
    SubscriptionReturnGovernanceService
  ],
  imports: [
    AssetAccountingModule,
    AssetFactsModule,
    AssetOperationsModule,
    AuditModule,
    AuthModule,
    ESignModule,
    HandoverWorkOrderModule,
    PaymentModule,
    PrismaModule,
    StorageModule,
    VehicleMileageModule
  ],
  providers: [
    SubscriptionClosureRepository,
    SubscriptionClosureEvidencePackageService,
    SubscriptionClosureFinancialService,
    SubscriptionClosurePricingService,
    SubscriptionClosureProjectionService,
    SubscriptionClosureService,
    SubscriptionClosureSettlementResolver,
    SubscriptionReturnDeltaService,
    SubscriptionReturnGovernanceService
  ]
})
export class SubscriptionClosureModule {}
