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

function completeSnapshot(overrides = {}) {
  const snapshot = {
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
      benefitPackages: [{ id: "benefit-1", productId: "product-1", productVersionId: "product-version-1", status: "ACTIVE" }],
      depositRules: [{ gradeCode: "STANDARD", id: "deposit-1", status: "ACTIVE" }],
      energyPackages: [{ id: "energy-1", productId: "product-1", productVersionId: "product-version-1", status: "ACTIVE" }],
      mileagePackages: [{ id: "mileage-1", productId: "product-1", productVersionId: "product-version-1", status: "ACTIVE" }],
      products: [{ id: "product-1", status: "ACTIVE" }],
      productVersions: [
        { id: "product-version-1", productId: "product-1", status: "ACTIVE" }
      ],
      productPriceRules: [{ id: "price-rule-1", modelDefinitionId: "model-1", productVersionId: "product-version-1", status: "ACTIVE" }],
      subscriptionPlans: [
        { benefitPackageId: "benefit-1", energyPackageId: "energy-1", id: "plan-1", mileagePackageId: "mileage-1", productId: "product-1", productVersionId: "product-version-1", status: "ACTIVE", vehiclePackageId: "package-1" }
      ],
      vehiclePackageModelMembers: [{ id: "package-member-1", modelDefinitionId: "model-1", vehiclePackageId: "package-1" }],
      vehiclePackages: [{ id: "package-1", productId: "product-1", productVersionId: "product-version-1", status: "ACTIVE" }]
    },
    customer: {
      customerAccounts: [
        { accountStatus: "ACTIVE", customerId: "customer-1", id: "customer-account-1", phone: "18616570212" }
      ],
      customerESignProviderAccounts: [
        { certBindingStatus: "BOUND", customerId: "customer-1", id: "esign-1", provider: "FADADA", providerOpenId: "provider-open-id-1", realNameStatus: "VERIFIED", registrationStatus: "REGISTERED" }
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
      contractVersions: [
        { fileId: "file-1", id: "contract-version-1", status: "ACTIVE", templateCode: "STAGE1_SUBSCRIPTION" }
      ],
      fileObjects: [{ bucket: "stage1-contracts", contentSha256: "a".repeat(64), id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template.pdf", originalName: "stage1-subscription.pdf", sizeBytes: 1 }],
      notificationTemplates: [{ code: "STAGE1_NOTICE", id: "notification-1", status: "ACTIVE" }],
      requiredContractTemplateCodes: ["STAGE1_SUBSCRIPTION"],
      requiredNotificationTemplateCodes: ["STAGE1_NOTICE"]
    },
    vehicle: {
      assetOwners: [{ id: "owner-1", status: "ACTIVE" }],
      eligibilityEvidence: {
        [VEHICLE_A]: {
          blockingRestrictionCount: 0,
          currentSalePricePositive: true,
          overlappingSubscriptionPeriodCount: 0,
          salePriceStatusEffective: true
        }
      },
      vehicles: [
        {
          assetOwnerId: "owner-1",
          currentSalePriceAmount: 100,
          id: VEHICLE_A,
          listingProfileId: "listing-1",
          modelDefinitionId: "model-1",
          salePriceStatus: "EFFECTIVE",
          status: "AVAILABLE",
        }
      ],
      vehicleAssetCostProfiles: [{ id: "cost-profile-1", vehicleId: VEHICLE_A }],
      vehicleCostLedgerEntries: [{ id: "cost-ledger-1", vehicleId: VEHICLE_A }],
      vehicleDocumentBatches: [{ id: "document-batch-1", vehicleId: VEHICLE_A }],
      vehicleDocuments: [{ batchId: "document-batch-1", id: "document-1", vehicleId: VEHICLE_A }],
      vehicleInsuranceCoverages: [{ id: "coverage-1", policyId: "policy-1" }],
      vehicleInsurancePolicies: [{ id: "policy-1", vehicleId: VEHICLE_A }],
      vehicleListingMedia: [{ id: "media-1", listingProfileId: "listing-1" }],
      vehicleListingPlans: [{ id: "listing-plan-1", listingProfileId: "listing-1" }],
      vehicleListingProfiles: [{ id: "listing-1", listingStatus: "PUBLISHED", vehicleId: VEHICLE_A }],
      vehicleListingSourceBindings: [{ id: "source-binding-1", vehicleId: VEHICLE_A }],
      vehicleModelDefinitions: [{ enabled: true, id: "model-1", portalVisible: true }],
      vehicleOwnershipPeriods: [{ assetOwnerId: "owner-1", id: "ownership-1", vehicleId: VEHICLE_A }],
      vehicleSalePriceHistories: [{ id: "sale-price-1", vehicleId: VEHICLE_A }]
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
    () => parseStage1CleanAcceptanceSelection({ adminUsername: "other", customerPhone: "18616570212", vehicleIds: [] }),
    "IDENTITY_SELECTION_NOT_ALLOWED"
  );
  expectCode(
    () => parseStage1CleanAcceptanceSelection({ adminUsername: "keqi_119", customerPhone: "13800000000", vehicleIds: [] }),
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
      () => parseStage1CleanAcceptanceSelection({ adminUsername: "keqi_119", customerPhone: "18616570212", vehicleIds }),
      "VEHICLE_ID_INVALID"
    );
  }
});

test("database identity exposes only comparable non-secret fields", () => {
  assert.deepEqual(
    parseStage1AcceptanceDatabaseIdentity("postgresql://operator:super-secret@db.internal:5544/subscription_saas_staging?sslmode=verify-full"),
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
  const source = "postgresql://operator:source-password@db.internal:5432/subscription_saas_staging?sslmode=require";
  const target = "postgresql://operator:target-password@db.internal:5432/subscription_saas_staging_acceptance_20260830?sslmode=require";
  const cases = [
    [source.replace("subscription_saas_staging?", "other?"), target, {}, "SOURCE_DATABASE_NOT_ALLOWED"],
    [source, target.replace("acceptance_20260830", "wrong"), {}, "TARGET_DATABASE_NOT_ALLOWED"],
    [source, source, { allowedHostname: "db.internal" }, "DATABASE_PAIR_SAME_DATABASE"],
    [source, target.replace("db.internal", "other.internal"), { allowedHostname: "db.internal" }, "DATABASE_HOSTNAME_MISMATCH"],
    [source, target, { allowedHostname: "other.internal" }, "DATABASE_HOSTNAME_NOT_ALLOWED"],
    [source, target.replace(":5432", ":5433"), { allowedHostname: "db.internal" }, "DATABASE_PORT_MISMATCH"],
    [source, target.replace("operator:", "reader:"), { allowedHostname: "db.internal" }, "DATABASE_USERNAME_MISMATCH"],
    [source, target.replace("sslmode=require", "sslmode=disable"), { allowedHostname: "db.internal" }, "DATABASE_TLS_POLICY_MISMATCH"],
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
  assert.deepEqual(result.exceptions.map(({ code }) => code), ["VEHICLE_SELECTION_REQUIRED"]);
});

test("classification closes the complete fixed baseline and marks it safe", () => {
  const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(isStage1CleanAcceptanceBaselineSafe(result), true);
  assert.equal(result.safeToApply, true);
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.rows.access.users[0].id, "admin-user");
  assert.equal(result.rows.customer.customers[0].id, "customer-1");
  assert.equal(result.rows.vehicle.vehicles[0].id, VEHICLE_A);
  assert.deepEqual(result.targetForbiddenCounts, { auditLog: 0, subscriptionOrder: 0 });
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
  assert.equal(result.rows.customer.customerESignProviderAccounts[0].providerOpenId, "provider-open-id-1");
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
});

test("vehicle closure keeps each explicitly selected vehicle and its one-to-many rows", () => {
  const snapshot = completeSnapshot();
  snapshot.vehicle.eligibilityEvidence[VEHICLE_B] = {
    blockingRestrictionCount: 0,
    currentSalePricePositive: true,
    overlappingSubscriptionPeriodCount: 0,
    salePriceStatusEffective: true
  };
  snapshot.vehicle.vehicles.push({ assetOwnerId: "owner-1", currentSalePriceAmount: 200, id: VEHICLE_B, listingProfileId: "listing-2", modelDefinitionId: "model-1", salePriceStatus: "EFFECTIVE", status: "AVAILABLE" });
  snapshot.vehicle.vehicleListingProfiles.push({ id: "listing-2", listingStatus: "PUBLISHED", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleListingMedia.push({ id: "media-2", listingProfileId: "listing-2" });
  snapshot.vehicle.vehicleListingPlans.push({ id: "listing-plan-2", listingProfileId: "listing-2" });
  snapshot.vehicle.vehicleDocumentBatches.push({ id: "document-batch-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleDocuments.push({ batchId: "document-batch-2", id: "document-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleListingSourceBindings.push({ id: "source-binding-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleInsurancePolicies.push({ id: "policy-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleInsuranceCoverages.push({ id: "coverage-2", policyId: "policy-2" });
  snapshot.vehicle.vehicleSalePriceHistories.push({ id: "sale-price-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleOwnershipPeriods.push({ assetOwnerId: "owner-1", id: "ownership-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleAssetCostProfiles.push({ id: "cost-profile-2", vehicleId: VEHICLE_B });
  snapshot.vehicle.vehicleCostLedgerEntries.push({ id: "cost-ledger-2", vehicleId: VEHICLE_B });

  const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection([VEHICLE_A, VEHICLE_B]));
  assert.equal(result.safeToApply, true);
  assert.deepEqual(result.rows.vehicle.vehicles.map(({ id }) => id), [VEHICLE_A, VEHICLE_B]);
  assert.deepEqual(result.rows.vehicle.vehicleInsuranceCoverages.map(({ id }) => id), ["coverage-1", "coverage-2"]);
});

test("classification blocks exceptions, ambiguity, target rows, schema drift, and incomplete vehicle closure", () => {
  const cases = [
    [completeSnapshot({ access: { users: [] } }), "ADMIN_NOT_FOUND"],
    [completeSnapshot({ access: { users: [{ id: "admin-2", status: "ACTIVE", username: "keqi_119" }, { id: "admin-1", status: "ACTIVE", username: "keqi_119" }] } }), "ADMIN_AMBIGUOUS"],
    [completeSnapshot({ target: { tableCounts: { user: 1 } } }), "TARGET_NOT_EMPTY"],
    [completeSnapshot({ target: { schemaCanonical: false } }), "TARGET_SCHEMA_NOT_CANONICAL"],
    [completeSnapshot({ target: { forbiddenCounts: { auditLog: 1 } } }), "FORBIDDEN_DOMAIN_NOT_EMPTY"],
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

test("classification requires explicit active template and notification closure with a unique active PDF file", () => {
  const cases = [
    [completeSnapshot({ templates: { contractVersions: [] } }), "CONTRACT_TEMPLATE_REQUIRED"],
    [completeSnapshot({ templates: { notificationTemplates: [] } }), "NOTIFICATION_TEMPLATE_REQUIRED"],
    [completeSnapshot({ templates: { fileObjects: [{ deletedAt: new Date(), id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template.pdf", sizeBytes: 1, status: "ACTIVE" }] } }), "CONTRACT_TEMPLATE_FILE_INVALID"],
    [completeSnapshot({ templates: { fileObjects: [{ id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template.pdf", sizeBytes: 1, status: "ACTIVE" }, { deletedAt: new Date(), id: "file-1", mimeType: "application/pdf", objectKey: "contracts/retired.pdf", sizeBytes: 1, status: "ACTIVE" }] } }), "CONTRACT_TEMPLATE_FILE_INVALID"],
    [completeSnapshot({ templates: { fileObjects: [{ id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template.pdf", sizeBytes: 1, status: "ACTIVE" }, { id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template-copy.pdf", sizeBytes: 1, status: "ACTIVE" }] } }), "CONTRACT_TEMPLATE_FILE_INVALID"]
  ];
  for (const [snapshot, code] of cases) {
    const result = classifyStage1CleanAcceptanceBaseline(snapshot, selection());
    assert.equal(result.safeToApply, false);
    assert.ok(result.exceptions.some((exception) => exception.code === code));
  }
});

test("classification accepts the actual FileObject scalar shape when its contract file is complete", () => {
  const result = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({
      templates: {
        fileObjects: [
          {
            bucket: "stage1-contracts",
            contentSha256: "a".repeat(64),
            id: "file-1",
            mimeType: "application/pdf",
            objectKey: "contracts/template.pdf",
            originalName: "stage1-subscription.pdf",
            sizeBytes: 1
          }
        ]
      }
    }),
    selection()
  );
  assert.equal(result.safeToApply, true);
  assert.equal(result.rows.templates.fileObjects[0].bucket, "stage1-contracts");
});

test("classification rejects unknown statuses and includes the complete selected vehicle closure", () => {
  const unknownStatus = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ access: { users: [{ id: "admin-user", username: "keqi_119" }] } }),
    selection()
  );
  assert.equal(unknownStatus.safeToApply, false);
  assert.ok(unknownStatus.exceptions.some(({ code }) => code === "ADMIN_NOT_FOUND"));

  const duplicatedOwner = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ vehicle: { assetOwners: [{ id: "owner-1", status: "ACTIVE" }, { id: "owner-1", status: "ACTIVE" }] } }),
    selection()
  );
  assert.equal(duplicatedOwner.safeToApply, false);
  assert.ok(duplicatedOwner.exceptions.some(({ code }) => code === "VEHICLE_REFERENCE_NOT_CLOSED"));

  const baseline = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const changedOwner = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ vehicle: { assetOwners: [{ id: "owner-1", ownerNo: "changed-owner", status: "ACTIVE" }] } }),
    selection()
  );
  assert.deepEqual(baseline.rows.vehicle.assetOwners.map(({ id }) => id), ["owner-1"]);
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
    expectCode(() => buildStage1CleanAcceptanceManifest(classification, invalid), "MANIFEST_CONTEXT_INVALID");
  }
  expectCode(() => buildStage1CleanAcceptanceManifest({ ...classification, rows: {} }, context), "MANIFEST_CLASSIFICATION_INVALID");
  expectCode(
    () => buildStage1CleanAcceptanceManifest({ ...classification, rows: { ...classification.rows, unexpected: [] } }, context),
    "MANIFEST_CLASSIFICATION_INVALID"
  );
  expectCode(
    () => buildStage1CleanAcceptanceManifest({ ...classification, selection: { ...classification.selection, vehicleIds: ["not-a-uuid"] } }, context),
    "MANIFEST_CLASSIFICATION_INVALID"
  );

  const manifest = buildStage1CleanAcceptanceManifest(
    { ...classification, exceptions: [{ code: "TARGET_NOT_EMPTY", domain: "target", subjectDigest: "a".repeat(64) }], safeToApply: false },
    context
  );
  assert.match(manifest.rowDigests.vehicle, /^[0-9a-f]{64}$/);
  assert.match(manifest.exceptions[0].subjectDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(manifest.rowDigests.vehicle, classification.rowDigests.vehicle);
  assert.notEqual(manifest.exceptions[0].subjectDigest, "a".repeat(64));
  assert.equal(manifest.rowDigests.vehicle, "a2e459ed40b3b01b34ac0fe36086e76d277824c5795a71beea4b87ece6768833");
  assert.equal(manifest.exceptions[0].subjectDigest, "dd881d6b5f32438dfc1e23709a232088240e855697d0d5baa0789e32fb27833e");
});

test("error and manifest exception redaction collapse undeclared code, domain, and digest input", () => {
  assert.deepEqual(redactStage1CleanAcceptanceError({ code: "UNDECLARED_CODE" }), { code: "STAGE1_ACCEPTANCE_ERROR" });
  const classification = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  const manifest = buildStage1CleanAcceptanceManifest(
    { ...classification, exceptions: [{ code: "UNDECLARED_CODE", domain: "unapproved", subjectDigest: "not-a-digest" }], safeToApply: false },
    validManifestContext()
  );
  assert.deepEqual(manifest.exceptions.map(({ code, domain }) => ({ code, domain })), [
    { code: "STAGE1_ACCEPTANCE_ERROR", domain: "unknown" }
  ]);
});

test("row digests preserve distinct Prisma timestamp values", () => {
  const earlier = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ access: { users: [{ createdAt: new Date("2026-08-30T00:00:00.000Z"), id: "admin-user", status: "ACTIVE", username: "keqi_119" }] } }),
    selection()
  );
  const later = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ access: { users: [{ createdAt: new Date("2026-08-31T00:00:00.000Z"), id: "admin-user", status: "ACTIVE", username: "keqi_119" }] } }),
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
    selection: { ...classification.selection, vehicleIds: [...classification.selection.vehicleIds].reverse() }
  };
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  const shuffledManifest = buildStage1CleanAcceptanceManifest(shuffled, {
    ...context,
    source: { migrationCatalogDigest: "a".repeat(64), databaseDigest: "b".repeat(64), schemaDigest: "c".repeat(64) }
  });

  assert.equal(hashStage1CleanAcceptanceManifest(manifest), hashStage1CleanAcceptanceManifest(shuffledManifest));
  assert.equal(hashStage1CleanAcceptanceManifest(manifest), "f50fefe10fbfa7b3d636d22799ac28a8ddfab9996a4f5981b1f416380e9f2ad6");
  assert.deepEqual(manifest.selection.vehicleDigests, [...manifest.selection.vehicleDigests].sort());
});

test("manifest contains salted domain digests but no identity, VIN, plate, or object key", () => {
  const classification = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ vehicle: { vehicles: [{ assetOwnerId: "owner-1", currentSalePriceAmount: 100, id: VEHICLE_A, licensePlate: "沪A12345", listingProfileId: "listing-1", modelDefinitionId: "model-1", salePriceStatus: "EFFECTIVE", status: "AVAILABLE", vin: "VIN-SECRET" }] } }),
    selection()
  );
  const manifest = buildStage1CleanAcceptanceManifest(classification, validManifestContext());
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.selection.adminDigest.length, 64);
  assert.equal(manifest.selection.customerDigest.length, 64);
  assert.equal(manifest.selection.vehicleDigests[0].length, 64);
  for (const secret of ["keqi_119", "18616570212", "VIN-SECRET", "沪A12345", "contracts/template.pdf"]) {
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
    source: { databaseDigest: "b".repeat(64), migrationCatalogDigest: "a".repeat(64), schemaDigest: "c".repeat(64) },
    target: { databaseDigest: "e".repeat(64), migrationCatalogDigest: "d".repeat(64), schemaDigest: "f".repeat(64) }
  };
}
