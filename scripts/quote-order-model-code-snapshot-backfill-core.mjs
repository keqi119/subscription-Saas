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

  if (env.QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY !== "1") {
    throw new Error(
      "Quote/Order model code snapshot backfill apply requires QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL_APPLY=1."
    );
  }

  const isProduction = env.APP_ENV === "production" || env.NODE_ENV === "production";
  if (isProduction && env.ALLOW_PRODUCTION_QUOTE_ORDER_MODEL_CODE_SNAPSHOT_BACKFILL !== "1") {
    throw new Error("Production model code snapshot backfill requires backup and manual approval.");
  }
}

export function buildQuoteModelCodeSnapshotPlan({ quotes }) {
  const updates = [];
  const unresolved = [];
  let skippedExisting = 0;

  for (const quote of quotes) {
    if (isPresent(quote.legacyVehicleModelCodeSnapshot)) {
      skippedExisting += 1;
      continue;
    }

    const source = firstCodeSource([
      ["legacyVehicleModelSnapshot", quote.legacyVehicleModelSnapshot],
      ["vehicleModel", quote.vehicleModel]
    ]);

    if (!source) {
      unresolved.push({
        id: quote.id,
        reason: "missing legacy model code source",
        tableName: "SubscriptionQuote"
      });
      continue;
    }

    updates.push({
      id: quote.id,
      legacyVehicleModelCodeSnapshot: source.value,
      source: source.name
    });
  }

  return emptyPlan({
    matched: updates.length,
    skippedExisting,
    tableName: "SubscriptionQuote",
    total: quotes.length,
    unresolved,
    updates
  });
}

export function buildOrderModelCodeSnapshotPlan({ orders, quotePlan }) {
  const plannedQuoteCodeSnapshots = buildPlannedQuoteCodeSnapshotMap(quotePlan);
  const updates = [];
  const unresolved = [];
  let skippedExisting = 0;

  for (const order of orders) {
    if (isPresent(order.legacyVehicleModelCodeSnapshot)) {
      skippedExisting += 1;
      continue;
    }

    const quoteId = order.quoteId ?? order.quote?.id ?? null;
    const plannedQuoteCodeSnapshot = quoteId ? plannedQuoteCodeSnapshots.get(quoteId) : null;
    const source = firstCodeSource([
      ["legacyVehicleModelSnapshot", order.legacyVehicleModelSnapshot],
      ["vehicleModel", order.vehicleModel],
      ["quoteLegacyVehicleModelCodeSnapshot", order.quote?.legacyVehicleModelCodeSnapshot],
      ["plannedQuoteModelCodeSnapshot", plannedQuoteCodeSnapshot],
      ["quoteLegacyVehicleModelSnapshot", order.quote?.legacyVehicleModelSnapshot],
      ["quoteVehicleModel", order.quote?.vehicleModel]
    ]);

    if (!source) {
      unresolved.push({
        id: order.id,
        reason: "missing legacy model code source",
        tableName: "SubscriptionOrder"
      });
      continue;
    }

    updates.push({
      id: order.id,
      legacyVehicleModelCodeSnapshot: source.value,
      quoteId,
      source: source.name
    });
  }

  return emptyPlan({
    matched: updates.length,
    skippedExisting,
    tableName: "SubscriptionOrder",
    total: orders.length,
    unresolved,
    updates
  });
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

function emptyPlan({ matched, skippedExisting, tableName, total, unresolved, updates }) {
  return {
    conflicts: [],
    matched,
    skippedExisting,
    tableName,
    total,
    unresolved,
    updated: 0,
    updates
  };
}

function buildPlannedQuoteCodeSnapshotMap(quotePlan) {
  const map = new Map();

  for (const update of quotePlan.updates) {
    map.set(update.id, update.legacyVehicleModelCodeSnapshot);
  }

  return map;
}

function firstCodeSource(candidates) {
  for (const [name, value] of candidates) {
    const code = clean(value);
    if (code) {
      return { name, value: code };
    }
  }
  return null;
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
