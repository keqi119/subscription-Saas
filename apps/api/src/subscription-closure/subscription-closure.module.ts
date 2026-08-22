import { Module } from "@nestjs/common";

import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AssetFactsModule } from "../asset-facts/asset-facts.module";
import { AssetAccountingModule } from "../asset-accounting/asset-accounting.module";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { PrismaModule } from "../prisma/prisma.module";
import { VehicleMileageModule } from "../vehicle-mileage/vehicle-mileage.module";
import { SubscriptionClosureRepository } from "./subscription-closure.repository";
import { SubscriptionClosureController } from "./subscription-closure.controller";
import { SubscriptionClosureProjectionService } from "./subscription-closure.projection";
import { SubscriptionClosureSettlementResolver } from "./subscription-closure.settlement-resolver";
import { SubscriptionClosureService } from "./subscription-closure.service";

@Module({
  controllers: [SubscriptionClosureController],
  exports: [SubscriptionClosureProjectionService, SubscriptionClosureService],
  imports: [
    AssetAccountingModule,
    AssetFactsModule,
    AssetOperationsModule,
    AuditModule,
    AuthModule,
    HandoverWorkOrderModule,
    PrismaModule,
    VehicleMileageModule
  ],
  providers: [
    SubscriptionClosureRepository,
    SubscriptionClosureProjectionService,
    SubscriptionClosureService,
    SubscriptionClosureSettlementResolver
  ]
})
export class SubscriptionClosureModule {}
