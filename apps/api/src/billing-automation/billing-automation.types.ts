import {
  Prisma,
  SubscriptionAutomationJob,
  SubscriptionAutomationJobType
} from "@prisma/client";

export type BillingAutomationDb = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "$queryRaw" | "subscriptionAutomationJob"
>;

export interface EnqueueBillingAutomationJobInput {
  availableAt?: Date;
  billId?: string;
  billingScheduleId?: string;
  changeOrderId?: string;
  contractSegmentId?: string;
  idempotencyKey: string;
  jobType: SubscriptionAutomationJobType;
  maxAttempts?: number;
  orderId?: string;
  payload?: Prisma.InputJsonValue;
  renewalConsiderationId?: string;
}

export type ClaimedBillingAutomationJob = Omit<
  SubscriptionAutomationJob,
  "leaseExpiresAt" | "leaseToken"
> & {
  leaseExpiresAt: Date;
  leaseToken: string;
};

export interface BillingAutomationFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RescheduleBillingAutomationJobInput {
  delayMs: number;
  error: BillingAutomationFailure;
}

export class BillingAutomationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(input: BillingAutomationFailure) {
    super(input.message);
    this.name = "BillingAutomationError";
    this.code = input.code;
    this.retryable = input.retryable;
  }
}
