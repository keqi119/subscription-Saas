import { Prisma } from "@prisma/client";

import type { VehicleModelIdentity } from "./vehicle-model-resolver";

export const modelDefinitionSnapshotSelect = {
  displayName: true,
  id: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

export type ModelDefinitionSnapshot = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof modelDefinitionSnapshotSelect;
}>;

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
