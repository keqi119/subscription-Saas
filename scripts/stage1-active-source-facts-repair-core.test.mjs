import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1-active-source-facts-repair-core.mjs").catch(() => ({}));

function parse(args) {
  assert.equal(typeof core.parseStage1ActiveSourceFactsRepairArgs, "function");
  return core.parseStage1ActiveSourceFactsRepairArgs(args);
}

function classify(input) {
  assert.equal(typeof core.classifyStage1ActiveSourceFactsRepair, "function");
  return core.classifyStage1ActiveSourceFactsRepair(input);
}

test("argument parsing requires one mode and accepts one output path", () => {
  assert.deepEqual(parse(["--dry-run"]), { mode: "dry-run", output: null });
  assert.deepEqual(parse(["--apply", "--output", "reports/source-facts.json"]), {
    mode: "apply",
    output: "reports/source-facts.json"
  });
  assert.deepEqual(parse(["--dry-run", "--output=report.json"]), {
    mode: "dry-run",
    output: "report.json"
  });

  for (const args of [
    [],
    ["--dry-run", "--apply"],
    ["--dry-run", "--output"],
    ["--dry-run", "--output", "   "],
    ["--dry-run", "--output=a", "--output=b"],
    ["--unknown"]
  ]) {
    assert.throws(() => parse(args), /STAGE1_ACTIVE_SOURCE_FACTS_REPAIR_ARGUMENTS_INVALID/);
  }
});

test("classifies a provable combined date, archive, and binding repair", () => {
  const report = classify(
    snapshot({
      contractId: null,
      contracts: [contract({ status: "SIGNED", archivedAt: null })],
      startDate: null,
      endDate: null
    })
  );

  assert.deepEqual(report.candidates[0].actions, [
    "ARCHIVE_CONTRACT",
    "BIND_CONTRACT",
    "SET_ORDER_DATES"
  ]);
  assert.equal(report.candidates[0].startDate, "2026-08-26");
  assert.equal(report.candidates[0].endDate, "2027-08-25");
  assert.equal(report.candidates[0].archivedAt, "2026-08-26T03:53:26.694Z");
  assert.match(report.candidates[0].evidenceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.summary, {
    actions: { ARCHIVE_CONTRACT: 1, BIND_CONTRACT: 1, SET_ORDER_DATES: 1 },
    candidates: 1,
    exceptions: 0,
    inspectedOrders: 1,
    unchanged: 0
  });
});

test("fails closed on a one-day activation conflict", () => {
  const input = snapshot();
  input.orders[0].lease.activatedAt = "2026-08-27T03:53:26.694Z";

  assert.equal(classify(input).exceptions[0].code, "ACTIVATION_TIMESTAMP_CONFLICT");
});

test("fails closed when activation evidence is missing, ambiguous, or mismatched", () => {
  const missing = snapshot();
  missing.orders[0].lease = null;
  assert.equal(classify(missing).exceptions[0].code, "ACTIVATION_EVIDENCE_MISSING");

  const ambiguous = snapshot();
  ambiguous.orders[0].deliveries.push({
    ...ambiguous.orders[0].deliveries[0],
    id: "delivery-2"
  });
  assert.equal(classify(ambiguous).exceptions[0].code, "ACTIVATION_EVIDENCE_AMBIGUOUS");

  const mismatch = snapshot();
  mismatch.orders[0].deliveries[0].vehicleId = "vehicle-other";
  assert.equal(classify(mismatch).exceptions[0].code, "ACTIVATION_IDENTITY_MISMATCH");
});

test("rejects partial and conflicting existing order dates", () => {
  const partial = snapshot({ startDate: "2026-08-26T00:00:00.000Z", endDate: null });
  assert.equal(classify(partial).exceptions[0].code, "ORDER_DATE_PARTIAL");

  const conflict = snapshot({
    startDate: "2026-08-25T00:00:00.000Z",
    endDate: "2027-08-24T00:00:00.000Z"
  });
  assert.equal(classify(conflict).exceptions[0].code, "ORDER_DATE_CONFLICT");
});

test("fails closed for missing and ambiguous contract authority", () => {
  const missing = snapshot({ contractId: null, contracts: [] });
  assert.equal(classify(missing).exceptions[0].code, "CONTRACT_AUTHORITY_MISSING");

  const ambiguous = snapshot({
    contractId: null,
    contracts: [contract({ id: "contract-a" }), contract({ id: "contract-b" })]
  });
  assert.equal(classify(ambiguous).exceptions[0].code, "CONTRACT_AUTHORITY_AMBIGUOUS");
});

test("fails closed for multiple completed Stage 1 signing tasks", () => {
  const input = snapshot({
    contractId: null,
    contracts: [
      contract({
        eSignTasks: [eSignTask({ id: "task-a" }), eSignTask({ id: "task-b" })]
      })
    ]
  });

  assert.equal(classify(input).exceptions[0].code, "CONTRACT_AUTHORITY_AMBIGUOUS");
});

test("rejects incomplete and mismatched signed artifacts", () => {
  const missingPdf = snapshot({
    contracts: [contract({ file: null, status: "SIGNED", archivedAt: null })]
  });
  assert.equal(classify(missingPdf).exceptions[0].code, "SIGNED_ARTIFACT_INCOMPLETE");

  const mismatchedObjectKey = snapshot({
    contracts: [
      contract({
        file: fileObject({ objectKey: "signed/contracts/file-a.pdf" }),
        eSignTasks: [eSignTask({ signedDocumentObjectKey: "signed/contracts/file-b.pdf" })],
        status: "SIGNED",
        archivedAt: null
      })
    ]
  });
  assert.equal(classify(mismatchedObjectKey).exceptions[0].code, "SIGNED_ARTIFACT_MISMATCH");
});

test("rejects an invalid contract signing timeline", () => {
  const input = snapshot({
    contracts: [
      contract({
        signedAt: "2026-08-26T04:00:00.000Z",
        eSignTasks: [eSignTask({ completedAt: "2026-08-26T03:53:26.694Z" })],
        status: "SIGNED",
        archivedAt: null
      })
    ]
  });

  assert.equal(classify(input).exceptions[0].code, "CONTRACT_TIMELINE_INVALID");
});

test("does not repair parent facts after downstream facts already exist", () => {
  const withSegment = snapshot({
    startDate: null,
    endDate: null,
    contractSegments: [{ id: "segment-1" }]
  });
  assert.equal(classify(withSegment).exceptions[0].code, "DOWNSTREAM_FACTS_ALREADY_PRESENT");

  const withPeriod = snapshot({
    startDate: null,
    endDate: null,
    subscriptionPeriods: [{ id: "period-1" }]
  });
  assert.equal(classify(withPeriod).exceptions[0].code, "DOWNSTREAM_FACTS_ALREADY_PRESENT");
});

test("classifies a healthy order as unchanged", () => {
  const report = classify(snapshot());

  assert.equal(report.candidates.length, 0);
  assert.equal(report.exceptions.length, 0);
  assert.deepEqual(report.unchanged, [
    {
      contractId: "contract-1",
      evidenceDigest: report.unchanged[0].evidenceDigest,
      orderId: "order-1",
      orderNo: "ORD-1"
    }
  ]);
});

test("classification is deterministic and never exposes raw object keys", () => {
  const firstOrder = snapshot().orders[0];
  const secondOrder = order({
    id: "order-2",
    orderNo: "ORD-2",
    customerId: "customer-2",
    vehicleId: "vehicle-2",
    contractId: "contract-2",
    deliveries: [
      delivery({
        id: "delivery-2",
        orderId: "order-2",
        customerId: "customer-2",
        vehicleId: "vehicle-2"
      })
    ],
    lease: lease({ id: "lease-2", orderId: "order-2" }),
    contracts: [
      contract({
        id: "contract-2",
        orderId: "order-2",
        customerId: "customer-2",
        contractNo: "CON-2",
        file: fileObject({ id: "file-2", objectKey: "secret/raw-contract-2.pdf" }),
        fileId: "file-2",
        eSignTasks: [
          eSignTask({
            id: "task-2",
            contractId: "contract-2",
            orderId: "order-2",
            signedDocumentObjectKey: "secret/raw-contract-2.pdf"
          })
        ]
      })
    ]
  });
  const left = classify({ orders: [secondOrder, firstOrder] });
  const right = classify({ orders: [firstOrder, secondOrder] });

  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.deepEqual(
    left.unchanged.map(({ orderId }) => orderId),
    ["order-1", "order-2"]
  );
  const publicReport = JSON.stringify(left);
  assert.doesNotMatch(publicReport, /secret\/raw-contract-2\.pdf/);
  assert.doesNotMatch(publicReport, /signed\/contracts\/contract-1\.pdf/);
  assert.doesNotMatch(publicReport, /objectKey|signedDocumentObjectKey/);
});

function snapshot(overrides = {}) {
  return { orders: [order(overrides)] };
}

function order(overrides = {}) {
  const id = overrides.id ?? "order-1";
  const customerId = overrides.customerId ?? "customer-1";
  const vehicleId = overrides.vehicleId ?? "vehicle-1";
  const contractId = Object.hasOwn(overrides, "contractId") ? overrides.contractId : "contract-1";
  const contracts = overrides.contracts ?? [
    contract({ id: "contract-1", orderId: id, customerId })
  ];
  return {
    actualDeliveryAt: "2026-08-26T03:53:26.694Z",
    contractId,
    contractSegments: [],
    contracts,
    customerId,
    deletedAt: null,
    deliveries: [delivery({ orderId: id, customerId, vehicleId })],
    endDate: "2027-08-25T00:00:00.000Z",
    id,
    lease: lease({ orderId: id }),
    orderNo: overrides.orderNo ?? "ORD-1",
    orderStatus: "ACTIVE",
    periodMonths: 12,
    startDate: "2026-08-26T00:00:00.000Z",
    subscriptionPeriods: [],
    vehicleId,
    ...overrides,
    contracts
  };
}

function delivery(overrides = {}) {
  return {
    customerId: "customer-1",
    deletedAt: null,
    deliveredAt: "2026-08-26T03:53:26.694Z",
    deliveryStatus: "DELIVERED",
    id: "delivery-1",
    orderId: "order-1",
    vehicleId: "vehicle-1",
    ...overrides
  };
}

function lease(overrides = {}) {
  return {
    activatedAt: "2026-08-26T03:53:26.694Z",
    deletedAt: null,
    id: "lease-1",
    orderId: "order-1",
    status: "ACTIVE",
    ...overrides
  };
}

function contract(overrides = {}) {
  const id = overrides.id ?? "contract-1";
  const orderId = overrides.orderId ?? "order-1";
  const objectKey = overrides.file?.objectKey ?? "signed/contracts/contract-1.pdf";
  return {
    archivedAt: "2026-08-26T03:53:26.694Z",
    contractNo: "CON-1",
    contractSnapshot: { terms: "signed" },
    customerId: "customer-1",
    deletedAt: null,
    eSignTasks: [eSignTask({ contractId: id, orderId, signedDocumentObjectKey: objectKey })],
    file: fileObject({ objectKey }),
    fileId: "file-1",
    id,
    orderId,
    signedAt: "2026-08-26T03:50:00.000Z",
    status: "ARCHIVED",
    ...overrides
  };
}

function eSignTask(overrides = {}) {
  return {
    completedAt: "2026-08-26T03:53:26.694Z",
    contractId: "contract-1",
    documentType: "SUBSCRIPTION_CONTRACT",
    id: "task-1",
    orderId: "order-1",
    signedDocumentObjectKey: "signed/contracts/contract-1.pdf",
    signingStage: "STAGE1_SUBSCRIPTION_CONTRACT",
    taskStatus: "COMPLETED",
    ...overrides
  };
}

function fileObject(overrides = {}) {
  return {
    id: "file-1",
    mimeType: "application/pdf",
    objectKey: "signed/contracts/contract-1.pdf",
    sizeBytes: 1024n,
    ...overrides
  };
}
