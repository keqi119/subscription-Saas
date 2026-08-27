import {
  applySubscriptionSegmentBootstrapPlan,
  buildSubscriptionSegmentBootstrapPlan
} from "./subscription-segment-bootstrap-core.mjs";

const ACTIVE_CHANGE_STATUSES = new Set([
  "DRAFT",
  "QUOTED",
  "CUSTOMER_CONFIRMED",
  "SIGNING_OR_PAYMENT",
  "SCHEDULED",
  "EXECUTING",
  "MANUAL_TAKEOVER"
]);
const PRICING_MODES = new Set(["CURRENT_VERSION", "ORIGINAL_PRICE", "APPROVED_DISCOUNT"]);
const FLAG_DEFINITIONS = [
  ["earlyTermination", "SUBSCRIPTION_EARLY_TERMINATION_ENABLED"],
  ["extension", "SUBSCRIPTION_EXTENSION_ENABLED"],
  ["managedOther", "SUBSCRIPTION_MANAGED_OTHER_ENABLED"],
  ["vehicleSwap", "SUBSCRIPTION_VEHICLE_SWAP_ENABLED"]
];

export function parseContractChangeBootstrapMode(args) {
  if (args.length !== 1 || !["--dry-run", "--apply"].includes(args[0])) {
    throw new Error("Specify exactly one of --dry-run or --apply.");
  }
  return args[0] === "--apply" ? "apply" : "dry-run";
}

export function validateContractChangeFeatureFlags(environment) {
  const blockers = [];
  const flags = {};
  for (const [name, key] of FLAG_DEFINITIONS) {
    const value = environment[key];
    flags[name] = value === "true";
    if (value !== "true" && value !== "false") {
      blockers.push({ code: "FEATURE_FLAG_INVALID", flag: key });
    }
  }
  if (
    String(environment.DEPLOYMENT_ENV ?? environment.APP_ENV ?? "").toLowerCase() ===
      "staging" &&
    !flags.extension
  ) {
    blockers.push({
      code: "STAGING_EXTENSION_DISABLED",
      flag: "SUBSCRIPTION_EXTENSION_ENABLED"
    });
  }
  return { blockers, flags };
}

export function buildContractChangeBootstrapPlan(records) {
  const activeOrders = records.filter((order) => order.orderStatus === "ACTIVE");
  const baseSegments = buildSubscriptionSegmentBootstrapPlan(activeOrders);
  const extensionDetails = {
    candidates: [],
    existing: 0
  };
  const exceptions = [...baseSegments.exceptions];

  for (const order of activeOrders) {
    inspectActiveVehiclePeriods(order, exceptions);
    inspectActiveChanges(order, exceptions);
    for (const change of order.subscriptionChanges ?? []) {
      if (change.changeType !== "EXTENSION") continue;
      if (change.extensionDetail) {
        extensionDetails.existing += 1;
        continue;
      }
      const candidate = extensionDetailCandidate(change);
      if (!candidate) {
        exceptions.push({
          changeOrderId: change.id,
          code: "EXTENSION_DETAIL_SOURCE_INCOMPLETE",
          missingFacts: missingExtensionDetailFacts(change),
          orderId: order.id,
          orderNo: order.orderNo
        });
        continue;
      }
      extensionDetails.candidates.push({
        changeOrderId: change.id,
        data: candidate,
        orderId: order.id,
        orderNo: order.orderNo
      });
    }
  }

  return {
    baseSegments,
    exceptions,
    extensionDetails,
    summary: {
      activeOrders: activeOrders.length,
      baseSegmentCandidates: baseSegments.candidates.length,
      exceptions: exceptions.length,
      extensionDetailCandidates: extensionDetails.candidates.length
    }
  };
}

export async function applyContractChangeBootstrapPlan(prisma, plan) {
  const baseSegments = await applySubscriptionSegmentBootstrapPlan(prisma, plan.baseSegments);
  const extensionDetails = await applyExtensionDetails(prisma, plan.extensionDetails.candidates);
  return { baseSegments, extensionDetails };
}

async function applyExtensionDetails(prisma, plannedCandidates) {
  let created = 0;
  let existing = 0;
  const candidates = [...plannedCandidates].sort((left, right) =>
    left.changeOrderId.localeCompare(right.changeOrderId)
  );
  for (const planned of candidates) {
    const result = await prisma.$transaction(
      async (tx) => {
        await lockChange(tx, planned.changeOrderId);
        const current = await tx.subscriptionChangeOrder.findUnique({
          include: { extensionDetail: true },
          where: { id: planned.changeOrderId }
        });
        if (!current || current.changeType !== "EXTENSION") {
          throw new Error(`CONTRACT_CHANGE_BOOTSTRAP_STALE_PLAN:${planned.changeOrderId}`);
        }
        if (current.extensionDetail) return { created: 0, existing: 1 };
        const candidate = extensionDetailCandidate(current);
        if (!candidate || !sameExtensionDetail(candidate, planned.data)) {
          throw new Error(`CONTRACT_CHANGE_BOOTSTRAP_STALE_PLAN:${planned.changeOrderId}`);
        }
        await tx.subscriptionExtensionChangeDetail.create({
          data: { changeOrderId: planned.changeOrderId, ...candidate }
        });
        const stored = await tx.subscriptionExtensionChangeDetail.findUnique({
          where: { changeOrderId: planned.changeOrderId }
        });
        if (!stored || !sameExtensionDetail(stored, candidate)) {
          throw new Error(`CONTRACT_CHANGE_BOOTSTRAP_WRITE_CONFLICT:${planned.changeOrderId}`);
        }
        return { created: 1, existing: 0 };
      },
      { isolationLevel: "Serializable" }
    );
    created += result.created;
    existing += result.existing;
  }
  return { created, existing };
}

function inspectActiveVehiclePeriods(order, exceptions) {
  const open = (order.subscriptionPeriods ?? []).filter((period) => period.endedAt === null);
  if (open.length === 0) {
    exceptions.push(exceptionRow(order, "ACTIVE_VEHICLE_PERIOD_MISSING"));
    return;
  }
  if (open.length > 1) {
    exceptions.push(exceptionRow(order, "ACTIVE_VEHICLE_PERIOD_MULTIPLE", { count: open.length }));
    return;
  }
  const period = open[0];
  if (!validDate(period.startedAt)) {
    exceptions.push(exceptionRow(order, "ACTIVE_VEHICLE_PERIOD_INVALID"));
  } else if (!order.vehicleId || period.vehicleId !== order.vehicleId) {
    exceptions.push(
      exceptionRow(order, "ACTIVE_VEHICLE_PERIOD_VEHICLE_MISMATCH", {
        orderVehicleId: order.vehicleId ?? null,
        periodVehicleId: period.vehicleId ?? null
      })
    );
  }
}

function inspectActiveChanges(order, exceptions) {
  const active = (order.subscriptionChanges ?? []).filter((change) =>
    ACTIVE_CHANGE_STATUSES.has(change.status)
  );
  if (active.length > 1) {
    exceptions.push(
      exceptionRow(order, "ACTIVE_SUBSCRIPTION_CHANGE_MULTIPLE", {
        changeOrderIds: active.map((change) => change.id).sort()
      })
    );
  }
}

function extensionDetailCandidate(change) {
  if (missingExtensionDetailFacts(change).length > 0) return null;
  return {
    extensionMonths: change.extensionMonths,
    priceOverrideApprovedAt: change.priceOverrideApprovedAt ?? null,
    priceOverrideApprovedBy: change.priceOverrideApprovedBy ?? null,
    priceOverrideReason: change.priceOverrideReason ?? null,
    pricingMode: change.pricingMode,
    sourceSegmentId: change.sourceSegmentId,
    targetEndDate: change.targetEndDate,
    targetStartDate: change.targetStartDate
  };
}

function missingExtensionDetailFacts(change) {
  const missing = [];
  if (!change.sourceSegmentId) missing.push("SOURCE_SEGMENT_ID");
  if (!Number.isSafeInteger(change.extensionMonths) || change.extensionMonths <= 0) {
    missing.push("EXTENSION_MONTHS");
  }
  if (!PRICING_MODES.has(change.pricingMode)) missing.push("PRICING_MODE");
  if (!validDate(change.targetStartDate)) missing.push("TARGET_START_DATE");
  if (!validDate(change.targetEndDate)) missing.push("TARGET_END_DATE");
  if (
    validDate(change.targetStartDate) &&
    validDate(change.targetEndDate) &&
    change.targetEndDate.getTime() < change.targetStartDate.getTime()
  ) {
    missing.push("TARGET_DATE_RANGE");
  }
  return missing;
}

function sameExtensionDetail(left, right) {
  return (
    left.sourceSegmentId === right.sourceSegmentId &&
    left.extensionMonths === right.extensionMonths &&
    left.pricingMode === right.pricingMode &&
    sameDate(left.targetStartDate, right.targetStartDate) &&
    sameDate(left.targetEndDate, right.targetEndDate) &&
    (left.priceOverrideReason ?? null) === (right.priceOverrideReason ?? null) &&
    (left.priceOverrideApprovedBy ?? null) === (right.priceOverrideApprovedBy ?? null) &&
    sameOptionalDate(left.priceOverrideApprovedAt, right.priceOverrideApprovedAt)
  );
}

async function lockChange(tx, changeOrderId) {
  if (typeof tx.$queryRawUnsafe !== "function") return;
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_change_order" WHERE "id" = $1::uuid FOR UPDATE',
    changeOrderId
  );
}

function exceptionRow(order, code, detail = {}) {
  return { code, orderId: order.id, orderNo: order.orderNo, ...detail };
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameDate(left, right) {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime();
}

function sameOptionalDate(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  return sameDate(left, right);
}
