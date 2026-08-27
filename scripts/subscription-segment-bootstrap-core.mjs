import { createHash } from "node:crypto";

const ELIGIBLE_ORDER_STATUSES = new Set(["ACTIVE", "PENDING_RETURN"]);

export function parseSubscriptionSegmentBootstrapMode(args) {
  if (args.length !== 1 || !["--dry-run", "--apply"].includes(args[0])) {
    throw new Error("Specify exactly one of --dry-run or --apply.");
  }
  return args[0] === "--apply" ? "apply" : "dry-run";
}

export function buildSubscriptionSegmentBootstrapPlan(records) {
  const candidates = [];
  const exceptions = [];
  let existing = 0;
  let ignored = 0;

  for (const order of records) {
    if (!ELIGIBLE_ORDER_STATUSES.has(order.orderStatus)) {
      ignored += 1;
      continue;
    }

    const baseSegments = (order.contractSegments ?? []).filter(
      (segment) => segment.segmentType === "BASE"
    );
    if (baseSegments.length === 1) {
      existing += 1;
      continue;
    }
    if (baseSegments.length > 1 || (order.contractSegments ?? []).length > 0) {
      exceptions.push(exceptionRow(order, ["CONTRACT_SEGMENT_STATE"]));
      continue;
    }

    const missingFacts = missingSourceFacts(order);
    if (missingFacts.length > 0) {
      exceptions.push(exceptionRow(order, missingFacts));
      continue;
    }

    candidates.push({
      data: {
        activatedAt: order.startDate,
        completedAt: order.orderStatus === "PENDING_RETURN" ? order.endDate : null,
        contractSnapshot: order.contract.contractSnapshot,
        endDate: order.endDate,
        energyLimitCount: order.energyLimitCount ?? null,
        energyLimitKwh: order.energyLimitKwh ?? null,
        mileageLimitKm: order.mileageLimitKm,
        monthlyFeeAmount: order.monthlyFeeAmount,
        orderId: order.id,
        overMileageFeeAmount: order.overMileageFeeAmount,
        planSnapshot: order.finalPlanSnapshot,
        productId: order.productId,
        productVersionId: order.productVersionId,
        quoteSnapshot: order.quoteSnapshot,
        segmentNo: bootstrapSegmentNo(order.id),
        segmentType: "BASE",
        sequenceNo: 1,
        sourceContractId: order.contract.id,
        startDate: order.startDate,
        status: order.orderStatus === "ACTIVE" ? "ACTIVE" : "COMPLETED",
        subscriptionPlanId: null
      },
      orderId: order.id,
      orderNo: order.orderNo
    });
  }

  return {
    candidates,
    exceptions,
    ignored,
    summary: {
      eligible: candidates.length,
      exceptions: exceptions.length,
      existing
    }
  };
}

export async function applySubscriptionSegmentBootstrapPlan(prisma, plan) {
  if (plan.candidates.length === 0) {
    return { created: 0, existing: plan.summary.existing };
  }

  let created = 0;
  let existing = plan.summary.existing;
  const candidates = [...plan.candidates].sort((left, right) =>
    left.orderId.localeCompare(right.orderId)
  );
  for (const planned of candidates) {
    const result = await prisma.$transaction(
      async (tx) => {
        await lockBootstrapSource(tx, planned.orderId);
        const current = await tx.subscriptionOrder.findUnique({
          include: {
            contract: true,
            contractSegments: {
              orderBy: { sequenceNo: "asc" },
              select: { id: true, segmentType: true, sequenceNo: true }
            }
          },
          where: { id: planned.orderId }
        });
        if (!current) {
          throw new Error(`SUBSCRIPTION_SEGMENT_BOOTSTRAP_STALE_PLAN:${planned.orderId}`);
        }
        const rebuilt = buildSubscriptionSegmentBootstrapPlan([current]);
        if (rebuilt.summary.existing === 1) return { created: 0, existing: 1 };
        const candidate = rebuilt.candidates[0];
        if (!candidate || candidate.orderId !== planned.orderId) {
          throw new Error(`SUBSCRIPTION_SEGMENT_BOOTSTRAP_STALE_PLAN:${planned.orderId}`);
        }
        const inserted = await tx.subscriptionContractSegment.createMany({
          data: [candidate.data],
          skipDuplicates: true
        });
        const stored = await tx.subscriptionContractSegment.findMany({
          where: { orderId: { in: [candidate.orderId] } }
        });
        const winner = stored.find(
          (segment) => segment.orderId === candidate.orderId && segment.sequenceNo === 1
        );
        if (!winner || !matchesBootstrapCandidate(winner, candidate.data)) {
          throw new Error(`SUBSCRIPTION_SEGMENT_BOOTSTRAP_WRITE_CONFLICT:${candidate.orderId}`);
        }
        if (inserted.count > 0) {
          await tx.auditLog.create({
            data: {
              action: "CREATE",
              afterSnapshot: segmentAuditSnapshot(winner),
              beforeSnapshot: undefined,
              entityId: winner.id,
              entityType: "subscription_contract_segment",
              module: "subscription_change",
              operatorId: undefined
            }
          });
        }
        return { created: inserted.count, existing: inserted.count === 0 ? 1 : 0 };
      },
      { isolationLevel: "Serializable" }
    );
    created += result.created;
    existing += result.existing;
  }
  return { created, existing };
}

async function lockBootstrapSource(tx, orderId) {
  if (typeof tx.$queryRawUnsafe !== "function") return;
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_order" WHERE "id" = $1::uuid FOR UPDATE',
    orderId
  );
  await tx.$queryRawUnsafe(
    'SELECT "id" FROM "subscription_contract_segment" WHERE "order_id" = $1::uuid ORDER BY "sequence_no" FOR UPDATE',
    orderId
  );
}

function missingSourceFacts(order) {
  const missing = [];
  if (!validDate(order.startDate)) missing.push("START_DATE");
  if (!validDate(order.endDate)) missing.push("END_DATE");
  if (!isJsonObject(order.finalPlanSnapshot)) missing.push("FINAL_PLAN_SNAPSHOT");
  if (!isJsonObject(order.quoteSnapshot)) missing.push("QUOTE_SNAPSHOT");
  if (
    !order.contract ||
    order.contract.status !== "ARCHIVED" ||
    !isJsonObject(order.contract.contractSnapshot)
  ) {
    missing.push("ARCHIVED_MAIN_CONTRACT");
  }
  for (const [fact, value] of [
    ["PRODUCT_ID", order.productId],
    ["PRODUCT_VERSION_ID", order.productVersionId],
    ["MONTHLY_FEE_AMOUNT", order.monthlyFeeAmount],
    ["MILEAGE_LIMIT_KM", order.mileageLimitKm],
    ["OVER_MILEAGE_FEE_AMOUNT", order.overMileageFeeAmount]
  ]) {
    if (value === null || value === undefined || value === "") missing.push(fact);
  }
  return missing;
}

function exceptionRow(order, missingFacts) {
  return {
    code: "BASE_SEGMENT_SOURCE_INCOMPLETE",
    missingFacts,
    orderId: order.id,
    orderNo: order.orderNo
  };
}

function matchesBootstrapCandidate(segment, candidate) {
  return (
    segment.orderId === candidate.orderId &&
    segment.segmentType === "BASE" &&
    segment.sequenceNo === 1 &&
    segment.sourceContractId === candidate.sourceContractId &&
    sameDate(segment.startDate, candidate.startDate) &&
    sameDate(segment.endDate, candidate.endDate)
  );
}

function bootstrapSegmentNo(orderId) {
  return `SEG-BSTR-${String(orderId)
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 48)}`;
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function sameDate(left, right) {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime();
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function segmentAuditSnapshot(segment) {
  return {
    activatedAt: iso(segment.activatedAt),
    completedAt: iso(segment.completedAt),
    contractSnapshotDigest: jsonDigest(segment.contractSnapshot),
    endDate: iso(segment.endDate),
    energyLimitCount: segment.energyLimitCount,
    energyLimitKwh: segment.energyLimitKwh,
    id: segment.id,
    mileageLimitKm: segment.mileageLimitKm,
    monthlyFeeAmount: String(segment.monthlyFeeAmount),
    orderId: segment.orderId,
    overMileageFeeAmount: String(segment.overMileageFeeAmount),
    planSnapshotDigest: jsonDigest(segment.planSnapshot),
    productId: segment.productId,
    productVersionId: segment.productVersionId,
    quoteSnapshotDigest: jsonDigest(segment.quoteSnapshot),
    segmentNo: segment.segmentNo,
    segmentType: segment.segmentType,
    sequenceNo: segment.sequenceNo,
    sourceContractId: segment.sourceContractId,
    startDate: iso(segment.startDate),
    status: segment.status,
    subscriptionPlanId: segment.subscriptionPlanId
  };
}

function jsonDigest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function iso(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
