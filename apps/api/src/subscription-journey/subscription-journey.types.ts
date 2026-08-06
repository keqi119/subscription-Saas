import type {
  Prisma,
  SubscriptionJourneyJob,
  SubscriptionJourneyJobType,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyManualTask,
  SubscriptionJourneyStep,
  SubscriptionJourneyStepCode
} from "@prisma/client";

export type JourneySignalType =
  | "APPLICATION_SUBMITTED"
  | "CUSTOMER_PLAN_CONFIRMED"
  | "FADADA_TASK_COMPLETED"
  | "FADADA_ARTIFACT_ARCHIVED"
  | "PAYMENT_SETTLED"
  | "HANDOVER_EVIDENCE_READY"
  | "HANDOVER_OPS_REVIEWED";

export interface JourneySignalInput {
  applicationId?: string;
  orderId?: string;
  type: JourneySignalType;
  eventKey: string;
  payload?: Prisma.InputJsonValue;
}

export interface CompleteJourneyStepInput {
  eventKey: string;
  expectedVersion: number;
  journeyId: string;
  nextStepCode: SubscriptionJourneyStepCode | null;
  payload?: Prisma.InputJsonValue;
  stepCode: SubscriptionJourneyStepCode;
  stepId: string;
}

export interface WaitForCustomerInput {
  eventKey: string;
  expectedVersion: number;
  journeyId: string;
  payload?: Prisma.InputJsonValue;
  stepCode: SubscriptionJourneyStepCode;
  stepId: string;
}

export interface OpenManualTaskInput {
  inputSnapshot: Prisma.InputJsonValue;
  journeyId: string;
  stepCode: SubscriptionJourneyStepCode;
  stepId: string;
}

export interface DecideManualTaskInput {
  decidedBy: string;
  decision: SubscriptionJourneyManualDecision;
  decisionNotes?: string;
  expectedVersion: number;
  journeyId: string;
  taskId: string;
}

export interface EnqueueJourneyJobInput {
  availableAt?: Date;
  jobType: SubscriptionJourneyJobType;
  journeyId: string;
  maxAttempts?: number;
  payload?: Prisma.InputJsonValue;
  sourceKey: string;
  stepId: string;
}

export interface JourneyFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RecordJourneyExceptionInput {
  error: JourneyFailure;
  jobId?: string;
  journeyId: string;
  stepId: string;
}

export interface RescheduleJourneyJobInput {
  delayMs: number;
  error: JourneyFailure;
}

export interface DeadLetterJourneyJobInput
  extends RecordJourneyExceptionInput {
  jobId: string;
  leaseToken: string;
}

export type ClaimedJourneyJob = Omit<
  SubscriptionJourneyJob,
  "leaseExpiresAt" | "leaseToken"
> & {
  leaseExpiresAt: Date;
  leaseToken: string;
};

export type JourneyStepResult = SubscriptionJourneyStep;
export type JourneyManualTaskResult = SubscriptionJourneyManualTask;
