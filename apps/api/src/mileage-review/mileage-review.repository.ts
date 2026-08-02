import { ConflictException, Injectable } from "@nestjs/common";
import { OrderMileageReviewStatus, Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { MileageReviewTransaction } from "./mileage-review.types";

export const mileageReviewInclude = {
  baselineReading: true,
  entitlementGrant: true,
  entitlementUsage: true,
  evidence: {
    include: { file: true },
    orderBy: { createdAt: "asc" as const },
    where: { deletedAt: null }
  },
  mileageReading: true,
  order: {
    select: {
      customerId: true,
      id: true,
      orderNo: true,
      orderStatus: true
    }
  },
  overMileageBill: true,
  vehicle: {
    select: {
      brand: true,
      id: true,
      model: true,
      plateNo: true,
      vehicleNo: true,
      vin: true
    }
  }
} satisfies Prisma.OrderMileageReviewInclude;

export type MileageReviewRecord = Prisma.OrderMileageReviewGetPayload<{
  include: typeof mileageReviewInclude;
}>;

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

  findById(id: string) {
    return this.prisma.orderMileageReview.findUnique({
      include: mileageReviewInclude,
      where: { id }
    });
  }

  async list(input: {
    orderId?: string;
    page: number;
    pageSize: number;
    status?: OrderMileageReviewStatus;
  }) {
    const where = {
      deletedAt: null,
      orderId: input.orderId,
      status: input.status
    } satisfies Prisma.OrderMileageReviewWhereInput;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.orderMileageReview.findMany({
        include: mileageReviewInclude,
        orderBy: [{ scheduledReviewAt: "desc" }, { createdAt: "desc" }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        where
      }),
      this.prisma.orderMileageReview.count({ where })
    ]);
    return { items, total };
  }

  findFile(id: string) {
    return this.prisma.fileObject.findUnique({ where: { id } });
  }

  findEvidence(id: string, reviewId: string) {
    return this.prisma.orderMileageReviewEvidence.findFirst({
      include: { file: true },
      where: { deletedAt: null, id, reviewId }
    });
  }

  updateReview(input: {
    data: Prisma.OrderMileageReviewUncheckedUpdateManyInput;
    expectedLockVersion: number;
    expectedStatuses: OrderMileageReviewStatus[];
    id: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await updateReviewGuard(tx, input);
      return tx.orderMileageReview.findUniqueOrThrow({
        include: mileageReviewInclude,
        where: { id: input.id }
      });
    });
  }

  attachEvidence(input: {
    data: Prisma.OrderMileageReviewEvidenceUncheckedCreateInput;
    expectedLockVersion: number;
    expectedStatuses: OrderMileageReviewStatus[];
    id: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await updateReviewGuard(tx, {
        data: {},
        expectedLockVersion: input.expectedLockVersion,
        expectedStatuses: input.expectedStatuses,
        id: input.id
      });
      await tx.orderMileageReviewEvidence.create({ data: input.data });
      return tx.orderMileageReview.findUniqueOrThrow({
        include: mileageReviewInclude,
        where: { id: input.id }
      });
    });
  }

  softDeleteEvidence(input: {
    actorId: string;
    evidenceId: string;
    expectedLockVersion: number;
    expectedStatuses: OrderMileageReviewStatus[];
    id: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await updateReviewGuard(tx, {
        data: {},
        expectedLockVersion: input.expectedLockVersion,
        expectedStatuses: input.expectedStatuses,
        id: input.id
      });
      const deleted = await tx.orderMileageReviewEvidence.updateMany({
        data: {
          deletedAt: new Date(),
          updatedBy: input.actorId
        },
        where: {
          deletedAt: null,
          id: input.evidenceId,
          reviewId: input.id
        }
      });
      if (deleted.count !== 1) {
        throw new ConflictException(
          "Mileage review evidence is missing or already removed."
        );
      }
      return tx.orderMileageReview.findUniqueOrThrow({
        include: mileageReviewInclude,
        where: { id: input.id }
      });
    });
  }
}

async function updateReviewGuard(
  tx: MileageReviewTransaction,
  input: {
    data: Prisma.OrderMileageReviewUncheckedUpdateManyInput;
    expectedLockVersion: number;
    expectedStatuses: OrderMileageReviewStatus[];
    id: string;
  }
) {
  const updated = await tx.orderMileageReview.updateMany({
    data: {
      ...input.data,
      lockVersion: { increment: 1 }
    },
    where: {
      deletedAt: null,
      id: input.id,
      lockVersion: input.expectedLockVersion,
      status: { in: input.expectedStatuses }
    }
  });
  if (updated.count !== 1) {
    throw new ConflictException(
      "Mileage review was changed by another request."
    );
  }
}
