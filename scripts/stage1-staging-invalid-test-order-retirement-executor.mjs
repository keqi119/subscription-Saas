import {
  STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET as TARGET,
  classifyStage1StagingInvalidTestOrderRetirement
} from "./stage1-staging-invalid-test-order-retirement-core.mjs";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };
const RETIREMENT_MODULE = "STAGE1_STAGING_TEST_DATA_RETIREMENT";
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
  classify = classifyStage1StagingInvalidTestOrderRetirement,
  generatedAt = new Date().toISOString(),
  loadSnapshot = loadStage1StagingInvalidTestOrderRetirementSnapshot,
  mode,
  operatorId,
  prisma
}) {
  if (mode !== "dry-run") {
    throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_MODE_INVALID");
  }
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

export async function loadStage1StagingInvalidTestOrderRetirementSnapshot(db, { operatorId }) {
  const [
    order,
    lease,
    billingSchedule,
    vehicle,
    operatorRow,
    vehicleDeliveries,
    contracts,
    eSignTasks,
    handovers,
    handoverWorkOrders,
    activeOtherOrders,
    activeOtherLeases,
    activeRestrictions
  ] = await Promise.all([
    db.subscriptionOrder.findUnique({
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
    }),
    db.lease.findUnique({
      select: {
        activatedAt: true,
        deletedAt: true,
        id: true,
        orderId: true,
        status: true
      },
      where: { orderId: TARGET.orderId }
    }),
    db.billingSchedule.findUnique({
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
    }),
    db.vehicle.findUnique({
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
    }),
    db.user.findUnique({
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
    }),
    db.vehicleDelivery.findMany({
      orderBy: { id: "asc" },
      select: { deliveredAt: true, deliveryStatus: true, id: true },
      where: { orderId: TARGET.orderId }
    }),
    db.contract.findMany({
      orderBy: { id: "asc" },
      select: { deletedAt: true, id: true, orderId: true, status: true },
      where: { orderId: TARGET.orderId }
    }),
    db.contractESignTask.findMany({
      orderBy: { id: "asc" },
      select: {
        contractId: true,
        deletedAt: true,
        id: true,
        orderId: true,
        taskStatus: true
      },
      where: { orderId: TARGET.orderId }
    }),
    db.vehicleDeliveryHandover.findMany({
      orderBy: { id: "asc" },
      select: { archiveStatus: true, deletedAt: true, id: true, orderId: true, status: true },
      where: { orderId: TARGET.orderId }
    }),
    db.vehicleHandoverWorkOrder.findMany({
      orderBy: { id: "asc" },
      select: { id: true },
      where: { orderId: TARGET.orderId }
    }),
    db.subscriptionOrder.findMany({
      orderBy: { id: "asc" },
      select: { id: true, orderNo: true, orderStatus: true },
      where: {
        deletedAt: null,
        id: { not: TARGET.orderId },
        orderStatus: { in: NONTERMINAL_ORDER_STATUSES },
        vehicleId: TARGET.vehicleId
      }
    }),
    db.lease.findMany({
      orderBy: { id: "asc" },
      select: { id: true, orderId: true },
      where: {
        deletedAt: null,
        order: { id: { not: TARGET.orderId }, vehicleId: TARGET.vehicleId },
        status: { in: ["ACTIVE", "RETURN_DUE"] }
      }
    }),
    db.vehicleOperationalRestriction.findMany({
      orderBy: { id: "asc" },
      select: { id: true, restrictionType: true, severity: true, status: true },
      where: { status: "ACTIVE", vehicleId: TARGET.vehicleId }
    })
  ]);

  const handoverWorkflowJobs = await db.vehicleHandoverWorkflowJob.findMany({
    orderBy: { id: "asc" },
    select: { handoverId: true, id: true, jobStatus: true, workOrderId: true },
    where: { workOrderId: { in: handoverWorkOrders.map(({ id }) => id) } }
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
  const countEntries = await Promise.all(
    COUNT_QUERIES.map(async ([field, model]) => [
      field,
      await db[model].count({ where: { orderId: TARGET.orderId } })
    ])
  );

  return {
    auditLogs,
    billingSchedule,
    blockingCounts: Object.fromEntries(countEntries),
    evidenceReferences: { contracts, eSignTasks, handovers, handoverWorkflowJobs },
    lease,
    operator: normalizeOperator(operatorRow),
    order,
    vehicle: vehicle
      ? { ...vehicle, activeOtherLeases, activeOtherOrders, activeRestrictions }
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
