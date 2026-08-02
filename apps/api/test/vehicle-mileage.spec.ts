import {
  Prisma,
  VehicleMileageReadingStatus,
  VehicleMileageSourceType
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

const vehicleId = "00000000-0000-4000-8000-000000000101";
const orderId = "00000000-0000-4000-8000-000000000201";
const actorId = "00000000-0000-4000-8000-000000000301";
const recordedAt = new Date("2026-08-02T04:00:00.000Z");

describe("VehicleMileageService", () => {
  it("creates the first confirmed reading and updates the vehicle projection", async () => {
    const harness = createHarness();

    const reading = await harness.service.appendConfirmedReading(harness.transaction, {
      confirmedBy: actorId,
      mileageKm: 128,
      orderId: null,
      recordedAt,
      sourceRecordId: vehicleId,
      sourceType: VehicleMileageSourceType.VEHICLE_INITIALIZATION,
      vehicleId
    });

    expect(reading).toMatchObject({
      deltaKm: 128,
      mileageKm: 128,
      previousReadingId: null,
      status: VehicleMileageReadingStatus.ACTIVE
    });
    expect(harness.tx.vehicleMileageReading.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        confirmedAt: expect.any(Date),
        confirmedBy: actorId,
        deltaKm: 128,
        mileageKm: 128,
        previousReadingId: null,
        sourceRecordId: vehicleId,
        sourceType: VehicleMileageSourceType.VEHICLE_INITIALIZATION,
        vehicleId
      })
    });
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: {
        currentMileageKm: 128,
        updatedBy: actorId
      },
      where: { id: vehicleId }
    });
  });

  it("chains a later reading and marks residual value for recalculation", async () => {
    const previous = readingRow({ mileageKm: 100, sourceRecordId: "previous" });
    const harness = createHarness({ latest: previous });

    const reading = await harness.service.appendConfirmedReading(harness.transaction, {
      confirmedBy: actorId,
      evidenceSnapshot: { fieldWorkOrderId: "work-order-1" },
      mileageKm: 145,
      orderId,
      recordedAt,
      sourceRecordId: "delivery-1",
      sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
      vehicleId
    });

    expect(reading).toMatchObject({ deltaKm: 45, previousReadingId: previous.id });
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: {
        currentMileageKm: 145,
        salePriceReinitRequiredAt: expect.any(Date),
        updatedBy: actorId
      },
      where: { id: vehicleId }
    });
  });

  it("returns an identical source record idempotently without writing again", async () => {
    const existing = readingRow({
      mileageKm: 145,
      orderId,
      recordedAt,
      sourceRecordId: "delivery-1",
      sourceType: VehicleMileageSourceType.DELIVERY_BASELINE
    });
    const harness = createHarness({ existing });

    await expect(
      harness.service.appendConfirmedReading(harness.transaction, {
        confirmedBy: actorId,
        mileageKm: 145,
        orderId,
        recordedAt,
        sourceRecordId: "delivery-1",
        sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
        vehicleId
      })
    ).resolves.toBe(existing);

    expect(harness.tx.vehicleMileageReading.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("rejects reuse of a source record with different business values", async () => {
    const harness = createHarness({
      existing: readingRow({
        mileageKm: 145,
        orderId,
        recordedAt,
        sourceRecordId: "delivery-1",
        sourceType: VehicleMileageSourceType.DELIVERY_BASELINE
      })
    });

    await expect(
      harness.service.appendConfirmedReading(harness.transaction, {
        confirmedBy: actorId,
        mileageKm: 146,
        orderId,
        recordedAt,
        sourceRecordId: "delivery-1",
        sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
        vehicleId
      })
    ).rejects.toThrow("同一来源单据已记录不同的车辆里程");
  });

  it("rejects mileage lower than the latest active reading", async () => {
    const harness = createHarness({ latest: readingRow({ mileageKm: 200 }) });

    await expect(
      harness.service.appendConfirmedReading(harness.transaction, {
        confirmedBy: actorId,
        mileageKm: 199,
        orderId,
        recordedAt,
        sourceRecordId: "review-1",
        sourceType: VehicleMileageSourceType.MONTHLY_REVIEW,
        vehicleId
      })
    ).rejects.toThrow("车辆里程不能小于上一条有效里程 200 km");

    expect(harness.tx.vehicleMileageReading.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
  });

  it("lists readings newest first", async () => {
    const rows = [readingRow({ mileageKm: 200 }), readingRow({ mileageKm: 100 })];
    const harness = createHarness({ rows });

    await expect(harness.service.listVehicleReadings(vehicleId)).resolves.toBe(rows);
    expect(harness.prisma.vehicleMileageReading.findMany).toHaveBeenCalledWith({
      include: {
        order: { select: { id: true, orderNo: true } }
      },
      orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
      where: { vehicleId }
    });
  });
});

function createHarness(options: {
  existing?: ReturnType<typeof readingRow> | null;
  latest?: ReturnType<typeof readingRow> | null;
  rows?: ReturnType<typeof readingRow>[];
} = {}) {
  const rows = options.rows ?? [];
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: vehicleId }]),
    vehicle: {
      findUnique: vi.fn(async () => ({ deletedAt: null, id: vehicleId })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        deletedAt: null,
        id: vehicleId,
        ...data
      }))
    },
    vehicleMileageReading: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        createdAt: new Date(),
        id: "reading-created",
        status: VehicleMileageReadingStatus.ACTIVE,
        updatedAt: new Date(),
        ...data
      })),
      findFirst: vi.fn(async () => options.latest ?? null),
      findUnique: vi.fn(async () => options.existing ?? null)
    }
  };
  const prisma = {
    vehicleMileageReading: {
      findMany: vi.fn(async () => rows)
    }
  };
  return {
    prisma,
    service: new VehicleMileageService(prisma as never),
    transaction: tx as unknown as Prisma.TransactionClient,
    tx
  };
}

function readingRow(overrides: Record<string, unknown> = {}) {
  return {
    confirmedAt: recordedAt,
    confirmedBy: actorId,
    createdAt: recordedAt,
    createdBy: actorId,
    deltaKm: 100,
    evidenceSnapshot: null,
    id: "reading-previous",
    mileageKm: 100,
    orderId: null,
    previousReadingId: null,
    recordedAt,
    sourceRecordId: "source-1",
    sourceType: VehicleMileageSourceType.LEGACY_MIGRATION,
    status: VehicleMileageReadingStatus.ACTIVE,
    updatedAt: recordedAt,
    updatedBy: actorId,
    vehicleId,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...overrides
  };
}
