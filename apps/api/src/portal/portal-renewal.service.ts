import {
  BadRequestException,
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
import { createHash } from "node:crypto";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-number";
import { sortByPortalListOrder } from "../common/portal-list-ordering";
import type { PortalListSortKey } from "../common/portal-list-ordering";
import { PrismaService } from "../prisma/prisma.service";
import {
  isSubscriptionChangeTypeEnabled,
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
    return sortByPortalListOrder(considerations, portalRenewalSortKey).map((consideration) =>
      this.projectConsideration(consideration)
    );
  }

  async get(id: string, currentCustomer: CurrentCustomer) {
    return this.projectConsideration(
      await this.findOwnedConsideration(id, currentCustomer.customerId)
    );
  }

  async decide(
    id: string,
    input: PortalRenewalDecisionDto & { idempotencyKey?: string },
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    if (input.decision === RenewalDecision.RENEW) this.assertEnabled();
    const idempotencyKey = assertPortalIdempotencyKey(input.idempotencyKey);
    const operation = "PORTAL_RENEWAL_DECISION";
    const requestHash = portalCommandHash({
      decision: input.decision,
      id,
      version: input.version
    });
    const replay = await replayPortalRenewalDecision(
      this.prisma,
      operation,
      idempotencyKey,
      currentCustomer.customerId,
      requestHash
    );
    if (replay)
      return this.projectConsideration(
        await this.findOwnedConsideration(id, currentCustomer.customerId)
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: currentCustomer.customerId,
            idempotencyKey,
            operation,
            requestHash
          }
        });
        await lockRow(tx, "renewal_consideration", id);
        const consideration = await findOwnedConsideration(tx, id, currentCustomer.customerId);
        if (!consideration) throw hiddenNotFound();
        if (consideration.decision) {
          if (consideration.decision === input.decision) {
            await completePortalRenewalDecisionCommand(tx, command.id, id, this.config.now());
            return this.projectConsideration(consideration);
          }
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
            this.projectConsideration(consideration),
            this.projectConsideration(updated)
          ),
          tx
        );
        await completePortalRenewalDecisionCommand(tx, command.id, id, this.config.now());
        return this.projectConsideration(updated);
      }, serializableTransaction);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrentReplay = await replayPortalRenewalDecision(
        this.prisma,
        operation,
        idempotencyKey,
        currentCustomer.customerId,
        requestHash
      );
      if (!concurrentReplay) throw error;
      return this.projectConsideration(
        await this.findOwnedConsideration(id, currentCustomer.customerId)
      );
    }
  }

  async getChange(id: string, currentCustomer: CurrentCustomer) {
    return toChangeView(
      await this.findOwnedChange(id, currentCustomer.customerId),
      isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)
    );
  }

  async confirmQuote(
    changeId: string,
    input: PortalConfirmExtensionQuoteDto & { idempotencyKey?: string },
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.assertEnabled();
    const idempotencyKey = assertPortalIdempotencyKey(input.idempotencyKey);
    const operation = "PORTAL_CONFIRM_EXTENSION_QUOTE";
    const requestHash = portalCommandHash({ changeId, ...input, idempotencyKey });
    const replay = await replayPortalChangeCommand(
      this.prisma,
      operation,
      idempotencyKey,
      currentCustomer.customerId,
      requestHash
    );
    if (replay)
      return toChangeView(
        await this.findOwnedChange(changeId, currentCustomer.customerId),
        isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: currentCustomer.customerId,
            idempotencyKey,
            operation,
            requestHash
          }
        });
        await lockRow(tx, "subscription_change_order", changeId);
        const change = await findOwnedChange(tx, changeId, currentCustomer.customerId);
        if (!change) throw hiddenNotFound();
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
            toChangeView(change, true),
            toChangeView(updated, true)
          ),
          tx
        );
        await completePortalChangeCommand(tx, command.id, change.id, this.config.now());
        return toChangeView(updated, true);
      }, serializableTransaction);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrentReplay = await replayPortalChangeCommand(
        this.prisma,
        operation,
        idempotencyKey,
        currentCustomer.customerId,
        requestHash
      );
      if (!concurrentReplay) throw error;
      return toChangeView(
        await this.findOwnedChange(changeId, currentCustomer.customerId),
        isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)
      );
    }
  }

  async rejectQuote(
    changeId: string,
    input: PortalRejectExtensionQuoteDto & { idempotencyKey?: string },
    currentCustomer: CurrentCustomer,
    context: PortalRequestContext
  ) {
    this.assertEnabled();
    const idempotencyKey = assertPortalIdempotencyKey(input.idempotencyKey);
    const reason = input.reason.trim();
    if (!reason) throw new ConflictException("A quote rejection reason is required.");
    const operation = "PORTAL_REJECT_EXTENSION_QUOTE";
    const requestHash = portalCommandHash({ changeId, ...input, idempotencyKey, reason });
    const replay = await replayPortalChangeCommand(
      this.prisma,
      operation,
      idempotencyKey,
      currentCustomer.customerId,
      requestHash
    );
    if (replay)
      return toChangeView(
        await this.findOwnedChange(changeId, currentCustomer.customerId),
        isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)
      );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const command = await tx.subscriptionChangeCommand.create({
          data: {
            actorId: currentCustomer.customerId,
            idempotencyKey,
            operation,
            requestHash
          }
        });
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
            toChangeView(change, true),
            toChangeView(updated, true)
          ),
          tx
        );
        await completePortalChangeCommand(tx, command.id, change.id, this.config.now());
        return toChangeView(updated, true);
      }, serializableTransaction);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const concurrentReplay = await replayPortalChangeCommand(
        this.prisma,
        operation,
        idempotencyKey,
        currentCustomer.customerId,
        requestHash
      );
      if (!concurrentReplay) throw error;
      return toChangeView(
        await this.findOwnedChange(changeId, currentCustomer.customerId),
        isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)
      );
    }
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

  private projectConsideration(consideration: PortalConsideration) {
    return toConsiderationView(
      consideration,
      isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION),
      this.config.now()
    );
  }

  private assertEnabled() {
    if (!isSubscriptionChangeTypeEnabled(this.config, SubscriptionChangeType.EXTENSION)) {
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

function toConsiderationView(
  consideration: PortalConsideration,
  extensionEnabled: boolean,
  now: Date
) {
  const decisionReady =
    !consideration.decision && now.getTime() < consideration.completionDeadlineAt.getTime();
  return {
    allowedActions: decisionReady
      ? [...(extensionEnabled ? (["RENEW"] as const) : []), "EXPIRE"]
      : [],
    changeOrderId: consideration.changeOrderId,
    completionDeadlineAt: consideration.completionDeadlineAt.toISOString(),
    considerationStartAt: consideration.considerationStartAt.toISOString(),
    decision: consideration.decision,
    decidedAt: consideration.decidedAt?.toISOString() ?? null,
    featureAvailability: {
      enabled: extensionEnabled,
      flagName: "SUBSCRIPTION_EXTENSION_ENABLED"
    },
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

function toChangeView(change: PortalChange, featureEnabled: boolean) {
  const extensionChange = requireExtensionChangeProjection(change);
  const customerDecisionReady = Boolean(
    featureEnabled &&
    change.status === SubscriptionChangeStatus.QUOTED &&
    change.customerConfirmationPublishedAt &&
    change.currentQuote?.status === SubscriptionChangeQuoteStatus.FORMAL
  );
  return {
    allowedActions: customerDecisionReady ? ["CONFIRM_QUOTE", "REJECT_QUOTE"] : [],
    cancelReason: change.cancelReason,
    completionDeadlineAt: change.completionDeadlineAt.toISOString(),
    confirmedQuoteId: change.confirmedQuoteId,
    contractId: change.contractId,
    currentQuote: change.currentQuote ? toQuoteView(change.currentQuote) : null,
    customerConfirmationPublishedAt: change.customerConfirmationPublishedAt?.toISOString() ?? null,
    extensionMonths: extensionChange.extensionMonths,
    featureAvailability: {
      enabled: featureEnabled,
      flagName: "SUBSCRIPTION_EXTENSION_ENABLED"
    },
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

function assertPortalIdempotencyKey(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid Idempotency-Key header is required."
    });
  }
  return normalized;
}

function portalCommandHash(value: unknown) {
  return createHash("sha256").update(stablePortalJson(value)).digest("hex");
}

function stablePortalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stablePortalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stablePortalJson(item)}`)
    .join(",")}}`;
}

async function replayPortalRenewalDecision(
  db: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  operation: string,
  idempotencyKey: string,
  actorId: string,
  requestHash: string
) {
  const command = await db.subscriptionChangeCommand.findUnique({
    where: { actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation } }
  });
  if (!command) return null;
  if (command.requestHash !== requestHash) {
    throw new ConflictException({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      message: "The Idempotency-Key was already used with a different request."
    });
  }
  if (
    command.resourceType !== "RENEWAL_CONSIDERATION" ||
    !command.resourceId ||
    !command.completedAt
  ) {
    throw new ConflictException({
      code: "IDEMPOTENCY_COMMAND_IN_PROGRESS",
      message: "The idempotent renewal decision has not completed."
    });
  }
  return command;
}

async function completePortalRenewalDecisionCommand(
  tx: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  commandId: string,
  considerationId: string,
  completedAt: Date
) {
  await tx.subscriptionChangeCommand.update({
    data: {
      completedAt,
      resourceId: considerationId,
      resourceType: "RENEWAL_CONSIDERATION"
    },
    where: { id: commandId }
  });
}

async function replayPortalChangeCommand(
  db: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  operation: string,
  idempotencyKey: string,
  actorId: string,
  requestHash: string
) {
  const command = await db.subscriptionChangeCommand.findUnique({
    where: { actorId_operation_idempotencyKey: { actorId, idempotencyKey, operation } }
  });
  if (!command) return null;
  if (command.requestHash !== requestHash) {
    throw new ConflictException({
      code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      message: "The Idempotency-Key was already used with a different request."
    });
  }
  if (command.resourceType !== "CHANGE" || !command.resourceId || !command.completedAt) {
    throw new ConflictException({
      code: "IDEMPOTENCY_COMMAND_IN_PROGRESS",
      message: "The idempotent command has not completed."
    });
  }
  return command;
}

async function completePortalChangeCommand(
  tx: Pick<Prisma.TransactionClient, "subscriptionChangeCommand">,
  commandId: string,
  changeId: string,
  completedAt: Date
) {
  await tx.subscriptionChangeCommand.update({
    data: { completedAt, resourceId: changeId, resourceType: "CHANGE" },
    where: { id: commandId }
  });
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable
};
