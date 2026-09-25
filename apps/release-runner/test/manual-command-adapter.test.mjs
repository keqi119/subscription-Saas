import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canonicalJson,
  computeManualClusterFingerprint,
  encodeManualJson,
  sha256Bytes,
  sha256Canonical,
  signManualAuthorization,
  verifyManualHandoff,
  verifyManualAuthorization,
  validateContract
} from "@subscription-saas/release-foundation";
import { executeManualCommand } from "../src/manual-command-adapter.mjs";
import { buildManualBaseline } from "../src/manual-command-adapter.mjs";
import { createPostgresConnector } from "../src/postgres-connector.mjs";
import { createDatabaseRuntimeAdapter } from "../src/database-runtime-adapter.mjs";
import { planMigration } from "../src/commands/db-migrate-deploy.mjs";
import { verifySchema } from "../src/commands/db-schema-verify.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const uuid = (tail) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const observedAt = "2026-09-01T00:00:00.000Z";
const targetRequest = {
  schemaVersion: "manual-runner-request.v1",
  attemptId: uuid(1),
  runId: uuid(2),
  attemptAllocationDigest: digest,
  profileDigest: digest,
  ownerId: "owner",
  sessionId: uuid(3),
  sessionNonce: "a".repeat(64),
  operationId: uuid(4),
  idempotencyKey: "observe",
  purpose: "synthetic-fresh",
  targetIntent: { endpointPolicyId: "fresh", databaseName: "fresh_db" },
  stage: "target-observe",
  capability: "verify"
};
const catalog = {
  migrationTableOid: null,
  migrationRows: [],
  schemaOwner: "schema_owner",
  ownerInventory: [{ objectClass: "schema", objectName: "public", owner: "schema_owner" }],
  extensions: ["plpgsql"],
  postgresqlVersion: "17.11"
};
const observation = {
  schemaVersion: "manual-runner-evidence.v1",
  recordedAt: observedAt,
  promotionEligible: false,
  kind: "observation",
  profileDigest: targetRequest.profileDigest,
  sessionId: targetRequest.sessionId,
  sessionNonce: targetRequest.sessionNonce,
  operationId: targetRequest.operationId,
  idempotencyKey: targetRequest.idempotencyKey,
  attemptId: targetRequest.attemptId,
  runId: targetRequest.runId,
  requestDigest: sha256Canonical(targetRequest),
  observedAt,
  physicalIdentity: {
    ...targetRequest.targetIntent,
    databaseOid: "123",
    clusterFingerprint: digest
  },
  roleObservation: {
    role: "observer",
    tls: true,
    schemaObservationDigest: sha256Canonical(catalog)
  },
  catalog,
  schema: null,
  processEvidenceDigest: null
};
function baselineInput(request = targetRequest) {
  return {
    trustedBuildDecision: { buildProofDigest: digest, promotionEligible: false },
    request,
    targetObservation: observation,
    roleObservation: observation.roleObservation,
    preState: catalog,
    authorizationDigest: digest
  };
}

test("rejects fabricated handoff before database access", async () => {
  let databaseCalls = 0;
  await assert.rejects(
    () =>
      executeManualCommand({
        request: { commandId: "db.migrate.deploy", commandVersion: "1", phase: "apply" },
        decision: { verified: true },
        database: {
          observeIdentity() {
            databaseCalls += 1;
          }
        }
      }),
    { code: "MANUAL_HANDOFF_UNTRUSTED" }
  );
  assert.equal(databaseCalls, 0);
});

test("baseline derives purpose from the read-back target request and binds its full observation", () => {
  const baseline = buildManualBaseline(baselineInput());
  assert.equal(baseline.identity.purpose, "synthetic-fresh");
  assert.equal(baseline.identity.targetObservationDigest, sha256Canonical(observation));
  assert.equal(baseline.identity.preStateDigest, sha256Canonical(catalog));
});

for (const [name, mutate] of [
  [
    "missing request",
    (input) => {
      delete input.request;
    }
  ],
  [
    "runner request",
    (input) => {
      input.request = { ...input.request, stage: "runner-command" };
    }
  ],
  [
    "wrong request digest",
    (input) => {
      input.request = { ...input.request, operationId: uuid(9) };
    }
  ],
  [
    "modified purpose",
    (input) => {
      input.request = { ...input.request, purpose: "staging-mainline" };
    }
  ]
]) {
  test(`baseline rejects ${name}`, () => {
    const input = baselineInput();
    mutate(input);
    assert.throws(() => buildManualBaseline(input));
  });
}

for (const [field, value] of [
  ["sessionId", uuid(9)],
  ["sessionNonce", "f".repeat(64)],
  ["idempotencyKey", "other-observe"],
  ["attemptId", uuid(9)]
]) {
  test(`baseline rejects observation with drifted ${field} despite an unchanged requestDigest`, () => {
    const input = baselineInput();
    input.targetObservation = { ...observation, [field]: value };
    assert.throws(() => buildManualBaseline(input), { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" });
  });
}

const NOW = "2026-09-25T10:00:01.000Z";
const keys = generateKeyPairSync("ed25519");
const cluster = {
  systemIdentifier: "123456789012345678",
  databaseContainerId: "b".repeat(64),
  dataVolumeName: "fresh-volume",
  postgresImageDigest: digest,
  marker: "fresh-marker",
  serverAddress: "172.19.0.2",
  serverPort: 5432
};
const endpointPolicy = {
  ...targetRequest.targetIntent,
  endpoint: "127.0.0.1:5432",
  purposes: ["synthetic-fresh"],
  roles: { observer: "observer", migrate: "migrator", verify: "verifier" },
  tls: "required"
};
const targetContext = {
  contextVersion: "manual-h3-target-context.v1",
  operationRef: uuid(8),
  indexDigest: digest,
  runId: targetRequest.runId,
  profileDigest: digest,
  targetIntent: targetRequest.targetIntent,
  databaseOid: "123",
  h3Approval: { digest, bytes: 42 },
  h3Readback: { digest, bytes: 42 },
  cluster
};

function profile() {
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  return {
    schemaVersion: "manual-stage1-profile.v2",
    profileId: uuid(10),
    ownerId: "owner",
    publicKeyPem: publicKey,
    keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    validFrom: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-26T00:00:00.000Z",
    buildTrust: {
      repository: "keqi119/subscription-Saas",
      workflow: "keqi119/subscription-Saas/.github/workflows/docker-images.yml",
      sourceRef: "refs/heads/main",
      oidcIssuer: "https://token.actions.githubusercontent.com",
      runnerClass: "github-hosted"
    },
    allowedCommands: [
      { commandId: "db.migrate.deploy", commandVersion: "1", capability: "migrate" },
      { commandId: "db.schema.verify", commandVersion: "1", capability: "verify" }
    ],
    allowedTargets: [endpointPolicy],
    storage: {
      keyRoot: "/keys",
      keyRef: "owner.key",
      journalRoot: "/journal",
      archiveRoot: "/archive",
      backupRoot: "/backup",
      credentialRoot: "/credentials",
      retentionDays: 90
    }
  };
}

function manualFixture(
  phase = "dry-run",
  {
    attemptId = targetRequest.attemptId,
    approvedPlanDigest = digest,
    expectedSchemaDigest = digest
  } = {}
) {
  const fixedProfile = profile();
  const profileDigest = sha256Canonical(fixedProfile);
  const observedCatalog = structuredClone(catalog);
  const originalObservation = {
    ...observation,
    profileDigest,
    requestDigest: sha256Canonical({ ...targetRequest, profileDigest }),
    physicalIdentity: {
      ...observation.physicalIdentity,
      clusterFingerprint: computeManualClusterFingerprint(cluster)
    },
    roleObservation: {
      ...observation.roleObservation,
      schemaObservationDigest: sha256Canonical(observedCatalog)
    },
    catalog: observedCatalog
  };
  const baseline = {
    schemaVersion: "manual-baseline-manifest.v1",
    identity: {
      buildProofDigest: digest,
      purpose: "synthetic-fresh",
      targetObservationDigest: sha256Canonical(originalObservation),
      physicalIdentity: originalObservation.physicalIdentity,
      roleObservation: originalObservation.roleObservation,
      preStateDigest: sha256Canonical(observedCatalog),
      authorizationDigest: digest
    },
    createdAt: observedAt,
    promotionEligible: false
  };
  const role = phase === "verify" ? "verifier" : "migrator";
  const request = {
    ...targetRequest,
    attemptId,
    profileDigest,
    stage: "runner-command",
    capability: phase === "verify" ? "verify" : "migrate",
    commandId: phase === "verify" ? "db.schema.verify" : "db.migrate.deploy",
    commandVersion: "1",
    phase,
    buildProofDigest: digest,
    baselineManifestDigest: sha256Canonical(baseline),
    targetObservationDigest: sha256Canonical(originalObservation),
    physicalIdentity: originalObservation.physicalIdentity,
    roleObservation: {
      role,
      tls: true,
      schemaObservationDigest: originalObservation.roleObservation.schemaObservationDigest
    },
    containerId: "c".repeat(64),
    runnerImageDigest: digest,
    childChallenge: "d".repeat(64),
    domainInput: {
      databaseIdentityFingerprint: sha256Canonical({
        databaseName: "fresh_db",
        databaseOid: "123",
        role,
        tls: true
      }),
      baselineManifestIdentityDigest: sha256Canonical(baseline.identity),
      baselineManifestDigest: sha256Canonical(baseline),
      expectedSchemaDigest,
      expectedOwner: "schema_owner",
      allowedExtensions: ["plpgsql"]
    },
    expectedSchemaEvidenceDigest: digest
  };
  if (phase === "apply") Object.assign(request, { dryRunRecordDigest: digest, approvedPlanDigest });
  if (["replay", "reconcile"].includes(phase))
    Object.assign(request, {
      predecessorExecutionRecordDigest: digest,
      originalIdempotencyKey: request.idempotencyKey
    });
  const bindingKeys = [
    "profileDigest",
    "ownerId",
    "sessionId",
    "sessionNonce",
    "operationId",
    "idempotencyKey",
    "purpose",
    "targetIntent",
    "stage",
    "capability",
    "commandId",
    "commandVersion",
    "phase",
    "buildProofDigest",
    "baselineManifestDigest",
    "targetObservationDigest",
    "physicalIdentity",
    "roleObservation",
    "containerId",
    "runnerImageDigest",
    "childChallenge",
    ...(phase === "apply" ? ["dryRunRecordDigest", "approvedPlanDigest"] : []),
    ...(["replay", "reconcile"].includes(phase)
      ? ["predecessorExecutionRecordDigest", "originalIdempotencyKey"]
      : [])
  ];
  const binding = Object.fromEntries(bindingKeys.map((key) => [key, request[key]]));
  const authorization = signManualAuthorization({
    payload: {
      schemaVersion: "manual-launch-authorization.v1",
      authorizationId: uuid(11),
      issuedAt: "2026-09-25T10:00:00.000Z",
      expiresAt: "2026-09-25T10:05:00.000Z",
      requestDigest: sha256Canonical(request),
      ...binding
    },
    privateKey: keys.privateKey
  });
  const receiptBody = {
    schemaVersion: "manual-operation-record.v2",
    profileDigest,
    recordedAt: NOW,
    promotionEligible: false,
    kind: "consumption-handoff",
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    authorizationDigest: sha256Canonical(authorization),
    requestDigest: sha256Canonical(request),
    containerId: request.containerId,
    runnerImageDigest: request.runnerImageDigest,
    childChallenge: request.childChallenge,
    consumptionRecordDigest: digest,
    consumptionReadbackDigest: digest,
    revocationSequence: 0,
    issuedAt: NOW,
    expiresAt: "2026-09-25T10:00:31.000Z"
  };
  const receipt = {
    ...receiptBody,
    signature: sign(
      null,
      Buffer.from(`subscription-saas/manual-consumption/v1\n${canonicalJson(receiptBody)}`),
      keys.privateKey
    ).toString("base64")
  };
  const decision = verifyManualHandoff({
    authorization,
    receipt,
    profile: fixedProfile,
    request: { canonicalBytes: encodeManualJson(request), binding },
    childObservation: {
      containerId: request.containerId,
      runnerImageDigest: request.runnerImageDigest,
      childChallenge: request.childChallenge
    },
    now: NOW
  });
  targetContext.profileDigest = profileDigest;
  return {
    request,
    decision,
    baseline,
    originalObservation,
    authorization,
    receipt,
    fixedProfile,
    binding
  };
}

test("a real parent decision cannot cross the child command boundary", async () => {
  const { request, baseline, authorization, fixedProfile, binding } = manualFixture();
  const openedAt = "2026-09-25T09:59:00.000Z";
  const sessionRecord = {
    schemaVersion: "manual-operation-record.v2",
    kind: "session",
    profileDigest: request.profileDigest,
    recordedAt: openedAt,
    promotionEligible: false,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    ownerId: request.ownerId,
    targetIntent: request.targetIntent,
    status: "OPEN",
    openedAt,
    previousSessionRecordDigest: null,
    reasonCode: null
  };
  const revocationRecord = {
    schemaVersion: "manual-operation-record.v2",
    kind: "revocation",
    profileDigest: request.profileDigest,
    recordedAt: openedAt,
    promotionEligible: false,
    ownerId: request.ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  const parentDecision = verifyManualAuthorization({
    authorization,
    profile: fixedProfile,
    request: { canonicalBytes: encodeManualJson(request), binding },
    session: {
      record: sessionRecord,
      recordDigest: sha256Canonical(sessionRecord),
      readAt: NOW,
      predecessor: null
    },
    revocation: {
      records: [revocationRecord],
      headDigest: sha256Canonical(revocationRecord),
      checkpoint: { sequence: 0, digest: sha256Canonical(revocationRecord) },
      readAt: NOW
    },
    now: NOW
  });
  const runtime = await connectedRuntime("migrator");
  await assert.rejects(
    () =>
      executeManualCommand({
        request,
        decision: parentDecision,
        baseline,
        database: runtime,
        runtime
      }),
    { code: "MANUAL_HANDOFF_UNTRUSTED" }
  );
  assert.deepEqual(runtime.statementLog, []);
});

for (const [name, phase, change, code] of [
  ["third command", "dry-run", { commandId: "db.raw.execute" }, "CONTRACT_SCHEMA_INVALID"],
  [
    "old challenge",
    "dry-run",
    { childChallenge: "e".repeat(64) },
    "MANUAL_EVIDENCE_BINDING_MISMATCH"
  ],
  [
    "replay without predecessor",
    "replay",
    { predecessorExecutionRecordDigest: undefined },
    "CONTRACT_SCHEMA_INVALID"
  ]
]) {
  test(`branded request rejects ${name} before database access`, async () => {
    const { request, decision, baseline } = manualFixture(phase);
    const modified = { ...request, ...change };
    if (change.predecessorExecutionRecordDigest === undefined)
      delete modified.predecessorExecutionRecordDigest;
    const runtime = await connectedRuntime("migrator");
    await assert.rejects(
      () =>
        executeManualCommand({ request: modified, decision, baseline, database: runtime, runtime }),
      { code }
    );
    assert.deepEqual(runtime.statementLog, []);
  });
}

test("expired receipt and changed signature domain cannot produce a child decision", () => {
  const { request, authorization, receipt, fixedProfile, binding } = manualFixture();
  const handoff = {
    authorization,
    receipt,
    profile: fixedProfile,
    request: { canonicalBytes: encodeManualJson(request), binding },
    childObservation: {
      containerId: request.containerId,
      runnerImageDigest: request.runnerImageDigest,
      childChallenge: request.childChallenge
    },
    now: "2026-09-25T10:00:32.000Z"
  };
  assert.throws(() => verifyManualHandoff({ ...handoff, receipt: null, now: NOW }));
  assert.throws(() => verifyManualHandoff(handoff), { code: "MANUAL_TIME_INVALID" });
  const { signature, ...body } = receipt;
  const wrongDomain = {
    ...receipt,
    signature: sign(
      null,
      Buffer.from(`subscription-saas/manual-launch/v1\n${canonicalJson(body)}`),
      keys.privateKey
    ).toString("base64")
  };
  assert.throws(() => verifyManualHandoff({ ...handoff, receipt: wrongDomain, now: NOW }), {
    code: "MANUAL_SIGNATURE_INVALID"
  });
});

function connectedRuntime(role, changes = {}) {
  const actual = {
    systemIdentifier: cluster.systemIdentifier,
    serverAddress: cluster.serverAddress,
    serverPort: cluster.serverPort,
    databaseName: "fresh_db",
    databaseOid: "123",
    tls: true,
    ...changes
  };
  let domainCalls = 0;
  let migrated = false;
  let deployCalls = 0;
  const client = {
    async unsafe(sql) {
      if (sql.includes("pg_stat_ssl") && !sql.includes("inet_server_addr()"))
        return [
          {
            databaseName: actual.databaseName,
            databaseOid: actual.databaseOid,
            role,
            tls: actual.tls,
            schemas: ["public"],
            extensions: ["plpgsql"]
          }
        ];
      if (sql.includes("pg_control_system()"))
        return [{ systemIdentifier: actual.systemIdentifier }];
      if (sql.includes("inet_server_addr()"))
        return [
          {
            serverAddress: actual.serverAddress,
            serverPort: actual.serverPort,
            databaseName: actual.databaseName,
            databaseOid: actual.databaseOid,
            role,
            tls: actual.tls
          }
        ];
      if (sql === "SHOW transaction_isolation")
        return [{ transaction_isolation: "repeatable read" }];
      if (sql === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
      if (sql.includes("to_regclass"))
        return [{ oid: migrated ? "456" : null, name: migrated ? "_prisma_migrations" : null }];
      if (
        sql.includes('FROM "public"."_prisma_migrations"') &&
        sql.includes("finished_at IS NOT NULL")
      )
        return [{ name: "20260101000000_first", checksum: digest }];
      if (sql.includes('FROM "public"."_prisma_migrations"'))
        return [
          {
            id: "id1",
            migrationName: "20260101000000_first",
            checksum: digest,
            startedAt: new Date("2026-09-01T00:00:00.000Z"),
            finishedAt: new Date("2026-09-01T00:01:00.000Z"),
            rolledBackAt: null,
            appliedStepsCount: 1
          }
        ];
      if (sql.includes("FROM pg_class AS c"))
        return [
          {
            objectClass: "schema",
            objectName: "public",
            owner: actual.schemaOwner ?? "schema_owner"
          }
        ];
      if (sql.includes("nspowner::regrole"))
        return [{ owner: actual.schemaOwner ?? "schema_owner" }];
      if (sql.includes("FROM pg_extension")) return [{ name: "plpgsql" }];
      if (sql === "SHOW server_version") return [{ server_version: "17.11" }];
      return [];
    },
    async begin(callback) {
      return callback(this);
    },
    async end() {}
  };
  const connect = createPostgresConnector({ createClient: () => client });
  return connect({
    credential: { capabilityProfile: "migrate", username: role, password: "test" },
    target: { hostname: "127.0.0.1", databaseName: "fresh_db", tlsMode: "require" }
  }).then((database) => {
    Object.assign(database, {
      now: () => new Date(NOW),
      loadMigrationCatalog: async () => {
        domainCalls += 1;
        return {
          catalogVersion: "migration-catalog.v1",
          entries: [
            {
              order: 1,
              path: "apps/api/prisma/migrations/20260101000000_first/migration.sql",
              sha256: digest
            }
          ],
          digest
        };
      },
      observeMigrationState: async () => ({
        appliedMigrations: migrated
          ? [
              {
                order: 1,
                path: "apps/api/prisma/migrations/20260101000000_first/migration.sql",
                sha256: digest
              }
            ]
          : [],
        migrationHead: migrated ? "20260101000000_first" : null,
        databaseIdentityFingerprint: database.databaseIdentityFingerprint,
        schemaOwner: "schema_owner"
      }),
      observeSchema: async () => ({
        appliedMigrations: [
          {
            order: 1,
            path: "apps/api/prisma/migrations/20260101000000_first/migration.sql",
            sha256: digest
          }
        ],
        migrationHead: "20260101000000_first",
        schemaDigest: digest,
        schemaOwner: "schema_owner",
        ownerInventory: [{ objectClass: "schema", objectName: "public", owner: "schema_owner" }],
        extensions: ["plpgsql"],
        schemaDiff: { exitCode: 0, stdout: "" },
        statements: [...database.statementLog]
      }),
      withMigrationLock: async (callback) => callback(),
      executePrismaMigrateDeploy: async () => {
        deployCalls += 1;
        migrated = true;
      },
      readToolVersions: async () => ({
        postgresql: "17.11",
        prisma: "prisma : 7.8.0\nengines : test",
        psql: "17.11"
      }),
      manualContext: {
        endpointPolicy,
        approvedClusterObservation: targetContext,
        processEvidence: { kind: "process", sequence: 0 }
      }
    });
    database.domainCalls = () => domainCalls;
    database.deployCalls = () => deployCalls;
    database.simulateDeploy = () => {
      migrated = true;
    };
    return database;
  });
}

test("branded dry-run maps stable domain input and returns a bound observation/result pair", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  const { result, observation: actual } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "RETURNED", result.reasonCode ?? "unexpected outcome");
  assert.equal(result.plan.identity.inputDigest, sha256Canonical(request.domainInput));
  assert.equal(result.observationDigest, sha256Canonical(actual));
  assert.deepEqual(result.statements, runtime.statementLog);
  validateContract("manual-runner-evidence.v1", actual);
  validateContract("manual-runner-evidence.v1", result);
});

test("fresh apply identity changes without changing the approved stable plan", async () => {
  const runtime = await connectedRuntime("migrator");
  const dryRun = manualFixture();
  await runtime.observeIdentity();
  const approvedPlan = await planMigration(runtime, dryRun.request.domainInput);
  const planDigest = (
    await import("@subscription-saas/release-foundation")
  ).deterministicPlanDigest(approvedPlan);
  const apply = manualFixture("apply", { attemptId: uuid(12), approvedPlanDigest: planDigest });
  assert.deepEqual(apply.request.domainInput, dryRun.request.domainInput);
  const { result, observation: after } = await executeManualCommand({
    request: apply.request,
    decision: apply.decision,
    baseline: apply.baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "RETURNED", result.reasonCode ?? "unexpected outcome");
  assert.equal(result.postState.attemptId, apply.request.attemptId);
  assert.equal(result.postState.runId, apply.request.runId);
  assert.equal(after.catalog.migrationRows.length, 1);
  assert.ok(after.schema);
  assert.equal(result.observationDigest, sha256Canonical(after));
  assert.equal(after.schema.statementLogDigest, sha256Canonical(result.statements));
});

test("real runtime apply preserves every version, deploy, diff and script call", async () => {
  const schemaScript = "CREATE TABLE test(id INT);\n";
  const expectedSchemaDigest = sha256Bytes(Buffer.from(schemaScript));
  const planning = await connectedRuntime("migrator");
  await planning.observeIdentity();
  const proposed = manualFixture("dry-run", { expectedSchemaDigest });
  const approvedPlan = await planMigration(planning, proposed.request.domainInput);
  const approvedPlanDigest = (
    await import("@subscription-saas/release-foundation")
  ).deterministicPlanDigest(approvedPlan);
  const { request, decision, baseline } = manualFixture("apply", {
    approvedPlanDigest,
    expectedSchemaDigest
  });
  const database = await connectedRuntime("migrator");
  const calls = [];
  const runtime = createDatabaseRuntimeAdapter({
    database,
    credential: { username: "offline", password: "offline" },
    target: { hostname: "127.0.0.1", port: 5432, databaseName: "fresh_db" },
    repoRoot: fileURLToPath(new URL("../../..", import.meta.url)),
    now: () => new Date(NOW),
    runProcess: async (command, args) => {
      const tool =
        command === "psql"
          ? "psql-version"
          : args.length === 1 && args[0] === "--version"
            ? "prisma-version"
            : args.includes("deploy")
              ? "prisma-deploy"
              : args.includes("--script")
                ? "prisma-script"
                : "prisma-diff";
      calls.push(tool);
      if (tool === "prisma-deploy") database.simulateDeploy();
      return {
        exitCode: 0,
        signal: null,
        stdout:
          tool === "prisma-version"
            ? "prisma : 7.8.0\nengines : test\n"
            : tool === "psql-version"
              ? "psql (PostgreSQL) 17.11\n"
              : tool === "prisma-script"
                ? schemaScript
                : "",
        stderr: ""
      };
    }
  });
  runtime.loadMigrationCatalog = planning.loadMigrationCatalog;
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "RETURNED", result.reasonCode ?? "unexpected outcome");
  assert.equal(current.schema.statementLogDigest, sha256Canonical(result.statements));
  assert.deepEqual(calls, [
    "prisma-version",
    "psql-version",
    "prisma-deploy",
    "prisma-version",
    "psql-version",
    "prisma-diff",
    "prisma-script",
    "prisma-version",
    "psql-version",
    "prisma-diff",
    "prisma-script"
  ]);
});

test("apply plan drift returns a THREW result with the real observation and no deploy", async () => {
  const { request, decision, baseline } = manualFixture("apply", {
    approvedPlanDigest: `sha256:${"f".repeat(64)}`
  });
  const runtime = await connectedRuntime("migrator");
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "PLAN_CHANGED_SINCE_APPROVAL");
  assert.equal(result.observationDigest, sha256Canonical(current));
  assert.equal(runtime.deployCalls(), 0);
});

test("reconcile preserves full current catalog when schema verification throws", async () => {
  const { request, decision, baseline } = manualFixture("reconcile");
  const runtime = await connectedRuntime("migrator");
  runtime.simulateDeploy();
  runtime.observeSchema = async () => ({
    appliedMigrations: [],
    migrationHead: null,
    schemaDigest: digest,
    schemaOwner: "schema_owner",
    ownerInventory: [],
    extensions: ["plpgsql"],
    schemaDiff: { exitCode: 2, stdout: "drift" },
    statements: [...runtime.statementLog]
  });
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "MIGRATION_HEAD_INCOMPLETE");
  assert.equal(current.catalog.migrationRows.length, 1);
  assert.equal(current.schema, null);
  assert.equal(result.observationDigest, sha256Canonical(current));
  assert.equal(result.originalExecutionRecordDigest, request.predecessorExecutionRecordDigest);
});

test("apply preserves a valid returned postState and changed catalog if final verification throws", async () => {
  const runtime = await connectedRuntime("migrator");
  await runtime.observeIdentity();
  const proposal = manualFixture();
  const plan = await planMigration(runtime, proposal.request.domainInput);
  const planDigest = (
    await import("@subscription-saas/release-foundation")
  ).deterministicPlanDigest(plan);
  const { request, decision, baseline } = manualFixture("apply", {
    approvedPlanDigest: planDigest
  });
  const realObserveSchema = runtime.observeSchema;
  let schemaCalls = 0;
  runtime.observeSchema = async () => {
    schemaCalls += 1;
    if (schemaCalls === 2) throw Object.assign(new Error("permission denied"), { code: "42501" });
    return realObserveSchema();
  };
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(schemaCalls, 2);
  assert.equal(runtime.deployCalls(), 1);
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "MANUAL_COMMAND_FAILED");
  assert.equal(result.postState.attemptId, request.attemptId);
  assert.equal(result.postState.runId, request.runId);
  assert.equal(current.catalog.migrationRows.length, 1);
  assert.equal(current.schema, null);
  assert.equal(result.observationDigest, sha256Canonical(current));
  assert.equal(Object.hasOwn(result, "committed"), false);
  validateContract("manual-runner-evidence.v1", result);
});

test("SQLSTATE handler failure keeps a schema-valid THREW result and prior observation", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  runtime.loadMigrationCatalog = async () => {
    throw Object.assign(new Error("permission denied"), { code: "42501" });
  };
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "MANUAL_COMMAND_FAILED");
  assert.equal(result.observationDigest, sha256Canonical(current));
  validateContract("manual-runner-evidence.v1", result);
});

test("invalid schema output keeps the prior valid catalog observation", async () => {
  const { request, decision, baseline } = manualFixture("verify");
  const runtime = await connectedRuntime("verifier");
  runtime.readToolVersions = async () => ({
    postgresql: "17.11",
    prisma: "p".repeat(1_048_577),
    psql: "17.11"
  });
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(current.schema, null);
  assert.equal(result.observationDigest, sha256Canonical(current));
  validateContract("manual-runner-evidence.v1", current);
  validateContract("manual-runner-evidence.v1", result);
});

test("invalid plan output becomes THREW without leaking an invalid plan artifact", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  runtime.readToolVersions = async () => ({
    postgresql: "17.11",
    prisma: "p".repeat(1_048_577),
    psql: "17.11"
  });
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.plan, null);
  assert.equal(result.observationDigest, sha256Canonical(current));
  validateContract("manual-runner-evidence.v1", result);
});

for (const [phase, role] of [
  ["verify", "verifier"],
  ["replay", "migrator"],
  ["reconcile", "migrator"]
]) {
  test(`${phase} observes changed catalog under its approved role without using old prestate as a veto`, async () => {
    const runtime = await connectedRuntime(role);
    runtime.simulateDeploy();
    const { request, decision, baseline } = manualFixture(phase);
    const { result, observation: current } = await executeManualCommand({
      request,
      decision,
      baseline,
      database: runtime,
      runtime
    });
    assert.equal(result.outcome, "RETURNED", result.reasonCode ?? "unexpected outcome");
    assert.equal(current.catalog.migrationRows.length, 1);
    assert.ok(current.schema);
    assert.equal(current.schema.statementLogDigest, sha256Canonical(result.statements));
    assert.equal(
      result.originalExecutionRecordDigest,
      ["replay", "reconcile"].includes(phase) ? request.predecessorExecutionRecordDigest : null
    );
    assert.equal(Object.hasOwn(result, "committed"), false);
  });
}

for (const [name, role, change] of [
  ["role", "verifier", {}],
  ["TLS", "migrator", { tls: false }],
  ["database OID", "migrator", { databaseOid: "999" }],
  ["system identifier", "migrator", { systemIdentifier: "999" }],
  ["server endpoint", "migrator", { serverAddress: "172.19.0.9" }]
]) {
  test(`branded command rejects actual ${name} before migration planner/deploy`, async () => {
    const { request, decision, baseline } = manualFixture();
    const runtime = await connectedRuntime(role, change);
    const { result, observation: current } = await executeManualCommand({
      request,
      decision,
      baseline,
      database: runtime,
      runtime
    });
    assert.equal(result.outcome, "THREW");
    assert.equal(result.reasonCode, "MANUAL_CLUSTER_IDENTITY_MISMATCH");
    assert.equal(result.observationDigest, null);
    assert.equal(current, null);
    validateContract("manual-runner-evidence.v1", result);
    assert.equal(runtime.domainCalls(), 0);
    assert.equal(runtime.deployCalls(), 0);
  });
}

test("identity query failure produces THREW without fabricating an observation", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  runtime.observeIdentity = async () => {
    throw Object.assign(new Error("permission denied"), { code: "42501" });
  };
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "MANUAL_COMMAND_FAILED");
  assert.equal(result.observationDigest, null);
  assert.equal(current, null);
  assert.equal(runtime.domainCalls(), 0);
  assert.equal(runtime.deployCalls(), 0);
});

test("branded command rejects a modified baseline before any database query", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  const modified = {
    ...baseline,
    identity: { ...baseline.identity, preStateDigest: `sha256:${"f".repeat(64)}` }
  };
  await assert.rejects(
    () =>
      executeManualCommand({ request, decision, baseline: modified, database: runtime, runtime }),
    { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
  );
  assert.deepEqual(runtime.statementLog, []);
});

test("fresh dry-run rejects live prestate drift before planner", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator", { schemaOwner: "other_owner" });
  const { result, observation: current } = await executeManualCommand({
    request,
    decision,
    baseline,
    database: runtime,
    runtime
  });
  assert.equal(result.outcome, "THREW");
  assert.equal(result.reasonCode, "MANUAL_BASELINE_STATE_CHANGED");
  assert.equal(current.catalog.schemaOwner, "other_owner");
  assert.equal(result.observationDigest, sha256Canonical(current));
  assert.equal(runtime.domainCalls(), 0);
});

test("missing H3 readback rejects before database access", async () => {
  const { request, decision, baseline } = manualFixture();
  const runtime = await connectedRuntime("migrator");
  runtime.manualContext = {
    ...runtime.manualContext,
    approvedClusterObservation: { ...targetContext, h3Readback: undefined }
  };
  await assert.rejects(() =>
    executeManualCommand({ request, decision, baseline, database: runtime, runtime })
  );
  assert.deepEqual(runtime.statementLog, []);
});

for (const extra of [{ credentials: ["migrate", "verify"] }, { cloudApproved: true }]) {
  test(`manual adapter rejects unauthorized extra input ${Object.keys(extra)[0]}`, async () => {
    const { request, decision, baseline } = manualFixture();
    const runtime = await connectedRuntime("migrator");
    await assert.rejects(
      () =>
        executeManualCommand({ request, decision, baseline, database: runtime, runtime, ...extra }),
      { code: "MANUAL_COMMAND_INPUT_INVALID" }
    );
    assert.deepEqual(runtime.statementLog, []);
  });
}

test("real local Prisma 7.8 version report survives runtime plan and schema mapping intact", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const prismaRoot = fileURLToPath(new URL("../node_modules/prisma/", import.meta.url));
  const prismaPackage = JSON.parse(readFileSync(path.join(prismaRoot, "package.json"), "utf8"));
  assert.equal(prismaPackage.version, "7.8.0");
  const emptyCwd = path.join(
    repoRoot,
    "node_modules/.cache/sdd/2026-09-06-stage1-r2-runner-migrate-verify-plan/prisma-empty-cwd"
  );
  mkdirSync(emptyCwd, { recursive: true });
  const invocation = spawnSync(
    process.execPath,
    [path.join(prismaRoot, "build/index.js"), "--version"],
    {
      cwd: emptyCwd,
      env: { CI: "1", NO_COLOR: "1", PRISMA_DISABLE_UPDATE_CHECK: "1", SystemRoot: "C:\\Windows" },
      encoding: null,
      timeout: 30_000,
      windowsHide: true
    }
  );
  assert.equal(invocation.status, 0, String(invocation.error?.code ?? "Prisma --version failed"));
  assert.ok(invocation.stdout.length > 256);
  const report = new TextDecoder("utf-8", { fatal: true }).decode(invocation.stdout).trim();
  assert.ok(report.includes("\n"));
  assert.ok(report.includes("7.8.0"));

  const schemaScript = "CREATE TABLE test(id INT);\n";
  const fullCatalog = {
    catalogVersion: "migration-catalog.v1",
    entries: [
      {
        order: 1,
        path: "apps/api/prisma/migrations/20260101000000_first/migration.sql",
        sha256: digest
      }
    ],
    digest
  };
  let applied = false;
  const database = {
    statementLog: [],
    databaseIdentityFingerprint: digest,
    async $queryRawUnsafe(sql) {
      if (sql.includes("to_regclass")) return [{ name: applied ? "_prisma_migrations" : null }];
      if (sql.includes('FROM "public"."_prisma_migrations"'))
        return [{ name: "20260101000000_first", checksum: digest }];
      if (sql.includes("nspowner::regrole") && !sql.includes("FROM pg_class"))
        return [{ owner: "schema_owner" }];
      if (sql.includes("FROM pg_class"))
        return [{ objectClass: "schema", objectName: "public", owner: "schema_owner" }];
      if (sql.includes("FROM pg_extension")) return [{ name: "plpgsql" }];
      if (sql === "SHOW server_version") return [{ server_version: "17.11" }];
      throw new Error(`UNEXPECTED_SQL:${sql}`);
    }
  };
  const runtime = createDatabaseRuntimeAdapter({
    database,
    credential: { username: "offline", password: "offline" },
    target: { hostname: "127.0.0.1", port: 5432, databaseName: "offline" },
    repoRoot,
    runProcess: async (command, args) => {
      if (args.length === 1 && args[0] === "--version") {
        return {
          exitCode: 0,
          signal: null,
          stdout: command === "psql" ? "psql (PostgreSQL) 17.11\n" : report + "\n",
          stderr: ""
        };
      }
      if (args.includes("--script"))
        return { exitCode: 0, signal: null, stdout: schemaScript, stderr: "" };
      if (args.includes("--exit-code"))
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      throw new Error("UNEXPECTED_PROCESS");
    }
  });
  runtime.loadMigrationCatalog = async () => fullCatalog;
  const domain = {
    databaseIdentityFingerprint: digest,
    baselineManifestIdentityDigest: digest,
    baselineManifestDigest: digest,
    expectedSchemaDigest: sha256Bytes(Buffer.from(schemaScript)),
    expectedOwner: "schema_owner",
    allowedExtensions: ["plpgsql"]
  };
  const plan = await planMigration(runtime, domain);
  assert.equal(plan.provenance.toolVersions.prisma, report);
  validateContract("manual-runner-evidence.v1", {
    schemaVersion: "manual-runner-evidence.v1",
    recordedAt: NOW,
    promotionEligible: false,
    kind: "schema-expectation",
    buildProofDigest: digest,
    sourceSchemaDigest: digest,
    prismaVersion: report,
    script: { digest: domain.expectedSchemaDigest, bytes: Buffer.byteLength(schemaScript) },
    sourceSchemaPath: "apps/api/prisma/schema.prisma"
  });
  applied = true;
  const schema = await verifySchema(runtime, domain);
  assert.equal(schema.toolVersions.prisma, report);
  assert.equal(schema.schemaDigest, domain.expectedSchemaDigest);
});
