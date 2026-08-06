import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { JourneySignalInput } from "./subscription-journey.types";

@Injectable()
export class SubscriptionJourneySignalService {
  constructor(private readonly repository: SubscriptionJourneyRepository) {}

  async record(
    tx: Prisma.TransactionClient,
    input: JourneySignalInput
  ): Promise<void> {
    if (input.type === "APPLICATION_SUBMITTED") {
      if (!input.applicationId) {
        throw journeyError(
          "JOURNEY_NOT_FOUND",
          "An application id is required to start a subscription journey."
        );
      }
      await this.repository.createOrGetForApplication(
        tx,
        input.applicationId,
        input.eventKey
      );
      return;
    }
    if (!input.applicationId && !input.orderId) {
      throw journeyError(
        "JOURNEY_NOT_FOUND",
        "An application or order id is required to record a journey signal."
      );
    }
    await this.repository.recordSignal(tx, input);
  }
}
