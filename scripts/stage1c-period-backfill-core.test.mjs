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
    ["--dry-run", "--output", "   "],
    ["--dry-run", "--output=\t"],
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
      contracts: [
        contractRecord(),
        contractRecord({
          customerId: "customer-pending-return",
          id: "contract-pending-return",
          orderId: "order-pending-return"
        }),
        contractRecord({
          customerId: "customer-closed",
          id: "contract-closed",
          orderId: "order-closed"
        })
      ],
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
    isolatedOrder("missing-vehicle", { orderNo: "ORD-1", vehicleId: "absent" }),
    isolatedOrder("missing-customer", {
      orderNo: "ORD-2",
      customer: null,
      vehicleId: "vehicle-2",
      lease: leaseRecord({ id: "lease-2", orderId: "order-missing-customer" })
    }),
    isolatedOrder("missing-activation", {
      orderNo: "ORD-3",
      vehicleId: "vehicle-3",
      lease: null,
      deliveries: []
    }),
    isolatedOrder("conflicting-starts", {
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
    isolatedOrder("conflicting-returns", {
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
    isolatedOrder("invalid-range", {
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
        isolatedOrder("a", { orderNo: "ORD-A", vehicleId: "vehicle-1" }),
        isolatedOrder("b", {
          orderNo: "ORD-B",
          customerId: "customer-b",
          vehicleId: "vehicle-1",
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
      isolatedOrder("z", { orderNo: "ORD-Z", vehicleId: "vehicle-1" }),
      isolatedOrder("a", {
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
    contracts: [...source.contracts].reverse(),
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

test("referenced contract authority must exist, be live, and match the order aggregate", () => {
  const missing = classify(snapshot({ contracts: [] }));
  const deleted = classify(
    snapshot({ contracts: [contractRecord({ deletedAt: date("2026-08-01T00:00:00.000Z") })] })
  );
  const wrongOrder = classify(
    snapshot({ contracts: [contractRecord({ orderId: "order-foreign" })] })
  );
  const wrongCustomer = classify(
    snapshot({ contracts: [contractRecord({ customerId: "customer-foreign" })] })
  );

  assert.deepEqual(
    [missing, deleted, wrongOrder, wrongCustomer].map((report) =>
      report.ambiguities.map(({ code }) => code)
    ),
    [
      ["MISSING_CONTRACT"],
      ["MISSING_CONTRACT"],
      ["SUBSCRIPTION_AGGREGATE_MISMATCH"],
      ["SUBSCRIPTION_AGGREGATE_MISMATCH"]
    ]
  );
  assert.deepEqual(
    [missing, deleted, wrongOrder, wrongCustomer].map(
      (report) => report.subscriptionPeriods.length
    ),
    [0, 0, 0, 0]
  );
});

test("authority liveness markers must be present in the classifier input", () => {
  const orderWithoutMarker = orderRecord();
  delete orderWithoutMarker.deletedAt;
  const customerWithoutMarker = orderRecord();
  delete customerWithoutMarker.customer.deletedAt;
  const vehicleWithoutMarker = vehicleRecord();
  delete vehicleWithoutMarker.deletedAt;
  const contractWithoutMarker = contractRecord({ deletedAt: undefined });

  const reports = [
    classify(snapshot({ orders: [orderWithoutMarker] })),
    classify(snapshot({ orders: [customerWithoutMarker] })),
    classify(snapshot({ vehicles: [vehicleWithoutMarker] })),
    classify(snapshot({ contracts: [contractWithoutMarker] }))
  ];

  assert.deepEqual(
    reports.map((report) => report.ambiguities.map(({ code }) => code)),
    [
      ["INCOMPLETE_AUTHORITY_SNAPSHOT"],
      ["INCOMPLETE_AUTHORITY_SNAPSHOT"],
      ["INCOMPLETE_AUTHORITY_SNAPSHOT"],
      ["INCOMPLETE_AUTHORITY_SNAPSHOT"]
    ]
  );
  assert.deepEqual(
    reports.map((report) => report.subscriptionPeriods.length),
    [0, 0, 0, 0]
  );
});

test("invalid confirmed evidence and closed projections without returns fail closed", () => {
  const invalidDelivery = isolatedOrder("invalid-delivery", {
    deliveries: [
      deliveryRecord({
        deliveredAt: null,
        id: "delivery-invalid",
        orderId: "order-invalid-delivery",
        vehicleId: "vehicle-invalid-delivery"
      })
    ]
  });
  const invalidReturn = isolatedOrder("invalid-return", {
    actualReturnAt: date("2026-04-03T00:00:00.000Z"),
    returns: [
      returnRecord({
        id: "return-invalid",
        orderId: "order-invalid-return",
        returnedAt: "not-a-timestamp",
        vehicleId: "vehicle-invalid-return"
      })
    ]
  });
  const completedWithoutReturn = isolatedOrder("completed-without-return", {
    orderStatus: "COMPLETED"
  });
  const terminatedWithoutReturn = isolatedOrder("terminated-without-return", {
    orderStatus: "TERMINATED"
  });

  const report = classify(
    snapshot({
      orders: [invalidDelivery, invalidReturn, completedWithoutReturn, terminatedWithoutReturn],
      vehicles: [
        vehicleRecord({ id: "vehicle-invalid-delivery" }),
        vehicleRecord({ id: "vehicle-invalid-return" }),
        vehicleRecord({ id: "vehicle-completed-without-return" }),
        vehicleRecord({ id: "vehicle-terminated-without-return" })
      ]
    })
  );

  assert.deepEqual(
    report.ambiguities.map(({ code, orderId }) => ({ code, orderId })),
    [
      { code: "INVALID_DELIVERY_TIMESTAMP", orderId: "order-invalid-delivery" },
      { code: "INVALID_RETURN_TIMESTAMP", orderId: "order-invalid-return" },
      { code: "MISSING_RETURN_EVIDENCE", orderId: "order-completed-without-return" },
      { code: "MISSING_RETURN_EVIDENCE", orderId: "order-terminated-without-return" }
    ]
  );
  assert.deepEqual(report.subscriptionPeriods, []);
});

test("absent or undefined evidence liveness markers fail closed deterministically", () => {
  const leaseAbsent = leaseRecord({
    id: "lease-liveness-absent",
    orderId: "order-lease-liveness-absent"
  });
  delete leaseAbsent.deletedAt;
  const leaseUndefined = leaseRecord({
    deletedAt: undefined,
    id: "lease-liveness-undefined",
    orderId: "order-lease-liveness-undefined"
  });
  const deliveryAbsent = deliveryRecord({
    id: "delivery-liveness-absent",
    orderId: "order-delivery-liveness-absent",
    vehicleId: "vehicle-delivery-liveness-absent"
  });
  delete deliveryAbsent.deletedAt;
  const deliveryUndefined = deliveryRecord({
    deletedAt: undefined,
    id: "delivery-liveness-undefined",
    orderId: "order-delivery-liveness-undefined",
    vehicleId: "vehicle-delivery-liveness-undefined"
  });
  const returnAbsent = returnRecord({
    id: "return-liveness-absent",
    orderId: "order-return-liveness-absent",
    vehicleId: "vehicle-return-liveness-absent"
  });
  delete returnAbsent.deletedAt;
  const returnUndefined = returnRecord({
    deletedAt: undefined,
    id: "return-liveness-undefined",
    orderId: "order-return-liveness-undefined",
    vehicleId: "vehicle-return-liveness-undefined"
  });
  const orders = [
    isolatedOrder("lease-liveness-absent", {
      deliveries: [
        deliveryRecord({
          id: "delivery-for-lease-absent",
          orderId: "order-lease-liveness-absent",
          vehicleId: "vehicle-lease-liveness-absent"
        })
      ],
      lease: leaseAbsent
    }),
    isolatedOrder("lease-liveness-undefined", {
      deliveries: [
        deliveryRecord({
          id: "delivery-for-lease-undefined",
          orderId: "order-lease-liveness-undefined",
          vehicleId: "vehicle-lease-liveness-undefined"
        })
      ],
      lease: leaseUndefined
    }),
    isolatedOrder("delivery-liveness-absent", { deliveries: [deliveryAbsent] }),
    isolatedOrder("delivery-liveness-undefined", { deliveries: [deliveryUndefined] }),
    isolatedOrder("return-liveness-absent", {
      actualReturnAt: date("2026-04-03T00:00:00.000Z"),
      returns: [returnAbsent]
    }),
    isolatedOrder("return-liveness-undefined", {
      actualReturnAt: date("2026-04-03T00:00:00.000Z"),
      returns: [returnUndefined]
    })
  ];
  const source = snapshot({
    orders,
    vehicles: orders.map((order) => vehicleRecord({ id: order.vehicleId }))
  });
  const reversed = {
    ...source,
    contracts: [...source.contracts].reverse(),
    orders: [...source.orders].reverse(),
    vehicles: [...source.vehicles].reverse()
  };

  const report = classify(source);

  assert.equal(JSON.stringify(report), JSON.stringify(classify(reversed)));
  assert.deepEqual(
    report.ambiguities.map(({ code, orderId }) => ({ code, orderId })),
    [
      {
        code: "DELIVERY_EVIDENCE_LIVENESS_UNKNOWN",
        orderId: "order-delivery-liveness-absent"
      },
      {
        code: "DELIVERY_EVIDENCE_LIVENESS_UNKNOWN",
        orderId: "order-delivery-liveness-undefined"
      },
      { code: "LEASE_LIVENESS_UNKNOWN", orderId: "order-lease-liveness-absent" },
      { code: "LEASE_LIVENESS_UNKNOWN", orderId: "order-lease-liveness-undefined" },
      {
        code: "RETURN_EVIDENCE_LIVENESS_UNKNOWN",
        orderId: "order-return-liveness-absent"
      },
      {
        code: "RETURN_EVIDENCE_LIVENESS_UNKNOWN",
        orderId: "order-return-liveness-undefined"
      }
    ]
  );
  assert.deepEqual(report.subscriptionPeriods, []);
});

test("explicitly deleted evidence is ignored", () => {
  const deletedAt = date("2026-08-01T00:00:00.000Z");
  const orders = [
    isolatedOrder("deleted-lease", {
      deliveries: [
        deliveryRecord({
          id: "delivery-live",
          orderId: "order-deleted-lease",
          vehicleId: "vehicle-deleted-lease"
        })
      ],
      lease: leaseRecord({
        activatedAt: "invalid-but-deleted",
        deletedAt,
        id: "lease-deleted",
        orderId: "order-foreign"
      })
    }),
    isolatedOrder("deleted-delivery", {
      deliveries: [
        deliveryRecord({
          deletedAt,
          deliveredAt: "invalid-but-deleted",
          id: "delivery-deleted",
          orderId: "order-foreign",
          vehicleId: "vehicle-foreign"
        })
      ]
    }),
    isolatedOrder("deleted-return", {
      returns: [
        returnRecord({
          deletedAt,
          id: "return-deleted",
          orderId: "order-foreign",
          returnedAt: "invalid-but-deleted",
          vehicleId: "vehicle-foreign"
        })
      ]
    })
  ];
  const report = classify(
    snapshot({
      orders,
      vehicles: orders.map((order) => vehicleRecord({ id: order.vehicleId }))
    })
  );

  assert.deepEqual(report.ambiguities, []);
  assert.deepEqual(
    report.subscriptionPeriods.map(({ disposition, payload, sourceKey }) => ({
      disposition,
      endedAt: payload.endedAt,
      selectedDeliveryId: payload.startSnapshot.metadata.activationEvidence.delivery?.id ?? null,
      selectedLeaseId: payload.startSnapshot.metadata.activationEvidence.lease?.id ?? null,
      sourceKey
    })),
    [
      {
        disposition: "CREATE",
        endedAt: null,
        selectedDeliveryId: null,
        selectedLeaseId: "lease-deleted-delivery",
        sourceKey: "stage1c-period-backfill:subscription-order:order-deleted-delivery"
      },
      {
        disposition: "CREATE",
        endedAt: null,
        selectedDeliveryId: "delivery-live",
        selectedLeaseId: null,
        sourceKey: "stage1c-period-backfill:subscription-order:order-deleted-lease"
      },
      {
        disposition: "CREATE",
        endedAt: null,
        selectedDeliveryId: null,
        selectedLeaseId: "lease-deleted-return",
        sourceKey: "stage1c-period-backfill:subscription-order:order-deleted-return"
      }
    ]
  );
});

test("an explicitly live lease requires a valid activation timestamp", () => {
  const report = classify(
    snapshot({
      orders: [
        isolatedOrder("invalid-live-lease", {
          lease: leaseRecord({
            activatedAt: "not-a-timestamp",
            deletedAt: null,
            id: "lease-invalid-live",
            orderId: "order-invalid-live-lease"
          })
        })
      ],
      vehicles: [vehicleRecord({ id: "vehicle-invalid-live-lease" })]
    })
  );

  assert.deepEqual(
    report.ambiguities.map(({ code, orderId }) => ({ code, orderId })),
    [
      {
        code: "INVALID_LEASE_ACTIVATION_TIMESTAMP",
        orderId: "order-invalid-live-lease"
      }
    ]
  );
  assert.deepEqual(report.subscriptionPeriods, []);
});

test("lease and covering contract-segment identities must match the order aggregate", () => {
  const leaseMismatch = isolatedOrder("lease-mismatch", {
    lease: leaseRecord({ id: "lease-mismatch", orderId: "order-foreign" })
  });
  const segmentOrderMismatch = isolatedOrder("segment-order-mismatch", {
    contractSegments: [
      segmentRecord({
        id: "segment-order-mismatch",
        orderId: "order-foreign",
        sourceContractId: "contract-segment-order-mismatch"
      })
    ]
  });
  const segmentContractMismatch = isolatedOrder("segment-contract-mismatch", {
    contractSegments: [
      segmentRecord({
        id: "segment-contract-mismatch",
        orderId: "order-segment-contract-mismatch",
        sourceContractId: "contract-foreign"
      })
    ]
  });

  const report = classify(
    snapshot({
      orders: [leaseMismatch, segmentOrderMismatch, segmentContractMismatch],
      vehicles: [
        vehicleRecord({ id: "vehicle-lease-mismatch" }),
        vehicleRecord({ id: "vehicle-segment-order-mismatch" }),
        vehicleRecord({ id: "vehicle-segment-contract-mismatch" })
      ]
    })
  );

  assert.deepEqual(
    report.ambiguities.map(({ code, orderId }) => ({ code, orderId })),
    [
      {
        code: "ACTIVATION_EVIDENCE_IDENTITY_MISMATCH",
        orderId: "order-lease-mismatch"
      },
      {
        code: "SUBSCRIPTION_AGGREGATE_MISMATCH",
        orderId: "order-segment-contract-mismatch"
      },
      {
        code: "SUBSCRIPTION_AGGREGATE_MISMATCH",
        orderId: "order-segment-order-mismatch"
      }
    ]
  );
  assert.deepEqual(report.subscriptionPeriods, []);
});

test("persisted reconciliation requires one exact full source identity", () => {
  const expected = expectedActivePayload();
  const exact = existingPeriod({ id: "period-exact", ...expected });
  const drift = existingPeriod({
    id: "period-drift",
    ...expected,
    customerId: "customer-drift"
  });
  const forward = classify(snapshot({ existingSubscriptionPeriods: [exact, drift] }));
  const reversed = classify(snapshot({ existingSubscriptionPeriods: [drift, exact] }));

  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
  assert.equal(forward.subscriptionPeriods[0].disposition, "CONFLICT");
  assert.equal(forward.subscriptionPeriods[0].conflictCode, "MULTIPLE_PERSISTED_SOURCE_ROWS");
  assert.deepEqual(forward.subscriptionPeriods[0].existingPeriodIds, [
    "period-drift",
    "period-exact"
  ]);
  assert.deepEqual(
    forward.invariantViolations.filter(({ code }) => code === "PERSISTED_SOURCE_IDENTITY_CONFLICT"),
    [
      {
        code: "PERSISTED_SOURCE_IDENTITY_CONFLICT",
        existingPeriodIds: ["period-drift", "period-exact"],
        sourceKey: "stage1c-period-backfill:subscription-order:order-active"
      }
    ]
  );

  const foreignTuple = classify(
    snapshot({
      existingSubscriptionPeriods: [
        existingPeriod({
          id: "period-foreign",
          ...expected,
          startSourceId: "order-foreign",
          startSourceType: "FOREIGN_SOURCE"
        })
      ]
    })
  );

  assert.equal(foreignTuple.subscriptionPeriods[0].disposition, "CONFLICT");
  assert.equal(
    foreignTuple.subscriptionPeriods[0].conflictCode,
    "PERSISTED_SOURCE_IDENTITY_CONFLICT"
  );
  assert.deepEqual(foreignTuple.subscriptionPeriods[0].differingFields, [
    "startSourceId",
    "startSourceType"
  ]);
});

test("contract segment dates include the entire UTC calendar end day", () => {
  const endDay = classify(
    snapshot({
      orders: [
        orderRecord({
          lease: leaseRecord({ activatedAt: date("2026-03-31T23:59:59.999Z") }),
          contractSegments: [
            segmentRecord({
              endDate: date("2026-03-31T00:00:00.000Z"),
              id: "segment-end-day",
              startDate: date("2026-03-01T00:00:00.000Z")
            })
          ]
        })
      ]
    })
  );
  const afterEndDay = classify(
    snapshot({
      orders: [
        orderRecord({
          lease: leaseRecord({ activatedAt: date("2026-04-01T00:00:00.000Z") }),
          contractSegments: [
            segmentRecord({
              endDate: date("2026-03-31T00:00:00.000Z"),
              id: "segment-ended",
              startDate: date("2026-03-01T00:00:00.000Z")
            })
          ]
        })
      ]
    })
  );
  const beforeStartDay = classify(
    snapshot({
      orders: [
        orderRecord({
          lease: leaseRecord({ activatedAt: date("2026-02-28T23:59:59.999Z") }),
          contractSegments: [
            segmentRecord({
              endDate: date("2026-03-31T00:00:00.000Z"),
              id: "segment-not-started",
              startDate: date("2026-03-01T00:00:00.000Z")
            })
          ]
        })
      ]
    })
  );

  assert.equal(endDay.subscriptionPeriods[0].payload.contractSegmentId, "segment-end-day");
  assert.equal(afterEndDay.subscriptionPeriods[0].payload.contractSegmentId, null);
  assert.equal(beforeStartDay.subscriptionPeriods[0].payload.contractSegmentId, null);
});

test("report remains deterministic when authorities, evidence, and segments are reversed", () => {
  const order = isolatedOrder("deterministic", {
    actualReturnAt: date("2026-04-03T00:00:00.000Z"),
    contractSegments: [
      segmentRecord({
        endDate: date("2026-02-01T00:00:00.000Z"),
        id: "segment-old",
        orderId: "order-deterministic",
        sourceContractId: "contract-deterministic"
      }),
      segmentRecord({
        id: "segment-current",
        orderId: "order-deterministic",
        sourceContractId: "contract-deterministic"
      })
    ],
    deliveries: [
      deliveryRecord({
        id: "delivery-z",
        orderId: "order-deterministic",
        vehicleId: "vehicle-deterministic"
      }),
      deliveryRecord({
        id: "delivery-a",
        orderId: "order-deterministic",
        vehicleId: "vehicle-deterministic"
      })
    ],
    returns: [
      returnRecord({
        id: "return-z",
        orderId: "order-deterministic",
        vehicleId: "vehicle-deterministic"
      }),
      returnRecord({
        id: "return-a",
        orderId: "order-deterministic",
        vehicleId: "vehicle-deterministic"
      })
    ]
  });
  const source = snapshot({
    orders: [order],
    vehicles: [vehicleRecord({ id: "vehicle-deterministic" })]
  });
  const reversed = {
    ...source,
    contracts: [...source.contracts].reverse(),
    orders: source.orders.map((record) => ({
      ...record,
      contractSegments: [...record.contractSegments].reverse(),
      deliveries: [...record.deliveries].reverse(),
      returns: [...record.returns].reverse()
    })),
    vehicles: [...source.vehicles].reverse()
  };

  assert.equal(JSON.stringify(classify(source)), JSON.stringify(classify(reversed)));
});

function snapshot(overrides = {}) {
  const orders = overrides.orders ?? [orderRecord()];
  const contracts =
    overrides.contracts ??
    orders
      .filter((order) => order.contractId)
      .map((order) =>
        contractRecord({
          customerId: order.customerId,
          id: order.contractId,
          orderId: order.id
        })
      );
  return {
    assetOwners: [],
    contracts,
    existingOwnershipPeriods: [],
    existingSubscriptionPeriods: [],
    orders,
    vehicles: [vehicleRecord()],
    ...overrides
  };
}

function orderRecord(overrides = {}) {
  const id = overrides.id ?? "order-active";
  const customerId = overrides.customerId ?? "customer-1";
  const vehicleId = overrides.vehicleId ?? "vehicle-1";
  const contractId = overrides.contractId ?? "contract-1";
  return {
    actualReturnAt: null,
    contractId,
    contractSegments: [
      segmentRecord({
        orderId: id,
        sourceContractId: contractId
      })
    ],
    customer: {
      customerNo: "CUS-1",
      deletedAt: null,
      id: customerId,
      name: "Customer One",
      status: "ACTIVE"
    },
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

function isolatedOrder(suffix, overrides = {}) {
  const id = `order-${suffix}`;
  const contractId = `contract-${suffix}`;
  return orderRecord({
    contractId,
    contractSegments: [
      segmentRecord({
        id: `segment-${suffix}`,
        orderId: id,
        segmentNo: `SEG-${suffix}`,
        sourceContractId: contractId
      })
    ],
    id,
    lease: leaseRecord({ id: `lease-${suffix}`, orderId: id }),
    orderNo: `ORD-${suffix}`,
    vehicleId: `vehicle-${suffix}`,
    ...overrides
  });
}

function vehicleRecord(overrides = {}) {
  return {
    deletedAt: null,
    id: "vehicle-1",
    plateNo: "沪A00001",
    status: "LEASED",
    vehicleNo: "VEH-1",
    vin: "VIN00000000000001",
    ...overrides
  };
}

function contractRecord(overrides = {}) {
  return {
    contractNo: "CTR-1",
    customerId: "customer-1",
    deletedAt: null,
    id: "contract-1",
    orderId: "order-active",
    status: "ARCHIVED",
    ...overrides
  };
}

function segmentRecord(overrides = {}) {
  return {
    endDate: date("2026-12-31T00:00:00.000Z"),
    id: "segment-1",
    orderId: "order-active",
    segmentNo: "SEG-1",
    sourceContractId: "contract-1",
    startDate: date("2026-01-01T00:00:00.000Z"),
    status: "ACTIVE",
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
      authority: {
        contract: {
          contractNo: "CTR-1",
          customerId: "customer-1",
          id: "contract-1",
          orderId: "order-active",
          status: "ARCHIVED"
        },
        contractSegment: {
          id: "segment-1",
          orderId: "order-active",
          segmentNo: "SEG-1",
          sourceContractId: "contract-1",
          status: "ACTIVE"
        },
        customer: {
          customerNo: "CUS-1",
          id: "customer-1",
          name: "Customer One",
          status: "ACTIVE"
        },
        order: {
          contractId: "contract-1",
          customerId: "customer-1",
          id: "order-active",
          orderNo: "ORD-ACTIVE",
          orderStatus: "ACTIVE",
          vehicleId: "vehicle-1"
        },
        vehicle: {
          id: "vehicle-1",
          plateNo: "沪A00001",
          status: "LEASED",
          vehicleNo: "VEH-1",
          vin: "VIN00000000000001"
        }
      },
      metadata: {
        activationEvidence: {
          delivery: null,
          lease: {
            activatedAt: "2026-03-03T00:00:00.000Z",
            id: "lease-1",
            status: "ACTIVE"
          }
        }
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
      authority: {
        contract: {
          contractNo: "CTR-1",
          customerId: "customer-pending-return",
          id: "contract-pending-return",
          orderId: "order-pending-return",
          status: "ARCHIVED"
        },
        contractSegment: null,
        customer: {
          customerNo: "CUS-1",
          id: "customer-pending-return",
          name: "Customer One",
          status: "ACTIVE"
        },
        order: {
          contractId: "contract-pending-return",
          customerId: "customer-pending-return",
          id: "order-pending-return",
          orderNo: "ORD-PENDING-RETURN",
          orderStatus: "PENDING_RETURN",
          vehicleId: "vehicle-pending-return"
        },
        vehicle: {
          id: "vehicle-pending-return",
          plateNo: "沪A00001",
          status: "LEASED",
          vehicleNo: "VEH-PENDING",
          vin: "VIN00000000000001"
        }
      },
      metadata: {
        activationEvidence: {
          delivery: {
            deliveredAt: "2026-04-02T03:04:05.000Z",
            id: "delivery-pending-return",
            status: "DELIVERED"
          },
          lease: null
        }
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
      authority: {
        contract: {
          contractNo: "CTR-1",
          customerId: "customer-closed",
          id: "contract-closed",
          orderId: "order-closed",
          status: "ARCHIVED"
        },
        contractSegment: null,
        customer: {
          customerNo: "CUS-1",
          id: "customer-closed",
          name: "Customer One",
          status: "ACTIVE"
        },
        order: {
          contractId: "contract-closed",
          customerId: "customer-closed",
          id: "order-closed",
          orderNo: "ORD-CLOSED",
          orderStatus: "COMPLETED",
          vehicleId: "vehicle-closed"
        },
        vehicle: {
          id: "vehicle-closed",
          plateNo: "沪A00001",
          status: "RETURNED",
          vehicleNo: "VEH-CLOSED",
          vin: "VIN00000000000001"
        }
      },
      metadata: {
        orderActualReturnAt: "2026-06-01T08:00:00.000Z",
        returnEvidence: {
          id: "return-closed",
          returnedAt: "2026-06-01T08:00:00.000Z",
          status: "CONFIRMED"
        }
      }
    },
    endSourceId: "order-closed",
    endSourceKey: "stage1c-period-backfill:subscription-order:order-closed:end",
    endSourceType: "SUBSCRIPTION_ORDER",
    orderId: "order-closed",
    startedAt: "2026-05-01T08:00:00.000Z",
    startSnapshot: {
      authority: {
        contract: {
          contractNo: "CTR-1",
          customerId: "customer-closed",
          id: "contract-closed",
          orderId: "order-closed",
          status: "ARCHIVED"
        },
        contractSegment: null,
        customer: {
          customerNo: "CUS-1",
          id: "customer-closed",
          name: "Customer One",
          status: "ACTIVE"
        },
        order: {
          contractId: "contract-closed",
          customerId: "customer-closed",
          id: "order-closed",
          orderNo: "ORD-CLOSED",
          orderStatus: "COMPLETED",
          vehicleId: "vehicle-closed"
        },
        vehicle: {
          id: "vehicle-closed",
          plateNo: "沪A00001",
          status: "RETURNED",
          vehicleNo: "VEH-CLOSED",
          vin: "VIN00000000000001"
        }
      },
      metadata: {
        activationEvidence: {
          delivery: null,
          lease: {
            activatedAt: "2026-05-01T08:00:00.000Z",
            id: "lease-closed",
            status: "COMPLETED"
          }
        }
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
