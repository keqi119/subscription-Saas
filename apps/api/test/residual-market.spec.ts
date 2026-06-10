import {
  AuditAction,
  MarketPriceImportBatch,
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  Prisma,
  VehicleBatteryUsageType,
  VehicleMarketPriceObservation,
  VehicleResidualCurve,
  VehicleResidualCurveMethod,
  VehicleResidualCurvePoint,
  VehicleResidualCurveStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { parseCsv, parseCsvRecords } from "../src/residual-market/csv-parser";
import { calculateConfidenceScore, ResidualMarketService } from "../src/residual-market/residual-market.service";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  menus: [],
  name: "Tester",
  permissions: [],
  roles: [],
  username: "tester"
};

const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

describe("ResidualMarketService", () => {
  it("creates a manual market price observation and writes audit log", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.createObservation(validObservationDto(), user, context);

    expect(result.observationNo).toMatch(/^MPO\d{14}[A-Z0-9]{4}$/);
    expect(result.priceAmount).toBe(12800000);
    expect(result.confidenceScore).toBe(100);
    expect(harness.state.observations).toHaveLength(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_market_price_observation",
        module: "residual_market"
      })
    );
  });

  it("rejects priceAmount less than or equal to zero", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation({ ...validObservationDto(), priceAmount: 0 }, user, context)
    ).rejects.toThrow("priceAmount");
  });

  it("rejects missing observedAt", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation(
        { ...validObservationDto(), observedAt: undefined as unknown as string },
        user,
        context
      )
    ).rejects.toThrow("observedAt");
  });

  it("rejects missing brand", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation({ ...validObservationDto(), brand: "" }, user, context)
    ).rejects.toThrow("brand");
  });

  it("rejects missing model", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation({ ...validObservationDto(), model: "" }, user, context)
    ).rejects.toThrow("model");
  });

  it("rejects missing priceType", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation(
        { ...validObservationDto(), priceType: undefined as unknown as MarketPriceType },
        user,
        context
      )
    ).rejects.toThrow("priceType");
  });

  it("deduplicates active observations by dedupeKey", async () => {
    const existing = makeObservation({
      dedupeKey: `${MarketPriceSource.MANUAL}:listing-1`,
      sourceListingId: "LISTING-1"
    });
    const harness = createResidualMarketHarness({ observations: [existing] });

    await expect(
      harness.service.createObservation(
        { ...validObservationDto(), sourceListingId: " listing-1 " },
        user,
        context
      )
    ).rejects.toThrow("该市场价格样本已存在");
  });

  it("imports CSV, creates a batch, and converts yuan amounts to cents", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.importCsv(
      {
        csvText: [
          "observedAt,brand,model,priceType,priceAmount,city,mileageKm",
          "2026-06-01,NIO,ET5,LISTING,128000,上海,23000"
        ].join("\n"),
        fileName: "et5.csv",
        remark: "import",
        source: MarketPriceSource.CSV_IMPORT
      },
      user,
      context
    );

    expect(result.batch.batchNo).toMatch(/^MPB\d{14}[A-Z0-9]{4}$/);
    expect(result.totalRows).toBe(1);
    expect(result.importedRows).toBe(1);
    expect(result.batch.importStatus).toBe(MarketPriceImportStatus.COMPLETED);
    expect(harness.state.observations[0]?.priceAmount).toBe(12800000n);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "market_price_import_batch",
        module: "residual_market"
      })
    );
  });

  it("skips duplicate rows during CSV import", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.importCsv(
      {
        csvText: [
          "observedAt,brand,model,priceType,priceAmount,sourceListingId",
          "2026-06-01,NIO,ET5,LISTING,128000,L-1",
          "2026-06-01,NIO,ET5,LISTING,128000,L-1"
        ].join("\n"),
        source: MarketPriceSource.CSV_IMPORT
      },
      user,
      context
    );

    expect(result.importedRows).toBe(1);
    expect(result.skippedRows).toBe(1);
    expect(result.items[1]).toMatchObject({ action: "SKIPPED_DUPLICATE", rowNumber: 3 });
  });

  it("keeps importing when a CSV row fails", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.importCsv(
      {
        csvText: [
          "observedAt,brand,model,priceType,priceAmount",
          "2026-06-01,NIO,ET5,LISTING,128000",
          "2026-06-02,NIO,ET5,LISTING,0"
        ].join("\n"),
        source: MarketPriceSource.CSV_IMPORT
      },
      user,
      context
    );

    expect(result.importedRows).toBe(1);
    expect(result.failedRows).toBe(1);
    expect(result.batch.importStatus).toBe(MarketPriceImportStatus.PARTIAL_FAILED);
    expect(harness.state.batches[0]?.failedRows).toBe(1);
    expect(harness.state.batches[0]?.errorSnapshot).toMatchObject({
      failedItems: [expect.objectContaining({ rowNumber: 3 })]
    });
  });

  it("calculates confidenceScore with the documented first-version formula", () => {
    expect(
      calculateConfidenceScore({
        batteryCapacityKwh: new Prisma.Decimal(75),
        brand: "NIO",
        city: "上海",
        mileageKm: 23000,
        model: "ET5",
        observedAt: new Date("2026-06-01T00:00:00.000Z"),
        priceAmount: 12800000n,
        registrationDate: new Date("2024-06-01T00:00:00.000Z")
      })
    ).toBe(100);
  });

  it("filters observation list by brand and price type", async () => {
    const harness = createResidualMarketHarness({
      observations: [
        makeObservation({ brand: "NIO", id: "observation-nio", priceType: MarketPriceType.LISTING }),
        makeObservation({ brand: "Tesla", id: "observation-tesla", priceType: MarketPriceType.TRANSACTION })
      ]
    });

    const result = await harness.service.listObservations({
      brand: "nio",
      priceType: MarketPriceType.LISTING
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("observation-nio");
  });

  it("returns observation detail without BigInt serialization failures", async () => {
    const harness = createResidualMarketHarness({ observations: [makeObservation()] });

    const result = await harness.service.getObservation("observation-1");

    expect(result.priceAmount).toBe(12800000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("voids an active observation and writes audit log", async () => {
    const harness = createResidualMarketHarness({ observations: [makeObservation()] });

    const result = await harness.service.voidObservation(
      "observation-1",
      { remark: "duplicate" },
      user,
      context
    );

    expect(result.observationStatus).toBe(MarketPriceObservationStatus.VOIDED);
    expect(harness.state.observations[0]?.observationStatus).toBe(MarketPriceObservationStatus.VOIDED);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_market_price_observation"
      })
    );
  });

  it("rejects repeated void actions", async () => {
    const harness = createResidualMarketHarness({
      observations: [makeObservation({ observationStatus: MarketPriceObservationStatus.VOIDED })]
    });

    await expect(
      harness.service.voidObservation("observation-1", { remark: "again" }, user, context)
    ).rejects.toThrow("已作废");
  });

  it("lists import batches", async () => {
    const harness = createResidualMarketHarness({ batches: [makeBatch()] });

    const result = await harness.service.listImportBatches({});

    expect(result.total).toBe(1);
    expect(result.items[0]?.batchNo).toBe("MPB20260601000000A1B2");
  });

  it("returns import batch detail with observation count", async () => {
    const harness = createResidualMarketHarness({
      batches: [makeBatch()],
      observations: [makeObservation({ batchId: "batch-1" })]
    });

    const result = await harness.service.getImportBatch("batch-1");

    expect(result.observationCount).toBe(1);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("dry-runs residual curve generation without writing database rows", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 3,
        model: "ET5",
        referencePriceAmount: 20000000
      },
      user,
      context
    );

    expect(result.dryRun).toBe(true);
    expect(result.pointCount).toBe(1);
    expect(result.points[0]?.medianPriceAmount).toBe(12000000);
    expect(harness.state.curves).toHaveLength(0);
    expect(harness.state.points).toHaveLength(0);
  });

  it("formally generates a draft residual curve with points and audit log", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        minSamplePerPoint: 3,
        model: "ET5",
        referencePriceAmount: 20000000,
        remark: "generate"
      },
      user,
      context
    );

    expect(result.dryRun).toBe(false);
    expect(result.curve.curveNo).toMatch(/^RVC\d{14}[A-Z0-9]{4}$/);
    expect(result.curve.curveStatus).toBe(VehicleResidualCurveStatus.DRAFT);
    expect(harness.state.curves).toHaveLength(1);
    expect(harness.state.points).toHaveLength(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_residual_curve",
        module: "residual_market"
      })
    );
  });

  it("rejects residual curve generation when brand or model is missing", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.generateCurve({ brand: "", model: "ET5" }, user, context)
    ).rejects.toThrow("brand");
    await expect(
      harness.service.generateCurve({ brand: "NIO", model: "" }, user, context)
    ).rejects.toThrow("model");
  });

  it("uses only active market observations for residual curves", async () => {
    const harness = createResidualMarketHarness({
      observations: [
        ...makeCurveSamples([10000000n], { idPrefix: "active" }),
        ...makeCurveSamples([30000000n], {
          idPrefix: "voided",
          observationStatus: MarketPriceObservationStatus.VOIDED
        }),
        ...makeCurveSamples([40000000n], {
          idPrefix: "ignored",
          observationStatus: MarketPriceObservationStatus.IGNORED
        })
      ]
    });

    const result = await harness.service.generateCurve(
      { brand: "NIO", dryRun: true, minSamplePerPoint: 1, model: "ET5" },
      user,
      context
    );

    expect(result.sampleCount).toBe(1);
    expect(result.points[0]?.medianPriceAmount).toBe(10000000);
  });

  it("derives ageMonth from registrationDate and skips samples without age", async () => {
    const harness = createResidualMarketHarness({
      observations: [
        makeObservation({
          dedupeKey: "age-derived",
          id: "age-derived",
          priceAmount: 10000000n,
          registrationDate: new Date("2024-06-01T00:00:00.000Z"),
          vehicleAgeMonths: null
        }),
        makeObservation({
          dedupeKey: "age-missing",
          id: "age-missing",
          priceAmount: 12000000n,
          registrationDate: null,
          vehicleAgeMonths: null
        })
      ]
    });

    const result = await harness.service.generateCurve(
      { brand: "NIO", dryRun: true, minSamplePerPoint: 1, model: "ET5" },
      user,
      context
    );

    expect(result.points[0]?.ageMonth).toBe(24);
    expect(result.skippedSampleCount).toBe(1);
    expect(result.skippedReasons).toEqual([expect.objectContaining({ reason: "AGE_MONTH_MISSING" })]);
  });

  it("enforces minSamplePerPoint and reports insufficient samples", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n])
    });

    await expect(
      harness.service.generateCurve(
        { brand: "NIO", dryRun: true, minSamplePerPoint: 3, model: "ET5" },
        user,
        context
      )
    ).rejects.toThrow("符合条件的样本不足");
  });

  it("calculates curve statistics, residual rate, and confidence score", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 18000000n, 20000000n], {
        confidenceScores: [100, 80, 60, 50]
      })
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 4,
        model: "ET5",
        referencePriceAmount: 20000000
      },
      user,
      context
    );
    const point = result.points[0];

    expect(point?.medianPriceAmount).toBe(15000000);
    expect(point?.p25PriceAmount).toBe(11500000);
    expect(point?.p75PriceAmount).toBe(18500000);
    expect(point?.averagePriceAmount).toBe(15000000);
    expect(point?.predictedResidualRateBps).toBe(7500);
    expect(point?.confidenceScore).toBe(64);
    expect(result.curve.confidenceScore).toBe(64);
  });

  it("leaves residualRateBps null when referencePriceAmount is not provided", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    const result = await harness.service.generateCurve(
      { brand: "NIO", dryRun: true, minSamplePerPoint: 3, model: "ET5" },
      user,
      context
    );

    expect(result.points[0]?.predictedResidualRateBps).toBeNull();
  });

  it("lists residual curves with filters", async () => {
    const harness = createResidualMarketHarness({
      curves: [
        makeCurve({ brand: "NIO", curveStatus: VehicleResidualCurveStatus.ACTIVE, id: "curve-nio" }),
        makeCurve({ brand: "Tesla", curveStatus: VehicleResidualCurveStatus.DRAFT, id: "curve-tesla" })
      ]
    });

    const result = await harness.service.listCurves({
      brand: "nio",
      curveStatus: VehicleResidualCurveStatus.ACTIVE
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("curve-nio");
  });

  it("returns residual curve detail with points and JSON-safe amounts", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ id: "curve-1" })],
      points: [makeCurvePoint({ curveId: "curve-1" })]
    });

    const result = await harness.service.getCurve("curve-1");

    expect(result.points).toHaveLength(1);
    expect(result.points?.[0]?.medianPriceAmount).toBe(12000000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("activates a curve and supersedes old active curves with the same dimension", async () => {
    const harness = createResidualMarketHarness({
      curves: [
        makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE, id: "curve-old" }),
        makeCurve({ curveNo: "RVC20260602000000A1B2", curveStatus: VehicleResidualCurveStatus.DRAFT, id: "curve-new" })
      ]
    });

    const result = await harness.service.activateCurve(
      "curve-new",
      { effectiveFrom: "2026-07-01", remark: "activate" },
      user,
      context
    );

    expect(result.curveStatus).toBe(VehicleResidualCurveStatus.ACTIVE);
    expect(result.effectiveFrom).toBe("2026-07-01");
    expect(harness.state.curves.find((curve) => curve.id === "curve-old")?.curveStatus).toBe(
      VehicleResidualCurveStatus.SUPERSEDED
    );
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_residual_curve"
      })
    );
  });

  it("archives a residual curve and rejects repeated archive actions", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })]
    });

    const result = await harness.service.archiveCurve("curve-1", { remark: "archive" }, user, context);

    expect(result.curveStatus).toBe(VehicleResidualCurveStatus.ARCHIVED);
    expect(harness.state.curves[0]?.effectiveTo).toBeInstanceOf(Date);
    await expect(
      harness.service.archiveCurve("curve-1", { remark: "again" }, user, context)
    ).rejects.toThrow("已归档");
  });
});

describe("residual market CSV parser", () => {
  it("supports UTF-8 BOM", () => {
    const records = parseCsvRecords("\uFEFFobservedAt,brand\n2026-06-01,NIO");
    expect(records[0]?.values.brand).toBe("NIO");
  });

  it("supports comma fields", () => {
    expect(parseCsv('name,remark\n"ET5, 75kWh",ok')[1]?.[0]).toBe("ET5, 75kWh");
  });

  it("supports quoted fields", () => {
    expect(parseCsv('name\n"ET5 ""Touring"""')[1]?.[0]).toBe('ET5 "Touring"');
  });

  it("supports newline fields", () => {
    expect(parseCsv('name,remark\nET5,"line1\nline2"')[1]?.[1]).toBe("line1\nline2");
  });

  it("supports empty values", () => {
    expect(parseCsv("a,b,c\n1,,3")[1]).toEqual(["1", "", "3"]);
  });
});

function validObservationDto() {
  return {
    batteryCapacityKwh: 75,
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    city: "上海",
    mileageKm: 23000,
    model: "ET5",
    observedAt: "2026-06-01",
    priceAmount: 12800000,
    priceType: MarketPriceType.LISTING,
    registrationDate: "2024-06-01",
    source: MarketPriceSource.MANUAL,
    sourceListingId: "LISTING-1"
  };
}

function createResidualMarketHarness(seed: Partial<ResidualMarketState> = {}) {
  const state: ResidualMarketState = {
    batches: [...(seed.batches ?? [])],
    curves: [...(seed.curves ?? [])],
    observations: [...(seed.observations ?? [])],
    points: [...(seed.points ?? [])]
  };
  const auditService = { write: vi.fn().mockResolvedValue(undefined) };
  const prisma = createResidualMarketPrisma(state);
  const service = new ResidualMarketService(auditService as never, prisma as never);

  return { auditService, service, state };
}

type ResidualMarketState = {
  batches: MarketPriceImportBatch[];
  curves: VehicleResidualCurve[];
  observations: VehicleMarketPriceObservation[];
  points: VehicleResidualCurvePoint[];
};

function createResidualMarketPrisma(state: ResidualMarketState) {
  const prisma = {
    marketPriceImportBatch: {
      count: vi.fn(({ where }) => Promise.resolve(state.batches.filter((batch) => matchesBatchWhere(batch, where)).length)),
      create: vi.fn(({ data }) => {
        const batch = makeBatch({
          ...data,
          errorSnapshot: null,
          id: `batch-${state.batches.length + 1}`,
          snapshot: data.snapshot ?? null
        });
        state.batches.push(batch);
        return Promise.resolve(batch);
      }),
      findFirst: vi.fn(({ where }) => Promise.resolve(state.batches.find((batch) => matchesBatchWhere(batch, where)) ?? null)),
      findMany: vi.fn(({ skip = 0, take = 20, where }) =>
        Promise.resolve(state.batches.filter((batch) => matchesBatchWhere(batch, where)).slice(skip, skip + take))
      ),
      update: vi.fn(({ data, where }) => {
        const index = state.batches.findIndex((batch) => batch.id === where.id);
        const before = state.batches[index];
        if (!before) {
          throw new Error("Batch not found.");
        }
        const updated = {
          ...before,
          ...data,
          errorSnapshot: data.errorSnapshot === Prisma.JsonNull ? null : data.errorSnapshot,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
        state.batches[index] = updated;
        return Promise.resolve(updated);
      })
    },
    vehicleMarketPriceObservation: {
      count: vi.fn(({ where }) =>
        Promise.resolve(state.observations.filter((observation) => matchesObservationWhere(observation, where)).length)
      ),
      create: vi.fn(({ data }) => {
        if (
          state.observations.some(
            (observation) =>
              observation.dedupeKey === data.dedupeKey &&
              observation.deletedAt === null &&
              observation.observationStatus === MarketPriceObservationStatus.ACTIVE
          )
        ) {
          return Promise.reject({ code: "P2002" });
        }
        const observation = makeObservation({
          ...data,
          id: `observation-${state.observations.length + 1}`
        });
        state.observations.push(observation);
        return Promise.resolve(observation);
      }),
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(state.observations.find((observation) => matchesObservationWhere(observation, where)) ?? null)
      ),
      findMany: vi.fn(({ skip = 0, take = 20, where }) =>
        Promise.resolve(
          state.observations.filter((observation) => matchesObservationWhere(observation, where)).slice(skip, skip + take)
        )
      ),
      update: vi.fn(({ data, where }) => {
        const index = state.observations.findIndex((observation) => observation.id === where.id);
        const before = state.observations[index];
        if (!before) {
          throw new Error("Observation not found.");
        }
        const updated = {
          ...before,
          ...data,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
          state.observations[index] = updated;
          return Promise.resolve(updated);
        })
    },
    vehicleResidualCurve: {
      count: vi.fn(({ where }) =>
        Promise.resolve(state.curves.filter((curve) => matchesCurveWhere(curve, where)).length)
      ),
      create: vi.fn(({ data, include }) => {
        const { points, ...curveData } = data;
        const curve = makeCurve({
          ...curveData,
          id: `curve-${state.curves.length + 1}`
        });
        const createdPoints = (points?.create ?? []).map((point: Partial<VehicleResidualCurvePoint>, index: number) =>
          makeCurvePoint({
            ...point,
            curveId: curve.id,
            id: `curve-point-${state.points.length + index + 1}`
          })
        );
        state.curves.push(curve);
        state.points.push(...createdPoints);
        return Promise.resolve(attachCurveInclude(curve, include, state));
      }),
      findFirst: vi.fn(({ include, where }) =>
        Promise.resolve(
          attachCurveInclude(
            state.curves.find((curve) => matchesCurveWhere(curve, where)) ?? null,
            include,
            state
          )
        )
      ),
      findMany: vi.fn(({ skip = 0, take = 20, where }) =>
        Promise.resolve(state.curves.filter((curve) => matchesCurveWhere(curve, where)).slice(skip, skip + take))
      ),
      update: vi.fn(({ data, include, where }) => {
        const index = state.curves.findIndex((curve) => curve.id === where.id);
        const before = state.curves[index];
        if (!before) {
          throw new Error("Curve not found.");
        }
        const updated = {
          ...before,
          ...data,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
        state.curves[index] = updated;
        return Promise.resolve(attachCurveInclude(updated, include, state));
      }),
      updateMany: vi.fn(({ data, where }) => {
        let count = 0;
        state.curves = state.curves.map((curve) => {
          if (!matchesCurveWhere(curve, where)) {
            return curve;
          }
          count += 1;
          return {
            ...curve,
            ...data,
            updatedAt: new Date("2026-06-01T00:10:00.000Z")
          };
        });
        return Promise.resolve({ count });
      })
    }
  };

  return {
    ...prisma,
    $transaction: vi.fn((callback) => callback(prisma))
  };
}

function matchesObservationWhere(observation: VehicleMarketPriceObservation, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && observation.id !== where.id) {
    return false;
  }
  if (where.batchId !== undefined && observation.batchId !== where.batchId) {
    return false;
  }
  if (where.deletedAt === null && observation.deletedAt !== null) {
    return false;
  }
  if (where.dedupeKey !== undefined && observation.dedupeKey !== where.dedupeKey) {
    return false;
  }
  if (where.observationStatus !== undefined && observation.observationStatus !== where.observationStatus) {
    return false;
  }
  if (where.source !== undefined && observation.source !== where.source) {
    return false;
  }
  if (!matchesEnumFilter(observation.priceType, where.priceType)) {
    return false;
  }
  if (where.modelYear !== undefined && observation.modelYear !== where.modelYear) {
    return false;
  }
  if (where.batteryUsageType !== undefined && observation.batteryUsageType !== where.batteryUsageType) {
    return false;
  }
  if (!matchesDecimal(observation.batteryCapacityKwh, where.batteryCapacityKwh)) {
    return false;
  }
  if (!matchesTextFilter(observation.brand, where.brand) || !matchesTextFilter(observation.model, where.model)) {
    return false;
  }
  if (!matchesTextFilter(observation.series, where.series) || !matchesTextFilter(observation.city, where.city)) {
    return false;
  }
  if (!matchesTextFilter(observation.trim, where.trim)) {
    return false;
  }
  if (!matchesRange(observation.mileageKm, where.mileageKm as RangeFilter<number> | undefined)) {
    return false;
  }
  if (!matchesRange(observation.priceAmount, where.priceAmount as RangeFilter<bigint> | undefined)) {
    return false;
  }
  return matchesRange(observation.observedAt, where.observedAt as RangeFilter<Date> | undefined);
}

function matchesBatchWhere(batch: MarketPriceImportBatch, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && batch.id !== where.id) {
    return false;
  }
  if (where.deletedAt === null && batch.deletedAt !== null) {
    return false;
  }
  if (where.source !== undefined && batch.source !== where.source) {
    return false;
  }
  if (where.importStatus !== undefined && batch.importStatus !== where.importStatus) {
    return false;
  }
  return matchesRange(batch.createdAt, where.createdAt as RangeFilter<Date> | undefined);
}

function matchesCurveWhere(curve: VehicleResidualCurve, where: Record<string, unknown> = {}) {
  if (where.id !== undefined) {
    if (typeof where.id === "object" && where.id !== null && "not" in where.id) {
      if (curve.id === (where.id as { not: unknown }).not) {
        return false;
      }
    } else if (curve.id !== where.id) {
      return false;
    }
  }
  if (where.deletedAt === null && curve.deletedAt !== null) {
    return false;
  }
  if (where.curveStatus !== undefined && curve.curveStatus !== where.curveStatus) {
    return false;
  }
  if (where.curveMethod !== undefined && curve.curveMethod !== where.curveMethod) {
    return false;
  }
  if (where.modelYear !== undefined && curve.modelYear !== where.modelYear) {
    return false;
  }
  if (where.batteryUsageType !== undefined && curve.batteryUsageType !== where.batteryUsageType) {
    return false;
  }
  if (!matchesDecimal(curve.batteryCapacityKwh, where.batteryCapacityKwh)) {
    return false;
  }
  if (!matchesTextFilter(curve.brand, where.brand) || !matchesTextFilter(curve.model, where.model)) {
    return false;
  }
  if (!matchesTextFilter(curve.series, where.series) || !matchesTextFilter(curve.trim, where.trim)) {
    return false;
  }
  return true;
}

type RangeFilter<T> = {
  gte?: T;
  lte?: T;
};

function matchesTextFilter(value: string | null, filter: unknown) {
  if (filter === undefined) {
    return true;
  }
  if (filter === null) {
    return value === null;
  }
  if (typeof filter === "string") {
    return value === filter;
  }
  if (!filter || typeof filter !== "object") {
    return true;
  }
  if ("contains" in filter) {
    const contains = String((filter as { contains: unknown }).contains).toLowerCase();
    return (value ?? "").toLowerCase().includes(contains);
  }
  if ("equals" in filter) {
    const equals = String((filter as { equals: unknown }).equals).toLowerCase();
    return (value ?? "").toLowerCase() === equals;
  }
  return true;
}

function matchesEnumFilter(value: string, filter: unknown) {
  if (filter === undefined) {
    return true;
  }
  if (typeof filter === "object" && filter !== null && "in" in filter) {
    return ((filter as { in: unknown[] }).in ?? []).includes(value);
  }
  return value === filter;
}

function matchesDecimal(value: Prisma.Decimal | null, filter: unknown) {
  if (filter === undefined) {
    return true;
  }
  if (filter === null) {
    return value === null;
  }
  if (value === null) {
    return false;
  }
  return value.toString() === new Prisma.Decimal(filter as Prisma.Decimal.Value).toString();
}

function matchesRange<T extends bigint | Date | number>(value: T | null, filter?: RangeFilter<T>) {
  if (!filter) {
    return true;
  }
  if (value === null) {
    return false;
  }
  if (filter.gte !== undefined && value < filter.gte) {
    return false;
  }
  return !(filter.lte !== undefined && value > filter.lte);
}

function attachCurveInclude(
  curve: VehicleResidualCurve | null,
  include: { points?: unknown } | undefined,
  state: ResidualMarketState
) {
  if (!curve) {
    return null;
  }
  if (!include?.points) {
    return curve;
  }

  return {
    ...curve,
    points: state.points
      .filter((point) => point.curveId === curve.id)
      .sort((left, right) => left.ageMonth - right.ageMonth)
  };
}

function makeCurveSamples(
  prices: bigint[],
  options: {
    confidenceScores?: number[];
    idPrefix?: string;
    observationStatus?: MarketPriceObservationStatus;
  } = {}
) {
  const idPrefix = options.idPrefix ?? "curve-sample";

  return prices.map((priceAmount, index) =>
    makeObservation({
      confidenceScore: options.confidenceScores?.[index] ?? 100,
      dedupeKey: `${idPrefix}-${index + 1}`,
      id: `${idPrefix}-${index + 1}`,
      mileageKm: 20000 + index * 1000,
      observationNo: `MPO2026060100000${index}A1B2`,
      observationStatus: options.observationStatus ?? MarketPriceObservationStatus.ACTIVE,
      priceAmount,
      priceType: MarketPriceType.TRANSACTION,
      sourceListingId: `${idPrefix}-${index + 1}`,
      vehicleAgeMonths: 24
    })
  );
}

function makeCurve(overrides: Partial<VehicleResidualCurve> = {}): VehicleResidualCurve {
  return {
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    confidenceScore: 80,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN,
    curveName: "NIO ET5 2024 75 BUYOUT",
    curveNo: "RVC20260601000000A1B2",
    curveStatus: VehicleResidualCurveStatus.DRAFT,
    curveVersion: null,
    deletedAt: null,
    effectiveFrom: null,
    effectiveTo: null,
    generatedAt: new Date("2026-06-01T00:00:00.000Z"),
    id: "curve-1",
    metrics: null,
    model: "ET5",
    modelYear: 2024,
    pointCount: 1,
    priceTypes: [MarketPriceType.TRANSACTION],
    referencePriceAmount: 20000000n,
    remark: null,
    sampleCount: 3,
    sampleEndDate: null,
    sampleFilterSnapshot: null,
    sampleStartDate: null,
    series: "ET5",
    snapshot: null,
    trim: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    ...overrides
  };
}

function makeCurvePoint(overrides: Partial<VehicleResidualCurvePoint> = {}): VehicleResidualCurvePoint {
  return {
    ageMonth: 24,
    averagePriceAmount: 12000000n,
    confidenceScore: 80,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    curveId: "curve-1",
    id: "curve-point-1",
    lowerBoundAmount: 11000000n,
    maxPriceAmount: 14000000n,
    medianPriceAmount: 12000000n,
    mileageBucketEndKm: null,
    mileageBucketStartKm: null,
    minPriceAmount: 10000000n,
    p25PriceAmount: 11000000n,
    p75PriceAmount: 13000000n,
    pointSnapshot: null,
    predictedResidualAmount: 12000000n,
    predictedResidualRateBps: 6000,
    sampleCount: 3,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    upperBoundAmount: 13000000n,
    ...overrides
  };
}

function makeObservation(
  overrides: Partial<VehicleMarketPriceObservation> = {}
): VehicleMarketPriceObservation {
  const observedAt = new Date("2026-06-01T00:00:00.000Z");
  return {
    accidentFlag: null,
    batchId: null,
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryHealthPercent: null,
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    city: "上海",
    conditionGrade: null,
    confidenceScore: 100,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    dedupeKey: `${MarketPriceSource.MANUAL}:listing-1`,
    deletedAt: null,
    id: "observation-1",
    listingDays: null,
    listingPriceAmount: null,
    mileageKm: 23000,
    model: "ET5",
    modelYear: 2024,
    observationNo: "MPO20260601000000A1B2",
    observationStatus: MarketPriceObservationStatus.ACTIVE,
    observedAt,
    priceAmount: 12800000n,
    priceType: MarketPriceType.LISTING,
    province: "上海",
    rawSnapshot: null,
    registrationDate: new Date("2024-06-01T00:00:00.000Z"),
    remark: null,
    sellerType: null,
    series: "ET5",
    source: MarketPriceSource.MANUAL,
    sourceListingId: "LISTING-1",
    sourceUrlHash: null,
    transactionPriceAmount: null,
    trim: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    vehicleAgeMonths: null,
    ...overrides
  };
}

function makeBatch(overrides: Partial<MarketPriceImportBatch> = {}): MarketPriceImportBatch {
  return {
    batchNo: "MPB20260601000000A1B2",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    deletedAt: null,
    errorSnapshot: null,
    failedRows: 0,
    fileName: "et5.csv",
    id: "batch-1",
    importedBy: user.id,
    importedRows: 1,
    importStatus: MarketPriceImportStatus.COMPLETED,
    remark: null,
    skippedRows: 0,
    snapshot: null,
    source: MarketPriceSource.CSV_IMPORT,
    totalRows: 1,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides
  };
}
