import { Injectable } from "@nestjs/common";
import {
  ContractSegmentStatus,
  ContractSegmentType,
  ContractStatus,
  Prisma,
  SubscriptionContractSegment
} from "@prisma/client";

import {
  createBusinessNo,
  withUniqueBusinessNoRetry
} from "../common/business-number";
import { PrismaService } from "../prisma/prisma.service";
import { ContractSegmentError } from "./subscription-change.errors";
import { ContractSegmentTerms } from "./subscription-change.types";

const DAY_MS = 86_400_000;

@Injectable()
export class ContractSegmentService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureBaseSegment(
    orderId: string,
    actorId?: string
  ): Promise<SubscriptionContractSegment> {
    return this.serializable(async (tx) => {
      await lockOrder(tx, orderId);

      const existing = await tx.subscriptionContractSegment.findFirst({
        where: {
          orderId,
          segmentType: ContractSegmentType.BASE
        }
      });
      if (existing) return existing;

      const order = await tx.subscriptionOrder.findUnique({
        include: {
          contract: true
        },
        where: { id: orderId }
      });
      if (!order) {
        throw new ContractSegmentError("ORDER_NOT_FOUND", "Subscription order was not found.");
      }

      assertBaseSourceComplete(order);
      const contract = order.contract!;

      return withUniqueBusinessNoRetry(() =>
        tx.subscriptionContractSegment.create({
          data: {
            activatedAt: order.startDate,
            contractSnapshot: contract.contractSnapshot as Prisma.InputJsonObject,
            createdBy: actorId,
            endDate: order.endDate!,
            energyLimitCount: order.energyLimitCount,
            energyLimitKwh: order.energyLimitKwh,
            mileageLimitKm: order.mileageLimitKm,
            monthlyFeeAmount: order.monthlyFeeAmount,
            orderId: order.id,
            overMileageFeeAmount: order.overMileageFeeAmount,
            planSnapshot: order.finalPlanSnapshot!,
            productId: order.productId,
            productVersionId: order.productVersionId,
            quoteSnapshot: order.quoteSnapshot as Prisma.InputJsonObject,
            segmentNo: createBusinessNo("SEG"),
            segmentType: ContractSegmentType.BASE,
            sequenceNo: 1,
            sourceContractId: contract.id,
            startDate: order.startDate!,
            status: ContractSegmentStatus.ACTIVE,
            subscriptionPlanId: null
          }
        })
      );
    });
  }

  async resolveEffectiveServiceEndDate(orderId: string): Promise<Date | null> {
    const segment = await this.prisma.subscriptionContractSegment.findFirst({
      orderBy: [{ endDate: "desc" }, { sequenceNo: "desc" }],
      select: { endDate: true },
      where: {
        orderId,
        status: { not: ContractSegmentStatus.CANCELLED }
      }
    });
    if (segment) return segment.endDate;

    const order = await this.prisma.subscriptionOrder.findUnique({
      select: { endDate: true },
      where: { id: orderId }
    });
    return order?.endDate ?? null;
  }

  async resolveSegmentForPeriod(
    orderId: string,
    periodStart: Date
  ): Promise<ContractSegmentTerms> {
    assertDate(periodStart);
    const segment = await this.prisma.subscriptionContractSegment.findFirst({
      orderBy: { sequenceNo: "desc" },
      where: {
        endDate: { gte: periodStart },
        orderId,
        startDate: { lte: periodStart },
        status: { not: ContractSegmentStatus.CANCELLED }
      }
    });
    if (!segment) {
      throw new ContractSegmentError(
        "CONTRACT_SEGMENT_NOT_FOUND",
        "No effective contract segment contains the billing period start."
      );
    }

    return {
      endDate: segment.endDate,
      mileageLimitKm: segment.mileageLimitKm,
      monthlyFeeAmount: segment.monthlyFeeAmount,
      overMileageFeeAmount: segment.overMileageFeeAmount,
      planSnapshot: segment.planSnapshot,
      segmentId: segment.id,
      startDate: segment.startDate
    };
  }

  async assertAppendableExtension(
    sourceSegmentId: string,
    startDate: Date,
    endDate: Date
  ): Promise<void> {
    assertDate(startDate);
    assertDate(endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new ContractSegmentError(
        "CONTRACT_SEGMENT_INVALID_DATE_RANGE",
        "Contract segment end date must not precede its start date."
      );
    }

    await this.serializable(async (tx) => {
      await lockSegment(tx, sourceSegmentId);
      const source = await tx.subscriptionContractSegment.findUnique({
        where: { id: sourceSegmentId }
      });
      if (!source || source.status === ContractSegmentStatus.CANCELLED) {
        throw new ContractSegmentError(
          "CONTRACT_SEGMENT_NOT_FOUND",
          "Source contract segment was not found."
        );
      }

      const latest = await tx.subscriptionContractSegment.findFirst({
        orderBy: { sequenceNo: "desc" },
        where: {
          orderId: source.orderId,
          status: { not: ContractSegmentStatus.CANCELLED }
        }
      });
      if (!latest || latest.id !== source.id) {
        throw new ContractSegmentError(
          "CONTRACT_SEGMENT_OVERLAP",
          "The source segment is not the current final segment."
        );
      }

      const expectedStart = addUtcDays(source.endDate, 1);
      if (startDate.getTime() < expectedStart.getTime()) {
        throw new ContractSegmentError(
          "CONTRACT_SEGMENT_OVERLAP",
          "The extension overlaps the source contract segment."
        );
      }
      if (startDate.getTime() > expectedStart.getTime()) {
        throw new ContractSegmentError(
          "CONTRACT_SEGMENT_NOT_CONTIGUOUS",
          "The extension must begin on the day after the source segment ends."
        );
      }

      const overlap = await tx.subscriptionContractSegment.findFirst({
        where: {
          endDate: { gte: startDate },
          id: { not: source.id },
          orderId: source.orderId,
          startDate: { lte: endDate },
          status: { not: ContractSegmentStatus.CANCELLED }
        }
      });
      if (overlap) {
        throw new ContractSegmentError(
          "CONTRACT_SEGMENT_OVERLAP",
          "The extension overlaps an existing contract segment."
        );
      }
    });
  }

  private serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    });
  }
}

function assertBaseSourceComplete(order: {
  contract: null | {
    contractSnapshot: Prisma.JsonValue;
    id: string;
    status: ContractStatus;
  };
  endDate: Date | null;
  finalPlanSnapshot: Prisma.JsonValue | null;
  quoteSnapshot: Prisma.JsonValue;
  startDate: Date | null;
}) {
  if (
    !order.startDate ||
    !order.endDate ||
    !isJsonObject(order.finalPlanSnapshot) ||
    !isJsonObject(order.quoteSnapshot) ||
    !order.contract ||
    order.contract.status !== ContractStatus.ARCHIVED ||
    !isJsonObject(order.contract.contractSnapshot)
  ) {
    throw new ContractSegmentError(
      "BASE_SEGMENT_SOURCE_INCOMPLETE",
      "Original order dates, plan snapshot, and archived main contract are required."
    );
  }
}

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertDate(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ContractSegmentError(
      "CONTRACT_SEGMENT_INVALID_DATE_RANGE",
      "A valid contract segment date is required."
    );
  }
}

function addUtcDays(value: Date, days: number) {
  return new Date(value.getTime() + days * DAY_MS);
}

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_order" WHERE "id" = ${orderId}::uuid FOR UPDATE
  `);
}

async function lockSegment(tx: Prisma.TransactionClient, segmentId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "subscription_contract_segment" WHERE "id" = ${segmentId}::uuid FOR UPDATE
  `);
}
