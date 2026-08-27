export interface VehiclePackageMembershipSource {
  modelDefinitionId?: string;
  modelMembers: ReadonlyArray<{ modelDefinitionId: string }>;
}

export function vehiclePackageSupportsModel(
  vehiclePackage: VehiclePackageMembershipSource,
  modelDefinitionId: string
) {
  return vehiclePackage.modelMembers.some(
    (member) => member.modelDefinitionId === modelDefinitionId
  );
}
