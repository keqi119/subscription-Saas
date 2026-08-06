import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { SubscriptionJourneySignalService } from "./subscription-journey-signal.service";

@Module({
  exports: [SubscriptionJourneySignalService],
  imports: [PrismaModule],
  providers: [SubscriptionJourneyRepository, SubscriptionJourneySignalService]
})
export class SubscriptionJourneySignalModule {}
