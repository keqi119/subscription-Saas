import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import { BillingAutomationHandlers } from "./billing-automation.handlers";
import { BillingAutomationRepository } from "./billing-automation.repository";
import { BillingAutomationService } from "./billing-automation.service";
import {
  BillingAutomationError,
  BillingAutomationFailure,
  ClaimedBillingAutomationJob
} from "./billing-automation.types";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

@Injectable()
export class BillingAutomationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingAutomationWorker.name);
  private activePoll?: Promise<void>;
  private nextMaintenanceAt = 0;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly repository: BillingAutomationRepository,
    private readonly service: BillingAutomationService,
    private readonly handlers: BillingAutomationHandlers,
    private readonly config: ConfigService
  ) {}

  onModuleInit() {
    if (this.isEnabled()) {
      this.schedulePoll(0);
    }
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.activePoll;
  }

  async runOnce() {
    await this.runMaintenanceIfDue();

    const concurrency = this.concurrency();
    const jobs = await this.repository.claimDue(
      concurrency,
      this.leaseMs(),
      this.handlers.supportedJobTypes
    );
    await runWithConcurrency(jobs, concurrency, (job) => this.handleClaimedJob(job));
  }

  private async runMaintenanceIfDue() {
    const now = Date.now();
    if (now < this.nextMaintenanceAt) {
      return;
    }

    this.nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;
    try {
      await this.service.reconcileSchedules({ dryRun: false });
      await this.service.enqueueDueSchedules();
    } catch (error) {
      this.nextMaintenanceAt = 0;
      throw error;
    }
  }

  private async handleClaimedJob(job: ClaimedBillingAutomationJob) {
    try {
      const result = await this.handlers.handle(job);
      await this.repository.complete(job.id, job.leaseToken, toResultSnapshot(result));
    } catch (error) {
      const sanitized = sanitizeBillingAutomationError(error);
      const failedAttempt = job.attemptCount + 1;
      if (!sanitized.retryable || failedAttempt >= job.maxAttempts) {
        await this.repository.deadLetter(job.id, job.leaseToken, sanitized);
      } else {
        await this.repository.reschedule(job.id, job.leaseToken, {
          delayMs: retryDelayMs(job.attemptCount),
          error: sanitized
        });
      }

      this.logger.warn({
        attemptCount: failedAttempt,
        errorCode: sanitized.code,
        jobId: job.id,
        jobType: job.jobType
      });
    }
  }

  private schedulePoll(delayMs: number) {
    if (this.stopping) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      const poll = this.runOnce()
        .catch((error) => {
          const sanitized = sanitizeBillingAutomationError(error);
          this.logger.error({
            errorCode: sanitized.code,
            operation: "BILLING_AUTOMATION_POLL"
          });
        })
        .finally(() => {
          this.activePoll = undefined;
          this.schedulePoll(this.pollIntervalMs());
        });
      this.activePoll = poll;
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private isEnabled() {
    return (
      this.config.get<string>("BILLING_AUTOMATION_WORKER_ENABLED")?.trim().toLowerCase() === "true"
    );
  }

  private concurrency() {
    return readPositiveInteger(
      this.config,
      "BILLING_AUTOMATION_WORKER_CONCURRENCY",
      DEFAULT_CONCURRENCY
    );
  }

  private leaseMs() {
    return readPositiveInteger(this.config, "BILLING_AUTOMATION_WORKER_LEASE_MS", DEFAULT_LEASE_MS);
  }

  private pollIntervalMs() {
    return readPositiveInteger(
      this.config,
      "BILLING_AUTOMATION_WORKER_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS
    );
  }
}

export function sanitizeBillingAutomationError(error: unknown): BillingAutomationFailure {
  if (error instanceof BillingAutomationError) {
    if (error.code === "BILLING_CONFIGURATION_ERROR") {
      return {
        code: "BILLING_CONFIGURATION_ERROR",
        message: "Billing automation configuration is invalid.",
        retryable: false
      };
    }
    if (error.code === "BILLING_EXECUTION_ERROR") {
      return genericExecutionError();
    }
  }
  return genericExecutionError();
}

function genericExecutionError(): BillingAutomationFailure {
  return {
    code: "BILLING_EXECUTION_ERROR",
    message: "Billing automation operation failed.",
    retryable: true
  };
}

function retryDelayMs(attemptCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount, 0), RETRY_DELAYS_MS.length - 1)]!;
}

function toResultSnapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  ) as Prisma.InputJsonValue;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await operation(item!);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) {
    throw failure.reason;
  }
}

function readPositiveInteger(config: ConfigService, key: string, fallback: number) {
  const parsed = Number(config.get<string>(key));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
