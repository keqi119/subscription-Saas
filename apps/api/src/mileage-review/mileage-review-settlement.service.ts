import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  BillStatus,
  BillType,
  EntitlementAccountStatus,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementType,
  EntitlementUnit,
  EntitlementUsageSource,
  EntitlementUsageStatus,
  OrderMileageReviewStatus,
  OrderStatus,
  Prisma,
  VehicleMileageSourceType
} from "@prisma/client";

import { createBusinessNo } from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { VehicleMileageService } from "../vehicle-mileage/vehicle-mileage.service";
import { buildMileageReviewCycle } from "./mileage-review.calendar";
import { calculateMileageSettlement } from "./mileage-review.calculator";
import { mileageReviewInclude } from "./mileage-review.repository";
import { isSupportedRasterMimeType } from "./mileage-review-evidence";
import { assertMileageReviewTimestamp } from "./mileage-review-time";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

const settlementReviewInclude = {
  baselineReading: { select: { recordedAt: true } },
  evidence: {
    include: { file: true },
    where: { deletedAt: null }
  },
  order: {
    select: {
      actualDeliveryAt: true,
      customerId: true,
      id: true,
      mileageLimitKm: true,
      orderNo: true,
      orderStatus: true,
      overMileageFeeAmount: true,
      periodMonths: true
    }
  }
} satisfies Prisma.OrderMileageReviewInclude;

type SettlementReview = Prisma.OrderMileageReviewGetPayload<{
  include: typeof settlementReviewInclude;
}>;

export interface SettleMileageReviewInput {
  confirmedAt?: Date;
  expectedLockVersion: number;
  idempotencyKey: string;
  reviewId: string;
  userId: string;
}

export interface VoidMileageReviewInput {
  expectedLockVersion: number;
  reason: string;
  reviewId: string;
  userId: string;
  voidedAt?: Date;
}

@Injectable()
export class MileageReviewSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleMileageService: VehicleMileageService
  ) {}

  settleReview(input: SettleMileageReviewInput) {
    const confirmedAt = input.confirmedAt ?? new Date();
    assertSettlementInput(input, confirmedAt);

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "order_mileage_review" WHERE "id" = ${input.reviewId}::uuid FOR UPDATE`
        );
        const review = await tx.orderMileageReview.findUnique({
          include: settlementReviewInclude,
          where: { id: input.reviewId }
        });
        if (!review || review.deletedAt) {
          throw new NotFoundException("Mileage review not found.");
        }

        if (review.status === OrderMileageReviewStatus.CONFIRMED) {
          if (confirmationKey(review.calculationSnapshot) === input.idempotencyKey) {
            return this.findSettledReview(tx, review.id);
          }
          throw new ConflictException("Mileage review is already confirmed.");
        }
        assertConfirmable(review, input.expectedLockVersion, confirmedAt);

        const unresolvedPriorCycles = await tx.orderMileageReview.count({
          where: {
            cycleNo: { lt: review.cycleNo },
            deletedAt: null,
            orderId: review.orderId,
            status: {
              notIn: [OrderMileageReviewStatus.CONFIRMED, OrderMileageReviewStatus.VOIDED]
            }
          }
        });
        if (unresolvedPriorCycles > 0) {
          throw new BadRequestException("Prior mileage review cycles must be confirmed first.");
        }

        const grant = await this.findOrCreateMileageGrant(tx, review, input.userId);
        const allowanceKm = decimalToSafeMileage(
          grant.remainingAmount ?? grant.totalAmount,
          "Mileage allowance"
        );
        const settlement = calculateMileageSettlement({
          allowanceKm,
          baselineMileageKm: review.baselineMileageKm,
          overMileageFeeAmount: review.order.overMileageFeeAmount,
          submittedMileageKm: review.submittedMileageKm!
        });
        const usage = await this.consumeAndExpireGrant(
          tx,
          review,
          grant,
          settlement.consumedAllowanceKm,
          settlement.unusedAllowanceKm,
          confirmedAt,
          input.userId
        );

        const reading = await this.vehicleMileageService.appendConfirmedReading(tx, {
          confirmedBy: input.userId,
          evidenceSnapshot: toJsonValue({
            evidenceIds: review.evidence.map((item) => item.id),
            mileageReviewId: review.id,
            version: review.version
          }),
          mileageKm: review.submittedMileageKm!,
          orderId: review.orderId,
          recordedAt: review.readingAt!,
          sourceRecordId: `${review.id}:v${review.version}`,
          sourceType: VehicleMileageSourceType.MONTHLY_REVIEW,
          vehicleId: review.vehicleId
        });

        const bill = await this.createOverMileageBill(
          tx,
          review,
          settlement.overMileageAmount,
          settlement.overMileageKm,
          confirmedAt,
          input.userId
        );
        const calculationSnapshot = toJsonValue({
          ...jsonRecord(review.calculationSnapshot),
          confirmation: {
            confirmedAt: confirmedAt.toISOString(),
            confirmedBy: input.userId,
            idempotencyKey: input.idempotencyKey
          },
          settlement: {
            actualUsageKm: settlement.actualUsageKm,
            allowanceKm,
            consumedAllowanceKm: settlement.consumedAllowanceKm,
            entitlementGrantId: grant.id,
            entitlementUsageId: usage?.id ?? null,
            overMileageAmount: settlement.overMileageAmount.toString(),
            overMileageBillId: bill?.id ?? null,
            overMileageFeeAmount: review.order.overMileageFeeAmount.toString(),
            overMileageKm: settlement.overMileageKm,
            unusedAllowanceKm: settlement.unusedAllowanceKm
          }
        });

        await tx.orderMileageReview.update({
          data: {
            allowanceKm,
            calculationSnapshot,
            consumedAllowanceKm: settlement.consumedAllowanceKm,
            entitlementGrantId: grant.id,
            entitlementUsageId: usage?.id ?? null,
            lockVersion: { increment: 1 },
            mileageReadingId: reading.id,
            overMileageAmount: settlement.overMileageAmount,
            overMileageBillId: bill?.id ?? null,
            overMileageFeeAmount: review.order.overMileageFeeAmount,
            overMileageKm: settlement.overMileageKm,
            reviewNote: null,
            reviewedAt: confirmedAt,
            reviewedBy: input.userId,
            status: OrderMileageReviewStatus.CONFIRMED,
            updatedBy: input.userId
          },
          where: { id: review.id }
        });

        await this.createNextReview(tx, review, reading.id, confirmedAt, input.userId);
        return this.findSettledReview(tx, review.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  voidAndReopenReview(input: VoidMileageReviewInput) {
    const voidedAt = input.voidedAt ?? new Date();
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException("Mileage review void reason is required.");
    }
    if (!Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 0) {
      throw new BadRequestException("Mileage review lock version is invalid.");
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "order_mileage_review" WHERE "id" = ${input.reviewId}::uuid FOR UPDATE`
        );
        const review = await tx.orderMileageReview.findUnique({
          include: settlementReviewInclude,
          where: { id: input.reviewId }
        });
        if (!review || review.deletedAt) {
          throw new NotFoundException("Mileage review not found.");
        }
        if (
          review.status !== OrderMileageReviewStatus.CONFIRMED ||
          review.lockVersion !== input.expectedLockVersion
        ) {
          throw new ConflictException("Mileage review was changed or is not confirmed.");
        }

        const laterConfirmedCount = await tx.orderMileageReview.count({
          where: {
            cycleNo: { gt: review.cycleNo },
            deletedAt: null,
            orderId: review.orderId,
            status: OrderMileageReviewStatus.CONFIRMED
          }
        });
        if (laterConfirmedCount > 0) {
          throw new BadRequestException("A later confirmed mileage review prevents this rollback.");
        }

        const bill = review.overMileageBillId
          ? await tx.receivableBill.findUnique({
              where: { id: review.overMileageBillId }
            })
          : null;
        if (
          bill &&
          (bill.paidAmount > 0n ||
            bill.billStatus === BillStatus.PARTIALLY_PAID ||
            bill.billStatus === BillStatus.PAID)
        ) {
          throw new BadRequestException(
            "A paid or partially paid over-mileage bill prevents this rollback."
          );
        }

        await this.restoreEntitlement(tx, review, input.userId);
        if (bill) {
          await tx.receivableBill.update({
            data: {
              billStatus: BillStatus.CANCELLED,
              cancelledAt: voidedAt,
              remainingAmount: 0n,
              updatedBy: input.userId
            },
            where: { id: bill.id }
          });
        }
        if (!review.mileageReadingId) {
          throw new ConflictException("Confirmed mileage review is missing its mileage reading.");
        }
        await this.vehicleMileageService.voidReadingAndRestoreProjection(tx, {
          actorId: input.userId,
          readingId: review.mileageReadingId,
          reason,
          vehicleId: review.vehicleId,
          voidedAt
        });

        await tx.orderMileageReview.updateMany({
          data: {
            deletedAt: voidedAt,
            updatedBy: input.userId
          },
          where: {
            cycleNo: { gt: review.cycleNo },
            deletedAt: null,
            orderId: review.orderId,
            status: {
              not: OrderMileageReviewStatus.CONFIRMED
            }
          }
        });
        await tx.orderMileageReview.update({
          data: {
            calculationSnapshot: toJsonValue({
              ...jsonRecord(review.calculationSnapshot),
              void: {
                reason,
                voidedAt: voidedAt.toISOString(),
                voidedBy: input.userId
              }
            }),
            lockVersion: { increment: 1 },
            status: OrderMileageReviewStatus.VOIDED,
            updatedBy: input.userId,
            voidReason: reason,
            voidedAt,
            voidedBy: input.userId
          },
          where: { id: review.id }
        });

        const replacement = await tx.orderMileageReview.create({
          data: {
            baselineMileageKm: review.baselineMileageKm,
            baselineReadingId: review.baselineReadingId,
            calculationSnapshot: toJsonValue({
              reopenedAt: voidedAt.toISOString(),
              reopenedBy: input.userId,
              replacesReviewId: review.id
            }),
            createdBy: input.userId,
            cycleNo: review.cycleNo,
            dueAt: review.dueAt,
            orderId: review.orderId,
            periodEnd: review.periodEnd,
            periodStart: review.periodStart,
            scheduledReviewAt: review.scheduledReviewAt,
            status: OrderMileageReviewStatus.PENDING_SUBMISSION,
            updatedBy: input.userId,
            vehicleId: review.vehicleId,
            version: review.version + 1
          }
        });
        return {
          replacementReview: await this.findSettledReview(tx, replacement.id),
          voidedReview: await this.findSettledReview(tx, review.id)
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private findSettledReview(tx: Prisma.TransactionClient, id: string) {
    return tx.orderMileageReview.findUniqueOrThrow({
      include: mileageReviewInclude,
      where: { id }
    });
  }

  private async findOrCreateMileageGrant(
    tx: Prisma.TransactionClient,
    review: SettlementReview,
    userId: string
  ) {
    const entitlementPeriod = reviewEntitlementPeriod(review);
    const existing = await tx.orderEntitlementGrant.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        deletedAt: null,
        entitlementType: EntitlementType.MILEAGE,
        grantPeriodEnd: { gte: entitlementPeriod.periodEnd },
        grantPeriodStart: { lte: entitlementPeriod.periodStart },
        orderId: review.orderId,
        status: {
          in: [
            EntitlementGrantStatus.ACTIVE,
            EntitlementGrantStatus.EXHAUSTED,
            EntitlementGrantStatus.EXPIRED
          ]
        },
        unit: EntitlementUnit.KM
      }
    });
    if (existing) {
      return existing;
    }

    let account = await tx.orderEntitlementAccount.findFirst({
      orderBy: { createdAt: "desc" },
      where: {
        accountStatus: EntitlementAccountStatus.ACTIVE,
        deletedAt: null,
        orderId: review.orderId
      }
    });
    if (!account) {
      account = await tx.orderEntitlementAccount.create({
        data: {
          accountNo: createBusinessNo("EA"),
          accountStatus: EntitlementAccountStatus.ACTIVE,
          createdBy: userId,
          customerId: review.order.customerId,
          orderId: review.orderId,
          periodEnd: null,
          periodStart: toBusinessDate(review.order.actualDeliveryAt ?? review.periodStart),
          snapshot: toJsonValue({
            backfilledBy: "MILEAGE_REVIEW_SETTLEMENT",
            mileageReviewId: review.id
          }),
          updatedBy: userId
        }
      });
    }

    const allowance = new Prisma.Decimal(review.order.mileageLimitKm);
    return tx.orderEntitlementGrant.create({
      data: {
        accountId: account.id,
        createdBy: userId,
        customerId: review.order.customerId,
        entitlementName: "月里程额度",
        entitlementType: EntitlementType.MILEAGE,
        grantNo: createBusinessNo("EG"),
        grantPeriodEnd: entitlementPeriod.periodEnd,
        grantPeriodStart: entitlementPeriod.periodStart,
        grantSource: EntitlementGrantSource.MONTHLY_RENEWAL,
        orderId: review.orderId,
        remainingAmount: allowance,
        snapshot: toJsonValue({
          backfilledBy: "MILEAGE_REVIEW_SETTLEMENT",
          mileageReviewId: review.id
        }),
        status: EntitlementGrantStatus.ACTIVE,
        totalAmount: allowance,
        unit: EntitlementUnit.KM,
        updatedBy: userId,
        usedAmount: new Prisma.Decimal(0)
      }
    });
  }

  private async consumeAndExpireGrant(
    tx: Prisma.TransactionClient,
    review: SettlementReview,
    grant: Awaited<ReturnType<typeof this.findOrCreateMileageGrant>>,
    consumedAllowanceKm: number,
    unusedAllowanceKm: number,
    confirmedAt: Date,
    userId: string
  ) {
    const existingUsed = decimalToSafeMileage(grant.usedAmount, "Used mileage");
    let usage: { id: string } | null = null;
    if (consumedAllowanceKm > 0) {
      const externalRefNo = `mileage-review:${review.id}:v${review.version}`;
      usage = await tx.orderEntitlementUsage.findFirst({
        where: {
          deletedAt: null,
          externalRefNo,
          usageStatus: EntitlementUsageStatus.CONFIRMED
        }
      });
      usage ??= await tx.orderEntitlementUsage.create({
        data: {
          accountId: grant.accountId,
          createdBy: userId,
          customerId: review.order.customerId,
          entitlementName: grant.entitlementName,
          entitlementType: EntitlementType.MILEAGE,
          externalRefNo,
          grantId: grant.id,
          occurredAt: confirmedAt,
          orderId: review.orderId,
          scenario: "MILEAGE_REVIEW",
          snapshot: toJsonValue({
            mileageReviewId: review.id,
            version: review.version
          }),
          unit: EntitlementUnit.KM,
          updatedBy: userId,
          usageNo: createBusinessNo("EU"),
          usageSource: EntitlementUsageSource.SYSTEM,
          usageStatus: EntitlementUsageStatus.CONFIRMED,
          usedAmount: new Prisma.Decimal(consumedAllowanceKm)
        }
      });
    }

    await tx.orderEntitlementGrant.update({
      data: {
        remainingAmount: new Prisma.Decimal(0),
        status:
          unusedAllowanceKm > 0 ? EntitlementGrantStatus.EXPIRED : EntitlementGrantStatus.EXHAUSTED,
        updatedBy: userId,
        usedAmount: new Prisma.Decimal(existingUsed + consumedAllowanceKm)
      },
      where: { id: grant.id }
    });
    return usage;
  }

  private async createOverMileageBill(
    tx: Prisma.TransactionClient,
    review: SettlementReview,
    amount: bigint,
    overMileageKm: number,
    confirmedAt: Date,
    userId: string
  ) {
    if (amount <= 0n) {
      return null;
    }
    const sourceKey = `over-mileage:${review.id}:v${review.version}`;
    const existing = await tx.receivableBill.findUnique({ where: { sourceKey } });
    if (existing) {
      if (
        existing.billType !== BillType.OVER_MILEAGE ||
        existing.orderId !== review.orderId ||
        existing.amount !== amount
      ) {
        throw new ConflictException("Over-mileage bill idempotency key is already in use.");
      }
      return existing;
    }
    const entitlementPeriod = reviewEntitlementPeriod(review);
    return tx.receivableBill.create({
      data: {
        amount,
        billNo: createBusinessNo("BIL"),
        billPeriodEnd: entitlementPeriod.periodEnd,
        billPeriodStart: entitlementPeriod.periodStart,
        billStatus: BillStatus.PENDING,
        billType: BillType.OVER_MILEAGE,
        createdBy: userId,
        customerId: review.order.customerId,
        dueDate: new Date(confirmedAt.getTime() + FIVE_DAYS_MS),
        orderId: review.orderId,
        paidAmount: 0n,
        remainingAmount: amount,
        snapshot: toJsonValue({
          mileageReviewId: review.id,
          overMileageFeeAmount: review.order.overMileageFeeAmount.toString(),
          overMileageKm,
          version: review.version
        }),
        sourceKey,
        updatedBy: userId
      }
    });
  }

  private async createNextReview(
    tx: Prisma.TransactionClient,
    review: SettlementReview,
    baselineReadingId: string,
    confirmedAt: Date,
    userId: string
  ) {
    if (
      review.order.orderStatus !== OrderStatus.ACTIVE ||
      !review.order.actualDeliveryAt ||
      review.cycleNo >= review.order.periodMonths
    ) {
      return null;
    }
    const cycleNo = review.cycleNo + 1;
    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: review.order.actualDeliveryAt,
      cycleNo
    });
    const existing = await tx.orderMileageReview.findFirst({
      orderBy: { version: "desc" },
      where: { cycleNo, orderId: review.orderId }
    });
    if (existing && !existing.deletedAt) {
      return existing;
    }
    return tx.orderMileageReview.create({
      data: {
        baselineMileageKm: review.submittedMileageKm!,
        baselineReadingId,
        calculationSnapshot: toJsonValue({
          createdFromReviewId: review.id,
          cycle: {
            actualDeliveryAt: review.order.actualDeliveryAt.toISOString(),
            timezone: "Asia/Shanghai"
          }
        }),
        createdBy: userId,
        cycleNo,
        dueAt: cycle.dueAt,
        orderId: review.orderId,
        periodEnd: cycle.periodEnd,
        periodStart: cycle.periodStart,
        scheduledReviewAt: cycle.scheduledReviewAt,
        status:
          cycle.scheduledReviewAt.getTime() <= confirmedAt.getTime()
            ? OrderMileageReviewStatus.PENDING_SUBMISSION
            : OrderMileageReviewStatus.SCHEDULED,
        updatedBy: userId,
        vehicleId: review.vehicleId,
        version: (existing?.version ?? 0) + 1
      }
    });
  }

  private async restoreEntitlement(
    tx: Prisma.TransactionClient,
    review: SettlementReview,
    userId: string
  ) {
    if (!review.entitlementGrantId || review.allowanceKm === null) {
      throw new ConflictException(
        "Confirmed mileage review is missing its entitlement settlement."
      );
    }
    const grant = await tx.orderEntitlementGrant.findUnique({
      where: { id: review.entitlementGrantId }
    });
    if (!grant) {
      throw new ConflictException("Mileage entitlement grant is unavailable.");
    }
    let restoredUsed = decimalToSafeMileage(grant.usedAmount, "Used mileage");
    if (review.entitlementUsageId) {
      const usage = await tx.orderEntitlementUsage.findUnique({
        where: { id: review.entitlementUsageId }
      });
      if (!usage || usage.usageStatus !== EntitlementUsageStatus.CONFIRMED) {
        throw new ConflictException("Mileage entitlement usage is unavailable.");
      }
      const used = decimalToSafeMileage(usage.usedAmount, "Usage mileage");
      restoredUsed -= used;
      if (restoredUsed < 0) {
        throw new ConflictException("Mileage entitlement usage cannot be restored.");
      }
      await tx.orderEntitlementUsage.update({
        data: {
          usageStatus: EntitlementUsageStatus.CANCELLED,
          updatedBy: userId
        },
        where: { id: usage.id }
      });
    }
    await tx.orderEntitlementGrant.update({
      data: {
        remainingAmount: new Prisma.Decimal(review.allowanceKm),
        status: EntitlementGrantStatus.ACTIVE,
        updatedBy: userId,
        usedAmount: new Prisma.Decimal(restoredUsed)
      },
      where: { id: grant.id }
    });
  }
}

function assertSettlementInput(input: SettleMileageReviewInput, confirmedAt: Date) {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
    throw new BadRequestException("Mileage review confirmation idempotency key is required.");
  }
  if (!Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 0) {
    throw new BadRequestException("Mileage review lock version is invalid.");
  }
  if (Number.isNaN(confirmedAt.getTime())) {
    throw new BadRequestException("Mileage review confirmation time is invalid.");
  }
}

function assertConfirmable(
  review: SettlementReview,
  expectedLockVersion: number,
  confirmedAt: Date
) {
  if (
    review.status !== OrderMileageReviewStatus.PENDING_REVIEW ||
    review.lockVersion !== expectedLockVersion
  ) {
    throw new ConflictException("Mileage review was changed by another request.");
  }
  if (review.order.orderStatus !== OrderStatus.ACTIVE) {
    throw new BadRequestException("Only active orders can settle mileage reviews.");
  }
  if (
    review.submittedMileageKm === null ||
    !review.readingAt ||
    review.submittedMileageKm < review.baselineMileageKm
  ) {
    throw new BadRequestException("Mileage review submission is incomplete.");
  }
  assertMileageReviewTimestamp(review, review.readingAt, confirmedAt);
  if (!review.evidence.some((item) => isSupportedRasterMimeType(item.file.mimeType))) {
    throw new BadRequestException("At least one image evidence file is required for confirmation.");
  }
}

function decimalToSafeMileage(value: Prisma.Decimal | null, label: string) {
  const number = value?.toNumber();
  if (number === undefined || !Number.isSafeInteger(number) || number < 0) {
    throw new BadRequestException(`${label} must be a non-negative integer.`);
  }
  return number;
}

function confirmationKey(value: Prisma.JsonValue | null) {
  const confirmation = jsonRecord(jsonRecord(value).confirmation);
  return typeof confirmation.idempotencyKey === "string" ? confirmation.idempotencyKey : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toBusinessDate(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function reviewEntitlementPeriod(
  review: Pick<SettlementReview, "periodStart" | "scheduledReviewAt">
) {
  const periodStart = toBusinessDate(review.periodStart);
  const nextPeriodStart = toBusinessDate(review.scheduledReviewAt);
  const periodEnd = new Date(nextPeriodStart);
  periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);
  return { periodEnd, periodStart };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
