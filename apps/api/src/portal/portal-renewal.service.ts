import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  AuditAction,
  Prisma,
  RenewalConsiderationStatus,
  RenewalDecision,
  RenewalReminderStatus,
  SubscriptionAutomationJobStatus,
  SubscriptionAutomationJobType,
  SubscriptionChangePricingMode,
  SubscriptionChangeQuoteStatus,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { sortByPortalListOrder } from "../common/portal-list-ordering";
import type { PortalListSortKey } from "../common/portal-list-ordering";
import { PrismaService } from "../prisma/prisma.service";
import {
  SUBSCRIPTION_CHANGE_CONFIG,
  SubscriptionChangeConfig
} from "../subscription-change/subscription-change.config";
import { SubscriptionChangeRepository } from "../subscription-change/subscription-change.repository";
import { requireExtensionChangeProjection } from "../subscription-change/subscription-extension-compat";
import { CurrentCustomer, PortalRequestContext } from "./portal-auth.types";
import {
  PortalConfirmExtensionQuoteDto,
  PortalRejectExtensionQuoteDto,
  PortalRenewalDecisionDto
} from "./portal-renewal.dto";

const PORTAL_RENEWAL_CUSTOMER_ACTIONS = new Set([
  "DECIDE_RENEW_OR_EXPIRE",
  "REVIEW_QUOTE",
  "SIGN_AGREEMENT",
  "PREPARE_RETURN"
]);
const PORTAL_RENEWAL_HISTORY_STATUSES = new Set<RenewalConsiderationStatus>([
  RenewalConsiderationStatus.EXTENDED,
  RenewalConsiderationStatus.EXPIRED,
  RenewalConsiderationStatus.CANCELLED
]);
const considerationInclude = Prisma.validator<Prisma.RenewalConsiderationInclude>()({
  changeOrder: {
    include: { confirmedQuote: true, currentQuote: true }
  },
  order: {
    select: {
      customerId: true,
      id: true,
      orderNo: true,
      periodMonths: true,
      vehicle: { select: { plateNo: true } }
    }
  },
  reminders: { orderBy: { scheduledAt: "asc" } },
  segment: true
});

const changeInclude = Prisma.validator<Prisma.SubscriptionChangeOrderInclude>()({
  automationJobs: { orderBy: { createdAt: "desc" } },
  confirmedQuote: true,
  contract: true,
  currentQuote: true,
  extensionDetail: { include: { sourceSegment: true } },
  order: {
    select: { customerId: true, id: true, orderNo: true }
  },
  quotes: { orderBy: { revision: "desc" } },
  sourceSegment: true,
  targetSegment: true
});

type PortalConsideration = Prisma.RenewalConsiderationGetPayload<{
  include: typeof considerationInclude;
}>;
type PortalChange = Prisma.SubscriptionChangeOrderGetPayload<{
  include: typeof changeInclude;
}>;

@Injectable()
export class PortalRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(SUBSCRIPTION_CHANGE_CONFIG)
    private readonly config: SubscriptionChangeConfig,
    private readonly changeRepository: SubscriptionChangeRepository
  ) {}

  async list(currentCustomer: CurrentCustomer) {
    const considerations = await this.prisma.renewalConsideration.findMany({
      include: considerationInclude,
      orderBy: [{ completionDeadlineAt: "asc" }, { createdAt: "desc" }],
      where: { order: { customerId: currentCustomer.customerId } }
    });
    return sortByPortalListOrder(considerations, portalRenewalSortKey).map(toConsiderationView);
  }

  async get(id: string, currentCustomer: CurrentCustomer) {
    return toConsiderationView(await this.findOwnedConsideration(id, currentCustomer.customerId));
  }

  async decide(
    id: string,
    input: PortalRenewalDecisionDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, "renewal_consideration", id);
      const consideration = await findOwnedConsideration(tx, id, currentCustomer.customerId);
      if (!consideration) throw hiddenNotFound();
      if (consideration.decision) {
        if (consideration.decision === input.decision) return toConsiderationView(consideration);
        throw new ConflictException("A different renewal decision has already been recorded.");
      }
      assertVersion(consideration.version, input.version);
      assertBeforeDeadline(this.config.now(), consideration.completionDeadlineAt);

      let changeOrderId: string | null = null;
      if (input.decision === RenewalDecision.RENEW) {
        await this.changeRepository.lockCreationScope(tx, consideration.orderId);
        const active = await this.changeRepository.findActiveChange(tx, consideration.orderId);
        if (active)
          throw new ConflictException("The order already has an active subscription change.");
        const extensionMonths = Math.max(1, consideration.order.periodMonths);
        const targetStartDate = addUtcDays(consideration.segment.endDate, 1);
        const targetEndDate = addUtcDays(addCalendarMonths(targetStartDate, extensionMonths), -1);
        const change = await tx.subscriptionChangeOrder.create({
          data: {
            changeNo: createBusinessNo("SCO"),
            changeType: SubscriptionChangeType.EXTENSION,
            completionDeadlineAt: consideration.completionDeadlineAt,
            extensionDetail: {
              create: {
                extensionMonths,
                pricingMode: SubscriptionChangePricingMode.CURRENT_VERSION,
                sourceSegmentId: consideration.segmentId,
                targetEndDate,
                targetStartDate
              }
            },
            orderId: consideration.orderId,
            renewalConsiderationId: consideration.id,
            status: SubscriptionChangeStatus.DRAFT
          }
        });
        changeOrderId = change.id;
      }

      const status =
        input.decision === RenewalDecision.RENEW
          ? RenewalConsiderationStatus.RENEWAL_REQUESTED
          : RenewalConsiderationStatus.EXPIRY_CONFIRMED;
      await tx.renewalConsideration.update({
        data: {
          changeOrderId,
          decidedAt: this.config.now(),
          decision: input.decision,
          status,
          version: { increment: 1 }
        },
        where: { id }
      });
      await cancelMarketingReminders(tx, id, this.config.now());
      const updated = await findOwnedConsideration(tx, id, currentCustomer.customerId);
      if (!updated) throw hiddenNotFound();
      await this.auditService.write(
        portalAudit(
          AuditAction.UPDATE,
          "renewal_consideration",
          id,
          currentCustomer.customerId,
          context,
          toConsiderationView(consideration),
          toConsiderationView(updated)
        ),
        tx
      );
      return toConsiderationView(updated);
    }, serializableTransaction);
  }

  async getChange(id: string, currentCustomer: CurrentCustomer) {
    return toChangeView(await this.findOwnedChange(id, currentCustomer.customerId));
  }

  async confirmQuote(
    changeId: string,
    input: PortalConfirmExtensionQuoteDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.assertEnabled();
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, "subscription_change_order", changeId);
      const change = await findOwnedChange(tx, changeId, currentCustomer.customerId);
      if (!change) throw hiddenNotFound();
      if (change.confirmedQuoteId) {
        const confirmed = change.quotes.find((quote) => quote.id === change.confirmedQuoteId);
        if (confirmed?.id === input.quoteId && confirmed.revision === input.revision) {
          return toChangeView(change);
        }
        throw new ConflictException("A different quote revision has already been confirmed.");
      }
      assertVersion(change.version, input.version);
      assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
      const quote = assertExactPublishableQuote(change, input, this.config.now());
      await tx.subscriptionChangeQuote.update({
        data: {
          confirmedAt: this.config.now(),
          status: SubscriptionChangeQuoteStatus.CUSTOMER_CONFIRMED
        },
        where: { id: quote.id }
      });
      await tx.subscriptionChangeOrder.update({
        data: {
          confirmedQuoteId: quote.id,
          status: SubscriptionChangeStatus.CUSTOMER_CONFIRMED,
          version: { increment: 1 }
        },
        where: { id: change.id }
      });
      const updated = await findOwnedChange(tx, changeId, currentCustomer.customerId);
      if (!updated) throw hiddenNotFound();
      await this.auditService.write(
        portalAudit(
          AuditAction.UPDATE,
          "subscription_change_order",
          change.id,
          currentCustomer.customerId,
          context,
          toChangeView(change),
          toChangeView(updated)
        ),
        tx
      );
      return toChangeView(updated);
    }, serializableTransaction);
  }

  async rejectQuote(
    changeId: string,
    input: PortalRejectExtensionQuoteDto,
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.assertEnabled();
    const reason = input.reason.trim();
    if (!reason) throw new ConflictException("A quote rejection reason is required.");
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, "subscription_change_order", changeId);
      const change = await findOwnedChange(tx, changeId, currentCustomer.customerId);
      if (!change) throw hiddenNotFound();
      assertVersion(change.version, input.version);
      assertBeforeDeadline(this.config.now(), change.completionDeadlineAt);
      const quote = assertExactPublishableQuote(change, input, this.config.now());
      await tx.subscriptionChangeQuote.update({
        data: {
          rejectedAt: this.config.now(),
          status: SubscriptionChangeQuoteStatus.CUSTOMER_REJECTED
        },
        where: { id: quote.id }
      });
      await tx.subscriptionChangeOrder.update({
        data: {
          cancelReason: `CUSTOMER_QUOTE_REJECTED: ${reason}`,
          status: SubscriptionChangeStatus.CANCELLED,
          version: { increment: 1 }
        },
        where: { id: change.id }
      });
      if (change.renewalConsiderationId) {
        await tx.renewalConsideration.update({
          data: {
            status: RenewalConsiderationStatus.RENEWAL_REQUESTED,
            version: { increment: 1 }
          },
          where: { id: change.renewalConsiderationId }
        });
      }
      const updated = await findOwnedChange(tx, changeId, currentCustomer.customerId);
      if (!updated) throw hiddenNotFound();
      await this.auditService.write(
        portalAudit(
          AuditAction.UPDATE,
          "subscription_change_order",
          change.id,
          currentCustomer.customerId,
          context,
          toChangeView(change),
          toChangeView(updated)
        ),
        tx
      );
      return toChangeView(updated);
    }, serializableTransaction);
  }

  async listContractSegments(orderId: string, currentCustomer: CurrentCustomer) {
    const segments = await this.prisma.subscriptionContractSegment.findMany({
      orderBy: { sequenceNo: "asc" },
      where: { order: { customerId: currentCustomer.customerId, id: orderId } }
    });
    if (segments.length === 0) throw hiddenNotFound();
    return segments.map(toSegmentView);
  }

  private findOwnedConsideration(id: string, customerId: string) {
    return findOwnedConsideration(this.prisma, id, customerId).then((value) => {
      if (!value) throw hiddenNotFound();
      return value;
    });
  }

  private findOwnedChange(id: string, customerId: string) {
    return findOwnedChange(this.prisma, id, customerId).then((value) => {
      if (!value) throw hiddenNotFound();
      return value;
    });
  }

  private assertEnabled() {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException("Subscription renewal is temporarily unavailable.");
    }
  }
}

function findOwnedConsideration(
  db: Pick<Prisma.TransactionClient, "renewalConsideration">,
  id: string,
  customerId: string
) {
  return db.renewalConsideration.findFirst({
    include: considerationInclude,
    where: { id, order: { customerId } }
  });
}

function findOwnedChange(
  db: Pick<Prisma.TransactionClient, "subscriptionChangeOrder">,
  id: string,
  customerId: string
) {
  return db.subscriptionChangeOrder.findFirst({
    include: changeInclude,
    where: { id, order: { customerId } }
  });
}

function assertExactPublishableQuote(
  change: PortalChange,
  input: Pick<PortalConfirmExtensionQuoteDto, "quoteId" | "revision">,
  now: Date
) {
  const quote = change.currentQuote;
  if (
    change.status !== SubscriptionChangeStatus.QUOTED ||
    !change.customerConfirmationPublishedAt ||
    !quote ||
    quote.id !== input.quoteId ||
    quote.revision !== input.revision ||
    quote.status !== SubscriptionChangeQuoteStatus.FORMAL ||
    quote.validUntil <= now
  ) {
    throw new ConflictException("The published quote revision is stale or unavailable.");
  }
  return quote;
}

async function cancelMarketingReminders(
  tx: Prisma.TransactionClient,
  considerationId: string,
  now: Date
) {
  await tx.renewalReminder.updateMany({
    data: { status: RenewalReminderStatus.SKIPPED_DECIDED },
    where: {
      renewalConsiderationId: considerationId,
      status: { in: [RenewalReminderStatus.PENDING, RenewalReminderStatus.FAILED] }
    }
  });
  await tx.subscriptionAutomationJob.updateMany({
    data: {
      cancelledAt: now,
      completedAt: now,
      jobStatus: SubscriptionAutomationJobStatus.CANCELLED
    },
    where: {
      jobStatus: SubscriptionAutomationJobStatus.PENDING,
      jobType: {
        in: [
          SubscriptionAutomationJobType.RENEWAL_REMINDER_D30,
          SubscriptionAutomationJobType.RENEWAL_REMINDER_D14,
          SubscriptionAutomationJobType.RENEWAL_REMINDER_D3
        ]
      },
      renewalConsiderationId: considerationId
    }
  });
}

function toConsiderationView(consideration: PortalConsideration) {
  return {
    changeOrderId: consideration.changeOrderId,
    completionDeadlineAt: consideration.completionDeadlineAt.toISOString(),
    considerationStartAt: consideration.considerationStartAt.toISOString(),
    decision: consideration.decision,
    decidedAt: consideration.decidedAt?.toISOString() ?? null,
    id: consideration.id,
    nextAction: considerationNextAction(consideration),
    order: {
      id: consideration.order.id,
      orderNo: consideration.order.orderNo,
      plateMasked: maskPlate(consideration.order.vehicle?.plateNo)
    },
    reminders: consideration.reminders.map((reminder) => ({
      scheduledAt: reminder.scheduledAt.toISOString(),
      slot: reminder.slot,
      status: reminder.status
    })),
    segment: toSegmentView(consideration.segment),
    status: consideration.status,
    version: consideration.version
  };
}

function toChangeView(change: PortalChange) {
  const extensionChange = requireExtensionChangeProjection(change);
  return {
    cancelReason: change.cancelReason,
    completionDeadlineAt: change.completionDeadlineAt.toISOString(),
    confirmedQuoteId: change.confirmedQuoteId,
    contractId: change.contractId,
    currentQuote: change.currentQuote ? toQuoteView(change.currentQuote) : null,
    extensionMonths: extensionChange.extensionMonths,
    id: change.id,
    orderId: change.orderId,
    orderNo: change.order.orderNo,
    pricingMode: extensionChange.pricingMode,
    quotes: change.quotes.map(toQuoteView),
    sourceSegment: toSegmentView(extensionChange.sourceSegment),
    status: change.status,
    targetEndDate: dateOnly(extensionChange.targetEndDate),
    targetSegment: change.targetSegment ? toSegmentView(change.targetSegment) : null,
    targetStartDate: dateOnly(extensionChange.targetStartDate),
    version: change.version
  };
}

function toQuoteView(quote: PortalChange["quotes"][number]) {
  return {
    energyLimitCount: quote.energyLimitCount,
    energyLimitKwh: quote.energyLimitKwh,
    id: quote.id,
    mileageLimitKm: quote.mileageLimitKm,
    monthlyFeeAmount: quote.monthlyFeeAmount.toString(),
    overMileageFeeAmount: quote.overMileageFeeAmount.toString(),
    pricingMode: quote.pricingMode,
    quoteNo: quote.quoteNo,
    revision: quote.revision,
    status: quote.status,
    validUntil: quote.validUntil.toISOString()
  };
}

function toSegmentView(segment: {
  endDate: Date;
  id: string;
  monthlyFeeAmount: bigint;
  sequenceNo: number;
  startDate: Date;
  status: string;
}) {
  return {
    endDate: dateOnly(segment.endDate),
    id: segment.id,
    monthlyFeeAmount: segment.monthlyFeeAmount.toString(),
    sequenceNo: segment.sequenceNo,
    startDate: dateOnly(segment.startDate),
    status: segment.status
  };
}

function considerationNextAction(consideration: PortalConsideration) {
  if (!consideration.decision) return "DECIDE_RENEW_OR_EXPIRE";
  if (consideration.decision === RenewalDecision.EXPIRE) return "PREPARE_RETURN";
  const change = consideration.changeOrder;
  if (!change || change.status === SubscriptionChangeStatus.DRAFT) return "WAIT_FOR_QUOTE";
  if (change.status === SubscriptionChangeStatus.QUOTED) return "REVIEW_QUOTE";
  if (change.status === SubscriptionChangeStatus.CUSTOMER_CONFIRMED) return "WAIT_FOR_AGREEMENT";
  if (change.status === SubscriptionChangeStatus.SIGNING_OR_PAYMENT) return "SIGN_AGREEMENT";
  if (change.status === SubscriptionChangeStatus.SCHEDULED) return "WAIT_FOR_EFFECTIVE_DATE";
  if (change.status === SubscriptionChangeStatus.COMPLETED) return "RENEWAL_COMPLETED";
  return "CONTACT_SUPPORT";
}

function portalRenewalSortKey(consideration: PortalConsideration): PortalListSortKey {
  const nextAction = considerationNextAction(consideration);
  const terminal =
    PORTAL_RENEWAL_HISTORY_STATUSES.has(consideration.status) || nextAction === "RENEWAL_COMPLETED";

  return {
    createdAt: consideration.createdAt,
    deadlineAt: terminal ? null : consideration.completionDeadlineAt,
    id: consideration.id,
    priority: terminal ? 2 : PORTAL_RENEWAL_CUSTOMER_ACTIONS.has(nextAction) ? 0 : 1,
    updatedAt: consideration.updatedAt
  };
}

function portalAudit(
  action: AuditAction,
  entityType: string,
  entityId: string,
  customerId: string,
  context: PortalRequestContext,
  before: unknown,
  after: unknown
) {
  return {
    action,
    after: { customerId, value: after },
    before,
    entityId,
    entityType,
    ipAddress: context.ipAddress,
    module: "portal_subscription_change",
    userAgent: context.userAgent
  };
}

async function lockRow(tx: Prisma.TransactionClient, table: string, id: string) {
  if (typeof tx.$queryRaw !== "function") return;
  if (table === "renewal_consideration") {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "renewal_consideration" WHERE "id" = ${id}::uuid FOR UPDATE`
    );
  } else {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "subscription_change_order" WHERE "id" = ${id}::uuid FOR UPDATE`
    );
  }
}

function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new ConflictException("The renewal record was updated.");
}

function assertBeforeDeadline(now: Date, deadline: Date) {
  if (now >= deadline) {
    throw new ConflictException(
      "The renewal deadline has passed; the order must proceed to return."
    );
  }
}

function hiddenNotFound() {
  return new NotFoundException("Renewal record was not found.");
}

function addUtcDays(value: Date, days: number) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addCalendarMonths(value: Date, months: number) {
  const year = value.getUTCFullYear();
  const monthIndex = value.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(value.getUTCDate(), lastDay)));
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function maskPlate(value: string | null | undefined) {
  const plate = value?.trim().toUpperCase() ?? "";
  if (plate.length <= 2) return plate || "-";
  return `${plate.slice(0, 1)}${"*".repeat(Math.max(2, plate.length - 3))}${plate.slice(-2)}`;
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};
