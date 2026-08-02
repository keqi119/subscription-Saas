import { BadRequestException, Injectable } from "@nestjs/common";
import {
  OrderMileageReviewStatus,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { buildMileageReviewCycle } from "./mileage-review.calendar";
import { MileageReviewRepository } from "./mileage-review.repository";
import {
  CreateFirstMileageReviewInput,
  MileageReviewTransaction
} from "./mileage-review.types";

@Injectable()
export class MileageReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MileageReviewRepository
  ) {}

  async createFirstReview(
    tx: MileageReviewTransaction,
    input: CreateFirstMileageReviewInput
  ) {
    const baseline = await this.repository.findMileageReading(
      tx,
      input.deliveryReadingId
    );
    if (
      !baseline ||
      baseline.status !== VehicleMileageReadingStatus.ACTIVE ||
      baseline.sourceType !== VehicleMileageSourceType.DELIVERY_BASELINE ||
      baseline.orderId !== input.orderId ||
      baseline.vehicleId !== input.vehicleId
    ) {
      throw new BadRequestException(
        "Delivery baseline mileage reading is invalid."
      );
    }

    const cycle = buildMileageReviewCycle({
      actualDeliveryAt: input.actualDeliveryAt,
      cycleNo: 1
    });

    return this.repository.createFirstReview(tx, {
      baselineMileageKm: baseline.mileageKm,
      baselineReadingId: baseline.id,
      calculationSnapshot: {
        cycle: {
          actualDeliveryAt: input.actualDeliveryAt.toISOString(),
          timezone: "Asia/Shanghai"
        },
        source: {
          deliveryReadingId: baseline.id,
          type: VehicleMileageSourceType.DELIVERY_BASELINE
        }
      },
      createdBy: input.actorId,
      cycleNo: 1,
      dueAt: cycle.dueAt,
      orderId: input.orderId,
      periodEnd: cycle.periodEnd,
      periodStart: cycle.periodStart,
      scheduledReviewAt: cycle.scheduledReviewAt,
      status: OrderMileageReviewStatus.SCHEDULED,
      updatedBy: input.actorId,
      vehicleId: input.vehicleId,
      version: 1
    });
  }

  async activateDueReviews(asOf: Date) {
    assertValidAsOf(asOf);
    const result = await this.repository.activateDueReviews(asOf);
    return { activatedCount: result.count };
  }
}

export function deriveOverdue(
  review: Pick<{ dueAt: Date; status: OrderMileageReviewStatus }, "dueAt" | "status">,
  asOf = new Date()
) {
  assertValidAsOf(asOf);
  assertValidAsOf(review.dueAt);
  return (
    review.status === OrderMileageReviewStatus.PENDING_SUBMISSION &&
    asOf.getTime() > review.dueAt.getTime()
  );
}

function assertValidAsOf(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("Mileage review evaluation time must be valid.");
  }
}
