import { Module } from "@nestjs/common";

import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AssetFactsModule } from "../asset-facts/asset-facts.module";
import { AssetAccountingModule } from "../asset-accounting/asset-accounting.module";
import { AuditModule } from "../audit/audit.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { SubscriptionClosureRepository } from "./subscription-closure.repository";
import { SubscriptionClosureSettlementResolver } from "./subscription-closure.settlement-resolver";
import { SubscriptionClosureService } from "./subscription-closure.service";

@Module({
  exports: [SubscriptionClosureService],
  imports: [
    AssetAccountingModule,
    AssetFactsModule,
    AssetOperationsModule,
    AuditModule,
    HandoverWorkOrderModule,
    PrismaModule,
    VehicleMileageModule
  ],
  providers: [
    SubscriptionClosureRepository,
    SubscriptionClosureService,
    SubscriptionClosureSettlementResolver
  ]
})
export class SubscriptionClosureModule {}
