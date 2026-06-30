const LEGACY_SCHEMA_UNIQUE_PATTERN = /@@unique\s*\(\s*\[\s*productVersionId\s*,\s*vehicleModel\s*\]/;
const MODEL_DEFINITION_SCHEMA_UNIQUE_PATTERN =
  /@@unique\s*\(\s*\[\s*productVersionId\s*,\s*modelDefinitionId\s*\][^)]*product_price_rule_product_version_model_definition_key/;

export function buildProductPriceRuleLegacyRollbackReport({ rules }) {
  const scopes = new Map();

  for (const rule of rules) {
    const productVersionId = cleanOriginal(rule.productVersionId);
    const vehicleModel = cleanOriginal(rule.vehicleModel);
    if (!productVersionId || !vehicleModel) {
      continue;
    }

    const scopeKey = `${productVersionId}::${vehicleModel}`;
    const scope = scopes.get(scopeKey) ?? {
      productVersionId,
      ruleIds: [],
      vehicleModel
    };
    scope.ruleIds.push(rule.id);
    scopes.set(scopeKey, scope);
  }

  const duplicateLegacyScopes = [...scopes.values()]
    .filter((scope) => scope.ruleIds.length > 1)
    .map((scope) => ({
      productVersionId: scope.productVersionId,
      ruleIds: scope.ruleIds,
      vehicleModel: scope.vehicleModel
    }));

  return {
    duplicateLegacyScopes,
    ready: duplicateLegacyScopes.length === 0,
    summary: {
      duplicateLegacyScopes: duplicateLegacyScopes.length
    }
  };
}

export function buildProductPriceRuleConstraintDecommissionReport({ dbIndexes = [], legacyRollbackReport, readinessReport, schemaText }) {
  const blockers = [];
  const productPriceRuleModel = extractProductPriceRuleModel(schemaText);
  const legacySchemaUniquePresent = LEGACY_SCHEMA_UNIQUE_PATTERN.test(productPriceRuleModel);
  const modelDefinitionSchemaUniquePresent = MODEL_DEFINITION_SCHEMA_UNIQUE_PATTERN.test(productPriceRuleModel);
  const legacyDatabaseUniquePresent = dbIndexes.some(isLegacyVehicleModelUniqueIndex);
  const modelDefinitionDatabaseUniquePresent = dbIndexes.some(isModelDefinitionUniqueIndex);

  if (legacySchemaUniquePresent) {
    blockers.push({
      code: "LEGACY_SCHEMA_UNIQUE_PRESENT",
      message: "ProductPriceRule schema still declares @@unique([productVersionId, vehicleModel])."
    });
  }

  if (!modelDefinitionSchemaUniquePresent) {
    blockers.push({
      code: "MODEL_DEFINITION_SCHEMA_UNIQUE_MISSING",
      message: "ProductPriceRule schema must keep the modelDefinitionId unique constraint."
    });
  }

  if (legacyDatabaseUniquePresent) {
    blockers.push({
      code: "LEGACY_DATABASE_UNIQUE_PRESENT",
      message: "Database still has the legacy product_version_id + vehicle_model unique index."
    });
  }

  if (!modelDefinitionDatabaseUniquePresent) {
    blockers.push({
      code: "MODEL_DEFINITION_DATABASE_UNIQUE_MISSING",
      message: "Database must have the product_version_id + model_definition_id unique index before legacy decommission."
    });
  }

  if (!readinessReport?.ready) {
    blockers.push({
      code: "DATA_READINESS_FAILED",
      message: "ProductPriceRule data readiness is not clean.",
      summary: readinessReport?.summary ?? null
    });
  }

  if (legacyRollbackReport && !legacyRollbackReport.ready) {
    blockers.push({
      code: "LEGACY_ROLLBACK_SCOPE_DUPLICATES",
      duplicateLegacyScopes: legacyRollbackReport.duplicateLegacyScopes,
      message: "Current ProductPriceRule data would prevent restoring the legacy product_version_id + vehicle_model unique index.",
      summary: legacyRollbackReport.summary
    });
  }

  return {
    blockers,
    database: {
      legacyDatabaseUniquePresent,
      modelDefinitionDatabaseUniquePresent
    },
    ready: blockers.length === 0,
    legacyRollbackSummary: legacyRollbackReport?.summary ?? null,
    readinessSummary: readinessReport?.summary ?? null,
    schema: {
      legacySchemaUniquePresent,
      modelDefinitionSchemaUniquePresent
    }
  };
}

function extractProductPriceRuleModel(schemaText) {
  const match = schemaText.match(/model\s+ProductPriceRule\s+\{[\s\S]*?^\s*\}/m);
  return match?.[0] ?? "";
}

function isLegacyVehicleModelUniqueIndex(index) {
  const name = clean(index.indexName);
  const definition = clean(index.indexDefinition);
  return (
    name === "product_price_rule_product_version_id_vehicle_model_key" ||
    (definition.includes("unique") &&
      definition.includes("product_version_id") &&
      definition.includes("vehicle_model") &&
      !definition.includes("model_definition_id"))
  );
}

function isModelDefinitionUniqueIndex(index) {
  const name = clean(index.indexName);
  const definition = clean(index.indexDefinition);
  return (
    name === "product_price_rule_product_version_model_definition_key" ||
    (definition.includes("unique") &&
      definition.includes("product_version_id") &&
      definition.includes("model_definition_id"))
  );
}

function clean(value) {
  return String(value ?? "").toLowerCase();
}

function cleanOriginal(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
