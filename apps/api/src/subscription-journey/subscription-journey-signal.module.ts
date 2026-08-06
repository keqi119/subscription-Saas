import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { SubscriptionJourneySignalService } from "./subscription-journey-signal.service";
import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";

@Module({
  exports: [SubscriptionJourneySignalService],
  imports: [PrismaModule],
  providers: [
    SubscriptionJourneyRepository,
    SubscriptionJourneyRuntimeConfig,
    SubscriptionJourneySignalService
  ]
})
export class SubscriptionJourneySignalModule {}
