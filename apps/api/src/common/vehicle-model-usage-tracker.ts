export type VehicleModelEvidenceModule =
  | "api"
  | "csv"
  | "external"
  | "order"
  | "product"
  | "quote"
  | "report"
  | "resolver"
  | "vehicle";

export type VehicleModelDecisionPath = "MODEL_DEFINITION_ID" | "LEGACY_ENUM" | "SNAPSHOT" | "UNKNOWN";

export type VehicleModelUsageKind =
  | "API_ENUM_FILTER"
  | "BUSINESS_DECISION"
  | "DISPLAY"
  | "ENUM_RESOLVE"
  | "EXTERNAL_CONTRACT"
  | "FALLBACK"
  | "PRODUCT_PRICE_RULE_INPUT";

export type VehicleModelRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type VehicleModelUsageEvent = {
  decisionPath: VehicleModelDecisionPath;
  legacyVehicleModelCode?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  modelDefinitionId?: string | null;
  module: VehicleModelEvidenceModule;
  operation: string;
  riskLevel: VehicleModelRiskLevel;
  timestamp?: string;
  usageKind: VehicleModelUsageKind;
};

export type VehicleModelRemovalReadinessDecision = "READY" | "NOT_READY";

export type VehicleModelRemovalReadinessReport = {
  businessDecisionUsageCount: number;
  decision: VehicleModelRemovalReadinessDecision;
  enumUsageCount: number;
  events: VehicleModelUsageEvent[];
  externalUsageCount: number;
  fallbackUsageCount: number;
  readinessScore: number;
  riskClassification: VehicleModelRiskLevel;
  totalUsageCount: number;
};

export class VehicleModelUsageTracker {
  private readonly events: VehicleModelUsageEvent[] = [];

  record(event: VehicleModelUsageEvent) {
    this.events.push({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString()
    });
  }

  report(): VehicleModelRemovalReadinessReport {
    return calculateVehicleModelRemovalReadiness(this.events);
  }

  reset() {
    this.events.length = 0;
  }
}

export const vehicleModelUsageTracker = new VehicleModelUsageTracker();

export function trackVehicleModelUsage(event: VehicleModelUsageEvent) {
  vehicleModelUsageTracker.record(event);
}

export function calculateVehicleModelRemovalReadiness(
  events: VehicleModelUsageEvent[]
): VehicleModelRemovalReadinessReport {
  const enumUsageCount = events.filter(isEnumUsageEvent).length;
  const businessDecisionUsageCount = events.filter(
    (event) => event.usageKind === "BUSINESS_DECISION" && event.decisionPath === "LEGACY_ENUM"
  ).length;
  const fallbackUsageCount = events.filter((event) => event.usageKind === "FALLBACK").length;
  const externalUsageCount = events.filter((event) => event.usageKind === "EXTERNAL_CONTRACT").length;

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
    events: events.map((event) => ({ ...event, metadata: event.metadata ? { ...event.metadata } : undefined })),
    externalUsageCount,
    fallbackUsageCount,
    readinessScore,
    riskClassification: classifyRisk({ businessDecisionUsageCount, externalUsageCount, fallbackUsageCount }),
    totalUsageCount: events.length
  };
}

function isEnumUsageEvent(event: VehicleModelUsageEvent) {
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

function classifyRisk(input: {
  businessDecisionUsageCount: number;
  externalUsageCount: number;
  fallbackUsageCount: number;
}): VehicleModelRiskLevel {
  if (input.businessDecisionUsageCount > 0) {
    return "HIGH";
  }
  if (input.fallbackUsageCount > 0 || input.externalUsageCount > 0) {
    return "MEDIUM";
  }
  return "LOW";
}

function clampReadinessScore(value: number) {
  return Math.max(0, Math.min(100, value));
}
