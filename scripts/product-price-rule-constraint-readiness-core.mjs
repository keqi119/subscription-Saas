export function buildProductPriceRuleConstraintReadinessReport({ rules }) {
  const missingModelDefinitionId = [];
  const legacyMappingMismatches = [];
  const scopes = new Map();

  for (const rule of rules) {
    if (!rule.modelDefinitionId) {
      missingModelDefinitionId.push({
        id: rule.id,
        productVersionId: rule.productVersionId,
        vehicleModel: clean(rule.vehicleModel)
      });
      continue;
    }

    const scopeKey = `${rule.productVersionId}::${rule.modelDefinitionId}`;
    const scope = scopes.get(scopeKey) ?? {
      modelDefinitionId: rule.modelDefinitionId,
      productVersionId: rule.productVersionId,
      ruleIds: []
    };
    scope.ruleIds.push(rule.id);
    scopes.set(scopeKey, scope);

    const legacyVehicleModel = clean(rule.vehicleModel);
    const definitionLegacyVehicleModel = clean(rule.modelDefinition?.legacyVehicleModel);
    if (definitionLegacyVehicleModel && legacyVehicleModel && legacyVehicleModel !== definitionLegacyVehicleModel) {
      legacyMappingMismatches.push({
        definitionLegacyVehicleModel,
        id: rule.id,
        modelDefinitionId: rule.modelDefinitionId,
        productVersionId: rule.productVersionId,
        vehicleModel: legacyVehicleModel
      });
    }
  }

  const duplicateModelDefinitionScopes = [...scopes.values()]
    .filter((scope) => scope.ruleIds.length > 1)
    .map((scope) => ({
      modelDefinitionId: scope.modelDefinitionId,
      productVersionId: scope.productVersionId,
      ruleIds: scope.ruleIds
    }));

  const summary = {
    duplicateModelDefinitionScopes: duplicateModelDefinitionScopes.length,
    legacyMappingMismatches: legacyMappingMismatches.length,
    missingModelDefinitionId: missingModelDefinitionId.length,
    totalRules: rules.length
  };

  return {
    duplicateModelDefinitionScopes,
    legacyMappingMismatches,
    missingModelDefinitionId,
    ready:
      summary.duplicateModelDefinitionScopes === 0 &&
      summary.legacyMappingMismatches === 0 &&
      summary.missingModelDefinitionId === 0,
    summary
  };
}

function clean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
