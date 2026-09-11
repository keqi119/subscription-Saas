import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { deterministicPlanDigest } from "../src/proof-builders.mjs";
import { validateContract } from "../src/schema-registry.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const D = "sha256:" + "a".repeat(64);
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const currentKeys = generateKeyPairSync("ed25519");
const signDomain = (body, domain) =>
  sign(
    null,
    Buffer.from(`subscription-saas/${domain}/v1\n${canonicalJson(body)}`),
    currentKeys.privateKey
  ).toString("base64");
const legacyPolicy = Object.freeze({
  profileBytes: null,
  recordSchema: "manual-operation-record.v1",
  retentionDays: 180
});
const requestPolicies = new WeakMap();
function profile90() {
  return {
    schemaVersion: "manual-stage1-profile.v2",
    profileId: uuid(90),
    ownerId: "test-owner",
    publicKeyPem: currentKeys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: `sha256:${createHash("sha256")
      .update(currentKeys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`,
    validFrom: time(-1000),
    expiresAt: time(10000),
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
    allowedTargets: [
      {
        endpointPolicyId: "test-endpoint",
        endpoint: "db.invalid:5432",
        databaseName: "test-db",
        purposes: ["synthetic-fresh", "staging-mainline"],
        roles: { observer: "test-observer", migrate: "test-migrate", verify: "test-verify" },
        tls: "required"
      }
    ],
    storage: {
      keyRoot: "/manual/keys",
      keyRef: "owner.key",
      journalRoot: "/manual/journal",
      archiveRoot: "/manual/archive",
      backupRoot: "/independent/backup",
      credentialRoot: "/manual/credentials",
      retentionDays: 90
    }
  };
}
function current90Policy() {
  const profileBytes = encodeManualJson(profile90());
  return Object.freeze({
    profileBytes,
    recordSchema: "manual-operation-record.v2",
    retentionDays: 90
  });
}
function policyFor(request) {
  return requestPolicies.get(request) ?? legacyPolicy;
}
function profileInput(request) {
  const profileBytes = policyFor(request).profileBytes;
  return profileBytes ? { profileBytes } : {};
}
function requestFixture(phase = "target-observe", policy = legacyPolicy) {
  const request = {
    schemaVersion: "manual-runner-request.v1",
    attemptId: uuid(1),
    runId: uuid(2),
    attemptAllocationDigest: D,
    profileDigest: policy.profileBytes ? sha256Bytes(policy.profileBytes) : D,
    ownerId: "test-owner",
    sessionId: uuid(3),
    sessionNonce: "b".repeat(64),
    operationId: uuid(4),
    idempotencyKey: "test-operation",
    purpose: "synthetic-fresh",
    targetIntent: { endpointPolicyId: "test-endpoint", databaseName: "test-db" },
    stage: "target-observe",
    capability: "verify"
  };
  requestPolicies.set(request, policy);
  if (phase === "target-observe") return request;
  const physicalIdentity = { ...request.targetIntent, databaseOid: "123", clusterFingerprint: D };
  const role = phase === "verify" ? "test-verify" : "test-migrate";
  Object.assign(request, {
    stage: "runner-command",
    phase,
    capability: phase === "verify" ? "verify" : "migrate",
    commandId: phase === "verify" ? "db.schema.verify" : "db.migrate.deploy",
    commandVersion: "1",
    buildProofDigest: D,
    baselineManifestDigest: D,
    targetObservationDigest: D,
    physicalIdentity,
    roleObservation: { role, tls: true, schemaObservationDigest: D },
    containerId: "c".repeat(64),
    runnerImageDigest: D,
    childChallenge: "d".repeat(64),
    expectedSchemaEvidenceDigest: D,
    domainInput: {
      databaseIdentityFingerprint: sha256Canonical({
        databaseName: "test-db",
        databaseOid: "123",
        role,
        tls: true
      }),
      baselineManifestIdentityDigest: D,
      baselineManifestDigest: D,
      expectedSchemaDigest: D,
      expectedOwner: "test-owner",
      allowedExtensions: ["plpgsql"]
    }
  });
  if (phase === "apply") Object.assign(request, { dryRunRecordDigest: D, approvedPlanDigest: D });
  if (["replay", "reconcile"].includes(phase))
    Object.assign(request, {
      predecessorExecutionRecordDigest: D,
      originalIdempotencyKey: request.idempotencyKey
    });
  return request;
}
import {
  assessManualRunnerEvidence,
  validateManualRunnerRequest,
  encodeManualRunnerFrame,
  parseManualRunnerFrames,
  validateManualRunnerProtocol
} from "../src/manual-runner-evidence.mjs";

test("does not replace missing originals with a caller commit claim", () => {
  assert.throws(() => validateManualRunnerRequest({ committed: true }));
  assert.throws(() =>
    assessManualRunnerEvidence({
      requestBytes: Buffer.from("{}"),
      artifactBytes: [],
      rawBlobs: []
    })
  );
});

for (const phase of ["target-observe", "dry-run", "apply", "verify", "replay", "reconcile"]) {
  test(`complete ${phase} request passes, missing required identity and extra claims fail`, () => {
    const request = requestFixture(phase);
    assert.equal(validateManualRunnerRequest(request), undefined);
    for (const key of Object.keys(request).filter(
      (k) => k !== "predecessorExecutionRecordDigest" || ["replay", "reconcile"].includes(phase)
    )) {
      const missing = structuredClone(request);
      delete missing[key];
      assert.throws(
        () => validateManualRunnerRequest(missing),
        { code: "CONTRACT_SCHEMA_INVALID" },
        `missing ${phase}.${key}`
      );
    }
    assert.throws(() => validateManualRunnerRequest({ ...request, committed: true }), {
      code: "CONTRACT_SCHEMA_INVALID"
    });
  });
}

test("expected capability fingerprint is not the observer fingerprint", () => {
  const request = requestFixture("dry-run");
  request.domainInput.databaseIdentityFingerprint = sha256Canonical({
    databaseName: "test-db",
    databaseOid: "123",
    role: "test-observer",
    tls: true
  });
  assert.throws(() => validateManualRunnerRequest(request), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("request rejects cross-stage inputs and over-limit actual JSON bytes", () => {
  assert.throws(
    () =>
      validateManualRunnerRequest({
        ...requestFixture(),
        domainInput: requestFixture("verify").domainInput
      }),
    { code: "CONTRACT_SCHEMA_INVALID" }
  );
  assert.throws(
    () =>
      assessManualRunnerEvidence({
        requestBytes: Buffer.alloc(1048577),
        artifactBytes: [],
        rawBlobs: []
      }),
    { code: "MANUAL_JSON_LIMIT" }
  );
});

const time = (n) => new Date(Date.UTC(2026, 8, 8) + n * 1000).toISOString();
const sessionKeys = ["sessionId", "sessionNonce"];
const operationKeys = ["operationId", "idempotencyKey"];
const aKeys = ["profileDigest", ...sessionKeys, ...operationKeys, "attemptId", "runId"];
const pick = (value, keys) => Object.fromEntries(keys.map((k) => [k, value[k]]));
// Independent wire fixture encoder: expected framing is not computed by the codec under test.
function fixtureFrame({ type, sequence, payload }) {
  const bytes = encodeManualJson(payload);
  return Buffer.concat([Buffer.from(`MS1 ${type} ${sequence} ${bytes.length}\n`), bytes]);
}
function archiveFixture(policy = legacyPolicy) {
  const artifacts = new Map(),
    raws = new Map();
  return {
    artifacts,
    raws,
    add(value) {
      const digest = sha256Canonical(value);
      artifacts.set(digest, value);
      return digest;
    },
    raw(bytes) {
      const digest = sha256Bytes(bytes);
      raws.set(digest, bytes);
      return { digest, bytes: bytes.length };
    },
    input(request) {
      return {
        ...profileInput(request),
        requestBytes: encodeManualJson(request),
        artifactBytes: [...artifacts.values()].map(encodeManualJson),
        rawBlobs: [...raws.values()]
      };
    }
  };
}
function record(request, kind, n, fields) {
  return {
    schemaVersion: policyFor(request).recordSchema,
    kind,
    profileDigest: request.profileDigest,
    recordedAt: time(n),
    promotionEligible: false,
    ...fields
  };
}
function evidence(request, kind, n, fields) {
  return {
    schemaVersion: "manual-runner-evidence.v1",
    kind,
    recordedAt: time(n),
    promotionEligible: false,
    ...pick(request, aKeys),
    ...fields
  };
}
function consumeFixture(
  archive,
  request,
  n = 0,
  existingSession = null,
  existingRevocation = null
) {
  const session =
    existingSession ??
    record(request, "session", n, {
      ...pick(request, sessionKeys),
      ownerId: request.ownerId,
      targetIntent: request.targetIntent,
      status: "OPEN",
      openedAt: time(n),
      previousSessionRecordDigest: null,
      reasonCode: null
    });
  const revocation =
    existingRevocation ??
    record(request, "revocation", n, {
      ownerId: request.ownerId,
      sequence: 0,
      previousRevocationDigest: null,
      action: "GENESIS",
      authorizationId: null,
      reasonCode: null
    });
  const payload = { ...request };
  for (const k of [
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete payload[k];
  Object.assign(payload, {
    schemaVersion: "manual-launch-authorization.v1",
    authorizationId: uuid(n + 500),
    issuedAt: time(n + 5),
    expiresAt: time(n + 120),
    requestDigest: archive.add(request)
  });
  const authorization = {
    payload,
    signature: policyFor(request).profileBytes
      ? signDomain(payload, "manual-launch")
      : Buffer.alloc(64, 7).toString("base64")
  };
  const consumption = record(request, "consumption", n + 6, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    ownerId: request.ownerId,
    authorizationDigest: archive.add(authorization),
    requestDigest: archive.add(request),
    stage: request.stage,
    sessionRecordDigest: archive.add(session),
    revocationRecordDigest: archive.add(revocation),
    revocationSequence: 0,
    status: "CONSUMED"
  });
  archive.add(consumption);
  return { session, revocation, authorization, consumption };
}
function observeFixture(options = {}) {
  const policy = options.policy ?? legacyPolicy,
    archive = archiveFixture(policy),
    request = requestFixture("target-observe", policy);
  const allocation = evidence(request, "attempt-allocation", 1, {
    stage: "target-observe",
    phaseKey: "target-observe",
    allocatedAt: time(1),
    targetIntent: request.targetIntent,
    predecessorExecutionRecordDigest: null
  });
  request.attemptAllocationDigest = archive.add(allocation);
  const prior = consumeFixture(archive, request);
  const catalog = {
    migrationTableOid: null,
    migrationRows: [],
    schemaOwner: "test-owner",
    ownerInventory: [],
    extensions: ["plpgsql"],
    postgresqlVersion: "17.0"
  };
  const observation = evidence(request, "observation", 10, {
    requestDigest: archive.add(request),
    observedAt: time(10),
    physicalIdentity: { ...request.targetIntent, databaseOid: "123", clusterFingerprint: D },
    roleObservation: {
      role: "test-observer",
      tls: true,
      schemaObservationDigest: sha256Canonical(catalog)
    },
    catalog,
    schema: null,
    processEvidenceDigest: null
  });
  const result = evidence(request, "manual-command-result", 11, {
    requestDigest: archive.add(request),
    phaseKey: options.resultPhase ?? "target-observe",
    attemptAllocationDigest: request.attemptAllocationDigest,
    startedAt: time(7),
    finishedAt: time(11),
    outcome: "RETURNED",
    reasonCode: null,
    plan: null,
    postState: null,
    observationDigest: archive.add(observation),
    processEvidenceDigest: null,
    statements: ["SELECT current_database()"],
    originalExecutionRecordDigest: null
  });
  archive.add(result);
  const post = record(request, "post-state", 12, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    requestDigest: archive.add(request),
    consumptionRecordDigest: sha256Canonical(prior.consumption),
    outcome: "OBSERVED",
    observationDigest: archive.add(observation),
    observedAt: time(10),
    reasonCode: null
  });
  if (!options.missingPost) archive.add(post);
  return { archive, request, allocation, ...prior, catalog, observation, result, post };
}

test("complete consumed observe chain succeeds without invented runner or fingerprint preimages", () => {
  const f = observeFixture();
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.deepEqual(actual, {
    attemptId: uuid(1),
    phaseKey: "target-observe",
    executionStatus: "SUCCEEDED",
    originalDatabaseOutcome: "not-applicable",
    reasonCode: null,
    planDigest: null,
    proofDigest: sha256Canonical(f.result),
    promotionEligible: false
  });
  assert.equal(Object.isFrozen(actual), true);
});

test("observe result phase mismatch is rejected and missing post-state is unknown", () => {
  const wrong = observeFixture({ resultPhase: "verify" });
  assert.throws(() => assessManualRunnerEvidence(wrong.archive.input(wrong.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  const missing = observeFixture({ missingPost: true });
  assert.equal(
    assessManualRunnerEvidence(missing.archive.input(missing.request)).executionStatus,
    "INTERRUPTED_UNKNOWN"
  );
});

function custodyFixture(archive, request, subject, purpose, n) {
  const custody = record(request, "custody", n, {
    ownerId: request.ownerId,
    subjectDigest: archive.add(subject),
    subjectType: subject.schemaVersion === "manual-runner-evidence.v1" ? "r2-artifact" : "record",
    purpose,
    outcome: "MATCH",
    observedDigest: archive.add(subject),
    observedAt: time(n),
    storageRole:
      purpose === "consumption-readback"
        ? "journal"
        : purpose === "backup-readback"
          ? "backup"
          : "archive",
    retentionDays: policyFor(request).retentionDays,
    reasonCode: null
  });
  archive.add(custody);
  return custody;
}
function buildFixture(f, prismaReport = null) {
  const { archive } = f;
  const entries = [1, 2].map((n) => ({
    order: n,
    path: `apps/api/prisma/migrations/2026090800000${n}_step${n}/migration.sql`,
    sha256: archive.raw(Buffer.from(`CREATE TABLE test_${n}(id int);`)).digest
  }));
  const catalog = {
    catalogVersion: "migration-catalog.v1",
    entries,
    digest: sha256Canonical({ catalogVersion: "migration-catalog.v1", entries })
  };
  archive.add(catalog);
  const sourceSha = "e".repeat(40);
  const build = {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: Object.fromEntries(
        ["api", "web", "runner"].map((name) => [
          name,
          {
            name,
            registry: "test.invalid/release",
            platform: "linux/amd64",
            imageDigest: D,
            sourceRevision: sourceSha
          }
        ])
      ),
      sourceSha,
      migrationCatalogDigest: catalog.digest,
      repositoryContractDigest: D
    },
    provenance: {
      generatedAt: time(0),
      ciRunRef: "offline-fixture",
      attestationRef: "offline-fixture",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: D }],
      materials: [{ name: "source", reference: sourceSha }],
      registryResolutionEvidenceDigest: D
    }
  };
  const buildProofDigest = archive.add(build);
  const report =
    prismaReport ??
    "prisma : 7.8.0\n" + "fixed complete version output field : offline test value\n".repeat(6);
  const expectation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "schema-expectation",
    recordedAt: time(2),
    promotionEligible: false,
    buildProofDigest,
    sourceSchemaDigest: archive.raw(Buffer.from("model Test { id Int @id }\n")).digest,
    prismaVersion: report.trim(),
    script: archive.raw(
      Buffer.from("CREATE TABLE test_1(id int);\nCREATE TABLE test_2(id int);\n")
    ),
    sourceSchemaPath: "apps/api/prisma/schema.prisma"
  };
  archive.add(expectation);
  const baseline = {
    schemaVersion: "manual-baseline-manifest.v1",
    identity: {
      buildProofDigest,
      purpose: f.request.purpose,
      targetObservationDigest: archive.add(f.observation),
      physicalIdentity: f.observation.physicalIdentity,
      roleObservation: f.observation.roleObservation,
      preStateDigest: sha256Canonical(f.catalog),
      authorizationDigest: archive.add(f.authorization)
    },
    createdAt: time(14),
    promotionEligible: false
  };
  archive.add(baseline);
  return { build, migrationCatalog: catalog, report, expectation, baseline };
}
function runnerFixture(phase = "dry-run", previous = null, options = {}) {
  const root = previous?.root ?? observeFixture({ policy: options.policy });
  const shared = previous?.shared ?? buildFixture(root, options.report);
  const { archive } = root;
  const expectation = options.expectationScript
    ? { ...shared.expectation, script: archive.raw(Buffer.from(options.expectationScript)) }
    : shared.expectation;
  const step = { "dry-run": 1, apply: 2, verify: 3, replay: 4, reconcile: 5 }[phase];
  const n = 20 + step * 100;
  const request = requestFixture(phase, policyFor(root.request));
  Object.assign(request, {
    attemptId: uuid(100 + step),
    physicalIdentity: root.observation.physicalIdentity,
    buildProofDigest: archive.add(shared.build),
    baselineManifestDigest: archive.add(shared.baseline),
    targetObservationDigest: archive.add(root.observation),
    roleObservation: {
      role: phase === "verify" ? "test-verify" : "test-migrate",
      tls: true,
      schemaObservationDigest: sha256Canonical(root.catalog)
    },
    expectedSchemaEvidenceDigest: archive.add(expectation),
    containerId: String(step).repeat(64),
    childChallenge: String(step + 1).repeat(64)
  });
  request.domainInput = {
    ...request.domainInput,
    baselineManifestIdentityDigest: sha256Canonical(shared.baseline.identity),
    baselineManifestDigest: request.baselineManifestDigest,
    expectedSchemaDigest: expectation.script.digest,
    ...options.domainDrift
  };
  if (phase === "apply") {
    request.dryRunRecordDigest = archive.add(previous.execution);
    request.approvedPlanDigest = deterministicPlanDigest(previous.result.plan);
  }
  if (["replay", "reconcile"].includes(phase)) {
    request.predecessorExecutionRecordDigest = archive.add(previous.execution);
    request.sessionId = uuid(900 + step);
    request.sessionNonce = String(step + 2).repeat(64);
  }
  if (options.changedSession) request.sessionId = uuid(999);
  if (phase === "verify" && previous)
    request.predecessorExecutionRecordDigest = archive.add(previous.execution);
  if (options.freshVerifyOperation) {
    request.operationId = uuid(880);
    request.idempotencyKey = "fresh-read-only-verification";
  }
  const allocation = evidence(request, "attempt-allocation", n, {
    stage: request.stage,
    phaseKey: phase,
    allocatedAt: time(n),
    targetIntent: request.targetIntent,
    predecessorExecutionRecordDigest:
      request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null
  });
  request.attemptAllocationDigest = archive.add(allocation);
  const events = [],
    stdoutFrames = [],
    parentFrames = [],
    liveInputs = [];
  let binding = null,
    lastAck = null;
  const frame = (type, payload) => {
    const bytes = fixtureFrame({ type, sequence: stdoutFrames.length, payload });
    stdoutFrames.push(bytes);
    return bytes;
  };
  const ref = (bytes) => archive.raw(bytes);
  const stdoutBytes = () => Buffer.concat(stdoutFrames);
  let last = null;
  function snapshot(t, digest = archive.add(request), closedAt = null) {
    const process = evidence(request, "process", t, {
      attemptAllocationDigest: request.attemptAllocationDigest,
      requestDigest: digest,
      previousProcessEvidenceDigest: last ? archive.add(last) : null,
      events: structuredClone(events),
      closedAt,
      protocol: { stdoutPrefix: ref(stdoutBytes()), parentFrames: parentFrames.map(ref) }
    });
    archive.add(process);
    last = process;
    return process;
  }
  const docker = {
    command: "docker",
    args: [
      "run",
      "--interactive",
      "--network",
      "test-internal",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      `test.invalid/release@${D}`
    ]
  };
  const runnerArgv = archive.raw(encodeManualJson(docker)).digest;
  function event(tool, status, t, processSequence, argvDigest, fields = {}) {
    events.push({
      sequence: events.length,
      processSequence,
      source: tool === "runner" ? "parent" : "runner",
      tool,
      event: status,
      at: time(t),
      containerId: tool === "runner" && status === "PREPARED" ? null : request.containerId,
      pid: null,
      argvDigest,
      exitCode: null,
      signal: null,
      reasonCode: null,
      stdout: null,
      stderr: null,
      ...fields
    });
  }
  event("runner", "PREPARED", n + 1, 0, runnerArgv);
  const nullRoot = snapshot(n + 1, null);
  event("runner", "SPAWNED", n + 2, 0, runnerArgv, {
    pid: 1000 + step,
    containerId: options.initialContainerId ?? request.containerId
  });
  frame("CHALLENGE", { childChallenge: request.childChallenge });
  snapshot(n + 2, null);
  const bound = snapshot(n + 3);
  const prior = consumeFixture(
    archive,
    request,
    n,
    ["replay", "reconcile"].includes(phase) || options.changedSession ? null : root.session,
    root.revocation
  );
  if (options.beforeCredential) {
    custodyFixture(archive, request, prior.consumption, "consumption-readback", n + 6);
    event("runner", "DISPATCH_CLOSED", n + 7, 0, null, { reasonCode: "MANUAL_PREFLIGHT_REJECTED" });
    snapshot(n + 7);
    event("runner", "CLOSED", n + 8, 0, runnerArgv, {
      pid: 1000 + step,
      exitCode: 1,
      stdout: ref(
        options.wrongClosedStdout ? Buffer.from("different actual stdout") : stdoutBytes()
      ),
      stderr: archive.raw(Buffer.alloc(0))
    });
    const finalProcess = snapshot(n + 8, archive.add(request), time(n + 8));
    const execution = record(request, "execution", n + 9, {
      ...pick(request, [...sessionKeys, ...operationKeys]),
      attemptId: request.attemptId,
      requestDigest: archive.add(request),
      authorizationDigest: archive.add(prior.authorization),
      consumptionRecordDigest: archive.add(prior.consumption),
      handoffRecordDigest: null,
      handoffReadbackDigest: null,
      postStateRecordDigest: null,
      predecessorExecutionRecordDigest: request.dryRunRecordDigest,
      startedAt: null,
      finishedAt: time(n + 8),
      status: "INTERRUPTED_UNKNOWN",
      reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
      resultDigest: null,
      processEvidenceDigest: archive.add(finalProcess)
    });
    archive.add(execution);
    return {
      root,
      shared,
      archive,
      request,
      allocation,
      ...prior,
      nullRoot,
      bound,
      finalProcess,
      execution
    };
  }
  const consumptionReadback = custodyFixture(
    archive,
    request,
    prior.consumption,
    "consumption-readback",
    n + 7
  );
  const handoff = record(request, "consumption-handoff", n + 8, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    authorizationDigest: archive.add(prior.authorization),
    requestDigest: archive.add(request),
    containerId: request.containerId,
    runnerImageDigest: request.runnerImageDigest,
    childChallenge: request.childChallenge,
    consumptionRecordDigest: archive.add(prior.consumption),
    consumptionReadbackDigest: archive.add(consumptionReadback),
    revocationSequence: 0,
    issuedAt: time(n + 8),
    expiresAt: time(n + 38),
    signature: Buffer.alloc(64, 8).toString("base64")
  });
  if (policyFor(request).profileBytes) {
    const body = { ...handoff };
    delete body.signature;
    handoff.signature = signDomain(body, "manual-consumption");
  }
  archive.add(handoff);
  const handoffReadback = custodyFixture(archive, request, handoff, "handoff-readback", n + 9);
  const processReadback = custodyFixture(archive, request, bound, "archive-readback", n + 4);
  const authorizeBytes = fixtureFrame({
    type: "AUTHORIZE",
    sequence: 0,
    payload: {
      launchContext: pick(request, ["containerId", "runnerImageDigest"]),
      allocation,
      request,
      authorization: prior.authorization,
      receipt: handoff,
      baseline: shared.baseline,
      process: bound,
      processReadback
    }
  });
  parentFrames.push(authorizeBytes);
  binding = {
    ...pick(request, [
      ...aKeys,
      "attemptAllocationDigest",
      "containerId",
      "runnerImageDigest",
      "childChallenge"
    ]),
    requestDigest: archive.add(request),
    authorizationDigest: archive.add(prior.authorization)
  };
  frame("READY", { binding, authorizeFrame: ref(authorizeBytes) });
  frame("CREDENTIAL_RECEIVED", { binding, authorizeFrame: ref(authorizeBytes) });
  function acknowledgedEvent(t) {
    const e = events.at(-1),
      previous = last;
    const payload = { binding, previousAck: lastAck ? ref(lastAck) : null, event: e };
    if (e.event !== "PREPARED")
      Object.assign(payload, {
        stdoutBase64: e.stdout ? archive.raws.get(e.stdout.digest).toString("base64") : null,
        stderrBase64: e.stderr ? archive.raws.get(e.stderr.digest).toString("base64") : null
      });
    const childFrame = frame(e.event === "PREPARED" ? "PREPARED" : "EVENT", payload);
    const subject = snapshot(t),
      readback = custodyFixture(archive, request, subject, "archive-readback", t);
    const ack = fixtureFrame({
      type: "ACK",
      sequence: parentFrames.length + 1,
      payload: {
        binding,
        acknowledgedFrame:
          options.wrongOriginalAck && e.tool === "prisma-deploy" && e.event === "PREPARED"
            ? ref(stdoutFrames[0])
            : ref(childFrame),
        subject: { kind: "process", process: subject },
        readback
      }
    });
    liveInputs.push({
      mode: "live-ack",
      ...profileInput(request),
      requestBytes: encodeManualJson(request),
      authorizationBytes: encodeManualJson(prior.authorization),
      previousProcessBytes: encodeManualJson(previous),
      childFrameBytes: childFrame,
      ackFrameBytes: ack,
      stdoutPrefixBytes: stdoutBytes(),
      parentFrameBytes: [...parentFrames]
    });
    parentFrames.push(ack);
    lastAck = ack;
  }
  if (options.zeroTools) {
    const result = evidence(request, "manual-command-result", n + 11, {
      requestDigest: archive.add(request),
      phaseKey: phase,
      attemptAllocationDigest: request.attemptAllocationDigest,
      startedAt: null,
      finishedAt: time(n + 11),
      outcome: "THREW",
      reasonCode: "MANUAL_HANDLER_REJECTED",
      plan: null,
      postState: null,
      observationDigest: null,
      processEvidenceDigest: archive.add(bound),
      statements: [],
      originalExecutionRecordDigest: null
    });
    archive.add(result);
    event("runner", "DISPATCH_CLOSED", n + 12, 0, null, { source: "runner" });
    acknowledgedEvent(n + 12);
    frame("ACK_RECEIVED", { binding, previousAck: ref(lastAck) });
    frame("RESULT", result);
    event("runner", "CLOSED", n + 13, 0, runnerArgv, {
      pid: 1000 + step,
      exitCode: 1,
      stdout: ref(stdoutBytes()),
      stderr: archive.raw(Buffer.alloc(0))
    });
    const finalProcess = snapshot(n + 13, archive.add(request), time(n + 13));
    return { root, shared, archive, request, ...prior, bound, result, finalProcess, liveInputs };
  }
  const config = "/app/apps/api/prisma.config.ts",
    schemaPath = "/app/apps/api/prisma/schema.prisma";
  const calls = [
    [
      "prisma-version",
      ["--version"],
      Buffer.from(options.truncatedReport ? shared.report.slice(0, 256) : shared.report)
    ],
    ["psql-version", ["--version"], Buffer.from("psql (PostgreSQL) 17.0\n")]
  ];
  if (phase === "apply" && !options.noDeploy)
    calls.push([
      "prisma-deploy",
      ["migrate", "deploy", "--schema", schemaPath, "--config", config],
      Buffer.from("2 migrations applied\n")
    ]);
  if (phase !== "dry-run")
    calls.push(
      [
        "prisma-script",
        [
          "migrate",
          "diff",
          "--from-empty",
          "--to-config-datasource",
          "--script",
          "--config",
          config
        ],
        archive.raws.get(expectation.script.digest)
      ],
      [
        "prisma-diff",
        [
          "migrate",
          "diff",
          "--from-config-datasource",
          "--to-schema",
          schemaPath,
          "--exit-code",
          "--config",
          config
        ],
        Buffer.from(options.diffOutput ?? "")
      ]
    );
  let t = n + 10;
  for (const [index, [tool, args, stdout]] of calls.entries()) {
    const argv = archive.raw(
      encodeManualJson({
        command:
          tool === "psql-version" ? "psql" : "/app/apps/release-runner/node_modules/.bin/prisma",
        args
      })
    ).digest;
    event(tool, "PREPARED", t++, index + 1, argv);
    acknowledgedEvent(t - 1);
    event(tool, "SPAWNED", t++, index + 1, argv, { pid: 2000 + index });
    acknowledgedEvent(t - 1);
    event(tool, "CLOSED", t++, index + 1, argv, {
      pid: 2000 + index,
      exitCode: tool === "prisma-deploy" ? (options.deployExit ?? 0) : 0,
      stdout: archive.raw(stdout),
      stderr: archive.raw(Buffer.from(""))
    });
    acknowledgedEvent(t - 1);
  }
  const process = last;
  const entries = shared.migrationCatalog.entries;
  const catalog = structuredClone(root.catalog);
  if (options.domainDrift?.expectedOwner) catalog.schemaOwner = options.domainDrift.expectedOwner;
  if (options.domainDrift?.allowedExtensions)
    catalog.extensions = [...options.domainDrift.allowedExtensions];
  if (phase !== "dry-run" && !options.emptyRows) {
    catalog.migrationTableOid = "456";
    catalog.migrationRows = entries.slice(0, options.partial ? 1 : 2).map((entry, i) => ({
      id: `row-${i}`,
      migrationName: entry.path.split("/").at(-2),
      checksum: entry.sha256,
      startedAt: time(phase === "apply" ? n + 17 : 237),
      finishedAt: options.unfinished ? null : time(phase === "apply" ? n + 18 : 238),
      rolledBackAt: options.rolledBack ? time(n + 19 + i) : null,
      appliedStepsCount: 1
    }));
  }
  const statements = [
    "SELECT current_database()",
    ...(options.partialResultUtf8 ? ["SELECT '测试'"] : [])
  ];
  const versions = {
    postgresql: "17.0",
    prisma: shared.report.trim(),
    psql: "psql (PostgreSQL) 17.0"
  };
  const schema =
    phase === "dry-run" || options.emptyRows
      ? null
      : {
          schemaVersion: "schema-observation.v1",
          catalogDigest: shared.migrationCatalog.digest,
          migrationHead: entries.at(-1).path.split("/").at(-2),
          migrationChecksums: entries,
          schemaDigest: expectation.script.digest,
          schemaOwner: catalog.schemaOwner,
          ownerInventory: [],
          extensions: catalog.extensions,
          schemaDiff: { exitCode: 0, stdout: "" },
          toolVersions: versions,
          statementLogDigest: sha256Canonical(statements),
          terminalStatus: "PASSED"
        };
  const observation = evidence(request, "observation", n + 40, {
    requestDigest: archive.add(request),
    observedAt: time(n + 40),
    physicalIdentity: request.physicalIdentity,
    roleObservation: {
      role: request.roleObservation.role,
      tls: true,
      schemaObservationDigest: sha256Canonical(catalog)
    },
    catalog,
    schema,
    processEvidenceDigest: archive.add(process)
  });
  const observationFrame = frame("OBSERVATION", {
    binding,
    previousAck: ref(lastAck),
    observation
  });
  const observationReadback = custodyFixture(
    archive,
    request,
    observation,
    "archive-readback",
    n + 40
  );
  const observationAck = fixtureFrame({
    type: "ACK",
    sequence: parentFrames.length + 1,
    payload: {
      binding,
      acknowledgedFrame: ref(observationFrame),
      subject: { kind: "observation", observation },
      readback: observationReadback
    }
  });
  liveInputs.push({
    mode: "live-ack",
    ...profileInput(request),
    requestBytes: encodeManualJson(request),
    authorizationBytes: encodeManualJson(prior.authorization),
    previousProcessBytes: encodeManualJson(process),
    childFrameBytes: observationFrame,
    ackFrameBytes: observationAck,
    stdoutPrefixBytes: stdoutBytes(),
    parentFrameBytes: [...parentFrames]
  });
  parentFrames.push(observationAck);
  lastAck = observationAck;
  const plan =
    phase === "dry-run"
      ? {
          schemaVersion: "deterministic-plan.v1",
          identity: {
            planType: "migration-plan.v1",
            commandKey: "db.migrate.deploy@1",
            inputDigest: sha256Canonical(request.domainInput),
            ...pick(request.domainInput, [
              "databaseIdentityFingerprint",
              "baselineManifestIdentityDigest",
              "baselineManifestDigest",
              "expectedSchemaDigest",
              "expectedOwner",
              "allowedExtensions"
            ]),
            migrationCatalogDigest: shared.migrationCatalog.digest,
            currentMigrationHead: null,
            pendingMigrations: entries,
            expectedPostMigrationHead: entries.at(-1).path.split("/").at(-2),
            expectedWriteScope: ["_prisma_migrations", "schema-ddl"]
          },
          provenance: { planner: "db.migrate.deploy@1", toolVersions: versions }
        }
      : null;
  const postconditions = [
    ["migration-head-equals-catalog-head", schema?.migrationHead],
    ["schema-diff-zero", { exitCode: 0, stdout: "" }],
    ["schema-owner-matches", "test-owner"],
    ["extensions-allowed", ["plpgsql"]]
  ].map(([id, value]) => ({
    id,
    status: "PASSED",
    expectedDigest: sha256Canonical(value ?? null),
    actualDigest: sha256Canonical(value ?? null)
  }));
  const postState =
    phase === "apply"
      ? {
          schemaVersion: "post-state-observation.v1",
          ...pick(request, ["operationId", "attemptId", "runId"]),
          ...pick(request.domainInput, [
            "baselineManifestIdentityDigest",
            "baselineManifestDigest",
            "databaseIdentityFingerprint"
          ]),
          commandId: request.commandId,
          commandVersion: "1",
          planDigest: request.approvedPlanDigest,
          postMigrationHead: schema.migrationHead,
          postSchemaDigest: schema.schemaDigest,
          configurationFingerprint: sha256Canonical({
            schemaOwner: schema.schemaOwner,
            extensions: schema.extensions,
            toolVersions: schema.toolVersions
          }),
          postconditions,
          observedAt: time(n + 40)
        }
      : null;
  if (options.emptyPostconditions) postState.postconditions = [];
  const result = evidence(request, "manual-command-result", n + 41, {
    requestDigest: archive.add(request),
    phaseKey: phase,
    attemptAllocationDigest: request.attemptAllocationDigest,
    startedAt: time(n + 10),
    finishedAt: time(n + 41),
    outcome: "RETURNED",
    reasonCode: null,
    plan,
    postState,
    observationDigest: archive.add(observation),
    processEvidenceDigest: archive.add(process),
    statements,
    originalExecutionRecordDigest: ["replay", "reconcile"].includes(phase)
      ? archive.add(previous.execution)
      : null
  });
  if (!options.missingResult) archive.add(result);
  event("runner", "DISPATCH_CLOSED", n + 42, 0, null, { source: "runner" });
  acknowledgedEvent(n + 42);
  frame("ACK_RECEIVED", { binding, previousAck: ref(lastAck) });
  if (!options.missingResult) frame("RESULT", result);
  if (options.partialResultUtf8) {
    const resultFrame = fixtureFrame({
      type: "RESULT",
      sequence: stdoutFrames.length,
      payload: result
    });
    stdoutFrames.push(resultFrame.subarray(0, resultFrame.indexOf(Buffer.from("测试")) + 2));
  }
  if (options.malformedPartialResult)
    stdoutFrames.push(Buffer.from(`MS1 RESULT ${stdoutFrames.length} 100\n!]`));
  if (!options.missingClose)
    event("runner", "CLOSED", n + 43, 0, runnerArgv, {
      pid: 1000 + step,
      exitCode: 0,
      stdout: ref(
        options.wrongClosedStdout ? Buffer.from("different actual stdout") : stdoutBytes()
      ),
      stderr: archive.raw(Buffer.from(""))
    });
  const finalProcess = options.missingClose
    ? last
    : snapshot(n + 43, archive.add(request), time(n + 43));
  const post = record(request, "post-state", n + 44, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    requestDigest: archive.add(request),
    consumptionRecordDigest: archive.add(prior.consumption),
    outcome: "OBSERVED",
    observationDigest: archive.add(observation),
    observedAt: observation.observedAt,
    reasonCode: null
  });
  if (!options.missingPost) archive.add(post);
  const execution = record(request, "execution", n + 45, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    attemptId: request.attemptId,
    requestDigest: archive.add(request),
    authorizationDigest: archive.add(prior.authorization),
    consumptionRecordDigest: archive.add(prior.consumption),
    handoffRecordDigest: archive.add(handoff),
    handoffReadbackDigest: archive.add(handoffReadback),
    postStateRecordDigest: options.missingPost ? null : archive.add(post),
    predecessorExecutionRecordDigest:
      request.dryRunRecordDigest ?? request.predecessorExecutionRecordDigest ?? null,
    startedAt: result.startedAt,
    finishedAt: options.missingClose ? null : finalProcess.closedAt,
    status: options.unknown ? "INTERRUPTED_UNKNOWN" : "SUCCEEDED",
    reasonCode: options.unknown ? "MANUAL_COMMIT_ATTRIBUTION_UNAVAILABLE" : null,
    resultDigest: options.missingResult ? null : archive.add(result),
    processEvidenceDigest: archive.add(finalProcess)
  });
  archive.add(execution);
  custodyFixture(archive, request, execution, "archive-readback", n + 46);
  custodyFixture(archive, request, execution, "backup-readback", n + 47);
  return {
    root,
    shared,
    archive,
    request,
    allocation,
    ...prior,
    handoff,
    handoffReadback,
    nullRoot,
    bound,
    process,
    finalProcess,
    observation,
    result,
    post,
    execution,
    stdoutFrames,
    parentFrames,
    liveInputs
  };
}

function fixture90(phase = "dry-run", previous = null, options = {}) {
  return runnerFixture(phase, previous, { ...options, policy: current90Policy() });
}

test("object-valued profile version stays a structural error in archive assessor and live ACK", () => {
  const current = fixture90();
  const profile = profile90();
  profile.schemaVersion = { toString: null };
  const profileBytes = encodeManualJson(profile);
  const archiveInput = { ...current.archive.input(current.request), profileBytes };
  for (const run of [assessManualRunnerEvidence, validateManualRunnerProtocol])
    assert.throws(() => run(archiveInput), { code: "CONTRACT_SCHEMA_INVALID" });
  assert.throws(
    () => validateManualRunnerProtocol({ ...current.liveInputs.at(-1), profileBytes }),
    { code: "CONTRACT_SCHEMA_INVALID" }
  );
});

test("bound 90-day profile accepts the complete v2 archive and every live ACK", () => {
  const current = fixture90();
  const newInput = current.archive.input(current.request);
  assert.equal(
    verify(
      null,
      Buffer.from(
        `subscription-saas/manual-launch/v1\n${canonicalJson(current.authorization.payload)}`
      ),
      currentKeys.publicKey,
      Buffer.from(current.authorization.signature, "base64")
    ),
    true
  );
  const receiptBody = { ...current.handoff };
  delete receiptBody.signature;
  assert.equal(
    verify(
      null,
      Buffer.from(`subscription-saas/manual-consumption/v1\n${canonicalJson(receiptBody)}`),
      currentKeys.publicKey,
      Buffer.from(current.handoff.signature, "base64")
    ),
    true
  );
  assert.equal(assessManualRunnerEvidence(newInput).executionStatus, "SUCCEEDED");
  assert.equal(validateManualRunnerProtocol(newInput), undefined);
  for (const live of current.liveInputs)
    assert.equal(validateManualRunnerProtocol(live), undefined);
});

test("bound v2 policy survives observe dry-run apply verify replay and reconcile routing", () => {
  const dry = fixture90();
  const apply = fixture90("apply", dry);
  const verifyCurrent = fixture90("verify", apply);
  const replay = fixture90("replay", apply);
  const recoveryDry = fixture90();
  const uncertainApply = fixture90("apply", recoveryDry, {
    unknown: true,
    missingResult: true,
    deployExit: 1
  });
  const reconcile = fixture90("reconcile", uncertainApply);
  for (const current of [dry.root, dry, apply, verifyCurrent, replay, reconcile]) {
    const input = current.archive.input(current.request);
    assert.equal(assessManualRunnerEvidence(input).executionStatus, "SUCCEEDED");
    assert.equal(validateManualRunnerProtocol(input), undefined);
  }
});

test("an unlinked opposite-version historical session does not select current policy", () => {
  for (const [current, historicalSchema] of [
    [runnerFixture(), "manual-operation-record.v2"],
    [fixture90(), "manual-operation-record.v1"]
  ]) {
    current.archive.add({
      schemaVersion: historicalSchema,
      kind: "session",
      profileDigest: `sha256:${"f".repeat(64)}`,
      recordedAt: time(-50),
      promotionEligible: false,
      sessionId: uuid(700),
      sessionNonce: "e".repeat(64),
      ownerId: "independent-history-owner",
      targetIntent: { endpointPolicyId: "history-endpoint", databaseName: "history-db" },
      status: "OPEN",
      openedAt: time(-50),
      previousSessionRecordDigest: null,
      reasonCode: null
    });
    assert.equal(
      assessManualRunnerEvidence(current.archive.input(current.request)).executionStatus,
      "SUCCEEDED"
    );
  }
});

test("v2 archive requires present canonical profile bytes bound to the request", () => {
  const current = fixture90();
  const newInput = current.archive.input(current.request);
  const absent = { ...newInput };
  delete absent.profileBytes;
  for (const input of [absent, { ...newInput, profileBytes: undefined }]) {
    assert.throws(() => validateManualRunnerProtocol(input), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
    assert.throws(() => assessManualRunnerEvidence(input), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
  }
  for (const profileBytes of [
    Buffer.from([0xff]),
    Buffer.from(JSON.stringify(profile90(), null, 2), "utf8")
  ])
    for (const run of [validateManualRunnerProtocol, assessManualRunnerEvidence])
      assert.throws(() => run({ ...newInput, profileBytes }), {
        code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
      });
  const wrongProfile = profile90();
  wrongProfile.profileId = uuid(91);
  for (const run of [validateManualRunnerProtocol, assessManualRunnerEvidence])
    assert.throws(() => run({ ...newInput, profileBytes: encodeManualJson(wrongProfile) }), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
  const malformedProfile = profile90();
  malformedProfile.storage.retentionDays = 180;
  assert.throws(
    () =>
      validateManualRunnerProtocol({
        ...newInput,
        profileBytes: encodeManualJson(malformedProfile)
      }),
    { code: "CONTRACT_SCHEMA_INVALID" }
  );
  assert.throws(
    () => validateManualRunnerProtocol({ ...newInput, profileBytes: Buffer.alloc(1048577) }),
    { code: "MANUAL_JSON_LIMIT" }
  );
});

test("profile input remains inert closed own data", () => {
  const current = fixture90();
  const newInput = current.archive.input(current.request);
  let getterCalled = false;
  const accessorInput = { ...newInput };
  Object.defineProperty(accessorInput, "profileBytes", {
    enumerable: true,
    get() {
      getterCalled = true;
      return newInput.profileBytes;
    }
  });
  for (const run of [validateManualRunnerProtocol, assessManualRunnerEvidence])
    assert.throws(() => run(accessorInput), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
  assert.equal(getterCalled, false);
  for (const run of [validateManualRunnerProtocol, assessManualRunnerEvidence])
    assert.throws(() => run({ ...newInput, [Symbol("extra")]: true }), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
});

test("v2 archive and live ACK both reject a linked v1 record", () => {
  const mixedArchive = fixture90();
  const backup = [...mixedArchive.archive.artifacts.values()].find(
    (value) =>
      value.kind === "custody" &&
      value.purpose === "backup-readback" &&
      value.subjectDigest === sha256Canonical(mixedArchive.execution)
  );
  backup.schemaVersion = "manual-operation-record.v1";
  backup.retentionDays = 180;
  assert.throws(
    () => validateManualRunnerProtocol(mixedArchive.archive.input(mixedArchive.request)),
    { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
  );

  const current = fixture90();
  const live = current.liveInputs.at(-1);
  const headerEnd = live.ackFrameBytes.indexOf(10);
  const [type, sequence] = live.ackFrameBytes
    .subarray(0, headerEnd)
    .toString("ascii")
    .split(" ")
    .slice(1, 3);
  const payload = JSON.parse(live.ackFrameBytes.subarray(headerEnd + 1).toString("utf8"));
  payload.readback.schemaVersion = "manual-operation-record.v1";
  payload.readback.retentionDays = 180;
  assert.throws(
    () =>
      validateManualRunnerProtocol({
        ...live,
        ackFrameBytes: fixtureFrame({ type, sequence: Number(sequence), payload })
      }),
    { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
  );
});

test("v2 live ACK requires the same bound profile bytes as archive assessment", () => {
  const current = fixture90();
  const live = current.liveInputs.at(-1);
  const absent = { ...live };
  delete absent.profileBytes;
  assert.throws(() => validateManualRunnerProtocol(absent), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  assert.throws(() => validateManualRunnerProtocol({ ...live, profileBytes: undefined }), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  const wrongProfile = profile90();
  wrongProfile.profileId = uuid(92);
  assert.throws(
    () => validateManualRunnerProtocol({ ...live, profileBytes: encodeManualJson(wrongProfile) }),
    { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
  );
  for (const profileBytes of [
    Buffer.from([0xff]),
    Buffer.from(JSON.stringify(profile90(), null, 2), "utf8")
  ])
    assert.throws(() => validateManualRunnerProtocol({ ...live, profileBytes }), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
});

test("legacy policy rejects v2 custody and cannot let a receipt choose its own version", () => {
  const custody90 = runnerFixture();
  const backup = [...custody90.archive.artifacts.values()].find(
    (value) =>
      value.kind === "custody" &&
      value.purpose === "backup-readback" &&
      value.subjectDigest === sha256Canonical(custody90.execution)
  );
  backup.schemaVersion = "manual-operation-record.v2";
  backup.retentionDays = 90;
  assert.throws(() => assessManualRunnerEvidence(custody90.archive.input(custody90.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });

  const receiptVersion = runnerFixture();
  const unauthorized = structuredClone(receiptVersion.handoff);
  unauthorized.schemaVersion = "manual-operation-record.v2";
  receiptVersion.archive.add(unauthorized);
  assert.throws(
    () => assessManualRunnerEvidence(receiptVersion.archive.input(receiptVersion.request)),
    { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
  );
});

test("complete dry-run and apply use stable domain input and fresh attempts", () => {
  const dry = runnerFixture();
  const actual = assessManualRunnerEvidence(dry.archive.input(dry.request));
  assert.equal(actual.executionStatus, "SUCCEEDED");
  assert.equal(actual.planDigest, deterministicPlanDigest(dry.result.plan));
  const apply = runnerFixture("apply", dry);
  assert.deepEqual(apply.request.domainInput, dry.request.domainInput);
  assert.notEqual(apply.request.attemptId, dry.request.attemptId);
  assert.deepEqual(assessManualRunnerEvidence(apply.archive.input(apply.request)), {
    attemptId: apply.request.attemptId,
    phaseKey: "apply",
    executionStatus: "SUCCEEDED",
    originalDatabaseOutcome: "committed",
    reasonCode: null,
    planDigest: deterministicPlanDigest(dry.result.plan),
    proofDigest: sha256Canonical(apply.result),
    promotionEligible: false
  });
});

test("wrong raw diff output cannot satisfy a reported PASSED schema", () => {
  const f = runnerFixture("verify", null, { diffOutput: "x" });
  assert.throws(() => assessManualRunnerEvidence(f.archive.input(f.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("MS1 preserves exact bytes and permits every incomplete challenge split", () => {
  const payload = { childChallenge: "b".repeat(64) };
  const expectedPayload = Buffer.from('{"childChallenge":"' + "b".repeat(64) + '"}');
  const expected = Buffer.concat([
    Buffer.from(`MS1 CHALLENGE 0 ${expectedPayload.length}\n`),
    expectedPayload
  ]);
  const encoded = encodeManualRunnerFrame({ type: "CHALLENGE", sequence: 0, payload });
  assert.deepEqual(encoded, expected);
  for (let i = 0; i < encoded.length; i++) {
    const parsed = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: encoded.subarray(0, i),
      ended: false
    });
    assert.equal(parsed.frames.length, 0);
    assert.deepEqual(parsed.pendingBytes, encoded.subarray(0, i));
  }
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: encoded,
    ended: true
  });
  assert.equal(parsed.frames.length, 1);
  assert.deepEqual(parsed.frames[0].payloadBytes, expectedPayload);
  assert.deepEqual(parsed.frames[0].frameBytes, encoded);
});

test("MS1 rejects malformed headers, closed payloads, direction and half-frame EOF", () => {
  const good = encodeManualRunnerFrame({
    type: "CHALLENGE",
    sequence: 0,
    payload: { childChallenge: "b".repeat(64) }
  });
  for (const prefix of [
    "MS2 ",
    "MS1  ",
    "MS1 UNKNOWN ",
    "MS1 CHALLENGE 00 ",
    "MS1 CHALLENGE 0 01\n",
    "MS1 CHALLENGE 0 10000000\n"
  ]) {
    assert.throws(
      () =>
        parseManualRunnerFrames({
          direction: "child-to-parent",
          bytes: Buffer.from(prefix),
          ended: false
        }),
      { code: "MANUAL_FRAME_INVALID" }
    );
  }
  assert.throws(
    () => parseManualRunnerFrames({ direction: "parent-to-child", bytes: good, ended: true }),
    { code: "MANUAL_FRAME_INVALID" }
  );
  assert.throws(
    () =>
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: good.subarray(0, -1),
        ended: true
      }),
    { code: "MANUAL_FRAME_INCOMPLETE" }
  );
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "CHALLENGE",
        sequence: 0,
        payload: { childChallenge: "b".repeat(64), containerId: "c".repeat(64) }
      }),
    { code: "MANUAL_FRAME_INVALID" }
  );
  assert.throws(
    () =>
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: Buffer.alloc(1048577),
        ended: false
      }),
    { code: "MANUAL_OUTPUT_LIMIT" }
  );
});

test("process schema requires the closed archive protocol shape", () => {
  const request = requestFixture("dry-run");
  const process = evidence(request, "process", 1, {
    attemptAllocationDigest: D,
    requestDigest: null,
    previousProcessEvidenceDigest: null,
    events: [],
    closedAt: null
  });
  assert.throws(() => validateContract("manual-runner-evidence.v1", process), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
  process.protocol = {
    stdoutPrefix: { digest: sha256Bytes(Buffer.alloc(0)), bytes: 0 },
    parentFrames: []
  };
  assert.equal(validateContract("manual-runner-evidence.v1", process), undefined);
});

test("live PREPARED ACK validates before any successor result or close exists", () => {
  const f = runnerFixture();
  const live = f.liveInputs[0];
  assert.equal(validateManualRunnerProtocol(live), undefined);
  assert.equal(
    validateManualRunnerProtocol(
      f.liveInputs.find(
        (i) =>
          parseManualRunnerFrames({
            direction: "child-to-parent",
            bytes: i.stdoutPrefixBytes,
            ended: false
          }).frames.at(-1).type === "OBSERVATION"
      )
    ),
    undefined
  );
  const wrong = { ...live, ackFrameBytes: f.liveInputs[1].ackFrameBytes };
  assert.throws(() => validateManualRunnerProtocol(wrong), { code: "MANUAL_FRAME_ORDER_INVALID" });
});

test("archive validates full challenge, tool ACKs, observation, unique result and parent close", () => {
  const f = runnerFixture();
  assert.equal(validateManualRunnerProtocol(f.archive.input(f.request)), undefined);
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: f.archive.raws.get(f.finalProcess.protocol.stdoutPrefix.digest),
    ended: true
  });
  assert.equal(parsed.frames[0].type, "CHALLENGE");
  assert.equal(parsed.frames.at(-1).type, "RESULT");
  assert.deepEqual(parsed.frames.at(-1).payloadBytes, encodeManualJson(f.result));
  assert.ok(parsed.frames.length > 10);
  const bad = f.archive.input(f.request);
  bad.rawBlobs = bad.rawBlobs.filter((b) => !b.equals(f.parentFrames[1]));
  assert.throws(() => validateManualRunnerProtocol(bad), {
    code: "MANUAL_EVIDENCE_INPUT_REQUIRED"
  });
});

test("reconcile proves original committed despite missing original result and nonzero deploy exit", () => {
  const dry = runnerFixture(),
    original = runnerFixture("apply", dry, { unknown: true, missingResult: true, deployExit: 1 });
  const current = runnerFixture("reconcile", original);
  assert.deepEqual(assessManualRunnerEvidence(current.archive.input(current.request)), {
    attemptId: current.request.attemptId,
    phaseKey: "reconcile",
    executionStatus: "SUCCEEDED",
    originalDatabaseOutcome: "committed",
    reasonCode: null,
    planDigest: deterministicPlanDigest(dry.result.plan),
    proofDigest: sha256Canonical(current.result),
    promotionEligible: false
  });
});

test("reconcile proves not committed only from actual pre-credential dispatch closure", () => {
  const dry = runnerFixture(),
    original = runnerFixture("apply", dry, { beforeCredential: true });
  const current = runnerFixture("reconcile", original, { emptyRows: true });
  assert.deepEqual(assessManualRunnerEvidence(current.archive.input(current.request)), {
    attemptId: current.request.attemptId,
    phaseKey: "reconcile",
    executionStatus: "SUCCEEDED",
    originalDatabaseOutcome: "not-committed",
    reasonCode: null,
    planDigest: deterministicPlanDigest(dry.result.plan),
    proofDigest: sha256Canonical(current.result),
    promotionEligible: false
  });
});

test("replay missing result retains original committed but marks only current attempt unknown", () => {
  const dry = runnerFixture(),
    original = runnerFixture("apply", dry);
  const current = runnerFixture("replay", original, { unknown: true, missingResult: true });
  const actual = assessManualRunnerEvidence(current.archive.input(current.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.originalDatabaseOutcome, "committed");
  assert.equal(actual.proofDigest, null);
});

test("complete verify and replay have read-only success with no deploy", () => {
  const verify = runnerFixture("verify");
  assert.equal(
    assessManualRunnerEvidence(verify.archive.input(verify.request)).executionStatus,
    "SUCCEEDED"
  );
  const dry = runnerFixture(),
    original = runnerFixture("apply", dry),
    replay = runnerFixture("replay", original);
  const actual = assessManualRunnerEvidence(replay.archive.input(replay.request));
  assert.equal(actual.executionStatus, "SUCCEEDED");
  assert.equal(actual.originalDatabaseOutcome, "committed");
  assert.equal(actual.proofDigest, sha256Canonical(replay.result));
});

test("installed Prisma complete version Report is read with no DB credentials or project config", () => {
  const require = createRequire(import.meta.url);
  const cli = require.resolve("prisma/build/index.js", {
    paths: [path.resolve(import.meta.dirname, "../../../apps/release-runner")]
  });
  const cwd = mkdtempSync(path.join(tmpdir(), "manual-evidence-version-"));
  let bytes;
  try {
    const environment = {
      CI: "true",
      CHECKPOINT_DISABLE: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      FORCE_COLOR: "0"
    };
    for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"])
      if (process.env[key]) environment[key] = process.env[key];
    bytes = execFileSync(process.execPath, [cli, "--version"], {
      cwd,
      env: environment,
      encoding: "buffer",
      timeout: 30000,
      maxBuffer: 1048576,
      windowsHide: true
    });
  } finally {
    rmdirSync(cwd);
  }
  const report = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(bytes.length > 256 && report.split("\n").length > 2);
  assert.match(report, /prisma\s*:\s*7\.8\.0/);
  const fixture = runnerFixture("dry-run", null, { report });
  assert.equal(
    assessManualRunnerEvidence(fixture.archive.input(fixture.request)).executionStatus,
    "SUCCEEDED"
  );
  assert.equal(fixture.result.plan.provenance.toolVersions.prisma, report.trim());
});

test("frame entry rejects accessor and symbol views without invoking them", () => {
  let calls = 0;
  const input = {
    sequence: 0,
    payload: { childChallenge: "b".repeat(64) },
    get type() {
      calls++;
      return "CHALLENGE";
    }
  };
  assert.throws(() => encodeManualRunnerFrame(input), { code: "MANUAL_FRAME_INVALID" });
  assert.equal(calls, 0);
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "CHALLENGE",
        sequence: 0,
        payload: { childChallenge: "b".repeat(64) },
        [Symbol("extra")]: true
      }),
    { code: "MANUAL_FRAME_INVALID" }
  );
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "CHALLENGE",
        sequence: 0,
        payload: { childChallenge: { toString: null } }
      }),
    { code: "MANUAL_FRAME_INVALID" }
  );
});

test("raw outputs have the output limit rather than the independent JSON limit", () => {
  const f = observeFixture(),
    input = f.archive.input(f.request);
  input.rawBlobs = [Buffer.alloc(1048577)];
  assert.throws(() => assessManualRunnerEvidence(input), { code: "MANUAL_OUTPUT_LIMIT" });
});

function fixtureDecode(bytes) {
  const end = bytes.indexOf(10),
    header = bytes.subarray(0, end).toString("ascii").split(" ");
  return {
    type: header[1],
    sequence: Number(header[2]),
    payload: JSON.parse(bytes.subarray(end + 1).toString("utf8"))
  };
}
const refBytes = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
function changedLiveEvent(input, mutate) {
  const child = fixtureDecode(input.childFrameBytes),
    ack = fixtureDecode(input.ackFrameBytes);
  mutate(child.payload.event);
  const childFrameBytes = fixtureFrame(child);
  const stdoutPrefixBytes = Buffer.concat([
    input.stdoutPrefixBytes.subarray(0, -input.childFrameBytes.length),
    childFrameBytes
  ]);
  const subject = ack.payload.subject.process;
  subject.events[subject.events.length - 1] = child.payload.event;
  subject.protocol.stdoutPrefix = refBytes(stdoutPrefixBytes);
  ack.payload.acknowledgedFrame = refBytes(childFrameBytes);
  ack.payload.readback.subjectDigest = sha256Canonical(subject);
  ack.payload.readback.observedDigest = sha256Canonical(subject);
  return { ...input, childFrameBytes, stdoutPrefixBytes, ackFrameBytes: fixtureFrame(ack) };
}

test("live spawn cannot precede previous ACK readback even with internally matching new subject", () => {
  const f = runnerFixture();
  const early = changedLiveEvent(f.liveInputs[1], (event) => {
    event.at = time(129);
  });
  assert.throws(() => validateManualRunnerProtocol(early), { code: "MANUAL_TIME_INVALID" });
});

test("live cannot acknowledge an observation after dispatch closed", () => {
  const f = runnerFixture(),
    dispatch = f.liveInputs.at(-1);
  const dispatchAck = fixtureDecode(dispatch.ackFrameBytes),
    previous = dispatchAck.payload.subject.process;
  const observation = {
    ...f.observation,
    observedAt: time(164),
    recordedAt: time(164),
    processEvidenceDigest: sha256Canonical(previous)
  };
  const childFrameBytes = fixtureFrame({
    type: "OBSERVATION",
    sequence: fixtureDecode(dispatch.childFrameBytes).sequence + 1,
    payload: {
      binding: dispatchAck.payload.binding,
      previousAck: refBytes(dispatch.ackFrameBytes),
      observation
    }
  });
  const parentFrameBytes = [...dispatch.parentFrameBytes, dispatch.ackFrameBytes];
  const readback = record(f.request, "custody", 164, {
    ownerId: f.request.ownerId,
    subjectDigest: sha256Canonical(observation),
    subjectType: "r2-artifact",
    purpose: "archive-readback",
    outcome: "MATCH",
    observedDigest: sha256Canonical(observation),
    observedAt: time(164),
    storageRole: "archive",
    retentionDays: 180,
    reasonCode: null
  });
  const ackFrameBytes = fixtureFrame({
    type: "ACK",
    sequence: parentFrameBytes.length + 1,
    payload: {
      binding: dispatchAck.payload.binding,
      acknowledgedFrame: refBytes(childFrameBytes),
      subject: { kind: "observation", observation },
      readback
    }
  });
  const input = {
    ...dispatch,
    previousProcessBytes: encodeManualJson(previous),
    childFrameBytes,
    ackFrameBytes,
    stdoutPrefixBytes: Buffer.concat([dispatch.stdoutPrefixBytes, childFrameBytes]),
    parentFrameBytes
  };
  assert.throws(() => validateManualRunnerProtocol(input), { code: "MANUAL_FRAME_ORDER_INVALID" });
});

for (const [label, options] of [
  ["partial rows", { partial: true }],
  ["unfinished row", { unfinished: true }],
  ["rolled-back row", { rolledBack: true }],
  ["schema-only unchanged history", { emptyRows: true }]
]) {
  test(`reconcile retains unknown for ${label} after an original dispatched apply`, () => {
    const dry = runnerFixture(),
      original = runnerFixture("apply", dry, { unknown: true, missingResult: true, deployExit: 1 });
    const current = runnerFixture("reconcile", original, options);
    const actual = assessManualRunnerEvidence(current.archive.input(current.request));
    assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
    assert.equal(actual.originalDatabaseOutcome, "unknown");
  });
}

test("replay without actual parent close preserves original committed independently", () => {
  const dry = runnerFixture(),
    original = runnerFixture("apply", dry),
    current = runnerFixture("replay", original, { unknown: true, missingClose: true });
  const actual = assessManualRunnerEvidence(current.archive.input(current.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.originalDatabaseOutcome, "committed");
  assert.equal(actual.proofDigest, sha256Canonical(current.result));
});

test("successful dry-run cannot impersonate an original committed apply for replay", () => {
  const dry = runnerFixture(),
    replay = runnerFixture("replay", dry);
  assert.throws(() => assessManualRunnerEvidence(replay.archive.input(replay.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("apply refuses changing the approved dry-run session", () => {
  const dry = runnerFixture(),
    apply = runnerFixture("apply", dry, { changedSession: true });
  assert.throws(() => assessManualRunnerEvidence(apply.archive.input(apply.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("live ACK refuses missing readback and current ACK in its own process history", () => {
  const f = runnerFixture(),
    live = f.liveInputs[0];
  const missing = fixtureDecode(live.ackFrameBytes);
  missing.payload.readback.outcome = "UNKNOWN";
  missing.payload.readback.reasonCode = "MANUAL_STORAGE_UNVERIFIED";
  assert.throws(
    () => validateManualRunnerProtocol({ ...live, ackFrameBytes: fixtureFrame(missing) }),
    { code: "MANUAL_FRAME_ORDER_INVALID" }
  );
  const self = fixtureDecode(live.ackFrameBytes);
  self.payload.subject.process.protocol.parentFrames.push(refBytes(live.ackFrameBytes));
  self.payload.readback.subjectDigest = sha256Canonical(self.payload.subject.process);
  self.payload.readback.observedDigest = self.payload.readback.subjectDigest;
  assert.throws(
    () => validateManualRunnerProtocol({ ...live, ackFrameBytes: fixtureFrame(self) }),
    { code: "MANUAL_FRAME_ORDER_INVALID" }
  );
  const mixed = { ...live, artifactBytes: [] };
  assert.throws(() => validateManualRunnerProtocol(mixed), { code: "MANUAL_FRAME_INVALID" });
});

test("public parent single-frame sequence excludes secrets and rejects a skipped ACK", () => {
  const f = runnerFixture(),
    live = f.liveInputs[2];
  assert.equal(validateManualRunnerProtocol(live), undefined);
  assert.throws(
    () =>
      validateManualRunnerProtocol({
        ...live,
        parentFrameBytes: [live.parentFrameBytes[0], live.parentFrameBytes[2]]
      }),
    { code: "MANUAL_FRAME_ORDER_INVALID" }
  );
  const credential = fixtureFrame({
    type: "CREDENTIAL",
    sequence: 1,
    payload: {
      binding: fixtureDecode(live.ackFrameBytes).payload.binding,
      credential: "synthetic-test-only"
    }
  });
  assert.throws(
    () =>
      validateManualRunnerProtocol({
        ...live,
        parentFrameBytes: [live.parentFrameBytes[0], credential]
      }),
    { code: "MANUAL_FRAME_INVALID" }
  );
});

function grammarPrefix() {
  const request = requestFixture("dry-run");
  const binding = {
    ...pick(request, [
      ...aKeys,
      "attemptAllocationDigest",
      "containerId",
      "runnerImageDigest",
      "childChallenge"
    ]),
    requestDigest: D,
    authorizationDigest: D,
    idempotencyKey: "离线多字节测试"
  };
  const ref = { digest: D, bytes: 17 };
  return {
    binding,
    ref,
    frames: [
      fixtureFrame({
        type: "CHALLENGE",
        sequence: 0,
        payload: { childChallenge: request.childChallenge }
      }),
      fixtureFrame({ type: "READY", sequence: 1, payload: { binding, authorizeFrame: ref } }),
      fixtureFrame({
        type: "CREDENTIAL_RECEIVED",
        sequence: 2,
        payload: { binding, authorizeFrame: ref }
      })
    ]
  };
}

test("MS1 all UTF-8 split positions and coalesced frames preserve exact boundaries", () => {
  const { frames } = grammarPrefix(),
    bytes = Buffer.concat(frames);
  for (let n = 0; n <= bytes.length; n++) {
    const parsed = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: bytes.subarray(0, n),
      ended: false
    });
    assert.equal(parsed.consumedBytes + parsed.pendingBytes.length, n);
    assert.deepEqual(
      Buffer.concat(parsed.frames.map((f) => f.frameBytes)),
      bytes.subarray(0, parsed.consumedBytes)
    );
  }
  const parsed = parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: true });
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(
    parsed.frames.map((f) => f.frameBytes),
    frames
  );
});

test("MS1 rejects known wrong sequence without waiting for its payload", () => {
  const prefix = grammarPrefix();
  const wrong = fixtureFrame({
    type: "READY",
    sequence: 2,
    payload: { binding: prefix.binding, authorizeFrame: prefix.ref }
  });
  const partial = Buffer.concat([prefix.frames[0], wrong.subarray(0, wrong.indexOf(10) + 2)]);
  assert.throws(
    () => parseManualRunnerFrames({ direction: "child-to-parent", bytes: partial, ended: false }),
    { code: "MANUAL_FRAME_ORDER_INVALID" }
  );
});

test("MS1 rejects invalid UTF-8, noncanonical payload, and nested malformed result", () => {
  for (const bytes of [
    Buffer.from("MS1 CHALLENGE 0 2\n{}"),
    Buffer.concat([Buffer.from("MS1 CHALLENGE 0 1\n"), Buffer.from([255])]),
    Buffer.from("MS1 CHALLENGE 0 4\n{ }\n")
  ]) {
    assert.throws(
      () => parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: true }),
      { code: "MANUAL_FRAME_INVALID" }
    );
  }
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "RESULT",
        sequence: 4,
        payload: { kind: "manual-command-result" }
      }),
    { code: "MANUAL_FRAME_INVALID" }
  );
});

test("MS1 complete RESULT rejects duplicate result and every trailing byte", () => {
  const prefix = grammarPrefix(),
    result = observeFixture().result;
  const frames = [
    ...prefix.frames,
    fixtureFrame({
      type: "ACK_RECEIVED",
      sequence: 3,
      payload: { binding: prefix.binding, previousAck: prefix.ref }
    }),
    fixtureFrame({ type: "RESULT", sequence: 4, payload: result })
  ];
  const bytes = Buffer.concat(frames);
  assert.equal(
    parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: true }).frames.length,
    5
  );
  for (const trailing of [Buffer.from("\n"), Buffer.from("log"), Buffer.from(" ")])
    assert.throws(
      () =>
        parseManualRunnerFrames({
          direction: "child-to-parent",
          bytes: Buffer.concat([bytes, trailing]),
          ended: false
        }),
      { code: "MANUAL_FRAME_INVALID" }
    );
  assert.throws(
    () =>
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: Buffer.concat([bytes, frames.at(-1)]),
        ended: true
      }),
    { code: "MANUAL_HANDOFF_REUSED" }
  );
});

test("MS1 header and base64 overhead count toward frame and whole stream limits", () => {
  const { binding } = grammarPrefix();
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "CREDENTIAL",
        sequence: 1,
        payload: { binding, credential: "x".repeat(1048576) }
      }),
    { code: "MANUAL_OUTPUT_LIMIT" }
  );
  const raw = Buffer.alloc(786432, 120),
    ref = refBytes(raw);
  const event = {
    sequence: 4,
    processSequence: 1,
    source: "runner",
    tool: "prisma-script",
    event: "CLOSED",
    at: time(1),
    containerId: binding.containerId,
    pid: 1,
    argvDigest: D,
    exitCode: 0,
    signal: null,
    reasonCode: null,
    stdout: ref,
    stderr: refBytes(Buffer.alloc(0))
  };
  assert.throws(
    () =>
      encodeManualRunnerFrame({
        type: "EVENT",
        sequence: 5,
        payload: {
          binding,
          previousAck: { digest: D, bytes: 1 },
          event,
          stdoutBase64: raw.toString("base64"),
          stderrBase64: ""
        }
      }),
    { code: "MANUAL_OUTPUT_LIMIT" }
  );
});

test("an EOF prefix ending inside UTF-8 remains current UNKNOWN rather than invented result", () => {
  const f = runnerFixture("verify", null, {
    unknown: true,
    missingResult: true,
    partialResultUtf8: true
  });
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.reasonCode, "MANUAL_FRAME_INCOMPLETE");
  assert.equal(actual.proofDigest, null);
});

test("Buffer collections reject accessors without invoking a caller callback", () => {
  const f = observeFixture(),
    input = f.archive.input(f.request);
  let calls = 0;
  Object.defineProperty(input.rawBlobs, "0", {
    enumerable: true,
    get() {
      calls++;
      return Buffer.alloc(0);
    }
  });
  assert.throws(() => assessManualRunnerEvidence(input), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  assert.equal(calls, 0);
});

test("baseline cannot elevate an observation whose target-observe authorization was not consumed", () => {
  const f = runnerFixture(),
    input = f.archive.input(f.request);
  const removed = new Set([sha256Canonical(f.root.consumption), sha256Canonical(f.root.post)]);
  input.artifactBytes = input.artifactBytes.filter((bytes) => !removed.has(sha256Bytes(bytes)));
  assert.throws(() => assessManualRunnerEvidence(input), {
    code: "MANUAL_EVIDENCE_INPUT_REQUIRED"
  });
});

test("typed allocation edges reject a real wrong-kind original and a missing original", () => {
  const f = observeFixture();
  const request = { ...f.request, attemptAllocationDigest: sha256Canonical(f.authorization) };
  assert.throws(() => assessManualRunnerEvidence(f.archive.input(request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  const input = f.archive.input(f.request);
  input.artifactBytes = input.artifactBytes.filter(
    (bytes) => sha256Bytes(bytes) !== f.request.attemptAllocationDigest
  );
  assert.throws(() => assessManualRunnerEvidence(input), {
    code: "MANUAL_EVIDENCE_INPUT_REQUIRED"
  });
});

test("missing process root and handoff readback cannot be replaced by nonempty digests", () => {
  const f = runnerFixture(),
    input = f.archive.input(f.request);
  for (const missing of [sha256Canonical(f.nullRoot), sha256Canonical(f.handoffReadback)]) {
    assert.throws(
      () =>
        assessManualRunnerEvidence({
          ...input,
          artifactBytes: input.artifactBytes.filter((bytes) => sha256Bytes(bytes) !== missing)
        }),
      { code: "MANUAL_EVIDENCE_INPUT_REQUIRED" }
    );
  }
});

test("live checks the single nonce and exact independent launch-context shape", () => {
  const f = runnerFixture(),
    live = f.liveInputs[0];
  for (const change of [
    (p) => {
      p.launchContext.containerId = "f".repeat(64);
    },
    (p) => {
      p.launchContext.runnerImageDigest = "sha256:" + "f".repeat(64);
    }
  ]) {
    const authorize = fixtureDecode(live.parentFrameBytes[0]);
    change(authorize.payload);
    assert.throws(
      () => validateManualRunnerProtocol({ ...live, parentFrameBytes: [fixtureFrame(authorize)] }),
      { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" }
    );
  }
  const missing = fixtureDecode(live.parentFrameBytes[0]);
  delete missing.payload.launchContext.containerId;
  assert.throws(
    () => validateManualRunnerProtocol({ ...live, parentFrameBytes: [fixtureFrame(missing)] }),
    { code: "MANUAL_FRAME_INVALID" }
  );
  const challenge = fixtureDecode(f.stdoutFrames[0]);
  challenge.payload.childChallenge = "f".repeat(64);
  const stdoutPrefixBytes = Buffer.concat([
    fixtureFrame(challenge),
    live.stdoutPrefixBytes.subarray(f.stdoutFrames[0].length)
  ]);
  assert.throws(() => validateManualRunnerProtocol({ ...live, stdoutPrefixBytes }), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("MS1 duplicate one-time challenge is HANDOFF_REUSED even before payload completes", () => {
  const challenge = grammarPrefix().frames[0];
  const bytes = Buffer.concat([challenge, challenge.subarray(0, challenge.indexOf(10) + 2)]);
  assert.throws(
    () => parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: false }),
    { code: "MANUAL_HANDOFF_REUSED" }
  );
});

test("invalid finite artifact timestamp is rejected before any success assertion", () => {
  const f = observeFixture(),
    input = f.archive.input(f.request),
    bad = { ...f.observation, observedAt: "2026-02-30T00:00:00.000Z" };
  input.artifactBytes = input.artifactBytes.filter(
    (b) => sha256Bytes(b) !== sha256Canonical(f.observation)
  );
  input.artifactBytes.push(encodeManualJson(bad));
  assert.throws(() => assessManualRunnerEvidence(input), { code: "MANUAL_TIME_INVALID" });
});

test("foundation public surface exposes the five shared pure functions", async () => {
  const publicApi = await import("../src/index.mjs");
  for (const [name, expected] of Object.entries({
    validateManualRunnerRequest,
    assessManualRunnerEvidence,
    encodeManualRunnerFrame,
    parseManualRunnerFrames,
    validateManualRunnerProtocol
  }))
    assert.equal(publicApi[name], expected);
});

test("zero-tool authorized failure ACK needs no invented observation or prior ACK", () => {
  const f = runnerFixture("verify", null, { zeroTools: true });
  assert.equal(validateManualRunnerProtocol(f.liveInputs[0]), undefined);
  assert.equal(validateManualRunnerProtocol(f.archive.input(f.request)), undefined);
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.equal(actual.executionStatus, "FAILED");
  assert.equal(actual.originalDatabaseOutcome, "not-applicable");
  assert.equal(actual.reasonCode, "MANUAL_HANDLER_REJECTED");
});

test("proved apply commit without R1 post-state custody stays UNKNOWN committed-result-unproved", () => {
  const f = runnerFixture("apply", runnerFixture(), { missingPost: true, unknown: true });
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.originalDatabaseOutcome, "committed");
  assert.equal(actual.reasonCode, "MANUAL_EVIDENCE_INCOMPLETE");
});

test("empty legacy PostState assertions do not prove an apply success", () => {
  const f = runnerFixture("apply", runnerFixture(), { emptyPostconditions: true });
  assert.throws(() => assessManualRunnerEvidence(f.archive.input(f.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("a truncated version stdout cannot satisfy the independent complete Report", () => {
  const f = runnerFixture("dry-run", null, { truncatedReport: true });
  assert.throws(() => assessManualRunnerEvidence(f.archive.input(f.request)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("live rejects contradictory tool sequence and mixed archive keys", () => {
  const f = runnerFixture(),
    live = f.liveInputs[1];
  for (const mutation of [
    (e) => {
      e.processSequence = 2;
    },
    (e) => {
      e.tool = "prisma-deploy";
    }
  ]) {
    assert.throws(() => validateManualRunnerProtocol(changedLiveEvent(live, mutation)), {
      code: "MANUAL_FRAME_ORDER_INVALID"
    });
  }
  assert.throws(() => validateManualRunnerProtocol({ ...live, artifactBytes: [] }), {
    code: "MANUAL_FRAME_INVALID"
  });
});

test("review1 pending decoder immediately rejects invalid UTF-8 and known wrong stage", () => {
  for (const [bytes, code] of [
    [
      Buffer.concat([Buffer.from("MS1 CHALLENGE 0 100\n"), Buffer.from([255])]),
      "MANUAL_FRAME_INVALID"
    ],
    [Buffer.from("MS1 READY 0 100\n{"), "MANUAL_FRAME_ORDER_INVALID"]
  ])
    assert.throws(
      () => parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: false }),
      { code }
    );
  const prefix = grammarPrefix();
  prefix.binding.idempotencyKey = "测试只读";
  const ready = fixtureFrame({
    type: "READY",
    sequence: 1,
    payload: { binding: prefix.binding, authorizeFrame: prefix.ref }
  });
  const partial = ready.subarray(0, ready.indexOf(Buffer.from("测试只读")) + 2);
  const bytes = Buffer.concat([prefix.frames[0], partial]);
  assert.deepEqual(
    parseManualRunnerFrames({ direction: "child-to-parent", bytes, ended: false }).pendingBytes,
    partial
  );
  assert.equal(
    parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: Buffer.concat([prefix.frames[0], ready]),
      ended: true
    }).frames[1].payload.binding.idempotencyKey,
    "测试只读"
  );
});

function firstObservationLive(f, observedAt, recordedAt) {
  const live = f.liveInputs[0],
    oldChild = fixtureDecode(live.childFrameBytes),
    ack = fixtureDecode(live.ackFrameBytes);
  const observation = {
    ...f.observation,
    observedAt,
    recordedAt,
    processEvidenceDigest: sha256Canonical(f.bound)
  };
  const child = {
    type: "OBSERVATION",
    sequence: 3,
    payload: { binding: oldChild.payload.binding, previousAck: null, observation }
  };
  const childFrameBytes = fixtureFrame(child),
    stdoutPrefixBytes = Buffer.concat([
      live.stdoutPrefixBytes.subarray(0, -live.childFrameBytes.length),
      childFrameBytes
    ]);
  ack.payload.acknowledgedFrame = refBytes(childFrameBytes);
  ack.payload.subject = { kind: "observation", observation };
  ack.payload.readback.subjectDigest = sha256Canonical(observation);
  ack.payload.readback.observedDigest = sha256Canonical(observation);
  return { ...live, childFrameBytes, stdoutPrefixBytes, ackFrameBytes: fixtureFrame(ack) };
}

test("review1 first live event respects existing AUTHORIZE readback and handoff times", () => {
  const f = runnerFixture();
  for (const n of [123, 125])
    assert.throws(
      () =>
        validateManualRunnerProtocol(
          changedLiveEvent(f.liveInputs[0], (e) => {
            e.at = time(n);
          })
        ),
      { code: "MANUAL_TIME_INVALID" }
    );
});

test("review1 first observation is valid only after authorization and before its recording", () => {
  const f = runnerFixture();
  assert.equal(
    validateManualRunnerProtocol(firstObservationLive(f, time(130), time(130))),
    undefined
  );
  for (const [observed, recorded] of [
    [123, 130],
    [131, 130]
  ])
    assert.throws(
      () => validateManualRunnerProtocol(firstObservationLive(f, time(observed), time(recorded))),
      { code: "MANUAL_TIME_INVALID" }
    );
});

test("review1 known stage rejects READY before CHALLENGE while payload is partial", () => {
  assert.throws(
    () =>
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: Buffer.from("MS1 READY 0 100\n{"),
        ended: false
      }),
    { code: "MANUAL_FRAME_ORDER_INVALID" }
  );
});

test("review1 handoff floor applies even after the D process was read back", () => {
  const f = runnerFixture();
  assert.throws(
    () =>
      validateManualRunnerProtocol(
        changedLiveEvent(f.liveInputs[0], (e) => {
          e.at = time(125);
        })
      ),
    { code: "MANUAL_TIME_INVALID" }
  );
});

test("review1 observation clock cannot finish after its own archived recording", () => {
  const f = runnerFixture();
  assert.throws(() => validateManualRunnerProtocol(firstObservationLive(f, time(131), time(130))), {
    code: "MANUAL_TIME_INVALID"
  });
});

test("review1 verify predecessor permits its own fresh read-only operation and session", () => {
  const apply = runnerFixture("apply", runnerFixture());
  const f = runnerFixture("verify", apply, { freshVerifyOperation: true, changedSession: true });
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.equal(actual.executionStatus, "SUCCEEDED");
  assert.equal(actual.originalDatabaseOutcome, "not-applicable");
});

for (const [label, options] of [
  ["wrong original ACK target", { wrongOriginalAck: true }],
  ["actual original stdout mismatch", { wrongClosedStdout: true }]
]) {
  test(`review1 reconcile refuses ${label} despite complete new rows`, () => {
    const apply = runnerFixture("apply", runnerFixture(), {
      missingResult: true,
      unknown: true,
      deployExit: 1,
      ...options
    });
    const f = runnerFixture("reconcile", apply);
    const actual = assessManualRunnerEvidence(f.archive.input(f.request));
    assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
    assert.equal(actual.originalDatabaseOutcome, "unknown");
    assert.equal(actual.reasonCode, "MANUAL_FRAME_ORDER_INVALID");
  });
}

test("review1 reconcile accepts validated original protocol ending in partial RESULT UTF-8", () => {
  const apply = runnerFixture("apply", runnerFixture(), {
    missingResult: true,
    unknown: true,
    partialResultUtf8: true,
    deployExit: 1
  });
  const f = runnerFixture("reconcile", apply);
  const actual = assessManualRunnerEvidence(f.archive.input(f.request));
  assert.equal(actual.executionStatus, "SUCCEEDED");
  assert.equal(actual.originalDatabaseOutcome, "committed");
});

test("review2 not-committed requires actual original CLOSED stdout equality before credential refusal", () => {
  const original = runnerFixture("apply", runnerFixture(), {
    beforeCredential: true,
    wrongClosedStdout: true
  });
  const current = runnerFixture("reconcile", original, { emptyRows: true });
  const actual = assessManualRunnerEvidence(current.archive.input(current.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.originalDatabaseOutcome, "unknown");
  assert.equal(actual.reasonCode, "MANUAL_FRAME_ORDER_INVALID");
});

test("review2 committed reconstruction refuses an impossible unfinished RESULT", () => {
  const original = runnerFixture("apply", runnerFixture(), {
    missingResult: true,
    unknown: true,
    deployExit: 1,
    malformedPartialResult: true
  });
  const current = runnerFixture("reconcile", original);
  const actual = assessManualRunnerEvidence(current.archive.input(current.request));
  assert.equal(actual.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(actual.originalDatabaseOutcome, "unknown");
  assert.equal(actual.reasonCode, "MANUAL_FRAME_INVALID");
});

function resultPrefixFixture() {
  const prefix = grammarPrefix();
  prefix.frames.push(
    fixtureFrame({
      type: "ACK_RECEIVED",
      sequence: 3,
      payload: { binding: prefix.binding, previousAck: prefix.ref }
    })
  );
  const result = {
    ...pick(prefix.binding, [...aKeys, "attemptAllocationDigest", "requestDigest"]),
    schemaVersion: "manual-runner-evidence.v1",
    recordedAt: time(150),
    promotionEligible: false,
    kind: "manual-command-result",
    phaseKey: "apply",
    startedAt: null,
    finishedAt: null,
    outcome: "INTERRUPTED",
    reasonCode: null,
    plan: null,
    postState: null,
    observationDigest: null,
    processEvidenceDigest: null,
    statements: ["测试\nvalue"],
    originalExecutionRecordDigest: null
  };
  const payload = encodeManualJson(result);
  return {
    result,
    payload,
    parse(body, length = payload.length) {
      return parseManualRunnerFrames({
        direction: "child-to-parent",
        ended: false,
        bytes: Buffer.concat([...prefix.frames, Buffer.from(`MS1 RESULT 4 ${length}\n`), body])
      });
    }
  };
}

test("review2 RESULT prefixes reject received syntax, canonical, identity and schema contradictions", () => {
  const f = resultPrefixFixture();
  const atValue = (key, suffix) => {
    const text = f.payload.toString("utf8"),
      marker = `"${key}":`;
    return Buffer.from(text.slice(0, text.indexOf(marker) + marker.length) + suffix);
  };
  for (const body of [
    Buffer.from("!]"),
    Buffer.from(" {"),
    Buffer.from('{"unknown":'),
    Buffer.from('{"attemptId":'), // required earlier sorted allocation key skipped
    atValue("promotionEligible", "t"),
    atValue("outcome", '"IMPOSSIBLE'),
    atValue("plan", "{"),
    atValue("attemptId", '"20000000'),
    atValue("attemptId", '"10000000-0000-4000-8000-000000000009"'),
    atValue("postState", "{}"),
    atValue("statements", "[42"),
    atValue("statements", '["\\u0041'),
    atValue("statements", '["\\x'),
    atValue("statements", '["a", ]'),
    atValue("statements", '["a\n'),
    atValue("postState", '{"attemptId":"x"}')
  ])
    assert.throws(() => f.parse(body, 8000), { code: "MANUAL_FRAME_INVALID" }, body.toString());
});

test("review2 RESULT prefixes enforce declared completion budget and fixed terminal remainder", () => {
  const f = resultPrefixFixture();
  assert.throws(() => f.parse(Buffer.from("{"), 5), { code: "MANUAL_FRAME_INVALID" });
  assert.throws(() => f.parse(f.payload.subarray(0, -1), f.payload.length + 5), {
    code: "MANUAL_FRAME_INVALID"
  });
  assert.throws(() => f.parse(f.payload, f.payload.length + 5), { code: "MANUAL_FRAME_INVALID" });
});

test("review2 RESULT genuine canonical JSON and UTF-8 truncations stay pending", () => {
  const f = resultPrefixFixture();
  for (let end = 0; end < f.payload.length; end++) {
    const body = f.payload.subarray(0, end);
    assert.equal(f.parse(body).frames.length, 4);
  }
  assert.equal(f.parse(f.payload).frames.at(-1).payload.kind, "manual-command-result");
});

test("review2 empty statements array remains a viable final two-byte closure", () => {
  const f = resultPrefixFixture(),
    payload = encodeManualJson({ ...f.result, statements: [] });
  assert.equal(f.parse(payload.subarray(0, -2), payload.length).frames.length, 4);
});

test("review2 dry-run plan prefixes preserve bounded integer orders and reject impossible numbers", () => {
  const f = resultPrefixFixture(),
    plan = runnerFixture().result.plan;
  const result = { ...f.result, phaseKey: "dry-run", plan },
    payload = encodeManualJson(result);
  const text = payload.toString("utf8"),
    offset = text.indexOf('"order":') + '"order":'.length;
  for (const token of ["-1", "01", "1e309", "9007199254740992"])
    assert.throws(() => f.parse(Buffer.from(text.slice(0, offset) + token), payload.length + 100), {
      code: "MANUAL_FRAME_INVALID"
    });
  for (const end of [
    offset,
    offset + 1,
    payload.indexOf(Buffer.from('"postState":')),
    payload.length - 1
  ])
    assert.equal(f.parse(payload.subarray(0, end), payload.length).frames.length, 4);
});

test("review2 nested postState identity prefixes cannot contradict the original binding", () => {
  const f = resultPrefixFixture(),
    text = f.payload.toString("utf8"),
    marker = '"postState":';
  const body = Buffer.from(
    text.slice(0, text.indexOf(marker) + marker.length) + '{"attemptId":"20000000'
  );
  assert.throws(() => f.parse(body, 8000), { code: "MANUAL_FRAME_INVALID" });
});

test("review3 unique arrays reject completed duplicate items before closing", () => {
  const f = resultPrefixFixture(),
    plan = runnerFixture().result.plan;
  const text = encodeManualJson({ ...f.result, phaseKey: "dry-run", plan }).toString("utf8");
  const marker = '"allowedExtensions":[',
    head = text.slice(0, text.indexOf(marker) + marker.length);
  for (const suffix of ['"plpgsql","plpgsql"', '"plpgsql","plpgsql",'])
    assert.throws(() => f.parse(Buffer.from(head + suffix), 8000), {
      code: "MANUAL_FRAME_INVALID"
    });
});

test("review3 unique arrays preserve different items and an unfinished matching prefix", () => {
  const f = resultPrefixFixture(),
    plan = runnerFixture().result.plan;
  const text = encodeManualJson({ ...f.result, phaseKey: "dry-run", plan }).toString("utf8");
  const marker = '"allowedExtensions":[',
    head = text.slice(0, text.indexOf(marker) + marker.length);
  for (const suffix of ['"hstore","plpgsql",', '"plpgsql","plpgsql', '"plpgsql","plpgsql_extra",'])
    assert.equal(f.parse(Buffer.from(head + suffix), 8000).frames.length, 4);
});

for (const phase of ["reconcile", "replay"]) {
  for (const [field, options] of [
    ["expectedOwner", { domainDrift: { expectedOwner: "changed-owner" } }],
    ["allowedExtensions", { domainDrift: { allowedExtensions: ["hstore", "plpgsql"] } }],
    ["expectedSchemaDigest", { expectationScript: "CREATE TABLE changed_target(id int);\n" }]
  ]) {
    test(`user-review ${phase} rejects current ${field} drift from the original approved plan`, () => {
      const dry = runnerFixture(),
        original = runnerFixture(
          "apply",
          dry,
          phase === "reconcile" ? { unknown: true, missingResult: true, deployExit: 1 } : {}
        );
      const originals = [...original.archive.artifacts].map(([digest, value]) => [
        digest,
        encodeManualJson(value)
      ]);
      const current = runnerFixture(phase, original, options);
      for (const [digest, bytes] of originals)
        assert.deepEqual(encodeManualJson(current.archive.artifacts.get(digest)), bytes);
      assert.notDeepEqual(current.request.domainInput[field], dry.result.plan.identity[field]);
      assert.equal(current.request.buildProofDigest, original.request.buildProofDigest);
      assert.equal(current.request.baselineManifestDigest, original.request.baselineManifestDigest);
      assert.throws(() => assessManualRunnerEvidence(current.archive.input(current.request)), {
        code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
      });
    });
  }

  test(`user-review unchanged ${phase} preserves the original approved plan`, () => {
    const dry = runnerFixture(),
      original = runnerFixture(
        "apply",
        dry,
        phase === "reconcile" ? { unknown: true, missingResult: true, deployExit: 1 } : {}
      );
    const current = runnerFixture(phase, original);
    const actual = assessManualRunnerEvidence(current.archive.input(current.request));
    assert.equal(actual.executionStatus, "SUCCEEDED");
    assert.equal(actual.originalDatabaseOutcome, "committed");
    assert.equal(actual.planDigest, deterministicPlanDigest(dry.result.plan));
  });
}

test("user-review live ACK refuses a different initial container after coherent digest repairs", () => {
  const genuine = runnerFixture(),
    altered = runnerFixture("dry-run", null, { initialContainerId: "f".repeat(64) });
  const live = altered.liveInputs[0],
    authorize = fixtureDecode(live.parentFrameBytes[0]);
  assert.deepEqual(live.requestBytes, genuine.liveInputs[0].requestBytes);
  assert.deepEqual(live.authorizationBytes, genuine.liveInputs[0].authorizationBytes);
  assert.equal(authorize.payload.launchContext.containerId, altered.request.containerId);
  assert.equal(authorize.payload.process.events[1].containerId, "f".repeat(64));
  assert.equal(
    authorize.payload.processReadback.subjectDigest,
    sha256Canonical(authorize.payload.process)
  );
  assert.equal(
    authorize.payload.processReadback.observedDigest,
    sha256Canonical(authorize.payload.process)
  );
  assert.throws(() => validateManualRunnerProtocol(live), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
});

test("user-review live ACK preserves the valid initial launch binding", () => {
  assert.equal(validateManualRunnerProtocol(runnerFixture().liveInputs[0]), undefined);
});

test("user-review verify preserves the approved capability role fingerprint difference", () => {
  const original = runnerFixture("apply", runnerFixture());
  const current = runnerFixture("verify", original, {
    freshVerifyOperation: true,
    changedSession: true
  });
  assert.equal(original.request.roleObservation.role, "test-migrate");
  assert.equal(current.request.roleObservation.role, "test-verify");
  assert.notEqual(
    current.request.domainInput.databaseIdentityFingerprint,
    original.request.domainInput.databaseIdentityFingerprint
  );
  const actual = assessManualRunnerEvidence(current.archive.input(current.request));
  assert.equal(actual.executionStatus, "SUCCEEDED");
  assert.equal(actual.originalDatabaseOutcome, "not-applicable");
});
