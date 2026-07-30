import {
  AuditAction,
  MarketPriceImportBatch,
  MarketPriceImportStatus,
  MarketPriceObservationStatus,
  MarketPriceSource,
  MarketPriceType,
  Prisma,
  ResidualForecastInterpolationMethod,
  ResidualModelAlgorithm,
  ResidualModelRun,
  ResidualModelRunOutput,
  ResidualModelRunOutputStatus,
  ResidualModelRunOutputType,
  ResidualModelRunStatus,
  ResidualModelRunType,
  ResidualModelTargetType,
  SalePriceStatus,
  Vehicle,
  VehicleAcquisitionMode,
  VehicleBatteryUsageType,
  VehicleMarketPriceObservation,
  VehicleModelDefinition,
  VehicleResidualCurve,
  VehicleResidualCurveMethod,
  VehicleResidualCurvePoint,
  VehicleResidualCurveStatus,
  VehicleResidualForecast,
  VehicleResidualForecastMethod,
  VehicleResidualForecastPoint,
  VehicleResidualForecastPointStatus,
  VehicleResidualForecastStatus,
  VehicleSalePriceHistory,
  VehicleStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { VehicleModel } from "./helpers/vehicle-model-codes";

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

const modelRunManager = {
  ...user,
  permissions: ["residual_model_run:manage"]
};

const context = { ipAddress: "127.0.0.1", userAgent: "vitest" };

describe("ResidualMarketService", () => {
  it("creates a manual market price observation and writes audit log", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.createObservation(validObservationDto(), user, context);

    expect(result.observationNo).toMatch(/^MPO\d{14}[A-Z0-9]{4}$/);
    expect(result.modelDefinitionId).toBe(makeModelDefinition().id);
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

  it("binds market price observations to vehicle model definitions", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({ modelDefinitions: [definition] });

    const result = await harness.service.createObservation(
      { ...validObservationDto(), modelDefinitionId: definition.id },
      user,
      context
    );

    expect(result.modelDefinitionId).toBe(definition.id);
    expect(result.modelDefinition?.modelCode).toBe("ET5");
    expect(result.modelDisplayName).toBe("NIO ET5");

    const list = await harness.service.listObservations({ modelDefinitionId: definition.id });

    expect(list.total).toBe(1);
    expect(list.items[0]?.modelDefinition?.id).toBe(definition.id);
  });

  it("creates market price observations from modelDefinitionId without legacy brand and model input", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({ modelDefinitions: [definition] });

    const result = await harness.service.createObservation(
      {
        ...validObservationDto(),
        brand: undefined,
        model: undefined,
        modelDefinitionId: definition.id
      },
      user,
      context
    );

    expect(result).toMatchObject({
      brand: definition.brand,
      model: definition.modelName,
      modelDefinitionId: definition.id,
      series: definition.series
    });
  });

  it("rejects legacy-only market price observations even when legacy fields could resolve", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createObservation(
        { ...validObservationDto(), modelDefinitionId: undefined },
        user,
        context
      )
    ).rejects.toThrow("modelDefinitionId");
    expect(harness.state.observations).toHaveLength(0);
  });

  it("does not auto-resolve legacy market price observations from duplicate model definitions", async () => {
    const harness = createResidualMarketHarness({
      modelDefinitions: [
        makeModelDefinition({ id: "00000000-0000-4000-8000-000000000e51", modelCode: "ET5-A" }),
        makeModelDefinition({ id: "00000000-0000-4000-8000-000000000e52", modelCode: "ET5-B" })
      ]
    });

    await expect(
      harness.service.createObservation(
        { ...validObservationDto(), modelDefinitionId: undefined },
        user,
        context
      )
    ).rejects.toThrow("modelDefinitionId");
    expect(harness.state.observations).toHaveLength(0);
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

  it("derives residual legacy fields from modelDefinitionId when legacy inputs are blank", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.createObservation(
      { ...validObservationDto(), brand: "", model: "" },
      user,
      context
    );

    expect(result.brand).toBe(makeModelDefinition().brand);
    expect(result.model).toBe(makeModelDefinition().modelName);
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
          "observedAt,modelDefinitionId,brand,model,priceType,priceAmount,city,mileageKm",
          `2026-06-01,${makeModelDefinition().id},NIO,ET5,LISTING,128000,Shanghai,23000`
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
    expect(harness.state.observations[0]?.modelDefinitionId).toBe(makeModelDefinition().id);
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
          "observedAt,modelDefinitionId,brand,model,priceType,priceAmount,sourceListingId",
          `2026-06-01,${makeModelDefinition().id},NIO,ET5,LISTING,128000,L-1`,
          `2026-06-01,${makeModelDefinition().id},NIO,ET5,LISTING,128000,L-1`
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
          "observedAt,modelDefinitionId,brand,model,priceType,priceAmount",
          `2026-06-01,${makeModelDefinition().id},NIO,ET5,LISTING,128000`,
          `2026-06-02,${makeModelDefinition().id},NIO,ET5,LISTING,0`
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

  it("imports CSV rows with modelDefinitionId even when legacy brand and model are blank", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({ modelDefinitions: [definition] });

    const result = await harness.service.importCsv(
      {
        csvText: [
          "observedAt,modelDefinitionId,brand,model,priceType,priceAmount",
          `2026-06-01,${definition.id},,,LISTING,128000`
        ].join("\n"),
        source: MarketPriceSource.CSV_IMPORT
      },
      user,
      context
    );

    expect(result.importedRows).toBe(1);
    expect(result.createdRows).toBe(1);
    expect(result.failedRows).toBe(0);
    expect(harness.state.observations[0]).toMatchObject({
      brand: definition.brand,
      model: definition.modelName,
      modelDefinitionId: definition.id
    });
  });

  it("returns row-level CSV errors when legacy model cannot resolve to model definition", async () => {
    const harness = createResidualMarketHarness({ modelDefinitions: [] });

    const result = await harness.service.importCsv(
      {
        csvText: [
          "observedAt,brand,model,priceType,priceAmount",
          "2026-06-01,NIO,ET5,LISTING,128000"
        ].join("\n"),
        source: MarketPriceSource.CSV_IMPORT
      },
      user,
      context
    );

    expect(result.importedRows).toBe(0);
    expect(result.createdRows).toBe(0);
    expect(result.failedRows).toBe(1);
    expect(result.errors[0]).toMatchObject({ action: "FAILED", rowNumber: 2 });
    expect(harness.state.observations).toHaveLength(0);
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
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n]),
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id,
        referencePriceAmount: 20000000
      },
      user,
      context
    );

    expect(result.dryRun).toBe(true);
    expect(result.curve.modelDefinitionId).toBe(makeModelDefinition().id);
    expect(result.pointCount).toBe(1);
    expect(result.points[0]?.medianPriceAmount).toBe(12000000);
    expect(harness.state.curves).toHaveLength(0);
    expect(harness.state.points).toHaveLength(0);
    expect(harness.state.modelRuns).toHaveLength(0);
    expect(harness.state.modelRunOutputs).toHaveLength(0);
    expect(harness.auditService.write).not.toHaveBeenCalled();
    expectNoResidualMarketSalePriceWrites(harness);
  });

  it("formally generates a draft residual curve with points and audit log", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n]),
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id,
        referencePriceAmount: 20000000,
        remark: "generate"
      },
      user,
      context
    );

    expect(result.dryRun).toBe(false);
    expect(result.curve.curveNo).toMatch(/^RVC\d{14}[A-Z0-9]{4}$/);
    expect(result.curve.curveStatus).toBe(VehicleResidualCurveStatus.DRAFT);
    expect(result.curve.modelDefinitionId).toBe(makeModelDefinition().id);
    expect(harness.state.curves).toHaveLength(1);
    expect(harness.state.points).toHaveLength(1);
    expect(harness.state.modelRuns).toHaveLength(0);
    expect(harness.state.modelRunOutputs).toHaveLength(0);
    expect(result.modelRunLinked).toBe(false);
    expectNoResidualMarketSalePriceWrites(harness);
    expect(result.warnings).toContain("本次残值曲线未关联模型运行记录。");
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_residual_curve",
        module: "residual_market"
      })
    );
  });

  it("generates residual curves with modelDefinitionId and legacy sample fallback", async () => {
    const definition = makeModelDefinition();
    const observations = makeCurveSamples([10000000n, 12000000n, 14000000n]).map((observation, index) => ({
      ...observation,
      modelDefinitionId: index < 2 ? definition.id : null
    }));
    const harness = createResidualMarketHarness({
      modelDefinitions: [definition],
      observations
    });

    const result = await harness.service.generateCurve(
      {
        brand: "NIO",
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: definition.id,
        referencePriceAmount: 20000000
      },
      user,
      context
    );

    expect(result.curve.modelDefinitionId).toBe(definition.id);
    expect(result.curve.modelDefinition?.displayName).toBe("NIO ET5");
    expect(result.curve.modelDisplayName).toBe("NIO ET5");
    expect(result.curve.sampleCount).toBe(3);
    expect(harness.state.curves[0]?.modelDefinitionId).toBe(definition.id);

    const list = await harness.service.listCurves({ modelDefinitionId: definition.id });

    expect(list.total).toBe(1);
    expect(list.items[0]?.modelDefinition?.id).toBe(definition.id);
  });

  it("keeps residual model run linkage read-only during dryRun", async () => {
    const dryRunWithAutoCreate = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    const autoCreateResult = await dryRunWithAutoCreate.service.generateCurve(
      {
        autoCreateModelRun: true,
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id
      },
      modelRunManager,
      context
    );

    expect(autoCreateResult.modelRunLinked).toBe(false);
    expect(autoCreateResult.warnings).toContain("当前为试算，不会创建或更新模型运行记录。");
    expect(dryRunWithAutoCreate.state.curves).toHaveLength(0);
    expect(dryRunWithAutoCreate.state.modelRuns).toHaveLength(0);
    expect(dryRunWithAutoCreate.state.modelRunOutputs).toHaveLength(0);
    expect(dryRunWithAutoCreate.state.salePriceHistories).toHaveLength(0);
    expect(dryRunWithAutoCreate.auditService.write).not.toHaveBeenCalled();

    const dryRunWithExistingRun = createResidualMarketHarness({
      modelRuns: [makeModelRun({ runStatus: ResidualModelRunStatus.RUNNING })],
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    await dryRunWithExistingRun.service.generateCurve(
      {
        batteryCapacityKwh: 75,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT,
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id,
        modelRunId: "model-run-1",
        modelYear: 2024,
        series: "ET5"
      },
      modelRunManager,
      context
    );

    expect(dryRunWithExistingRun.state.modelRuns[0]?.runStatus).toBe(ResidualModelRunStatus.RUNNING);
    expect(dryRunWithExistingRun.state.curves).toHaveLength(0);
    expect(dryRunWithExistingRun.state.modelRunOutputs).toHaveLength(0);
    expect(dryRunWithExistingRun.state.salePriceHistories).toHaveLength(0);
    expect(dryRunWithExistingRun.auditService.write).not.toHaveBeenCalled();
  });

  it("auto-creates a completed residual model run and curve output on formal generation", async () => {
    const harness = createResidualMarketHarness({
      forecasts: [makeForecast()],
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n]),
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateCurve(
      {
        autoCreateModelRun: true,
        batteryCapacityKwh: 75,
        batteryUsageType: VehicleBatteryUsageType.BUYOUT,
        brand: "NIO",
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id,
        modelProvider: "internal",
        modelVersion: "v2026.06.link",
        modelYear: 2024,
        sampleEndDate: "2026-06-30",
        sampleStartDate: "2026-01-01",
        series: "ET5"
      },
      modelRunManager,
      context
    );

    expect(result.modelRunLinked).toBe(true);
    expect(result.modelRun?.runStatus).toBe(ResidualModelRunStatus.COMPLETED);
    expect(result.modelRun?.runType).toBe(ResidualModelRunType.STATISTICAL_BASELINE);
    expect(result.modelRun?.modelVersion).toBe("v2026.06.link");
    expect(result.modelRunOutput?.outputType).toBe(ResidualModelRunOutputType.RESIDUAL_CURVE);
    expect(result.modelRunOutput?.curveId).toBe(result.curve.id);
    expect(harness.state.modelRuns).toHaveLength(1);
    expect(harness.state.modelRunOutputs).toHaveLength(1);
    expect(harness.state.modelRuns[0]).toMatchObject({
      runStatus: ResidualModelRunStatus.COMPLETED,
      targetBrand: "NIO",
      targetModel: "ET5",
      targetModelYear: 2024
    });
    expect(harness.state.modelRuns[0]?.metricsSnapshot).toEqual(
      expect.objectContaining({
        curveGeneration: expect.objectContaining({
          pointCount: 1,
          sampleCount: 3,
          skippedSampleCount: 0
        })
      })
    );
    expect(harness.state.modelRuns[0]?.outputSnapshot).toEqual(
      expect.objectContaining({
        curveGeneration: expect.objectContaining({
          curveId: result.curve.id,
          curveNo: result.curve.curveNo
        })
      })
    );
    expect(harness.state.modelRuns[0]?.filterSnapshot).toEqual(
      expect.objectContaining({
        curveGeneration: expect.objectContaining({
          brand: "NIO",
          minSamplePerPoint: 3,
          model: "ET5"
        })
      })
    );
    expect(harness.state.modelRuns[0]?.parameterSnapshot).toEqual(
      expect.objectContaining({
        curveGeneration: expect.objectContaining({
          curveMethod: VehicleResidualCurveMethod.STATISTICAL_MEDIAN
        })
      })
    );
    expect(harness.state.modelRunOutputs[0]).toMatchObject({
      curveId: result.curve.id,
      outputNo: result.curve.curveNo,
      outputStatus: ResidualModelRunOutputStatus.ACTIVE
    });
    expectNoResidualMarketSalePriceWrites(harness);
    expect(harness.state.forecasts).toHaveLength(1);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "residual_model_run"
      })
    );
  });

  it("links created and running residual model runs to generated curves", async () => {
    for (const runStatus of [ResidualModelRunStatus.CREATED, ResidualModelRunStatus.RUNNING]) {
      const harness = createResidualMarketHarness({
        modelRuns: [makeModelRun({ runStatus })],
        observations: makeCurveSamples([10000000n, 12000000n, 14000000n]),
        vehicles: [makeVehicle()]
      });

      const result = await harness.service.generateCurve(
        {
          batteryCapacityKwh: 75,
          batteryUsageType: VehicleBatteryUsageType.BUYOUT,
          brand: "NIO",
          minSamplePerPoint: 3,
          model: "ET5",
          modelDefinitionId: makeModelDefinition().id,
          modelRunId: "model-run-1",
          modelYear: 2024,
          series: "ET5"
        },
        modelRunManager,
        context
      );

      expect(result.modelRunLinked).toBe(true);
      expect(harness.state.modelRuns[0]?.runStatus).toBe(ResidualModelRunStatus.COMPLETED);
      expect(harness.state.modelRunOutputs[0]).toMatchObject({
        curveId: result.curve.id,
        outputType: ResidualModelRunOutputType.RESIDUAL_CURVE,
        runId: "model-run-1"
      });
      expectNoResidualMarketSalePriceWrites(harness);
    }
  });

  it("rejects curve output linkage for immutable residual model run statuses", async () => {
    for (const runStatus of [
      ResidualModelRunStatus.COMPLETED,
      ResidualModelRunStatus.FAILED,
      ResidualModelRunStatus.CANCELLED
    ]) {
      const harness = createResidualMarketHarness({
        modelRuns: [makeModelRun({ runStatus })],
        observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
      });

      await expect(
        harness.service.generateCurve(
          {
            batteryCapacityKwh: 75,
            batteryUsageType: VehicleBatteryUsageType.BUYOUT,
            brand: "NIO",
            minSamplePerPoint: 3,
            model: "ET5",
            modelDefinitionId: makeModelDefinition().id,
            modelRunId: "model-run-1",
            modelYear: 2024,
            series: "ET5"
          },
          modelRunManager,
          context
        )
      ).rejects.toThrow("状态");
    }
  });

  it("rejects curve model run linkage when target dimensions mismatch", async () => {
    const harness = createResidualMarketHarness({
      modelRuns: [makeModelRun({ targetModel: "ES6" })],
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    await expect(
      harness.service.generateCurve(
        {
          batteryCapacityKwh: 75,
          batteryUsageType: VehicleBatteryUsageType.BUYOUT,
          brand: "NIO",
          minSamplePerPoint: 3,
          model: "ET5",
          modelDefinitionId: makeModelDefinition().id,
          modelRunId: "model-run-1",
          modelYear: 2024,
          series: "ET5"
        },
        modelRunManager,
        context
      )
    ).rejects.toThrow("目标维度");
  });

  it("requires residual model run management permission for curve linkage", async () => {
    const harness = createResidualMarketHarness({
      modelRuns: [makeModelRun()],
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    await expect(
      harness.service.generateCurve(
        {
          autoCreateModelRun: true,
          brand: "NIO",
          minSamplePerPoint: 3,
          model: "ET5",
          modelDefinitionId: makeModelDefinition().id
        },
        user,
        context
      )
    ).rejects.toThrow("缺少模型运行记录管理权限");

    await expect(
      harness.service.generateCurve(
        {
          brand: "NIO",
          minSamplePerPoint: 3,
          model: "ET5",
          modelDefinitionId: makeModelDefinition().id,
          modelRunId: "model-run-1"
        },
        user,
        context
      )
    ).rejects.toThrow("缺少模型运行记录管理权限");
  });

  it("rejects legacy-only residual curve generation", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.generateCurve({ brand: "NIO", minSamplePerPoint: 3, model: "ET5" }, user, context)
    ).rejects.toThrow("modelDefinitionId");
  });

  it("does not auto-resolve legacy residual curve generation from available model definitions", async () => {
    const harness = createResidualMarketHarness({
      observations: makeCurveSamples([10000000n, 12000000n, 14000000n])
    });

    await expect(
      harness.service.generateCurve({ brand: "NIO", minSamplePerPoint: 3, model: "ET5" }, user, context)
    ).rejects.toThrow("modelDefinitionId");
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
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 1,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id
      },
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
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 1,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id
      },
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
        {
          brand: "NIO",
          dryRun: true,
          minSamplePerPoint: 3,
          model: "ET5",
          modelDefinitionId: makeModelDefinition().id
        },
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
        modelDefinitionId: makeModelDefinition().id,
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
      {
        brand: "NIO",
        dryRun: true,
        minSamplePerPoint: 3,
        model: "ET5",
        modelDefinitionId: makeModelDefinition().id
      },
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
      ],
      vehicles: [makeVehicle()]
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
    expectNoResidualMarketSalePriceWrites(harness);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_residual_curve"
      })
    );
  });

  it("archives a residual curve and rejects repeated archive actions", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.archiveCurve("curve-1", { remark: "archive" }, user, context);

    expect(result.curveStatus).toBe(VehicleResidualCurveStatus.ARCHIVED);
    expect(harness.state.curves[0]?.effectiveTo).toBeInstanceOf(Date);
    expectNoResidualMarketSalePriceWrites(harness);
    await expect(
      harness.service.archiveCurve("curve-1", { remark: "again" }, user, context)
    ).rejects.toThrow("已归档");
  });
  it("dry-runs vehicle residual forecast without writing database rows", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      points: makeForecastCurvePoints(),
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: true },
      user,
      context
    );

    expect(result.dryRun).toBe(true);
    expect(result.pointCount).toBe(5);
    expect(result.points.map((point) => point.horizonMonth)).toEqual([0, 6, 12, 24, 36]);
    expect(result.points[0]?.interpolationMethod).toBe(ResidualForecastInterpolationMethod.EXACT);
    expect(result.points[0]?.predictedResidualAmount).toBe(12000000);
    expect(result.points[0]?.predictedResidualRateBps).toBe(6000);
    expect(harness.state.forecasts).toHaveLength(0);
    expect(harness.state.forecastPoints).toHaveLength(0);
    expect(harness.auditService.write).not.toHaveBeenCalled();
    expectNoResidualMarketSalePriceWrites(harness);
  });

  it("formally creates vehicle residual forecast and points with audit log", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      points: makeForecastCurvePoints(),
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: false, horizonMonths: [0, 6], remark: "generate forecast" },
      user,
      context
    );

    expect(result.forecast.forecastNo).toMatch(/^VRF\d{14}[A-Z0-9]{4}$/);
    expect(result.forecast.forecastStatus).toBe(VehicleResidualForecastStatus.GENERATED);
    expect(harness.state.forecasts).toHaveLength(1);
    expect(harness.state.forecastPoints).toHaveLength(2);
    expectNoResidualMarketSalePriceWrites(harness);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "vehicle_residual_forecast",
        module: "residual_market"
      })
    );
  });

  it("rejects vehicle residual forecast when vehicle is missing or lacks registrationDate", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      points: makeForecastCurvePoints(),
      vehicles: [makeVehicle({ registrationDate: null })]
    });

    await expect(
      harness.service.generateVehicleForecast("missing-vehicle", { dryRun: true }, user, context)
    ).rejects.toThrow("车辆不存在");
    await expect(
      harness.service.generateVehicleForecast("vehicle-1", { dryRun: true }, user, context)
    ).rejects.toThrow("上牌日期");
  });

  it("rejects vehicle residual forecast when no active curve matches", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.DRAFT })],
      points: makeForecastCurvePoints(),
      vehicles: [makeVehicle()]
    });

    await expect(
      harness.service.generateVehicleForecast("vehicle-1", { dryRun: true }, user, context)
    ).rejects.toThrow("未找到匹配的生效残值曲线");
  });

  it("selects the highest-scoring active curve by vehicle dimension", async () => {
    const harness = createResidualMarketHarness({
      curves: [
        makeCurve({
          batteryCapacityKwh: null,
          batteryUsageType: null,
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          id: "curve-broad",
          modelYear: null,
          series: null
        }),
        makeCurve({
          curveNo: "RVC20260602000000A1B2",
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          generatedAt: new Date("2026-06-02T00:00:00.000Z"),
          id: "curve-specific"
        })
      ],
      points: [
        makeCurvePoint({ curveId: "curve-broad", id: "broad-24", predictedResidualAmount: 12000000n }),
        makeCurvePoint({ curveId: "curve-specific", id: "specific-24", predictedResidualAmount: 9000000n })
      ],
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: true, horizonMonths: [0] },
      user,
      context
    );

    expect(result.forecast.curveId).toBe("curve-specific");
    expect(result.points[0]?.predictedResidualAmount).toBe(9000000);
    const inputSnapshot = result.forecast.inputSnapshot as { curveMatch: { score: number } };
    expect(inputSnapshot.curveMatch.score).toBeGreaterThan(0);
  });

  it("uses modelDefinition residual curves before legacy curves for forecast generation", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({
      curves: [
        makeCurve({
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          id: "curve-legacy",
          modelDefinitionId: null
        }),
        makeCurve({
          curveNo: "RVC20260602000000A1B2",
          curveStatus: VehicleResidualCurveStatus.ACTIVE,
          id: "curve-definition",
          modelDefinitionId: definition.id
        })
      ],
      modelDefinitions: [definition],
      points: [
        makeCurvePoint({ curveId: "curve-legacy", id: "legacy-24", predictedResidualAmount: 12000000n }),
        makeCurvePoint({ curveId: "curve-definition", id: "definition-24", predictedResidualAmount: 9000000n })
      ],
      vehicles: [makeVehicle({ modelDefinitionId: definition.id })]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: false, horizonMonths: [0] },
      user,
      context
    );

    expect(result.forecast.curveId).toBe("curve-definition");
    expect(result.forecast.modelDefinitionId).toBe(definition.id);
    expect(result.forecast.modelDefinition?.displayName).toBe("NIO ET5");
    expect(result.points[0]?.predictedResidualAmount).toBe(9000000);
    expect(harness.state.forecasts[0]?.modelDefinitionId).toBe(definition.id);
    expectNoResidualMarketSalePriceWrites(harness);
    const inputSnapshot = result.forecast.inputSnapshot as { curveMatch: { matchedFields: string[] } };
    expect(inputSnapshot.curveMatch.matchedFields).toContain("modelDefinitionId");
  });

  it("falls back to legacy residual curves when a vehicle modelDefinition curve is missing", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE, id: "curve-legacy" })],
      modelDefinitions: [definition],
      points: [makeCurvePoint({ curveId: "curve-legacy", id: "legacy-24", predictedResidualAmount: 12000000n })],
      vehicles: [makeVehicle({ modelDefinitionId: definition.id })]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: false, horizonMonths: [0] },
      user,
      context
    );

    expect(result.forecast.curveId).toBe("curve-legacy");
    expect(result.forecast.modelDefinitionId).toBe(definition.id);
    expect(result.points[0]?.predictedResidualAmount).toBe(12000000);
    expectNoResidualMarketSalePriceWrites(harness);
    const inputSnapshot = result.forecast.inputSnapshot as { curveMatch: { matchedFields: string[] } };
    expect(inputSnapshot.curveMatch.matchedFields).not.toContain("modelDefinitionId");
  });

  it("linearly interpolates forecast points and marks out-of-range points unsupported", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      points: [
        makeCurvePoint({ ageMonth: 24, id: "curve-point-24", predictedResidualAmount: 12000000n }),
        makeCurvePoint({ ageMonth: 36, id: "curve-point-36", predictedResidualAmount: 9000000n })
      ],
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: true, horizonMonths: [6, 36] },
      user,
      context
    );

    expect(result.points[0]).toMatchObject({
      horizonMonth: 6,
      interpolationMethod: ResidualForecastInterpolationMethod.LINEAR_INTERPOLATION,
      predictedResidualAmount: 10500000
    });
    expect(result.points[1]).toMatchObject({
      horizonMonth: 36,
      interpolationMethod: ResidualForecastInterpolationMethod.UNSUPPORTED_OUT_OF_RANGE,
      pointStatus: VehicleResidualForecastPointStatus.UNSUPPORTED,
      predictedResidualAmount: null
    });
  });

  it("leaves vehicle residualRateBps null when purchasePriceAmount is not positive", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      points: makeForecastCurvePoints(),
      vehicles: [makeVehicle({ purchasePriceAmount: 0n })]
    });

    const result = await harness.service.generateVehicleForecast(
      "vehicle-1",
      { asOfDate: "2026-06-01", dryRun: true, horizonMonths: [0] },
      user,
      context
    );

    expect(result.points[0]?.predictedResidualRateBps).toBeNull();
  });

  it("lists latest and detailed vehicle residual forecasts without BigInt serialization failures", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      forecastPoints: [makeForecastPoint()],
      forecasts: [makeForecast()],
      vehicles: [makeVehicle()]
    });

    const list = await harness.service.listVehicleForecasts("vehicle-1", {});
    const latest = await harness.service.getLatestVehicleForecast("vehicle-1");
    const detail = await harness.service.getVehicleForecast("forecast-1");

    expect(list.total).toBe(1);
    expect(latest?.forecastNo).toBe("VRF20260601000000A1B2");
    expect(detail.points?.[0]?.predictedResidualAmount).toBe(12000000);
    expect(() => JSON.stringify(detail)).not.toThrow();
  });

  it("adopts a supported forecast point without changing vehicle currentSalePriceAmount", async () => {
    const vehicle = makeVehicle({ currentSalePriceAmount: 15000000n });
    const harness = createResidualMarketHarness({
      curves: [makeCurve({ curveStatus: VehicleResidualCurveStatus.ACTIVE })],
      forecastPoints: [makeForecastPoint()],
      forecasts: [makeForecast()],
      vehicles: [vehicle]
    });

    const result = await harness.service.adoptVehicleForecastPoint(
      "forecast-point-1",
      { adoptedResidualAmount: 11800000, adoptRemark: "adopt" },
      user,
      context
    );

    expect(result.pointStatus).toBe(VehicleResidualForecastPointStatus.ADOPTED);
    expect(result.adoptedResidualAmount).toBe(11800000);
    expect(harness.state.forecasts[0]?.forecastStatus).toBe(VehicleResidualForecastStatus.ADOPTED);
    expectNoResidualMarketSalePriceWrites(harness, 15000000n);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_residual_forecast_point"
      })
    );
  });

  it("rejects unsupported point adoption and non-positive adopted amount", async () => {
    const harness = createResidualMarketHarness({
      forecastPoints: [
        makeForecastPoint({
          pointStatus: VehicleResidualForecastPointStatus.UNSUPPORTED,
          predictedResidualAmount: null
        })
      ],
      forecasts: [makeForecast()],
      vehicles: [makeVehicle()]
    });

    await expect(
      harness.service.adoptVehicleForecastPoint(
        "forecast-point-1",
        { adoptedResidualAmount: 10000000 },
        user,
        context
      )
    ).rejects.toThrow("不能采用");

    harness.state.forecastPoints[0] = makeForecastPoint();
    await expect(
      harness.service.adoptVehicleForecastPoint(
        "forecast-point-1",
        { adoptedResidualAmount: 0 },
        user,
        context
      )
    ).rejects.toThrow("adoptedResidualAmount");
  });

  it("voids a vehicle residual forecast without changing sale price or writing sale price history", async () => {
    const harness = createResidualMarketHarness({
      forecasts: [makeForecast()],
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.voidVehicleForecast(
      "forecast-1",
      { remark: "void forecast" },
      user,
      context
    );

    expect(result.forecastStatus).toBe(VehicleResidualForecastStatus.VOIDED);
    expectNoResidualMarketSalePriceWrites(harness);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "vehicle_residual_forecast"
      })
    );
  });

  it("creates a residual model run and writes audit log", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.createModelRun(validModelRunDto(), user, context);

    expect(result.runNo).toMatch(/^RMR\d{14}[A-Z0-9]{4}$/);
    expect(result.runStatus).toBe(ResidualModelRunStatus.CREATED);
    expect(result.targetModelDefinitionId).toBe(makeModelDefinition().id);
    expect(result.featureSnapshot).toEqual({ features: ["ageMonth", "mileageKm"] });
    expect(harness.state.modelRuns).toHaveLength(1);
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.CREATE,
        entityType: "residual_model_run",
        module: "residual_market"
      })
    );
  });

  it("creates and filters residual model runs with target model definitions", async () => {
    const definition = makeModelDefinition();
    const harness = createResidualMarketHarness({ modelDefinitions: [definition] });

    const result = await harness.service.createModelRun(
      { ...validModelRunDto(), targetModelDefinitionId: definition.id },
      user,
      context
    );

    expect(result.targetModelDefinitionId).toBe(definition.id);
    expect(result.targetModelDefinition?.modelCode).toBe("ET5");
    expect(result.targetModelDisplayName).toBe("NIO ET5");

    const list = await harness.service.listModelRuns({ targetModelDefinitionId: definition.id });

    expect(list.total).toBe(1);
    expect(list.items[0]?.targetModelDefinition?.id).toBe(definition.id);
  });

  it("allows full residual model runs without targetModelDefinitionId when no target model is specified", async () => {
    const harness = createResidualMarketHarness();

    const result = await harness.service.createModelRun(
      {
        algorithm: ResidualModelAlgorithm.STATISTICAL_MEDIAN,
        modelProvider: "internal",
        modelVersion: "v2026.06.full",
        runName: "full residual baseline",
        runStatus: ResidualModelRunStatus.CREATED,
        runType: ResidualModelRunType.STATISTICAL_BASELINE,
        targetType: ResidualModelTargetType.MARKET_PRICE
      },
      user,
      context
    );

    expect(result.targetModelDefinitionId).toBeNull();
    expect(result.targetModelDefinition).toBeNull();
  });

  it("rejects target-specific residual model runs when only legacy target fields are provided", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createModelRun(
        { ...validModelRunDto(), targetModelDefinitionId: undefined },
        user,
        context
      )
    ).rejects.toThrow("targetModelDefinitionId");
    expect(harness.state.modelRuns).toHaveLength(0);
  });

  it("rejects invalid initial residual model run status", async () => {
    const harness = createResidualMarketHarness();

    await expect(
      harness.service.createModelRun(
        { ...validModelRunDto(), runStatus: ResidualModelRunStatus.COMPLETED },
        user,
        context
      )
    ).rejects.toThrow("CREATED");
  });

  it("lists residual model runs with filters", async () => {
    const harness = createResidualMarketHarness({
      modelRuns: [
        makeModelRun({
          id: "run-nio",
          modelVersion: "v2026.06",
          runStatus: ResidualModelRunStatus.CREATED,
          targetBrand: "NIO"
        }),
        makeModelRun({
          id: "run-tesla",
          modelVersion: "v2026.07",
          runStatus: ResidualModelRunStatus.FAILED,
          targetBrand: "Tesla"
        })
      ]
    });

    const result = await harness.service.listModelRuns({
      modelVersion: "v2026.06",
      runStatus: ResidualModelRunStatus.CREATED,
      targetBrand: "nio"
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("run-nio");
  });

  it("returns residual model run detail with snapshots and outputs", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve()],
      modelRunOutputs: [makeModelRunOutput({ curveId: "curve-1" })],
      modelRuns: [makeModelRun({ metricsSnapshot: { mae: 12345 }, outputSnapshot: { curveCount: 1 } })]
    });

    const result = await harness.service.getModelRun("model-run-1");

    expect(result.metricsSnapshot).toEqual({ mae: 12345 });
    expect(result.outputSnapshot).toEqual({ curveCount: 1 });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs?.[0]?.curve?.curveNo).toBe("RVC20260601000000A1B2");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("completes a created residual model run with a curve output", async () => {
    const harness = createResidualMarketHarness({
      curves: [makeCurve()],
      modelRuns: [makeModelRun()]
    });

    const result = await harness.service.completeModelRun(
      "model-run-1",
      {
        metricsSnapshot: { mae: 12345 },
        outputSnapshot: { curveCount: 1 },
        outputs: [
          {
            curveId: "curve-1",
            outputSnapshot: { curveNo: "RVC20260601000000A1B2" },
            outputType: ResidualModelRunOutputType.RESIDUAL_CURVE
          }
        ],
        remark: "complete"
      },
      user,
      context
    );

    expect(result.runStatus).toBe(ResidualModelRunStatus.COMPLETED);
    expect(result.finishedAt).not.toBeNull();
    expect(result.outputs).toHaveLength(1);
    expect(harness.state.modelRunOutputs[0]).toMatchObject({
      curveId: "curve-1",
      outputStatus: ResidualModelRunOutputStatus.ACTIVE,
      outputType: ResidualModelRunOutputType.RESIDUAL_CURVE
    });
    expect(harness.auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entityType: "residual_model_run"
      })
    );
  });

  it("completes a running residual model run with a forecast output", async () => {
    const harness = createResidualMarketHarness({
      forecasts: [makeForecast()],
      modelRuns: [makeModelRun({ runStatus: ResidualModelRunStatus.RUNNING })],
      vehicles: [makeVehicle()]
    });

    const result = await harness.service.completeModelRun(
      "model-run-1",
      {
        outputs: [
          {
            forecastId: "forecast-1",
            outputType: ResidualModelRunOutputType.VEHICLE_FORECAST,
            vehicleId: "vehicle-1"
          }
        ]
      },
      user,
      context
    );

    expect(result.runStatus).toBe(ResidualModelRunStatus.COMPLETED);
    expect(result.outputs?.[0]?.forecast?.forecastNo).toBe("VRF20260601000000A1B2");
    expect(result.outputs?.[0]?.vehicle?.vehicleNo).toBe("VH20260601000000A1B2");
  });

  it("rejects residual model run completion with missing output references", async () => {
    const harness = createResidualMarketHarness({ modelRuns: [makeModelRun()] });

    await expect(
      harness.service.completeModelRun(
        "model-run-1",
        { outputs: [{ curveId: "missing-curve", outputType: ResidualModelRunOutputType.RESIDUAL_CURVE }] },
        user,
        context
      )
    ).rejects.toThrow();

    await expect(
      harness.service.completeModelRun(
        "model-run-1",
        { outputs: [{ forecastId: "missing-forecast", outputType: ResidualModelRunOutputType.VEHICLE_FORECAST }] },
        user,
        context
      )
    ).rejects.toThrow();
  });

  it("rejects repeated residual model run completion", async () => {
    const harness = createResidualMarketHarness({
      modelRuns: [makeModelRun({ runStatus: ResidualModelRunStatus.COMPLETED })]
    });

    await expect(
      harness.service.completeModelRun("model-run-1", { outputs: [] }, user, context)
    ).rejects.toThrow();
  });

  it("fails a running residual model run and rejects failing completed runs", async () => {
    const harness = createResidualMarketHarness({
      modelRuns: [makeModelRun({ runStatus: ResidualModelRunStatus.RUNNING })]
    });

    const result = await harness.service.failModelRun(
      "model-run-1",
      { errorSnapshot: { code: "INSUFFICIENT_SAMPLE" }, remark: "fail" },
      user,
      context
    );

    expect(result.runStatus).toBe(ResidualModelRunStatus.FAILED);
    expect(result.errorSnapshot).toEqual({ code: "INSUFFICIENT_SAMPLE" });

    harness.state.modelRuns[0] = makeModelRun({ runStatus: ResidualModelRunStatus.COMPLETED });
    await expect(
      harness.service.failModelRun("model-run-1", { remark: "again" }, user, context)
    ).rejects.toThrow();
  });

  it("cancels a created residual model run and rejects cancelling completed runs", async () => {
    const harness = createResidualMarketHarness({ modelRuns: [makeModelRun()] });

    const result = await harness.service.cancelModelRun("model-run-1", { remark: "cancel" }, user, context);

    expect(result.runStatus).toBe(ResidualModelRunStatus.CANCELLED);
    expect(result.finishedAt).not.toBeNull();

    harness.state.modelRuns[0] = makeModelRun({ runStatus: ResidualModelRunStatus.COMPLETED });
    await expect(
      harness.service.cancelModelRun("model-run-1", { remark: "again" }, user, context)
    ).rejects.toThrow();
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
    modelDefinitionId: makeModelDefinition().id,
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
    forecastPoints: [...(seed.forecastPoints ?? [])],
    forecasts: [...(seed.forecasts ?? [])],
    modelRunOutputs: [...(seed.modelRunOutputs ?? [])],
    modelRuns: [...(seed.modelRuns ?? [])],
    modelDefinitions: [...(seed.modelDefinitions ?? [makeModelDefinition()])],
    observations: [...(seed.observations ?? [])],
    points: [...(seed.points ?? [])],
    salePriceHistories: [...(seed.salePriceHistories ?? [])],
    vehicles: [...(seed.vehicles ?? [])]
  };
  const auditService = { write: vi.fn().mockResolvedValue(undefined) };
  const prisma = createResidualMarketPrisma(state);
  const service = new ResidualMarketService(auditService as never, prisma as never);

  return { auditService, prisma, service, state };
}

type ResidualMarketState = {
  batches: MarketPriceImportBatch[];
  curves: VehicleResidualCurve[];
  forecastPoints: VehicleResidualForecastPoint[];
  forecasts: VehicleResidualForecast[];
  modelRunOutputs: ResidualModelRunOutput[];
  modelRuns: ResidualModelRun[];
  modelDefinitions: VehicleModelDefinition[];
  observations: VehicleMarketPriceObservation[];
  points: VehicleResidualCurvePoint[];
  salePriceHistories: VehicleSalePriceHistory[];
  vehicles: Vehicle[];
};

function expectNoResidualMarketSalePriceWrites(
  harness: ReturnType<typeof createResidualMarketHarness>,
  expectedCurrentSalePriceAmount = 13000000n
) {
  expect(harness.state.vehicles[0]?.currentSalePriceAmount).toBe(expectedCurrentSalePriceAmount);
  expect(harness.state.salePriceHistories).toHaveLength(0);
  expect(harness.prisma.vehicle.update).not.toHaveBeenCalled();
  expect(harness.prisma.vehicleSalePriceHistory.create).not.toHaveBeenCalled();
}

function createResidualMarketPrisma(state: ResidualMarketState) {
  const prisma = {
    vehicle: {
      findFirst: vi.fn(({ include, where }) =>
        Promise.resolve(
          attachVehicleInclude(state.vehicles.find((vehicle) => matchesVehicleWhere(vehicle, where)) ?? null, include, state)
        )
      ),
      update: vi.fn(() =>
        Promise.reject(new Error("Residual market service must not update Vehicle.currentSalePriceAmount."))
      )
    },
    vehicleModelDefinition: {
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(
          state.modelDefinitions.find((definition) => matchesModelDefinitionWhere(definition, where)) ?? null
        )
      ),
      findMany: vi.fn(({ where }) =>
        Promise.resolve(state.modelDefinitions.filter((definition) => matchesModelDefinitionWhere(definition, where)))
      )
    },
    vehicleSalePriceHistory: {
      count: vi.fn(() => Promise.resolve(state.salePriceHistories.length)),
      create: vi.fn(() =>
        Promise.reject(new Error("Residual market service must not write VehicleSalePriceHistory."))
      ),
      findMany: vi.fn(() => Promise.resolve(state.salePriceHistories))
    },
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
      create: vi.fn(({ data, include }) => {
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
        return Promise.resolve(attachObservationInclude(observation, include, state));
      }),
      findFirst: vi.fn(({ include, where }) =>
        Promise.resolve(
          attachObservationInclude(
            state.observations.find((observation) => matchesObservationWhere(observation, where)) ?? null,
            include,
            state
          )
        )
      ),
      findMany: vi.fn(({ include, skip = 0, take = 20, where }) =>
        Promise.resolve(
          state.observations
            .filter((observation) => matchesObservationWhere(observation, where))
            .slice(skip, skip + take)
            .map((observation) => attachObservationInclude(observation, include, state))
        )
      ),
      update: vi.fn(({ data, include, where }) => {
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
        return Promise.resolve(attachObservationInclude(updated, include, state));
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
      findMany: vi.fn(({ include, skip = 0, take = 20, where }) =>
        Promise.resolve(
          state.curves
            .filter((curve) => matchesCurveWhere(curve, where))
            .slice(skip, skip + take)
            .map((curve) => attachCurveInclude(curve, include, state))
        )
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
    },
    vehicleResidualForecast: {
      count: vi.fn(({ where }) =>
        Promise.resolve(state.forecasts.filter((forecast) => matchesForecastWhere(forecast, where)).length)
      ),
      create: vi.fn(({ data, include }) => {
        const { points, ...forecastData } = data;
        const forecast = makeForecast({
          ...forecastData,
          id: `forecast-${state.forecasts.length + 1}`
        });
        const createdPoints = (points?.create ?? []).map(
          (point: Partial<VehicleResidualForecastPoint>, index: number) =>
            makeForecastPoint({
              ...point,
              forecastId: forecast.id,
              id: `forecast-point-${state.forecastPoints.length + index + 1}`
            })
        );
        state.forecasts.push(forecast);
        state.forecastPoints.push(...createdPoints);
        return Promise.resolve(attachForecastInclude(forecast, include, state));
      }),
      findFirst: vi.fn(({ include, orderBy, where }) => {
        const forecasts = state.forecasts.filter((forecast) => matchesForecastWhere(forecast, where));
        sortForecasts(forecasts, orderBy);
        return Promise.resolve(attachForecastInclude(forecasts[0] ?? null, include, state));
      }),
      findMany: vi.fn(({ include, orderBy, skip = 0, take = 20, where }) => {
        const forecasts = state.forecasts.filter((forecast) => matchesForecastWhere(forecast, where));
        sortForecasts(forecasts, orderBy);
        return Promise.resolve(
          forecasts.slice(skip, skip + take).map((forecast) => attachForecastInclude(forecast, include, state))
        );
      }),
      update: vi.fn(({ data, include, where }) => {
        const index = state.forecasts.findIndex((forecast) => forecast.id === where.id);
        const before = state.forecasts[index];
        if (!before) {
          throw new Error("Forecast not found.");
        }
        const updated = {
          ...before,
          ...data,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
        state.forecasts[index] = updated;
        return Promise.resolve(attachForecastInclude(updated, include, state));
      })
    },
    vehicleResidualForecastPoint: {
      findFirst: vi.fn(({ include, where }) =>
        Promise.resolve(
          attachForecastPointInclude(
            state.forecastPoints.find((point) => matchesForecastPointWhere(point, where)) ?? null,
            include,
            state
          )
        )
      ),
      update: vi.fn(({ data, include, where }) => {
        const index = state.forecastPoints.findIndex((point) => point.id === where.id);
        const before = state.forecastPoints[index];
        if (!before) {
          throw new Error("Forecast point not found.");
        }
        const updated = {
          ...before,
          ...data,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
        state.forecastPoints[index] = updated;
        return Promise.resolve(attachForecastPointInclude(updated, include, state));
      })
    },
    residualModelRun: {
      count: vi.fn(({ where }) =>
        Promise.resolve(state.modelRuns.filter((run) => matchesModelRunWhere(run, where)).length)
      ),
      create: vi.fn(({ data, include }) => {
        const run = makeModelRun({
          ...data,
          featureSnapshot: data.featureSnapshot === Prisma.JsonNull ? null : data.featureSnapshot,
          filterSnapshot: data.filterSnapshot === Prisma.JsonNull ? null : data.filterSnapshot,
          id: `model-run-${state.modelRuns.length + 1}`,
          parameterSnapshot: data.parameterSnapshot === Prisma.JsonNull ? null : data.parameterSnapshot
        });
        state.modelRuns.push(run);
        return Promise.resolve(attachModelRunInclude(run, include, state));
      }),
      findFirst: vi.fn(({ include, where }) =>
        Promise.resolve(
          attachModelRunInclude(
            state.modelRuns.find((run) => matchesModelRunWhere(run, where)) ?? null,
            include,
            state
          )
        )
      ),
      findMany: vi.fn(({ include, orderBy, skip = 0, take = 20, where }) => {
        const runs = state.modelRuns.filter((run) => matchesModelRunWhere(run, where));
        sortModelRuns(runs, orderBy);
        return Promise.resolve(runs.slice(skip, skip + take).map((run) => attachModelRunInclude(run, include, state)));
      }),
      findUniqueOrThrow: vi.fn(({ include, where }) => {
        const run = state.modelRuns.find((candidate) => candidate.id === where.id);
        if (!run) {
          throw new Error("Model run not found.");
        }
        return Promise.resolve(attachModelRunInclude(run, include, state));
      }),
      update: vi.fn(({ data, include, where }) => {
        const index = state.modelRuns.findIndex((run) => run.id === where.id);
        const before = state.modelRuns[index];
        if (!before) {
          throw new Error("Model run not found.");
        }
        const updated = {
          ...before,
          ...data,
          errorSnapshot: data.errorSnapshot === Prisma.JsonNull ? null : data.errorSnapshot,
          filterSnapshot: data.filterSnapshot === Prisma.JsonNull ? null : data.filterSnapshot,
          metricsSnapshot: data.metricsSnapshot === Prisma.JsonNull ? null : data.metricsSnapshot,
          outputSnapshot: data.outputSnapshot === Prisma.JsonNull ? null : data.outputSnapshot,
          parameterSnapshot: data.parameterSnapshot === Prisma.JsonNull ? null : data.parameterSnapshot,
          updatedAt: new Date("2026-06-01T00:10:00.000Z")
        };
        state.modelRuns[index] = updated;
        return Promise.resolve(attachModelRunInclude(updated, include, state));
      })
    },
    residualModelRunOutput: {
      create: vi.fn(({ data, include }) => {
        const created = makeModelRunOutput({
          ...data,
          id: `model-run-output-${state.modelRunOutputs.length + 1}`,
          outputSnapshot: data.outputSnapshot === Prisma.JsonNull ? null : data.outputSnapshot
        });
        state.modelRunOutputs.push(created);
        return Promise.resolve(include ? attachModelRunOutputInclude(created, include, state) : created);
      }),
      createMany: vi.fn(({ data }) => {
        const rows = Array.isArray(data) ? data : [data];
        const created = rows.map((row, index) =>
          makeModelRunOutput({
            ...row,
            id: `model-run-output-${state.modelRunOutputs.length + index + 1}`,
            outputSnapshot: row.outputSnapshot === Prisma.JsonNull ? null : row.outputSnapshot
          })
        );
        state.modelRunOutputs.push(...created);
        return Promise.resolve({ count: created.length });
      })
    }
  };

  return {
    ...prisma,
    $transaction: vi.fn((callback) => callback(prisma))
  };
}

function matchesObservationWhere(observation: VehicleMarketPriceObservation, where: Record<string, unknown> = {}): boolean {
  if (Array.isArray(where.OR)) {
    const baseWhere = { ...where };
    delete baseWhere.OR;
    return where.OR.some((orWhere) => matchesObservationWhere(observation, { ...baseWhere, ...(orWhere as Record<string, unknown>) }));
  }
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
  if (where.modelDefinitionId !== undefined && observation.modelDefinitionId !== where.modelDefinitionId) {
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
  if (where.modelDefinitionId !== undefined && curve.modelDefinitionId !== where.modelDefinitionId) {
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

function matchesVehicleWhere(vehicle: Vehicle, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && vehicle.id !== where.id) {
    return false;
  }
  if (where.deletedAt === null && vehicle.deletedAt !== null) {
    return false;
  }
  return true;
}

function matchesModelDefinitionWhere(definition: VehicleModelDefinition, where: Record<string, unknown> = {}): boolean {
  if (Array.isArray(where.OR)) {
    const baseWhere = { ...where };
    delete baseWhere.OR;
    return where.OR.some((orWhere) =>
      matchesModelDefinitionWhere(definition, { ...baseWhere, ...(orWhere as Record<string, unknown>) })
    );
  }
  if (where.id !== undefined && definition.id !== where.id) {
    return false;
  }
  if (where.brand !== undefined && definition.brand !== where.brand) {
    return false;
  }
  if (where.deletedAt === null && definition.deletedAt !== null) {
    return false;
  }
  if (where.enabled !== undefined && definition.enabled !== where.enabled) {
    return false;
  }
  if (where.modelCode !== undefined && definition.modelCode !== where.modelCode) {
    return false;
  }
  if (where.modelName !== undefined && definition.modelName !== where.modelName) {
    return false;
  }
  if (where.series !== undefined && definition.series !== where.series) {
    return false;
  }
  return true;
}

function matchesForecastWhere(forecast: VehicleResidualForecast, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && forecast.id !== where.id) {
    return false;
  }
  if (where.vehicleId !== undefined && forecast.vehicleId !== where.vehicleId) {
    return false;
  }
  if (where.deletedAt === null && forecast.deletedAt !== null) {
    return false;
  }
  if (where.forecastStatus !== undefined && forecast.forecastStatus !== where.forecastStatus) {
    return false;
  }
  if (where.modelDefinitionId !== undefined && forecast.modelDefinitionId !== where.modelDefinitionId) {
    return false;
  }
  return true;
}

function matchesForecastPointWhere(point: VehicleResidualForecastPoint, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && point.id !== where.id) {
    return false;
  }
  if (where.forecastId !== undefined && point.forecastId !== where.forecastId) {
    return false;
  }
  return true;
}

function matchesModelRunWhere(run: ResidualModelRun, where: Record<string, unknown> = {}) {
  if (where.id !== undefined && run.id !== where.id) {
    return false;
  }
  if (where.deletedAt === null && run.deletedAt !== null) {
    return false;
  }
  if (where.runType !== undefined && run.runType !== where.runType) {
    return false;
  }
  if (where.runStatus !== undefined && run.runStatus !== where.runStatus) {
    return false;
  }
  if (where.targetType !== undefined && run.targetType !== where.targetType) {
    return false;
  }
  if (where.targetModelDefinitionId !== undefined && run.targetModelDefinitionId !== where.targetModelDefinitionId) {
    return false;
  }
  if (!matchesTextFilter(run.modelVersion, where.modelVersion)) {
    return false;
  }
  if (!matchesTextFilter(run.targetBrand, where.targetBrand)) {
    return false;
  }
  if (!matchesTextFilter(run.targetSeries, where.targetSeries)) {
    return false;
  }
  if (!matchesTextFilter(run.targetModel, where.targetModel)) {
    return false;
  }
  return matchesRange(run.createdAt, where.createdAt as RangeFilter<Date> | undefined);
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

function findModelDefinition(state: ResidualMarketState, id: string | null) {
  return id ? state.modelDefinitions.find((definition) => definition.id === id) ?? null : null;
}

function nestedInclude(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && "include" in value) {
    return (value as { include?: Record<string, unknown> }).include;
  }
  return undefined;
}

function attachVehicleInclude(vehicle: Vehicle | null, include: { modelDefinition?: unknown } | undefined, state: ResidualMarketState) {
  if (!vehicle) {
    return null;
  }
  return {
    ...vehicle,
    ...(include?.modelDefinition ? { modelDefinition: findModelDefinition(state, vehicle.modelDefinitionId) } : {})
  };
}

function attachObservationInclude(
  observation: VehicleMarketPriceObservation | null,
  include: { modelDefinition?: unknown } | undefined,
  state: ResidualMarketState
) {
  if (!observation) {
    return null;
  }
  return {
    ...observation,
    ...(include?.modelDefinition ? { modelDefinition: findModelDefinition(state, observation.modelDefinitionId) } : {})
  };
}

function attachCurveInclude(
  curve: VehicleResidualCurve | null,
  include: { modelDefinition?: unknown; points?: unknown } | undefined,
  state: ResidualMarketState
) {
  if (!curve) {
    return null;
  }

  return {
    ...curve,
    ...(include?.modelDefinition ? { modelDefinition: findModelDefinition(state, curve.modelDefinitionId) } : {}),
    ...(include?.points
      ? {
          points: state.points
            .filter((point) => point.curveId === curve.id)
            .sort((left, right) => left.ageMonth - right.ageMonth)
        }
      : {})
  };
}

function attachForecastInclude(
  forecast: VehicleResidualForecast | null,
  include: { curve?: unknown; modelDefinition?: unknown; points?: unknown; vehicle?: unknown } | undefined,
  state: ResidualMarketState
) {
  if (!forecast) {
    return null;
  }

  return {
    ...forecast,
    ...(include?.modelDefinition ? { modelDefinition: findModelDefinition(state, forecast.modelDefinitionId) } : {}),
    ...(include?.curve
      ? {
          curve: attachCurveInclude(
            state.curves.find((curve) => curve.id === forecast.curveId) ?? null,
            nestedInclude(include.curve),
            state
          )
        }
      : {}),
    ...(include?.points
      ? {
          points: state.forecastPoints
            .filter((point) => point.forecastId === forecast.id)
            .sort((left, right) => left.horizonMonth - right.horizonMonth)
        }
      : {}),
    ...(include?.vehicle
      ? {
          vehicle: attachVehicleInclude(
            state.vehicles.find((vehicle) => vehicle.id === forecast.vehicleId) ?? null,
            nestedInclude(include.vehicle),
            state
          )
        }
      : {})
  };
}

function attachForecastPointInclude(
  point: VehicleResidualForecastPoint | null,
  include: { forecast?: { include?: { curve?: unknown; modelDefinition?: unknown; vehicle?: unknown } } } | undefined,
  state: ResidualMarketState
) {
  if (!point) {
    return null;
  }
  const forecast = state.forecasts.find((candidate) => candidate.id === point.forecastId) ?? null;

  return {
    ...point,
    ...(include?.forecast
      ? {
          forecast: attachForecastInclude(forecast, include.forecast.include, state)
        }
      : {})
  };
}

function validModelRunDto() {
  return {
    algorithm: ResidualModelAlgorithm.STATISTICAL_MEDIAN,
    featureSnapshot: { features: ["ageMonth", "mileageKm"] },
    filterSnapshot: { priceTypes: ["TRANSACTION"] },
    modelName: "statistical_median_curve",
    modelProvider: "internal",
    modelVersion: "v2026.06.10",
    parameterSnapshot: { minSamplePerPoint: 3 },
    runName: "ET5 residual baseline",
    runStatus: ResidualModelRunStatus.CREATED,
    runType: ResidualModelRunType.STATISTICAL_BASELINE,
    sampleCount: 120,
    targetBatteryCapacityKwh: 75,
    targetBatteryUsageType: VehicleBatteryUsageType.BUYOUT,
    targetBrand: "NIO",
    targetModel: "ET5",
    targetModelDefinitionId: makeModelDefinition().id,
    targetModelYear: 2024,
    targetSeries: "ET5",
    targetType: ResidualModelTargetType.RESIDUAL_CURVE,
    trainingDataEndDate: "2026-06-30",
    trainingDataStartDate: "2026-01-01"
  };
}

function attachModelRunInclude(
  run: ResidualModelRun | null,
  include: { outputs?: { include?: { curve?: unknown; forecast?: unknown; vehicle?: unknown } }; targetModelDefinition?: unknown } | undefined,
  state: ResidualMarketState
) {
  if (!run) {
    return null;
  }

  const baseRun = {
    ...run,
    ...(include?.targetModelDefinition
      ? { targetModelDefinition: findModelDefinition(state, run.targetModelDefinitionId) }
      : {})
  };

  if (!include?.outputs) {
    return baseRun;
  }

  return {
    ...baseRun,
    outputs: state.modelRunOutputs
      .filter((output) => output.runId === run.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((output) => attachModelRunOutputInclude(output, include.outputs?.include, state))
  };
}

function attachModelRunOutputInclude(
  output: ResidualModelRunOutput,
  include: { curve?: unknown; forecast?: unknown; vehicle?: unknown } | undefined,
  state: ResidualMarketState
) {
  return {
    ...output,
    ...(include?.curve
      ? {
          curve: attachCurveInclude(
            state.curves.find((curve) => curve.id === output.curveId) ?? null,
            nestedInclude(include.curve),
            state
          )
        }
      : {}),
    ...(include?.forecast
      ? {
          forecast: attachForecastInclude(
            state.forecasts.find((forecast) => forecast.id === output.forecastId) ?? null,
            nestedInclude(include.forecast),
            state
          )
        }
      : {}),
    ...(include?.vehicle
      ? {
          vehicle: attachVehicleInclude(
            state.vehicles.find((vehicle) => vehicle.id === output.vehicleId) ?? null,
            nestedInclude(include.vehicle),
            state
          )
        }
      : {})
  };
}

function sortForecasts(forecasts: VehicleResidualForecast[], orderBy: unknown) {
  if (!orderBy) {
    return;
  }
  forecasts.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

function sortModelRuns(runs: ResidualModelRun[], orderBy: unknown) {
  if (!orderBy) {
    return;
  }
  runs.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
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
    modelDefinitionId: null,
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

function makeForecastCurvePoints() {
  return [
    makeCurvePoint({ ageMonth: 24, id: "curve-point-24", predictedResidualAmount: 12000000n }),
    makeCurvePoint({ ageMonth: 30, id: "curve-point-30", predictedResidualAmount: 11000000n }),
    makeCurvePoint({ ageMonth: 36, id: "curve-point-36", predictedResidualAmount: 10000000n }),
    makeCurvePoint({ ageMonth: 48, id: "curve-point-48", predictedResidualAmount: 8000000n }),
    makeCurvePoint({ ageMonth: 60, id: "curve-point-60", predictedResidualAmount: 6000000n })
  ];
}

function makeModelDefinition(overrides: Partial<VehicleModelDefinition> = {}): VehicleModelDefinition {
  return {
    batteryCapacityKwh: new Prisma.Decimal(75),
    bodyType: null,
    brand: "NIO",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: null,
    customerDisplayName: "ET5",
    deletedAt: null,
    displayName: "NIO ET5",
    driveType: null,
    enabled: true,
    energyType: null,
    id: "00000000-0000-4000-8000-000000000e50",
    legacyVehicleModel: VehicleModel.ET5,
    modelCode: "ET5",
    modelName: "ET5",
    modelYear: 2024,
    officialRangeKm: null,
    portalVisible: true,
    remark: null,
    seatCount: null,
    series: "ET5",
    snapshot: null,
    sortOrder: 10,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: null,
    variantName: null,
    ...overrides
  };
}

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    acquisitionMode: VehicleAcquisitionMode.OWNED_CASH,
    assetLocation: "Shanghai",
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    currentMileageKm: 25000,
    currentSalePriceAmount: 13000000n,
    currentSalePriceInitializedAt: null,
    currentSalePriceReviewedAt: null,
    deletedAt: null,
    id: "vehicle-1",
    model: "ET5",
    modelYear: 2024,
    nextSalePriceReviewAt: null,
    plateNo: "沪A12345",
    purchaseDate: new Date("2024-06-01T00:00:00.000Z"),
    purchasePriceAmount: 20000000n,
    registrationDate: new Date("2024-06-01T00:00:00.000Z"),
    latestRegistrationDate: null,
    remark: null,
    salePriceReinitRequiredAt: null,
    salePriceStatus: SalePriceStatus.EFFECTIVE,
    series: "ET5",
    status: VehicleStatus.AVAILABLE,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    modelDefinitionId: null,
    vehicleModel: VehicleModel.ET5,
    vehicleNo: "VH20260601000000A1B2",
    vin: "LJ1TEST0000000001",
    ...overrides
  };
}

function makeForecast(overrides: Partial<VehicleResidualForecast> = {}): VehicleResidualForecast {
  return {
    asOfDate: new Date("2026-06-01T00:00:00.000Z"),
    batteryCapacityKwh: new Prisma.Decimal(75),
    batteryUsageType: VehicleBatteryUsageType.BUYOUT,
    brand: "NIO",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    curveId: "curve-1",
    curveSnapshot: null,
    currentMileageKm: 25000,
    currentSalePriceAmount: 13000000n,
    deletedAt: null,
    forecastMethod: VehicleResidualForecastMethod.CURVE_STATISTICAL,
    forecastNo: "VRF20260601000000A1B2",
    forecastStatus: VehicleResidualForecastStatus.GENERATED,
    id: "forecast-1",
    inputSnapshot: null,
    metrics: null,
    model: "ET5",
    modelDefinitionId: null,
    modelYear: 2024,
    purchasePriceAmount: 20000000n,
    remark: null,
    series: "ET5",
    trim: null,
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    vehicleAgeMonths: 24,
    vehicleId: "vehicle-1",
    vehicleSnapshot: null,
    ...overrides
  };
}

function makeForecastPoint(
  overrides: Partial<VehicleResidualForecastPoint> = {}
): VehicleResidualForecastPoint {
  return {
    adoptedAt: null,
    adoptedBy: null,
    adoptedResidualAmount: null,
    adoptRemark: null,
    confidenceScore: 80,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    forecastId: "forecast-1",
    horizonMonth: 0,
    id: "forecast-point-1",
    interpolationMethod: ResidualForecastInterpolationMethod.EXACT,
    lowerBoundAmount: 11000000n,
    matchedCurvePointAgeMonth: 24,
    pointSnapshot: null,
    pointStatus: VehicleResidualForecastPointStatus.GENERATED,
    predictedResidualAmount: 12000000n,
    predictedResidualRateBps: 6000,
    targetAgeMonth: 24,
    targetDate: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    upperBoundAmount: 13000000n,
    ...overrides
  };
}

function makeModelRun(overrides: Partial<ResidualModelRun> = {}): ResidualModelRun {
  return {
    algorithm: ResidualModelAlgorithm.STATISTICAL_MEDIAN,
    artifactUri: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    createdBy: user.id,
    deletedAt: null,
    errorSnapshot: null,
    featureSnapshot: { features: ["ageMonth", "mileageKm"] },
    filterSnapshot: { priceTypes: ["TRANSACTION"] },
    finishedAt: null,
    id: "model-run-1",
    metricsSnapshot: null,
    modelName: "statistical_median_curve",
    modelProvider: "internal",
    modelVersion: "v2026.06.10",
    outputSnapshot: null,
    parameterSnapshot: { minSamplePerPoint: 3 },
    remark: null,
    runName: "ET5 residual baseline",
    runNo: "RMR20260601000000A1B2",
    runStatus: ResidualModelRunStatus.CREATED,
    runType: ResidualModelRunType.STATISTICAL_BASELINE,
    sampleCount: 120,
    startedAt: null,
    targetBatteryCapacityKwh: new Prisma.Decimal(75),
    targetBatteryUsageType: VehicleBatteryUsageType.BUYOUT,
    targetBrand: "NIO",
    targetModelDefinitionId: null,
    targetModel: "ET5",
    targetModelYear: 2024,
    targetSeries: "ET5",
    targetTrim: null,
    targetType: ResidualModelTargetType.RESIDUAL_CURVE,
    trainingDataEndDate: new Date("2026-06-30T00:00:00.000Z"),
    trainingDataStartDate: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedBy: user.id,
    ...overrides
  };
}

function makeModelRunOutput(
  overrides: Partial<ResidualModelRunOutput> = {}
): ResidualModelRunOutput {
  return {
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    curveId: null,
    deletedAt: null,
    forecastId: null,
    id: "model-run-output-1",
    outputNo: null,
    outputSnapshot: null,
    outputStatus: ResidualModelRunOutputStatus.ACTIVE,
    outputType: ResidualModelRunOutputType.RESIDUAL_CURVE,
    remark: null,
    runId: "model-run-1",
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    vehicleId: null,
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
    modelDefinitionId: null,
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
