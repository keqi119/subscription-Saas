export function scanExternalEnumUsage(files) {
  const items = [];

  for (const file of files) {
    if (!hasVehicleModelReference(file.content)) {
      continue;
    }

    const category = classifyExternalUsage(file.path, file.content);
    if (!category) {
      continue;
    }

    items.push({
      category,
      path: file.path,
      riskLevel: riskLevelForCategory(category)
    });
  }

  return {
    items,
    totalReferences: items.length
  };
}

export function buildVehicleModelRemovalReadinessReport({ externalUsage, runtimeEvents = [] }) {
  const externalEvents = externalUsage.items.map((item) => ({
    decisionPath: "LEGACY_ENUM",
    legacyVehicleModelCode: null,
    metadata: { category: item.category, path: item.path },
    module: item.category === "CSV_EXPORT" ? "csv" : item.category === "EXTERNAL_INTEGRATION" ? "external" : "api",
    operation: item.category,
    riskLevel: item.riskLevel,
    usageKind: "EXTERNAL_CONTRACT"
  }));
  const events = [...runtimeEvents, ...externalEvents];
  const enumUsageCount = events.filter(isEnumUsageEvent).length;
  const businessDecisionUsageCount = events.filter(
    (event) => event.usageKind === "BUSINESS_DECISION" && event.decisionPath === "LEGACY_ENUM"
  ).length;
  const fallbackUsageCount = events.filter((event) => event.usageKind === "FALLBACK").length;
  const externalRuntimeWarningCount = runtimeEvents.filter(
    (event) => event.usageKind === "EXTERNAL_CONTRACT_DEPRECATION_WARNING"
  ).length;
  const externalUsageCount = externalEvents.length + externalRuntimeWarningCount;
  const displayOnlyEnumUsageCount = events.filter(
    (event) => isEnumUsageEvent(event) && event.usageKind === "DISPLAY"
  ).length;
  const readinessScore = clampReadinessScore(
    100 -
      businessDecisionUsageCount * 50 -
      fallbackUsageCount * 20 -
      externalUsageCount * 15 -
      displayOnlyEnumUsageCount * 5
  );
  const decision =
    businessDecisionUsageCount === 0 && fallbackUsageCount === 0 && externalUsageCount === 0 && readinessScore >= 90
      ? "READY"
      : "NOT_READY";

  return {
    businessDecisionUsageCount,
    decision,
    enumUsageCount,
    events,
    externalEnumUsageMap: externalUsage,
    externalUsageCount,
    fallbackUsageCount,
    readinessScore,
    riskClassification: classifyRisk({ businessDecisionUsageCount, externalUsageCount, fallbackUsageCount }),
    totalUsageCount: events.length
  };
}

const blockingMigrationStatuses = new Set(["Discovered", "No owner", "Unknown usage", "Requires legacy enum", "Exception rejected"]);
const hardRemovalStatuses = new Set(["Signed off", "Exception approved"]);

export function validateExternalConsumerRegistry({ externalUsage, consumers }) {
  const normalizedConsumerPaths = new Map();
  for (const consumer of consumers) {
    const paths = normalizeConsumerEvidencePaths(consumer);
    for (const evidencePath of paths) {
      normalizedConsumerPaths.set(evidencePath, consumer);
    }
  }

  const missingReferences = [];
  for (const item of externalUsage.items) {
    if (!normalizedConsumerPaths.has(normalizePath(item.path))) {
      missingReferences.push(item);
    }
  }

  const blockingConsumers = consumers.filter((consumer) => isWarningModeBlockingConsumer(consumer));
  const hardRemovalBlockingConsumers = consumers.filter((consumer) => !isHardRemovalCompleteConsumer(consumer));

  return {
    blockingConsumers,
    hardRemovalBlockingConsumers,
    hardRemovalReady: missingReferences.length === 0 && hardRemovalBlockingConsumers.length === 0,
    missingReferences,
    registeredReferences: externalUsage.items.length - missingReferences.length,
    totalConsumers: consumers.length,
    totalExternalReferences: externalUsage.totalReferences,
    warningModeReady: missingReferences.length === 0 && blockingConsumers.length === 0
  };
}

function hasVehicleModelReference(content) {
  return /\bVehicleModel\b|\bvehicleModel\b|\blegacyVehicleModel\b/.test(content);
}

function classifyExternalUsage(path, content) {
  const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
  const lowerContent = content.toLowerCase();

  if (isInternalVehicleModelEvidenceFile(normalizedPath)) {
    return null;
  }

  if (normalizedPath.includes("external") || normalizedPath.includes("integration") || normalizedPath.includes("webhook")) {
    return "EXTERNAL_INTEGRATION";
  }
  if (/\bcsv\b|csvexport|导出 csv/i.test(content) || normalizedPath.includes("export")) {
    return "CSV_EXPORT";
  }
  if (normalizedPath.includes("/dto/") || normalizedPath.includes("controller")) {
    return "API_CONTRACT";
  }
  if (normalizedPath.includes("/report/") || normalizedPath.includes("/reports/")) {
    return "REPORTS_API";
  }
  return null;
}

function isInternalVehicleModelEvidenceFile(normalizedPath) {
  return (
    normalizedPath.includes("vehicle-model-usage-tracker") ||
    normalizedPath.includes("vehicle-model-removal-readiness") ||
    normalizedPath.includes("vehicle-model-contract-governance")
  );
}

function riskLevelForCategory(category) {
  if (category === "EXTERNAL_INTEGRATION") {
    return "HIGH";
  }
  if (category === "API_CONTRACT" || category === "REPORTS_API") {
    return "MEDIUM";
  }
  return "LOW";
}

function isEnumUsageEvent(event) {
  return Boolean(
    event.decisionPath === "LEGACY_ENUM" ||
      event.legacyVehicleModelCode ||
      event.usageKind === "API_ENUM_FILTER" ||
      event.usageKind === "ENUM_RESOLVE" ||
      event.usageKind === "EXTERNAL_CONTRACT" ||
      event.usageKind === "EXTERNAL_CONTRACT_DEPRECATION_WARNING" ||
      event.usageKind === "FALLBACK" ||
      event.usageKind === "PRODUCT_PRICE_RULE_INPUT"
  );
}

function classifyRisk(input) {
  if (input.businessDecisionUsageCount > 0) {
    return "HIGH";
  }
  if (input.fallbackUsageCount > 0 || input.externalUsageCount > 0) {
    return "MEDIUM";
  }
  return "LOW";
}

function clampReadinessScore(value) {
  return Math.max(0, Math.min(100, value));
}

function isWarningModeBlockingConsumer(consumer) {
  const risk = normalizeRisk(consumer.risk);
  if (risk !== "MEDIUM" && risk !== "HIGH") {
    return false;
  }

  return (
    !String(consumer.owner ?? "").trim() ||
    !String(consumer.replacement ?? "").trim() ||
    blockingMigrationStatuses.has(String(consumer.migrationStatus ?? ""))
  );
}

function isHardRemovalCompleteConsumer(consumer) {
  const status = String(consumer.migrationStatus ?? "");
  if (!hardRemovalStatuses.has(status)) {
    return false;
  }

  if (status === "Exception approved") {
    return Boolean(consumer.acceptedNonEnumReplacement);
  }

  return true;
}

function normalizeConsumerEvidencePaths(consumer) {
  const paths = [];
  if (consumer.evidencePath) {
    paths.push(consumer.evidencePath);
  }
  if (Array.isArray(consumer.evidencePaths)) {
    paths.push(...consumer.evidencePaths);
  }
  return paths.map(normalizePath);
}

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/").toLowerCase();
}

function normalizeRisk(value) {
  return String(value ?? "").toUpperCase();
}
