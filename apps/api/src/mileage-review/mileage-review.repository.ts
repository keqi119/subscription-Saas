import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { MileageReviewTransaction } from "./mileage-review.types";

@Injectable()
export class MileageReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMileageReading(tx: MileageReviewTransaction, id: string) {
    return tx.vehicleMileageReading.findUnique({ where: { id } });
  }

  createFirstReview(
    tx: MileageReviewTransaction,
    data: Prisma.OrderMileageReviewUncheckedCreateInput
  ) {
    return tx.orderMileageReview.upsert({
      create: data,
      update: {},
      where: {
        orderId_cycleNo_version: {
          cycleNo: 1,
          orderId: data.orderId,
          version: 1
        }
      }
    });
  }

  async activateDueReviews(asOf: Date) {
    return this.prisma.orderMileageReview.updateMany({
      data: {
        lockVersion: { increment: 1 },
        status: "PENDING_SUBMISSION"
      },
      where: {
        deletedAt: null,
        scheduledReviewAt: { lte: asOf },
        status: "SCHEDULED"
      }
    });
  }
}
