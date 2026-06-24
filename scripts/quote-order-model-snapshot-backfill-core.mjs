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

  if (env.QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY !== "1") {
    throw new Error("Quote/Order snapshot backfill apply requires QUOTE_ORDER_SNAPSHOT_BACKFILL_APPLY=1.");
  }

  const isProduction = env.APP_ENV === "production" || env.NODE_ENV === "production";
  if (isProduction && env.ALLOW_PRODUCTION_QUOTE_ORDER_SNAPSHOT_BACKFILL !== "1") {
    throw new Error("Production snapshot backfill requires backup and manual approval.");
  }
}

export function buildQuoteSnapshotPlan({ definitions, quotes }) {
  const definitionMap = buildDefinitionMap(definitions);
  const updates = [];
  const unresolved = [];
  const conflicts = [];
  let skippedExisting = 0;

  for (const quote of quotes) {
    if (hasAnySnapshotField(quote)) {
      skippedExisting += 1;
      continue;
    }

    const vehicleModel = clean(quote.vehicleModel);
    if (!vehicleModel) {
      unresolved.push({ id: quote.id, reason: "missing legacy vehicleModel", tableName: "SubscriptionQuote", vehicleModel: null });
      continue;
    }

    const match = resolveDefinition(definitionMap, vehicleModel, quote.id, "SubscriptionQuote");
    if (match.unresolved) {
      unresolved.push(match.unresolved);
      continue;
    }
    if (match.conflict) {
      conflicts.push(match.conflict);
      continue;
    }

    updates.push(snapshotUpdateFromDefinition({ definition: match.definition, id: quote.id, source: "legacyVehicleModel", vehicleModel }));
  }

  return {
    conflicts,
    matched: updates.length,
    skippedExisting,
    tableName: "SubscriptionQuote",
    total: quotes.length,
    unresolved,
    updated: 0,
    updates
  };
}

export function buildOrderSnapshotPlan({ definitions, orders, quotePlan }) {
  const definitionMap = buildDefinitionMap(definitions);
  const plannedQuoteSnapshots = buildPlannedQuoteSnapshotMap(quotePlan);
  const updates = [];
  const unresolved = [];
  const conflicts = [];
  let skippedExisting = 0;

  for (const order of orders) {
    if (hasAnySnapshotField(order)) {
      skippedExisting += 1;
      continue;
    }

    const quoteId = order.quoteId ?? order.quote?.id ?? null;
    const plannedQuoteSnapshot = quoteId ? plannedQuoteSnapshots.get(quoteId) : null;
    if (plannedQuoteSnapshot) {
      updates.push(orderSnapshotUpdateFromSnapshot({ id: order.id, quoteId, snapshot: plannedQuoteSnapshot, source: "plannedQuoteSnapshot", vehicleModel: order.vehicleModel }));
      continue;
    }

    const existingQuoteSnapshot = snapshotFromExistingQuote(order.quote);
    if (existingQuoteSnapshot) {
      updates.push(orderSnapshotUpdateFromSnapshot({ id: order.id, quoteId, snapshot: existingQuoteSnapshot, source: "quoteSnapshot", vehicleModel: order.vehicleModel }));
      continue;
    }

    const vehicleModel = clean(order.vehicleModel);
    if (!vehicleModel) {
      unresolved.push({ id: order.id, reason: "missing legacy vehicleModel", tableName: "SubscriptionOrder", vehicleModel: null });
      continue;
    }

    const match = resolveDefinition(definitionMap, vehicleModel, order.id, "SubscriptionOrder", {
      noMatchReason: "no quote snapshot and no matching VehicleModelDefinition"
    });
    if (match.unresolved) {
      unresolved.push(match.unresolved);
      continue;
    }
    if (match.conflict) {
      conflicts.push(match.conflict);
      continue;
    }

    updates.push({
      ...snapshotUpdateFromDefinition({ definition: match.definition, id: order.id, source: "legacyVehicleModel", vehicleModel }),
      quoteId
    });
  }

  return {
    conflicts,
    matched: updates.length,
    skippedExisting,
    tableName: "SubscriptionOrder",
    total: orders.length,
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
    if (definition.deletedAt || !definition.legacyVehicleModel) {
      continue;
    }

    const key = clean(definition.legacyVehicleModel);
    if (!key) {
      continue;
    }

    const bucket = map.get(key) ?? [];
    bucket.push(definition);
    map.set(key, bucket);
  }

  return map;
}

function resolveDefinition(definitionMap, vehicleModel, id, tableName, options = {}) {
  const matches = definitionMap.get(vehicleModel) ?? [];
  if (matches.length === 0) {
    return {
      unresolved: {
        id,
        reason: options.noMatchReason ?? "no matching VehicleModelDefinition",
        tableName,
        vehicleModel
      }
    };
  }

  if (matches.length > 1) {
    return {
      conflict: {
        definitionIds: matches.map((definition) => definition.id),
        id,
        reason: "multiple matching VehicleModelDefinition records",
        tableName,
        vehicleModel
      }
    };
  }

  return { definition: matches[0] };
}

function snapshotUpdateFromDefinition({ definition, id, source, vehicleModel }) {
  return {
    id,
    legacyVehicleModelSnapshot: vehicleModel,
    modelDefinitionIdSnapshot: definition.id,
    modelDisplayNameSnapshot: definition.displayName,
    source,
    vehicleModel
  };
}

function orderSnapshotUpdateFromSnapshot({ id, quoteId, snapshot, source, vehicleModel }) {
  return {
    id,
    legacyVehicleModelSnapshot: snapshot.legacyVehicleModelSnapshot,
    modelDefinitionIdSnapshot: snapshot.modelDefinitionIdSnapshot,
    modelDisplayNameSnapshot: snapshot.modelDisplayNameSnapshot,
    quoteId,
    source,
    vehicleModel
  };
}

function buildPlannedQuoteSnapshotMap(quotePlan) {
  const map = new Map();

  for (const update of quotePlan.updates) {
    map.set(update.id, {
      legacyVehicleModelSnapshot: update.legacyVehicleModelSnapshot,
      modelDefinitionIdSnapshot: update.modelDefinitionIdSnapshot,
      modelDisplayNameSnapshot: update.modelDisplayNameSnapshot
    });
  }

  return map;
}

function snapshotFromExistingQuote(quote) {
  if (!quote || !hasAnySnapshotField(quote)) {
    return null;
  }

  const legacyVehicleModelSnapshot = clean(quote.legacyVehicleModelSnapshot) ?? clean(quote.vehicleModel);
  const modelDisplayNameSnapshot = clean(quote.modelDisplayNameSnapshot) ?? legacyVehicleModelSnapshot;

  return {
    legacyVehicleModelSnapshot,
    modelDefinitionIdSnapshot: clean(quote.modelDefinitionIdSnapshot),
    modelDisplayNameSnapshot
  };
}

function hasAnySnapshotField(record) {
  return (
    isPresent(record.modelDefinitionIdSnapshot) ||
    isPresent(record.modelDisplayNameSnapshot) ||
    isPresent(record.legacyVehicleModelSnapshot)
  );
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

function clean(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
