import { createHash } from "node:crypto";

export const STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET = Object.freeze({
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RETIREMENT_MODULE = "STAGE1_STAGING_TEST_DATA_RETIREMENT";
const RETIREMENT_REASON = "STAGING_INVALID_TEST_DATA_RETIREMENT";
const BLOCKING_COUNT_FIELDS = [
  "assetWorkOrders",
  "automationJobs",
  "closureCases",
  "collectionActions",
  "collectionCaseBills",
  "collectionCases",
  "contractSegments",
  "costLedgerEntries",
  "debitAttempts",
  "depositLedgers",
  "entitlementAccounts",
  "entitlementGrants",
  "entitlementUsages",
  "insuranceClaims",
  "mileageReadings",
  "mileageReviews",
  "orderChanges",
  "paymentMandates",
  "paymentOrders",
  "paymentRecords",
  "paymentWriteOffs",
  "receivableBills",
  "renewalConsiderations",
  "returnDamages",
  "returns",
  "revenueRightAssignments",
  "serviceCases",
  "subscriptionChanges",
  "subscriptionPeriods"
];
const EXPECTED_AUDITS = [
  ["billing_schedule", "billingSchedule", "PAUSED", "CANCELLED"],
  ["lease", "lease", "ACTIVE", "COMPLETED"],
  ["subscription_order", "order", "ACTIVE", "CANCELLED"],
  ["vehicle", "vehicle", "LEASED", "AVAILABLE"]
];
const TERMINAL_ESIGN_TASK_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
const TERMINAL_HANDOVER_JOB_STATUSES = new Set(["COMPLETED", "DEAD_LETTER", "CANCELLED"]);
const SELECTOR_OPTIONS = new Map([
  ["--order-id", "orderId"],
  ["--order-no", "orderNo"],
  ["--vehicle-id", "vehicleId"],
  ["--vehicle-no", "vehicleNo"],
  ["--vin", "vin"]
]);

export function parseStage1StagingInvalidTestOrderRetirementArgs(args) {
  let expectedEvidenceDigest = null;
  let mode = null;
  let operatorId = null;
  let output = null;
  const selectors = {};
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      useOnce(seen, "mode");
      mode = argument === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (SELECTOR_OPTIONS.has(argument)) {
      const field = SELECTOR_OPTIONS.get(argument);
      useOnce(seen, field);
      selectors[field] = optionValue(args, ++index);
      continue;
    }
    if (argument === "--operator-id") {
      useOnce(seen, "operatorId");
      operatorId = optionValue(args, ++index);
      continue;
    }
    if (argument === "--expected-evidence-digest") {
      useOnce(seen, "expectedEvidenceDigest");
      expectedEvidenceDigest = optionValue(args, ++index);
      continue;
    }
    if (argument === "--output") {
      useOnce(seen, "output");
      output = optionValue(args, ++index);
      continue;
    }
    if (typeof argument === "string" && argument.startsWith("--output=")) {
      useOnce(seen, "output");
      output = nonempty(argument.slice("--output=".length));
      continue;
    }
    invalidArguments();
  }

  if (mode === null || operatorId === null || !UUID.test(operatorId)) invalidArguments();
  for (const field of Object.keys(STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET)) {
    if (typeof selectors[field] !== "string") invalidArguments();
  }
  if (!UUID.test(selectors.orderId) || !UUID.test(selectors.vehicleId)) invalidArguments();
  if (mode === "apply") {
    if (expectedEvidenceDigest === null) {
      throw new Error(
        "STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EXPECTED_EVIDENCE_DIGEST_REQUIRED"
      );
    }
    if (!SHA256.test(expectedEvidenceDigest)) invalidArguments();
  } else if (expectedEvidenceDigest !== null) {
    invalidArguments();
  }

  assertStage1StagingInvalidTestOrderRetirementTarget(selectors);
  return { expectedEvidenceDigest, mode, operatorId, output, selectors };
}

export function assertStage1StagingInvalidTestOrderRetirementTarget(selectors) {
  for (const [field, expected] of Object.entries(
    STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET
  )) {
    if (selectors?.[field] !== expected) {
      throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH");
    }
  }
}

export function classifyStage1StagingInvalidTestOrderRetirement(snapshot = {}) {
  if (isTerminalTuple(snapshot)) {
    const replay = inspectRetirementAudits(snapshot);
    const blockers = [...inspectStableIdentityAndForbiddenFacts(snapshot), ...replay.blockers];
    return classificationResult({
      blockers,
      candidate: null,
      disposition: blockers.length === 0 ? "UNCHANGED" : "BLOCKED",
      evidenceDigest: replay.evidenceDigest ?? digestEvidence(snapshot),
      snapshot
    });
  }

  const blockers = inspectCandidateSnapshot(snapshot);
  if (!isInitialTuple(snapshot) && touchesTerminalTuple(snapshot)) {
    blockers.push({ code: "PARTIAL_RETIREMENT_STATE" });
  }
  const disposition = blockers.length === 0 ? "CANDIDATE" : "BLOCKED";
  return classificationResult({
    blockers,
    candidate: disposition === "CANDIDATE" ? retirementCandidate(snapshot) : null,
    disposition,
    evidenceDigest: digestEvidence(snapshot),
    snapshot
  });
}

function inspectCandidateSnapshot(snapshot) {
  const blockers = inspectStableIdentityAndForbiddenFacts(snapshot);
  const { billingSchedule, lease, order, vehicle } = snapshot;
  if (array(snapshot.auditLogs).length > 0) {
    blockers.push({ code: "RETIREMENT_AUDIT_UNEXPECTED" });
  }
  if (order?.deletedAt != null) blockers.push({ code: "ORDER_DELETED" });
  if (order?.orderStatus !== "ACTIVE") blockers.push({ code: "ORDER_STATUS_INVALID" });
  if (lease?.deletedAt != null) blockers.push({ code: "LEASE_DELETED" });
  if (lease?.status !== "ACTIVE") blockers.push({ code: "LEASE_STATUS_INVALID" });
  if (billingSchedule?.status !== "PAUSED") {
    blockers.push({ code: "BILLING_SCHEDULE_STATUS_INVALID" });
  }
  if (billingSchedule?.cancelledAt != null) {
    blockers.push({ code: "BILLING_SCHEDULE_ALREADY_CANCELLED" });
  }
  if (vehicle?.deletedAt != null) blockers.push({ code: "VEHICLE_DELETED" });
  if (vehicle?.status !== "LEASED") blockers.push({ code: "VEHICLE_STATUS_INVALID" });
  return blockers;
}

function inspectStableIdentityAndForbiddenFacts(snapshot) {
  const blockers = [];
  const { billingSchedule, lease, operator, order, vehicle } = snapshot;
  if (!order) blockers.push({ code: "ORDER_MISSING" });
  if (!lease) blockers.push({ code: "LEASE_MISSING" });
  if (!billingSchedule) blockers.push({ code: "BILLING_SCHEDULE_MISSING" });
  if (!vehicle) blockers.push({ code: "VEHICLE_MISSING" });

  const target = STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET;
  if (
    order?.id !== target.orderId ||
    order?.orderNo !== target.orderNo ||
    order?.vehicleId !== target.vehicleId ||
    vehicle?.id !== target.vehicleId ||
    vehicle?.vehicleNo !== target.vehicleNo ||
    vehicle?.vin !== target.vin
  ) {
    blockers.push({ code: "TARGET_IDENTITY_MISMATCH" });
  }
  if (lease?.orderId != null && lease.orderId !== target.orderId) {
    blockers.push({ code: "LEASE_IDENTITY_MISMATCH" });
  }
  if (billingSchedule?.orderId != null && billingSchedule.orderId !== target.orderId) {
    blockers.push({ code: "BILLING_SCHEDULE_IDENTITY_MISMATCH" });
  }
  if (!isActiveAdmin(operator)) blockers.push({ code: "OPERATOR_NOT_ACTIVE_ADMIN" });

  for (const relation of BLOCKING_COUNT_FIELDS) {
    const count = snapshot.blockingCounts?.[relation];
    if (!Number.isInteger(count) || count < 0) {
      blockers.push({ code: "RELATED_RECORD_COUNT_INVALID", relation });
    } else if (count > 0) {
      blockers.push({ code: "RELATED_RECORDS_PRESENT", count, relation });
    }
  }
  if (array(snapshot.vehicleDeliveries).length > 0) {
    blockers.push({ code: "VEHICLE_DELIVERY_PRESENT" });
  }
  if (order?.actualReturnAt != null) blockers.push({ code: "ORDER_ACTUAL_RETURN_PRESENT" });
  if (array(vehicle?.activeOtherOrders).length > 0) {
    blockers.push({ code: "VEHICLE_OTHER_ACTIVE_ORDER" });
  }
  if (array(vehicle?.activeOtherLeases).length > 0) {
    blockers.push({ code: "VEHICLE_OTHER_ACTIVE_LEASE" });
  }
  if (array(vehicle?.activeRestrictions).length > 0) {
    blockers.push({ code: "VEHICLE_ACTIVE_RESTRICTION" });
  }
  if (vehicle?.salePriceStatus !== "EFFECTIVE") {
    blockers.push({ code: "VEHICLE_SALE_PRICE_NOT_EFFECTIVE" });
  }
  if (!positiveAmount(vehicle?.currentSalePriceAmount)) {
    blockers.push({ code: "VEHICLE_SALE_PRICE_NOT_POSITIVE" });
  }
  if (billingSchedule?.lastGeneratedBillId != null) {
    blockers.push({ code: "BILLING_SCHEDULE_LAST_BILL_PRESENT" });
  }
  for (const task of array(snapshot.evidenceReferences?.eSignTasks)) {
    if (!TERMINAL_ESIGN_TASK_STATUSES.has(task?.taskStatus)) {
      blockers.push({ code: "NONTERMINAL_ESIGN_TASK", entityId: task?.id ?? null });
    }
  }
  for (const job of array(snapshot.evidenceReferences?.handoverWorkflowJobs)) {
    if (!TERMINAL_HANDOVER_JOB_STATUSES.has(job?.jobStatus)) {
      blockers.push({
        code: "NONTERMINAL_HANDOVER_WORKFLOW_JOB",
        entityId: job?.id ?? null
      });
    }
  }
  return blockers;
}

function inspectRetirementAudits(snapshot) {
  const auditLogs = array(snapshot.auditLogs);
  const blockers = [];
  if (auditLogs.length !== EXPECTED_AUDITS.length) {
    blockers.push({ code: "RETIREMENT_AUDIT_MISMATCH" });
    return { blockers, evidenceDigest: sharedAuditDigest(auditLogs) };
  }

  const expectedByType = new Map(EXPECTED_AUDITS.map((row) => [row[0], row]));
  const correlationIds = new Set();
  const evidenceDigests = new Set();
  for (const audit of auditLogs) {
    const expected = expectedByType.get(audit?.entityType);
    const entity = expected ? snapshot[expected[1]] : null;
    const before = audit?.beforeSnapshot;
    const after = audit?.afterSnapshot;
    if (
      !expected ||
      !entity ||
      audit.action !== "UPDATE" ||
      audit.module !== RETIREMENT_MODULE ||
      audit.operatorId !== snapshot.operator?.id ||
      audit.entityId !== entity.id ||
      before?.entityId !== entity.id ||
      after?.entityId !== entity.id ||
      before?.status !== expected[2] ||
      after?.status !== expected[3] ||
      before?.reasonCode !== RETIREMENT_REASON ||
      after?.reasonCode !== RETIREMENT_REASON ||
      before?.correlationId !== after?.correlationId ||
      before?.evidenceDigest !== after?.evidenceDigest ||
      !SHA256.test(after?.evidenceDigest ?? "")
    ) {
      blockers.push({ code: "RETIREMENT_AUDIT_MISMATCH" });
      return { blockers, evidenceDigest: sharedAuditDigest(auditLogs) };
    }
    correlationIds.add(after.correlationId);
    evidenceDigests.add(after.evidenceDigest);
  }
  if (correlationIds.size !== 1 || evidenceDigests.size !== 1) {
    blockers.push({ code: "RETIREMENT_AUDIT_MISMATCH" });
  }
  return { blockers, evidenceDigest: evidenceDigests.size === 1 ? [...evidenceDigests][0] : null };
}

function isInitialTuple(snapshot) {
  return (
    snapshot.order?.orderStatus === "ACTIVE" &&
    snapshot.lease?.status === "ACTIVE" &&
    snapshot.billingSchedule?.status === "PAUSED" &&
    snapshot.billingSchedule?.cancelledAt == null &&
    snapshot.vehicle?.status === "LEASED"
  );
}

function isTerminalTuple(snapshot) {
  return (
    snapshot.order?.orderStatus === "CANCELLED" &&
    snapshot.lease?.status === "COMPLETED" &&
    snapshot.billingSchedule?.status === "CANCELLED" &&
    snapshot.billingSchedule?.cancelledAt != null &&
    snapshot.billingSchedule?.pauseReason === RETIREMENT_REASON &&
    snapshot.vehicle?.status === "AVAILABLE"
  );
}

function touchesTerminalTuple(snapshot) {
  return (
    snapshot.order?.orderStatus === "CANCELLED" ||
    snapshot.lease?.status === "COMPLETED" ||
    snapshot.billingSchedule?.status === "CANCELLED" ||
    snapshot.vehicle?.status === "AVAILABLE"
  );
}

function retirementCandidate(snapshot) {
  return {
    billingScheduleId: snapshot.billingSchedule.id,
    leaseId: snapshot.lease.id,
    orderId: snapshot.order.id,
    transitions: {
      billingSchedule: ["PAUSED", "CANCELLED"],
      lease: ["ACTIVE", "COMPLETED"],
      order: ["ACTIVE", "CANCELLED"],
      vehicle: ["LEASED", "AVAILABLE"]
    },
    vehicleId: snapshot.vehicle.id
  };
}

function classificationResult({ blockers, candidate, disposition, evidenceDigest, snapshot }) {
  return {
    blockers: [...blockers].sort(compareBlockers),
    candidate,
    disposition,
    evidenceDigest,
    summary: { blockers: blockers.length, inspectedOrders: snapshot.order ? 1 : 0 }
  };
}

function digestEvidence(snapshot) {
  const evidence = {
    billingSchedule: safeEntity(snapshot.billingSchedule, [
      "cancelledAt",
      "id",
      "lastGeneratedBillId",
      "orderId",
      "pauseReason",
      "status",
      "version"
    ]),
    blockingCounts: safeEntity(snapshot.blockingCounts, BLOCKING_COUNT_FIELDS),
    evidenceReferences: {
      contracts: safeRecords(snapshot.evidenceReferences?.contracts, [
        "contractVersionId",
        "deletedAt",
        "fileId",
        "id",
        "orderId",
        "status"
      ]),
      eSignTasks: safeRecords(snapshot.evidenceReferences?.eSignTasks, [
        "contractId",
        "deletedAt",
        "id",
        "orderId",
        "sourceId",
        "sourceType",
        "taskStatus"
      ]),
      evidenceFiles: safeRecords(snapshot.evidenceReferences?.evidenceFiles, [
        "evidenceItemId",
        "fileId",
        "id",
        "lifecycleStatus",
        "replacedById"
      ]),
      evidenceItems: safeRecords(snapshot.evidenceReferences?.evidenceItems, [
        "handoverId",
        "id",
        "orderId",
        "reviewStatus",
        "status",
        "vehicleDeliveryId"
      ]),
      fileObjects: safeRecords(snapshot.evidenceReferences?.fileObjects, [
        "contentSha256",
        "createdAt",
        "id",
        "sizeBytes"
      ]),
      handovers: safeRecords(snapshot.evidenceReferences?.handovers, [
        "archiveStatus",
        "deletedAt",
        "handoverContractId",
        "handoverESignTaskId",
        "id",
        "orderId",
        "signedDocumentFileId",
        "sourceDocumentFileId",
        "stage1ContractId",
        "status"
      ]),
      handoverWorkOrders: safeRecords(snapshot.evidenceReferences?.handoverWorkOrders, [
        "handoverId",
        "id",
        "orderId",
        "status"
      ]),
      handoverWorkflowJobs: safeRecords(snapshot.evidenceReferences?.handoverWorkflowJobs, [
        "eSignTaskId",
        "handoverId",
        "id",
        "jobStatus",
        "workOrderId"
      ])
    },
    lease: safeEntity(snapshot.lease, ["activatedAt", "deletedAt", "id", "orderId", "status"]),
    operator: {
      ...safeEntity(snapshot.operator, ["deletedAt", "id", "status"]),
      roles: safeRecords(snapshot.operator?.roles, [
        "code",
        "deletedAt",
        "roleDeletedAt",
        "roleStatus"
      ])
    },
    order: safeEntity(snapshot.order, [
      "actualDeliveryAt",
      "actualReturnAt",
      "contractId",
      "deletedAt",
      "endDate",
      "id",
      "orderNo",
      "orderStatus",
      "startDate",
      "vehicleId"
    ]),
    vehicle: {
      ...safeEntity(snapshot.vehicle, [
        "currentSalePriceAmount",
        "deletedAt",
        "id",
        "salePriceStatus",
        "status",
        "vehicleNo",
        "vin"
      ]),
      activeOtherLeases: safeRecords(snapshot.vehicle?.activeOtherLeases, ["id", "orderId"]),
      activeOtherOrders: safeRecords(snapshot.vehicle?.activeOtherOrders, [
        "id",
        "orderNo",
        "orderStatus"
      ]),
      activeRestrictions: safeRecords(snapshot.vehicle?.activeRestrictions, [
        "id",
        "restrictionType",
        "severity",
        "status"
      ])
    },
    vehicleDeliveries: safeRecords(snapshot.vehicleDeliveries, [
      "deliveredAt",
      "deliveryStatus",
      "id"
    ])
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(evidence)))
    .digest("hex");
}

function safeEntity(record, fields) {
  if (!record || typeof record !== "object") return null;
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

function safeRecords(records, fields) {
  return array(records)
    .map((record) => safeEntity(record, fields))
    .sort((left, right) => compare(left?.id ?? stableJson(left), right?.id ?? stableJson(right)));
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function isActiveAdmin(operator) {
  return Boolean(
    operator &&
    operator.deletedAt == null &&
    operator.status === "ACTIVE" &&
    array(operator.roles).some(
      (role) =>
        role?.code === "ADMIN" &&
        role.deletedAt == null &&
        role.roleDeletedAt == null &&
        role.roleStatus === "ACTIVE"
    )
  );
}

function positiveAmount(value) {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function sharedAuditDigest(audits) {
  const values = new Set(
    array(audits)
      .flatMap((audit) => [
        audit?.beforeSnapshot?.evidenceDigest,
        audit?.afterSnapshot?.evidenceDigest
      ])
      .filter((value) => SHA256.test(value ?? ""))
  );
  return values.size === 1 ? [...values][0] : null;
}

function compareBlockers(left, right) {
  return (
    compare(left.code ?? "", right.code ?? "") ||
    compare(left.relation ?? "", right.relation ?? "") ||
    compare(left.entityId ?? "", right.entityId ?? "")
  );
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function optionValue(args, index) {
  const value = args[index];
  if (typeof value !== "string" || value.startsWith("--")) invalidArguments();
  return nonempty(value);
}

function nonempty(value) {
  if (value.trim().length === 0) invalidArguments();
  return value;
}

function useOnce(seen, key) {
  if (seen.has(key)) invalidArguments();
  seen.add(key);
}

function invalidArguments() {
  throw new Error("STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_ARGUMENTS_INVALID");
}
