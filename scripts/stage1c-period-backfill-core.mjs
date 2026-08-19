const CURRENT_ORDER_STATUSES = new Set(["ACTIVE", "PENDING_RETURN"]);
const CLOSED_ORDER_STATUSES = new Set(["COMPLETED", "TERMINATED"]);
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
      if (output !== null || !value || value.trim().length === 0 || value.startsWith("--")) {
        invalidArguments();
      }
      output = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      const value = argument.slice("--output=".length);
      if (output !== null || value.trim().length === 0) invalidArguments();
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
  const contracts = array(snapshot.contracts);
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
    const contractAuthority = resolveContractAuthority(contracts, order);
    if (contractAuthority.code) {
      ambiguities.push(ambiguity(context, contractAuthority.code));
      continue;
    }
    if (!hasCompleteBaseAuthority({ contract: contractAuthority.contract, order, vehicle })) {
      ambiguities.push(ambiguity(context, "INCOMPLETE_AUTHORITY_SNAPSHOT"));
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

    const segment = resolveContractSegment(
      order.contractSegments,
      activation.startedAt,
      order,
      contractAuthority.contract
    );
    if (segment.code) {
      ambiguities.push(ambiguity(context, segment.code));
      continue;
    }
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
      contract: contractAuthority.contract,
      contractSegmentId: segment.contractSegmentId,
      contractSegment: segment.contractSegment,
      order,
      sourceKey,
      vehicle
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
  for (const period of existingSubscriptionPeriods) {
    const persisted = existingBySourceKey.get(period?.startSourceKey) ?? [];
    persisted.push(period);
    existingBySourceKey.set(period?.startSourceKey, persisted);
  }

  const resolved = [];
  const pendingCreates = [];
  const persistedSourceViolations = [];
  for (const result of provisional) {
    const persisted = [...(existingBySourceKey.get(result.sourceKey) ?? [])].sort(
      comparePersistedPeriod
    );
    if (persisted.length === 0) {
      pendingCreates.push(result);
      continue;
    }
    const matchingIdentity = persisted.filter(
      (period) =>
        period.startSourceType === result.payload.startSourceType &&
        period.startSourceId === result.payload.startSourceId &&
        period.startSourceKey === result.payload.startSourceKey
    );
    if (persisted.length !== 1 || matchingIdentity.length !== 1) {
      const existingPeriodIds = persisted.map((period) => period.id ?? null).sort();
      const differingFields = [
        ...new Set(persisted.flatMap((period) => payloadDifferences(result.payload, period)))
      ].sort();
      resolved.push({
        conflictCode:
          persisted.length > 1
            ? "MULTIPLE_PERSISTED_SOURCE_ROWS"
            : "PERSISTED_SOURCE_IDENTITY_CONFLICT",
        ...(differingFields.length > 0 ? { differingFields } : {}),
        disposition: "CONFLICT",
        ...(persisted.length === 1 ? { existingPeriodId: existingPeriodIds[0] } : {}),
        existingPeriodIds,
        orderId: result.orderId,
        orderNo: result.orderNo,
        payload: result.payload,
        sourceKey: result.sourceKey
      });
      persistedSourceViolations.push({
        code: "PERSISTED_SOURCE_IDENTITY_CONFLICT",
        existingPeriodIds,
        sourceKey: result.sourceKey
      });
      continue;
    }
    const existing = matchingIdentity[0];
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
  const invariantViolations = [...overlaps, ...multipleCurrent, ...persistedSourceViolations].sort(
    compareViolation
  );

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
      contracts: contracts.length,
      existingOwnershipPeriods: existingOwnershipPeriods.length,
      existingSubscriptionPeriods: existingSubscriptionPeriods.length,
      orders: orders.length,
      vehicles: vehicles.length
    },
    subscriptionPeriods: resolved
  };
}

function readActivation(order) {
  const presentLease = order.lease && !order.lease.deletedAt ? order.lease : null;
  if (presentLease && presentLease.orderId !== order.id) {
    return { code: "ACTIVATION_EVIDENCE_IDENTITY_MISMATCH" };
  }
  const lease =
    presentLease && CREDIBLE_LEASE_STATUSES.has(presentLease.status) ? presentLease : null;
  if (lease && !timestamp(lease.activatedAt)) {
    return { code: "INVALID_LEASE_ACTIVATION_TIMESTAMP" };
  }
  const deliveries = array(order.deliveries).filter(
    (delivery) => delivery && !delivery.deletedAt && delivery.deliveryStatus === "DELIVERED"
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
  if (deliveries.some((delivery) => !timestamp(delivery.deliveredAt))) {
    return { code: "INVALID_DELIVERY_TIMESTAMP" };
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
      vehicleReturn && !vehicleReturn.deletedAt && vehicleReturn.returnStatus === "CONFIRMED"
  );
  const inconsistentReturn = returns.find(
    (vehicleReturn) =>
      vehicleReturn.orderId !== order.id ||
      vehicleReturn.vehicleId !== order.vehicleId ||
      vehicleReturn.customerId !== order.customerId
  );
  if (inconsistentReturn) return { code: "RETURN_EVIDENCE_IDENTITY_MISMATCH" };
  if (returns.some((vehicleReturn) => !timestamp(vehicleReturn.returnedAt))) {
    return { code: "INVALID_RETURN_TIMESTAMP" };
  }
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
  if (!orderReturnTime && !evidenceReturnTime && CLOSED_ORDER_STATUSES.has(order.orderStatus)) {
    return { code: "MISSING_RETURN_EVIDENCE" };
  }
  return {
    endedAt: orderReturnTime ?? evidenceReturnTime,
    returnEvidence: returns.sort(compareId)[0] ?? null
  };
}

function buildPayload({
  activation,
  completion,
  contract,
  contractSegment,
  contractSegmentId,
  order,
  sourceKey,
  vehicle
}) {
  const endedAt = completion.endedAt ?? null;
  const authority = projectSubscriptionAuthority({
    contract,
    contractSegment,
    customer: order.customer,
    order,
    vehicle
  });
  return {
    contractId: order.contractId ?? null,
    contractSegmentId,
    customerId: order.customerId,
    endedAt,
    endReason: endedAt ? "BACKFILL" : null,
    endSnapshot: endedAt
      ? {
          authority,
          metadata: {
            orderActualReturnAt: timestamp(order.actualReturnAt),
            returnEvidence: completion.returnEvidence
              ? {
                  id: completion.returnEvidence.id,
                  returnedAt: timestamp(completion.returnEvidence.returnedAt),
                  status: completion.returnEvidence.returnStatus
                }
              : null
          }
        }
      : null,
    endSourceId: endedAt ? order.id : null,
    endSourceKey: endedAt ? `${sourceKey}:end` : null,
    endSourceType: endedAt ? START_SOURCE_TYPE : null,
    orderId: order.id,
    startedAt: activation.startedAt,
    startReason: "BACKFILL",
    startSnapshot: {
      authority,
      metadata: {
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
        }
      }
    },
    startSourceId: order.id,
    startSourceKey: sourceKey,
    startSourceType: START_SOURCE_TYPE,
    vehicleId: order.vehicleId
  };
}

function projectSubscriptionAuthority({ contract, contractSegment, customer, order, vehicle }) {
  return {
    contract: contract
      ? {
          contractNo: contract.contractNo,
          customerId: contract.customerId,
          id: contract.id,
          orderId: contract.orderId,
          status: contract.status
        }
      : null,
    contractSegment: contractSegment
      ? {
          id: contractSegment.id,
          orderId: contractSegment.orderId,
          segmentNo: contractSegment.segmentNo,
          sourceContractId: contractSegment.sourceContractId ?? null,
          status: contractSegment.status
        }
      : null,
    customer: {
      customerNo: customer.customerNo,
      id: customer.id,
      name: customer.name,
      status: customer.status
    },
    order: {
      contractId: order.contractId ?? null,
      customerId: order.customerId,
      id: order.id,
      orderNo: order.orderNo,
      orderStatus: order.orderStatus,
      vehicleId: order.vehicleId
    },
    vehicle: {
      id: vehicle.id,
      plateNo: vehicle.plateNo ?? null,
      status: vehicle.status,
      vehicleNo: vehicle.vehicleNo,
      vin: vehicle.vin ?? null
    }
  };
}

function resolveContractAuthority(contracts, order) {
  if (!order.contractId) return { contract: null };
  const referenced = contracts.filter((contract) => contract?.id === order.contractId);
  if (referenced.length === 0 || (referenced.length === 1 && referenced[0].deletedAt)) {
    return { code: "MISSING_CONTRACT" };
  }
  if (referenced.length !== 1) return { code: "SUBSCRIPTION_AGGREGATE_MISMATCH" };
  const contract = referenced[0];
  if (
    contract.deletedAt ||
    contract.orderId !== order.id ||
    contract.customerId !== order.customerId
  ) {
    return { code: "SUBSCRIPTION_AGGREGATE_MISMATCH" };
  }
  return { contract };
}

function resolveContractSegment(segments, startedAt, order, contract) {
  const startedDate = utcCalendarDate(startedAt);
  const covering = array(segments)
    .filter(
      (segment) =>
        segment &&
        segment.status !== "CANCELLED" &&
        utcCalendarDate(segment.startDate) &&
        utcCalendarDate(segment.endDate) &&
        utcCalendarDate(segment.startDate) <= startedDate &&
        startedDate <= utcCalendarDate(segment.endDate)
    )
    .sort(compareId);
  if (
    covering.some(
      (segment) =>
        segment.orderId !== order.id ||
        (segment.sourceContractId != null && segment.sourceContractId !== contract?.id)
    )
  ) {
    return { code: "SUBSCRIPTION_AGGREGATE_MISMATCH" };
  }
  if (covering.length === 1 && !hasCompleteContractSegmentAuthority(covering[0])) {
    return { code: "INCOMPLETE_AUTHORITY_SNAPSHOT" };
  }
  return {
    contractSegmentId: covering.length === 1 ? covering[0].id : null,
    contractSegment: covering.length === 1 ? covering[0] : null,
    coveringSegmentIds: covering.map((segment) => segment.id)
  };
}

function hasCompleteBaseAuthority({ contract, order, vehicle }) {
  return (
    hasDefined(vehicle, ["id", "vehicleNo", "status", "plateNo", "vin", "deletedAt"]) &&
    hasDefined(order, [
      "id",
      "orderNo",
      "customerId",
      "vehicleId",
      "contractId",
      "orderStatus",
      "deletedAt"
    ]) &&
    hasDefined(order.customer, ["id", "customerNo", "name", "status", "deletedAt"]) &&
    (!contract ||
      hasDefined(contract, ["id", "contractNo", "orderId", "customerId", "status", "deletedAt"]))
  );
}

function hasCompleteContractSegmentAuthority(segment) {
  return hasDefined(segment, ["id", "segmentNo", "orderId", "sourceContractId", "status"]);
}

function hasDefined(value, fields) {
  return (
    Boolean(value) &&
    fields.every((field) => Object.hasOwn(value, field) && value[field] !== undefined)
  );
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
    CLOSED_ORDER_STATUSES.has(order.orderStatus) ||
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

function utcCalendarDate(value) {
  return timestamp(value)?.slice(0, 10) ?? null;
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

function comparePersistedPeriod(left, right) {
  return `${left?.startSourceType ?? ""}|${left?.startSourceId ?? ""}|${
    left?.startSourceKey ?? ""
  }|${left?.id ?? ""}`.localeCompare(
    `${right?.startSourceType ?? ""}|${right?.startSourceId ?? ""}|${
      right?.startSourceKey ?? ""
    }|${right?.id ?? ""}`
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
  return `${left.code}|${left.orderId ?? left.leftSourceKey ?? left.sourceKey ?? ""}`.localeCompare(
    `${right.code}|${right.orderId ?? right.leftSourceKey ?? right.sourceKey ?? ""}`
  );
}
