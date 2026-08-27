import { classifyStage1ActiveSourceFactsRepair } from "./stage1-active-source-facts-repair-core.mjs";

const APPLY_LOCK_KEY = "stage1-active-source-facts-repair:apply";
const TRANSACTION_BASE = { maxWait: 10_000, timeout: 120_000 };

export async function executeStage1ActiveSourceFactsRepair({
  classify = classifyStage1ActiveSourceFactsRepair,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1ActiveSourceFactsRepairSnapshot,
  mode,
  prisma
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classify(await loadSnapshot(tx)),
      { ...TRANSACTION_BASE, isolationLevel: "RepeatableRead" }
    );
    const safeToApply = isStage1ActiveSourceFactsRepairCandidateSetClean(classification);
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
    throw new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_MODE_INVALID");
  }

  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockApply(tx);
      await lockTables(tx);
      const snapshot = await loadSnapshot(tx);
      const classification = classify(snapshot);
      const safeToApply = isStage1ActiveSourceFactsRepairCandidateSetClean(classification);
      const skippedUnchanged = classification.unchanged.length;
      if (!safeToApply) {
        return {
          applied: emptyApplyResult({ blocked: true, skippedUnchanged }),
          classification,
          safeToApply
        };
      }

      let audits = 0;
      let contractsUpdated = 0;
      let ordersUpdated = 0;
      const ordersById = new Map(snapshot.orders.map((order) => [order.id, order]));
      for (const candidate of [...classification.candidates].sort(compareOrderId)) {
        const order = ordersById.get(candidate.orderId);
        const contract = order?.contracts?.find(({ id }) => id === candidate.contractId);
        if (!order || !contract) {
          throw new Error(`STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_STALE_PLAN:${candidate.orderId}`);
        }

        if (candidate.actions.includes("ARCHIVE_CONTRACT")) {
          await archiveContract(tx, contract, candidate);
          contractsUpdated += 1;
          audits += 1;
        }
        if (
          candidate.actions.includes("BIND_CONTRACT") ||
          candidate.actions.includes("SET_ORDER_DATES")
        ) {
          await repairOrder(tx, order, candidate);
          ordersUpdated += 1;
          audits += 1;
        }
      }

      return {
        applied: {
          audits,
          blocked: false,
          contractsUpdated,
          ordersUpdated,
          skippedUnchanged
        },
        classification,
        safeToApply
      };
    },
    { ...TRANSACTION_BASE, isolationLevel: "Serializable" }
  );

  return {
    exitCode: outcome.safeToApply ? 0 : 1,
    report: buildReport({ ...outcome, generatedAt, mode })
  };
}

export function isStage1ActiveSourceFactsRepairCandidateSetClean(classification) {
  return Array.isArray(classification?.candidates) && classification.exceptions?.length === 0;
}

export async function loadStage1ActiveSourceFactsRepairSnapshot(db) {
  const orders = await db.subscriptionOrder.findMany({
    orderBy: { id: "asc" },
    select: {
      actualDeliveryAt: true,
      contractId: true,
      customerId: true,
      deletedAt: true,
      endDate: true,
      id: true,
      orderNo: true,
      orderStatus: true,
      periodMonths: true,
      startDate: true,
      vehicleId: true
    },
    where: {
      deletedAt: null,
      orderStatus: { in: ["ACTIVE", "PENDING_RETURN"] }
    }
  });
  const orderIds = orders.map(({ id }) => id);
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
  const contracts = await db.contract.findMany({
    orderBy: { id: "asc" },
    select: {
      archivedAt: true,
      businessType: true,
      contractNo: true,
      contractSnapshot: true,
      customerId: true,
      deletedAt: true,
      fileId: true,
      id: true,
      orderId: true,
      signedAt: true,
      status: true
    },
    where: { orderId: { in: orderIds } }
  });
  const contractIds = contracts.map(({ id }) => id);
  const tasks = await db.contractESignTask.findMany({
    orderBy: { id: "asc" },
    select: {
      completedAt: true,
      contractId: true,
      customerId: true,
      deletedAt: true,
      documentType: true,
      id: true,
      orderId: true,
      signedDocumentObjectKey: true,
      signingStage: true,
      taskStatus: true
    },
    where: { contractId: { in: contractIds } }
  });
  const fileIds = [...new Set(contracts.map(({ fileId }) => fileId).filter(Boolean))];
  const files = await db.fileObject.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      mimeType: true,
      objectKey: true,
      sizeBytes: true
    },
    where: { id: { in: fileIds } }
  });
  const contractSegments = await db.subscriptionContractSegment.findMany({
    orderBy: { id: "asc" },
    select: { id: true, orderId: true },
    where: { orderId: { in: orderIds } }
  });
  const subscriptionPeriods = await db.vehicleSubscriptionPeriod.findMany({
    orderBy: { id: "asc" },
    select: { id: true, orderId: true },
    where: { orderId: { in: orderIds } }
  });

  const deliveriesByOrder = groupBy(deliveries, "orderId");
  const leasesByOrder = groupBy(leases, "orderId");
  const contractsByOrder = groupBy(contracts, "orderId");
  const tasksByContract = groupBy(tasks, "contractId");
  const filesById = new Map(files.map((file) => [file.id, file]));
  const segmentsByOrder = groupBy(contractSegments, "orderId");
  const periodsByOrder = groupBy(subscriptionPeriods, "orderId");

  return {
    orders: orders.map((order) => {
      const orderLeases = leasesByOrder.get(order.id) ?? [];
      return {
        ...order,
        contractSegments: segmentsByOrder.get(order.id) ?? [],
        contracts: (contractsByOrder.get(order.id) ?? []).map((contract) => ({
          ...contract,
          eSignTasks: tasksByContract.get(contract.id) ?? [],
          file: contract.fileId ? (filesById.get(contract.fileId) ?? null) : null
        })),
        deliveries: deliveriesByOrder.get(order.id) ?? [],
        lease: orderLeases.length === 1 ? orderLeases[0] : null,
        leases: orderLeases,
        subscriptionPeriods: periodsByOrder.get(order.id) ?? []
      };
    })
  };
}

async function archiveContract(tx, contract, candidate) {
  const updated = await tx.contract.updateMany({
    data: {
      archivedAt: new Date(candidate.archivedAt),
      status: "ARCHIVED"
    },
    where: {
      archivedAt: contract.archivedAt,
      deletedAt: null,
      id: contract.id,
      status: "SIGNED"
    }
  });
  assertSingleUpdate(updated, "CONTRACT", candidate.orderId);
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: contractAuditSnapshot(
        { ...contract, archivedAt: candidate.archivedAt, status: "ARCHIVED" },
        candidate
      ),
      beforeSnapshot: contractAuditSnapshot(contract, candidate),
      entityId: contract.id,
      entityType: "contract",
      module: "subscription_change",
      operatorId: undefined
    }
  });
}

async function repairOrder(tx, order, candidate) {
  const data = {};
  if (candidate.actions.includes("BIND_CONTRACT")) data.contractId = candidate.contractId;
  if (candidate.actions.includes("SET_ORDER_DATES")) {
    data.startDate = utcDate(candidate.startDate);
    data.endDate = utcDate(candidate.endDate);
  }
  const updated = await tx.subscriptionOrder.updateMany({
    data,
    where: {
      actualDeliveryAt: order.actualDeliveryAt,
      contractId: order.contractId,
      deletedAt: null,
      endDate: order.endDate,
      id: order.id,
      orderStatus: { in: ["ACTIVE", "PENDING_RETURN"] },
      startDate: order.startDate
    }
  });
  assertSingleUpdate(updated, "ORDER", candidate.orderId);
  await tx.auditLog.create({
    data: {
      action: "UPDATE",
      afterSnapshot: orderAuditSnapshot({ ...order, ...data }, candidate),
      beforeSnapshot: orderAuditSnapshot(order, candidate),
      entityId: order.id,
      entityType: "subscription_order",
      module: "subscription_change",
      operatorId: undefined
    }
  });
}

function contractAuditSnapshot(contract, candidate) {
  return {
    archivedAt: iso(contract.archivedAt),
    contractId: contract.id,
    contractNo: contract.contractNo ?? null,
    evidenceDigest: candidate.evidenceDigest,
    fileId: contract.fileId,
    repairActions: candidate.actions.filter((action) => action === "ARCHIVE_CONTRACT"),
    signedAt: iso(contract.signedAt),
    status: contract.status
  };
}

function orderAuditSnapshot(order, candidate) {
  return {
    actualDeliveryAt: iso(order.actualDeliveryAt),
    contractId: order.contractId,
    endDate: calendarDate(order.endDate),
    evidenceDigest: candidate.evidenceDigest,
    orderId: order.id,
    orderNo: order.orderNo ?? null,
    orderStatus: order.orderStatus,
    repairActions: candidate.actions.filter((action) => action !== "ARCHIVE_CONTRACT"),
    startDate: calendarDate(order.startDate)
  };
}

function emptyApplyResult({ blocked, skippedUnchanged }) {
  return {
    audits: 0,
    blocked,
    contractsUpdated: 0,
    ordersUpdated: 0,
    skippedUnchanged
  };
}

async function lockApply(tx) {
  await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", APPLY_LOCK_KEY);
}

async function lockTables(tx) {
  await tx.$queryRawUnsafe(`
    LOCK TABLE subscription_order, contract, contract_esign_task,
      file_object, vehicle_delivery, lease, subscription_contract_segment,
      vehicle_subscription_period IN SHARE ROW EXCLUSIVE MODE NOWAIT
  `);
}

function assertSingleUpdate(result, entity, orderId) {
  if (result.count !== 1) {
    throw new Error(`STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_STALE_${entity}:${orderId}`);
  }
}

function buildReport({ applied, classification, generatedAt, mode, safeToApply }) {
  return { applied, classification, generatedAt, mode, safeToApply };
}

function groupBy(records, field) {
  const grouped = new Map();
  for (const record of records) {
    const values = grouped.get(record[field]) ?? [];
    values.push(record);
    grouped.set(record[field], values);
  }
  return grouped;
}

function compareOrderId(left, right) {
  return left.orderId.localeCompare(right.orderId);
}

function utcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function calendarDate(value) {
  return iso(value)?.slice(0, 10) ?? null;
}
