export async function convergeVehicleModelDefinition(
  prisma,
  { createData, modelCode, updateData }
) {
  return prisma.vehicleModelDefinition.upsert({
    create: {
      ...createData,
      modelCode
    },
    update: {
      ...updateData,
      deletedAt: null
    },
    where: { modelCode }
  });
}

export async function upsertCanonicalProductPriceRule(
  prisma,
  { createData, modelDefinitionId, productVersionId, updateData }
) {
  return prisma.productPriceRule.upsert({
    create: {
      ...createData,
      modelDefinitionId,
      productVersionId
    },
    update: {
      ...updateData,
      modelDefinitionId
    },
    where: {
      productVersionId_modelDefinitionId: {
        modelDefinitionId,
        productVersionId
      }
    }
  });
}
