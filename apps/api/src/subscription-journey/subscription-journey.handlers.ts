import { Injectable } from "@nestjs/common";
import { Prisma, SubscriptionJourneyJobType } from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { ClaimedJourneyJob } from "./subscription-journey.types";

@Injectable()
export class SubscriptionJourneyHandlers {
  readonly supportedJobTypes = Object.values(SubscriptionJourneyJobType);

  async handle(job: ClaimedJourneyJob): Promise<Prisma.InputJsonValue> {
    void job;
    throw journeyError(
      "JOURNEY_HANDLER_NOT_READY",
      "The subscription journey handler is not ready."
    );
  }
}
