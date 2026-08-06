import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { JourneySignalInput } from "./subscription-journey.types";
import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";

@Injectable()
export class SubscriptionJourneySignalService {
  constructor(
    private readonly repository: SubscriptionJourneyRepository,
    private readonly config: SubscriptionJourneyRuntimeConfig
  ) {}

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
      const existingJourney = await tx.subscriptionJourney.findUnique({
        where: { applicationId: input.applicationId }
      });
      if (!existingJourney) {
        if (!this.config.enabled) return;
        const application = await tx.application.findUnique({
          select: { customerId: true },
          where: { id: input.applicationId }
        });
        if (!application) {
          throw journeyError(
            "JOURNEY_NOT_FOUND",
            "The subscription application was not found."
          );
        }
        if (
          !this.config.permitsEnrollment(
            input.applicationId,
            application.customerId
          )
        ) {
          return;
        }
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
