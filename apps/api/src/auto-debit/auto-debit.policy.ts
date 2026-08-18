import { SubscriptionAutomationJobType } from "@prisma/client";

export const STAGE1_COLLECTION_MODE = "ACTIVE_PAYMENT_ONLY" as const;

export const STAGE1_AUTO_DEBIT_JOB_TYPES = [
  SubscriptionAutomationJobType.SUBMIT_BILL_DEBIT,
  SubscriptionAutomationJobType.QUERY_DEBIT_ATTEMPT,
  SubscriptionAutomationJobType.SEND_DEBIT_FAILURE_NOTICE,
  SubscriptionAutomationJobType.SYNC_PAYMENT_MANDATE
] as const;

export function isStage1AutoDebitJobType(value: SubscriptionAutomationJobType) {
  return STAGE1_AUTO_DEBIT_JOB_TYPES.includes(
    value as (typeof STAGE1_AUTO_DEBIT_JOB_TYPES)[number]
  );
}
