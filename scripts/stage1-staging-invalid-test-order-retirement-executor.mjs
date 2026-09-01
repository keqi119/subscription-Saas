import { randomUUID } from "node:crypto";

import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET,
  classifyStage1StagingInvalidTestOrderRetirement
} from "./stage1-staging-invalid-test-order-retirement-core.mjs";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };
const RETIREMENT_MODULE = "STAGE1_STAGING_TEST_DATA_RETIREMENT";
const RETIREMENT_REASON = "STAGING_INVALID_TEST_DATA_RETIREMENT";
const APPLY_LOCK_KEY = "stage1-staging-invalid-test-order-retirement:apply";
const STAGING_DATABASE_NAME = "subscription_saas_staging";
const SNAPSHOT_RELATIONS = Object.freeze([
  "asset_work_order",
  "audit_log",
  "billing_schedule",
  "collection_action",
  "collection_case",
  "collection_case_bill",
  "contract",
  "contract_esign_task",
  "debit_attempt",
  "deposit_ledger",
  "file_object",
  "insurance_claim",
  "lease",
  "order_change",
  "order_entitlement_account",
  "order_entitlement_grant",
  "order_entitlement_usage",
  "order_mileage_review",
  "payment_mandate",
  "payment_order",
  "payment_record",
  "payment_write_off",
  "receivable_bill",
  "renewal_consideration",
  "revenue_right_assignment",
  "role",
  "service_case",
  "subscription_automation_job",
  "subscription_change_order",
  "subscription_closure_case",
  "subscription_contract_segment",
  "subscription_journey",
  "subscription_journey_event",
  "subscription_journey_exception",
  "subscription_journey_job",
  "subscription_journey_manual_task",
  "subscription_journey_outbox",
  "subscription_journey_step",
  "subscription_order",
  "user",
  "user_role",
  "vehicle",
  "vehicle_cost_ledger_entry",
  "vehicle_delivery",
  "vehicle_delivery_evidence_file",
  "vehicle_delivery_evidence_item",
  "vehicle_delivery_handover",
  "vehicle_handover_work_order",
  "vehicle_handover_workflow_job",
  "vehicle_mileage_reading",
  "vehicle_operational_restriction",
  "vehicle_return",
  "vehicle_return_damage",
  "vehicle_subscription_period"
]);
const NONTERMINAL_ORDER_STATUSES = [
  "PENDING_REVIEW",
  "PENDING_CUSTOMER_CONFIRMATION",
  "PENDING_CONTRACT",
  "PENDING_SIGN",
  "PENDING_PAYMENT",
  "PENDING_VEHICLE",
  "PENDING_DELIVERY",
  "ACTIVE",
  "SUSPENDED",
  "PENDING_RETURN",
  "RETURNED_PENDING_SETTLEMENT"
];
const COUNT_QUERIES = [
  ["assetWorkOrders", "assetWorkOrder"],
  ["automationJobs", "subscriptionAutomationJob"],
  ["closureCases", "subscriptionClosureCase"],
  ["collectionActions", "collectionAction"],
  ["collectionCaseBills", "collectionCaseBill"],
  ["collectionCases", "collectionCase"],
  ["contractSegments", "subscriptionContractSegment"],
  ["costLedgerEntries", "vehicleCostLedgerEntry"],
  ["debitAttempts", "debitAttempt"],
  ["depositLedgers", "depositLedger"],
  ["entitlementAccounts", "orderEntitlementAccount"],
  ["entitlementGrants", "orderEntitlementGrant"],
  ["entitlementUsages", "orderEntitlementUsage"],
  ["insuranceClaims", "insuranceClaim"],
  ["mileageReadings", "vehicleMileageReading"],
  ["mileageReviews", "orderMileageReview"],
  ["orderChanges", "orderChange"],
  ["paymentMandates", "paymentMandate"],
  ["paymentOrders", "paymentOrder"],
  ["paymentRecords", "paymentRecord"],
  ["paymentWriteOffs", "paymentWriteOff"],
  ["receivableBills", "receivableBill"],
  ["renewalConsiderations", "renewalConsideration"],
  ["returnDamages", "vehicleReturnDamage"],
  ["returns", "vehicleReturn"],
  ["revenueRightAssignments", "revenueRightAssignment"],
  ["serviceCases", "serviceCase"],
  ["subscriptionChanges", "subscriptionChangeOrder"],
  ["subscriptionPeriods", "vehicleSubscriptionPeriod"]
];

export async function executeStage1StagingInvalidTestOrderRetirement({
  assertDatabaseIdentity = assertStagingDatabase,
  classify = classifyStage1StagingInvalidTestOrderRetirement,
  expectedEvidenceDigest,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1StagingInvalidTestOrderRetirementSnapshot,
  mode,
  now = () => new Date(),
  operatorId,
  prisma,
  randomUuid = randomUUID
}) {
  if (mode === "dry-run") {
    const classification = await prisma.$transaction(
      async (tx) => classify(await loadSnapshot(tx, { operatorId })),
      { ...TRANSACTION_OPTIONS, isolationLevel: "RepeatableRead" }
    );
    const safeToApply = classification.disposition !== "BLOCKED";
    return {
      exitCode: safeToApply ? 0 : 1,
      report: {
        applied: null,
        classification,
        generatedAt,
        mode,
        safeToApply
      }
    };
  }
  if (mode !== "apply") {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_MODE_INVALID");
  }

  const outcome = await prisma.$transaction(
    async (tx) => {
      await assertDatabaseIdentity(tx);
      await lockApply(tx);
      await lockSnapshotRelations(tx);
      await lockTargetRows(tx);
      const snapshot = await loadSnapshot(tx, { operatorId });
      const classification = classify(snapshot);
      if (classification.disposition === "BLOCKED") {
        return {
          applied: emptyApplyResult({ blocked: true }),
          classification,
          safeToApply: false
        };
      }
      if (classification.evidenceDigest !== expectedEvidenceDigest) {
        throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EVIDENCE_DIGEST_MISMATCH");
      }
      if (classification.disposition === "UNCHANGED") {
        return {
          applied: emptyApplyResult({ blocked: false, skippedUnchanged: 1 }),
          classification,
          safeToApply: true
        };
      }

      const changedAt = now();
      const correlationId = randomUuid();
      await cancelBillingSchedule(tx, snapshot, changedAt);
      await completeLease(tx, snapshot, operatorId);
      await cancelOrder(tx, snapshot, operatorId);
      await releaseVehicle(tx, snapshot, operatorId);
      await createRetirementAudits(tx, snapshot, {
        changedAt,
        correlationId,
        evidenceDigest: classification.evidenceDigest,
        operatorId
      });
      await assertPostconditions(tx, {
        classify,
        evidenceDigest: classification.evidenceDigest,
        loadSnapshot,
        operatorId
      });
      return {
        applied: {
          auditsCreated: 4,
          billingSchedulesUpdated: 1,
          blocked: false,
          correlationId,
          leasesUpdated: 1,
          ordersUpdated: 1,
          skippedUnchanged: 0,
          vehiclesUpdated: 1
        },
        classification,
        safeToApply: true
      };
    },
    { ...TRANSACTION_OPTIONS, isolationLevel: "Serializable" }
  );

  return {
    exitCode: outcome.safeToApply ? 0 : 1,
    report: { ...outcome, generatedAt, mode }
  };
}

export async function loadStage1StagingInvalidTestOrderRetirementSnapshot(db, { operatorId }) {
  const order = await db.subscriptionOrder.findUnique({
    select: {
      actualDeliveryAt: true,
      actualReturnAt: true,
      contractId: true,
      deletedAt: true,
      endDate: true,
      id: true,
      orderNo: true,
      orderStatus: true,
      startDate: true,
      vehicleId: true
    },
    where: { id: TARGET.orderId }
  });
  const lease = await db.lease.findUnique({
    select: {
      activatedAt: true,
      deletedAt: true,
      id: true,
      orderId: true,
      status: true
    },
    where: { orderId: TARGET.orderId }
  });
  const billingSchedule = await db.billingSchedule.findUnique({
    select: {
      cancelledAt: true,
      id: true,
      lastGeneratedBillId: true,
      orderId: true,
      pauseReason: true,
      status: true,
      version: true
    },
    where: { orderId: TARGET.orderId }
  });
  const vehicle = await db.vehicle.findUnique({
    select: {
      currentSalePriceAmount: true,
      deletedAt: true,
      id: true,
      salePriceStatus: true,
      status: true,
      vehicleNo: true,
      vin: true
    },
    where: { id: TARGET.vehicleId }
  });
  const operatorRow = await db.user.findUnique({
    select: {
      deletedAt: true,
      id: true,
      roles: {
        orderBy: { id: "asc" },
        select: {
          deletedAt: true,
          role: { select: { code: true, deletedAt: true, status: true } }
        }
      },
      status: true
    },
    where: { id: operatorId }
  });
  const journey = await db.subscriptionJourney.findUnique({
    select: {
      currentStepCode: true,
      currentStepStatus: true,
      events: {
        orderBy: { id: "asc" },
        select: { eventType: true, id: true, sequence: true }
      },
      exceptions: {
        orderBy: { id: "asc" },
        select: {
          code: true,
          id: true,
          jobId: true,
          retryable: true,
          status: true,
          stepId: true
        }
      },
      id: true,
      jobs: {
        orderBy: { id: "asc" },
        select: { id: true, jobType: true, status: true, stepId: true }
      },
      manualTasks: {
        orderBy: { id: "asc" },
        select: { id: true, status: true, stepId: true, taskType: true }
      },
      orderId: true,
      outboxRows: {
        orderBy: { id: "asc" },
        select: {
          aggregateId: true,
          aggregateType: true,
          eventType: true,
          id: true,
          status: true
        }
      },
      status: true,
      steps: {
        orderBy: { id: "asc" },
        select: { code: true, id: true, status: true }
      }
    },
    where: { orderId: TARGET.orderId }
  });
  const vehicleDeliveries = await db.vehicleDelivery.findMany({
    orderBy: { id: "asc" },
    select: { deliveredAt: true, deliveryStatus: true, id: true },
    where: { orderId: TARGET.orderId }
  });
  const contracts = await db.contract.findMany({
    orderBy: { id: "asc" },
    select: {
      contractVersionId: true,
      deletedAt: true,
      fileId: true,
      id: true,
      orderId: true,
      status: true
    },
    where: { orderId: TARGET.orderId }
  });
  const eSignTasks = await db.contractESignTask.findMany({
    orderBy: { id: "asc" },
    select: {
      contractId: true,
      deletedAt: true,
      id: true,
      orderId: true,
      sourceId: true,
      sourceType: true,
      taskStatus: true
    },
    where: { orderId: TARGET.orderId }
  });
  const handovers = await db.vehicleDeliveryHandover.findMany({
    orderBy: { id: "asc" },
    select: {
      archiveStatus: true,
      deletedAt: true,
      handoverContractId: true,
      handoverESignTaskId: true,
      id: true,
      orderId: true,
      signedDocumentFileId: true,
      sourceDocumentFileId: true,
      stage1ContractId: true,
      status: true
    },
    where: { orderId: TARGET.orderId }
  });
  const handoverWorkOrders = await db.vehicleHandoverWorkOrder.findMany({
    orderBy: { id: "asc" },
    select: { handoverId: true, id: true, orderId: true, status: true },
    where: { orderId: TARGET.orderId }
  });
  const evidenceItems = await db.vehicleDeliveryEvidenceItem.findMany({
    orderBy: { id: "asc" },
    select: {
      handoverId: true,
      id: true,
      orderId: true,
      reviewStatus: true,
      status: true,
      vehicleDeliveryId: true
    },
    where: { orderId: TARGET.orderId }
  });
  const activeOtherOrders = await db.subscriptionOrder.findMany({
    orderBy: { id: "asc" },
    select: { id: true, orderNo: true, orderStatus: true },
    where: {
      deletedAt: null,
      id: { not: TARGET.orderId },
      orderStatus: { in: NONTERMINAL_ORDER_STATUSES },
      vehicleId: TARGET.vehicleId
    }
  });
  const activeOtherLeases = await db.lease.findMany({
    orderBy: { id: "asc" },
    select: { id: true, orderId: true },
    where: {
      deletedAt: null,
      order: { id: { not: TARGET.orderId }, vehicleId: TARGET.vehicleId },
      status: { not: "COMPLETED" }
    }
  });
  const activeRestrictions = await db.vehicleOperationalRestriction.findMany({
    orderBy: { id: "asc" },
    select: { id: true, restrictionType: true, severity: true, status: true },
    where: { status: "ACTIVE", vehicleId: TARGET.vehicleId }
  });
  const activeSubscriptionPeriods = await db.vehicleSubscriptionPeriod.findMany({
    orderBy: { id: "asc" },
    select: { id: true, orderId: true },
    where: { endedAt: null, vehicleId: TARGET.vehicleId }
  });

  const handoverWorkflowJobs = await db.vehicleHandoverWorkflowJob.findMany({
    orderBy: { id: "asc" },
    select: {
      eSignTaskId: true,
      handoverId: true,
      id: true,
      jobStatus: true,
      workOrderId: true
    },
    where: { workOrderId: { in: handoverWorkOrders.map(({ id }) => id) } }
  });
  const evidenceFiles = await db.vehicleDeliveryEvidenceFile.findMany({
    orderBy: { id: "asc" },
    select: {
      evidenceItemId: true,
      fileId: true,
      id: true,
      lifecycleStatus: true,
      replacedById: true
    },
    where: { evidenceItemId: { in: evidenceItems.map(({ id }) => id) } }
  });
  const referencedFileIds = [
    ...contracts.map(({ fileId }) => fileId),
    ...handovers.flatMap(({ signedDocumentFileId, sourceDocumentFileId }) => [
      signedDocumentFileId,
      sourceDocumentFileId
    ]),
    ...evidenceFiles.map(({ fileId }) => fileId)
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  const fileObjects = await db.fileObject.findMany({
    orderBy: { id: "asc" },
    select: { contentSha256: true, createdAt: true, id: true, sizeBytes: true },
    where: { id: { in: referencedFileIds } }
  });
  const entityIds = [billingSchedule?.id, lease?.id, TARGET.orderId, TARGET.vehicleId].filter(
    Boolean
  );
  const auditLogs = await db.auditLog.findMany({
    orderBy: { id: "asc" },
    select: {
      action: true,
      afterSnapshot: true,
      beforeSnapshot: true,
      entityId: true,
      entityType: true,
      module: true,
      operatorId: true
    },
    where: { entityId: { in: entityIds }, module: RETIREMENT_MODULE }
  });
  const countEntries = [];
  for (const [field, model] of COUNT_QUERIES) {
    const where =
      field === "assetWorkOrders"
        ? { OR: [{ orderId: TARGET.orderId }, { vehicleId: TARGET.vehicleId }] }
        : { orderId: TARGET.orderId };
    countEntries.push([field, await db[model].count({ where })]);
  }

  return {
    auditLogs,
    billingSchedule,
    blockingCounts: Object.fromEntries(countEntries),
    evidenceReferences: {
      contracts,
      eSignTasks,
      evidenceFiles,
      evidenceItems,
      fileObjects,
      handovers,
      handoverWorkOrders,
      handoverWorkflowJobs
    },
    journey,
    lease,
    operator: normalizeOperator(operatorRow),
    order,
    vehicle: vehicle
      ? {
          ...vehicle,
          activeOtherLeases,
          activeOtherOrders,
          activeRestrictions,
          activeSubscriptionPeriods
        }
      : null,
    vehicleDeliveries
  };
}

function normalizeOperator(operator) {
  if (!operator) return null;
  return {
    deletedAt: operator.deletedAt,
    id: operator.id,
    roles: (operator.roles ?? []).map((assignment) => ({
      code: assignment.role.code,
      deletedAt: assignment.deletedAt,
      roleDeletedAt: assignment.role.deletedAt,
      roleStatus: assignment.role.status
    })),
    status: operator.status
  };
}

async function lockApply(tx) {
  await tx.$queryRawUnsafe(
    "SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtext($1))",
    APPLY_LOCK_KEY
  );
}

async function assertStagingDatabase(tx) {
  const rows = await tx.$queryRawUnsafe('SELECT current_database() AS "databaseName"');
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.databaseName !== STAGING_DATABASE_NAME
  ) {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_DATABASE_IDENTITY_MISMATCH");
  }
}

async function lockSnapshotRelations(tx) {
  const relations = SNAPSHOT_RELATIONS.map((relation) => `"${relation}"`).join(", ");
  await tx.$queryRawUnsafe(`LOCK TABLE ${relations} IN SHARE ROW EXCLUSIVE MODE`);
}

async function lockTargetRows(tx) {
  await tx.$queryRawUnsafe(
    "SELECT id FROM subscription_order WHERE id = $1::uuid FOR UPDATE",
    TARGET.orderId
  );
  await tx.$queryRawUnsafe(
    "SELECT id FROM lease WHERE order_id = $1::uuid FOR UPDATE",
    TARGET.orderId
  );
  await tx.$queryRawUnsafe(
    "SELECT id FROM billing_schedule WHERE order_id = $1::uuid FOR UPDATE",
    TARGET.orderId
  );
  await tx.$queryRawUnsafe(
    "SELECT id FROM vehicle WHERE id = $1::uuid FOR UPDATE",
    TARGET.vehicleId
  );
}

async function cancelBillingSchedule(tx, snapshot, changedAt) {
  const current = snapshot.billingSchedule;
  const updated = await tx.billingSchedule.updateMany({
    data: {
      cancelledAt: changedAt,
      pauseReason: RETIREMENT_REASON,
      status: "CANCELLED",
      version: { increment: 1 }
    },
    where: {
      cancelledAt: current.cancelledAt,
      id: current.id,
      lastGeneratedBillId: current.lastGeneratedBillId,
      orderId: TARGET.orderId,
      status: "PAUSED",
      version: current.version
    }
  });
  assertSingleUpdate(updated, "BILLING_SCHEDULE");
}

async function completeLease(tx, snapshot, operatorId) {
  const current = snapshot.lease;
  const updated = await tx.lease.updateMany({
    data: { status: "COMPLETED", updatedBy: operatorId },
    where: {
      deletedAt: null,
      id: current.id,
      orderId: TARGET.orderId,
      status: "ACTIVE"
    }
  });
  assertSingleUpdate(updated, "LEASE");
}

async function cancelOrder(tx, snapshot, operatorId) {
  const current = snapshot.order;
  const updated = await tx.subscriptionOrder.updateMany({
    data: { orderStatus: "CANCELLED", updatedBy: operatorId },
    where: {
      actualReturnAt: null,
      deletedAt: null,
      id: TARGET.orderId,
      orderNo: TARGET.orderNo,
      orderStatus: "ACTIVE",
      vehicleId: TARGET.vehicleId
    }
  });
  assertSingleUpdate(updated, "ORDER");
}

async function releaseVehicle(tx, snapshot, operatorId) {
  const current = snapshot.vehicle;
  const updated = await tx.vehicle.updateMany({
    data: { status: "AVAILABLE", updatedBy: operatorId },
    where: {
      currentSalePriceAmount: current.currentSalePriceAmount,
      deletedAt: null,
      id: TARGET.vehicleId,
      salePriceStatus: "EFFECTIVE",
      status: "LEASED",
      vehicleNo: TARGET.vehicleNo,
      vin: TARGET.vin
    }
  });
  assertSingleUpdate(updated, "VEHICLE");
}

async function createRetirementAudits(
  tx,
  snapshot,
  { changedAt, correlationId, evidenceDigest, operatorId }
) {
  const rows = [
    {
      after: {
        cancelledAt: iso(changedAt),
        status: "CANCELLED",
        version: snapshot.billingSchedule.version + 1
      },
      before: {
        cancelledAt: iso(snapshot.billingSchedule.cancelledAt),
        status: "PAUSED",
        version: snapshot.billingSchedule.version
      },
      entityId: snapshot.billingSchedule.id,
      entityType: "billing_schedule"
    },
    {
      after: { status: "COMPLETED" },
      before: { status: "ACTIVE" },
      entityId: snapshot.lease.id,
      entityType: "lease"
    },
    {
      after: { orderNo: TARGET.orderNo, status: "CANCELLED" },
      before: { orderNo: TARGET.orderNo, status: "ACTIVE" },
      entityId: TARGET.orderId,
      entityType: "subscription_order"
    },
    {
      after: { status: "AVAILABLE", vehicleNo: TARGET.vehicleNo },
      before: { status: "LEASED", vehicleNo: TARGET.vehicleNo },
      entityId: TARGET.vehicleId,
      entityType: "vehicle"
    }
  ];
  for (const row of rows) {
    await tx.auditLog.create({
      data: {
        action: "UPDATE",
        afterSnapshot: retirementAuditSnapshot(row.after, {
          correlationId,
          entityId: row.entityId,
          evidenceDigest
        }),
        beforeSnapshot: retirementAuditSnapshot(row.before, {
          correlationId,
          entityId: row.entityId,
          evidenceDigest
        }),
        entityId: row.entityId,
        entityType: row.entityType,
        module: RETIREMENT_MODULE,
        operatorId,
        userAgent: "stage1-staging-invalid-test-order-retirement-cli"
      }
    });
  }
}

function retirementAuditSnapshot(state, { correlationId, entityId, evidenceDigest }) {
  return {
    ...state,
    correlationId,
    entityId,
    evidenceDigest,
    reasonCode: RETIREMENT_REASON
  };
}

async function assertPostconditions(tx, { classify, evidenceDigest, loadSnapshot, operatorId }) {
  const classification = classify(await loadSnapshot(tx, { operatorId }));
  if (
    classification.disposition !== "UNCHANGED" ||
    classification.evidenceDigest !== evidenceDigest
  ) {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_POSTCONDITION_FAILED");
  }
}

function emptyApplyResult({ blocked, skippedUnchanged = 0 }) {
  return {
    auditsCreated: 0,
    billingSchedulesUpdated: 0,
    blocked,
    correlationId: null,
    leasesUpdated: 0,
    ordersUpdated: 0,
    skippedUnchanged,
    vehiclesUpdated: 0
  };
}

function assertSingleUpdate(result, entity) {
  if (result.count !== 1) {
    throw new Error(`STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_STALE_${entity}`);
  }
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
