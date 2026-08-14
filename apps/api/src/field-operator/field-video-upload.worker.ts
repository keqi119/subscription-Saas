import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FieldEvidenceVideoUploadStatus } from "@prisma/client";

import { HandoverWorkOrderService } from "../handover-work-order/handover-work-order.service";
import { StorageService } from "../storage/storage.service";
import { FieldVideoUploadFinalizerService } from "./field-video-upload-finalizer.service";
import { FieldVideoUploadRepository } from "./field-video-upload.repository";
import { FieldVideoUploadSessionSnapshot } from "./field-video-upload.types";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

@Injectable()
export class FieldVideoUploadWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FieldVideoUploadWorker.name);
  private activePoll?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly repository: FieldVideoUploadRepository,
    private readonly finalizer: FieldVideoUploadFinalizerService,
    private readonly storage: StorageService,
    private readonly handover: HandoverWorkOrderService,
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
    const concurrency = this.concurrency();
    const leaseMs = this.leaseMs();
    const claimed = await this.repository.claimDue(concurrency, leaseMs);
    await runWithConcurrency(claimed, concurrency, (session) => this.finalizer.finalize(session));

    const expired = await this.repository.expireDue(concurrency, leaseMs);
    await runWithConcurrency(expired, concurrency, (session) => this.expire(session));
  }

  private async expire(session: FieldVideoUploadSessionSnapshot) {
    if (!session.leaseOwner) {
      return;
    }
    const startedAt = Date.now();
    try {
      if (session.internal.objectKey && session.internal.ossUploadId) {
        await this.storage.abortFieldVideoMultipart({
          key: session.internal.objectKey,
          uploadId: session.internal.ossUploadId
        });
      }
      if (session.objectCompletedAt && session.internal.objectKey) {
        await this.storage.deleteFieldVideoUploadSource({ key: session.internal.objectKey });
      }
      const terminal = await this.repository.markTerminal({
        code: "VIDEO_UPLOAD_EXPIRED",
        leaseOwner: session.leaseOwner,
        message: "视频上传记录已过期，请重新开始。",
        sessionId: session.id,
        status: FieldEvidenceVideoUploadStatus.EXPIRED
      });
      if (terminal) {
        await this.handover.recordFieldVideoUploadEvent({
          actorId: session.createdBySessionId ?? undefined,
          errorCode: "VIDEO_UPLOAD_EXPIRED",
          eventType: "FIELD_VIDEO_UPLOAD_FAILED",
          evidenceItemId: session.evidenceItemId,
          sessionId: session.id,
          status: FieldEvidenceVideoUploadStatus.EXPIRED,
          workOrderId: session.workOrderId
        });
      }
    } catch {
      await this.repository.releaseLease(session.id, session.leaseOwner).catch(() => false);
      this.logger.warn({
        elapsedMs: Date.now() - startedAt,
        errorCode: "VIDEO_UPLOAD_EXPIRY_CLEANUP_FAILED",
        evidenceItemId: session.evidenceItemId,
        sessionId: session.id,
        stage: FieldEvidenceVideoUploadStatus.UPLOADING,
        workOrderId: session.workOrderId
      });
    }
  }

  private schedulePoll(delayMs: number) {
    if (this.stopping) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.activePoll = this.runOnce()
        .catch(() => {
          this.logger.error({ errorCode: "FIELD_VIDEO_UPLOAD_WORKER_POLL_FAILED" });
        })
        .finally(() => {
          this.activePoll = undefined;
          this.schedulePoll(this.pollIntervalMs());
        });
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private isEnabled() {
    return (
      this.config.get<string>("FIELD_VIDEO_UPLOAD_WORKER_ENABLED")?.trim().toLowerCase() === "true"
    );
  }

  private concurrency() {
    return positiveInteger(
      this.config,
      "FIELD_VIDEO_UPLOAD_WORKER_CONCURRENCY",
      DEFAULT_CONCURRENCY
    );
  }

  private leaseMs() {
    return positiveInteger(this.config, "FIELD_VIDEO_UPLOAD_WORKER_LEASE_MS", DEFAULT_LEASE_MS);
  }

  private pollIntervalMs() {
    return positiveInteger(
      this.config,
      "FIELD_VIDEO_UPLOAD_WORKER_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS
    );
  }
}

function positiveInteger(config: ConfigService, key: string, fallback: number) {
  const value = Number(config.get<string>(key));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>
) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item) {
          await handler(item);
        }
      }
    })
  );
}
