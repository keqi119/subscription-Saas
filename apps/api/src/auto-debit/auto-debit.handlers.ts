import { Injectable } from "@nestjs/common";
import { SubscriptionAutomationJobType } from "@prisma/client";

import {
  BillingAutomationError,
  ClaimedBillingAutomationJob
} from "../billing-automation/billing-automation.types";
import { DebitAttemptService } from "./debit-attempt.service";

@Injectable()
export class AutoDebitHandlers {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT
  ] as const;

  constructor(private readonly service: DebitAttemptService) {}

  async handle(job: ClaimedBillingAutomationJob) {
    if (job.jobType === SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT) {
      return this.service.submitBillDebit(job);
    }
    if (job.jobType === SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT) {
      const result = await this.service.queryDebitAttempt(job);
      if (result.action === "PENDING_QUERY") {
        throw new BillingAutomationError({
          code: "AUTO_DEBIT_QUERY_PENDING",
          message: "Debit result is still pending provider confirmation.",
          retryable: true
        });
      }
      return result;
    }
    throw new Error("Unsupported auto debit job type.");
  }
}
