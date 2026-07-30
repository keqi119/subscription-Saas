import type { VehicleModelIdentity } from "./vehicle-model-resolver";

export type VehicleModelSnapshot = {
  modelCodeSnapshot: string;
  modelDefinitionIdSnapshot: string;
  modelDisplayNameSnapshot: string;
};

export function buildVehicleModelSnapshot(
  identity: VehicleModelIdentity
): VehicleModelSnapshot {
  return {
    modelCodeSnapshot: identity.modelCode,
    modelDefinitionIdSnapshot: identity.modelDefinitionId,
    modelDisplayNameSnapshot: identity.modelDisplayName
  };
}
