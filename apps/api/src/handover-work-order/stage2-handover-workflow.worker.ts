import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { Stage2HandoverWorkflowRepository } from "./stage2-handover-workflow.repository";
import {
  ClaimedStage2WorkflowJob,
  STAGE2_HANDOVER_WORKFLOW_HANDLER,
  Stage2HandoverWorkflowHandler,
  Stage2WorkflowError,
  WorkflowHandlerResult
} from "./stage2-handover-workflow.types";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;

@Injectable()
export class Stage2HandoverWorkflowWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Stage2HandoverWorkflowWorker.name);
  private activePoll?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly repository: Stage2HandoverWorkflowRepository,
    private readonly config: ConfigService,
    @Optional()
    @Inject(STAGE2_HANDOVER_WORKFLOW_HANDLER)
    private readonly handler?: Stage2HandoverWorkflowHandler
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      return;
    }
    if (!this.handler) {
      this.logger.warn("Stage 2 handover workflow worker has no handler.");
      return;
    }

    this.schedulePoll(0);
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.activePoll;
  }

  async runOnce(): Promise<void> {
    if (!this.handler) {
      return;
    }

    const concurrency = this.concurrency();
    const jobs = await this.repository.claimDue(
      concurrency,
      this.leaseMs(),
      this.handler.supportedJobTypes
    );
    await runWithConcurrency(jobs, concurrency, (job) => this.handleClaimedJob(job));
  }

  private async handleClaimedJob(job: ClaimedStage2WorkflowJob) {
    let result: WorkflowHandlerResult;
    try {
      result = await this.handler!.handle(job);
    } catch (error) {
      const sanitized = sanitizeWorkflowError(error);
      const failedAttempt = job.attemptCount + 1;

      if (failedAttempt >= job.maxAttempts) {
        await this.repository.deadLetter(job.id, job.leaseToken, sanitized);
      } else {
        await this.repository.reschedule(job.id, job.leaseToken, {
          availableAt: new Date(Date.now() + retryDelayMs(job.attemptCount)),
          error: sanitized
        });
      }

      this.logger.warn({
        attemptCount: failedAttempt,
        errorCode: sanitized.code,
        jobId: job.id,
        jobType: job.jobType
      });
      return;
    }

    if (result.kind === "OBSERVED_SIGNING") {
      await this.repository.reschedule(job.id, job.leaseToken, {
        availableAt: result.availableAt,
        incrementAttempt: false,
        result: result.result
      });
      return;
    }

    await this.repository.complete(job.id, job.leaseToken, result.result);
  }

  private schedulePoll(delayMs: number) {
    if (this.stopping) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      const poll = this.runOnce()
        .catch((error) => {
          const sanitized = sanitizeWorkflowError(error);
          this.logger.error({
            errorCode: sanitized.code,
            operation: "STAGE2_WORKFLOW_POLL"
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
    return this.config.get<string>("STAGE2_HANDOVER_WORKER_ENABLED")?.trim().toLowerCase() === "true";
  }

  private concurrency() {
    return readPositiveInteger(
      this.config,
      "STAGE2_HANDOVER_WORKER_CONCURRENCY",
      DEFAULT_CONCURRENCY
    );
  }

  private leaseMs() {
    return readPositiveInteger(
      this.config,
      "STAGE2_HANDOVER_WORKER_LEASE_MS",
      DEFAULT_LEASE_MS
    );
  }

  private pollIntervalMs() {
    return readPositiveInteger(
      this.config,
      "STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS
    );
  }
}

export function sanitizeWorkflowError(error: unknown): Stage2WorkflowError {
  void error;
  return {
    code: "WORKFLOW_ERROR",
    message: "Workflow operation failed."
  };
}

function retryDelayMs(attemptCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount, 0), RETRY_DELAYS_MS.length - 1)]!;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await operation(item!);
      }
    }
  );

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
