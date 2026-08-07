import { Module } from "@nestjs/common";

import { SubscriptionJourneySignalModule } from "../subscription-journey/subscription-journey-signal.module";
import { DeliveryEvidenceService } from "./delivery-evidence.service";

@Module({
  exports: [DeliveryEvidenceService],
  imports: [SubscriptionJourneySignalModule],
  providers: [DeliveryEvidenceService]
})
export class DeliveryEvidenceModule {}
