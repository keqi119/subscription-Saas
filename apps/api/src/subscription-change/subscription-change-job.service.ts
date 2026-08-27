import { Injectable, Optional } from "@nestjs/common";
import {
  ContractSegmentStatus,
  RenewalReminderSlot,
  SubscriptionAutomationJobType,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";

import { BillingAutomationRepository } from "../billing-automation/billing-automation.repository";
import { ClaimedBillingAutomationJob } from "../billing-automation/billing-automation.types";
import { ReturnManifestESignService } from "../esign/return-manifest-esign.service";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionClosureService } from "../subscription-closure/subscription-closure.service";
import { shanghaiBusinessDate } from "./renewal-calendar";
import { RenewalConsiderationService } from "./renewal-consideration.service";
import { SubscriptionExtensionActivationService } from "./subscription-extension-activation.service";
import { SubscriptionExpiryService } from "./subscription-expiry.service";
import { SubscriptionChangeError } from "./subscription-change.errors";
import { SubscriptionVehicleSwapActivationService } from "./subscription-vehicle-swap-activation.service";

const EXTENSION_EXECUTION_JOB_TYPES = new Set<SubscriptionAutomationJobType>([
  SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
  SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
  SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
  SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE
]);

@Injectable()
export class SubscriptionChangeJobService {
  readonly supportedJobTypes = [
    SubscriptionAutomationJobType.RENEWAL_CONSIDERATION_ENROLL,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
    SubscriptionAutomationJobType.RENEWAL_REMINDER_D3,
    SubscriptionAutomationJobType.RENEWAL_EXPIRY_PROCESS,
    SubscriptionAutomationJobType.RENEWAL_RETURN_OVERDUE_D1,
    SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE,
    SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME,
    SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW,
    SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE,
    SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7,
    SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN
  ] as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: BillingAutomationRepository,
    private readonly considerations: RenewalConsiderationService,
    private readonly activation: SubscriptionExtensionActivationService,
    private readonly expiry: SubscriptionExpiryService,
    private readonly closure: SubscriptionClosureService,
    @Optional() private readonly returnManifest?: ReturnManifestESignService,
    @Optional()
    private readonly vehicleSwapActivation?: SubscriptionVehicleSwapActivationService
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
      case SubscriptionAutomationJobType.RENEWAL_EXPIRY_PROCESS:
        return job.contractSegmentId
          ? this.expiry.expireSegment(job.contractSegmentId)
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.RENEWAL_RETURN_OVERDUE_D1:
        return job.orderId
          ? this.expiry.flagOverdueReturn(job.orderId)
          : { action: "SKIPPED", reason: "ORDER_ID_MISSING" };
      case SubscriptionAutomationJobType.EXTENSION_SEGMENT_ACTIVATE:
        return job.contractSegmentId
          ? this.activation.activate(job.contractSegmentId)
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.EXTENSION_BILLING_RESUME:
        return job.contractSegmentId
          ? this.activation.resumeBilling(job.contractSegmentId)
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.EXTENSION_ENTITLEMENT_RENEW:
        return job.contractSegmentId
          ? this.activation.renewEntitlements(
              job.contractSegmentId,
              payloadDate(job.payload, "periodStart"),
              payloadOptionalString(job.payload, "entitlementKey")
            )
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.EXTENSION_EFFECTIVE_NOTICE:
        return job.contractSegmentId
          ? this.activation.sendEffectiveNotice(job.contractSegmentId, job.idempotencyKey)
          : { action: "SKIPPED", reason: "CONTRACT_SEGMENT_ID_MISSING" };
      case SubscriptionAutomationJobType.CLOSURE_RECOVERY_ASSESSMENT_D7:
        return job.orderId
          ? this.closure.assessRecoveryJob({
              actorId: payloadString(job.payload, "actorId"),
              closureCaseId: payloadString(job.payload, "closureCaseId"),
              governingBillId: payloadString(job.payload, "billId"),
              governingDueDate: payloadDate(job.payload, "dueDate"),
              jobId: job.id,
              jobKey: job.idempotencyKey,
              orderId: job.orderId
            })
          : { action: "SKIPPED", reason: "ORDER_ID_MISSING" };
      case SubscriptionAutomationJobType.CLOSURE_RETURN_MANIFEST_ESIGN:
        if (!this.returnManifest) {
          throw new Error("Return-manifest e-sign service is unavailable.");
        }
        return this.returnManifest.reconcile({
          actorId: payloadString(job.payload, "actorId"),
          closureCaseId: payloadString(job.payload, "closureCaseId"),
          idempotencyKey: payloadString(job.payload, "generatedRevisionId")
        });
      default:
        throw new Error("Unsupported subscription change job type.");
    }
  }

  async afterComplete(job: ClaimedBillingAutomationJob) {
    return job.changeOrderId && EXTENSION_EXECUTION_JOB_TYPES.has(job.jobType)
      ? this.activation.completeIfReady(job.changeOrderId)
      : { completed: false };
  }

  async reconcileActiveChanges() {
    const changes = await this.prisma.subscriptionChangeOrder.findMany({
      select: { changeType: true, id: true, status: true },
      take: 200,
      where: {
        OR: [
          {
            changeType: SubscriptionChangeType.EXTENSION,
            status: SubscriptionChangeStatus.EXECUTING
          },
          {
            changeType: SubscriptionChangeType.VEHICLE_SWAP,
            status: {
              in: [SubscriptionChangeStatus.SCHEDULED, SubscriptionChangeStatus.EXECUTING]
            }
          }
        ]
      }
    });
    let completed = 0;
    for (const change of changes) {
      if (change.changeType === SubscriptionChangeType.EXTENSION) {
        const result = await this.activation.completeIfReady(change.id);
        if (result.completed) completed += 1;
        continue;
      }
      if (!this.vehicleSwapActivation) continue;
      try {
        const result = await this.vehicleSwapActivation.progress(change.id);
        if (result.outcome === "COMPLETED") completed += 1;
      } catch (error) {
        if (!(error instanceof SubscriptionChangeError)) throw error;
        await this.vehicleSwapActivation.markManualTakeover(change.id, {
          code: error.code,
          message: subscriptionChangeErrorMessage(error)
        });
      }
    }
    return completed;
  }

  async reconcileExecutingChanges() {
    return this.reconcileActiveChanges();
  }

  async markManualTakeover(
    job: ClaimedBillingAutomationJob,
    failure: { code: string; message: string }
  ) {
    return this.activation.markManualTakeover(job, failure);
  }

  private dispatch(job: ClaimedBillingAutomationJob, slot: RenewalReminderSlot) {
    return job.renewalConsiderationId
      ? this.considerations.dispatchReminder(job.renewalConsiderationId, slot)
      : { action: "SKIPPED", reason: "RENEWAL_CONSIDERATION_ID_MISSING" };
  }
}

function payloadRecord(payload: unknown) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: unknown, key: string) {
  const value = payloadRecord(payload)[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Subscription change job payload is missing ${key}.`);
  }
  return value;
}

function payloadOptionalString(payload: unknown, key: string) {
  const value = payloadRecord(payload)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function payloadDate(payload: unknown, key: string) {
  const value = new Date(payloadString(payload, key));
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Subscription change job payload has an invalid ${key}.`);
  }
  return value;
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function subscriptionChangeErrorMessage(error: SubscriptionChangeError) {
  const response = error.getResponse();
  return response && typeof response === "object" && "message" in response
    ? String(response.message).slice(0, 512)
    : error.message.slice(0, 512);
}
