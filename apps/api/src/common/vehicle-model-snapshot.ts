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

export function vehicleModelSnapshotDisplayName(source: VehicleModelSnapshotSource) {
  return (
    source.modelDisplayNameSnapshot ??
    source.modelDefinition?.displayName ??
    source.legacyVehicleModelSnapshot ??
    source.vehicleModel ??
    null
  );
}
