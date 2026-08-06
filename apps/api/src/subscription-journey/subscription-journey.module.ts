import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { CustomerModule } from "../customer/customer.module";
import { ESignModule } from "../esign/esign.module";
import { FinanceModule } from "../finance/finance.module";
import { HandoverWorkOrderModule } from "../handover-work-order/handover-work-order.module";
import { LeaseModule } from "../lease/lease.module";
import { OrderModule } from "../order/order.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";
import { SubscriptionJourneyController } from "./subscription-journey.controller";
import { SubscriptionJourneyHandlers } from "./subscription-journey.handlers";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { SubscriptionJourneyService } from "./subscription-journey.service";
import { SubscriptionJourneySignalModule } from "./subscription-journey-signal.module";
import { SubscriptionJourneyWorker } from "./subscription-journey.worker";

@Module({
  controllers: [SubscriptionJourneyController],
  exports: [SubscriptionJourneyService],
  imports: [
    AuditModule,
    AuthModule,
    CustomerModule,
    ESignModule,
    FinanceModule,
    HandoverWorkOrderModule,
    LeaseModule,
    OrderModule,
    PrismaModule,
    SubscriptionJourneySignalModule
  ],
  providers: [
    SubscriptionJourneyRuntimeConfig,
    SubscriptionJourneyHandlers,
    SubscriptionJourneyRepository,
    SubscriptionJourneyService,
    SubscriptionJourneyWorker
  ]
})
export class SubscriptionJourneyModule {}
