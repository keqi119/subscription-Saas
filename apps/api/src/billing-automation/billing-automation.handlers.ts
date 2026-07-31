import { Injectable } from "@nestjs/common";
import { SubscriptionAutomationJobType } from "@prisma/client";

import { BillingAutomationService } from "./billing-automation.service";
import { ClaimedBillingAutomationJob } from "./billing-automation.types";

@Injectable()
export class BillingAutomationHandlers {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL,
    SubscriptionAutomationJobType.MARK_BILL_OVERDUE
  ] as const;

  constructor(private readonly service: BillingAutomationService) {}

  async handle(job: ClaimedBillingAutomationJob) {
    switch (job.jobType) {
      case SubscriptionAutomationJobType.GENERATE_MONTHLY_RENT_BILL:
        return this.service.generateScheduledMonthlyRent(job);
      case SubscriptionAutomationJobType.MARK_BILL_OVERDUE:
        return this.service.markScheduledBillOverdue(job);
      default:
        throw new Error("Unsupported billing automation job type.");
    }
  }
}
