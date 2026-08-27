import { createHash } from "node:crypto";

const REPAIRABLE_ORDER_STATUSES = new Set(["ACTIVE", "PENDING_RETURN"]);
const CREDIBLE_LEASE_STATUSES = new Set(["ACTIVE", "RETURN_DUE", "COMPLETED"]);
const CONTRACT_STATUSES = new Set(["SIGNED", "ARCHIVED"]);
const ACTIONS = ["ARCHIVE_CONTRACT", "BIND_CONTRACT", "SET_ORDER_DATES"];
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function parseStage1ActiveSourceFactsRepairArgs(args) {
  let mode = null;
  let output = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode !== null) invalidArguments();
      mode = argument === "--apply" ? "apply" : "dry-run";
      continue;
    }
    if (argument === "--output") {
      const value = args[index + 1];
      if (output !== null || !validOutput(value)) invalidArguments();
      output = value;
      index += 1;
      continue;
    }
    if (typeof argument === "string" && argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (output !== null || !validOutput(value)) invalidArguments();
      output = value;
      continue;
    }
    invalidArguments();
  }

  if (mode === null) invalidArguments();
  return { mode, output };
}

export function classifyStage1ActiveSourceFactsRepair(snapshot = {}) {
  const candidates = [];
  const exceptions = [];
  const unchanged = [];
  const orders = array(snapshot.orders)
    .filter(
      (order) =>
        order && order.deletedAt == null && REPAIRABLE_ORDER_STATUSES.has(order.orderStatus)
    )
    .sort(compareId);

  for (const order of orders) {
    const context = {
      orderId: order.id,
      orderNo: order.orderNo ?? null
    };
    const activation = resolveActivationEvidence(order);
    if (activation.code) {
      exceptions.push({ code: activation.code, ...context });
      continue;
    }

    const dates = resolveOrderDates(order, activation.activatedAt);
    if (dates.code) {
      exceptions.push({ code: dates.code, ...context });
      continue;
    }

    const contractAuthority = resolveContractAuthority(order);
    if (contractAuthority.code) {
      exceptions.push({ code: contractAuthority.code, ...context });
      continue;
    }

    const contract = contractAuthority.contract;
    const task = contractAuthority.task;
    const actions = [];
    if (contract.status === "SIGNED") actions.push("ARCHIVE_CONTRACT");
    if (order.contractId == null) actions.push("BIND_CONTRACT");
    if (dates.needsRepair) actions.push("SET_ORDER_DATES");
    actions.sort(compareAction);

    const evidenceDigest = digestEvidence({
      activation,
      contract,
      order,
      task
    });
    if (actions.length === 0) {
      unchanged.push({
        contractId: contract.id,
        evidenceDigest,
        ...context
      });
      continue;
    }
    if (array(order.contractSegments).length > 0 || array(order.subscriptionPeriods).length > 0) {
      exceptions.push({ code: "DOWNSTREAM_FACTS_ALREADY_PRESENT", ...context });
      continue;
    }

    candidates.push({
      actions,
      actualDeliveryAt: activation.activatedAt,
      archivedAt: task.completedAt,
      contractId: contract.id,
      contractNo: contract.contractNo ?? null,
      eSignTaskId: task.id,
      endDate: dates.endDate,
      evidenceDigest,
      fileId: contract.file.id,
      ...context,
      startDate: dates.startDate
    });
  }

  candidates.sort(compareId);
  exceptions.sort(compareException);
  unchanged.sort(compareId);
  return {
    candidates,
    exceptions,
    unchanged,
    summary: {
      actions: Object.fromEntries(
        ACTIONS.map((action) => [
          action,
          candidates.filter((candidate) => candidate.actions.includes(action)).length
        ])
      ),
      candidates: candidates.length,
      exceptions: exceptions.length,
      inspectedOrders: orders.length,
      unchanged: unchanged.length
    }
  };
}

function resolveActivationEvidence(order) {
  const deliveries = array(order.deliveries).filter(
    (delivery) => delivery && delivery.deletedAt == null && delivery.deliveryStatus === "DELIVERED"
  );
  const leases = array(order.leases ?? (order.lease ? [order.lease] : [])).filter(
    (lease) => lease && lease.deletedAt == null && CREDIBLE_LEASE_STATUSES.has(lease.status)
  );
  if (deliveries.length > 1 || leases.length > 1) {
    return { code: "ACTIVATION_EVIDENCE_AMBIGUOUS" };
  }
  if (deliveries.length !== 1 || leases.length !== 1) {
    return { code: "ACTIVATION_EVIDENCE_MISSING" };
  }

  const delivery = deliveries[0];
  const lease = leases[0];
  if (
    delivery.orderId !== order.id ||
    delivery.vehicleId !== order.vehicleId ||
    delivery.customerId !== order.customerId ||
    lease.orderId !== order.id
  ) {
    return { code: "ACTIVATION_IDENTITY_MISMATCH" };
  }

  const actualDeliveryAt = timestamp(order.actualDeliveryAt);
  const deliveredAt = timestamp(delivery.deliveredAt);
  const activatedAt = timestamp(lease.activatedAt);
  if (!actualDeliveryAt || !deliveredAt || !activatedAt) {
    return { code: "ACTIVATION_EVIDENCE_MISSING" };
  }
  if (new Set([actualDeliveryAt, deliveredAt, activatedAt]).size !== 1) {
    return { code: "ACTIVATION_TIMESTAMP_CONFLICT" };
  }
  return { activatedAt, delivery, lease };
}

function resolveOrderDates(order, activatedAt) {
  if (!Number.isSafeInteger(order.periodMonths) || order.periodMonths <= 0) {
    return { code: "ACTIVATION_EVIDENCE_MISSING" };
  }
  const { endDate, startDate } = deriveOriginalSubscriptionPeriod(activatedAt, order.periodMonths);
  const hasStart = order.startDate != null;
  const hasEnd = order.endDate != null;
  if (hasStart !== hasEnd) return { code: "ORDER_DATE_PARTIAL" };
  if (!hasStart) return { endDate, needsRepair: true, startDate };

  if (calendarDate(order.startDate) !== startDate || calendarDate(order.endDate) !== endDate) {
    return { code: "ORDER_DATE_CONFLICT" };
  }
  return { endDate, needsRepair: false, startDate };
}

function resolveContractAuthority(order) {
  const contracts = array(order.contracts).filter(
    (contract) =>
      contract &&
      contract.deletedAt == null &&
      contract.orderId === order.id &&
      contract.customerId === order.customerId &&
      contract.businessType === "SUBSCRIPTION" &&
      CONTRACT_STATUSES.has(contract.status)
  );
  let selected;
  if (order.contractId != null) {
    const referenced = contracts.filter((contract) => contract.id === order.contractId);
    if (referenced.length === 0) return { code: "CONTRACT_AUTHORITY_MISSING" };
    if (referenced.length > 1) return { code: "CONTRACT_AUTHORITY_AMBIGUOUS" };
    selected = referenced[0];
  } else {
    if (contracts.length === 0) return { code: "CONTRACT_AUTHORITY_MISSING" };
    const proofs = contracts.map((contract) => ({
      contract,
      proof: validateSignedArtifact(contract, order)
    }));
    const viable = proofs.filter(({ proof }) => !proof.code);
    if (viable.length > 1) return { code: "CONTRACT_AUTHORITY_AMBIGUOUS" };
    if (viable.length === 0) {
      return { code: highestPriorityProofError(proofs.map(({ proof }) => proof.code)) };
    }
    return { contract: viable[0].contract, task: viable[0].proof.task };
  }

  const proof = validateSignedArtifact(selected, order);
  return proof.code ? proof : { contract: selected, task: proof.task };
}

function validateSignedArtifact(contract, order) {
  if (!isJsonObject(contract.contractSnapshot) || !timestamp(contract.signedAt)) {
    return { code: "SIGNED_ARTIFACT_INCOMPLETE" };
  }
  const tasks = array(contract.eSignTasks).filter(
    (task) =>
      task &&
      task.deletedAt == null &&
      task.contractId === contract.id &&
      task.orderId === order.id &&
      task.signingStage === "STAGE1_SUBSCRIPTION_CONTRACT" &&
      task.documentType === "SUBSCRIPTION_CONTRACT" &&
      task.taskStatus === "COMPLETED"
  );
  if (tasks.length > 1) return { code: "CONTRACT_AUTHORITY_AMBIGUOUS" };
  if (tasks.length !== 1) return { code: "SIGNED_ARTIFACT_INCOMPLETE" };
  const task = tasks[0];
  if (task.customerId !== order.customerId) {
    return { code: "SIGNED_ARTIFACT_MISMATCH" };
  }
  const completedAt = timestamp(task.completedAt);
  if (!completedAt || !nonEmptyString(task.signedDocumentObjectKey)) {
    return { code: "SIGNED_ARTIFACT_INCOMPLETE" };
  }
  const file = contract.file;
  if (
    !file ||
    contract.fileId !== file.id ||
    file.mimeType !== "application/pdf" ||
    typeof file.sizeBytes !== "bigint" ||
    file.sizeBytes <= 0n ||
    !nonEmptyString(file.objectKey)
  ) {
    return { code: "SIGNED_ARTIFACT_INCOMPLETE" };
  }
  if (file.objectKey !== task.signedDocumentObjectKey) {
    return { code: "SIGNED_ARTIFACT_MISMATCH" };
  }

  const signedAt = timestamp(contract.signedAt);
  const archivedAt = timestamp(contract.archivedAt);
  if (
    Date.parse(signedAt) > Date.parse(completedAt) ||
    (contract.status === "ARCHIVED" &&
      (!archivedAt || Date.parse(completedAt) > Date.parse(archivedAt)))
  ) {
    return { code: "CONTRACT_TIMELINE_INVALID" };
  }
  return { task: { ...task, completedAt } };
}

function deriveOriginalSubscriptionPeriod(activatedAt, periodMonths) {
  const instant = new Date(activatedAt);
  const shifted = new Date(instant.getTime() + SHANGHAI_OFFSET_MS);
  const start = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  );
  const targetFirst = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + periodMonths, 1)
  );
  const targetLastDay = new Date(
    Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const exclusiveEnd = new Date(
    Date.UTC(
      targetFirst.getUTCFullYear(),
      targetFirst.getUTCMonth(),
      Math.min(start.getUTCDate(), targetLastDay)
    )
  );
  const end = new Date(exclusiveEnd.getTime() - 86_400_000);
  return {
    endDate: end.toISOString().slice(0, 10),
    startDate: start.toISOString().slice(0, 10)
  };
}

function digestEvidence({ activation, contract, order, task }) {
  const evidence = {
    activation: {
      activatedAt: activation.activatedAt,
      deliveryId: activation.delivery.id,
      leaseId: activation.lease.id
    },
    contract: {
      archivedAt: timestamp(contract.archivedAt),
      fileId: contract.file.id,
      fileObjectKey: contract.file.objectKey,
      id: contract.id,
      signedAt: timestamp(contract.signedAt),
      signedDocumentObjectKey: task.signedDocumentObjectKey,
      status: contract.status,
      taskCompletedAt: task.completedAt,
      taskId: task.id
    },
    order: {
      customerId: order.customerId,
      id: order.id,
      vehicleId: order.vehicleId
    }
  };
  return createHash("sha256").update(stableJson(evidence), "utf8").digest("hex");
}

function highestPriorityProofError(codes) {
  return (
    [
      "CONTRACT_AUTHORITY_AMBIGUOUS",
      "SIGNED_ARTIFACT_MISMATCH",
      "CONTRACT_TIMELINE_INVALID",
      "SIGNED_ARTIFACT_INCOMPLETE"
    ].find((code) => codes.includes(code)) ?? "CONTRACT_AUTHORITY_MISSING"
  );
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
  return value;
}

function timestamp(value) {
  if (value == null) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function calendarDate(value) {
  return timestamp(value)?.slice(0, 10) ?? null;
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validOutput(value) {
  return nonEmptyString(value) && !value.startsWith("--");
}

function compareAction(left, right) {
  return ACTIONS.indexOf(left) - ACTIONS.indexOf(right);
}

function compareId(left, right) {
  return String(left?.orderId ?? left?.id ?? "").localeCompare(
    String(right?.orderId ?? right?.id ?? "")
  );
}

function compareException(left, right) {
  return `${left.orderId}|${left.code}`.localeCompare(`${right.orderId}|${right.code}`);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function invalidArguments() {
  throw new Error("STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_ARGUMENTS_INVALID");
}
