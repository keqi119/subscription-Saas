export function parseBackfillMode(args) {
  const hasApply = args.includes("--apply");
  const hasDryRun = args.includes("--dry-run");

  if (hasApply && hasDryRun) {
    throw new Error("Use either --dry-run or --apply, not both.");
  }

  return hasApply ? "apply" : "dry-run";
}

export function assertApplyAllowed({ env = process.env, mode }) {
  if (mode !== "apply") {
    return;
  }

  if (env.MODEL_DEFINITION_BACKFILL_APPLY !== "1") {
    throw new Error("Backfill apply requires MODEL_DEFINITION_BACKFILL_APPLY=1.");
  }

  const isProduction = env.APP_ENV === "production" || env.NODE_ENV === "production";
  if (isProduction && env.ALLOW_PRODUCTION_MODEL_DEFINITION_BACKFILL !== "1") {
    throw new Error("Production backfill requires backup and manual approval.");
  }
}

export function buildLowRiskTablePlan({ definitions, records, tableName }) {
  const definitionMap = buildDefinitionMap(definitions);
  const updates = [];
  const unresolved = [];
  const conflicts = [];
  let skippedExisting = 0;

  for (const record of records) {
    const vehicleModel = clean(record.vehicleModel);

    if (record.modelDefinitionId) {
      skippedExisting += 1;
      const matches = vehicleModel ? definitionMap.get(vehicleModel) ?? [] : [];
      if (matches.length === 1 && matches[0].id !== record.modelDefinitionId) {
        conflicts.push({
          id: record.id,
          reason: "existing modelDefinitionId does not match legacy vehicleModel",
          tableName,
          vehicleModel
        });
      }
      continue;
    }

    if (!vehicleModel) {
      unresolved.push({ id: record.id, reason: "missing legacy vehicleModel", tableName, vehicleModel: null });
      continue;
    }

    const matches = definitionMap.get(vehicleModel) ?? [];
    if (matches.length === 0) {
      unresolved.push({ id: record.id, reason: "no matching VehicleModelDefinition", tableName, vehicleModel });
      continue;
    }

    if (matches.length > 1) {
      conflicts.push({
        definitionIds: matches.map((definition) => definition.id),
        id: record.id,
        reason: "multiple matching VehicleModelDefinition records",
        tableName,
        vehicleModel
      });
      continue;
    }

    updates.push({ id: record.id, modelDefinitionId: matches[0].id, vehicleModel });
  }

  return {
    conflicts,
    matched: updates.length,
    skippedExisting,
    tableName,
    total: records.length,
    unresolved,
    updated: 0,
    updates
  };
}

export function hasBlockingIssues(plans) {
  return Object.values(plans).some((plan) => plan.unresolved.length > 0 || plan.conflicts.length > 0);
}

export function summarizeBackfill(plans) {
  return Object.values(plans).reduce(
    (summary, plan) => ({
      conflicts: summary.conflicts + plan.conflicts.length,
      matched: summary.matched + plan.matched,
      skippedExisting: summary.skippedExisting + plan.skippedExisting,
      total: summary.total + plan.total,
      unresolved: summary.unresolved + plan.unresolved.length,
      updated: summary.updated + plan.updated
    }),
    { conflicts: 0, matched: 0, skippedExisting: 0, total: 0, unresolved: 0, updated: 0 }
  );
}

export function markPlanUpdated(plan, updated) {
  return { ...plan, updated };
}

function buildDefinitionMap(definitions) {
  const map = new Map();

  for (const definition of definitions) {
    if (definition.deletedAt || definition.enabled !== true) {
      continue;
    }

    for (const code of [definition.modelCode, definition.legacyVehicleModel]) {
      const key = clean(code);
      if (!key) {
        continue;
      }

      const bucket = map.get(key) ?? [];
      if (!bucket.some((candidate) => candidate.id === definition.id)) {
        bucket.push(definition);
      }
      map.set(key, bucket);
    }
  }

  return map;
}

function clean(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
