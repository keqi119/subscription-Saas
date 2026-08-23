import { BadRequestException } from "@nestjs/common";
import { SubscriptionAutomationJobType } from "@prisma/client";

export const STAGE1_COLLECTION_MODE = "ACTIVE_PAYMENT_ONLY" as const;
export const STAGE1_AUTO_DEBIT_DISABLED_CODE = "AUTO_DEBIT_STAGE1_BASELINE_DISABLED" as const;

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

export function stage1AutoDebitDisabledException(
  message = "阶段 1 采用主动支付与自动催收，委托代扣变更操作已停用。"
) {
  return new BadRequestException({
    code: STAGE1_AUTO_DEBIT_DISABLED_CODE,
    message
  });
}
