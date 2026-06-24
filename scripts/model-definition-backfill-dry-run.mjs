import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));
const [{ PrismaPg }, { PrismaClient }, { config }] = await Promise.all([
  import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
  import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href),
  import(pathToFileURL(requireFromApi.resolve("dotenv")).href)
]);

config({ path: resolve(repoRoot, ".env") });
config({ path: resolve(repoRoot, "apps/api/.env") });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for modelDefinitionId backfill dry-run.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(normalizeLocalhostDatabaseUrl(databaseUrl))
});

async function main() {
  const report = await buildReport();
  console.log(JSON.stringify(report, null, 2));
}

async function buildReport() {
  const definitions = await prisma.vehicleModelDefinition.findMany({
    select: {
      brand: true,
      deletedAt: true,
      displayName: true,
      enabled: true,
      id: true,
      legacyVehicleModel: true,
      modelCode: true,
      modelName: true,
      series: true
    }
  });
  const vehicles = await prisma.vehicle.findMany({
    select: { id: true, model: true, modelDefinitionId: true, series: true, vehicleModel: true }
  });
  const quotes = await prisma.subscriptionQuote.findMany({
    select: {
      id: true,
      vehicleModel: true,
      vehicle: { select: { id: true, modelDefinitionId: true, vehicleModel: true } }
    }
  });
  const orders = await prisma.subscriptionOrder.findMany({
    select: {
      id: true,
      vehicleModel: true,
      vehicle: { select: { id: true, modelDefinitionId: true, vehicleModel: true } }
    }
  });
  const vehiclePackages = await prisma.vehiclePackage.findMany({
    select: { id: true, modelDefinitionId: true, packageNo: true, vehicleModel: true }
  });
  const productPriceRules = await prisma.productPriceRule.findMany({
    select: { id: true, modelDefinitionId: true, vehicleModel: true }
  });
  const observations = await prisma.vehicleMarketPriceObservation.findMany({
    select: { brand: true, id: true, model: true, modelDefinitionId: true, series: true }
  });
  const curves = await prisma.vehicleResidualCurve.findMany({
    select: { brand: true, curveNo: true, curveStatus: true, id: true, model: true, modelDefinitionId: true, series: true }
  });
  const forecasts = await prisma.vehicleResidualForecast.findMany({
    select: {
      brand: true,
      curve: { select: { brand: true, curveStatus: true, id: true, model: true, modelDefinitionId: true, series: true } },
      curveId: true,
      forecastNo: true,
      forecastStatus: true,
      id: true,
      model: true,
      modelDefinitionId: true,
      series: true,
      vehicle: { select: { id: true, modelDefinitionId: true, vehicleModel: true } },
      vehicleId: true
    }
  });
  const modelRuns = await prisma.residualModelRun.findMany({
    select: {
      id: true,
      runNo: true,
      runStatus: true,
      targetBrand: true,
      targetModel: true,
      targetModelDefinitionId: true,
      targetSeries: true,
      targetType: true
    }
  });

  const context = createMappingContext(definitions);

  return {
    generatedAt: new Date().toISOString(),
    noOp: true,
    vehicleModelDefinitions: summarizeDefinitions(definitions),
    vehicle: analyzeLegacyModelTable(vehicles, context),
    quote: analyzeSnapshotTable(quotes, context),
    order: analyzeSnapshotTable(orders, context),
    product: {
      vehiclePackage: analyzeLegacyModelTable(vehiclePackages, context),
      productPriceRule: analyzeLegacyModelTable(productPriceRules, context)
    },
    residual: {
      marketPriceObservation: analyzeResidualDimensionTable(observations, context),
      residualCurve: {
        ...analyzeResidualDimensionTable(curves, context),
        curveStatusDistribution: distribution(curves, (curve) => curve.curveStatus)
      },
      residualForecast: analyzeForecastTable(forecasts, context),
      residualModelRun: analyzeModelRunTable(modelRuns, context)
    }
  };
}

function summarizeDefinitions(definitions) {
  const liveDefinitions = definitions.filter((definition) => !definition.deletedAt);
  const legacyValues = liveDefinitions.map((definition) => definition.legacyVehicleModel).filter(Boolean);

  return {
    total: definitions.length,
    live: liveDefinitions.length,
    enabled: liveDefinitions.filter((definition) => definition.enabled).length,
    disabled: liveDefinitions.filter((definition) => !definition.enabled).length,
    withLegacyVehicleModel: legacyValues.length,
    withoutLegacyVehicleModel: liveDefinitions.length - legacyValues.length,
    legacyVehicleModelDistribution: distribution(liveDefinitions, (definition) => definition.legacyVehicleModel ?? "(none)"),
    duplicateLegacyVehicleModels: duplicates(legacyValues)
  };
}

function createMappingContext(definitions) {
  const liveDefinitions = definitions.filter((definition) => !definition.deletedAt);

  return {
    definitionById: new Map(definitions.map((definition) => [definition.id, definition])),
    resolveByLegacy(vehicleModel) {
      const legacyModel = clean(vehicleModel);
      if (!legacyModel) {
        return { status: "unmatched", reason: "missing legacy vehicleModel" };
      }

      const matches = liveDefinitions.filter((definition) => definition.legacyVehicleModel === legacyModel);
      return resolution(matches, `legacy vehicleModel ${legacyModel}`);
    },
    resolveByResidualDimension({ brand, model, series }) {
      const normalizedBrand = clean(brand);
      const normalizedModel = clean(model);
      const normalizedSeries = clean(series);

      if (!normalizedBrand || !normalizedModel) {
        return { status: "unmatched", reason: "missing brand or model" };
      }

      const matches = liveDefinitions.filter((definition) => {
        const modelMatches = definition.modelName === normalizedModel || definition.modelCode === normalizedModel;
        const seriesMatches = !normalizedSeries || definition.series === normalizedSeries;
        return definition.brand === normalizedBrand && modelMatches && seriesMatches;
      });

      return resolution(matches, `${normalizedBrand}/${normalizedSeries ?? "-"}/${normalizedModel}`);
    },
    resolveByResidualDimensionIgnoringSeries({ brand, model }) {
      const normalizedBrand = clean(brand);
      const normalizedModel = clean(model);

      if (!normalizedBrand || !normalizedModel) {
        return { status: "unmatched", reason: "missing brand or model" };
      }

      const matches = liveDefinitions.filter((definition) => {
        const modelMatches = definition.modelName === normalizedModel || definition.modelCode === normalizedModel;
        return definition.brand === normalizedBrand && modelMatches;
      });

      return resolution(matches, `${normalizedBrand}/*/${normalizedModel}`);
    }
  };
}

function analyzeLegacyModelTable(records, context) {
  const recordsWithDefinition = records.filter((record) => record.modelDefinitionId);
  const legacyOnlyRecords = records.filter((record) => !record.modelDefinitionId);
  const legacyOnlyResults = legacyOnlyRecords.map((record) => context.resolveByLegacy(record.vehicleModel));
  const existingResults = recordsWithDefinition.map((record) => {
    const definition = context.definitionById.get(record.modelDefinitionId);
    const legacyResolution = context.resolveByLegacy(record.vehicleModel);
    const conflict =
      definition && legacyResolution.status === "matched" && legacyResolution.definition.id !== record.modelDefinitionId;

    return {
      conflict,
      missingDefinition: !definition,
      mismatchedLegacy:
        definition?.legacyVehicleModel && record.vehicleModel && definition.legacyVehicleModel !== record.vehicleModel
    };
  });

  return {
    total: records.length,
    withModelDefinitionId: recordsWithDefinition.length,
    modelDefinitionIdNull: legacyOnlyRecords.length,
    legacyDistribution: distribution(records, (record) => record.vehicleModel ?? "(none)"),
    legacyOnlyMapping: summarizeResolutions(legacyOnlyResults),
    existingModelDefinitionCheck: {
      checked: recordsWithDefinition.length,
      missingDefinitionReference: existingResults.filter((result) => result.missingDefinition).length,
      mappingConflicts: existingResults.filter((result) => result.conflict).length,
      legacyMismatch: existingResults.filter((result) => result.mismatchedLegacy).length
    }
  };
}

function analyzeSnapshotTable(records, context) {
  const mappingResults = records.map((record) => context.resolveByLegacy(record.vehicleModel));
  const linkedRecords = records.filter((record) => record.vehicle);
  const currentVehicleLegacyMismatch = linkedRecords.filter(
    (record) => record.vehicle?.vehicleModel && record.vehicle.vehicleModel !== record.vehicleModel
  ).length;
  const currentVehicleDefinitionMismatch = linkedRecords.filter((record) => {
    const result = context.resolveByLegacy(record.vehicleModel);
    return result.status === "matched" && record.vehicle?.modelDefinitionId && record.vehicle.modelDefinitionId !== result.definition.id;
  }).length;

  return {
    total: records.length,
    legacyDistribution: distribution(records, (record) => record.vehicleModel ?? "(none)"),
    snapshotMapping: summarizeResolutions(mappingResults),
    linkedVehicleCount: linkedRecords.length,
    linkedVehicleWithoutModelDefinitionId: linkedRecords.filter((record) => !record.vehicle?.modelDefinitionId).length,
    currentVehicleLegacyMismatch,
    currentVehicleDefinitionMismatch,
    recommendation: "Do not overwrite historical snapshot fields; add snapshot modelDefinition fields only in a dedicated future stage."
  };
}

function analyzeResidualDimensionTable(records, context) {
  const recordsWithDefinition = records.filter((record) => record.modelDefinitionId);
  const legacyOnlyRecords = records.filter((record) => !record.modelDefinitionId);
  const legacyOnlyResults = legacyOnlyRecords.map((record) => context.resolveByResidualDimension(record));
  const relaxedLegacyOnlyResults = legacyOnlyRecords.map((record) => context.resolveByResidualDimensionIgnoringSeries(record));
  const existingResults = recordsWithDefinition.map((record) => {
    const definition = context.definitionById.get(record.modelDefinitionId);
    const residualResolution = context.resolveByResidualDimension(record);
    return {
      conflict:
        definition && residualResolution.status === "matched" && residualResolution.definition.id !== record.modelDefinitionId,
      missingDefinition: !definition,
      unresolvedLegacy: residualResolution.status === "unmatched",
      ambiguousLegacy: residualResolution.status === "ambiguous"
    };
  });

  return {
    total: records.length,
    withModelDefinitionId: recordsWithDefinition.length,
    modelDefinitionIdNull: legacyOnlyRecords.length,
    legacyDimensionDistribution: distribution(records, residualDimensionKey),
    legacyOnlyMapping: summarizeResolutions(legacyOnlyResults),
    legacyOnlyMappingIgnoringSeries: summarizeResolutions(relaxedLegacyOnlyResults),
    existingModelDefinitionCheck: {
      checked: recordsWithDefinition.length,
      missingDefinitionReference: existingResults.filter((result) => result.missingDefinition).length,
      mappingConflicts: existingResults.filter((result) => result.conflict).length,
      unresolvedLegacyDimension: existingResults.filter((result) => result.unresolvedLegacy).length,
      ambiguousLegacyDimension: existingResults.filter((result) => result.ambiguousLegacy).length
    }
  };
}

function analyzeForecastTable(records, context) {
  const base = analyzeResidualDimensionTable(records, context);
  const nullForecasts = records.filter((record) => !record.modelDefinitionId);

  return {
    ...base,
    forecastStatusDistribution: distribution(records, (record) => record.forecastStatus),
    forecastsUsingLegacyOnlyCurve: records.filter((record) => !record.curve?.modelDefinitionId).length,
    modelDefinitionIdNullResolutionSources: {
      totalNullForecasts: nullForecasts.length,
      hasVehicleModelDefinitionId: nullForecasts.filter((record) => record.vehicle?.modelDefinitionId).length,
      hasCurveModelDefinitionId: nullForecasts.filter((record) => record.curve?.modelDefinitionId).length,
      hasEitherVehicleOrCurveModelDefinitionId: nullForecasts.filter(
        (record) => record.vehicle?.modelDefinitionId || record.curve?.modelDefinitionId
      ).length,
      hasNoRelatedModelDefinitionId: nullForecasts.filter(
        (record) => !record.vehicle?.modelDefinitionId && !record.curve?.modelDefinitionId
      ).length
    },
    relationshipConflicts: {
      forecastVsVehicleModelDefinition: records.filter(
        (record) =>
          record.modelDefinitionId &&
          record.vehicle?.modelDefinitionId &&
          record.modelDefinitionId !== record.vehicle.modelDefinitionId
      ).length,
      forecastVsCurveModelDefinition: records.filter(
        (record) =>
          record.modelDefinitionId && record.curve?.modelDefinitionId && record.modelDefinitionId !== record.curve.modelDefinitionId
      ).length
    }
  };
}

function analyzeModelRunTable(records, context) {
  const recordsWithDefinition = records.filter((record) => record.targetModelDefinitionId);
  const recordsWithoutDefinition = records.filter((record) => !record.targetModelDefinitionId);
  const targetSpecificWithoutDefinition = recordsWithoutDefinition.filter(hasTargetDimension);
  const targetSpecificResults = targetSpecificWithoutDefinition.map((record) =>
    context.resolveByResidualDimension({
      brand: record.targetBrand,
      model: record.targetModel,
      series: record.targetSeries
    })
  );
  const relaxedTargetSpecificResults = targetSpecificWithoutDefinition.map((record) =>
    context.resolveByResidualDimensionIgnoringSeries({
      brand: record.targetBrand,
      model: record.targetModel
    })
  );
  const existingResults = recordsWithDefinition.map((record) => {
    const definition = context.definitionById.get(record.targetModelDefinitionId);
    const result = context.resolveByResidualDimension({
      brand: record.targetBrand,
      model: record.targetModel,
      series: record.targetSeries
    });
    return {
      conflict: definition && result.status === "matched" && result.definition.id !== record.targetModelDefinitionId,
      missingDefinition: !definition
    };
  });

  return {
    total: records.length,
    withTargetModelDefinitionId: recordsWithDefinition.length,
    targetModelDefinitionIdNull: recordsWithoutDefinition.length,
    fullRunsWithoutTargetDimensions: recordsWithoutDefinition.filter((record) => !hasTargetDimension(record)).length,
    targetSpecificWithoutTargetModelDefinitionId: targetSpecificWithoutDefinition.length,
    targetTypeDistribution: distribution(records, (record) => record.targetType),
    targetLegacyDistribution: distribution(records, (record) =>
      residualDimensionKey({ brand: record.targetBrand, model: record.targetModel, series: record.targetSeries })
    ),
    targetSpecificLegacyMapping: summarizeResolutions(targetSpecificResults),
    targetSpecificLegacyMappingIgnoringSeries: summarizeResolutions(relaxedTargetSpecificResults),
    existingTargetModelDefinitionCheck: {
      checked: recordsWithDefinition.length,
      missingDefinitionReference: existingResults.filter((result) => result.missingDefinition).length,
      mappingConflicts: existingResults.filter((result) => result.conflict).length
    }
  };
}

function summarizeResolutions(results) {
  return {
    matched: results.filter((result) => result.status === "matched").length,
    unmatched: results.filter((result) => result.status === "unmatched").length,
    ambiguous: results.filter((result) => result.status === "ambiguous").length,
    matchedDisabledDefinitions: results.filter((result) => result.status === "matched" && !result.definition.enabled).length
  };
}

function resolution(matches, key) {
  if (matches.length === 1) {
    return { definition: matches[0], key, status: "matched" };
  }

  if (matches.length > 1) {
    return { key, matches: matches.map((match) => match.id), status: "ambiguous" };
  }

  return { key, reason: "no matching VehicleModelDefinition", status: "unmatched" };
}

function distribution(records, keyFn, limit = 20) {
  const counts = new Map();
  for (const record of records) {
    const key = keyFn(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ count, key }))
    .sort((left, right) => right.count - left.count || String(left.key).localeCompare(String(right.key)))
    .slice(0, limit);
}

function duplicates(values) {
  const seen = new Set();
  const duplicateSet = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicateSet.add(value);
    }
    seen.add(value);
  }

  return [...duplicateSet];
}

function residualDimensionKey(record) {
  return `${clean(record.brand) ?? "(none)"}/${clean(record.series) ?? "-"}/${clean(record.model) ?? "(none)"}`;
}

function hasTargetDimension(record) {
  return Boolean(clean(record.targetBrand) || clean(record.targetSeries) || clean(record.targetModel));
}

function clean(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
