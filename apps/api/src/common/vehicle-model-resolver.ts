import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export const vehicleModelResolverDefinitionSelect = {
  deletedAt: true,
  displayName: true,
  enabled: true,
  id: true,
  modelCode: true
} satisfies Prisma.VehicleModelDefinitionSelect;

export type VehicleModelResolverDefinition = Prisma.VehicleModelDefinitionGetPayload<{
  select: typeof vehicleModelResolverDefinitionSelect;
}>;

export type VehicleModelIdentity = {
  modelCode: string;
  modelDefinitionId: string;
  modelDisplayName: string;
};

export type VehicleModelDefinitionReader = {
  vehicleModelDefinition: {
    findFirst(args: {
      select: typeof vehicleModelResolverDefinitionSelect;
      where: Prisma.VehicleModelDefinitionWhereInput;
    }): Promise<VehicleModelResolverDefinition | null>;
  };
};

export async function requireActiveVehicleModelDefinition(
  prisma: VehicleModelDefinitionReader,
  modelDefinitionId: string
): Promise<VehicleModelIdentity> {
  if (!modelDefinitionId) {
    throw new BadRequestException("车型主数据不存在。");
  }

  const definition = await prisma.vehicleModelDefinition.findFirst({
    select: vehicleModelResolverDefinitionSelect,
    where: { id: modelDefinitionId }
  });

  if (!definition) {
    throw new BadRequestException("车型主数据不存在。");
  }
  if (definition.deletedAt) {
    throw new BadRequestException("车型主数据已删除。");
  }
  if (!definition.enabled) {
    throw new BadRequestException("车型主数据已停用。");
  }

  return {
    modelCode: definition.modelCode,
    modelDefinitionId: definition.id,
    modelDisplayName: definition.displayName
  };
}
