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
  const externalUsageCount = externalEvents.length;
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

function hasVehicleModelReference(content) {
  return /\bVehicleModel\b|\bvehicleModel\b|\blegacyVehicleModel\b/.test(content);
}

function classifyExternalUsage(path, content) {
  const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
  const lowerContent = content.toLowerCase();

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
