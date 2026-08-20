import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AssetOperationsModule } from "../asset-operations/asset-operations.module";
import { AuthModule } from "../auth/auth.module";
import { NotificationModule } from "../notification/notification.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RiskModule } from "../risk/risk.module";
import { StorageModule } from "../storage/storage.module";
import { SubscriptionJourneySignalModule } from "../subscription-journey/subscription-journey-signal.module";
import { CustomerController } from "./customer.controller";
import { CustomerService } from "./customer.service";

@Module({
  controllers: [CustomerController],
  exports: [CustomerService],
  imports: [
    PrismaModule,
    AssetOperationsModule,
    AuditModule,
    AuthModule,
    NotificationModule,
    RiskModule,
    StorageModule,
    SubscriptionJourneySignalModule
  ],
  providers: [CustomerService]
})
export class CustomerModule {}
