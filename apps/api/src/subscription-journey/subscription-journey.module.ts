import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";
import { SubscriptionJourneyHandlers } from "./subscription-journey.handlers";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { SubscriptionJourneyService } from "./subscription-journey.service";
import { SubscriptionJourneySignalModule } from "./subscription-journey-signal.module";
import { SubscriptionJourneyWorker } from "./subscription-journey.worker";

@Module({
  exports: [SubscriptionJourneyService],
  imports: [PrismaModule, SubscriptionJourneySignalModule],
  providers: [
    SubscriptionJourneyRuntimeConfig,
    SubscriptionJourneyHandlers,
    SubscriptionJourneyRepository,
    SubscriptionJourneyService,
    SubscriptionJourneyWorker
  ]
})
export class SubscriptionJourneyModule {}
