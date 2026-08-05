import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import { BillingAutomationRepository } from "../billing-automation/billing-automation.repository";
import { ClaimedBillingAutomationJob } from "../billing-automation/billing-automation.types";
import { SubscriptionChangeJobService } from "./subscription-change-job.service";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

@Injectable()
export class SubscriptionChangeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionChangeWorker.name);
  private activePoll?: Promise<void>;
  private nextMaintenanceAt = 0;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly repository: BillingAutomationRepository,
    private readonly jobs: SubscriptionChangeJobService,
    private readonly config: ConfigService
  ) {}

  onModuleInit() {
    if (this.isEnabled()) this.schedulePoll(0);
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await this.activePoll;
  }

  async runOnce() {
    await this.runMaintenanceIfDue();
    const claimed = await this.repository.claimDue(
      1,
      this.readPositiveInteger("SUBSCRIPTION_CHANGE_WORKER_LEASE_MS", DEFAULT_LEASE_MS),
      this.jobs.supportedJobTypes
    );
    for (const job of claimed) await this.handleClaimedJob(job);
  }

  private async runMaintenanceIfDue() {
    const now = Date.now();
    if (now < this.nextMaintenanceAt) return;
    this.nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;
    try {
      await this.jobs.enqueueDueEnrollmentJobs(new Date(now));
    } catch (error) {
      this.nextMaintenanceAt = 0;
      throw error;
    }
  }

  private async handleClaimedJob(job: ClaimedBillingAutomationJob) {
    try {
      const result = await this.jobs.handle(job);
      await this.repository.complete(job.id, job.leaseToken, jsonValue(result));
    } catch (error) {
      const failedAttempt = job.attemptCount + 1;
      const failure = {
        code: "SUBSCRIPTION_CHANGE_JOB_FAILED",
        message: error instanceof Error ? error.message.slice(0, 512) : "Subscription change job failed.",
        retryable: true
      };
      if (failedAttempt >= job.maxAttempts) {
        await this.repository.deadLetter(job.id, job.leaseToken, failure);
      } else {
        await this.repository.reschedule(job.id, job.leaseToken, {
          delayMs: retryDelayMs(job.attemptCount),
          error: failure
        });
      }
      this.logger.warn({ errorCode: failure.code, jobId: job.id, jobType: job.jobType });
    }
  }

  private schedulePoll(delayMs: number) {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.activePoll = this.runOnce()
        .catch((error) => this.logger.error({ error, operation: "SUBSCRIPTION_CHANGE_POLL" }))
        .finally(() => {
          this.activePoll = undefined;
          this.schedulePoll(
            this.readPositiveInteger(
              "SUBSCRIPTION_CHANGE_WORKER_POLL_INTERVAL_MS",
              DEFAULT_POLL_INTERVAL_MS
            )
          );
        });
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private isEnabled() {
    return this.config.get<string>("SUBSCRIPTION_EXTENSION_ENABLED") === "true";
  }

  private readPositiveInteger(key: string, fallback: number) {
    const parsed = Number(this.config.get<string>(key));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

function retryDelayMs(attemptCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount, 0), RETRY_DELAYS_MS.length - 1)]!;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value ?? null, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item
    )
  ) as Prisma.InputJsonValue;
}
