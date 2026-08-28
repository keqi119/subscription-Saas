import type {
  Prisma,
  SubscriptionJourneyJob,
  SubscriptionJourneyJobType,
  SubscriptionJourneyManualDecision,
  SubscriptionJourneyManualTask,
  SubscriptionJourneyOutbox,
  SubscriptionJourneyStep
} from "@prisma/client";

export type JourneySignalType =
  | "APPLICATION_FACTS_CHANGED"
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
  factVersion?: number;
  journeyId: string;
  payload?: Prisma.InputJsonValue;
  stepId: string;
}

export interface CompleteJourneyActivationInput {
  expectedVersion: number;
  journeyId: string;
  payload?: Prisma.InputJsonValue;
  stepId: string;
}

export interface WaitForCustomerInput {
  eventKey: string;
  expectedVersion: number;
  factVersion?: number;
  journeyId: string;
  payload?: Prisma.InputJsonValue;
  stepId: string;
}

export interface WaitForManualInput extends WaitForCustomerInput {
  factVersion: number;
}

export interface RejectJourneyForApplicationInput extends WaitForCustomerInput {
  activeJobId?: string;
  factVersion: number;
}

export interface OpenManualTaskInput {
  inputSnapshot: Prisma.InputJsonValue;
  journeyId: string;
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

export type ClaimedJourneyOutbox = Omit<
  SubscriptionJourneyOutbox,
  "leaseExpiresAt" | "leaseToken"
> & {
  leaseExpiresAt: Date;
  leaseToken: string;
};

export interface JourneyOperationalMetrics {
  lastEventAt: Date | null;
  lastSuccessfulJobAt: Date | null;
  oldestOpenExceptionAt: Date | null;
  oldestPendingJobAt: Date | null;
  oldestPendingOutboxAt: Date | null;
  openExceptionCount: number;
  pendingJobCount: number;
  pendingOutboxCount: number;
  workerHeartbeatAt: Date | null;
}

export type JourneyStepResult = SubscriptionJourneyStep;
export type JourneyManualTaskResult = SubscriptionJourneyManualTask;
