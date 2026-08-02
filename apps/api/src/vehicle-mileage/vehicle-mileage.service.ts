import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  Prisma,
  VehicleMileageReading,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { AppendVehicleMileageReadingInput } from "./vehicle-mileage.types";

const PROJECTION_ONLY_SOURCES = new Set<VehicleMileageSourceType>([
  VehicleMileageSourceType.VEHICLE_INITIALIZATION,
  VehicleMileageSourceType.LEGACY_MIGRATION
]);

@Injectable()
export class VehicleMileageService {
  constructor(private readonly prisma: PrismaService) {}

  async appendConfirmedReading(
    tx: Prisma.TransactionClient,
    input: AppendVehicleMileageReadingInput
  ): Promise<VehicleMileageReading> {
    assertMileage(input.mileageKm);
    assertRecordedAt(input.recordedAt);

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "vehicle" WHERE "id" = ${input.vehicleId}::uuid FOR UPDATE`
    );

    const vehicle = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
    if (!vehicle || vehicle.deletedAt) {
      throw new NotFoundException("车辆不存在或已删除");
    }

    const existing = await tx.vehicleMileageReading.findUnique({
      where: {
        sourceType_sourceRecordId: {
          sourceRecordId: input.sourceRecordId,
          sourceType: input.sourceType
        }
      }
    });
    if (existing) {
      if (sameBusinessReading(existing, input)) {
        return existing;
      }
      throw new ConflictException("同一来源单据已记录不同的车辆里程");
    }

    const latest = await tx.vehicleMileageReading.findFirst({
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: {
        status: VehicleMileageReadingStatus.ACTIVE,
        vehicleId: input.vehicleId
      }
    });
    if (latest && input.mileageKm < latest.mileageKm) {
      throw new BadRequestException(`车辆里程不能小于上一条有效里程 ${latest.mileageKm} km`);
    }
    if (latest && input.recordedAt.getTime() < latest.recordedAt.getTime()) {
      throw new BadRequestException("里程记录时间不能早于上一条有效记录");
    }

    const now = new Date();
    const reading = await tx.vehicleMileageReading.create({
      data: {
        confirmedAt: now,
        confirmedBy: input.confirmedBy ?? null,
        createdBy: input.confirmedBy ?? null,
        deltaKm: input.mileageKm - (latest?.mileageKm ?? 0),
        evidenceSnapshot: input.evidenceSnapshot,
        mileageKm: input.mileageKm,
        orderId: input.orderId ?? null,
        previousReadingId: latest?.id ?? null,
        recordedAt: input.recordedAt,
        sourceRecordId: input.sourceRecordId,
        sourceType: input.sourceType,
        status: VehicleMileageReadingStatus.ACTIVE,
        updatedBy: input.confirmedBy ?? null,
        vehicleId: input.vehicleId
      }
    });

    await tx.vehicle.update({
      data: PROJECTION_ONLY_SOURCES.has(input.sourceType)
        ? {
            currentMileageKm: input.mileageKm,
            updatedBy: input.confirmedBy ?? undefined
          }
        : {
            currentMileageKm: input.mileageKm,
            salePriceReinitRequiredAt: now,
            updatedBy: input.confirmedBy ?? undefined
          },
      where: { id: input.vehicleId }
    });

    return reading;
  }

  listVehicleReadings(vehicleId: string) {
    return this.prisma.vehicleMileageReading.findMany({
      include: {
        order: { select: { id: true, orderNo: true } }
      },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: { vehicleId }
    });
  }
}

function assertMileage(mileageKm: number) {
  if (!Number.isSafeInteger(mileageKm) || mileageKm < 0) {
    throw new BadRequestException("车辆里程必须是非负整数");
  }
}

function assertRecordedAt(recordedAt: Date) {
  if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
    throw new BadRequestException("里程记录时间无效");
  }
}

function sameBusinessReading(
  existing: VehicleMileageReading,
  input: AppendVehicleMileageReadingInput
) {
  return (
    existing.vehicleId === input.vehicleId &&
    existing.orderId === (input.orderId ?? null) &&
    existing.sourceType === input.sourceType &&
    existing.sourceRecordId === input.sourceRecordId &&
    existing.recordedAt.getTime() === input.recordedAt.getTime() &&
    existing.mileageKm === input.mileageKm
  );
}
