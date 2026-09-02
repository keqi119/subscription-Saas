import {
  classifyStage1cPeriodBackfill,
  hashStage1cPeriodBackfillClassification
} from "./stage1c-period-backfill-core.mjs";

const APPLY_LOCK_KEY = "stage1c-period-backfill:apply";
const TRANSACTION_OPTIONS = {
  isolationLevel: "RepeatableRead",
  maxWait: 10_000,
  timeout: 120_000
};

export async function executeStage1cPeriodBackfill({
  classify = classifyStage1cPeriodBackfill,
  expectedClassificationDigest,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1cPeriodBackfillSnapshot,
  mode,
  prisma
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classify(await loadSnapshot(tx)),
      TRANSACTION_OPTIONS
    );
    const safeToApply = isStage1cPeriodBackfillCandidateSetClean(classification);
    return {
      exitCode: safeToApply ? 0 : 1,
      report: buildReport({
        applied: null,
        classification,
        generatedAt,
        mode,
        safeToApply
      })
    };
  }
  if (mode !== "apply") {
    throw new Error("STAGE1C_PERIOD_BACKFILL_MODE_INVALID");
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockStage1cPeriodBackfillTables(tx);
    await lockStage1cPeriodBackfillApply(tx);
    const classification = classify(await loadSnapshot(tx));
    if (
      expectedClassificationDigest !== undefined &&
      hashStage1cPeriodBackfillClassification(classification) !== expectedClassificationDigest
    ) {
      throw Object.assign(new Error("STAGE1C_PERIOD_BACKFILL_PLAN_CHANGED"), {
        code: "STAGE1C_PERIOD_BACKFILL_PLAN_CHANGED"
      });
    }
    const safeToApply = isStage1cPeriodBackfillCandidateSetClean(classification);
    const skippedUnchanged = classification.subscriptionPeriods.filter(
      ({ disposition }) => disposition === "UNCHANGED"
    ).length;
    if (!safeToApply) {
      return {
        applied: { blocked: true, inserted: 0, skippedUnchanged },
        classification,
        safeToApply
      };
    }

    let inserted = 0;
    const confirmedAt = new Date(generatedAt);
    for (const candidate of classification.subscriptionPeriods) {
      if (candidate.disposition !== "CREATE") continue;
      const fact = await tx.vehicleSubscriptionPeriod.create({
        data: {
          ...candidate.payload,
          createdBy: null,
          endConfirmedAt: candidate.payload.endedAt === null ? null : confirmedAt,
          endConfirmedBy: null,
          startConfirmedAt: confirmedAt,
          startConfirmedBy: null
        }
      });
      await tx.auditLog.create({
        data: {
          action: "CREATE",
          afterSnapshot: jsonSnapshot(fact),
          beforeSnapshot: undefined,
          entityId: fact.id,
          entityType: "vehicle_subscription_period",
          module: "asset_facts",
          operatorId: undefined
        }
      });
      inserted += 1;
    }
    return {
      applied: { blocked: false, inserted, skippedUnchanged },
      classification,
      safeToApply
    };
  }, TRANSACTION_OPTIONS);

  return {
    exitCode: outcome.safeToApply ? 0 : 1,
    report: buildReport({
      ...outcome,
      generatedAt,
      mode
    })
  };
}

export function isStage1cPeriodBackfillCandidateSetClean(report) {
  return (
    report.subscriptionPeriods.every(
      ({ disposition }) => disposition === "CREATE" || disposition === "UNCHANGED"
    ) &&
    report.ambiguities.length === 0 &&
    report.overlaps.length === 0 &&
    report.segmentOmissions.length === 0 &&
    report.invariantViolations.length === 0
  );
}

export async function loadStage1cPeriodBackfillSnapshot(db) {
  const assetOwners = await db.assetOwner.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      ownerNo: true,
      ownerType: true,
      status: true
    }
  });
  const contracts = await db.contract.findMany({
    orderBy: { id: "asc" },
    select: {
      contractNo: true,
      customerId: true,
      deletedAt: true,
      id: true,
      orderId: true,
      status: true
    }
  });
  const orders = await db.subscriptionOrder.findMany({
    orderBy: { id: "asc" },
    select: {
      actualReturnAt: true,
      contractId: true,
      customerId: true,
      deletedAt: true,
      id: true,
      orderNo: true,
      orderStatus: true,
      vehicleId: true
    }
  });
  const orderIds = orders.map(({ id }) => id);
  const customerIds = [...new Set(orders.map(({ customerId }) => customerId))];
  const customers = await db.customer.findMany({
    orderBy: { id: "asc" },
    select: {
      customerNo: true,
      deletedAt: true,
      id: true,
      name: true,
      status: true
    },
    where: { id: { in: customerIds } }
  });
  const leases = await db.lease.findMany({
    orderBy: { id: "asc" },
    select: {
      activatedAt: true,
      deletedAt: true,
      id: true,
      orderId: true,
      status: true
    },
    where: { orderId: { in: orderIds } }
  });
  const deliveries = await db.vehicleDelivery.findMany({
    orderBy: { id: "asc" },
    select: {
      customerId: true,
      deletedAt: true,
      deliveredAt: true,
      deliveryStatus: true,
      id: true,
      orderId: true,
      vehicleId: true
    },
    where: { orderId: { in: orderIds } }
  });
  const returns = await db.vehicleReturn.findMany({
    orderBy: { id: "asc" },
    select: {
      customerId: true,
      deletedAt: true,
      id: true,
      orderId: true,
      returnedAt: true,
      returnStatus: true,
      vehicleId: true
    },
    where: { orderId: { in: orderIds } }
  });
  const contractSegments = await db.subscriptionContractSegment.findMany({
    orderBy: { id: "asc" },
    select: {
      endDate: true,
      id: true,
      orderId: true,
      segmentNo: true,
      sourceContractId: true,
      startDate: true,
      status: true
    },
    where: { orderId: { in: orderIds } }
  });
  const vehicles = await db.vehicle.findMany({
    orderBy: { id: "asc" },
    select: {
      deletedAt: true,
      id: true,
      plateNo: true,
      status: true,
      vehicleNo: true,
      vin: true
    }
  });
  const existingOwnershipPeriods = await db.vehicleOwnershipPeriod.findMany({
    orderBy: { id: "asc" },
    select: {
      assetOwnerId: true,
      endedAt: true,
      id: true,
      startedAt: true,
      vehicleId: true
    }
  });
  const existingSubscriptionPeriods = await db.vehicleSubscriptionPeriod.findMany({
    orderBy: { id: "asc" },
    select: {
      contractId: true,
      contractSegmentId: true,
      customerId: true,
      endedAt: true,
      endReason: true,
      endSnapshot: true,
      endSourceId: true,
      endSourceKey: true,
      endSourceType: true,
      id: true,
      orderId: true,
      startedAt: true,
      startReason: true,
      startSnapshot: true,
      startSourceId: true,
      startSourceKey: true,
      startSourceType: true,
      vehicleId: true
    }
  });

  const customersById = new Map(customers.map((customer) => [customer.id, customer]));
  const leasesByOrderId = new Map(leases.map((lease) => [lease.orderId, lease]));
  const deliveriesByOrderId = groupByOrderId(deliveries);
  const returnsByOrderId = groupByOrderId(returns);
  const contractSegmentsByOrderId = groupByOrderId(contractSegments);

  return {
    assetOwners,
    contracts,
    existingOwnershipPeriods,
    existingSubscriptionPeriods,
    orders: orders.map((order) => ({
      ...order,
      contractSegments: contractSegmentsByOrderId.get(order.id) ?? [],
      customer: customersById.get(order.customerId) ?? null,
      deliveries: deliveriesByOrderId.get(order.id) ?? [],
      lease: leasesByOrderId.get(order.id) ?? null,
      returns: returnsByOrderId.get(order.id) ?? []
    })),
    vehicles
  };
}

async function lockStage1cPeriodBackfillApply(tx) {
  await tx.$queryRaw`SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtextextended(${APPLY_LOCK_KEY}, 0))`;
}

async function lockStage1cPeriodBackfillTables(tx) {
  await tx.$executeRaw`LOCK TABLE "vehicle_subscription_period" IN SHARE ROW EXCLUSIVE MODE`;
  await tx.$executeRaw`LOCK TABLE "asset_owner", "contract", "customer", "lease", "subscription_contract_segment", "subscription_order", "vehicle", "vehicle_delivery", "vehicle_ownership_period", "vehicle_return" IN SHARE MODE NOWAIT`;
}

function buildReport({ applied, classification, generatedAt, mode, safeToApply }) {
  return {
    applied,
    classification,
    generatedAt,
    mode,
    safeToApply
  };
}

function jsonSnapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function groupByOrderId(records) {
  const byOrderId = new Map();
  for (const record of records) {
    const values = byOrderId.get(record.orderId) ?? [];
    values.push(record);
    byOrderId.set(record.orderId, values);
  }
  return byOrderId;
}
