import { Prisma, VehicleMileageReadingStatus, VehicleMileageSourceType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { VehicleMileageRepository } from "../src/vehicle-mileage/vehicle-mileage.repository";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";

const vehicleId = "00000000-0000-4000-8000-000000000101";
const orderId = "00000000-0000-4000-8000-000000000201";
const actorId = "00000000-0000-4000-8000-000000000301";
const recordedAt = new Date("2026-08-02T04:00:00.000Z");

describe("VehicleMileageService", () => {
  it("fails closed for forged, wrong-transaction, retargeted, and reused source capabilities", async () => {
    const repository = new VehicleMileageRepository();
    const owner = createHarness();
    const foreign = createHarness();
    const source = {
      id: "00000000-0000-4000-8000-000000000401",
      key: "physical-mileage:VOLUNTARY_RETURN",
      type: "SUBSCRIPTION_CLOSURE"
    };

    expect(() =>
      repository.attestCallerOwnedCommand(owner.transaction, source, Object.freeze({}) as never)
    ).toThrow("The caller-owned vehicle-mileage capability is invalid.");

    const wrongTransaction = await repository.prepareCallerOwnedCommand(owner.transaction, source);
    expect(() =>
      repository.attestCallerOwnedCommand(foreign.transaction, source, wrongTransaction)
    ).toThrow("The caller-owned vehicle-mileage capability is invalid.");
    expect(() =>
      repository.attestCallerOwnedCommand(owner.transaction, source, wrongTransaction)
    ).toThrow("The caller-owned vehicle-mileage capability is invalid.");

    const retargeted = await repository.prepareCallerOwnedCommand(owner.transaction, source);
    expect(() =>
      repository.attestCallerOwnedCommand(
        owner.transaction,
        { ...source, key: "physical-mileage:RECOVERY" },
        retargeted
      )
    ).toThrow("The caller-owned vehicle-mileage capability is invalid.");

    const consumed = await repository.prepareCallerOwnedCommand(owner.transaction, source);
    expect(() =>
      repository.attestCallerOwnedCommand(owner.transaction, source, consumed)
    ).not.toThrow();
    expect(() => repository.attestCallerOwnedCommand(owner.transaction, source, consumed)).toThrow(
      "The caller-owned vehicle-mileage capability is invalid."
    );
  });

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

  it("consumes a coordinator-bound prepared append once without relocking the vehicle", async () => {
    const previous = readingRow({ mileageKm: 100, sourceRecordId: "previous" });
    const harness = createHarness({ latest: previous });
    const coordinator = new SubscriptionClosureRepository();
    const source = {
      id: "00000000-0000-4000-8000-000000000401",
      key: "physical-mileage:VOLUNTARY_RETURN",
      type: "SUBSCRIPTION_CLOSURE"
    };
    const command = {
      confirmedBy: actorId,
      evidenceSnapshot: { closureCaseId: source.id },
      mileageKm: 145,
      orderId,
      recordedAt,
      source,
      sourceRecordId: "00000000-0000-4000-8000-000000000501",
      sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
      vehicleId
    };

    const sourceCapability = await harness.service.prepareCallerOwnedTransaction(
      harness.transaction,
      source
    );
    const session = coordinator.createAuthoritySessionInTransaction(harness.transaction);
    const requirement = harness.service.appendAuthorityRequirement(
      session,
      command,
      "physical-mileage"
    );
    const proofs = await coordinator.prepareAuthorityInTransaction(
      harness.transaction,
      session,
      requirement.locks,
      [requirement]
    );
    const prepared = await harness.service.attestPreparedAppendInTransaction(
      harness.transaction,
      session,
      command,
      sourceCapability,
      proofs.get("physical-mileage")!,
      "physical-mileage"
    );
    const queryCount = harness.tx.$queryRaw.mock.calls.length;

    await expect(
      harness.service.appendPreparedReadingInTransaction(harness.transaction, prepared)
    ).resolves.toMatchObject({ mileageKm: 145, previousReadingId: previous.id });
    expect(harness.tx.$queryRaw).toHaveBeenCalledTimes(queryCount);
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: {
        currentMileageKm: 145,
        salePriceReinitRequiredAt: expect.any(Date),
        updatedBy: actorId
      },
      where: { id: vehicleId }
    });
    await expect(
      harness.service.appendPreparedReadingInTransaction(harness.transaction, prepared)
    ).rejects.toMatchObject({ response: { code: "VEHICLE_MILEAGE_CAPABILITY_INVALID" } });
  });

  it("rejects an identical prepared source replay when its persisted reading is inactive", async () => {
    const sourceRecordId = "00000000-0000-4000-8000-000000000502";
    const harness = createHarness({
      existing: readingRow({
        evidenceSnapshot: { closureCaseId: "00000000-0000-4000-8000-000000000402" },
        mileageKm: 145,
        orderId,
        recordedAt,
        sourceRecordId,
        sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
        status: VehicleMileageReadingStatus.VOIDED,
        vehicleId
      })
    });
    const coordinator = new SubscriptionClosureRepository();
    const source = {
      id: "00000000-0000-4000-8000-000000000402",
      key: "physical-mileage:RECOVERY",
      type: "SUBSCRIPTION_CLOSURE"
    };
    const command = {
      confirmedBy: actorId,
      evidenceSnapshot: { closureCaseId: source.id },
      mileageKm: 145,
      orderId,
      recordedAt,
      source,
      sourceRecordId,
      sourceType: VehicleMileageSourceType.RETURN_CONFIRMATION,
      vehicleId
    };
    const sourceCapability = await harness.service.prepareCallerOwnedTransaction(
      harness.transaction,
      source
    );
    const session = coordinator.createAuthoritySessionInTransaction(harness.transaction);
    const requirement = harness.service.appendAuthorityRequirement(
      session,
      command,
      "physical-mileage"
    );
    const proofs = await coordinator.prepareAuthorityInTransaction(
      harness.transaction,
      session,
      requirement.locks,
      [requirement]
    );
    const prepared = await harness.service.attestPreparedAppendInTransaction(
      harness.transaction,
      session,
      command,
      sourceCapability,
      proofs.get("physical-mileage")!,
      "physical-mileage"
    );

    await expect(
      harness.service.appendPreparedReadingInTransaction(harness.transaction, prepared)
    ).rejects.toThrow("同一来源单据的车辆里程记录已失效");
    expect(harness.tx.vehicleMileageReading.create).not.toHaveBeenCalled();
    expect(harness.tx.vehicle.update).not.toHaveBeenCalled();
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

  it("rejects an identical public source replay when its persisted reading is inactive", async () => {
    const existing = readingRow({
      mileageKm: 145,
      orderId,
      recordedAt,
      sourceRecordId: "delivery-inactive",
      sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
      status: VehicleMileageReadingStatus.VOIDED
    });
    const harness = createHarness({ existing });

    await expect(
      harness.service.appendConfirmedReading(harness.transaction, {
        confirmedBy: actorId,
        mileageKm: 145,
        orderId,
        recordedAt,
        sourceRecordId: "delivery-inactive",
        sourceType: VehicleMileageSourceType.DELIVERY_BASELINE,
        vehicleId
      })
    ).rejects.toThrow("同一来源单据的车辆里程记录已失效");
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

  it("voids only the latest reading and restores the preceding vehicle projection", async () => {
    const current = readingRow({ id: "reading-current", mileageKm: 300 });
    const previous = readingRow({ id: "reading-previous", mileageKm: 200 });
    const harness = createHarness({
      findFirstRows: [current, current, previous]
    });
    const voidedAt = new Date("2026-10-01T01:00:00.000Z");

    await expect(
      harness.service.voidReadingAndRestoreProjection(harness.transaction, {
        actorId,
        readingId: current.id,
        reason: "wrong reading",
        vehicleId,
        voidedAt
      })
    ).resolves.toBe(previous);

    expect(harness.tx.vehicleMileageReading.update).toHaveBeenCalledWith({
      data: {
        status: VehicleMileageReadingStatus.VOIDED,
        updatedBy: actorId,
        voidedAt,
        voidedBy: actorId,
        voidReason: "wrong reading"
      },
      where: { id: current.id }
    });
    expect(harness.tx.vehicle.update).toHaveBeenCalledWith({
      data: {
        currentMileageKm: 200,
        salePriceReinitRequiredAt: voidedAt,
        updatedBy: actorId
      },
      where: { id: vehicleId }
    });
  });
});

function createHarness(
  options: {
    existing?: ReturnType<typeof readingRow> | null;
    findFirstRows?: ReturnType<typeof readingRow>[];
    latest?: ReturnType<typeof readingRow> | null;
    rows?: ReturnType<typeof readingRow>[];
  } = {}
) {
  const rows = options.rows ?? [];
  const tx = {
    $queryRaw: vi.fn(
      async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const sql = query.strings?.join("?") ?? "";
        if (sql.includes("transaction_isolation")) {
          return [{ isolationLevel: "read committed", transactionId: "vehicle-mileage-tx" }];
        }
        if (sql.includes("txid_current")) {
          return [{ transactionId: "vehicle-mileage-tx" }];
        }
        if (sql.includes('AS "authorityTable"')) {
          const rows: Array<{ authorityTable: string; requestedId: string }> = [];
          for (let index = 0; index < (query.values?.length ?? 0); index += 2) {
            rows.push({
              authorityTable: String(query.values![index]),
              requestedId: String(query.values![index + 1])
            });
          }
          return rows;
        }
        return [{ id: vehicleId }];
      }
    ),
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
      findFirst: options.findFirstRows
        ? vi
            .fn()
            .mockResolvedValueOnce(options.findFirstRows[0] ?? null)
            .mockResolvedValueOnce(options.findFirstRows[1] ?? null)
            .mockResolvedValueOnce(options.findFirstRows[2] ?? null)
        : vi.fn(async () => options.latest ?? null),
      update: vi.fn(),
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
    service: new VehicleMileageService(prisma as never, new VehicleMileageRepository()),
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
