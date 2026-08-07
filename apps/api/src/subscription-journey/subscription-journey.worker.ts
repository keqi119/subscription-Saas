import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from "@nestjs/common";
import { Prisma, SubscriptionJourneyJobType } from "@prisma/client";

import { SubscriptionJourneyRuntimeConfig } from "./subscription-journey.config";
import { SubscriptionJourneyError } from "./subscription-journey.errors";
import { SubscriptionJourneyHandlers } from "./subscription-journey.handlers";
import { SubscriptionJourneyRepository } from "./subscription-journey.repository";
import { SubscriptionJourneyService } from "./subscription-journey.service";
import {
  ClaimedJourneyJob,
  ClaimedJourneyOutbox,
  JourneyFailure
} from "./subscription-journey.types";
import { PrismaService } from "../prisma/prisma.service";

const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;
const FADADA_RECONCILE_DELAYS_MS = [300_000, 1_800_000, 21_600_000] as const;
const MAX_OUTBOX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 7_200_000;

type SanitizedFailure = JourneyFailure & { retryAfterMs?: number };

@Injectable()
export class SubscriptionJourneyWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SubscriptionJourneyWorker.name);
  private activePoll?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: SubscriptionJourneyRepository,
    private readonly handlers: SubscriptionJourneyHandlers,
    private readonly service: SubscriptionJourneyService,
    private readonly config: SubscriptionJourneyRuntimeConfig
  ) {}

  onModuleInit(): void {
    this.config.validate();
    if (this.config.workerEnabled) this.schedulePoll(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.activePoll;
  }

  async runOnce(): Promise<void> {
    await this.runSignalLane();
    await this.runJobLane();
    await this.runNotificationLane();
  }

  private async runSignalLane(): Promise<void> {
    const rows = await this.prisma.$transaction((tx) =>
      this.repository.claimSignalOutbox(
        tx,
        this.config.claimLimit,
        this.config.leaseMs
      )
    );
    for (const row of rows) {
      await this.handleOutbox(row, (tx) =>
        this.service.dispatchSignalOutbox(tx, row)
      );
    }
  }

  private async runJobLane(): Promise<void> {
    const jobs = await this.prisma.$transaction((tx) =>
      this.repository.claimJobs(
        tx,
        this.config.claimLimit,
        this.config.leaseMs
      )
    );
    for (const job of jobs) await this.handleJob(job);
  }

  private async runNotificationLane(): Promise<void> {
    const rows = await this.prisma.$transaction((tx) =>
      this.repository.claimNotificationOutbox(
        tx,
        this.config.claimLimit,
        this.config.leaseMs
      )
    );
    for (const row of rows) {
      await this.handleOutbox(row, (tx) =>
        this.service.dispatchNotificationOutbox(tx, row)
      );
    }
  }

  private async handleJob(job: ClaimedJourneyJob): Promise<void> {
    try {
      const result = await this.handlers.handle(job);
      await this.prisma.$transaction((tx) =>
        this.repository.completeJob(tx, job.id, job.leaseToken, result)
      );
    } catch (error) {
      const failure = sanitizeJourneyFailure(error);
      const failedExecution = job.attemptCount + 1;
      if (!failure.retryable || failedExecution >= job.maxAttempts) {
        await this.prisma.$transaction((tx) =>
          this.repository.deadLetterJob(tx, {
            error: withoutRetryAfter(failure),
            jobId: job.id,
            journeyId: job.journeyId,
            leaseToken: job.leaseToken,
            stepId: job.stepId
          })
        );
      } else {
        await this.prisma.$transaction((tx) =>
          this.repository.rescheduleJob(tx, job.id, job.leaseToken, {
            delayMs: retryDelayForJob(job, failure),
            error: withoutRetryAfter(failure)
          })
        );
      }
      this.logger.warn({
        attemptCount: failedExecution,
        errorCode: failure.code,
        jobId: job.id,
        jobType: job.jobType
      });
    }
  }

  private async handleOutbox(
    outbox: ClaimedJourneyOutbox,
    dispatch: (tx: Prisma.TransactionClient) => Promise<void>
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await dispatch(tx);
        await this.repository.completeOutbox(
          tx,
          outbox.id,
          outbox.leaseToken
        );
      });
    } catch (error) {
      const failure = sanitizeJourneyFailure(error);
      const failedAttempt = outbox.attemptCount + 1;
      if (!failure.retryable || failedAttempt >= MAX_OUTBOX_ATTEMPTS) {
        await this.prisma.$transaction((tx) =>
          this.repository.deadLetterOutbox(
            tx,
            outbox.id,
            outbox.leaseToken,
            withoutRetryAfter(failure)
          )
        );
      } else {
        const delayMs =
          failure.retryAfterMs === undefined
            ? jitteredRetryDelayMs(baseRetryDelayMs(failedAttempt), Math.random())
            : capRetryAfterMs(failure.retryAfterMs);
        await this.prisma.$transaction((tx) =>
          this.repository.rescheduleOutbox(
            tx,
            outbox.id,
            outbox.leaseToken,
            { delayMs, error: withoutRetryAfter(failure) }
          )
        );
      }
      this.logger.warn({
        attemptCount: failedAttempt,
        errorCode: failure.code,
        eventType: outbox.eventType,
        outboxId: outbox.id
      });
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      const poll = this.runOnce()
        .catch((error) => {
          this.logger.error({
            errorCode: sanitizeJourneyFailure(error).code,
            operation: "SUBSCRIPTION_JOURNEY_POLL"
          });
        })
        .finally(() => {
          this.activePoll = undefined;
          this.schedulePoll(this.config.pollIntervalMs);
        });
      this.activePoll = poll;
    }, delayMs);
    this.pollTimer.unref?.();
  }
}

export function baseRetryDelayMs(failedExecution: number): number {
  const index = Math.min(
    Math.max(Math.trunc(failedExecution) - 1, 0),
    DEFAULT_RETRY_DELAYS_MS.length - 1
  );
  return DEFAULT_RETRY_DELAYS_MS[index]!;
}

export function jitteredRetryDelayMs(baseMs: number, random: number): number {
  const boundedRandom = Math.min(Math.max(random, 0), 1);
  return baseMs + Math.floor(baseMs * 0.2 * boundedRandom);
}

export function capRetryAfterMs(retryAfterMs: number): number {
  return Math.min(Math.max(Math.trunc(retryAfterMs), 0), MAX_RETRY_AFTER_MS);
}

export function fadadaReconcileDelayMs(observation: number): number {
  const index = Math.min(
    Math.max(Math.trunc(observation) - 1, 0),
    FADADA_RECONCILE_DELAYS_MS.length - 1
  );
  return FADADA_RECONCILE_DELAYS_MS[index]!;
}

export function sanitizeJourneyFailure(error: unknown): SanitizedFailure {
  if (error instanceof SubscriptionJourneyError) {
    if (error.code === "JOURNEY_HANDLER_NOT_READY") {
      return {
        code: error.code,
        message: "The subscription journey handler is not ready.",
        retryable: false
      };
    }
    if (error.code === "JOURNEY_CONFIGURATION_ERROR") {
      return {
        code: error.code,
        message: "Subscription journey worker configuration is invalid.",
        retryable: false
      };
    }
    return {
      code: error.code,
      message: "Subscription journey operation failed.",
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs
    };
  }
  return {
    code: "JOURNEY_EXECUTION_ERROR",
    message: "Subscription journey operation failed.",
    retryable: true
  };
}

function retryDelayForJob(
  job: ClaimedJourneyJob,
  failure: SanitizedFailure
): number {
  if (failure.retryAfterMs !== undefined) {
    return capRetryAfterMs(failure.retryAfterMs);
  }
  const failedExecution = job.attemptCount + 1;
  if (job.jobType === SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING) {
    return fadadaReconcileDelayMs(failedExecution);
  }
  return jitteredRetryDelayMs(
    baseRetryDelayMs(failedExecution),
    Math.random()
  );
}

function withoutRetryAfter(failure: SanitizedFailure): JourneyFailure {
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable
  };
}
