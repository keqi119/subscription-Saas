import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrderMileageReviewStatus, OrderStatus } from "@prisma/client";

import { NotificationService } from "../notification/notification.service";
import { PrismaService } from "../prisma/prisma.service";
import { MileageReviewService } from "./mileage-review.service";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_REMINDERS_PER_POLL = 100;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

@Injectable()
export class MileageReviewWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MileageReviewWorker.name);
  private activePoll?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly mileageReviewService: MileageReviewService,
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService
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

  async runOnce(asOf = new Date()) {
    if (!this.isEnabled()) {
      return {
        activatedCount: 0,
        enabled: false,
        failedNotifications: 0,
        notifiedCount: 0
      };
    }
    const activation = await this.mileageReviewService.activateDueReviews(asOf);
    const reviews = await this.prisma.orderMileageReview.findMany({
      orderBy: [{ scheduledReviewAt: "asc" }, { createdAt: "asc" }],
      select: {
        cycleNo: true,
        id: true,
        order: { select: { customerId: true, orderNo: true } },
        status: true
      },
      take: MAX_REMINDERS_PER_POLL,
      where: {
        deletedAt: null,
        order: { orderStatus: OrderStatus.ACTIVE },
        scheduledReviewAt: { lte: asOf },
        status: OrderMileageReviewStatus.PENDING_SUBMISSION
      }
    });
    let notifiedCount = 0;
    let failedNotifications = 0;
    const localDate = shanghaiDateKey(asOf);
    for (const review of reviews) {
      try {
        await this.notificationService.notifyMileageReviewDue({
          customerId: review.order.customerId,
          cycleNo: review.cycleNo,
          idempotencyKey: `mileage-review:${review.id}:due:${localDate}`,
          orderNo: review.order.orderNo,
          reviewId: review.id
        });
        notifiedCount += 1;
      } catch (error) {
        failedNotifications += 1;
        this.logger.warn({
          error: error instanceof Error ? error.message : String(error),
          operation: "MILEAGE_REVIEW_NOTIFICATION",
          reviewId: review.id
        });
      }
    }
    return {
      activatedCount: activation.activatedCount,
      enabled: true,
      failedNotifications,
      notifiedCount
    };
  }

  private schedulePoll(delayMs: number) {
    if (this.stopping) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      const poll = this.runOnce()
        .then(() => undefined)
        .catch((error) => {
          this.logger.error({
            error: error instanceof Error ? error.message : String(error),
            operation: "MILEAGE_REVIEW_POLL"
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
      this.config
        .get<string>("MILEAGE_REVIEW_WORKER_ENABLED")
        ?.trim()
        .toLowerCase() === "true"
    );
  }

  private pollIntervalMs() {
    const configured = Number(
      this.config.get<string>("MILEAGE_REVIEW_WORKER_POLL_INTERVAL_MS")
    );
    return Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_POLL_INTERVAL_MS;
  }
}

function shanghaiDateKey(value: Date) {
  const local = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return [
    local.getUTCFullYear(),
    String(local.getUTCMonth() + 1).padStart(2, "0"),
    String(local.getUTCDate()).padStart(2, "0")
  ].join("-");
}
