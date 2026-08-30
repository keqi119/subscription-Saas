import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStage1AcceptanceDatabasePair,
  buildStage1CleanAcceptanceManifest,
  classifyStage1CleanAcceptanceBaseline,
  hashStage1CleanAcceptanceManifest,
  isStage1CleanAcceptanceBaselineSafe,
  parseStage1AcceptanceDatabaseIdentity,
  parseStage1CleanAcceptanceSelection,
  redactStage1CleanAcceptanceError
} from "./stage1-clean-acceptance-baseline-core.mjs";

const VEHICLE_A = "11111111-1111-4111-8111-111111111111";
const VEHICLE_B = "22222222-2222-4222-8222-222222222222";
const HASH_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SNAPSHOT_AS_OF = new Date("2026-08-30T12:00:00.000Z");
const REQUIRED_CONTRACT_TEMPLATE_TYPES = [
  "SUBSCRIPTION_STANDARD",
  "DELIVERY_HANDOVER",
  "SUBSCRIPTION_EXTENSION"
];
const CONTRACT_TEMPLATE_FIXTURES = [
  [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    "SUBSCRIPTION_STANDARD",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
  ],
  [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    "DELIVERY_HANDOVER",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
  ],
  [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    "SUBSCRIPTION_EXTENSION",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"
  ]
];

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.message === code);
}

function selection(vehicleIds = [VEHICLE_A]) {
  return parseStage1CleanAcceptanceSelection({
    adminUsername: "keqi_119",
    customerPhone: "18616570212",
    vehicleIds
  });
}

function contractVersion([id, templateType, fileId], overrides = {}) {
  return {
    approvedAt: new Date("2026-01-02T08:00:00.000Z"),
    approvedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    businessType: "SUBSCRIPTION",
    contentTemplate: `content:${templateType}`,
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    deletedAt: null,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    fileId,
    id,
    status: "ACTIVE",
    templateName: templateType,
    templateType,
    updatedAt: new Date("2026-01-02T08:00:00.000Z"),
    updatedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    versionNo: "1.0",
    ...overrides
  };
}

function fileObject([, templateType, id], overrides = {}) {
  return {
    bucket: "stage1-contracts",
    contentSha256: "a".repeat(64),
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    id,
    mimeType: "application/pdf",
    objectKey: `contracts/${templateType.toLowerCase()}.pdf`,
    originalName: `${templateType.toLowerCase()}.pdf`,
    sizeBytes: 1n,
    uploadedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ...overrides
  };
}

function notificationTemplate(overrides = {}) {
  return {
    channel: "IN_APP",
    content: "Contract pending",
    createdAt: new Date("2026-01-01T08:00:00.000Z"),
    createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    deletedAt: null,
    description: null,
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    providerConfig: null,
    providerTemplateId: null,
    templateCode: "CONTRACT_PENDING_IN_APP",
    templateStatus: "ACTIVE",
    templateType: "CONTRACT_PENDING",
    title: "Contract pending",
    updatedAt: new Date("2026-01-01T08:00:00.000Z"),
    updatedBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    variables: null,
    ...overrides
  };
}

function addFictitiousTemplateFields(snapshot) {
  snapshot.templates.requiredContractTemplateCodes = [...REQUIRED_CONTRACT_TEMPLATE_TYPES];
  for (const row of snapshot.templates.contractVersions) row.templateCode = row.templateType;
  for (const row of snapshot.templates.notificationTemplates) {
    row.code = row.templateCode;
    row.status = row.templateStatus;
  }
  return snapshot;
}

function completeSnapshot(overrides = {}) {
  const snapshot = {
    asOf: SNAPSHOT_AS_OF,
    evaluationDate: new Date("2026-08-30T00:00:00.000Z"),
    access: {
      menus: [{ id: "menu-admin", status: "ACTIVE" }],
      permissions: [{ code: "acceptance:read", id: "permission-read", status: "ACTIVE" }],
      roleMenus: [{ menuId: "menu-admin", roleId: "role-admin" }],
      rolePermissions: [{ permissionId: "permission-read", roleId: "role-admin" }],
      roles: [{ code: "ADMIN", id: "role-admin", status: "ACTIVE" }],
      userRoles: [{ roleId: "role-admin", userId: "admin-user" }],
      users: [
        {
          id: "admin-user",
          status: "ACTIVE",
          username: "keqi_119"
        }
      ]
    },
    catalog: {
      benefitPackages: [
        {
          id: "benefit-1",
          productId: "product-1",
          productVersionId: "product-version-1",
          status: "ACTIVE"
        }
      ],
      depositRules: [{ grade: "A", id: "deposit-1", status: "ACTIVE" }],
      energyPackages: [
        {
          id: "energy-1",
          productId: "product-1",
          productVersionId: "product-version-1",
          status: "ACTIVE"
        }
      ],
      mileagePackages: [
        {
          id: "mileage-1",
          productId: "product-1",
          productVersionId: "product-version-1",
          status: "ACTIVE"
        }
      ],
      products: [{ id: "product-1", status: "ACTIVE" }],
      productVersions: [
        {
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "product-version-1",
          productId: "product-1",
          status: "ACTIVE"
        }
      ],
      productPriceRules: [
        {
          id: "price-rule-1",
          modelDefinitionId: "model-1",
          productVersionId: "product-version-1",
          status: "ACTIVE"
        }
      ],
      subscriptionPlans: [
        {
          benefitPackageId: "benefit-1",
          energyPackageId: "energy-1",
          id: "plan-1",
          mileagePackageId: "mileage-1",
          productId: "product-1",
          productVersionId: "product-version-1",
          status: "ACTIVE",
          vehiclePackageId: "package-1"
        }
      ],
      vehiclePackageModelMembers: [
        { id: "package-member-1", modelDefinitionId: "model-1", vehiclePackageId: "package-1" }
      ],
      vehiclePackages: [
        {
          id: "package-1",
          modelDefinitionId: "model-1",
          productId: "product-1",
          productVersionId: "product-version-1",
          status: "ACTIVE"
        }
      ]
    },
    customer: {
      customerAccounts: [
        {
          accountStatus: "ACTIVE",
          customerId: "customer-1",
          id: "customer-account-1",
          phone: "18616570212"
        }
      ],
      customerESignProviderAccounts: [
        {
          certBindingStatus: "BOUND",
          customerId: "customer-1",
          id: "esign-1",
          provider: "FADADA",
          providerOpenId: "provider-open-id-1",
          realNameStatus: "VERIFIED",
          registrationStatus: "REGISTERED"
        }
      ],
      customerIdentities: [{ customerId: "customer-1", id: "identity-1", realnameVerified: true }],
      customerProfiles: [{ customerId: "customer-1", id: "profile-1" }],
      customers: [{ id: "customer-1", status: "ACTIVE" }]
    },
    target: {
      forbiddenCounts: { auditLog: 0, subscriptionOrder: 0 },
      forbiddenCountKeys: ["auditLog", "subscriptionOrder"],
      schemaCanonical: true,
      tableCountKeys: ["customer", "user", "vehicle"],
      tableCounts: { customer: 0, user: 0, vehicle: 0 }
    },
    templates: {
      contractVersions: CONTRACT_TEMPLATE_FIXTURES.map((fixture) =>
        contractVersion(fixture, { approvedBy: "admin-user" })
      ),
      fileObjects: CONTRACT_TEMPLATE_FIXTURES.map((fixture) =>
        fileObject(fixture, { uploadedBy: "admin-user" })
      ),
      notificationTemplates: [notificationTemplate()],
      requiredContractTemplateTypes: REQUIRED_CONTRACT_TEMPLATE_TYPES,
      requiredNotificationTemplateCodes: ["CONTRACT_PENDING_IN_APP"]
    },
    vehicle: {
      assetOwners: [{ id: "owner-1", status: "ACTIVE" }],
      eligibilityEvidence: {
        [VEHICLE_A]: {
          activeAssetWorkOrderCount: 0,
          activeApplicationCount: 0,
          activeReviewReservationCount: 0,
          activeServiceCaseCount: 0,
          blockingRestrictionCount: 0,
          currentSalePricePositive: true,
          deliveryCount: 0,
          orderCount: 0,
          overlappingSubscriptionPeriodCount: 0,
          currentCommercialPolicyCount: 1,
          currentCompulsoryTrafficPolicyCount: 1,
          currentLicenseCount: 1,
          visibleRetainedListingPlanCount: 1,
          requiredDocumentsAndInsuranceReady: true,
          returnCount: 0,
          salePriceStatusEffective: true
        }
      },
      vehicles: [
        {
          currentSalePriceAmount: 100,
          id: VEHICLE_A,
          modelDefinitionId: "model-1",
          salePriceStatus: "EFFECTIVE",
          status: "AVAILABLE"
        }
      ],
      vehicleAssetCostProfiles: [{ id: "cost-profile-1", vehicleId: VEHICLE_A }],
      vehicleCostLedgerEntries: [
        {
          assetOwnerId: "owner-1",
          assetOwnerSnapshot: null,
          confirmedBy: "admin-user",
          contractId: null,
          customerId: "customer-1",
          evidenceId: null,
          evidenceSnapshot: null,
          id: "cost-ledger-1",
          orderId: null,
          responsibilitySnapshot: { responsibleParty: "PLATFORM" },
          reversalOfEntryId: null,
          vehicleId: VEHICLE_A,
          workOrderId: null
        },
        {
          assetOwnerId: "owner-1",
          assetOwnerSnapshot: { ownerNo: "OWNER-1" },
          confirmedBy: "admin-user",
          contractId: null,
          customerId: null,
          evidenceId: null,
          evidenceSnapshot: { source: "reversal" },
          id: "cost-ledger-2",
          orderId: null,
          responsibilitySnapshot: { responsibleParty: "PLATFORM" },
          reversalOfEntryId: "cost-ledger-1",
          vehicleId: VEHICLE_A,
          workOrderId: null
        }
      ],
      vehicleDocumentBatches: [
        { documentType: "VEHICLE_LICENSE", id: "document-batch-1", vehicleId: VEHICLE_A },
        {
          documentType: "COMPULSORY_INSURANCE_POLICY",
          id: "document-batch-compulsory",
          vehicleId: VEHICLE_A
        },
        {
          documentType: "COMMERCIAL_INSURANCE_POLICY",
          id: "document-batch-commercial",
          vehicleId: VEHICLE_A
        },
        {
          documentType: "VEHICLE_CONFIGURATION_SHEET",
          id: "document-batch-configuration",
          vehicleId: VEHICLE_A
        },
        {
          documentType: "VEHICLE_INSPECTION_REPORT",
          id: "document-batch-condition",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleDocuments: [
        {
          batchId: "document-batch-1",
          customerVisible: true,
          deletedAt: null,
          documentStatus: "ACTIVE",
          documentType: "VEHICLE_LICENSE",
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "document-1",
          policyId: null,
          vehicleId: VEHICLE_A
        },
        {
          batchId: "document-batch-compulsory",
          customerVisible: true,
          deletedAt: null,
          documentStatus: "ACTIVE",
          documentType: "COMPULSORY_INSURANCE_POLICY",
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "document-policy-compulsory",
          policyId: "policy-1",
          vehicleId: VEHICLE_A
        },
        {
          batchId: "document-batch-commercial",
          customerVisible: true,
          deletedAt: null,
          documentStatus: "ACTIVE",
          documentType: "COMMERCIAL_INSURANCE_POLICY",
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "document-policy-commercial",
          policyId: "policy-2",
          vehicleId: VEHICLE_A
        },
        {
          batchId: "document-batch-configuration",
          bucket: "acceptance",
          customerVisible: true,
          deletedAt: null,
          documentStatus: "ACTIVE",
          documentType: "VEHICLE_CONFIGURATION_SHEET",
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "document-configuration",
          mimeType: "image/jpeg",
          objectKey: "vehicle/configuration.jpg",
          policyId: null,
          vehicleId: VEHICLE_A
        },
        {
          batchId: "document-batch-condition",
          bucket: "acceptance",
          customerVisible: true,
          deletedAt: null,
          documentStatus: "ACTIVE",
          documentType: "VEHICLE_INSPECTION_REPORT",
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "document-condition",
          mimeType: "image/png",
          objectKey: "vehicle/condition.png",
          policyId: null,
          vehicleId: VEHICLE_A
        }
      ],
      vehicleInsuranceCoverages: [
        { deletedAt: null, id: "coverage-1", policyId: "policy-1" },
        { deletedAt: null, id: "coverage-2", policyId: "policy-2" }
      ],
      vehicleInsurancePolicies: [
        {
          deletedAt: null,
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "policy-1",
          policyStatus: "ACTIVE",
          policyType: "COMPULSORY_TRAFFIC",
          vehicleId: VEHICLE_A
        },
        {
          deletedAt: null,
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "policy-2",
          policyStatus: "ACTIVE",
          policyType: "COMMERCIAL",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleListingMedia: [
        {
          customerVisible: true,
          deletedAt: null,
          id: "media-1",
          listingProfileId: "listing-1",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleListingPlans: [
        {
          id: "listing-plan-1",
          listingProfileId: "listing-1",
          subscriptionPlanId: "plan-1",
          deletedAt: null,
          visible: true,
          vehicleId: VEHICLE_A
        }
      ],
      vehicleListingProfiles: [
        { id: "listing-1", listingStatus: "PUBLISHED", portalVisible: true, vehicleId: VEHICLE_A }
      ],
      vehicleListingSourceBindings: [
        {
          documentId: "document-configuration",
          id: "source-binding-configuration",
          section: "CONFIGURATION_SHEET",
          vehicleId: VEHICLE_A
        },
        {
          documentId: "document-condition",
          id: "source-binding-condition",
          section: "CONDITION_REPORT",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleModelDefinitions: [{ enabled: true, id: "model-1", portalVisible: true }],
      vehicleOwnershipPeriods: [
        {
          assetOwnerId: "owner-1",
          endedAt: null,
          endReason: null,
          id: "ownership-1",
          startReason: "INITIAL_ACQUISITION",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleSalePriceHistories: [
        {
          afterSalePriceAmount: 100,
          effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
          effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
          id: "sale-price-1",
          vehicleId: VEHICLE_A
        }
      ]
    }
  };
  return deepMerge(snapshot, overrides);
}

function deepMerge(target, source) {
  if (Array.isArray(source) || source === null || typeof source !== "object") return source;
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = deepMerge(target?.[key], value);
  }
  return result;
}

test("selection rejects identities outside the fixed acceptance pair", () => {
  expectCode(
    () =>
      parseStage1CleanAcceptanceSelection({
        adminUsername: "other",
        customerPhone: "18616570212",
        vehicleIds: []
      }),
    "IDENTITY_SELECTION_NOT_ALLOWED"
  );
  expectCode(
    () =>
      parseStage1CleanAcceptanceSelection({
        adminUsername: "keqi_119",
        customerPhone: "13800000000",
        vehicleIds: []
      }),
    "IDENTITY_SELECTION_NOT_ALLOWED"
  );
});

test("selection normalizes UUIDs by lexical order and removes exact duplicates", () => {
  assert.deepEqual(selection([VEHICLE_B, VEHICLE_A, VEHICLE_A]), {
    adminUsername: "keqi_119",
    customerPhone: "18616570212",
    vehicleIds: [VEHICLE_A, VEHICLE_B]
  });
});

test("selection rejects blank and malformed vehicle UUIDs", () => {
  for (const vehicleIds of [[""], ["  "], ["not-a-uuid"]]) {
    expectCode(
      () =>
        parseStage1CleanAcceptanceSelection({
          adminUsername: "keqi_119",
          customerPhone: "18616570212",
          vehicleIds
        }),
      "VEHICLE_ID_INVALID"
    );
  }
});

test("database identity exposes only comparable non-secret fields", () => {
  assert.deepEqual(
    parseStage1AcceptanceDatabaseIdentity(
      "postgresql://operator:super-secret@db.internal:5544/subscription_saas_staging?sslmode=verify-full"
    ),
    {
      databaseName: "subscription_saas_staging",
      hostname: "db.internal",
      port: "5544",
      protocol: "postgresql:",
      tlsPolicy: "verify-full",
      username: "operator"
    }
  );
});

test("database pair rejects unsafe identities without echoing URLs or passwords", () => {
  const source =
    "postgresql://operator:source-password@db.internal:5432/subscription_saas_staging?sslmode=require";
  const target =
    "postgresql://operator:target-password@db.internal:5432/subscription_saas_staging_acceptance_20260830?sslmode=require";
  const cases = [
    [
      source.replace("subscription_saas_staging?", "other?"),
      target,
      {},
      "SOURCE_DATABASE_NOT_ALLOWED"
    ],
    [source, target.replace("acceptance_20260830", "wrong"), {}, "TARGET_DATABASE_NOT_ALLOWED"],
    [source, source, { allowedHostname: "db.internal" }, "DATABASE_PAIR_SAME_DATABASE"],
    [
      source,
      target.replace("db.internal", "other.internal"),
      { allowedHostname: "db.internal" },
      "DATABASE_HOSTNAME_MISMATCH"
    ],
    [source, target, { allowedHostname: "other.internal" }, "DATABASE_HOSTNAME_NOT_ALLOWED"],
    [
      source,
      target.replace(":5432", ":5433"),
      { allowedHostname: "db.internal" },
      "DATABASE_PORT_MISMATCH"
    ],
    [
      source,
      target.replace("operator:", "reader:"),
      { allowedHostname: "db.internal" },
      "DATABASE_USERNAME_MISMATCH"
    ],
    [
      source,
      target.replace("sslmode=require", "sslmode=disable"),
      { allowedHostname: "db.internal" },
      "DATABASE_TLS_POLICY_MISMATCH"
    ],
    [source, target, {}, "DATABASE_ALLOWED_HOSTNAME_REQUIRED"]
  ];

  for (const [sourceUrl, targetUrl, options, code] of cases) {
    assert.throws(
      () => assertStage1AcceptanceDatabasePair(sourceUrl, targetUrl, options),
      (error) =>
        error?.message === code &&
        !error.message.includes("password") &&
        !error.message.includes(sourceUrl) &&
        !error.message.includes(targetUrl)
    );
  }
});

test("classification requires an explicit vehicle selection and never chooses a candidate", () => {
  const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection([]));
  assert.equal(result.safeToApply, false);
  assert.deepEqual(result.rows.vehicle.vehicles, []);
  assert.deepEqual(
    result.exceptions.map(({ code }) => code),
    ["VEHICLE_SELECTION_REQUIRED"]
  );
});

test("classification closes the complete fixed baseline and marks it safe", () => {
  const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(isStage1CleanAcceptanceBaselineSafe(result), true);
  assert.equal(result.safeToApply, true, JSON.stringify(result.exceptions));
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.rows.access.users[0].id, "admin-user");
  assert.equal(result.rows.customer.customers[0].id, "customer-1");
  assert.equal(result.rows.vehicle.vehicles[0].id, VEHICLE_A);
  assert.deepEqual(result.targetForbiddenCounts, { auditLog: 0, subscriptionOrder: 0 });
});

test("whitelist cross-domain user foreign keys must resolve to the retained administrator", () => {
  const mutations = [
    (snapshot) => (snapshot.customer.customers[0].ownerUserId = "unretained-user"),
    (snapshot) => (snapshot.catalog.productVersions[0].approvedBy = "unretained-user"),
    (snapshot) => (snapshot.templates.contractVersions[0].approvedBy = "unretained-user"),
    (snapshot) => (snapshot.templates.fileObjects[0].uploadedBy = "unretained-user"),
    (snapshot) => (snapshot.vehicle.assetOwners[0].createdBy = "unretained-user"),
    (snapshot) => (snapshot.vehicle.assetOwners[0].updatedBy = "unretained-user"),
    (snapshot) =>
      (snapshot.vehicle.vehicleOwnershipPeriods[0].startConfirmedBy = "unretained-user"),
    (snapshot) => (snapshot.vehicle.vehicleOwnershipPeriods[0].endConfirmedBy = "unretained-user"),
    (snapshot) => (snapshot.vehicle.vehicleOwnershipPeriods[0].createdBy = "unretained-user")
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "WHITELIST_REFERENCE_NOT_CLOSED"));
  }
});

test("cost ledger closes retained customer owner user and reversal endpoints and forbids historical FK domains", () => {
  const baseline = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(baseline.safeToApply, true);
  assert.deepEqual(
    baseline.rows.vehicle.vehicleCostLedgerEntries.map(({ id, reversalOfEntryId }) => ({
      id,
      reversalOfEntryId
    })),
    [
      { id: "cost-ledger-1", reversalOfEntryId: null },
      { id: "cost-ledger-2", reversalOfEntryId: "cost-ledger-1" }
    ]
  );

  const mutations = [
    (row) => (row.customerId = "unretained-customer"),
    (row) => (row.assetOwnerId = "unretained-owner"),
    (row) => (row.confirmedBy = "unretained-user"),
    (row) => (row.reversalOfEntryId = "unretained-ledger"),
    (row) => (row.orderId = "forbidden-order"),
    (row) => (row.contractId = "forbidden-contract"),
    (row) => (row.workOrderId = "forbidden-work-order"),
    (row) => (row.evidenceId = "forbidden-evidence")
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(snapshot.vehicle.vehicleCostLedgerEntries[0]);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "WHITELIST_REFERENCE_NOT_CLOSED"));
  }
});

test("classification retains the real Prisma catalog, customer, and vehicle whitelist closures losslessly", () => {
  const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(result.safeToApply, true);
  assert.equal("depositRuleId" in result.rows.catalog.productVersions[0], false);
  assert.deepEqual(Object.keys(result.rows.catalog).sort(), [
    "benefitPackages",
    "depositRules",
    "energyPackages",
    "mileagePackages",
    "productPriceRules",
    "productVersions",
    "products",
    "subscriptionPlans",
    "vehiclePackageModelMembers",
    "vehiclePackages"
  ]);
  assert.equal(result.rows.customer.customerAccounts[0].accountStatus, "ACTIVE");
  assert.equal(
    result.rows.customer.customerESignProviderAccounts[0].providerOpenId,
    "provider-open-id-1"
  );
  assert.equal("providerAccountId" in result.rows.customer.customerESignProviderAccounts[0], false);
  assert.deepEqual(Object.keys(result.rows.vehicle).sort(), [
    "assetOwners",
    "vehicleAssetCostProfiles",
    "vehicleCostLedgerEntries",
    "vehicleDocumentBatches",
    "vehicleDocuments",
    "vehicleInsuranceCoverages",
    "vehicleInsurancePolicies",
    "vehicleListingMedia",
    "vehicleListingPlans",
    "vehicleListingProfiles",
    "vehicleListingSourceBindings",
    "vehicleModelDefinitions",
    "vehicleOwnershipPeriods",
    "vehicleSalePriceHistories",
    "vehicles"
  ]);
  assert.equal(result.rows.vehicle.vehicleInsuranceCoverages[0].policyId, "policy-1");
  assert.equal("assetOwnerId" in result.rows.vehicle.vehicles[0], false);
  assert.equal("listingProfileId" in result.rows.vehicle.vehicles[0], false);
  assert.equal(result.rows.catalog.depositRules[0].grade, "A");
});

test("catalog accepts a null benefit-package FK and requires exactly one match for a non-null FK", () => {
  const withoutBenefit = completeSnapshot();
  withoutBenefit.catalog.subscriptionPlans[0].benefitPackageId = null;
  const nullableResult = classifyStage1CleanAcceptanceBaseline(withoutBenefit, selection());
  assert.equal(nullableResult.safeToApply, true);
  assert.equal(nullableResult.rows.catalog.subscriptionPlans[0].benefitPackageId, null);

  for (const benefitPackages of [
    [],
    [
      {
        id: "benefit-1",
        productId: "product-1",
        productVersionId: "product-version-1",
        status: "ACTIVE"
      },
      {
        id: "benefit-1",
        productId: "product-1",
        productVersionId: "product-version-1",
        status: "ACTIVE"
      }
    ]
  ]) {
    const result = classifyStage1CleanAcceptanceBaseline(
      completeSnapshot({ catalog: { benefitPackages } }),
      selection()
    );
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CATALOG_REFERENCE_NOT_CLOSED"));
  }
});

test("catalog model references close through the union of package, member, price-rule, and selected-vehicle models", () => {
  const snapshot = completeSnapshot();
  snapshot.catalog.vehiclePackages[0].modelDefinitionId = "model-package";
  snapshot.catalog.vehiclePackageModelMembers[0].modelDefinitionId = "model-member";
  snapshot.catalog.productPriceRules[0].modelDefinitionId = "model-price";
  snapshot.vehicle.vehicles[0].modelDefinitionId = "model-member";
  snapshot.vehicle.vehicleModelDefinitions.push(
    { deletedAt: null, enabled: true, id: "model-package", portalVisible: true },
    { deletedAt: null, enabled: true, id: "model-member", portalVisible: true },
    { deletedAt: null, enabled: true, id: "model-price", portalVisible: true }
  );

  const selected = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(selected.safeToApply, true);
  assert.deepEqual(
    selected.rows.vehicle.vehicleModelDefinitions.map(({ id }) => id),
    ["model-member", "model-package", "model-price"]
  );

  const discovery = classifyStage1CleanAcceptanceBaseline(snapshot, selection([]));
  assert.equal(discovery.safeToApply, false);
  assert.deepEqual(
    discovery.exceptions.map(({ code }) => code),
    ["VEHICLE_SELECTION_REQUIRED"]
  );
  assert.deepEqual(
    discovery.rows.vehicle.vehicleModelDefinitions.map(({ id }) => id),
    ["model-member", "model-package", "model-price"]
  );

  for (const mutate of [
    (value) => value.vehicle.vehicleModelDefinitions.splice(1, 1),
    (value) => (value.vehicle.vehicleModelDefinitions[1].enabled = false),
    (value) => (value.vehicle.vehicleModelDefinitions[1].portalVisible = false),
    (value) =>
      (value.vehicle.vehicleModelDefinitions[1].deletedAt = new Date("2026-08-01T00:00:00.000Z"))
  ]) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    const result = classifyStage1CleanAcceptanceBaseline(invalid, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CATALOG_REFERENCE_NOT_CLOSED"));
  }
});

test("administrator access covers every active permission and menu with a complete acyclic parent chain", () => {
  const completeAccess = {
    menus: [
      { deletedAt: null, id: "menu-child", parentId: "menu-root", status: "ACTIVE" },
      { deletedAt: null, id: "menu-root", parentId: null, status: "ACTIVE" }
    ],
    permissions: [
      { deletedAt: null, id: "permission-a", status: "ACTIVE" },
      { deletedAt: null, id: "permission-b", status: "ACTIVE" }
    ],
    roleMenus: [
      { deletedAt: null, menuId: "menu-child", roleId: "role-admin" },
      { deletedAt: null, menuId: "menu-root", roleId: "role-admin" }
    ],
    rolePermissions: [
      { deletedAt: null, permissionId: "permission-a", roleId: "role-admin" },
      { deletedAt: null, permissionId: "permission-b", roleId: "role-admin" }
    ],
    roles: [{ code: "ADMIN", deletedAt: null, id: "role-admin", status: "ACTIVE" }],
    userRoles: [{ deletedAt: null, roleId: "role-admin", userId: "admin-user" }],
    users: [{ deletedAt: null, id: "admin-user", status: "ACTIVE", username: "keqi_119" }]
  };
  const valid = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ access: completeAccess }),
    selection()
  );
  assert.equal(valid.safeToApply, true);
  assert.deepEqual(
    valid.rows.access.menus.map(({ id }) => id),
    ["menu-child", "menu-root"]
  );
  assert.deepEqual(
    valid.rows.access.permissions.map(({ id }) => id),
    ["permission-a", "permission-b"]
  );

  const cases = [];
  const missingPermissionGrant = structuredClone(completeAccess);
  missingPermissionGrant.rolePermissions.pop();
  cases.push(missingPermissionGrant);
  const missingParent = structuredClone(completeAccess);
  missingParent.menus.pop();
  missingParent.roleMenus.pop();
  cases.push(missingParent);
  const inactiveParent = structuredClone(completeAccess);
  inactiveParent.menus[1].status = "INACTIVE";
  inactiveParent.roleMenus.pop();
  cases.push(inactiveParent);
  const cyclicParents = structuredClone(completeAccess);
  cyclicParents.menus[1].parentId = "menu-child";
  cases.push(cyclicParents);
  for (const access of cases) {
    const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot({ access }), selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "ADMIN_ROLE_INCOMPLETE"));
  }
});

test("vehicle eligibility requires a published and portal-visible listing profile", () => {
  for (const mutate of [
    (profile) => (profile.listingStatus = "DRAFT"),
    (profile) => (profile.portalVisible = false),
    (profile) => (profile.deletedAt = new Date("2026-08-01T00:00:00.000Z"))
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot.vehicle.vehicleListingProfiles[0]);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle eligibility consumes every process, document, and insurance fact", () => {
  const mutations = [
    ["activeApplicationCount", 1],
    ["activeAssetWorkOrderCount", 1],
    ["activeReviewReservationCount", 1],
    ["activeServiceCaseCount", 1],
    ["blockingRestrictionCount", 1],
    ["deliveryCount", 1],
    ["orderCount", 1],
    ["overlappingSubscriptionPeriodCount", 1],
    ["currentCommercialPolicyCount", 0],
    ["currentCompulsoryTrafficPolicyCount", 0],
    ["currentLicenseCount", 0],
    ["requiredDocumentsAndInsuranceReady", false],
    ["returnCount", 1],
    ["visibleRetainedListingPlanCount", 0]
  ];
  for (const [field, value] of mutations) {
    const snapshot = completeSnapshot();
    snapshot.vehicle.eligibilityEvidence[VEHICLE_A][field] = value;
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false, field);
    assert.ok(
      result.exceptions.some(({ code }) => code === "VEHICLE_NOT_ELIGIBLE"),
      field
    );
  }
});

test("vehicle eligibility requires one current policy of each production resolver type with coverage", () => {
  for (const mutate of [
    (snapshot) => snapshot.vehicle.vehicleInsurancePolicies.splice(1, 1),
    (snapshot) => snapshot.vehicle.vehicleInsurancePolicies.splice(0, 1),
    (snapshot) => snapshot.vehicle.vehicleInsuranceCoverages.splice(1, 1),
    (snapshot) =>
      snapshot.vehicle.vehicleInsurancePolicies.push({
        ...snapshot.vehicle.vehicleInsurancePolicies[1],
        id: "policy-commercial-duplicate"
      })
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle closure requires a visible retained compatible plan bound to the published profile", () => {
  for (const mutate of [
    (snapshot) => snapshot.vehicle.vehicleListingPlans.splice(0),
    (snapshot) => (snapshot.vehicle.vehicleListingPlans[0].visible = false),
    (snapshot) => (snapshot.vehicle.vehicleListingPlans[0].listingProfileId = null),
    (snapshot) => (snapshot.vehicle.vehicleListingPlans[0].subscriptionPlanId = "missing-plan")
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle date-only windows include the evaluation date even when snapshot asOf is midday", () => {
  const snapshot = completeSnapshot();
  snapshot.asOf = new Date("2026-08-30T23:59:59.999Z");
  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(result.safeToApply, true, JSON.stringify(result.exceptions));

  for (const mutate of [
    (item) => (item.effectiveFrom = new Date("2026-08-31T00:00:00.000Z")),
    (item) => (item.effectiveTo = new Date("2026-08-29T00:00:00.000Z"))
  ]) {
    const changed = completeSnapshot();
    mutate(changed.vehicle.vehicleInsurancePolicies[0]);
    const changedResult = classifyStage1CleanAcceptanceBaseline(changed, selection());
    assert.equal(changedResult.safeToApply, false);
  }
});

test("catalog rejects ProductVersion outside the inclusive evaluation date", () => {
  const boundary = completeSnapshot();
  boundary.asOf = new Date("2026-08-30T23:59:59.999Z");
  assert.equal(classifyStage1CleanAcceptanceBaseline(boundary, selection()).safeToApply, true);

  for (const mutate of [
    (row) => (row.effectiveFrom = new Date("2026-08-31T00:00:00.000Z")),
    (row) => (row.effectiveTo = new Date("2026-08-29T00:00:00.000Z"))
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot.catalog.productVersions[0]);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CATALOG_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle classifier rejects non-minimal or superseded row closure", () => {
  const mutations = [
    (snapshot) =>
      snapshot.vehicle.vehicleListingMedia.push({
        customerVisible: false,
        deletedAt: null,
        id: "hidden-media",
        listingProfileId: "listing-1",
        vehicleId: VEHICLE_A
      }),
    (snapshot) =>
      snapshot.vehicle.vehicleDocuments.push({
        ...snapshot.vehicle.vehicleDocuments[0],
        customerVisible: false,
        id: "noncustomer-document"
      }),
    (snapshot) =>
      snapshot.vehicle.vehicleSalePriceHistories.push({
        ...snapshot.vehicle.vehicleSalePriceHistories[0],
        effectiveTo: new Date("2026-08-29T00:00:00.000Z"),
        id: "superseded-price"
      })
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle resolves its active owner through exactly one current ownership period", () => {
  const baseline = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(baseline.safeToApply, true);
  assert.deepEqual(
    baseline.rows.vehicle.vehicleOwnershipPeriods.map(({ id }) => id),
    ["ownership-1"]
  );
  assert.deepEqual(
    baseline.rows.vehicle.assetOwners.map(({ id }) => id),
    ["owner-1"]
  );

  const closedPeriod = completeSnapshot();
  closedPeriod.vehicle.vehicleOwnershipPeriods[0].endedAt = new Date("2026-08-29T00:00:00.000Z");
  closedPeriod.vehicle.vehicleOwnershipPeriods[0].endReason = "OWNERSHIP_TRANSFER";
  const duplicateCurrent = completeSnapshot();
  duplicateCurrent.vehicle.vehicleOwnershipPeriods.push({
    assetOwnerId: "owner-1",
    endedAt: null,
    endReason: null,
    id: "ownership-2",
    startReason: "OWNERSHIP_TRANSFER",
    vehicleId: VEHICLE_A
  });
  for (const snapshot of [closedPeriod, duplicateCurrent]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle profile is resolved by its unique vehicle FK", () => {
  const duplicateProfile = completeSnapshot();
  duplicateProfile.vehicle.vehicleListingProfiles.push({
    id: "listing-2",
    listingStatus: "PUBLISHED",
    portalVisible: true,
    vehicleId: VEHICLE_A
  });
  const result = classifyStage1CleanAcceptanceBaseline(duplicateProfile, selection());
  assert.equal(result.safeToApply, false);
  assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
});

test("vehicle media and plans must bind the published profile", () => {
  const withoutProfileReferences = completeSnapshot({
    vehicle: {
      vehicleListingMedia: [
        {
          customerVisible: true,
          deletedAt: null,
          id: "media-1",
          listingProfileId: "listing-1",
          vehicleId: VEHICLE_A
        }
      ],
      vehicleListingPlans: [
        {
          id: "listing-plan-1",
          listingProfileId: "listing-1",
          subscriptionPlanId: "plan-1",
          deletedAt: null,
          visible: true,
          vehicleId: VEHICLE_A
        }
      ]
    }
  });
  const nullableResult = classifyStage1CleanAcceptanceBaseline(
    withoutProfileReferences,
    selection()
  );
  assert.equal(nullableResult.safeToApply, true);
  assert.deepEqual(
    nullableResult.rows.vehicle.vehicleListingMedia.map(({ id }) => id),
    ["media-1"]
  );
  assert.deepEqual(
    nullableResult.rows.vehicle.vehicleListingPlans.map(({ id }) => id),
    ["listing-plan-1"]
  );

  for (const relation of ["vehicleListingMedia", "vehicleListingPlans"]) {
    const mismatched = completeSnapshot();
    mismatched.vehicle[relation][0].listingProfileId = "listing-other";
    const result = classifyStage1CleanAcceptanceBaseline(mismatched, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle documents allow null batches and require exact non-null batch and policy closure", () => {
  const batchless = completeSnapshot();
  batchless.vehicle.vehicleDocuments[0].batchId = null;
  batchless.vehicle.vehicleDocumentBatches = batchless.vehicle.vehicleDocumentBatches.filter(
    ({ id }) => id !== "document-batch-1"
  );
  const batchlessResult = classifyStage1CleanAcceptanceBaseline(batchless, selection());
  assert.equal(batchlessResult.safeToApply, true);
  assert.equal(batchlessResult.rows.vehicle.vehicleDocuments[0].batchId, null);

  for (const mutate of [
    (snapshot) => (snapshot.vehicle.vehicleDocuments[0].batchId = "missing-batch"),
    (snapshot) =>
      snapshot.vehicle.vehicleDocumentBatches.push({
        documentType: "VEHICLE_LICENSE",
        id: "document-batch-1",
        vehicleId: VEHICLE_A
      }),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[0].policyId = "missing-policy")
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle source bindings require their document to be in the selected vehicle closure", () => {
  for (const documentId of [undefined, "missing-document"]) {
    const snapshot = completeSnapshot();
    snapshot.vehicle.vehicleListingSourceBindings[0].documentId = documentId;
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle insurance documents close only through one matching retained policy document", () => {
  const mutations = [
    (snapshot) => (snapshot.vehicle.vehicleDocuments[1].policyId = null),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[1].policyId = "policy-2"),
    (snapshot) =>
      snapshot.vehicle.vehicleDocuments.push({
        ...snapshot.vehicle.vehicleDocuments[1],
        id: "document-policy-compulsory-duplicate"
      })
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle source bindings enforce production section mapping and supported image documents", () => {
  const mutations = [
    (snapshot) => (snapshot.vehicle.vehicleListingSourceBindings[0].section = "CONDITION_REPORT"),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[3].mimeType = "application/pdf"),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[3].bucket = null),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[3].objectKey = null),
    (snapshot) => (snapshot.vehicle.vehicleDocuments[3].vehicleId = VEHICLE_B)
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle listing plans and insurance coverages close their remaining required FKs", () => {
  const missingSubscriptionPlan = completeSnapshot();
  missingSubscriptionPlan.vehicle.vehicleListingPlans[0].subscriptionPlanId = "missing-plan";
  const missingCoveragePolicy = completeSnapshot();
  missingCoveragePolicy.vehicle.vehicleInsuranceCoverages[0].policyId = "missing-policy";
  for (const snapshot of [missingSubscriptionPlan, missingCoveragePolicy]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));
  }
});

test("vehicle closure keeps each explicitly selected vehicle and its one-to-many rows", () => {
  const snapshot = completeSnapshot();
  snapshot.vehicle.eligibilityEvidence[VEHICLE_B] = {
    activeApplicationCount: 0,
    activeAssetWorkOrderCount: 0,
    activeReviewReservationCount: 0,
    activeServiceCaseCount: 0,
    blockingRestrictionCount: 0,
    currentSalePricePositive: true,
    currentCommercialPolicyCount: 1,
    currentCompulsoryTrafficPolicyCount: 1,
    currentLicenseCount: 1,
    deliveryCount: 0,
    orderCount: 0,
    overlappingSubscriptionPeriodCount: 0,
    requiredDocumentsAndInsuranceReady: true,
    returnCount: 0,
    salePriceStatusEffective: true,
    visibleRetainedListingPlanCount: 1
  };
  snapshot.vehicle.vehicles.push({
    currentSalePriceAmount: 200,
    id: VEHICLE_B,
    modelDefinitionId: "model-1",
    salePriceStatus: "EFFECTIVE",
    status: "AVAILABLE"
  });
  snapshot.vehicle.vehicleListingProfiles.push({
    id: "listing-2",
    listingStatus: "PUBLISHED",
    portalVisible: true,
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleListingMedia.push({
    customerVisible: true,
    deletedAt: null,
    id: "media-2",
    listingProfileId: "listing-2",
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleListingPlans.push({
    deletedAt: null,
    id: "listing-plan-2",
    listingProfileId: "listing-2",
    subscriptionPlanId: "plan-1",
    visible: true,
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleDocumentBatches.push({
    documentType: "VEHICLE_LICENSE",
    id: "document-batch-2",
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleDocuments.push({
    batchId: "document-batch-2",
    customerVisible: true,
    deletedAt: null,
    documentStatus: "ACTIVE",
    documentType: "VEHICLE_LICENSE",
    effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
    effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
    id: "document-2",
    policyId: null,
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleDocuments.push(
    {
      batchId: null,
      customerVisible: true,
      deletedAt: null,
      documentStatus: "ACTIVE",
      documentType: "COMPULSORY_INSURANCE_POLICY",
      effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
      id: "document-policy-b1",
      policyId: "policy-b1",
      vehicleId: VEHICLE_B
    },
    {
      batchId: null,
      customerVisible: true,
      deletedAt: null,
      documentStatus: "ACTIVE",
      documentType: "COMMERCIAL_INSURANCE_POLICY",
      effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
      id: "document-policy-b2",
      policyId: "policy-b2",
      vehicleId: VEHICLE_B
    }
  );
  snapshot.vehicle.vehicleInsurancePolicies.push(
    {
      deletedAt: null,
      effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
      id: "policy-b1",
      policyStatus: "ACTIVE",
      policyType: "COMPULSORY_TRAFFIC",
      vehicleId: VEHICLE_B
    },
    {
      deletedAt: null,
      effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
      effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
      id: "policy-b2",
      policyStatus: "ACTIVE",
      policyType: "COMMERCIAL",
      vehicleId: VEHICLE_B
    }
  );
  snapshot.vehicle.vehicleInsuranceCoverages.push(
    { deletedAt: null, id: "coverage-b1", policyId: "policy-b1" },
    { deletedAt: null, id: "coverage-b2", policyId: "policy-b2" }
  );
  snapshot.vehicle.vehicleSalePriceHistories.push({
    afterSalePriceAmount: 200,
    effectiveFrom: new Date("2026-08-30T00:00:00.000Z"),
    effectiveTo: new Date("2026-08-30T00:00:00.000Z"),
    id: "sale-price-2",
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleOwnershipPeriods.push({
    assetOwnerId: "owner-1",
    endedAt: null,
    endReason: null,
    id: "ownership-2",
    startReason: "INITIAL_ACQUISITION",
    vehicleId: VEHICLE_B
  });
  snapshot.vehicle.vehicleAssetCostProfiles.push({ id: "cost-profile-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleCostLedgerEntries.push({
    assetOwnerId: "owner-1",
    assetOwnerSnapshot: null,
    confirmedBy: "admin-user",
    contractId: null,
    customerId: "customer-1",
    evidenceId: null,
    evidenceSnapshot: null,
    id: "cost-ledger-3",
    orderId: null,
    responsibilitySnapshot: { responsibleParty: "PLATFORM" },
    reversalOfEntryId: null,
    vehicleId: VEHICLE_B,
    workOrderId: null
  });

  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection([VEHICLE_A, VEHICLE_B]));
  assert.equal(result.safeToApply, true);
  assert.deepEqual(
    result.rows.vehicle.vehicles.map(({ id }) => id),
    [VEHICLE_A, VEHICLE_B]
  );
  assert.deepEqual(
    result.rows.vehicle.assetOwners.map(({ id }) => id),
    ["owner-1"]
  );
  assert.deepEqual(
    result.rows.vehicle.vehicleModelDefinitions.map(({ id }) => id),
    ["model-1"]
  );
  assert.deepEqual(
    result.rows.vehicle.vehicleInsuranceCoverages.map(({ id }) => id),
    ["coverage-1", "coverage-2", "coverage-b1", "coverage-b2"]
  );
});

test("classification blocks exceptions, ambiguity, target rows, schema drift, and incomplete vehicle closure", () => {
  const cases = [
    [completeSnapshot({ access: { users: [] } }), "ADMIN_NOT_FOUND"],
    [
      completeSnapshot({
        access: {
          users: [
            { id: "admin-2", status: "ACTIVE", username: "keqi_119" },
            { id: "admin-1", status: "ACTIVE", username: "keqi_119" }
          ]
        }
      }),
      "ADMIN_AMBIGUOUS"
    ],
    [completeSnapshot({ target: { tableCounts: { user: 1 } } }), "TARGET_NOT_EMPTY"],
    [completeSnapshot({ target: { schemaCanonical: false } }), "TARGET_SCHEMA_NOT_CANONICAL"],
    [
      completeSnapshot({ target: { forbiddenCounts: { auditLog: 1 } } }),
      "FORBIDDEN_DOMAIN_NOT_EMPTY"
    ],
    [completeSnapshot({ vehicle: { vehicleListingProfiles: [] } }), "VEHICLE_REFERENCE_NOT_CLOSED"]
  ];
  for (const [snapshot, code] of cases) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some((exception) => exception.code === code));
  }
});

test("classification fails closed when target count evidence is missing, partial, extra, or malformed", () => {
  const cases = [
    (snapshot) => delete snapshot.target.forbiddenCountKeys,
    (snapshot) => (snapshot.target.tableCountKeys = ["customer", "user"]),
    (snapshot) => (snapshot.target.forbiddenCounts.extra = 0),
    (snapshot) => (snapshot.target.tableCounts.customer = Number.NaN)
  ];
  for (const mutate of cases) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.equal(isStage1CleanAcceptanceBaselineSafe(result), false);
    assert.ok(result.exceptions.some(({ code }) => code === "TARGET_COUNT_EVIDENCE_INVALID"));
  }
});

test("classification requires exactly the three real contract template types", () => {
  const invalidRequiredSets = [
    [],
    ["SUBSCRIPTION_STANDARD", "DELIVERY_HANDOVER"],
    [
      "SUBSCRIPTION_STANDARD",
      "DELIVERY_HANDOVER",
      "SUBSCRIPTION_EXTENSION",
      "SUBSCRIPTION_RENEWAL",
      "VEHICLE_SWAP",
      "EARLY_TERMINATION",
      "MANAGED_OTHER"
    ]
  ];
  for (const requiredContractTemplateTypes of invalidRequiredSets) {
    const result = classifyStage1CleanAcceptanceBaseline(
      addFictitiousTemplateFields(
        completeSnapshot({ templates: { requiredContractTemplateTypes } })
      ),
      selection()
    );
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CONTRACT_TEMPLATE_REQUIRED"));
  }
});

test("classification uses real ContractVersion fields and returns raw scalar rows", () => {
  const snapshot = completeSnapshot();
  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(result.safeToApply, true);
  assert.deepEqual(result.rows.templates.contractVersions, snapshot.templates.contractVersions);
  assert.deepEqual(
    result.rows.templates.contractVersions.map(({ templateType }) => templateType).sort(),
    [...REQUIRED_CONTRACT_TEMPLATE_TYPES].sort()
  );
  assert.equal("templateCode" in result.rows.templates.contractVersions[0], false);
});

test("fictitious ContractVersion.templateCode cannot satisfy a required type", () => {
  const snapshot = addFictitiousTemplateFields(completeSnapshot());
  delete snapshot.templates.contractVersions[0].templateType;
  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(result.safeToApply, false);
  assert.ok(result.exceptions.some(({ code }) => code === "CONTRACT_TEMPLATE_REQUIRED"));
});

test("classification requires exactly one usable ContractVersion per required type", () => {
  const missing = completeSnapshot();
  missing.templates.contractVersions.shift();
  const duplicate = completeSnapshot();
  duplicate.templates.contractVersions.push(
    contractVersion(
      [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        "SUBSCRIPTION_STANDARD",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"
      ],
      { versionNo: "2.0" }
    )
  );
  for (const [snapshot, code] of [
    [missing, "CONTRACT_TEMPLATE_REQUIRED"],
    [duplicate, "CONTRACT_TEMPLATE_AMBIGUOUS"]
  ]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some((exception) => exception.code === code));
  }
});

test("inactive, deleted, unapproved, wrong-business, and out-of-window contract versions are unusable", () => {
  const mutations = [
    (row) => (row.status = "INACTIVE"),
    (row) => (row.deletedAt = new Date("2026-08-01T00:00:00.000Z")),
    (row) => delete row.deletedAt,
    (row) => (row.approvedAt = null),
    (row) => (row.approvedAt = new Date("2026-08-31T00:00:00.000Z")),
    (row) => (row.approvedBy = null),
    (row) => (row.businessType = "RENT_TO_OWN"),
    (row) => (row.effectiveFrom = new Date("2026-08-31T00:00:00.000Z")),
    (row) => (row.effectiveTo = new Date("2026-08-29T00:00:00.000Z"))
  ];
  for (const mutate of mutations) {
    const snapshot = addFictitiousTemplateFields(completeSnapshot());
    mutate(snapshot.templates.contractVersions[0]);
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CONTRACT_TEMPLATE_REQUIRED"));
  }
});

test("contract effectiveness is evaluated only at caller-provided snapshot.asOf", () => {
  const missingAsOf = addFictitiousTemplateFields(completeSnapshot());
  delete missingAsOf.asOf;
  const invalidAsOf = addFictitiousTemplateFields(completeSnapshot({ asOf: new Date(Number.NaN) }));
  const beforeWindow = addFictitiousTemplateFields(
    completeSnapshot({ asOf: new Date("2025-12-31T23:59:59.999Z") })
  );
  for (const snapshot of [missingAsOf, invalidAsOf, beforeWindow]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CONTRACT_TEMPLATE_REQUIRED"));
  }
});

test("each selected contract version requires exactly one valid referenced PDF FileObject", () => {
  const missing = completeSnapshot();
  missing.templates.fileObjects.shift();
  const invalidMime = completeSnapshot();
  invalidMime.templates.fileObjects[0].mimeType = "text/plain";
  const invalidDigest = completeSnapshot();
  invalidDigest.templates.fileObjects[0].contentSha256 = "not-a-sha256";
  const duplicate = completeSnapshot();
  duplicate.templates.fileObjects.push({ ...duplicate.templates.fileObjects[0] });
  for (const snapshot of [missing, invalidMime, invalidDigest, duplicate]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "CONTRACT_TEMPLATE_FILE_INVALID"));
  }
});

test("classification accepts and preserves the real FileObject scalar shape", () => {
  const snapshot = completeSnapshot();
  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(result.safeToApply, true);
  assert.deepEqual(result.rows.templates.fileObjects, snapshot.templates.fileObjects);
  assert.equal(typeof result.rows.templates.fileObjects[0].sizeBytes, "bigint");
  assert.equal("status" in result.rows.templates.fileObjects[0], false);
  assert.equal("deletedAt" in result.rows.templates.fileObjects[0], false);
});

test("notifications match real templateCode and templateStatus fields exactly once", () => {
  const baseline = completeSnapshot();
  const baselineResult = classifyStage1CleanAcceptanceBaseline(baseline, selection());
  assert.equal(baselineResult.safeToApply, true);
  assert.deepEqual(
    baselineResult.rows.templates.notificationTemplates,
    baseline.templates.notificationTemplates
  );
  assert.equal("code" in baselineResult.rows.templates.notificationTemplates[0], false);
  assert.equal("status" in baselineResult.rows.templates.notificationTemplates[0], false);

  const missing = completeSnapshot({ templates: { notificationTemplates: [] } });
  const inactive = completeSnapshot();
  inactive.templates.notificationTemplates[0].templateStatus = "INACTIVE";
  const deleted = completeSnapshot();
  deleted.templates.notificationTemplates[0].deletedAt = new Date("2026-08-01T00:00:00.000Z");
  const missingDeletedAt = completeSnapshot();
  delete missingDeletedAt.templates.notificationTemplates[0].deletedAt;
  const duplicate = completeSnapshot();
  duplicate.templates.notificationTemplates.push(
    notificationTemplate({ id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" })
  );
  for (const snapshot of [missing, inactive, deleted, missingDeletedAt, duplicate]) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some(({ code }) => code === "NOTIFICATION_TEMPLATE_REQUIRED"));
  }
});

test("fictitious NotificationTemplate.status and code cannot satisfy a required code", () => {
  const snapshot = addFictitiousTemplateFields(completeSnapshot());
  const row = snapshot.templates.notificationTemplates[0];
  delete row.templateCode;
  delete row.templateStatus;
  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
  assert.equal(result.safeToApply, false);
  assert.ok(result.exceptions.some(({ code }) => code === "NOTIFICATION_TEMPLATE_REQUIRED"));
});

test("classification rejects unknown statuses and includes the complete selected vehicle closure", () => {
  const unknownStatus = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ access: { users: [{ id: "admin-user", username: "keqi_119" }] } }),
    selection()
  );
  assert.equal(unknownStatus.safeToApply, false);
  assert.ok(unknownStatus.exceptions.some(({ code }) => code === "ADMIN_NOT_FOUND"));

  const duplicatedOwner = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      vehicle: {
        assetOwners: [
          { id: "owner-1", status: "ACTIVE" },
          { id: "owner-1", status: "ACTIVE" }
        ]
      }
    }),
    selection()
  );
  assert.equal(duplicatedOwner.safeToApply, false);
  assert.ok(duplicatedOwner.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));

  const baseline = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const changedOwner = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      vehicle: { assetOwners: [{ id: "owner-1", ownerNo: "changed-owner", status: "ACTIVE" }] }
    }),
    selection()
  );
  assert.deepEqual(
    baseline.rows.vehicle.assetOwners.map(({ id }) => id),
    ["owner-1"]
  );
  assert.notEqual(baseline.rowDigests.vehicle, changedOwner.rowDigests.vehicle);
});

test("manifest rejects malformed context and classification and salts every published digest", () => {
  const classification = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const context = validManifestContext();
  for (const mutate of [
    (value) => (value.source.databaseDigest = "not-a-digest"),
    (value) => (value.target.migrationCatalogDigest = "not-a-digest"),
    (value) => (value.gitSha = "not-a-sha"),
    (value) => (value.imageRef = "image:latest"),
    (value) => (value.generatedAt = "not-an-iso-timestamp"),
    (value) => (value.hashSalt = "not-a-salt")
  ]) {
    const invalid = structuredClone(context);
    mutate(invalid);
    expectCode(
      () => buildStage1CleanAcceptanceManifest(classification, invalid),
      "MANIFEST_CONTEXT_INVALID"
    );
  }
  expectCode(
    () => buildStage1CleanAcceptanceManifest({ ...classification, rows: {} }, context),
    "MANIFEST_CLASSIFICATION_INVALID"
  );
  expectCode(
    () =>
      buildStage1CleanAcceptanceManifest(
        { ...classification, rows: { ...classification.rows, unexpected: [] } },
        context
      ),
    "MANIFEST_CLASSIFICATION_INVALID"
  );
  expectCode(
    () =>
      buildStage1CleanAcceptanceManifest(
        {
          ...classification,
          selection: { ...classification.selection, vehicleIds: ["not-a-uuid"] }
        },
        context
      ),
    "MANIFEST_CLASSIFICATION_INVALID"
  );

  const manifest = buildStage1CleanAcceptanceManifest(
    {
      ...classification,
      exceptions: [{ code: "TARGET_NOT_EMPTY", domain: "target", subjectDigest: "a".repeat(64) }],
      safeToApply: false
    },
    context
  );
  assert.match(manifest.rowDigests.vehicle, /^[0-9a-f]{64}$/);
  assert.match(manifest.exceptions[0].subjectDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(manifest.rowDigests.vehicle, classification.rowDigests.vehicle);
  assert.notEqual(manifest.exceptions[0].subjectDigest, "a".repeat(64));
  assert.equal(
    manifest.rowDigests.vehicle,
    "0a8beafd5c677426852d02c824d916aa547e59a34ca13d80a4405e5d181fb69a"
  );
  assert.equal(
    manifest.exceptions[0].subjectDigest,
    "dd881d6b5f32438dfc1e23709a232088240e855697d0d5baa0789e32fb27833e"
  );
});

test("error and manifest exception redaction collapse undeclared code, domain, and digest input", () => {
  assert.deepEqual(redactStage1CleanAcceptanceError({ code: "UNDECLARED_CODE" }), {
    code: "STAGE1_ACCEPTANCE_ERROR"
  });
  const classification = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const manifest = buildStage1CleanAcceptanceManifest(
    {
      ...classification,
      exceptions: [
        { code: "UNDECLARED_CODE", domain: "unapproved", subjectDigest: "not-a-digest" }
      ],
      safeToApply: false
    },
    validManifestContext()
  );
  assert.deepEqual(
    manifest.exceptions.map(({ code, domain }) => ({ code, domain })),
    [{ code: "STAGE1_ACCEPTANCE_ERROR", domain: "unknown" }]
  );
});

test("row digests preserve distinct Prisma timestamp values", () => {
  const earlier = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      access: {
        users: [
          {
            createdAt: new Date("2026-08-30T00:00:00.000Z"),
            id: "admin-user",
            status: "ACTIVE",
            username: "keqi_119"
          }
        ]
      }
    }),
    selection()
  );
  const later = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      access: {
        users: [
          {
            createdAt: new Date("2026-08-31T00:00:00.000Z"),
            id: "admin-user",
            status: "ACTIVE",
            username: "keqi_119"
          }
        ]
      }
    }),
    selection()
  );
  assert.notEqual(earlier.rowDigests.access, later.rowDigests.access);
});

test("manifest canonicalizes object keys and arrays before producing a stable SHA-256", () => {
  const classification = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const context = validManifestContext();
  const shuffled = {
    ...classification,
    exceptions: [...classification.exceptions].reverse(),
    selection: {
      ...classification.selection,
      vehicleIds: [...classification.selection.vehicleIds].reverse()
    }
  };
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  const shuffledManifest = buildStage1CleanAcceptanceManifest(shuffled, {
    ...context,
    source: {
      migrationCatalogDigest: "a".repeat(64),
      databaseDigest: "b".repeat(64),
      schemaDigest: "c".repeat(64)
    }
  });

  assert.equal(
    hashStage1CleanAcceptanceManifest(manifest),
    hashStage1CleanAcceptanceManifest(shuffledManifest)
  );
  assert.equal(
    hashStage1CleanAcceptanceManifest(manifest),
    "325297b8d2d67341472de821683adafe501fe4f47242e4ced5b49d478ff112e9"
  );
  assert.deepEqual(
    manifest.selection.vehicleDigests,
    [...manifest.selection.vehicleDigests].sort()
  );
});

test("manifest contains salted domain digests but no identity, VIN, plate, or object key", () => {
  const classification = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      vehicle: {
        vehicles: [
          {
            currentSalePriceAmount: 100,
            id: VEHICLE_A,
            modelDefinitionId: "model-1",
            plateNo: "沪A12345",
            salePriceStatus: "EFFECTIVE",
            status: "AVAILABLE",
            vin: "VIN-SECRET"
          }
        ]
      }
    }),
    selection()
  );
  const manifest = buildStage1CleanAcceptanceManifest(classification, validManifestContext());
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.selection.adminDigest.length, 64);
  assert.equal(manifest.selection.customerDigest.length, 64);
  assert.equal(manifest.selection.vehicleDigests[0].length, 64);
  for (const secret of [
    "keqi_119",
    "18616570212",
    "VIN-SECRET",
    "沪A12345",
    "contracts/template.pdf"
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("error redaction retains only a stable code", () => {
  const error = new Error("postgresql://operator:password@db.internal/private");
  error.code = "DATABASE_PORT_MISMATCH";
  assert.deepEqual(redactStage1CleanAcceptanceError(error), { code: "DATABASE_PORT_MISMATCH" });
});

function validManifestContext() {
  return {
    generatedAt: "2026-08-30T00:00:00.000Z",
    gitSha: "a".repeat(40),
    hashSalt: HASH_SALT,
    imageRef: `registry.example/api@sha256:${"b".repeat(64)}`,
    source: {
      databaseDigest: "b".repeat(64),
      migrationCatalogDigest: "a".repeat(64),
      schemaDigest: "c".repeat(64)
    },
    target: {
      databaseDigest: "e".repeat(64),
      migrationCatalogDigest: "d".repeat(64),
      schemaDigest: "f".repeat(64)
    }
  };
}
