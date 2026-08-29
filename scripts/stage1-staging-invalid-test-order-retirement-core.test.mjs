import assert from "node:assert/strict";
import test from "node:test";

const core = await import("./stage1-staging-invalid-test-order-retirement-core.mjs").catch(
  () => ({})
);

const selectors = {
  orderId: "c392fa54-4784-4e04-ad4a-bfe2fd7e2d10",
  orderNo: "ORD20260726073922TFHF",
  vehicleId: "70565059-1841-4c97-a32c-7bd09ce0b90f",
  vehicleNo: "VEH20260713140950K4BT",
  vin: "TESTVINET50000001"
};
const operatorId = "11111111-1111-4111-8111-111111111111";

function required(name) {
  assert.equal(typeof core[name], "function", `${name} must be exported`);
  return core[name];
}

function selectorArgs(overrides = {}) {
  const current = { ...selectors, ...overrides };
  return [
    "--order-id",
    current.orderId,
    "--order-no",
    current.orderNo,
    "--vehicle-id",
    current.vehicleId,
    "--vehicle-no",
    current.vehicleNo,
    "--vin",
    current.vin,
    "--operator-id",
    operatorId
  ];
}

test("parses the exact dry-run contract", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  assert.deepEqual(
    parse(["--dry-run", ...selectorArgs(), "--output", "output/retirement-dry-run.json"]),
    {
      expectedEvidenceDigest: null,
      mode: "dry-run",
      operatorId,
      output: "output/retirement-dry-run.json",
      selectors
    }
  );
});

test("apply requires one lowercase sha256 evidence digest", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  const base = ["--apply", ...selectorArgs()];

  assert.throws(
    () => parse(base),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_EXPECTED_EVIDENCE_DIGEST_REQUIRED/
  );
  assert.throws(
    () => parse([...base, "--expected-evidence-digest", "A".repeat(64)]),
    /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_ARGUMENTS_INVALID/
  );
  assert.equal(
    parse([...base, "--expected-evidence-digest", "a".repeat(64)]).expectedEvidenceDigest,
    "a".repeat(64)
  );
});

test("rejects unknown, repeated, malformed, missing, or mode-incompatible arguments", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  for (const args of [
    [],
    ["--dry-run", "--apply", ...selectorArgs()],
    ["--dry-run", ...selectorArgs(), "--unknown", "x"],
    ["--dry-run", ...selectorArgs(), "--expected-evidence-digest", "a".repeat(64)],
    ["--dry-run", ...selectorArgs(), "--output"],
    ["--dry-run", ...selectorArgs(), "--output", "   "],
    ["--dry-run", ...selectorArgs(), "--order-id", selectors.orderId],
    [
      "--dry-run",
      ...selectorArgs().filter((value) => value !== "--vin" && value !== selectors.vin)
    ],
    ["--dry-run", ...selectorArgs().map((value) => (value === operatorId ? "not-a-uuid" : value))]
  ]) {
    assert.throws(
      () => parse(args),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_/,
      JSON.stringify(args)
    );
  }
});

test("supports equals syntax for output only", () => {
  const parse = required("parseStage1StagingInvalidTestOrderRetirementArgs");
  assert.equal(
    parse(["--dry-run", ...selectorArgs(), "--output=output/report.json"]).output,
    "output/report.json"
  );
});

test("target assertion accepts only the frozen five-field identity", () => {
  const assertTarget = required("assertStage1StagingInvalidTestOrderRetirementTarget");
  assert.doesNotThrow(() => assertTarget(selectors));
  for (const field of Object.keys(selectors)) {
    assert.throws(
      () => assertTarget({ ...selectors, [field]: `${selectors[field]}-other` }),
      /STAGE1_STAGING_INVALID_TEST_ORDER_RETIREMENT_TARGET_MISMATCH/
    );
  }
});

test("classifies only the exact empty-history active tuple as a candidate", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const result = classify(cleanSnapshot());

  assert.equal(result.disposition, "CANDIDATE");
  assert.deepEqual(result.blockers, []);
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.candidate, {
    billingScheduleId: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
    leaseId: "44444444-4444-4444-8444-444444444444",
    orderId: selectors.orderId,
    transitions: {
      billingSchedule: ["PAUSED", "CANCELLED"],
      lease: ["ACTIVE", "COMPLETED"],
      order: ["ACTIVE", "CANCELLED"],
      vehicle: ["LEASED", "AVAILABLE"]
    },
    vehicleId: selectors.vehicleId
  });
  assert.deepEqual(result.summary, { blockers: 0, inspectedOrders: 1 });
});

test("every prohibited relation fails closed with a stable count blocker", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  for (const field of Object.keys(cleanSnapshot().blockingCounts)) {
    const input = cleanSnapshot();
    input.blockingCounts[field] = 1;
    const result = classify(input);
    assert.equal(result.disposition, "BLOCKED", field);
    assert.ok(
      result.blockers.some(
        ({ code, count, relation }) =>
          code === "RELATED_RECORDS_PRESENT" && count === 1 && relation === field
      ),
      field
    );
  }
});

test("rejects target identity, lifecycle, delivery, return, occupation, and price drift", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const cases = [
    ["TARGET_IDENTITY_MISMATCH", { order: { ...cleanSnapshot().order, orderNo: "ORD-WRONG" } }],
    ["ORDER_STATUS_INVALID", { order: { ...cleanSnapshot().order, orderStatus: "SUSPENDED" } }],
    ["LEASE_STATUS_INVALID", { lease: { ...cleanSnapshot().lease, status: "RETURN_DUE" } }],
    [
      "BILLING_SCHEDULE_STATUS_INVALID",
      { billingSchedule: { ...cleanSnapshot().billingSchedule, status: "ACTIVE" } }
    ],
    ["VEHICLE_STATUS_INVALID", { vehicle: { ...cleanSnapshot().vehicle, status: "RENTED" } }],
    ["VEHICLE_DELIVERY_PRESENT", { vehicleDeliveries: [{ id: "delivery-1" }] }],
    [
      "ORDER_ACTUAL_RETURN_PRESENT",
      { order: { ...cleanSnapshot().order, actualReturnAt: "2026-08-29T00:00:00.000Z" } }
    ],
    [
      "VEHICLE_OTHER_ACTIVE_ORDER",
      { vehicle: { ...cleanSnapshot().vehicle, activeOtherOrders: [{ id: "other-order" }] } }
    ],
    [
      "VEHICLE_OTHER_ACTIVE_LEASE",
      { vehicle: { ...cleanSnapshot().vehicle, activeOtherLeases: [{ id: "other-lease" }] } }
    ],
    [
      "VEHICLE_ACTIVE_SUBSCRIPTION_PERIOD",
      {
        vehicle: {
          ...cleanSnapshot().vehicle,
          activeSubscriptionPeriods: [{ id: "active-period", orderId: "other-order" }]
        }
      }
    ],
    [
      "VEHICLE_ACTIVE_RESTRICTION",
      { vehicle: { ...cleanSnapshot().vehicle, activeRestrictions: [{ id: "restriction" }] } }
    ],
    [
      "VEHICLE_SALE_PRICE_NOT_EFFECTIVE",
      { vehicle: { ...cleanSnapshot().vehicle, salePriceStatus: "PENDING_INITIALIZE" } }
    ],
    [
      "VEHICLE_SALE_PRICE_NOT_POSITIVE",
      { vehicle: { ...cleanSnapshot().vehicle, currentSalePriceAmount: 0n } }
    ],
    [
      "BILLING_SCHEDULE_LAST_BILL_PRESENT",
      { billingSchedule: { ...cleanSnapshot().billingSchedule, lastGeneratedBillId: "bill-1" } }
    ]
  ];

  for (const [code, overrides] of cases) {
    const result = classify(cleanSnapshot(overrides));
    assert.ok(
      result.blockers.some((row) => row.code === code),
      code
    );
  }
});

test("requires one active ADMIN operator and terminal background evidence", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const disabledOperator = cleanSnapshot();
  disabledOperator.operator.status = "DISABLED";
  assert.ok(
    classify(disabledOperator).blockers.some(({ code }) => code === "OPERATOR_NOT_ACTIVE_ADMIN")
  );

  const noAdmin = cleanSnapshot();
  noAdmin.operator.roles = [
    {
      code: "OP",
      deletedAt: null,
      roleDeletedAt: null,
      roleStatus: "ACTIVE"
    }
  ];
  assert.ok(classify(noAdmin).blockers.some(({ code }) => code === "OPERATOR_NOT_ACTIVE_ADMIN"));

  const pendingEsign = cleanSnapshot();
  pendingEsign.evidenceReferences.eSignTasks[0].taskStatus = "SIGNING";
  assert.ok(classify(pendingEsign).blockers.some(({ code }) => code === "NONTERMINAL_ESIGN_TASK"));

  const pendingHandoverJob = cleanSnapshot();
  pendingHandoverJob.evidenceReferences.handoverWorkflowJobs[0].jobStatus = "PENDING";
  assert.ok(
    classify(pendingHandoverJob).blockers.some(
      ({ code }) => code === "NONTERMINAL_HANDOVER_WORKFLOW_JOB"
    )
  );

  const recoverableDeadLetter = cleanSnapshot();
  recoverableDeadLetter.evidenceReferences.handoverWorkflowJobs[0].jobStatus = "DEAD_LETTER";
  assert.ok(
    classify(recoverableDeadLetter).blockers.some(
      ({ code }) => code === "NONTERMINAL_HANDOVER_WORKFLOW_JOB"
    )
  );

  const activeHandoverWorkOrder = cleanSnapshot();
  activeHandoverWorkOrder.evidenceReferences.handoverWorkOrders[0].status = "SIGNING";
  assert.ok(
    classify(activeHandoverWorkOrder).blockers.some(
      ({ code }) => code === "NONTERMINAL_HANDOVER_WORK_ORDER"
    )
  );

  const journeyCases = [
    ["status", "RUNNING", "NONTERMINAL_SUBSCRIPTION_JOURNEY"],
    ["steps", "RUNNING", "NONTERMINAL_SUBSCRIPTION_JOURNEY_STEP"],
    ["jobs", "PENDING", "NONTERMINAL_SUBSCRIPTION_JOURNEY_JOB"],
    ["manualTasks", "OPEN", "NONTERMINAL_SUBSCRIPTION_JOURNEY_MANUAL_TASK"],
    ["exceptions", "ACKNOWLEDGED", "UNRESOLVED_SUBSCRIPTION_JOURNEY_EXCEPTION"],
    ["outboxRows", "PROCESSING", "NONTERMINAL_SUBSCRIPTION_JOURNEY_OUTBOX"]
  ];
  for (const [field, status, blockerCode] of journeyCases) {
    const pendingJourney = cleanSnapshot();
    pendingJourney.journey = terminalJourney();
    if (field === "status") pendingJourney.journey.status = status;
    else pendingJourney.journey[field][0].status = status;
    assert.ok(
      classify(pendingJourney).blockers.some(({ code }) => code === blockerCode),
      `${field} must fail closed`
    );
  }
});

test("evidence digest is deterministic and public classification is credential safe", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const first = cleanSnapshot();
  first.evidenceReferences.contracts.push({
    id: "00000000-0000-4000-8000-000000000002",
    objectKey: "private/second-contract.pdf",
    status: "ARCHIVED"
  });
  const second = structuredClone(first);
  second.evidenceReferences.contracts.reverse();

  const left = classify(first);
  const right = classify(second);
  assert.equal(left.evidenceDigest, right.evidenceDigest);
  assert.deepEqual(left.review.relatedCounts, emptyBlockingCounts());
  assert.deepEqual(left.review.vehicleAvailability, {
    activeOtherLeases: 0,
    activeOtherOrders: 0,
    activeRestrictions: 0,
    activeSubscriptionPeriods: 0
  });
  assert.deepEqual(left.review.evidence.handoverWorkOrders, [
    {
      handoverId: "bfc5a943-0000-4000-8000-000000000000",
      id: "00000000-0000-4000-8000-000000000005",
      orderId: selectors.orderId,
      status: "FIELD_COMPLETED"
    }
  ]);
  const publicReport = JSON.stringify(left);
  assert.doesNotMatch(publicReport, /private\//);
  assert.doesNotMatch(publicReport, /objectKey|signedDocumentObjectKey|DATABASE_URL|mobile/);
});

test("evidence digest changes when an evidence row is deleted or re-associated", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const baseline = cleanSnapshot();
  const deleted = structuredClone(baseline);
  deleted.evidenceReferences.contracts[0].deletedAt = "2026-08-29T00:00:00.000Z";
  const reassociated = structuredClone(baseline);
  reassociated.evidenceReferences.eSignTasks[0].contractId = "99999999-9999-4999-8999-999999999999";

  assert.notEqual(classify(deleted).evidenceDigest, classify(baseline).evidenceDigest);
  assert.notEqual(classify(reassociated).evidenceDigest, classify(baseline).evidenceDigest);
});

test("evidence digest covers handover evidence and referenced file identities", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const baseline = cleanSnapshot();
  const changedFile = structuredClone(baseline);
  changedFile.evidenceReferences.fileObjects[0].contentSha256 = "f".repeat(64);
  const reassociatedFile = structuredClone(baseline);
  reassociatedFile.evidenceReferences.evidenceFiles[0].fileId =
    "00000000-0000-4000-8000-000000000099";
  const reassociatedHandover = structuredClone(baseline);
  reassociatedHandover.evidenceReferences.handovers[0].sourceDocumentFileId =
    "00000000-0000-4000-8000-000000000098";

  assert.notEqual(classify(changedFile).evidenceDigest, classify(baseline).evidenceDigest);
  assert.notEqual(classify(reassociatedFile).evidenceDigest, classify(baseline).evidenceDigest);
  assert.notEqual(classify(reassociatedHandover).evidenceDigest, classify(baseline).evidenceDigest);
});

test("recognizes only a complete matching four-audit replay", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const before = classify(cleanSnapshot());
  const terminal = terminalSnapshot(cleanSnapshot(), before.evidenceDigest);

  const replay = classify(terminal);
  assert.equal(replay.disposition, "UNCHANGED");
  assert.equal(replay.evidenceDigest, before.evidenceDigest);

  terminal.auditLogs.pop();
  const missingAudit = classify(terminal);
  assert.equal(missingAudit.disposition, "BLOCKED");
  assert.ok(missingAudit.blockers.some(({ code }) => code === "RETIREMENT_AUDIT_MISMATCH"));
});

test("terminal replay still blocks newly introduced forbidden facts", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const before = classify(cleanSnapshot());
  const terminal = terminalSnapshot(cleanSnapshot(), before.evidenceDigest);
  terminal.blockingCounts.receivableBills = 1;

  const replay = classify(terminal);
  assert.equal(replay.disposition, "BLOCKED");
  assert.ok(
    replay.blockers.some(
      ({ code, relation }) => code === "RELATED_RECORDS_PRESENT" && relation === "receivableBills"
    )
  );
});

test("mixed initial and terminal states never auto-continue", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const input = cleanSnapshot();
  input.order.orderStatus = "CANCELLED";

  const result = classify(input);
  assert.equal(result.disposition, "BLOCKED");
  assert.ok(result.blockers.some(({ code }) => code === "PARTIAL_RETIREMENT_STATE"));
});

test("initial state with a prior retirement audit is blocked", () => {
  const classify = required("classifyStage1StagingInvalidTestOrderRetirement");
  const input = cleanSnapshot();
  input.auditLogs = [
    {
      action: "UPDATE",
      entityId: input.order.id,
      entityType: "subscription_order",
      module: "STAGE1_STAGING_TEST_DATA_RETIREMENT",
      operatorId
    }
  ];

  const result = classify(input);
  assert.equal(result.disposition, "BLOCKED");
  assert.ok(result.blockers.some(({ code }) => code === "RETIREMENT_AUDIT_UNEXPECTED"));
});

function cleanSnapshot(overrides = {}) {
  return {
    auditLogs: [],
    billingSchedule: {
      cancelledAt: null,
      id: "36054e6d-5104-4daf-b8a7-cb7e956fc436",
      lastGeneratedBillId: null,
      pauseReason: "legacy-test-order",
      status: "PAUSED",
      version: 0
    },
    blockingCounts: emptyBlockingCounts(),
    evidenceReferences: {
      contracts: [
        {
          contractVersionId: "00000000-0000-4000-8000-000000000012",
          fileId: "00000000-0000-4000-8000-000000000011",
          id: "00000000-0000-4000-8000-000000000001",
          deletedAt: null,
          objectKey: "private/original-contract.pdf",
          orderId: selectors.orderId,
          status: "SIGNED"
        }
      ],
      eSignTasks: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          contractId: "00000000-0000-4000-8000-000000000001",
          deletedAt: null,
          orderId: selectors.orderId,
          sourceId: "00000000-0000-4000-8000-000000000001",
          sourceType: "CONTRACT",
          signedDocumentObjectKey: "private/signed-contract.pdf",
          taskStatus: "COMPLETED"
        }
      ],
      evidenceFiles: [
        {
          evidenceItemId: "00000000-0000-4000-8000-000000000006",
          fileId: "00000000-0000-4000-8000-000000000013",
          id: "00000000-0000-4000-8000-000000000007",
          lifecycleStatus: "ACTIVE",
          replacedById: null
        }
      ],
      evidenceItems: [
        {
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000006",
          orderId: selectors.orderId,
          reviewStatus: "APPROVED",
          status: "ACCEPTED",
          vehicleDeliveryId: null
        }
      ],
      fileObjects: [
        {
          contentSha256: "a".repeat(64),
          createdAt: "2026-07-31T02:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000011",
          sizeBytes: 1024n
        },
        {
          contentSha256: "b".repeat(64),
          createdAt: "2026-07-31T02:30:00.000Z",
          id: "00000000-0000-4000-8000-000000000013",
          sizeBytes: 2048n
        }
      ],
      handovers: [
        {
          archiveStatus: "ARCHIVED",
          handoverContractId: null,
          handoverESignTaskId: "00000000-0000-4000-8000-000000000003",
          id: "bfc5a943-0000-4000-8000-000000000000",
          orderId: selectors.orderId,
          signedDocumentFileId: "00000000-0000-4000-8000-000000000013",
          sourceDocumentFileId: "00000000-0000-4000-8000-000000000011",
          stage1ContractId: "00000000-0000-4000-8000-000000000001",
          status: "ARCHIVED"
        }
      ],
      handoverWorkOrders: [
        {
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000005",
          orderId: selectors.orderId,
          status: "FIELD_COMPLETED"
        }
      ],
      handoverWorkflowJobs: [
        {
          eSignTaskId: "00000000-0000-4000-8000-000000000003",
          handoverId: "bfc5a943-0000-4000-8000-000000000000",
          id: "00000000-0000-4000-8000-000000000004",
          jobStatus: "COMPLETED",
          workOrderId: "00000000-0000-4000-8000-000000000005"
        }
      ]
    },
    journey: null,
    lease: {
      activatedAt: "2026-07-31T03:01:04.000Z",
      deletedAt: null,
      id: "44444444-4444-4444-8444-444444444444",
      status: "ACTIVE"
    },
    operator: {
      deletedAt: null,
      id: operatorId,
      roles: [
        {
          code: "ADMIN",
          deletedAt: null,
          roleDeletedAt: null,
          roleStatus: "ACTIVE"
        }
      ],
      status: "ACTIVE"
    },
    order: {
      actualDeliveryAt: "2026-07-31T03:01:04.000Z",
      actualReturnAt: null,
      contractId: null,
      deletedAt: null,
      endDate: null,
      id: selectors.orderId,
      orderNo: selectors.orderNo,
      orderStatus: "ACTIVE",
      startDate: null,
      vehicleId: selectors.vehicleId
    },
    vehicle: {
      activeOtherLeases: [],
      activeOtherOrders: [],
      activeRestrictions: [],
      activeSubscriptionPeriods: [],
      currentSalePriceAmount: 18500000n,
      deletedAt: null,
      id: selectors.vehicleId,
      salePriceStatus: "EFFECTIVE",
      status: "LEASED",
      vehicleNo: selectors.vehicleNo,
      vin: selectors.vin
    },
    vehicleDeliveries: [],
    ...overrides
  };
}

function terminalJourney() {
  return {
    currentStepCode: "AUTHORITATIVE_ACTIVATION",
    currentStepStatus: "COMPLETED",
    events: [
      {
        eventType: "JOURNEY_COMPLETED",
        id: "journey-event-1",
        sequence: 12
      }
    ],
    exceptions: [
      {
        code: "REVIEW_RESOLVED",
        id: "journey-exception-1",
        jobId: null,
        retryable: false,
        status: "RESOLVED",
        stepId: "journey-step-1"
      }
    ],
    id: "journey-1",
    jobs: [
      {
        id: "journey-job-1",
        jobType: "ACTIVATE_SUBSCRIPTION",
        status: "COMPLETED",
        stepId: "journey-step-1"
      }
    ],
    manualTasks: [
      {
        id: "journey-task-1",
        status: "COMPLETED",
        stepId: "journey-step-1",
        taskType: "DELIVERY_EVIDENCE_DECISION"
      }
    ],
    orderId: selectors.orderId,
    outboxRows: [
      {
        aggregateId: "journey-1",
        aggregateType: "SUBSCRIPTION_JOURNEY",
        eventType: "JOURNEY_COMPLETED",
        id: "journey-outbox-1",
        status: "DELIVERED"
      }
    ],
    status: "COMPLETED",
    steps: [
      {
        code: "AUTHORITATIVE_ACTIVATION",
        id: "journey-step-1",
        status: "COMPLETED"
      }
    ]
  };
}

function emptyBlockingCounts() {
  return {
    assetWorkOrders: 0,
    automationJobs: 0,
    closureCases: 0,
    collectionActions: 0,
    collectionCaseBills: 0,
    collectionCases: 0,
    contractSegments: 0,
    costLedgerEntries: 0,
    debitAttempts: 0,
    depositLedgers: 0,
    entitlementAccounts: 0,
    entitlementGrants: 0,
    entitlementUsages: 0,
    insuranceClaims: 0,
    mileageReadings: 0,
    mileageReviews: 0,
    orderChanges: 0,
    paymentMandates: 0,
    paymentOrders: 0,
    paymentRecords: 0,
    paymentWriteOffs: 0,
    receivableBills: 0,
    renewalConsiderations: 0,
    returnDamages: 0,
    returns: 0,
    revenueRightAssignments: 0,
    serviceCases: 0,
    subscriptionChanges: 0,
    subscriptionPeriods: 0
  };
}

function terminalSnapshot(snapshot, evidenceDigest) {
  const terminal = structuredClone(snapshot);
  terminal.billingSchedule.cancelledAt = "2026-08-29T01:00:00.000Z";
  terminal.billingSchedule.pauseReason = "STAGING_INVALID_TEST_DATA_RETIREMENT";
  terminal.billingSchedule.status = "CANCELLED";
  terminal.billingSchedule.version += 1;
  terminal.lease.status = "COMPLETED";
  terminal.order.orderStatus = "CANCELLED";
  terminal.vehicle.status = "AVAILABLE";
  const correlationId = "22222222-2222-4222-8222-222222222222";
  terminal.auditLogs = [
    ["billing_schedule", terminal.billingSchedule.id, "PAUSED", "CANCELLED"],
    ["lease", terminal.lease.id, "ACTIVE", "COMPLETED"],
    ["subscription_order", terminal.order.id, "ACTIVE", "CANCELLED"],
    ["vehicle", terminal.vehicle.id, "LEASED", "AVAILABLE"]
  ].map(([entityType, entityId, beforeStatus, afterStatus]) => ({
    action: "UPDATE",
    afterSnapshot: {
      correlationId,
      entityId,
      evidenceDigest,
      reasonCode: "STAGING_INVALID_TEST_DATA_RETIREMENT",
      status: afterStatus
    },
    beforeSnapshot: {
      correlationId,
      entityId,
      evidenceDigest,
      reasonCode: "STAGING_INVALID_TEST_DATA_RETIREMENT",
      status: beforeStatus
    },
    entityId,
    entityType,
    module: "STAGE1_STAGING_TEST_DATA_RETIREMENT",
    operatorId
  }));
  return terminal;
}
