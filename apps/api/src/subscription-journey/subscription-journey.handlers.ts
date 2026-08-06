import { Injectable } from "@nestjs/common";
import { Prisma, SubscriptionJourneyJobType } from "@prisma/client";

import { journeyError } from "./subscription-journey.errors";
import { SubscriptionJourneyService } from "./subscription-journey.service";
import { ClaimedJourneyJob } from "./subscription-journey.types";

@Injectable()
export class SubscriptionJourneyHandlers {
  readonly supportedJobTypes = Object.values(SubscriptionJourneyJobType);

  constructor(private readonly service: SubscriptionJourneyService) {}

  async handle(job: ClaimedJourneyJob): Promise<Prisma.InputJsonValue> {
    if (job.jobType === SubscriptionJourneyJobType.VALIDATE_APPLICATION) {
      return this.service.validateApplicationJob(job);
    }
    if (job.jobType === SubscriptionJourneyJobType.CREATE_ORDER_AND_CONTRACT) {
      return this.service.createOrderAndContractJob(job);
    }
    if (job.jobType === SubscriptionJourneyJobType.START_FADADA_SIGNING) {
      return this.service.startFadadaSigningJob(job);
    }
    if (job.jobType === SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING) {
      return this.service.reconcileFadadaSigningJob(job);
    }
    if (job.jobType === SubscriptionJourneyJobType.GENERATE_INITIAL_BILLS) {
      return this.service.generateInitialBillsJob(job);
    }
    if (
      job.jobType === SubscriptionJourneyJobType.EVALUATE_PAYMENT_SETTLEMENT
    ) {
      return this.service.evaluatePaymentSettlementJob(job);
    }
    throw journeyError(
      "JOURNEY_HANDLER_NOT_READY",
      "The subscription journey handler is not ready."
    );
  }
}
