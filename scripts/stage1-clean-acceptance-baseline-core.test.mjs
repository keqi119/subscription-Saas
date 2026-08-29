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
      depositRules: [{ id: "deposit-1", status: "ACTIVE" }],
      products: [{ id: "product-1", status: "ACTIVE" }],
      productVersions: [
        { depositRuleId: "deposit-1", id: "product-version-1", productId: "product-1", status: "ACTIVE" }
      ],
      subscriptionPlans: [
        { id: "plan-1", productVersionId: "product-version-1", status: "ACTIVE", vehiclePackageId: "package-1" }
      ],
      vehiclePackages: [{ id: "package-1", status: "ACTIVE" }]
    },
    customer: {
      customerAccounts: [
        { customerId: "customer-1", id: "customer-account-1", phone: "18616570212", status: "ACTIVE" }
      ],
      customerESignProviderAccounts: [
        { customerId: "customer-1", id: "esign-1", providerAccountId: "provider-1", status: "ACTIVE" }
      ],
      customerIdentities: [{ customerId: "customer-1", id: "identity-1", status: "ACTIVE" }],
      customerProfiles: [{ customerId: "customer-1", id: "profile-1", status: "ACTIVE" }],
      customers: [{ id: "customer-1", status: "ACTIVE" }]
    },
    target: {
      forbiddenCounts: { auditLog: 0, subscriptionOrder: 0 },
      schemaCanonical: true,
      tableCounts: { customer: 0, user: 0, vehicle: 0 }
    },
    templates: {
      contractVersions: [
        { fileId: "file-1", id: "contract-version-1", status: "ACTIVE", templateCode: "STAGE1_SUBSCRIPTION" }
      ],
      fileObjects: [{ id: "file-1", mimeType: "application/pdf", objectKey: "contracts/template.pdf", sizeBytes: 1 }],
      notificationTemplates: [{ code: "STAGE1_NOTICE", id: "notification-1", status: "ACTIVE" }]
    },
    vehicle: {
      assetOwners: [{ id: "owner-1", status: "ACTIVE" }],
      vehicles: [
        {
          assetOwnerId: "owner-1",
          id: VEHICLE_A,
          listingProfileId: "listing-1",
          status: "AVAILABLE",
          vehicleModelDefinitionId: "model-1"
        }
      ],
      vehicleListingProfiles: [{ id: "listing-1", status: "ACTIVE", vehicleId: VEHICLE_A }],
      vehicleModelDefinitions: [{ id: "model-1", status: "ACTIVE" }]
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
  assert.deepEqual(result.rows.vehicle, []);
  assert.deepEqual(result.exceptions.map(({ code }) => code), ["VEHICLE_SELECTION_REQUIRED"]);
});

test("classification closes the complete fixed baseline and marks it safe", () => {
  const result = classifyStage1CleanAcceptanceBaseline(completeSnapshot(), selection());
  assert.equal(isStage1CleanAcceptanceBaselineSafe(result), true);
  assert.equal(result.safeToApply, true);
  assert.deepEqual(result.exceptions, []);
  assert.equal(result.rows.access.users[0].id, "admin-user");
  assert.equal(result.rows.customer.customers[0].id, "customer-1");
  assert.equal(result.rows.vehicle[0].id, VEHICLE_A);
  assert.deepEqual(result.targetForbiddenCounts, { auditLog: 0, subscriptionOrder: 0 });
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
  const context = {
    generatedAt: "2026-08-30T00:00:00.000Z",
    gitSha: "a".repeat(40),
    hashSalt: HASH_SALT,
    imageRef: "registry.example/api@sha256:abc",
    source: { schemaDigest: "source-schema", databaseDigest: "source-db", migrationCatalogDigest: "source-migrations" },
    target: { schemaDigest: "target-schema", databaseDigest: "target-db", migrationCatalogDigest: "target-migrations" }
  };
  const shuffled = {
    ...classification,
    exceptions: [...classification.exceptions].reverse(),
    selection: { ...classification.selection, vehicleIds: [...classification.selection.vehicleIds].reverse() }
  };
  const manifest = buildStage1CleanAcceptanceManifest(classification, context);
  const shuffledManifest = buildStage1CleanAcceptanceManifest(shuffled, {
    ...context,
    source: { migrationCatalogDigest: "source-migrations", databaseDigest: "source-db", schemaDigest: "source-schema" }
  });

  assert.equal(hashStage1CleanAcceptanceManifest(manifest), hashStage1CleanAcceptanceManifest(shuffledManifest));
  assert.equal(hashStage1CleanAcceptanceManifest(manifest), "31fc953a4143b251e28391cfe0fb1d56405d2a907d3860815e8f89c8d1926675");
  assert.deepEqual(manifest.selection.vehicleDigests, [...manifest.selection.vehicleDigests].sort());
});

test("manifest contains salted domain digests but no identity, VIN, plate, or object key", () => {
  const classification = classifyStage1CleanAcceptanceBaseline(
    completeSnapshot({ vehicle: { vehicles: [{ assetOwnerId: "owner-1", id: VEHICLE_A, licensePlate: "沪A12345", listingProfileId: "listing-1", status: "AVAILABLE", vehicleModelDefinitionId: "model-1", vin: "VIN-SECRET" }] } }),
    selection()
  );
  const manifest = buildStage1CleanAcceptanceManifest(classification, {
    generatedAt: "2026-08-30T00:00:00.000Z",
    gitSha: "b".repeat(40),
    hashSalt: HASH_SALT,
    imageRef: "image",
    source: { databaseDigest: "a", migrationCatalogDigest: "b", schemaDigest: "c" },
    target: { databaseDigest: "d", migrationCatalogDigest: "e", schemaDigest: "f" }
  });
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
