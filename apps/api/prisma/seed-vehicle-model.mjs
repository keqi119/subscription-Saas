export async function convergeVehicleModelDefinition(
  prisma,
  { createData, legacyVehicleModel, modelCode, updateData }
) {
  const codes = [...new Set([modelCode, legacyVehicleModel].filter(Boolean))];
  const aliases = codes.flatMap((code) => [
    { modelCode: code },
    { legacyVehicleModel: code }
  ]);

  const matches = await prisma.vehicleModelDefinition.findMany({
    select: {
      id: true,
      legacyVehicleModel: true,
      modelCode: true
    },
    where: { OR: aliases }
  });

  if (matches.length > 1) {
    throw new Error(
      `VehicleModelDefinition seed conflict for ${modelCode}: multiple canonical or legacy matches.`
    );
  }

  if (matches.length === 1) {
    return prisma.vehicleModelDefinition.update({
      data: {
        ...updateData,
        deletedAt: null,
        legacyVehicleModel,
        modelCode
      },
      where: { id: matches[0].id }
    });
  }

  return prisma.vehicleModelDefinition.create({
    data: {
      ...createData,
      legacyVehicleModel,
      modelCode
    }
  });
}

export async function upsertCanonicalProductPriceRule(
  prisma,
  { createData, modelDefinitionId, productVersionId, updateData, vehicleModel }
) {
  return prisma.productPriceRule.upsert({
    create: {
      ...createData,
      modelDefinitionId,
      productVersionId,
      vehicleModel
    },
    update: {
      ...updateData,
      modelDefinitionId,
      vehicleModel
    },
    where: {
      productVersionId_modelDefinitionId: {
        modelDefinitionId,
        productVersionId
      }
    }
  });
}
