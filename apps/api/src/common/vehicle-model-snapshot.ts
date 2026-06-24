import { Prisma, VehicleModel } from "@prisma/client";

export const vehicleModelSnapshotDefinitionSelect = {
  displayName: true,
  id: true
} satisfies Prisma.VehicleModelDefinitionSelect;

export type VehicleModelSnapshotDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof vehicleModelSnapshotDefinitionSelect;
}>;

export type VehicleModelSnapshot = {
  legacyVehicleModelSnapshot: VehicleModel | null;
  modelDefinitionIdSnapshot: string | null;
  modelDisplayNameSnapshot: string | null;
};

export type QuoteOrderModelDisplaySource =
  | "SNAPSHOT"
  | "RUNTIME_MODEL_DEFINITION"
  | "LEGACY_SNAPSHOT"
  | "LEGACY_VEHICLE_MODEL"
  | "UNKNOWN";

type VehicleModelSnapshotSource = {
  legacyVehicleModelSnapshot?: VehicleModel | null;
  modelDefinition?: VehicleModelSnapshotDefinition | null;
  modelDefinitionId?: string | null;
  modelDefinitionIdSnapshot?: string | null;
  modelDisplayNameSnapshot?: string | null;
  vehicleModel?: VehicleModel | null;
};

export function buildVehicleModelSnapshot(source: VehicleModelSnapshotSource): VehicleModelSnapshot {
  const legacyVehicleModel = source.legacyVehicleModelSnapshot ?? source.vehicleModel ?? null;
  const modelDefinitionId = source.modelDefinitionIdSnapshot ?? source.modelDefinitionId ?? null;
  return {
    legacyVehicleModelSnapshot: legacyVehicleModel,
    modelDefinitionIdSnapshot: modelDefinitionId,
    modelDisplayNameSnapshot:
      source.modelDisplayNameSnapshot ?? source.modelDefinition?.displayName ?? legacyVehicleModel ?? null
  };
}

export function freezeQuoteVehicleModelSnapshot(quote: VehicleModelSnapshotSource): VehicleModelSnapshot {
  if (
    quote.modelDefinitionIdSnapshot ||
    quote.modelDisplayNameSnapshot ||
    quote.legacyVehicleModelSnapshot
  ) {
    return {
      legacyVehicleModelSnapshot: quote.legacyVehicleModelSnapshot ?? quote.vehicleModel ?? null,
      modelDefinitionIdSnapshot: quote.modelDefinitionIdSnapshot ?? null,
      modelDisplayNameSnapshot:
        quote.modelDisplayNameSnapshot ??
        quote.legacyVehicleModelSnapshot ??
        quote.vehicleModel ??
        null
    };
  }

  return buildVehicleModelSnapshot(quote);
}

export function buildQuoteOrderModelDisplay(source: VehicleModelSnapshotSource) {
  const modelDefinitionId =
    source.modelDefinitionIdSnapshot ?? source.modelDefinitionId ?? source.modelDefinition?.id ?? null;
  const legacyVehicleModel = source.legacyVehicleModelSnapshot ?? source.vehicleModel ?? null;

  if (source.modelDisplayNameSnapshot) {
    return {
      legacyVehicleModel,
      modelDefinitionId,
      modelDisplayName: source.modelDisplayNameSnapshot,
      modelDisplaySource: "SNAPSHOT" as const
    };
  }

  if (source.modelDefinition?.displayName) {
    return {
      legacyVehicleModel,
      modelDefinitionId,
      modelDisplayName: source.modelDefinition.displayName,
      modelDisplaySource: "RUNTIME_MODEL_DEFINITION" as const
    };
  }

  if (source.legacyVehicleModelSnapshot) {
    return {
      legacyVehicleModel,
      modelDefinitionId,
      modelDisplayName: source.legacyVehicleModelSnapshot,
      modelDisplaySource: "LEGACY_SNAPSHOT" as const
    };
  }

  if (source.vehicleModel) {
    return {
      legacyVehicleModel,
      modelDefinitionId,
      modelDisplayName: source.vehicleModel,
      modelDisplaySource: "LEGACY_VEHICLE_MODEL" as const
    };
  }

  return {
    legacyVehicleModel,
    modelDefinitionId,
    modelDisplayName: null,
    modelDisplaySource: "UNKNOWN" as const
  };
}

export function vehicleModelSnapshotDisplayName(source: VehicleModelSnapshotSource) {
  return buildQuoteOrderModelDisplay(source).modelDisplayName;
}
