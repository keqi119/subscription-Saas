import { Injectable } from "@nestjs/common";
import {
  ContractSegmentStatus,
  RenewalReminderSlot,
  SubscriptionAutomationJobType
} from "@prisma/client";

import { BillingAutomationRepository } from "../billing-automation/billing-automation.repository";
import { ClaimedBillingAutomationJob } from "../billing-automation/billing-automation.types";
import { PrismaService } from "../prisma/prisma.service";
import { shanghaiBusinessDate } from "./renewal-calendar";
import { RenewalConsiderationService } from "./renewal-consideration.service";

@Injectable()
export class SubscriptionChangeJobService {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.RENEWAL_CONSIDERATION_ENROLL,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D3
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly considerations: RenewalConsiderationService
  ) {}

  async enqueueDueEnrollmentJobs(now = new Date()) {
    const businessDate = shanghaiBusinessDate(now);
    const dueThrough = addUtcDays(businessDate, 30);
    const segments = await this.prisma.subscriptionContractSegment.findMany({
      select: { id: true, orderId: true },
      take: 200,
      where: {
        endDate: { gte: businessDate, lte: dueThrough },
        renewalConsideration: null,
        status: ContractSegmentStatus.ACTIVE
      }
    });
    for (const segment of segments) {
      await this.repository.enqueue(this.prisma, {
        availableAt: now,
        contractSegmentId: segment.id,
        idempotencyKey: `renewal-consideration:${segment.id}`,
        jobType: SubscriptionAutomationJobType.RENEWAL_CONSIDERATION_ENROLL,
        orderId: segment.orderId
      });
    }
    return segments.length;
  }

  async handle(job: ClaimedBillingAutomationJob) {
    switch (job.jobType) {
      case SubscriptionAutomationJobType.RENEWAL_CONSIDERATION_ENROLL:
        return job.contractSegmentId
          ? this.considerations.enrollSegment(job.contractSegmentId)
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.RENEWAL_REMINDER_D30:
        return this.dispatch(job, RenewalReminderSlot.D30);
      case SubscriptionAutomationJobType.RENEWAL_REMINDER_D14:
        return this.dispatch(job, RenewalReminderSlot.D14);
      case SubscriptionAutomationJobType.RENEWAL_REMINDER_D3:
        return this.dispatch(job, RenewalReminderSlot.D3);
      default:
        throw new Error("Unsupported subscription change job type.");
    }
  }

  private dispatch(job: ClaimedBillingAutomationJob, slot: RenewalReminderSlot) {
    return job.renewalConsiderationId
      ? this.considerations.dispatchReminder(job.renewalConsiderationId, slot)
      : { action: "SKIPPED", reason: "RENEWAL_CONSIDERATION_ID_MISSING" };
  }
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}
