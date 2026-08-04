import { Injectable } from "@nestjs/common";
import { SubscriptionAutomationJobType } from "@prisma/client";

import {
  BillingAutomationError,
  ClaimedBillingAutomationJob
} from "../billing-automation/billing-automation.types";
import { DebitAttemptService } from "./debit-attempt.service";
import { NotificationService } from "../notification/notification.service";

@Injectable()
export class AutoDebitHandlers {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
    SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
    SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE
  ] as const;

  constructor(
    private readonly service: DebitAttemptService,
    private readonly notifications: NotificationService
  ) {}

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
    if (job.jobType === SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE) {
      const attemptId = debitAttemptId(job);
      const records = await this.notifications.notifyAutoDebitFailure({
        attemptId,
        idempotencyKey: job.idempotencyKey
      });
      return {
        action: records.length > 0 ? "NOTIFIED" : "SKIPPED",
        attemptId,
        recordCount: records.length
      };
    }
    throw new Error("Unsupported auto debit job type.");
  }
}

function debitAttemptId(job: ClaimedBillingAutomationJob) {
  const payload = job.payload;
  const value =
    payload && !Array.isArray(payload) && typeof payload === "object"
      ? payload.debitAttemptId
      : undefined;
  if (typeof value !== "string" || !value) {
    throw new Error("Debit attempt id is missing from notification job.");
  }
  return value;
}
