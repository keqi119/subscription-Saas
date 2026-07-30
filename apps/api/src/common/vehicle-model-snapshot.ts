import { Prisma } from "@prisma/client";

import type { VehicleModelCode } from "./vehicle-model-resolver";

export const vehicleModelSnapshotDefinitionSelect = {
  displayName: true,
  id: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

export type VehicleModelSnapshotDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof vehicleModelSnapshotDefinitionSelect;
}>;

export type VehicleModelSnapshot = {
  legacyVehicleModelSnapshot: VehicleModelCode | null;
  legacyVehicleModelCodeSnapshot: VehicleModelCode | null;
  modelDefinitionIdSnapshot: string | null;
  modelDisplayNameSnapshot: string | null;
};

export type QuoteOrderModelDisplaySource =
  | "SNAPSHOT"
  | "SNAPSHOT_MODEL_CODE"
  | "SNAPSHOT_LEGACY_ENUM"
  | "RUNTIME_MODEL_DEFINITION"
  | "LEGACY_VEHICLE_MODEL"
  | "UNKNOWN";

type VehicleModelSnapshotSource = {
  legacyVehicleModelCodeSnapshot?: string | null;
  legacyVehicleModelSnapshot?: VehicleModelCode | null;
  modelDefinition?: VehicleModelSnapshotDefinition | null;
  modelDefinitionId?: string | null;
  modelDefinitionIdSnapshot?: string | null;
  modelDisplayNameSnapshot?: string | null;
  vehicleModel?: VehicleModelCode | null;
};

export function buildVehicleModelSnapshot(source: VehicleModelSnapshotSource): VehicleModelSnapshot {
  const legacyVehicleModel =
    source.legacyVehicleModelSnapshot ?? source.vehicleModel ?? source.modelDefinition?.modelCode ?? null;
  const legacyVehicleModelCode =
    source.legacyVehicleModelCodeSnapshot ?? (legacyVehicleModel ? String(legacyVehicleModel) : null);
  const modelDefinitionId = source.modelDefinitionIdSnapshot ?? source.modelDefinitionId ?? null;
  return {
    legacyVehicleModelSnapshot: legacyVehicleModel,
    legacyVehicleModelCodeSnapshot: legacyVehicleModelCode,
    modelDefinitionIdSnapshot: modelDefinitionId,
    modelDisplayNameSnapshot:
      source.modelDisplayNameSnapshot ?? source.modelDefinition?.displayName ?? legacyVehicleModel ?? null
  };
}

export function freezeQuoteVehicleModelSnapshot(quote: VehicleModelSnapshotSource): VehicleModelSnapshot {
  if (
    quote.modelDefinitionIdSnapshot ||
    quote.modelDisplayNameSnapshot ||
    quote.legacyVehicleModelSnapshot ||
    quote.legacyVehicleModelCodeSnapshot
  ) {
    const legacyVehicleModel = quote.legacyVehicleModelSnapshot ?? quote.vehicleModel ?? null;
    return {
      legacyVehicleModelSnapshot: legacyVehicleModel,
      legacyVehicleModelCodeSnapshot:
        quote.legacyVehicleModelCodeSnapshot ??
        (quote.legacyVehicleModelSnapshot ? String(quote.legacyVehicleModelSnapshot) : null) ??
        (quote.vehicleModel ? String(quote.vehicleModel) : null),
      modelDefinitionIdSnapshot: quote.modelDefinitionIdSnapshot ?? null,
      modelDisplayNameSnapshot:
        quote.modelDisplayNameSnapshot ??
        legacyVehicleModel ??
        null
    };
  }

  return buildVehicleModelSnapshot(quote);
}

export function buildQuoteOrderModelDisplay(source: VehicleModelSnapshotSource) {
  const modelDefinitionId =
    source.modelDefinitionIdSnapshot ?? source.modelDefinitionId ?? source.modelDefinition?.id ?? null;
  const legacyVehicleModel = source.legacyVehicleModelSnapshot ?? source.vehicleModel ?? null;
  const legacyVehicleModelCode =
    source.legacyVehicleModelCodeSnapshot ?? (legacyVehicleModel ? String(legacyVehicleModel) : null);

  if (source.modelDisplayNameSnapshot) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.modelDisplayNameSnapshot,
      modelDisplaySource: "SNAPSHOT" as const
    };
  }

  if (source.modelDefinitionIdSnapshot && source.modelDefinition?.displayName) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.modelDefinition.displayName,
      modelDisplaySource: "RUNTIME_MODEL_DEFINITION" as const
    };
  }

  if (source.legacyVehicleModelCodeSnapshot) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.legacyVehicleModelCodeSnapshot,
      modelDisplaySource: "SNAPSHOT_MODEL_CODE" as const
    };
  }

  if (source.legacyVehicleModelSnapshot) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.legacyVehicleModelSnapshot,
      modelDisplaySource: "SNAPSHOT_LEGACY_ENUM" as const
    };
  }

  if (source.modelDefinition?.displayName) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.modelDefinition.displayName,
      modelDisplaySource: "RUNTIME_MODEL_DEFINITION" as const
    };
  }

  if (source.vehicleModel) {
    return {
      legacyVehicleModel,
      legacyVehicleModelCode,
      modelDefinitionId,
      modelDisplayName: source.vehicleModel,
      modelDisplaySource: "LEGACY_VEHICLE_MODEL" as const
    };
  }

  return {
    legacyVehicleModel,
    legacyVehicleModelCode,
    modelDefinitionId,
    modelDisplayName: null,
    modelDisplaySource: "UNKNOWN" as const
  };
}

export function vehicleModelSnapshotDisplayName(source: VehicleModelSnapshotSource) {
  return buildQuoteOrderModelDisplay(source).modelDisplayName;
}
