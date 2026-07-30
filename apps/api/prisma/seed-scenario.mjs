import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const outputDir = path.join(repoRoot, ".tmp", "scenarios");

config({ path: path.join(repoRoot, ".env") });
config({ path: path.join(apiRoot, ".env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for scenario seeding.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

const scenarioScopes = {
  all: {
    dataPrefix: "SCN9_",
    files: ["mainline.json", "residual.json"],
    vinPrefix: "SCN9"
  },
  cleanup: {
    dataPrefix: "SCN9_",
    files: ["mainline.json", "residual.json"],
    vinPrefix: "SCN9"
  },
  mainline: {
    dataPrefix: "SCN9_MAINLINE_",
    files: ["mainline.json"],
    vinPrefix: "SCN9MAINLINE"
  },
  residual: {
    dataPrefix: "SCN9_RESIDUAL_",
    files: ["residual.json"],
    vinPrefix: "SCN9RESIDUAL"
  }
};

const scenarioDate = new Date("2026-06-13T00:00:00.000Z");
const effectiveFrom = new Date("2026-06-01T00:00:00.000Z");
const effectiveTo = new Date("2027-06-01T00:00:00.000Z");

async function main() {
  const scenario = process.argv[2];

  if (!scenario || !["mainline", "residual", "all", "cleanup"].includes(scenario)) {
    printUsageAndExit();
  }

  if (scenario === "cleanup") {
    const cleanup = await cleanupScenario("cleanup");
    console.log(JSON.stringify({ cleanup, scenario: "cleanup" }, jsonReplacer, 2));
    return;
  }

  if (scenario === "all") {
    const cleanup = await cleanupScenario("cleanup");
    const mainline = await seedMainline({ cleanupFirst: false });
    const residual = await seedResidual({ cleanupFirst: false });
    console.log(JSON.stringify({ cleanup, mainline, residual, scenario: "all" }, jsonReplacer, 2));
    return;
  }

  if (scenario === "mainline") {
    const output = await seedMainline({ cleanupFirst: true });
    console.log(JSON.stringify(output, jsonReplacer, 2));
    return;
  }

  if (scenario === "residual") {
    const output = await seedResidual({ cleanupFirst: true });
    console.log(JSON.stringify(output, jsonReplacer, 2));
  }
}

async function seedMainline({ cleanupFirst }) {
  if (cleanupFirst) {
    await cleanupScenario("mainline");
  }

  const operator = await getOperator();
  const plan = await getActiveSubscriptionPlan();
  const createdAt = new Date().toISOString();

  const customer = await prisma.customer.create({
    data: {
      createdBy: operator.id,
      customerNo: "SCN9_MAINLINE_CUSTOMER_001",
      customerType: "PERSONAL",
      mobile: "19990090001",
      name: "SCN9_MAINLINE Customer",
      ownerUserId: operator.id,
      remark: "SCN9_MAINLINE_ scenario seed customer",
      sourceChannel: "SCENARIO_SEED",
      status: "LEAD",
      updatedBy: operator.id
    }
  });

  const vehicle = await createScenarioVehicle({
    currentMileageKm: 1200,
    currentSalePriceAmount: 16500000,
    operatorId: operator.id,
    plateNo: "SCN9M001",
    purchasePriceAmount: 18000000,
    remark: "SCN9_MAINLINE_ dedicated vehicle",
    vehicleNo: "SCN9_MAINLINE_VEHICLE_001",
    vin: "SCN9MAINLINE000001"
  });

  const application = await prisma.application.create({
    data: {
      applicationNo: "SCN9_MAINLINE_APP_001",
      applicationSource: "SELF_SERVICE",
      createdBy: operator.id,
      customerId: customer.id,
      intendedModel: "ET5",
      intendedPeriodMonths: plan.minPeriodMonths,
      intentPeriodMonths: plan.minPeriodMonths,
      intentSnapshot: {
        scenario: "mainline",
        subscriptionPlanId: plan.id,
        vehicleId: vehicle.id
      },
      intentSubscriptionPlanId: plan.id,
      intentVehicleBaseFeeAmount: plan.baseMonthlyFeeAmount,
      intentVehicleId: vehicle.id,
      salesUserId: operator.id,
      status: "SUBMITTED",
      submittedAt: scenarioDate,
      updatedBy: operator.id
    }
  });

  const output = {
    scenario: "mainline",
    coverage: "customer_application_vehicle_plan",
    createdAt,
    customerId: customer.id,
    applicationId: application.id,
    vehicleId: vehicle.id,
    subscriptionPlanId: plan.id,
    quoteId: null,
    orderId: null,
    contractId: null
  };

  await writeScenarioOutput("mainline", output);
  return output;
}

async function seedResidual({ cleanupFirst }) {
  if (cleanupFirst) {
    await cleanupScenario("residual");
  }

  const operator = await getOperator();
  const createdAt = new Date().toISOString();

  const vehicle = await createScenarioVehicle({
    currentMileageKm: 8500,
    currentSalePriceAmount: 15200000,
    operatorId: operator.id,
    plateNo: "SCN9R001",
    purchasePriceAmount: 18600000,
    remark: "SCN9_RESIDUAL_ dedicated vehicle",
    vehicleNo: "SCN9_RESIDUAL_VEHICLE_001",
    vin: "SCN9RESIDUAL000001"
  });

  const batch = await prisma.marketPriceImportBatch.create({
    data: {
      batchNo: "SCN9_RESIDUAL_BATCH_001",
      fileName: "SCN9_RESIDUAL_market_observations.csv",
      importedBy: operator.id,
      importedRows: 6,
      importStatus: "COMPLETED",
      remark: "SCN9_RESIDUAL_ scenario seed import batch",
      skippedRows: 0,
      source: "MANUAL",
      totalRows: 6
    }
  });

  await prisma.vehicleMarketPriceObservation.createMany({
    data: buildResidualObservations(batch.id, operator.id)
  });

  const curve = await prisma.vehicleResidualCurve.create({
    data: {
      batteryCapacityKwh: "75.00",
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      confidenceScore: 86,
      createdBy: operator.id,
      curveMethod: "STATISTICAL_MEDIAN",
      curveName: "SCN9_RESIDUAL ET5 Curve",
      curveNo: "SCN9_RESIDUAL_CURVE_001",
      curveStatus: "ACTIVE",
      curveVersion: "SCN9-2026Q2",
      effectiveFrom,
      effectiveTo,
      generatedAt: scenarioDate,
      metrics: {
        scenario: "residual",
        source: "seed-scenario"
      },
      model: "ET5",
      modelYear: 2026,
      pointCount: 3,
      priceTypes: ["TRANSACTION", "LISTING"],
      referencePriceAmount: BigInt(18600000),
      remark: "SCN9_RESIDUAL_ active curve for smoke and manual acceptance",
      sampleCount: 6,
      sampleEndDate: scenarioDate,
      sampleFilterSnapshot: {
        brand: "NIO",
        model: "ET5",
        scenario: "residual"
      },
      sampleStartDate: new Date("2026-03-01T00:00:00.000Z"),
      series: "ET5",
      snapshot: {
        scenario: "residual",
        vehicleId: vehicle.id
      },
      updatedBy: operator.id
    }
  });

  const curvePoints = [];
  for (const point of [
    { ageMonth: 12, amount: 14880000, rate: 8000 },
    { ageMonth: 24, amount: 13200000, rate: 7097 },
    { ageMonth: 36, amount: 11800000, rate: 6344 }
  ]) {
    curvePoints.push(
      await prisma.vehicleResidualCurvePoint.create({
        data: {
          averagePriceAmount: BigInt(point.amount),
          confidenceScore: 84,
          curveId: curve.id,
          ageMonth: point.ageMonth,
          lowerBoundAmount: BigInt(point.amount - 600000),
          maxPriceAmount: BigInt(point.amount + 800000),
          medianPriceAmount: BigInt(point.amount),
          minPriceAmount: BigInt(point.amount - 900000),
          p25PriceAmount: BigInt(point.amount - 400000),
          p75PriceAmount: BigInt(point.amount + 400000),
          pointSnapshot: {
            scenario: "residual"
          },
          predictedResidualAmount: BigInt(point.amount),
          predictedResidualRateBps: point.rate,
          sampleCount: 2,
          upperBoundAmount: BigInt(point.amount + 600000)
        }
      })
    );
  }

  const forecast = await prisma.vehicleResidualForecast.create({
    data: {
      asOfDate: scenarioDate,
      batteryCapacityKwh: "75.00",
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      createdBy: operator.id,
      currentMileageKm: vehicle.currentMileageKm,
      currentSalePriceAmount: vehicle.currentSalePriceAmount,
      curveId: curve.id,
      curveSnapshot: {
        curveNo: curve.curveNo,
        scenario: "residual"
      },
      forecastMethod: "CURVE_STATISTICAL",
      forecastNo: "SCN9_RESIDUAL_FORECAST_001",
      forecastStatus: "GENERATED",
      inputSnapshot: {
        scenario: "residual"
      },
      metrics: {
        confidenceScore: 84,
        scenario: "residual"
      },
      model: "ET5",
      modelYear: 2026,
      purchasePriceAmount: vehicle.purchasePriceAmount,
      remark: "SCN9_RESIDUAL_ forecast for smoke and manual acceptance",
      series: "ET5",
      updatedBy: operator.id,
      vehicleAgeMonths: 6,
      vehicleId: vehicle.id,
      vehicleSnapshot: {
        vehicleNo: vehicle.vehicleNo,
        vin: vehicle.vin
      }
    }
  });

  const forecastPoints = [];
  for (const point of [
    { horizonMonth: 12, targetAgeMonth: 18, amount: 14400000, rate: 7742 },
    { horizonMonth: 24, targetAgeMonth: 30, amount: 12600000, rate: 6774 },
    { horizonMonth: 36, targetAgeMonth: 42, amount: 11200000, rate: 6022 }
  ]) {
    forecastPoints.push(
      await prisma.vehicleResidualForecastPoint.create({
        data: {
          confidenceScore: 84,
          forecastId: forecast.id,
          horizonMonth: point.horizonMonth,
          interpolationMethod: "LINEAR_INTERPOLATION",
          lowerBoundAmount: BigInt(point.amount - 600000),
          matchedCurvePointAgeMonth: point.targetAgeMonth <= 24 ? 24 : 36,
          pointSnapshot: {
            scenario: "residual"
          },
          pointStatus: "GENERATED",
          predictedResidualAmount: BigInt(point.amount),
          predictedResidualRateBps: point.rate,
          targetAgeMonth: point.targetAgeMonth,
          targetDate: addMonths(scenarioDate, point.horizonMonth),
          upperBoundAmount: BigInt(point.amount + 600000)
        }
      })
    );
  }

  const adoptablePoint = forecastPoints[0];
  const valuationReview = await prisma.vehicleValuationReview.create({
    data: {
      adoptedResidualAmount: null,
      beforeSnapshot: {
        currentSalePriceAmount: vehicle.currentSalePriceAmount.toString(),
        scenario: "residual"
      },
      createdBy: operator.id,
      forecastAmountSource: "SCN9_RESIDUAL_FORECAST",
      forecastConfidenceScore: adoptablePoint.confidenceScore,
      forecastHorizonMonth: adoptablePoint.horizonMonth,
      forecastId: forecast.id,
      forecastPointId: adoptablePoint.id,
      forecastResidualAmount: adoptablePoint.predictedResidualAmount,
      forecastSnapshot: {
        forecastNo: forecast.forecastNo,
        forecastPointId: adoptablePoint.id,
        scenario: "residual"
      },
      forecastTargetDate: adoptablePoint.targetDate,
      originalSalePriceAmount: vehicle.currentSalePriceAmount,
      reason: "SCN9_RESIDUAL_ pending valuation review from forecast point",
      requestedBy: operator.id,
      requestedSalePriceAmount: adoptablePoint.predictedResidualAmount ?? vehicle.currentSalePriceAmount,
      reviewNo: "SCN9_RESIDUAL_REVIEW_001",
      reviewSource: "RESIDUAL_FORECAST",
      reviewStatus: "PENDING",
      snapshot: {
        scenario: "residual"
      },
      updatedBy: operator.id,
      vehicleId: vehicle.id
    }
  });

  const output = {
    scenario: "residual",
    coverage: "vehicle_market_curve_forecast_pending_review",
    createdAt,
    vehicleId: vehicle.id,
    importBatchId: batch.id,
    curveId: curve.id,
    curvePointId: curvePoints[0]?.id ?? null,
    forecastId: forecast.id,
    forecastPointId: adoptablePoint.id,
    valuationReviewId: valuationReview.id
  };

  await writeScenarioOutput("residual", output);
  return output;
}

async function createScenarioVehicle({
  currentMileageKm,
  currentSalePriceAmount,
  operatorId,
  plateNo,
  purchasePriceAmount,
  remark,
  vehicleNo,
  vin
}) {
  const modelDefinition = await getVehicleModelDefinitionByCode("NIO_ET5");
  const vehicle = await prisma.vehicle.create({
    data: {
      assetLocation: "SCN9 acceptance pool",
      batteryCapacityKwh: "75.00",
      batteryUsageType: "BUYOUT",
      brand: "NIO",
      createdBy: operatorId,
      currentMileageKm,
      currentSalePriceAmount: BigInt(currentSalePriceAmount),
      currentSalePriceInitializedAt: scenarioDate,
      currentSalePriceReviewedAt: scenarioDate,
      latestRegistrationDate: new Date("2026-05-20T00:00:00.000Z"),
      model: "ET5",
      modelDefinition: { connect: { id: modelDefinition.id } },
      modelYear: 2026,
      nextSalePriceReviewAt: new Date("2026-09-01T00:00:00.000Z"),
      plateNo,
      purchaseDate: new Date("2026-05-20T00:00:00.000Z"),
      purchasePriceAmount: BigInt(purchasePriceAmount),
      registrationDate: new Date("2026-05-20T00:00:00.000Z"),
      remark,
      salePriceStatus: "EFFECTIVE",
      series: "ET5",
      status: "AVAILABLE",
      updatedBy: operatorId,
      vehicleNo,
      vin
    }
  });

  await prisma.vehicleInsurancePolicy.createMany({
    data: [
      {
        createdBy: operatorId,
        effectiveFrom,
        effectiveTo,
        insurerName: "SCN9 Insurance",
        policyNo: `${vehicleNo}-COMPULSORY`,
        policyStatus: "ACTIVE",
        policyType: "COMPULSORY_TRAFFIC",
        updatedBy: operatorId,
        vehicleId: vehicle.id
      },
      {
        createdBy: operatorId,
        effectiveFrom,
        effectiveTo,
        insurerName: "SCN9 Insurance",
        policyNo: `${vehicleNo}-COMMERCIAL`,
        policyStatus: "ACTIVE",
        policyType: "COMMERCIAL",
        updatedBy: operatorId,
        vehicleId: vehicle.id
      }
    ]
  });

  await prisma.vehicleSalePriceHistory.create({
    data: {
      afterSalePriceAmount: BigInt(currentSalePriceAmount),
      beforeSalePriceAmount: null,
      createdBy: operatorId,
      effectiveFrom,
      reason: `${vehicleNo} initial sale price for Stage 9C scenario seed`,
      remark,
      reviewQuarter: "2026Q2",
      reviewType: "INITIAL_POOL",
      vehicleId: vehicle.id
    }
  });

  return vehicle;
}

async function getVehicleModelDefinitionByCode(modelCode) {
  const definition = await prisma.vehicleModelDefinition.findFirst({
    select: {
      id: true,
      modelCode: true
    },
    where: {
      deletedAt: null,
      enabled: true,
      modelCode
    }
  });

  if (!definition) {
    throw new Error(`VehicleModelDefinition is required for scenario vehicle model code ${modelCode}.`);
  }

  return definition;
}

function buildResidualObservations(batchId, operatorId) {
  const samples = [
    ["001", 12, 14600000, 7500],
    ["002", 12, 15100000, 9200],
    ["003", 24, 13000000, 16800],
    ["004", 24, 13400000, 18500],
    ["005", 36, 11600000, 24800],
    ["006", 36, 12100000, 27200]
  ];

  return samples.map(([suffix, ageMonth, priceAmount, mileageKm]) => ({
    batchId,
    batteryCapacityKwh: "75.00",
    batteryHealthPercent: "93.00",
    batteryUsageType: "BUYOUT",
    brand: "NIO",
    city: "Shanghai",
    confidenceScore: 85,
    conditionGrade: "A",
    createdBy: operatorId,
    dedupeKey: `SCN9_RESIDUAL_DEDUPE_${suffix}`,
    listingDays: 12,
    listingPriceAmount: BigInt(priceAmount + 200000),
    mileageKm,
    model: "ET5",
    modelYear: 2026,
    observationNo: `SCN9_RESIDUAL_OBS_${suffix}`,
    observedAt: new Date("2026-06-01T00:00:00.000Z"),
    observationStatus: "ACTIVE",
    priceAmount: BigInt(priceAmount),
    priceType: suffix === "001" || suffix === "003" || suffix === "005" ? "TRANSACTION" : "LISTING",
    province: "Shanghai",
    rawSnapshot: {
      scenario: "residual",
      suffix
    },
    registrationDate: addMonths(scenarioDate, -ageMonth),
    remark: "SCN9_RESIDUAL_ market observation",
    sellerType: "DEALER",
    series: "ET5",
    source: "MANUAL",
    sourceListingId: `SCN9_RESIDUAL_LISTING_${suffix}`,
    transactionPriceAmount: BigInt(priceAmount),
    updatedBy: operatorId,
    vehicleAgeMonths: ageMonth
  }));
}

async function cleanupScenario(scopeName) {
  const scope = scenarioScopes[scopeName];
  const counts = {};

  const [vehicles, customers, applications, quotes, orders, contracts, curves, forecasts, batches] =
    await Promise.all([
      prisma.vehicle.findMany({
        select: { id: true },
        where: {
          OR: [
            { vehicleNo: { startsWith: scope.dataPrefix } },
            { vin: { startsWith: scope.vinPrefix } }
          ]
        }
      }),
      prisma.customer.findMany({
        select: { id: true },
        where: { customerNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.application.findMany({
        select: { id: true },
        where: { applicationNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.subscriptionQuote.findMany({
        select: { id: true },
        where: { quoteNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.subscriptionOrder.findMany({
        select: { id: true },
        where: { orderNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.contract.findMany({
        select: { id: true },
        where: { contractNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.vehicleResidualCurve.findMany({
        select: { id: true },
        where: { curveNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.vehicleResidualForecast.findMany({
        select: { id: true },
        where: { forecastNo: { startsWith: scope.dataPrefix } }
      }),
      prisma.marketPriceImportBatch.findMany({
        select: { id: true },
        where: { batchNo: { startsWith: scope.dataPrefix } }
      })
    ]);

  const vehicleIds = vehicles.map(({ id }) => id);
  const customerIds = customers.map(({ id }) => id);
  const applicationIds = applications.map(({ id }) => id);
  const quoteIds = quotes.map(({ id }) => id);
  const orderIds = orders.map(({ id }) => id);
  const contractIds = contracts.map(({ id }) => id);
  const curveIds = curves.map(({ id }) => id);
  const forecastIds = forecasts.map(({ id }) => id);
  const batchIds = batches.map(({ id }) => id);

  await record(
    counts,
    "vehicleValuationReview",
    prisma.vehicleValuationReview.deleteMany({
      where: {
        OR: [
          { reviewNo: { startsWith: scope.dataPrefix } },
          ...whereIn("vehicleId", vehicleIds),
          ...whereIn("forecastId", forecastIds)
        ]
      }
    })
  );
  await record(
    counts,
    "residualModelRunOutput",
    prisma.residualModelRunOutput.deleteMany({
      where: orWhere([
        ...whereIn("vehicleId", vehicleIds),
        ...whereIn("curveId", curveIds),
        ...whereIn("forecastId", forecastIds)
      ])
    })
  );
  await record(
    counts,
    "vehicleResidualForecastPoint",
    prisma.vehicleResidualForecastPoint.deleteMany({
      where: orWhere([...whereIn("forecastId", forecastIds)])
    })
  );
  await record(
    counts,
    "vehicleResidualForecast",
    prisma.vehicleResidualForecast.deleteMany({
      where: {
        OR: [
          { forecastNo: { startsWith: scope.dataPrefix } },
          ...whereIn("id", forecastIds),
          ...whereIn("vehicleId", vehicleIds),
          ...whereIn("curveId", curveIds)
        ]
      }
    })
  );
  await record(
    counts,
    "vehicleResidualCurvePoint",
    prisma.vehicleResidualCurvePoint.deleteMany({
      where: orWhere([...whereIn("curveId", curveIds)])
    })
  );
  await record(
    counts,
    "vehicleResidualCurve",
    prisma.vehicleResidualCurve.deleteMany({
      where: { OR: [{ curveNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", curveIds)] }
    })
  );
  await record(
    counts,
    "vehicleMarketPriceObservation",
    prisma.vehicleMarketPriceObservation.deleteMany({
      where: {
        OR: [
          { observationNo: { startsWith: scope.dataPrefix } },
          { dedupeKey: { startsWith: scope.dataPrefix } },
          ...whereIn("batchId", batchIds)
        ]
      }
    })
  );
  await record(
    counts,
    "marketPriceImportBatch",
    prisma.marketPriceImportBatch.deleteMany({
      where: { OR: [{ batchNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", batchIds)] }
    })
  );

  await cleanupOrderGraph(counts, orderIds);

  await record(
    counts,
    "contract",
    prisma.contract.deleteMany({
      where: { OR: [{ contractNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", contractIds)] }
    })
  );
  await record(
    counts,
    "subscriptionOrder",
    prisma.subscriptionOrder.deleteMany({
      where: { OR: [{ orderNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", orderIds)] }
    })
  );
  await record(
    counts,
    "subscriptionQuote",
    prisma.subscriptionQuote.deleteMany({
      where: { OR: [{ quoteNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", quoteIds)] }
    })
  );

  await record(
    counts,
    "riskResult",
    prisma.riskResult.deleteMany({ where: orWhere([...whereIn("applicationId", applicationIds)]) })
  );
  await record(
    counts,
    "applicationActionLog",
    prisma.applicationActionLog.deleteMany({
      where: orWhere([...whereIn("applicationId", applicationIds)])
    })
  );
  await record(
    counts,
    "applicationMaterialFile",
    prisma.applicationMaterialFile.deleteMany({
      where: orWhere([...whereIn("applicationId", applicationIds)])
    })
  );
  await record(
    counts,
    "applicationMaterialGroup",
    prisma.applicationMaterialGroup.deleteMany({
      where: orWhere([...whereIn("applicationId", applicationIds)])
    })
  );
  await record(
    counts,
    "applicationMaterial",
    prisma.applicationMaterial.deleteMany({
      where: orWhere([...whereIn("applicationId", applicationIds)])
    })
  );
  await record(
    counts,
    "application",
    prisma.application.deleteMany({
      where: { OR: [{ applicationNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", applicationIds)] }
    })
  );

  await record(
    counts,
    "customerFollowup",
    prisma.customerFollowup.deleteMany({ where: orWhere([...whereIn("customerId", customerIds)]) })
  );
  await record(
    counts,
    "customerIdentity",
    prisma.customerIdentity.deleteMany({ where: orWhere([...whereIn("customerId", customerIds)]) })
  );
  await record(
    counts,
    "customerProfile",
    prisma.customerProfile.deleteMany({ where: orWhere([...whereIn("customerId", customerIds)]) })
  );
  await record(
    counts,
    "customer",
    prisma.customer.deleteMany({
      where: { OR: [{ customerNo: { startsWith: scope.dataPrefix } }, ...whereIn("id", customerIds)] }
    })
  );

  await record(
    counts,
    "vehicleInsurancePolicy",
    prisma.vehicleInsurancePolicy.deleteMany({
      where: orWhere([...whereIn("vehicleId", vehicleIds)])
    })
  );
  await record(
    counts,
    "vehicleSalePriceHistory",
    prisma.vehicleSalePriceHistory.deleteMany({
      where: {
        OR: [
          ...whereIn("vehicleId", vehicleIds),
          { reason: { contains: scope.dataPrefix } },
          { remark: { contains: scope.dataPrefix } }
        ]
      }
    })
  );
  await record(
    counts,
    "vehicle",
    prisma.vehicle.deleteMany({
      where: {
        OR: [
          { vehicleNo: { startsWith: scope.dataPrefix } },
          { vin: { startsWith: scope.vinPrefix } },
          ...whereIn("id", vehicleIds)
        ]
      }
    })
  );

  await removeScenarioOutputs(scope.files);

  return {
    scope: scopeName,
    counts
  };
}

async function cleanupOrderGraph(counts, orderIds) {
  await record(
    counts,
    "orderEntitlementUsage",
    prisma.orderEntitlementUsage.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "orderEntitlementGrant",
    prisma.orderEntitlementGrant.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "orderEntitlementAccount",
    prisma.orderEntitlementAccount.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "collectionAction",
    prisma.collectionAction.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "collectionCaseBill",
    prisma.collectionCaseBill.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "collectionCase",
    prisma.collectionCase.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "depositLedger",
    prisma.depositLedger.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "paymentWriteOff",
    prisma.paymentWriteOff.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "paymentRecord",
    prisma.paymentRecord.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "receivableBill",
    prisma.receivableBill.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "vehicleReturnDamage",
    prisma.vehicleReturnDamage.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "vehicleReturn",
    prisma.vehicleReturn.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "vehicleDelivery",
    prisma.vehicleDelivery.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
  await record(
    counts,
    "orderChange",
    prisma.orderChange.deleteMany({ where: orWhere([...whereIn("orderId", orderIds)]) })
  );
}

async function getOperator() {
  const operator = await prisma.user.findFirst({
    where: {
      username: "admin"
    }
  });

  if (!operator) {
    throw new Error("Cannot find admin operator. Run pnpm prisma:seed before scenario seed.");
  }

  return operator;
}

async function getActiveSubscriptionPlan() {
  const plan = await prisma.subscriptionPlan.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      deletedAt: null,
      status: "ACTIVE"
    }
  });

  if (!plan) {
    throw new Error("Cannot find ACTIVE subscription plan. Run pnpm prisma:seed before scenario seed.");
  }

  return plan;
}

async function writeScenarioOutput(name, output) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, `${name}.json`), `${JSON.stringify(output, jsonReplacer, 2)}\n`, "utf8");
}

async function removeScenarioOutputs(files) {
  await Promise.all(files.map((file) => rm(path.join(outputDir, file), { force: true })));
}

async function record(counts, key, promise) {
  const result = await promise;
  counts[key] = result.count;
  return result;
}

function whereIn(field, ids) {
  if (ids.length === 0) {
    return [];
  }

  return [{ [field]: { in: ids } }];
}

function orWhere(conditions) {
  if (conditions.length === 0) {
    return { id: { in: [] } };
  }

  return { OR: conditions };
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function printUsageAndExit() {
  console.error("Usage: pnpm seed:scenario <mainline|residual|all|cleanup>");
  process.exit(1);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
