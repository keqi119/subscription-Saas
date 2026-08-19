import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1c-period-backfill-core.mjs").catch(() => ({}));

function parseArgs(args) {
  assert.equal(typeof core.parseStage1cPeriodBackfillArgs, "function");
  return core.parseStage1cPeriodBackfillArgs(args);
}

function classify(snapshot) {
  assert.equal(typeof core.classifyStage1cPeriodBackfill, "function");
  return core.classifyStage1cPeriodBackfill(snapshot);
}

test("argument parsing requires exactly one mode and accepts one optional output", () => {
  assert.deepEqual(parseArgs(["--dry-run"]), { mode: "dry-run", output: null });
  assert.deepEqual(parseArgs(["--apply", "--output", "reports/periods.json"]), {
    mode: "apply",
    output: "reports/periods.json"
  });
  assert.deepEqual(parseArgs(["--dry-run", "--output=reports/periods.json"]), {
    mode: "dry-run",
    output: "reports/periods.json"
  });

  for (const args of [
    [],
    ["--dry-run", "--apply"],
    ["--dry-run", "--output"],
    ["--dry-run", "--output", "a.json", "--output", "b.json"],
    ["--dry-run", "--unknown"]
  ]) {
    assert.throws(() => parseArgs(args), /STAGE1C_PERIOD_BACKFILL_ARGUMENTS_INVALID/);
  }
});

test("trusted active, pending-return, and returned orders produce materialized payloads", () => {
  const active = orderRecord({ id: "order-active", orderNo: "ORD-ACTIVE" });
  const pendingReturn = orderRecord({
    id: "order-pending-return",
    orderNo: "ORD-PENDING-RETURN",
    orderStatus: "PENDING_RETURN",
    vehicleId: "vehicle-pending-return",
    customerId: "customer-pending-return",
    contractId: "contract-pending-return",
    lease: null,
    deliveries: [
      deliveryRecord({
        id: "delivery-pending-return",
        orderId: "order-pending-return",
        vehicleId: "vehicle-pending-return",
        customerId: "customer-pending-return",
        deliveredAt: date("2026-04-02T03:04:05.000Z")
      })
    ],
    contractSegments: []
  });
  const closed = orderRecord({
    id: "order-closed",
    orderNo: "ORD-CLOSED",
    orderStatus: "COMPLETED",
    vehicleId: "vehicle-closed",
    customerId: "customer-closed",
    contractId: "contract-closed",
    actualReturnAt: date("2026-06-01T08:00:00.000Z"),
    lease: leaseRecord({
      id: "lease-closed",
      orderId: "order-closed",
      status: "COMPLETED",
      activatedAt: date("2026-05-01T08:00:00.000Z")
    }),
    returns: [
      returnRecord({
        id: "return-closed",
        orderId: "order-closed",
        vehicleId: "vehicle-closed",
        customerId: "customer-closed",
        returnedAt: date("2026-06-01T08:00:00.000Z")
      })
    ],
    contractSegments: []
  });

  const report = classify(
    snapshot({
      orders: [pendingReturn, closed, active],
      vehicles: [
        vehicleRecord(),
        vehicleRecord({ id: "vehicle-pending-return", vehicleNo: "VEH-PENDING" }),
        vehicleRecord({ id: "vehicle-closed", vehicleNo: "VEH-CLOSED", status: "RETURNED" })
      ]
    })
  );

  assert.deepEqual(
    report.subscriptionPeriods.map(({ disposition, payload }) => ({ disposition, payload })),
    [
      { disposition: "CREATE", payload: expectedActivePayload() },
      {
        disposition: "CREATE",
        payload: expectedClosedPayload()
      },
      {
        disposition: "CREATE",
        payload: expectedPendingReturnPayload()
      }
    ]
  );
  assert.deepEqual(report.counters, {
    activeOrders: 1,
    closedPeriods: 1,
    existingOpenPeriods: 0,
    leasedVehicles: 2,
    oneOrderMultipleCurrentAnomalies: 0,
    overlaps: 0,
    ownershipUnknownVehicles: 3,
    proposedOpenPeriods: 2
  });
  assert.deepEqual(report.ownership.proposedPeriods, []);
  assert.deepEqual(
    report.ownership.unknownVehicles.map(({ vehicleId }) => vehicleId),
    ["vehicle-1", "vehicle-closed", "vehicle-pending-return"]
  );
});

test("untrusted and internally inconsistent source records are ambiguous", () => {
  const orders = [
    orderRecord({ id: "order-missing-vehicle", orderNo: "ORD-1", vehicleId: "absent" }),
    orderRecord({
      id: "order-missing-customer",
      orderNo: "ORD-2",
      customer: null,
      vehicleId: "vehicle-2",
      lease: leaseRecord({ id: "lease-2", orderId: "order-missing-customer" })
    }),
    orderRecord({
      id: "order-missing-activation",
      orderNo: "ORD-3",
      vehicleId: "vehicle-3",
      lease: null,
      deliveries: []
    }),
    orderRecord({
      id: "order-conflicting-starts",
      orderNo: "ORD-4",
      vehicleId: "vehicle-4",
      lease: leaseRecord({
        id: "lease-4",
        orderId: "order-conflicting-starts",
        activatedAt: date("2026-03-03T00:00:00.000Z")
      }),
      deliveries: [
        deliveryRecord({
          id: "delivery-4",
          orderId: "order-conflicting-starts",
          vehicleId: "vehicle-4",
          deliveredAt: date("2026-03-04T00:00:00.000Z")
        })
      ]
    }),
    orderRecord({
      id: "order-conflicting-returns",
      orderNo: "ORD-5",
      vehicleId: "vehicle-5",
      actualReturnAt: date("2026-04-01T00:00:00.000Z"),
      lease: leaseRecord({ id: "lease-5", orderId: "order-conflicting-returns" }),
      returns: [
        returnRecord({
          id: "return-5",
          orderId: "order-conflicting-returns",
          vehicleId: "vehicle-5",
          returnedAt: date("2026-04-02T00:00:00.000Z")
        })
      ]
    }),
    orderRecord({
      id: "order-invalid-range",
      orderNo: "ORD-6",
      vehicleId: "vehicle-6",
      actualReturnAt: date("2026-03-03T00:00:00.000Z"),
      lease: leaseRecord({
        id: "lease-6",
        orderId: "order-invalid-range",
        activatedAt: date("2026-03-03T00:00:00.000Z")
      })
    })
  ];
  const vehicles = Array.from({ length: 5 }, (_, index) =>
    vehicleRecord({ id: `vehicle-${index + 2}`, vehicleNo: `VEH-${index + 2}` })
  );

  const report = classify(snapshot({ orders, vehicles }));

  assert.deepEqual(
    report.ambiguities.map(({ code, orderId }) => ({ code, orderId })),
    [
      { code: "CONFLICTING_RETURN_TIMESTAMPS", orderId: "order-conflicting-returns" },
      { code: "CONFLICTING_START_TIMESTAMPS", orderId: "order-conflicting-starts" },
      { code: "INVALID_PERIOD_RANGE", orderId: "order-invalid-range" },
      { code: "MISSING_ACTIVATION_EVIDENCE", orderId: "order-missing-activation" },
      { code: "MISSING_CUSTOMER", orderId: "order-missing-customer" },
      { code: "MISSING_VEHICLE", orderId: "order-missing-vehicle" }
    ]
  );
  assert.deepEqual(report.subscriptionPeriods, []);
});

test("overlapping proposed and persisted periods are reported and skipped", () => {
  const proposedOverlap = classify(
    snapshot({
      orders: [
        orderRecord({ id: "order-a", orderNo: "ORD-A" }),
        orderRecord({
          id: "order-b",
          orderNo: "ORD-B",
          customerId: "customer-b",
          lease: leaseRecord({
            id: "lease-b",
            orderId: "order-b",
            activatedAt: date("2026-03-04T00:00:00.000Z")
          })
        })
      ]
    })
  );

  assert.deepEqual(proposedOverlap.subscriptionPeriods, []);
  assert.deepEqual(proposedOverlap.overlaps, [
    {
      code: "SUBSCRIPTION_PERIOD_OVERLAP",
      leftSourceKey: "stage1c-period-backfill:subscription-order:order-a",
      overlapWith: "PROPOSED",
      rightSourceKey: "stage1c-period-backfill:subscription-order:order-b",
      vehicleId: "vehicle-1"
    }
  ]);
  assert.equal(proposedOverlap.counters.overlaps, 1);

  const persistedOverlap = classify(
    snapshot({
      existingSubscriptionPeriods: [
        existingPeriod({
          id: "period-other",
          orderId: "order-other",
          startSourceId: "order-other",
          startSourceKey: "manual:order-other",
          startedAt: date("2026-03-02T00:00:00.000Z")
        })
      ]
    })
  );

  assert.deepEqual(persistedOverlap.subscriptionPeriods, []);
  assert.deepEqual(persistedOverlap.overlaps, [
    {
      code: "SUBSCRIPTION_PERIOD_OVERLAP",
      leftSourceKey: "stage1c-period-backfill:subscription-order:order-active",
      overlapWith: "PERSISTED",
      rightSourceKey: "manual:order-other",
      vehicleId: "vehicle-1"
    }
  ]);
});

test("classification is deterministic across source ordering", () => {
  const source = snapshot({
    orders: [
      orderRecord({ id: "order-z", orderNo: "ORD-Z" }),
      orderRecord({
        id: "order-a",
        orderNo: "ORD-A",
        vehicleId: "vehicle-a",
        customerId: "customer-a",
        lease: leaseRecord({ id: "lease-a", orderId: "order-a" })
      })
    ],
    vehicles: [vehicleRecord(), vehicleRecord({ id: "vehicle-a", vehicleNo: "VEH-A" })]
  });
  const reversed = {
    ...source,
    orders: [...source.orders].reverse(),
    vehicles: [...source.vehicles].reverse()
  };

  const first = classify(source);
  const second = classify(reversed);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(
    first.subscriptionPeriods.map(({ sourceKey }) => sourceKey),
    [
      "stage1c-period-backfill:subscription-order:order-a",
      "stage1c-period-backfill:subscription-order:order-z"
    ]
  );
});

test("same source and payload is unchanged while same-key drift conflicts", () => {
  const expected = expectedActivePayload();
  const unchanged = classify(
    snapshot({
      existingSubscriptionPeriods: [existingPeriod({ id: "period-exact", ...expected })]
    })
  );

  assert.deepEqual(unchanged.subscriptionPeriods, [
    {
      disposition: "UNCHANGED",
      existingPeriodId: "period-exact",
      orderId: "order-active",
      orderNo: "ORD-ACTIVE",
      payload: expected,
      sourceKey: "stage1c-period-backfill:subscription-order:order-active"
    }
  ]);

  const conflict = classify(
    snapshot({
      existingSubscriptionPeriods: [
        existingPeriod({
          id: "period-drifted",
          ...expected,
          customerId: "customer-wrong"
        })
      ]
    })
  );

  assert.deepEqual(conflict.subscriptionPeriods, [
    {
      differingFields: ["customerId"],
      disposition: "CONFLICT",
      existingPeriodId: "period-drifted",
      orderId: "order-active",
      orderNo: "ORD-ACTIVE",
      payload: expected,
      sourceKey: "stage1c-period-backfill:subscription-order:order-active"
    }
  ]);
});

test("platform ownership is never inferred and ownership reconciliation is explicit", () => {
  const report = classify(
    snapshot({
      assetOwners: [{ id: "owner-platform", ownerType: "PLATFORM", status: "ACTIVE" }],
      orders: [],
      vehicles: [
        vehicleRecord({ id: "vehicle-b", vehicleNo: "VEH-B" }),
        vehicleRecord({ id: "vehicle-a", vehicleNo: "VEH-A" })
      ],
      existingOwnershipPeriods: [
        {
          assetOwnerId: "owner-external",
          endedAt: null,
          id: "ownership-b",
          startedAt: date("2026-01-01T00:00:00.000Z"),
          vehicleId: "vehicle-b"
        }
      ]
    })
  );

  assert.deepEqual(report.ownership.proposedPeriods, []);
  assert.deepEqual(report.ownership.unknownVehicles, [
    { code: "OWNERSHIP_UNKNOWN", vehicleId: "vehicle-a", vehicleNo: "VEH-A" }
  ]);
  assert.equal(report.counters.ownershipUnknownVehicles, 1);
});

test("reconciliation counts existing periods and one-order-multiple-current anomalies", () => {
  const report = classify(
    snapshot({
      orders: [],
      vehicles: [vehicleRecord(), vehicleRecord({ id: "vehicle-2", vehicleNo: "VEH-2" })],
      existingSubscriptionPeriods: [
        existingPeriod({ id: "period-open-a", orderId: "order-shared" }),
        existingPeriod({
          id: "period-open-b",
          orderId: "order-shared",
          vehicleId: "vehicle-2",
          startSourceId: "order-shared",
          startSourceKey: "manual:period-open-b"
        }),
        existingPeriod({
          endedAt: date("2026-02-01T00:00:00.000Z"),
          id: "period-closed",
          orderId: "order-closed",
          startSourceId: "order-closed",
          startSourceKey: "manual:period-closed"
        })
      ]
    })
  );

  assert.equal(report.counters.existingOpenPeriods, 2);
  assert.equal(report.counters.closedPeriods, 1);
  assert.equal(report.counters.oneOrderMultipleCurrentAnomalies, 1);
});

function snapshot(overrides = {}) {
  return {
    assetOwners: [],
    existingOwnershipPeriods: [],
    existingSubscriptionPeriods: [],
    orders: [orderRecord()],
    vehicles: [vehicleRecord()],
    ...overrides
  };
}

function orderRecord(overrides = {}) {
  const id = overrides.id ?? "order-active";
  const customerId = overrides.customerId ?? "customer-1";
  const vehicleId = overrides.vehicleId ?? "vehicle-1";
  return {
    actualReturnAt: null,
    contractId: "contract-1",
    contractSegments: [
      {
        endDate: date("2026-12-31T00:00:00.000Z"),
        id: "segment-1",
        startDate: date("2026-01-01T00:00:00.000Z"),
        status: "ACTIVE"
      }
    ],
    customer: { deletedAt: null, id: customerId },
    customerId,
    deletedAt: null,
    deliveries: [],
    id,
    lease: leaseRecord({ orderId: id }),
    orderNo: "ORD-ACTIVE",
    orderStatus: "ACTIVE",
    returns: [],
    vehicleId,
    ...overrides
  };
}

function vehicleRecord(overrides = {}) {
  return {
    deletedAt: null,
    id: "vehicle-1",
    status: "LEASED",
    vehicleNo: "VEH-1",
    ...overrides
  };
}

function leaseRecord(overrides = {}) {
  return {
    activatedAt: date("2026-03-03T00:00:00.000Z"),
    deletedAt: null,
    id: "lease-1",
    orderId: "order-active",
    status: "ACTIVE",
    ...overrides
  };
}

function deliveryRecord(overrides = {}) {
  return {
    customerId: "customer-1",
    deletedAt: null,
    deliveredAt: date("2026-03-03T00:00:00.000Z"),
    deliveryStatus: "DELIVERED",
    id: "delivery-1",
    orderId: "order-active",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function returnRecord(overrides = {}) {
  return {
    customerId: "customer-1",
    deletedAt: null,
    id: "return-1",
    orderId: "order-active",
    returnedAt: date("2026-04-03T00:00:00.000Z"),
    returnStatus: "CONFIRMED",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function existingPeriod(overrides = {}) {
  return {
    contractId: "contract-1",
    contractSegmentId: "segment-1",
    customerId: "customer-other",
    endedAt: null,
    endReason: null,
    endSnapshot: null,
    endSourceId: null,
    endSourceKey: null,
    endSourceType: null,
    id: "period-1",
    orderId: "order-other",
    startedAt: date("2026-01-01T00:00:00.000Z"),
    startReason: "BACKFILL",
    startSnapshot: {},
    startSourceId: "order-other",
    startSourceKey: "manual:period-1",
    startSourceType: "SUBSCRIPTION_ORDER",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function expectedActivePayload() {
  return {
    contractId: "contract-1",
    contractSegmentId: "segment-1",
    customerId: "customer-1",
    endedAt: null,
    endReason: null,
    endSnapshot: null,
    endSourceId: null,
    endSourceKey: null,
    endSourceType: null,
    orderId: "order-active",
    startedAt: "2026-03-03T00:00:00.000Z",
    startReason: "BACKFILL",
    startSnapshot: {
      activationEvidence: {
        delivery: null,
        lease: {
          activatedAt: "2026-03-03T00:00:00.000Z",
          id: "lease-1",
          status: "ACTIVE"
        }
      },
      order: {
        contractId: "contract-1",
        customerId: "customer-1",
        id: "order-active",
        orderNo: "ORD-ACTIVE",
        orderStatus: "ACTIVE",
        vehicleId: "vehicle-1"
      }
    },
    startSourceId: "order-active",
    startSourceKey: "stage1c-period-backfill:subscription-order:order-active",
    startSourceType: "SUBSCRIPTION_ORDER",
    vehicleId: "vehicle-1"
  };
}

function expectedPendingReturnPayload() {
  return {
    ...expectedActivePayload(),
    contractId: "contract-pending-return",
    contractSegmentId: null,
    customerId: "customer-pending-return",
    orderId: "order-pending-return",
    startedAt: "2026-04-02T03:04:05.000Z",
    startSnapshot: {
      activationEvidence: {
        delivery: {
          deliveredAt: "2026-04-02T03:04:05.000Z",
          id: "delivery-pending-return",
          status: "DELIVERED"
        },
        lease: null
      },
      order: {
        contractId: "contract-pending-return",
        customerId: "customer-pending-return",
        id: "order-pending-return",
        orderNo: "ORD-PENDING-RETURN",
        orderStatus: "PENDING_RETURN",
        vehicleId: "vehicle-pending-return"
      }
    },
    startSourceId: "order-pending-return",
    startSourceKey: "stage1c-period-backfill:subscription-order:order-pending-return",
    vehicleId: "vehicle-pending-return"
  };
}

function expectedClosedPayload() {
  return {
    ...expectedActivePayload(),
    contractId: "contract-closed",
    contractSegmentId: null,
    customerId: "customer-closed",
    endedAt: "2026-06-01T08:00:00.000Z",
    endReason: "BACKFILL",
    endSnapshot: {
      orderActualReturnAt: "2026-06-01T08:00:00.000Z",
      returnEvidence: {
        id: "return-closed",
        returnedAt: "2026-06-01T08:00:00.000Z",
        status: "CONFIRMED"
      }
    },
    endSourceId: "order-closed",
    endSourceKey: "stage1c-period-backfill:subscription-order:order-closed:end",
    endSourceType: "SUBSCRIPTION_ORDER",
    orderId: "order-closed",
    startedAt: "2026-05-01T08:00:00.000Z",
    startSnapshot: {
      activationEvidence: {
        delivery: null,
        lease: {
          activatedAt: "2026-05-01T08:00:00.000Z",
          id: "lease-closed",
          status: "COMPLETED"
        }
      },
      order: {
        contractId: "contract-closed",
        customerId: "customer-closed",
        id: "order-closed",
        orderNo: "ORD-CLOSED",
        orderStatus: "COMPLETED",
        vehicleId: "vehicle-closed"
      }
    },
    startSourceId: "order-closed",
    startSourceKey: "stage1c-period-backfill:subscription-order:order-closed",
    vehicleId: "vehicle-closed"
  };
}

function date(value) {
  return new Date(value);
}
