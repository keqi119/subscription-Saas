const CURRENT_ORDER_STATUSES = new Set(["ACTIVE", "PENDING_RETURN"]);
const CREDIBLE_LEASE_STATUSES = new Set(["ACTIVE", "RETURN_DUE", "COMPLETED"]);
const START_SOURCE_TYPE = "SUBSCRIPTION_ORDER";

export function parseStage1cPeriodBackfillArgs(args) {
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
      if (output !== null || !value || value.startsWith("--")) invalidArguments();
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (output !== null || value.length === 0) invalidArguments();
      output = value;
      continue;
    }
    invalidArguments();
  }

  if (mode === null) invalidArguments();
  return { mode, output };
}

export function classifyStage1cPeriodBackfill(snapshot = {}) {
  const orders = array(snapshot.orders);
  const vehicles = array(snapshot.vehicles);
  const existingSubscriptionPeriods = array(snapshot.existingSubscriptionPeriods);
  const existingOwnershipPeriods = array(snapshot.existingOwnershipPeriods);
  const vehicleById = new Map(
    vehicles.filter((vehicle) => vehicle?.id).map((vehicle) => [vehicle.id, vehicle])
  );
  const ambiguities = [];
  const segmentOmissions = [];
  const provisional = [];

  for (const order of [...orders].sort(compareId)) {
    if (!order || order.deletedAt || !shouldClassify(order)) continue;
    const sourceKey = stableSourceKey(order.id);
    const context = { orderId: order.id, orderNo: order.orderNo ?? null, sourceKey };
    const vehicle = vehicleById.get(order.vehicleId);
    if (!vehicle || vehicle.deletedAt) {
      ambiguities.push(ambiguity(context, "MISSING_VEHICLE"));
      continue;
    }
    if (
      !order.customer ||
      order.customer.deletedAt ||
      !order.customerId ||
      order.customer.id !== order.customerId
    ) {
      ambiguities.push(ambiguity(context, "MISSING_CUSTOMER"));
      continue;
    }

    const activation = readActivation(order);
    if (activation.code) {
      ambiguities.push(ambiguity(context, activation.code, activation.details));
      continue;
    }
    const completion = readCompletion(order);
    if (completion.code) {
      ambiguities.push(ambiguity(context, completion.code, completion.details));
      continue;
    }
    if (completion.endedAt && activation.startedAt >= completion.endedAt) {
      ambiguities.push(ambiguity(context, "INVALID_PERIOD_RANGE"));
      continue;
    }

    const segment = resolveContractSegment(order.contractSegments, activation.startedAt);
    if (segment.coveringSegmentIds.length !== 1) {
      segmentOmissions.push({
        code: "CONTRACT_SEGMENT_UNRESOLVED",
        coveringSegmentIds: segment.coveringSegmentIds,
        ...context
      });
    }

    const payload = buildPayload({
      activation,
      completion,
      contractSegmentId: segment.contractSegmentId,
      order,
      sourceKey
    });
    provisional.push({
      disposition: "CREATE",
      orderId: order.id,
      orderNo: order.orderNo ?? null,
      payload,
      sourceKey
    });
  }

  const existingBySourceKey = new Map();
  for (const period of [...existingSubscriptionPeriods].sort(compareSourceKey)) {
    if (!existingBySourceKey.has(period?.startSourceKey)) {
      existingBySourceKey.set(period?.startSourceKey, period);
    }
  }

  const resolved = [];
  const pendingCreates = [];
  for (const result of provisional) {
    const existing = existingBySourceKey.get(result.sourceKey);
    if (!existing) {
      pendingCreates.push(result);
      continue;
    }
    const differingFields = payloadDifferences(result.payload, existing);
    resolved.push({
      ...(differingFields.length > 0 ? { differingFields } : {}),
      disposition: differingFields.length > 0 ? "CONFLICT" : "UNCHANGED",
      existingPeriodId: existing.id ?? null,
      orderId: result.orderId,
      orderNo: result.orderNo,
      payload: result.payload,
      sourceKey: result.sourceKey
    });
  }

  const { overlaps, skippedSourceKeys } = findOverlaps(pendingCreates, existingSubscriptionPeriods);
  for (const result of pendingCreates) {
    if (!skippedSourceKeys.has(result.sourceKey)) resolved.push(result);
  }
  resolved.sort(compareSourceKey);
  ambiguities.sort(compareReportRow);
  segmentOmissions.sort(compareReportRow);
  overlaps.sort(compareOverlap);

  const ownershipUnknown = findOwnershipUnknown(vehicles, existingOwnershipPeriods);
  const openPeriods = existingSubscriptionPeriods
    .filter((period) => period?.endedAt == null)
    .map((period) => ({
      key: period.id ?? period.startSourceKey ?? "",
      orderId: period.orderId
    }));
  for (const result of resolved) {
    if (result.disposition === "CREATE" && result.payload.endedAt === null) {
      openPeriods.push({ key: result.sourceKey, orderId: result.orderId });
    }
  }
  const multipleCurrent = multipleCurrentOrderViolations(openPeriods);
  const createResults = resolved.filter((result) => result.disposition === "CREATE");
  const invariantViolations = [...overlaps, ...multipleCurrent].sort(compareViolation);

  return {
    ambiguities,
    counters: {
      activeOrders: orders.filter((order) => !order?.deletedAt && order?.orderStatus === "ACTIVE")
        .length,
      closedPeriods:
        existingSubscriptionPeriods.filter((period) => period?.endedAt != null).length +
        createResults.filter((result) => result.payload.endedAt !== null).length,
      existingOpenPeriods: existingSubscriptionPeriods.filter((period) => period?.endedAt == null)
        .length,
      leasedVehicles: vehicles.filter(
        (vehicle) => !vehicle?.deletedAt && vehicle?.status === "LEASED"
      ).length,
      oneOrderMultipleCurrentAnomalies: multipleCurrent.length,
      overlaps: overlaps.length,
      ownershipUnknownVehicles: ownershipUnknown.length,
      proposedOpenPeriods: createResults.filter((result) => result.payload.endedAt === null).length
    },
    invariantViolations,
    overlaps,
    ownership: {
      proposedPeriods: [],
      unknownVehicles: ownershipUnknown
    },
    segmentOmissions,
    sourceCounts: {
      assetOwners: array(snapshot.assetOwners).length,
      existingOwnershipPeriods: existingOwnershipPeriods.length,
      existingSubscriptionPeriods: existingSubscriptionPeriods.length,
      orders: orders.length,
      vehicles: vehicles.length
    },
    subscriptionPeriods: resolved
  };
}

function readActivation(order) {
  const lease =
    order.lease &&
    !order.lease.deletedAt &&
    CREDIBLE_LEASE_STATUSES.has(order.lease.status) &&
    timestamp(order.lease.activatedAt)
      ? order.lease
      : null;
  const deliveries = array(order.deliveries).filter(
    (delivery) =>
      delivery &&
      !delivery.deletedAt &&
      delivery.deliveryStatus === "DELIVERED" &&
      timestamp(delivery.deliveredAt)
  );
  const inconsistentDelivery = deliveries.find(
    (delivery) =>
      delivery.orderId !== order.id ||
      delivery.vehicleId !== order.vehicleId ||
      delivery.customerId !== order.customerId
  );
  if (inconsistentDelivery) {
    return { code: "ACTIVATION_EVIDENCE_IDENTITY_MISMATCH" };
  }
  const deliveryTimes = uniqueTimestamps(deliveries.map((delivery) => delivery.deliveredAt));
  if (deliveryTimes.length > 1) {
    return { code: "CONFLICTING_START_TIMESTAMPS", details: deliveryTimes };
  }
  const leaseTime = lease ? timestamp(lease.activatedAt) : null;
  const deliveryTime = deliveryTimes[0] ?? null;
  if (leaseTime && deliveryTime && leaseTime !== deliveryTime) {
    return {
      code: "CONFLICTING_START_TIMESTAMPS",
      details: [leaseTime, deliveryTime].sort()
    };
  }
  const startedAt = leaseTime ?? deliveryTime;
  if (!startedAt) return { code: "MISSING_ACTIVATION_EVIDENCE" };
  const delivery = deliveries.sort(compareId)[0] ?? null;
  return { delivery, lease, startedAt };
}

function readCompletion(order) {
  if (order.actualReturnAt != null && !timestamp(order.actualReturnAt)) {
    return { code: "INVALID_RETURN_TIMESTAMP" };
  }
  const returns = array(order.returns).filter(
    (vehicleReturn) =>
      vehicleReturn &&
      !vehicleReturn.deletedAt &&
      vehicleReturn.returnStatus === "CONFIRMED" &&
      timestamp(vehicleReturn.returnedAt)
  );
  const inconsistentReturn = returns.find(
    (vehicleReturn) =>
      vehicleReturn.orderId !== order.id ||
      vehicleReturn.vehicleId !== order.vehicleId ||
      vehicleReturn.customerId !== order.customerId
  );
  if (inconsistentReturn) return { code: "RETURN_EVIDENCE_IDENTITY_MISMATCH" };
  const returnTimes = uniqueTimestamps(returns.map((vehicleReturn) => vehicleReturn.returnedAt));
  if (returnTimes.length > 1) {
    return { code: "CONFLICTING_RETURN_TIMESTAMPS", details: returnTimes };
  }
  const orderReturnTime = timestamp(order.actualReturnAt);
  const evidenceReturnTime = returnTimes[0] ?? null;
  if (orderReturnTime && evidenceReturnTime && orderReturnTime !== evidenceReturnTime) {
    return {
      code: "CONFLICTING_RETURN_TIMESTAMPS",
      details: [orderReturnTime, evidenceReturnTime].sort()
    };
  }
  return {
    endedAt: orderReturnTime ?? evidenceReturnTime,
    returnEvidence: returns.sort(compareId)[0] ?? null
  };
}

function buildPayload({ activation, completion, contractSegmentId, order, sourceKey }) {
  const endedAt = completion.endedAt ?? null;
  return {
    contractId: order.contractId ?? null,
    contractSegmentId,
    customerId: order.customerId,
    endedAt,
    endReason: endedAt ? "BACKFILL" : null,
    endSnapshot: endedAt
      ? {
          orderActualReturnAt: timestamp(order.actualReturnAt),
          returnEvidence: completion.returnEvidence
            ? {
                id: completion.returnEvidence.id,
                returnedAt: timestamp(completion.returnEvidence.returnedAt),
                status: completion.returnEvidence.returnStatus
              }
            : null
        }
      : null,
    endSourceId: endedAt ? order.id : null,
    endSourceKey: endedAt ? `${sourceKey}:end` : null,
    endSourceType: endedAt ? START_SOURCE_TYPE : null,
    orderId: order.id,
    startedAt: activation.startedAt,
    startReason: "BACKFILL",
    startSnapshot: {
      activationEvidence: {
        delivery: activation.delivery
          ? {
              deliveredAt: timestamp(activation.delivery.deliveredAt),
              id: activation.delivery.id,
              status: activation.delivery.deliveryStatus
            }
          : null,
        lease: activation.lease
          ? {
              activatedAt: timestamp(activation.lease.activatedAt),
              id: activation.lease.id,
              status: activation.lease.status
            }
          : null
      },
      order: {
        contractId: order.contractId ?? null,
        customerId: order.customerId,
        id: order.id,
        orderNo: order.orderNo ?? null,
        orderStatus: order.orderStatus,
        vehicleId: order.vehicleId
      }
    },
    startSourceId: order.id,
    startSourceKey: sourceKey,
    startSourceType: START_SOURCE_TYPE,
    vehicleId: order.vehicleId
  };
}

function resolveContractSegment(segments, startedAt) {
  const instant = Date.parse(startedAt);
  const covering = array(segments)
    .filter(
      (segment) =>
        segment &&
        segment.status !== "CANCELLED" &&
        timestamp(segment.startDate) &&
        timestamp(segment.endDate) &&
        Date.parse(timestamp(segment.startDate)) <= instant &&
        instant <= Date.parse(timestamp(segment.endDate))
    )
    .sort(compareId);
  return {
    contractSegmentId: covering.length === 1 ? covering[0].id : null,
    coveringSegmentIds: covering.map((segment) => segment.id)
  };
}

function findOverlaps(candidates, existingPeriods) {
  const overlaps = [];
  const skippedSourceKeys = new Set();
  const sortedCandidates = [...candidates].sort(compareSourceKey);
  const sortedExisting = [...existingPeriods].sort(compareSourceKey);

  for (let leftIndex = 0; leftIndex < sortedCandidates.length; leftIndex += 1) {
    const left = sortedCandidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < sortedCandidates.length; rightIndex += 1) {
      const right = sortedCandidates[rightIndex];
      if (
        left.payload.vehicleId === right.payload.vehicleId &&
        rangesOverlap(left.payload, right.payload)
      ) {
        overlaps.push(
          overlapRow(left.sourceKey, right.sourceKey, left.payload.vehicleId, "PROPOSED")
        );
        skippedSourceKeys.add(left.sourceKey);
        skippedSourceKeys.add(right.sourceKey);
      }
    }
    for (const existing of sortedExisting) {
      if (
        left.payload.vehicleId === existing?.vehicleId &&
        validRange(existing) &&
        rangesOverlap(left.payload, existing)
      ) {
        overlaps.push(
          overlapRow(
            left.sourceKey,
            existing.startSourceKey ?? existing.id ?? "",
            left.payload.vehicleId,
            "PERSISTED"
          )
        );
        skippedSourceKeys.add(left.sourceKey);
      }
    }
  }
  return { overlaps, skippedSourceKeys };
}

function findOwnershipUnknown(vehicles, ownershipPeriods) {
  const ownedVehicleIds = new Set(
    ownershipPeriods
      .filter((period) => period && period.endedAt == null)
      .map((period) => period.vehicleId)
  );
  return vehicles
    .filter((vehicle) => vehicle && !vehicle.deletedAt && !ownedVehicleIds.has(vehicle.id))
    .map((vehicle) => ({
      code: "OWNERSHIP_UNKNOWN",
      vehicleId: vehicle.id,
      vehicleNo: vehicle.vehicleNo ?? null
    }))
    .sort((left, right) => left.vehicleId.localeCompare(right.vehicleId));
}

function multipleCurrentOrderViolations(openPeriods) {
  const periodsByOrder = new Map();
  for (const period of openPeriods) {
    if (!period.orderId) continue;
    const keys = periodsByOrder.get(period.orderId) ?? [];
    keys.push(period.key);
    periodsByOrder.set(period.orderId, keys);
  }
  return [...periodsByOrder.entries()]
    .filter(([, keys]) => keys.length > 1)
    .map(([orderId, keys]) => ({
      code: "ONE_ORDER_MULTIPLE_CURRENT_PERIODS",
      orderId,
      periodKeys: keys.sort()
    }))
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
}

function payloadDifferences(payload, existing) {
  return Object.keys(payload)
    .filter((field) => stableJson(payload[field]) !== stableJson(existing?.[field] ?? null))
    .sort();
}

function shouldClassify(order) {
  return (
    CURRENT_ORDER_STATUSES.has(order.orderStatus) ||
    order.actualReturnAt != null ||
    array(order.returns).some(
      (vehicleReturn) =>
        vehicleReturn &&
        !vehicleReturn.deletedAt &&
        vehicleReturn.returnStatus === "CONFIRMED" &&
        vehicleReturn.returnedAt != null
    )
  );
}

function rangesOverlap(left, right) {
  const leftStart = Date.parse(timestamp(left.startedAt));
  const rightStart = Date.parse(timestamp(right.startedAt));
  const leftEnd =
    left.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(timestamp(left.endedAt));
  const rightEnd =
    right.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(timestamp(right.endedAt));
  return leftStart < rightEnd && rightStart < leftEnd;
}

function validRange(period) {
  const start = timestamp(period?.startedAt);
  const end = period?.endedAt == null ? null : timestamp(period.endedAt);
  return Boolean(start && (end === null || Date.parse(start) < Date.parse(end)));
}

function stableSourceKey(orderId) {
  return `stage1c-period-backfill:subscription-order:${orderId}`;
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function canonical(value) {
  if (value instanceof Date) return timestamp(value);
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

function uniqueTimestamps(values) {
  return [...new Set(values.map(timestamp).filter(Boolean))].sort();
}

function ambiguity(context, code, details) {
  return { code, ...(details ? { details } : {}), ...context };
}

function overlapRow(leftSourceKey, rightSourceKey, vehicleId, overlapWith) {
  return {
    code: "SUBSCRIPTION_PERIOD_OVERLAP",
    leftSourceKey,
    overlapWith,
    rightSourceKey,
    vehicleId
  };
}

function invalidArguments() {
  throw new Error("STAGE1C_PERIOD_BACKFILL_ARGUMENTS_INVALID");
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function compareId(left, right) {
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function compareSourceKey(left, right) {
  return String(left?.sourceKey ?? left?.startSourceKey ?? "").localeCompare(
    String(right?.sourceKey ?? right?.startSourceKey ?? "")
  );
}

function compareReportRow(left, right) {
  return `${left.code}|${left.orderId ?? ""}|${left.sourceKey ?? ""}`.localeCompare(
    `${right.code}|${right.orderId ?? ""}|${right.sourceKey ?? ""}`
  );
}

function compareOverlap(left, right) {
  return `${left.leftSourceKey}|${left.rightSourceKey}|${left.overlapWith}`.localeCompare(
    `${right.leftSourceKey}|${right.rightSourceKey}|${right.overlapWith}`
  );
}

function compareViolation(left, right) {
  return `${left.code}|${left.orderId ?? left.leftSourceKey ?? ""}`.localeCompare(
    `${right.code}|${right.orderId ?? right.leftSourceKey ?? ""}`
  );
}
