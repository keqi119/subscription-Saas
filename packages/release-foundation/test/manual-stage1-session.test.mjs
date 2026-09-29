import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { openManualSession } from "../src/manual-stage1-session.mjs";
import { deterministicPlanDigest } from "../src/proof-builders.mjs";
import { assessManualRunnerEvidence } from "../src/manual-runner-evidence.mjs";

// Private offline artifact factories follow the approved E fixtures. They only
// construct bytes; the session tests below persist and reopen every original.
const uuid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (n) => new Date(Date.parse(NOW) + n * 1000).toISOString();
function runnerRequest(phase = "target-observe") {
  const request = {
    schemaVersion: "manual-runner-request.v1",
    attemptId: uuid(1),
    runId: uuid(2),
    attemptAllocationDigest: D,
    profileDigest: D,
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

function clusterFixture() {
  return {
    systemIdentifier: "18446744073709551615",
    databaseContainerId: "1".repeat(64),
    dataVolumeName: "test-h3-volume",
    postgresImageDigest: "sha256:" + "2".repeat(64),
    marker: "test-h3-marker",
    serverAddress: "192.0.2.10",
    serverPort: 5432
  };
}

function fixtureFrame({ protocol = "MS1", type, sequence, payload }) {
  const bytes = encodeManualJson(payload);
  return Buffer.concat([Buffer.from(`${protocol} ${type} ${sequence} ${bytes.length}\n`), bytes]);
}
function manualPolicy(profile = null) {
  const current = profile?.schemaVersion === "manual-stage1-profile.v2";
  return {
    recordSchema: current ? "manual-operation-record.v2" : "manual-operation-record.v1",
    retentionDays: current ? 90 : 180,
    profileBytes: current ? encodeManualJson(profile) : null
  };
}
function archiveFixture(profile = null) {
  const artifacts = new Map(),
    raws = new Map(),
    policy = manualPolicy(profile);
  return {
    artifacts,
    raws,
    ...policy,
    profileInput() {
      return policy.profileBytes ? { profileBytes: Buffer.from(policy.profileBytes) } : {};
    },
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
        requestBytes: encodeManualJson(request),
        artifactBytes: [...artifacts.values()].map(encodeManualJson),
        rawBlobs: [...raws.values()],
        ...this.profileInput()
      };
    }
  };
}
function record(archive, request, kind, n, fields) {
  return {
    schemaVersion: archive.recordSchema,
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

function custodyFixture(archive, request, subject, purpose, n) {
  const custody = record(archive, request, "custody", n, {
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
    retentionDays: archive.retentionDays,
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
  const root = previous?.root ?? options.root;
  const protocol = options.protocol ?? previous?.protocol ?? root.protocol ?? "MS1";
  const cluster = previous?.cluster ?? root.cluster ?? clusterFixture();
  const shared = previous?.shared ?? options.shared ?? buildFixture(root, options.report);
  const { archive } = root;
  const expectation = options.expectationScript
    ? { ...shared.expectation, script: archive.raw(Buffer.from(options.expectationScript)) }
    : shared.expectation;
  const step = { "dry-run": 1, apply: 2, verify: 3, replay: 4, reconcile: 5 }[phase];
  const n = options.n ?? 20 + step * 100;
  const request = runnerRequest(phase);
  Object.assign(request, {
    attemptId: options.attemptId ?? uuid(100 + step),
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
    containerId: options.containerId ?? String(step).repeat(64),
    childChallenge: options.childChallenge ?? String(step + 1).repeat(64)
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
  Object.assign(
    request,
    pick(root.request, ["profileDigest", "ownerId", "operationId", "idempotencyKey", "runId"]),
    pick(options.session ?? root.session, sessionKeys)
  );
  if (["replay", "reconcile"].includes(phase))
    request.originalIdempotencyKey = request.idempotencyKey;
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
  const wireFrame = (input) => fixtureFrame({ protocol, ...input });
  const frame = (type, payload) => {
    const bytes = wireFrame({ type, sequence: stdoutFrames.length, payload });
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
  if (options.beforeConsume)
    return { root, shared, archive, request, allocation, nullRoot, bound, n };
  const prior = options.prior;
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
    const execution = record(archive, request, "execution", n + 9, {
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
  const consumptionReadback = prior.consumptionReadback;
  const handoff = prior.handoff;
  archive.add(consumptionReadback);
  archive.add(handoff);
  const handoffReadback = prior.handoffReadback;
  archive.add(handoffReadback);
  const processReadback = custodyFixture(archive, request, bound, "archive-readback", n + 4);
  const h3ApprovalBytes =
    previous?.h3ApprovalBytes ??
    encodeManualJson({ kind: "synthetic-h3-a-approval", operationRef: uuid(700) });
  const h3ReadbackBytes =
    previous?.h3ReadbackBytes ??
    encodeManualJson({ kind: "synthetic-h3-a-readback", operationRef: uuid(700) });
  const targetContext =
    protocol === "MS2"
      ? {
          contextVersion: "manual-h3-target-context.v1",
          operationRef: uuid(700),
          indexDigest: "sha256:" + "7".repeat(64),
          runId: request.runId,
          profileDigest: request.profileDigest,
          targetIntent: structuredClone(request.targetIntent),
          databaseOid: request.physicalIdentity.databaseOid,
          h3Approval: archive.raw(h3ApprovalBytes),
          h3Readback: archive.raw(h3ReadbackBytes),
          cluster: structuredClone(cluster)
        }
      : null;
  const authorizePayload = {
    launchContext: pick(request, ["containerId", "runnerImageDigest"]),
    allocation,
    request,
    authorization: prior.authorization,
    receipt: handoff,
    baseline: shared.baseline,
    process: bound,
    processReadback
  };
  if (targetContext) authorizePayload.targetContext = targetContext;
  const authorizeBytes = wireFrame({
    type: "AUTHORIZE",
    sequence: 0,
    payload: authorizePayload
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
    const ack = wireFrame({
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
      requestBytes: encodeManualJson(request),
      authorizationBytes: encodeManualJson(prior.authorization),
      previousProcessBytes: encodeManualJson(previous),
      childFrameBytes: childFrame,
      ackFrameBytes: ack,
      stdoutPrefixBytes: stdoutBytes(),
      parentFrameBytes: [...parentFrames],
      ...archive.profileInput()
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
  if (protocol === "MS2" && phase === "apply") {
    const versions = calls.slice(0, 2),
      schemaCalls = calls
        .filter(([tool]) => ["prisma-diff", "prisma-script"].includes(tool))
        .reverse();
    calls.splice(
      0,
      calls.length,
      ...versions,
      ...calls.filter(([tool]) => tool === "prisma-deploy"),
      ...versions,
      ...schemaCalls,
      ...versions,
      ...schemaCalls
    );
    // Failed deploys end the handler; reconciliation is a separate attempt.
    if (options.deployExit) calls.splice(3);
  }
  let t = n + 10;
  for (const [index, [tool, args, stdout]] of calls.entries()) {
    const argv = archive.raw(
      encodeManualJson({
        command:
          tool === "psql-version" ? "psql" : "/app/apps/release-runner/node_modules/.bin/prisma",
        args
      })
    ).digest;
    const tick = protocol === "MS2" && phase === "apply" && index >= 3 ? 0.5 : 1;
    event(tool, "PREPARED", t, index + 1, argv);
    acknowledgedEvent(t);
    t += tick;
    event(tool, "SPAWNED", t, index + 1, argv, { pid: 2000 + index });
    acknowledgedEvent(t);
    t += tick;
    event(tool, "CLOSED", t, index + 1, argv, {
      pid: 2000 + index,
      exitCode: tool === "prisma-deploy" ? (options.deployExit ?? 0) : 0,
      stdout: archive.raw(stdout),
      stderr: archive.raw(Buffer.from(""))
    });
    acknowledgedEvent(t);
    t += tick;
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
  const observationAck = wireFrame({
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
    requestBytes: encodeManualJson(request),
    authorizationBytes: encodeManualJson(prior.authorization),
    previousProcessBytes: encodeManualJson(process),
    childFrameBytes: observationFrame,
    ackFrameBytes: observationAck,
    stdoutPrefixBytes: stdoutBytes(),
    parentFrameBytes: [...parentFrames],
    ...archive.profileInput()
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
      ? archive.add(previous.originalApply ?? previous.execution)
      : null
  });
  if (!options.missingResult) archive.add(result);
  event("runner", "DISPATCH_CLOSED", n + 42, 0, null, { source: "runner" });
  acknowledgedEvent(n + 42);
  frame("ACK_RECEIVED", { binding, previousAck: ref(lastAck) });
  if (!options.missingResult) frame("RESULT", result);
  if (options.partialResultUtf8) {
    const resultFrame = wireFrame({
      type: "RESULT",
      sequence: stdoutFrames.length,
      payload: result
    });
    stdoutFrames.push(resultFrame.subarray(0, resultFrame.indexOf(Buffer.from("测试")) + 2));
  }
  if (options.malformedPartialResult)
    stdoutFrames.push(Buffer.from(`${protocol} RESULT ${stdoutFrames.length} 100\n!]`));
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
  const post = record(archive, request, "post-state", n + 44, {
    ...pick(request, [...sessionKeys, ...operationKeys]),
    requestDigest: archive.add(request),
    consumptionRecordDigest: archive.add(prior.consumption),
    outcome: "OBSERVED",
    observationDigest: archive.add(observation),
    observedAt: observation.observedAt,
    reasonCode: null
  });
  if (!options.missingPost) archive.add(post);
  const execution = record(archive, request, "execution", n + 45, {
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
    startedAt: options.missingResult ? null : result.startedAt,
    finishedAt: options.missingClose ? null : finalProcess.closedAt,
    status: options.unknown ? "INTERRUPTED_UNKNOWN" : "SUCCEEDED",
    reasonCode: options.unknown ? "MANUAL_COMMIT_ATTRIBUTION_UNAVAILABLE" : null,
    resultDigest: options.missingResult ? null : archive.add(result),
    processEvidenceDigest: archive.add(finalProcess)
  });
  // The current execution and its custody do not exist when the parent
  // assesses it. Prior attempts stay in the same archive unchanged.
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
    liveInputs,
    protocol,
    cluster,
    targetContext,
    h3ApprovalBytes,
    h3ReadbackBytes
  };
}

const run = promisify(execFile);
const NOW = "2026-09-08T12:00:00.000Z";
const D = `sha256:${"a".repeat(64)}`;
const targetIntent = { endpointPolicyId: "test-endpoint", databaseName: "test-db" };
const sid = "S-1-5-21-111-222-333-1001";
const jsonPath = (root, digest) => path.join(root, "objects", `${digest.slice(7)}.json`);
const clone = (value) => structuredClone(value);
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
const sessionKeys = ["sessionId", "sessionNonce"];
const operationKeys = [...sessionKeys, "operationId", "idempotencyKey"];
const aKeys = ["profileDigest", ...operationKeys, "attemptId", "runId"];
const sessionPolicies = new WeakMap();

// Only the expensive OS ACL observer is doubled; all paths, locks, handles,
// create-only writes, readback, enumeration and cryptography are real.
async function fixture(
  t,
  { native = false, genesis = true, profileVersion = "v1", recordedAt = NOW } = {}
) {
  assert.match(profileVersion, /^v[12]$/);
  const root = await fs.mkdtemp(path.join(tmpdir(), "manual-session-test-"));
  t.after(async () => {
    assert.equal(
      path.dirname(path.resolve(root)).toLowerCase(),
      path.resolve(tmpdir()).toLowerCase()
    );
    assert.ok(path.basename(root).startsWith("manual-session-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync("ed25519");
  let actualSid = sid;
  if (native && process.platform === "win32") {
    const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true
    });
    actualSid = stdout.match(/S-1-[0-9-]+/)[0];
  }
  const storage = Object.fromEntries(
    ["key", "journal", "archive", "backup", "credential"].map((name) => [
      `${name}Root`,
      path.join(root, name)
    ])
  );
  Object.assign(storage, {
    keyRef: "owner.key",
    retentionDays: profileVersion === "v2" ? 90 : 180
  });
  for (const [key, dir] of Object.entries(storage).filter(([key]) => key.endsWith("Root"))) {
    await fs.mkdir(dir, { mode: 0o700 });
    if (native && process.platform === "win32")
      await run("icacls.exe", [dir, "/inheritance:r", "/grant:r", `*${actualSid}:(OI)(CI)F`], {
        windowsHide: true
      });
    if (["journalRoot", "archiveRoot", "backupRoot"].includes(key))
      await fs.mkdir(path.join(dir, "objects"), { mode: 0o700 });
  }
  for (const name of ["locks", "consumptions", "revocations", "checkpoints"])
    await fs.mkdir(path.join(storage.journalRoot, name), { mode: 0o700 });
  await fs.mkdir(path.join(storage.archiveRoot, "raw"), { mode: 0o700 });
  if (native && process.platform === "win32")
    await run("icacls.exe", [root, "/setowner", `*${actualSid}`, "/T"], { windowsHide: true });
  const profile = {
    schemaVersion: `manual-stage1-profile.${profileVersion}`,
    profileId: randomUUID(),
    ownerId: "test-owner",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: sha256Bytes(keys.publicKey.export({ type: "spki", format: "der" })),
    validFrom: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-09T00:00:00.000Z",
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
        ...targetIntent,
        endpoint: "db.invalid:5432",
        purposes: ["synthetic-fresh", "staging-mainline"],
        roles: { observer: "test-observer", migrate: "test-migrate", verify: "test-verify" },
        tls: "required"
      }
    ],
    storage
  };
  const ownerObservation = {
    ownerId: profile.ownerId,
    principal:
      process.platform === "win32"
        ? { platform: "win32", sid: actualSid }
        : { platform: "posix", uid: process.getuid() },
    targetIntent,
    observedAt: NOW
  };
  let clock = recordedAt;
  const f = {
    root,
    profile,
    ownerObservation,
    keys,
    setTime(value) {
      clock = value;
    },
    io: {
      fs: { ...fs },
      execFile: native
        ? run
        : async (file, args) => {
            if (file === "icacls.exe") return { stdout: "test ACL readback", stderr: "" };
            if (file === "powershell.exe")
              return { stdout: `${sid}\n${sid}|Allow|2032127\n`, stderr: "" };
            throw new Error(`Unexpected OS command ${file}`);
          }
    }
  };
  f.open = async () => {
    const session = await openManualSession({
      profile: f.profile,
      ownerObservation: f.ownerObservation,
      io: f.io,
      now: () => (typeof clock === "function" ? clock() : clock),
      signingKey: keys.privateKey
    });
    sessionPolicies.set(session, manualPolicy(f.profile));
    t.after(() => session.close().catch(() => {}));
    return session;
  };
  f.put = async (value, role = "archive") => {
    const digest = sha256Canonical(value);
    const file = jsonPath(storage[`${role}Root`], digest);
    try {
      await fs.writeFile(file, encodeManualJson(value), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (native && process.platform === "win32")
      await run("icacls.exe", [file, "/setowner", `*${actualSid}`], { windowsHide: true });
    return digest;
  };
  f.records = async (kind) => {
    const values = new Map();
    for (const role of ["journal", "archive"])
      for (const name of await fs.readdir(path.join(storage[`${role}Root`], "objects"))) {
        const value = JSON.parse(
          await fs.readFile(path.join(storage[`${role}Root`], "objects", name), "utf8")
        );
        if (!kind || value.kind === kind) values.set(sha256Canonical(value), value);
      }
    return [...values.values()];
  };
  if (genesis) {
    const policy = manualPolicy(profile);
    const value = {
      schemaVersion: policy.recordSchema,
      kind: "revocation",
      profileDigest: sha256Canonical(profile),
      recordedAt,
      promotionEligible: false,
      ownerId: profile.ownerId,
      sequence: 0,
      previousRevocationDigest: null,
      action: "GENESIS",
      authorizationId: null,
      reasonCode: null
    };
    await f.put(value, "journal");
    await fs.writeFile(
      path.join(storage.journalRoot, "revocations", `${sha256Canonical(profile).slice(7)}-0.json`),
      encodeManualJson(value),
      { flag: "wx", mode: 0o600 }
    );
    if (native && process.platform === "win32")
      await run(
        "icacls.exe",
        [path.join(storage.journalRoot, "revocations"), "/setowner", `*${actualSid}`, "/T"],
        { windowsHide: true }
      );
  }
  return f;
}

async function selectProfileVersion(f, profileVersion, recordedAt = NOW) {
  assert.match(profileVersion, /^v[12]$/);
  f.profile = {
    ...clone(f.profile),
    schemaVersion: `manual-stage1-profile.${profileVersion}`,
    profileId: randomUUID(),
    storage: {
      ...clone(f.profile.storage),
      retentionDays: profileVersion === "v2" ? 90 : 180
    }
  };
  const policy = manualPolicy(f.profile);
  const genesis = {
    schemaVersion: policy.recordSchema,
    kind: "revocation",
    profileDigest: sha256Canonical(f.profile),
    recordedAt,
    promotionEligible: false,
    ownerId: f.profile.ownerId,
    sequence: 0,
    previousRevocationDigest: null,
    action: "GENESIS",
    authorizationId: null,
    reasonCode: null
  };
  await f.put(genesis, "journal");
  await fs.writeFile(
    path.join(
      f.profile.storage.journalRoot,
      "revocations",
      `${sha256Canonical(f.profile).slice(7)}-0.json`
    ),
    encodeManualJson(genesis),
    { flag: "wx", mode: 0o600 }
  );
}

async function requestFixture(f, session, phase = "target-observe", fields = {}, recordedAt = NOW) {
  const binding = {
    profileDigest: session.profileDigest,
    ownerId: f.profile.ownerId,
    ...pick(session, sessionKeys),
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    purpose: "synthetic-fresh",
    targetIntent: session.targetIntent,
    stage: "target-observe",
    capability: "verify",
    ...fields
  };
  const request = {
    ...binding,
    schemaVersion: "manual-runner-request.v1",
    attemptId: randomUUID(),
    runId: randomUUID()
  };
  const allocation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "attempt-allocation",
    recordedAt,
    promotionEligible: false,
    ...pick(request, aKeys),
    stage: binding.stage,
    phaseKey: phase,
    allocatedAt: recordedAt,
    targetIntent: request.targetIntent,
    predecessorExecutionRecordDigest: null
  };
  request.attemptAllocationDigest = await f.put(allocation);
  await f.put(request);
  return { binding, canonicalBytes: encodeManualJson(request) };
}

test("exclusive parent lock follows endpoint across profile identity and role aliases", async (t) => {
  const f = await fixture(t),
    first = await f.open();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.targetIntent), true);
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      "close",
      "consume",
      "profileDigest",
      "record",
      "sessionId",
      "sessionNonce",
      "sign",
      "targetIntent"
    ].sort()
  );
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
  f.profile.profileId = randomUUID();
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
  const ref = await first.close();
  assert.match(ref.recordDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await f.records("session")).filter((r) => r.status === "CLOSED").length, 1);
  await assert.rejects(first.consume({ authorization: {}, request: {} }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
});

test("untrusted roots, owner observation and absent genesis do not create trust", async (t) => {
  const f = await fixture(t, { genesis: false });
  await assert.rejects(f.open(), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  assert.equal((await f.records("revocation")).length, 0);
  f.ownerObservation.ownerId = "wrong-owner";
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
  f.ownerObservation.ownerId = "test-owner";
  f.profile.storage.archiveRoot = `${f.root}${path.sep}journal${path.sep}..${path.sep}archive`;
  await assert.rejects(f.open(), { code: "CONTRACT_SCHEMA_INVALID" });
});

test("linked fixed root is rejected before OPEN", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.root, "linked-archive");
  await fs.symlink(
    f.profile.storage.archiveRoot,
    linked,
    process.platform === "win32" ? "junction" : "dir"
  );
  f.profile.storage.archiveRoot = linked;
  await assert.rejects(f.open(), { code: "MANUAL_STORAGE_UNVERIFIED" });
});

test("native owner-only ACL and create-only close are read back", async (t) => {
  const f = await fixture(t, { native: true });
  const session = await f.open();
  await session.close();
});

test("request cannot select archiveRoot and closed session cannot sign", async (t) => {
  const f = await fixture(t),
    session = await f.open();
  const request = await requestFixture(f, session);
  request.canonicalBytes = encodeManualJson({
    ...JSON.parse(request.canonicalBytes),
    archiveRoot: f.root
  });
  await assert.rejects(session.sign(request), { code: "CONTRACT_SCHEMA_INVALID" });
  await session.close();
  await assert.rejects(session.sign(request), { code: "MANUAL_SESSION_UNVERIFIED" });
});

function manualRecord(session, kind, fields = {}) {
  const policy = sessionPolicies.get(session) ?? manualPolicy();
  return {
    schemaVersion: policy.recordSchema,
    kind,
    profileDigest: session.profileDigest,
    recordedAt: NOW,
    promotionEligible: false,
    ...fields
  };
}
async function revoke(f, session, authorization, action = "REVOKE_AUTHORIZATION") {
  const chain = (await f.records("revocation")).sort((a, b) => a.sequence - b.sequence);
  return session.record(
    "revocation",
    manualRecord(session, "revocation", {
      ownerId: f.profile.ownerId,
      sequence: chain.length,
      previousRevocationDigest: sha256Canonical(chain.at(-1)),
      action,
      authorizationId:
        action === "REVOKE_AUTHORIZATION" ? authorization.payload.authorizationId : null,
      reasonCode: "OWNER_REVOKED"
    })
  );
}

test("authorization signs the complete request with a fresh ID and five-minute maximum", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  assert.equal(authorization.payload.requestDigest, sha256Bytes(request.canonicalBytes));
  assert.equal(authorization.payload.issuedAt, NOW);
  assert.equal(authorization.payload.expiresAt, "2026-09-08T12:05:00.000Z");
  const again = await session.sign(request);
  assert.notEqual(again.payload.authorizationId, authorization.payload.authorizationId);
  const result = await session.consume({ authorization, request });
  assert.deepEqual(
    Object.keys(result).sort(),
    ["stage", "parentDecision", "consumptionReadbackDigest"].sort()
  );
  assert.equal(result.stage, "target-observe");
  assert.equal(result.parentDecision.promotionEligible, false);
  const consumption = (await f.records("consumption"))[0];
  const custody = (await f.records("custody")).find(
    (r) => sha256Canonical(r) === result.consumptionReadbackDigest
  );
  assert.equal(custody.subjectDigest, sha256Canonical(consumption));
  assert.equal(custody.observedDigest, custody.subjectDigest);
  await assert.rejects(session.consume({ authorization, request }), {
    code: "MANUAL_AUTHORIZATION_CONSUMED"
  });
  await session.close();
});

test("revocation after signing prevents release and its sequence cannot be rolled back", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  await revoke(f, session, authorization);
  await assert.rejects(session.consume({ authorization, request }), {
    code: "MANUAL_AUTHORIZATION_REVOKED"
  });
  assert.equal((await f.records("consumption")).length, 0);
  const file = path.join(
    f.profile.storage.journalRoot,
    "revocations",
    `${session.profileDigest.slice(7)}-1.json`
  );
  await fs.unlink(file);
  await assert.rejects(session.sign(request), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  await session.close();
});

test("same authorization concurrently consumes only one durable slot", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  const results = await Promise.allSettled([
    session.consume({ authorization, request }),
    session.consume({ authorization, request })
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "MANUAL_AUTHORIZATION_CONSUMED"
  );
  assert.equal((await f.records("consumption")).length, 1);
  await session.close();
});

test("readback failure retains the original consumed slot and never releases capability", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  const open = f.io.fs.open;
  let injected = false;
  f.io.fs.open = async (file, flags, ...args) => {
    if (!injected && flags === "r" && file.includes(`${path.sep}consumptions${path.sep}`)) {
      injected = true;
      throw Object.assign(new Error("read unavailable"), { code: "EIO" });
    }
    return open(file, flags, ...args);
  };
  let releases = 0;
  await assert.rejects(
    session.consume({ authorization, request }).then(() => releases++),
    { code: "MANUAL_STORAGE_UNVERIFIED" }
  );
  assert.equal(releases, 0);
  assert.equal(
    (await fs.readdir(path.join(f.profile.storage.journalRoot, "consumptions"))).length,
    1
  );
  const interrupted = (await f.records("execution"))[0];
  assert.equal(interrupted?.status, "INTERRUPTED_UNKNOWN");
  assert.equal(interrupted?.attemptId, JSON.parse(request.canonicalBytes).attemptId);
  assert.equal(interrupted?.finishedAt, null);
  await assert.rejects(session.consume({ authorization, request }), {
    code: "MANUAL_AUTHORIZATION_CONSUMED"
  });
  f.io.fs.open = open;
  await session.close();
});

test("missing original allocation after consumption never invents a recovery attempt", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  await session.consume({ authorization, request });
  const allocationDigest = JSON.parse(request.canonicalBytes).attemptAllocationDigest;
  const slotDir = path.join(f.profile.storage.journalRoot, "consumptions");
  const slot = path.join(slotDir, (await fs.readdir(slotDir))[0]),
    before = await fs.readFile(slot);
  await fs.unlink(jsonPath(f.profile.storage.archiveRoot, allocationDigest));
  await assert.rejects(session.close(), { code: "MANUAL_EVIDENCE_INPUT_REQUIRED" });
  assert.equal((await f.records("execution")).length, 0);
  assert.deepEqual(await fs.readFile(slot), before);
  assert.ok((await f.records("session")).some((r) => r.status === "INTERRUPTED_UNKNOWN"));
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
});

test("target-observe rejects child context before consuming", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  await assert.rejects(
    session.consume({
      authorization,
      request,
      childObservation: {
        containerId: "c".repeat(64),
        runnerImageDigest: D,
        childChallenge: "d".repeat(64)
      }
    }),
    { code: "MANUAL_BINDING_MISMATCH" }
  );
  assert.equal((await f.records("consumption")).length, 0);
  await session.close();
});

async function observeResult(f, session, input, options = {}) {
  const request = JSON.parse(input.canonicalBytes),
    requestDigest = sha256Bytes(input.canonicalBytes),
    recordedAt = options.recordedAt ?? NOW;
  const consumption = (await f.records("consumption")).find(
    (r) => r.requestDigest === requestDigest
  );
  const catalog = {
    migrationTableOid: null,
    migrationRows: [],
    schemaOwner: "test-owner",
    ownerInventory: [],
    extensions: ["plpgsql"],
    postgresqlVersion: "17.0"
  };
  const observation = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "observation",
    recordedAt,
    promotionEligible: false,
    ...pick(request, aKeys),
    requestDigest,
    observedAt: recordedAt,
    physicalIdentity: {
      ...targetIntent,
      databaseOid: "123",
      clusterFingerprint: options.clusterFingerprint ?? D
    },
    roleObservation: {
      role: "test-observer",
      tls: true,
      schemaObservationDigest: sha256Canonical(catalog)
    },
    catalog,
    schema: null,
    processEvidenceDigest: null
  };
  const observationDigest = await f.put(observation);
  const result = {
    schemaVersion: "manual-runner-evidence.v1",
    kind: "manual-command-result",
    recordedAt,
    promotionEligible: false,
    ...pick(request, aKeys),
    requestDigest,
    phaseKey: options.phase ?? "target-observe",
    attemptAllocationDigest: request.attemptAllocationDigest,
    startedAt: recordedAt,
    finishedAt: recordedAt,
    outcome: options.failed ? "THREW" : "RETURNED",
    reasonCode: options.failed ? "OBSERVER_FAILED" : null,
    plan: null,
    postState: null,
    observationDigest,
    processEvidenceDigest: null,
    statements: ["SELECT current_database()"],
    originalExecutionRecordDigest: null
  };
  const resultDigest = await f.put(result);
  const post = manualRecord(session, "post-state", {
    recordedAt,
    ...pick(request, operationKeys),
    requestDigest,
    consumptionRecordDigest: sha256Canonical(consumption),
    outcome: options.unavailable ? "UNAVAILABLE" : "OBSERVED",
    observationDigest: options.unavailable ? null : observationDigest,
    observedAt: options.unavailable ? null : recordedAt,
    reasonCode: options.unavailable ? "OBSERVATION_UNAVAILABLE" : null
  });
  const postRef = await session.record("post-state", post);
  const execution = manualRecord(session, "execution", {
    recordedAt,
    ...pick(request, operationKeys),
    attemptId: request.attemptId,
    requestDigest,
    authorizationDigest: consumption.authorizationDigest,
    consumptionRecordDigest: sha256Canonical(consumption),
    handoffRecordDigest: null,
    handoffReadbackDigest: null,
    postStateRecordDigest: postRef.recordDigest,
    predecessorExecutionRecordDigest: null,
    startedAt: recordedAt,
    finishedAt: recordedAt,
    status: "SUCCEEDED",
    reasonCode: null,
    resultDigest,
    processEvidenceDigest: null
  });
  return { request, observation, result, post, execution };
}
function custody(session, subject, role = "archive") {
  const policy = sessionPolicies.get(session) ?? manualPolicy();
  return manualRecord(session, "custody", {
    ownerId: "test-owner",
    subjectDigest: sha256Canonical(subject),
    subjectType: "record",
    purpose: role === "backup" ? "backup-readback" : "archive-readback",
    outcome: "MATCH",
    observedDigest: sha256Canonical(subject),
    observedAt: NOW,
    storageRole: role,
    retentionDays: policy.retentionDays,
    reasonCode: null
  });
}

test("complete observed evidence is independently assessed before execution and signoff", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  await session.consume({ authorization, request });
  const evidence = await observeResult(f, session, request);
  const ref = await session.record("execution", evidence.execution);
  assert.equal(ref.recordDigest, sha256Canonical(evidence.execution));
  const archive = await session.record("custody", custody(session, evidence.execution));
  await assert.rejects(session.record("custody", custody(session, evidence.execution, "backup")), {
    code: "MANUAL_STORAGE_UNVERIFIED"
  });
  await f.put(evidence.execution, "backup");
  const backup = await session.record("custody", custody(session, evidence.execution, "backup"));
  const signoff = manualRecord(session, "signoff", {
    ...pick(evidence.execution, operationKeys),
    ownerId: "test-owner",
    executionRecordDigest: ref.recordDigest,
    executionReadbackDigest: archive.recordDigest,
    backupReadbackDigest: backup.recordDigest,
    decision: "ACCEPTED",
    reasonCode: null
  });
  await session.record("signoff", signoff);
  assert.equal((await f.records("signoff"))[0].decision, "ACCEPTED");
  await assert.rejects(session.sign(request), { code: "MANUAL_SESSION_UNVERIFIED" });
  const slotDir = path.join(f.profile.storage.journalRoot, "consumptions");
  await fs.unlink(path.join(slotDir, (await fs.readdir(slotDir))[0]));
  await assert.rejects(session.sign(await requestFixture(f, session)), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await session.close();
});

for (const [name, options] of [
  ["unavailable observation", { unavailable: true }],
  ["actual failed result", { failed: true }],
  ["wrong result phase", { phase: "verify" }]
]) {
  test(`${name} cannot be accepted as execution success`, async (t) => {
    const f = await fixture(t),
      session = await f.open(),
      request = await requestFixture(f, session);
    const authorization = await session.sign(request);
    await session.consume({ authorization, request });
    const evidence = await observeResult(f, session, request, options);
    await assert.rejects(session.record("execution", evidence.execution), {
      code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
    });
    assert.equal((await f.records("execution")).filter((r) => r.status === "SUCCEEDED").length, 0);
    if (options.phase)
      await assert.rejects(session.close(), { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" });
    else await session.close();
  });
}

test("custody cannot read another custody, future bytes or a one-byte corrupted original", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  const result = await session.consume({ authorization, request });
  const readback = (await f.records("custody")).find(
    (r) => sha256Canonical(r) === result.consumptionReadbackDigest
  );
  await assert.rejects(session.record("custody", custody(session, readback)), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  const missing = custody(session, readback);
  missing.subjectDigest = missing.observedDigest = D;
  await assert.rejects(session.record("custody", missing));
  const original = (await f.records("consumption"))[0];
  await f.put(original);
  await f.put(original, "backup");
  const file = jsonPath(f.profile.storage.archiveRoot, sha256Canonical(original));
  // Simulated loss/restore reads the independent fixed backup root, not the
  // previous write response. The subsequent one-byte corruption must fail.
  await fs.unlink(file);
  const restored = await fs.readFile(
    jsonPath(f.profile.storage.backupRoot, sha256Canonical(original))
  );
  await fs.writeFile(file, restored, { flag: "wx", mode: 0o600 });
  await session.record("custody", custody(session, original, "backup"));
  await session.record("custody", custody(session, original));
  const bytes = await fs.readFile(file);
  bytes[0] = 0x5b;
  await fs.writeFile(file, bytes);
  await assert.rejects(session.record("custody", custody(session, original)), {
    code: "MANUAL_STORAGE_UNVERIFIED"
  });
  await assert.rejects(session.close(), { code: "MANUAL_STORAGE_UNVERIFIED" });
});

test("MATCH custody cannot observe an original before its production time", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    input = await requestFixture(f, session);
  const opened = (await f.records("session"))[0];
  await f.put(opened);
  f.setTime(time(1));
  const authorization = await session.sign(input);
  const allocation = (await f.records("attempt-allocation"))[0];
  const request = JSON.parse(input.canonicalBytes);
  const subjects = [
    ["record", opened, opened.recordedAt],
    ["authorization", authorization, authorization.payload.issuedAt],
    ["r2-artifact", allocation, allocation.recordedAt],
    ["request", request, allocation.allocatedAt]
  ];
  for (const [, subject] of subjects)
    await fs.readFile(jsonPath(f.profile.storage.archiveRoot, sha256Canonical(subject)));
  f.setTime(time(2));
  for (const [subjectType, subject, producedAt] of subjects) {
    await t.test(subjectType, async () => {
      const value = {
        ...custody(session, subject),
        subjectType: subjectType === "request" ? "r2-artifact" : subjectType,
        recordedAt: time(2),
        observedAt: new Date(Date.parse(producedAt) - 1).toISOString()
      };
      await assert.rejects(session.record("custody", value), { code: "MANUAL_TIME_INVALID" });
      // A real earlier observation remains valid when this extra independent
      // verification read occurs later; equality to the new read is not required.
      await session.record("custody", { ...value, observedAt: time(1) });
    });
  }
  // Profiles have no creation timestamp in the approved contract. validFrom
  // is validity, not birth; only its identity/owner/actual bytes are proved.
  await f.put(f.profile);
  await session.record("custody", {
    ...custody(session, f.profile),
    subjectType: "profile",
    recordedAt: time(2),
    observedAt: new Date(Date.parse(f.profile.validFrom) - 1).toISOString()
  });
  await fs.unlink(jsonPath(f.profile.storage.archiveRoot, request.attemptAllocationDigest));
  await assert.rejects(
    session.record("custody", {
      ...custody(session, request),
      subjectType: "r2-artifact",
      recordedAt: time(2),
      observedAt: time(1)
    }),
    { code: "MANUAL_EVIDENCE_INPUT_REQUIRED" }
  );
  await session.close();
});

test("a second authorization for the consumed attempt cannot bypass target pending history", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const first = await session.sign(request),
    second = await session.sign(request);
  await session.consume({ authorization: first, request });
  await assert.rejects(session.consume({ authorization: second, request }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  const another = await requestFixture(f, session);
  await assert.rejects(session.sign(another), { code: "MANUAL_SESSION_UNVERIFIED" });
  await session.close();
  assert.equal((await f.records("execution"))[0].status, "INTERRUPTED_UNKNOWN");
});

async function persistArchive(f, archive) {
  for (const value of archive.artifacts.values()) await f.put(value);
  for (const [digest, bytes] of archive.raws) {
    const file = path.join(f.profile.storage.archiveRoot, "raw", `${digest.slice(7)}.bin`);
    try {
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}
async function liveRoot(t, fixtureOptions = {}) {
  const recordedAt = fixtureOptions.recordedAt ?? NOW;
  const protocol = fixtureOptions.protocol ?? "MS1";
  const cluster = clusterFixture();
  const clusterFingerprint = sha256Canonical({
    domain: "manual-postgres-cluster.v1",
    ...cluster
  });
  const f = await fixture(t, fixtureOptions),
    session = await f.open(),
    input = await requestFixture(f, session, "target-observe", {}, recordedAt);
  const authorization = await session.sign(input);
  await session.consume({ authorization, request: input });
  const result = await observeResult(f, session, input, {
    recordedAt,
    clusterFingerprint: protocol === "MS2" ? clusterFingerprint : D
  });
  await session.record("execution", result.execution);
  const archive = archiveFixture(f.profile);
  for (const value of await f.records()) archive.add(value);
  const root = {
    ...result,
    catalog: result.observation.catalog,
    archive,
    authorization,
    session: (await f.records("session")).find((r) => r.status === "OPEN"),
    revocation: (await f.records("revocation"))[0],
    protocol,
    cluster
  };
  return { f, session, root };
}
async function liveRunner(context, phase = "dry-run", previous = null, options = {}) {
  const { f, session, root } = context;
  const prefix = runnerFixture(phase, previous, { root, session, ...options, beforeConsume: true });
  await persistArchive(f, prefix.archive);
  f.setTime(time(prefix.n + 5));
  const binding = { ...prefix.request };
  for (const key of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete binding[key];
  const input = { binding, canonicalBytes: encodeManualJson(prefix.request) };
  const authorization = await session.sign(input);
  if (options.beforeCredential) {
    // Recovery fixture: the original parent saved a consumption and its
    // readback, then proved pre-credential refusal and process closure. No
    // receipt/result is invented. This bypass is test-only archival setup.
    const priorRecords = await f.records();
    const genesis = priorRecords.find((r) => r.kind === "revocation" && r.sequence === 0);
    const opened = priorRecords.find(
      (r) => r.kind === "session" && r.sessionId === session.sessionId && r.status === "OPEN"
    );
    const consumption = {
      ...manualRecord(session, "consumption", {}),
      recordedAt: time(prefix.n + 6),
      ...pick(prefix.request, operationKeys),
      ownerId: f.profile.ownerId,
      authorizationDigest: sha256Canonical(authorization),
      requestDigest: sha256Canonical(prefix.request),
      stage: "runner-command",
      sessionRecordDigest: sha256Canonical(opened),
      revocationRecordDigest: sha256Canonical(genesis),
      revocationSequence: 0,
      status: "CONSUMED"
    };
    await f.put(consumption, "journal");
    await fs.writeFile(
      path.join(
        f.profile.storage.journalRoot,
        "consumptions",
        `${session.profileDigest.slice(7)}-${authorization.payload.authorizationId}.json`
      ),
      encodeManualJson(consumption),
      { flag: "wx", mode: 0o600 }
    );
    prefix.archive.add(authorization);
    prefix.archive.add(consumption);
    const final = runnerFixture(phase, previous, {
      root,
      shared: prefix.shared,
      session,
      ...options,
      prior: { authorization, consumption }
    });
    await persistArchive(f, final.archive);
    f.setTime(time(prefix.n + 45));
    return { ...final, input };
  }
  const released = await session.consume({
    authorization,
    request: input,
    childObservation: pick(prefix.request, ["containerId", "runnerImageDigest", "childChallenge"])
  });
  const records = await f.records();
  const consumption = records.find(
    (r) => r.kind === "consumption" && r.requestDigest === sha256Canonical(prefix.request)
  );
  const handoff = released.handoffReceipt;
  const prior = {
    authorization,
    consumption,
    handoff,
    consumptionReadback: records.find(
      (r) => sha256Canonical(r) === handoff.consumptionReadbackDigest
    ),
    handoffReadback: records.find(
      (r) =>
        r.kind === "custody" &&
        r.subjectDigest === sha256Canonical(handoff) &&
        r.purpose === "handoff-readback"
    )
  };
  for (const value of records) prefix.archive.add(value);
  prefix.archive.add(authorization);
  const final = runnerFixture(phase, previous, {
    root,
    shared: prefix.shared,
    session,
    ...options,
    prior
  });
  await persistArchive(f, final.archive);
  f.setTime(time(prefix.n + 45));
  return { ...final, input, released };
}

test("runner consumption seals a child-bound receipt only after actual originals and readbacks", async (t) => {
  const context = await liveRoot(t);
  const dry = await liveRunner(context);
  assert.deepEqual(
    Object.keys(dry.released).sort(),
    ["stage", "parentDecision", "handoffReceipt"].sort()
  );
  assert.equal(dry.released.handoffReceipt.childChallenge, dry.request.childChallenge);
  assert.equal(
    Date.parse(dry.released.handoffReceipt.expiresAt) -
      Date.parse(dry.released.handoffReceipt.issuedAt),
    30000
  );
  assert.equal(
    assessManualRunnerEvidence(dry.archive.input(dry.request)).executionStatus,
    "SUCCEEDED"
  );
  await context.session.record("execution", dry.execution);
  await context.session.close();
});

async function operationCheckpoints(f, operationId) {
  const dir = path.join(f.profile.storage.journalRoot, "checkpoints");
  const files = (await fs.readdir(dir)).filter((name) =>
    name.startsWith(`execution-${operationId}-`)
  );
  return Promise.all(
    files.map(async (name) => ({
      name,
      bytes: await fs.readFile(path.join(dir, name)),
      value: JSON.parse(await fs.readFile(path.join(dir, name)))
    }))
  );
}
async function sealExecution(context, attempt) {
  const { f, session } = context;
  await session.record("execution", attempt.execution);
  await f.put(attempt.execution, "backup");
  for (const role of ["archive", "backup"]) {
    const value = custody(session, attempt.execution, role);
    value.recordedAt = value.observedAt = attempt.execution.recordedAt;
    await session.record("custody", value);
  }
}

async function acceptanceRecord(context, attempt, { alreadyRecorded = false } = {}) {
  const { f, session } = context;
  const executionRef = alreadyRecorded
    ? { recordDigest: sha256Canonical(attempt.execution) }
    : await session.record("execution", attempt.execution);
  await f.put(attempt.execution, "backup");
  const readbacks = {};
  for (const role of ["archive", "backup"]) {
    const value = custody(session, attempt.execution, role);
    value.recordedAt = value.observedAt = attempt.execution.recordedAt;
    readbacks[role] = await session.record("custody", value);
  }
  const signoff = manualRecord(session, "signoff", {
    ...pick(attempt.execution, operationKeys),
    ownerId: f.profile.ownerId,
    executionRecordDigest: executionRef.recordDigest,
    executionReadbackDigest: readbacks.archive.recordDigest,
    backupReadbackDigest: readbacks.backup.recordDigest,
    decision: "ACCEPTED",
    reasonCode: null
  });
  signoff.recordedAt = attempt.execution.recordedAt;
  return signoff;
}

async function acceptExecution(context, attempt, options = {}) {
  const signoff = await acceptanceRecord(context, attempt, options);
  await context.session.record("signoff", signoff);
  return signoff;
}

test("v2 profile completes handoff, archive readback, and signoff with all eight 90-day record kinds", async (t) => {
  const context = await liveRoot(t, { profileVersion: "v2" });
  const revocable = await requestFixture(context.f, context.session);
  const revokedAuthorization = await context.session.sign(revocable);
  await revoke(context.f, context.session, revokedAuthorization);
  const dry = await liveRunner(context);
  await acceptExecution(context, dry);
  await context.session.close();
  const expectedKinds = [
    "consumption",
    "consumption-handoff",
    "custody",
    "execution",
    "post-state",
    "revocation",
    "session",
    "signoff"
  ];
  const expectedKindSet = new Set(expectedKinds);
  const records = (await context.f.records()).filter(
    (value) =>
      value.profileDigest === context.session.profileDigest &&
      (expectedKindSet.has(value.kind) ||
        (typeof value.schemaVersion === "string" &&
          value.schemaVersion.startsWith("manual-operation-record.")))
  );
  assert.deepEqual([...new Set(records.map((value) => value.kind))].sort(), expectedKinds);
  assert.ok(records.every((value) => value.schemaVersion === "manual-operation-record.v2"));
  assert.ok(
    records.filter((value) => value.kind === "custody").every((value) => value.retentionDays === 90)
  );
  assert.equal(
    assessManualRunnerEvidence(dry.archive.input(dry.request)).executionStatus,
    "SUCCEEDED"
  );
  assert.equal(
    records.filter(
      (value) =>
        value.kind === "revocation" &&
        value.action === "REVOKE_AUTHORIZATION" &&
        value.authorizationId === revokedAuthorization.payload.authorizationId
    ).length,
    1
  );
  assert.equal(
    records.filter((value) => value.kind === "session" && value.status === "CLOSED").length,
    1
  );
});

test("MS2 capacity reopens a large apply stdout through real session history", async (t) => {
  const context = await liveRoot(t, { profileVersion: "v2", protocol: "MS2" });
  const script = "-- self-contained capacity fixture\n".repeat(12000).slice(0, 402008) + "\n";
  const dry = await liveRunner(context, "dry-run", null, { expectationScript: script });
  await sealExecution(context, dry);
  const apply = await liveRunner(context, "apply", dry, { expectationScript: script });
  assert.ok(apply.finalProcess.protocol.stdoutPrefix.bytes > 1048576);
  await sealExecution(context, apply);
  await context.session.close();
  context.session = await context.f.open();
  const verify = await liveRunner(context, "verify", apply, { expectationScript: script });
  assert.equal(
    assessManualRunnerEvidence(verify.archive.input(verify.request)).executionStatus,
    "SUCCEEDED"
  );
  await context.session.record("execution", verify.execution);
  await context.session.close();
});

test("MS2 v2 profile persists H3 originals through handoff, archive, signoff, and reopen", async (t) => {
  const context = await liveRoot(t, { profileVersion: "v2", protocol: "MS2" });
  const dry = await liveRunner(context);
  assert.equal(
    assessManualRunnerEvidence(dry.archive.input(dry.request)).executionStatus,
    "SUCCEEDED"
  );
  assert.equal(dry.targetContext.runId, dry.request.runId);
  assert.equal(dry.targetContext.profileDigest, context.session.profileDigest);
  await acceptExecution(context, dry);
  await context.session.close();
  context.session = await context.f.open();
  for (const [refKey, bytes] of [
    ["h3Approval", dry.h3ApprovalBytes],
    ["h3Readback", dry.h3ReadbackBytes]
  ]) {
    const ref = dry.targetContext[refKey];
    assert.deepEqual(
      await fs.readFile(
        path.join(context.f.profile.storage.archiveRoot, "raw", `${ref.digest.slice(7)}.bin`)
      ),
      bytes
    );
  }
  const records = await context.f.records();
  assert.equal(
    records.filter(
      (value) =>
        value.kind === "signoff" &&
        value.executionRecordDigest === sha256Canonical(dry.execution) &&
        value.decision === "ACCEPTED"
    ).length,
    1
  );
  const custodyRecords = records.filter(
    (value) => value.kind === "custody" && value.profileDigest === dry.request.profileDigest
  );
  assert.ok(custodyRecords.length > 0);
  assert.ok(custodyRecords.every((value) => value.retentionDays === 90));
  await context.session.close();
});

test("MS2 missing RESULT and close remain UNKNOWN after reopen and cannot be accepted", async (t) => {
  for (const phase of ["apply", "replay"])
    await t.test(phase, async () => {
      const context = await liveRoot(t, { profileVersion: "v2", protocol: "MS2" });
      const dry = await liveRunner(context);
      await sealExecution(context, dry);
      let predecessor = dry;
      if (phase === "replay") {
        predecessor = await liveRunner(context, "apply", dry);
        await sealExecution(context, predecessor);
      }
      const predecessorDigest = sha256Canonical(predecessor.execution);
      const predecessorBytes = encodeManualJson(predecessor.execution);
      const pending = await requestFixture(context.f, context.session);
      const pendingAuthorization = await context.session.sign(pending);
      const lost = await liveRunner(context, phase, predecessor, {
        missingResult: true,
        missingClose: true,
        unknown: true
      });
      const assessment = assessManualRunnerEvidence(lost.archive.input(lost.request));
      assert.equal(assessment.executionStatus, "INTERRUPTED_UNKNOWN");
      assert.equal(assessment.originalDatabaseOutcome, phase === "apply" ? "unknown" : "committed");
      await context.session.record("execution", lost.execution);
      const beforeBlockedHistory = await storedHistorySnapshot(context.f);
      const beforeConsumptions = await context.f.records("consumption");
      await assert.rejects(
        context.session.consume({ authorization: pendingAuthorization, request: pending }),
        { code: "MANUAL_SESSION_UNVERIFIED" }
      );
      assert.deepEqual(await storedHistorySnapshot(context.f), beforeBlockedHistory);
      assert.deepEqual(await context.f.records("consumption"), beforeConsumptions);
      const signoff = await acceptanceRecord(context, lost, { alreadyRecorded: true });
      const beforeSignoffs = await context.f.records("signoff");
      await assert.rejects(context.session.record("signoff", signoff), {
        code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
      });
      assert.deepEqual(await context.f.records("signoff"), beforeSignoffs);
      await context.session.close();
      context.session = await context.f.open();
      assert.ok(
        (await context.f.records("execution")).some(
          (value) =>
            value.status === "INTERRUPTED_UNKNOWN" &&
            value.attemptId === lost.request.attemptId &&
            value.resultDigest === null &&
            value.finishedAt === null
        )
      );
      if (phase === "replay") {
        const originalApply = (await context.f.records("execution")).find(
          (value) => sha256Canonical(value) === predecessorDigest
        );
        assert.equal(originalApply.status, "SUCCEEDED");
        assert.deepEqual(encodeManualJson(originalApply), predecessorBytes);
      }
      const request = await requestFixture(context.f, context.session);
      const beforeBlockedSign = await storedHistorySnapshot(context.f);
      await assert.rejects(context.session.sign(request), { code: "MANUAL_SESSION_UNVERIFIED" });
      assert.deepEqual(await storedHistorySnapshot(context.f), beforeBlockedSign);
      await context.session.close();
    });
});

test("dry-run to apply and full replay use the existing state machine with fresh attempts", async (t) => {
  const context = await liveRoot(t),
    { f, session } = context;
  const dry = await liveRunner(context);
  await sealExecution(context, dry);
  const retryPrefix = runnerFixture("apply", dry, {
    session,
    beforeConsume: true,
    attemptId: uuid(802),
    containerId: "e".repeat(64),
    childChallenge: "f".repeat(64)
  });
  await persistArchive(f, retryPrefix.archive);
  f.setTime(time(retryPrefix.n + 5));
  const retryBinding = { ...retryPrefix.request };
  for (const field of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete retryBinding[field];
  const retryInput = {
    binding: retryBinding,
    canonicalBytes: encodeManualJson(retryPrefix.request)
  };
  const presignedRetry = await session.sign(retryInput);
  const apply = await liveRunner(context, "apply", dry);
  await sealExecution(context, apply);
  let states = await operationCheckpoints(f, apply.request.operationId);
  assert.ok(
    states.some(
      (item) => item.value.status === "SUCCEEDED" && item.value.commitState === "committed"
    )
  );
  await t.test(
    "completed apply rejects signing a fresh apply against the old dry-run",
    async () => {
      await assert.rejects(session.sign(retryInput), { code: "MANUAL_SESSION_UNVERIFIED" });
    }
  );
  let duplicateReleased = false;
  await t.test(
    "completed apply rejects consuming an authorization signed before the first apply",
    async () => {
      await assert.rejects(
        session
          .consume({
            authorization: presignedRetry,
            request: retryInput,
            childObservation: pick(retryPrefix.request, [
              "containerId",
              "runnerImageDigest",
              "childChallenge"
            ])
          })
          .then((value) => {
            duplicateReleased = true;
            return value;
          }),
        { code: "MANUAL_SESSION_UNVERIFIED" }
      );
    }
  );
  if (duplicateReleased) {
    await session.close();
    return;
  }
  assert.equal(
    (await f.records("consumption")).filter(
      (value) => value.requestDigest === sha256Canonical(retryPrefix.request)
    ).length,
    0
  );
  const independent = await requestFixture(f, session);
  await session.sign(independent);
  const independentRoot = {
    ...context.root,
    request: { ...context.root.request, operationId: randomUUID(), idempotencyKey: randomUUID() }
  };
  const independentDry = runnerFixture("dry-run", null, {
    root: independentRoot,
    shared: dry.shared,
    session,
    beforeConsume: true,
    n: 320,
    attemptId: uuid(804)
  });
  await persistArchive(f, independentDry.archive);
  f.setTime(time(325));
  const independentBinding = { ...independentDry.request };
  for (const field of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete independentBinding[field];
  assert.notEqual(independentDry.request.operationId, apply.request.operationId);
  await session.sign({
    binding: independentBinding,
    canonicalBytes: encodeManualJson(independentDry.request)
  });
  const replay = await liveRunner(context, "replay", apply);
  await sealExecution(context, replay);
  states = await operationCheckpoints(f, apply.request.operationId);
  assert.ok(
    states.some(
      (item) => item.value.activeAttempt.phase === "replay" && item.value.status === "SUCCEEDED"
    )
  );
  assert.equal(
    states.some((item) => item.value.status === "REPLAYING"),
    false
  );
  assert.notEqual(replay.request.attemptId, apply.request.attemptId);
  const verify = await liveRunner(context, "verify", apply, { freshVerifyOperation: true, n: 620 });
  await sealExecution(context, verify);
  await session.close();
});

test("replay loss preserves original committed checkpoint and all-history stops new authorization", async (t) => {
  const context = await liveRoot(t),
    { f, session } = context;
  const dry = await liveRunner(context);
  await sealExecution(context, dry);
  const apply = await liveRunner(context, "apply", dry);
  await sealExecution(context, apply);
  const before = await operationCheckpoints(f, apply.request.operationId);
  const replay = await liveRunner(context, "replay", apply, {
    missingResult: true,
    missingClose: true,
    unknown: true
  });
  await session.record("execution", replay.execution);
  assert.equal(replay.execution.finishedAt, null);
  const after = await operationCheckpoints(f, apply.request.operationId);
  assert.deepEqual(
    after.map((item) => item.name),
    before.map((item) => item.name)
  );
  for (let i = 0; i < before.length; i++) assert.ok(after[i].bytes.equals(before[i].bytes));
  const another = await requestFixture(f, session);
  await assert.rejects(session.sign(another), { code: "MANUAL_SESSION_UNVERIFIED" });
  await session.close();
  const fresh = await f.open();
  const request = await requestFixture(f, fresh);
  await assert.rejects(fresh.sign(request), { code: "MANUAL_SESSION_UNVERIFIED" });
  await fresh.close();
});

test("partial migration originals retain apply UNKNOWN and cannot be ACCEPTED", async (t) => {
  const context = await liveRoot(t),
    { f, session } = context;
  const dry = await liveRunner(context);
  await sealExecution(context, dry);
  const partial = await liveRunner(context, "apply", dry, { partial: true, unknown: true });
  const assessment = assessManualRunnerEvidence(partial.archive.input(partial.request));
  assert.equal(assessment.executionStatus, "INTERRUPTED_UNKNOWN");
  assert.equal(assessment.originalDatabaseOutcome, "unknown");
  await session.record("execution", partial.execution);
  const before = await operationCheckpoints(f, partial.request.operationId);
  assert.ok(before.some((item) => item.value.status === "INTERRUPTED_UNKNOWN"));
  const archiveCustody = custody(session, partial.execution);
  archiveCustody.recordedAt = archiveCustody.observedAt = partial.execution.recordedAt;
  const archive = await session.record("custody", archiveCustody);
  await f.put(partial.execution, "backup");
  const backupCustody = custody(session, partial.execution, "backup");
  backupCustody.recordedAt = backupCustody.observedAt = partial.execution.recordedAt;
  const backup = await session.record("custody", backupCustody);
  const signoff = manualRecord(session, "signoff", {
    ...pick(partial.execution, operationKeys),
    ownerId: "test-owner",
    executionRecordDigest: sha256Canonical(partial.execution),
    executionReadbackDigest: archive.recordDigest,
    backupReadbackDigest: backup.recordDigest,
    decision: "ACCEPTED",
    reasonCode: null
  });
  signoff.recordedAt = partial.execution.recordedAt;
  await assert.rejects(session.record("signoff", signoff), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  assert.deepEqual(await operationCheckpoints(f, partial.request.operationId), before);
  assert.equal(
    (await f.records("execution")).find((r) => r.attemptId === partial.request.attemptId).status,
    "INTERRUPTED_UNKNOWN"
  );
  await assert.rejects(session.sign(await requestFixture(f, session)), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await session.close();
});

async function childParent(f, t, initialize) {
  const moduleUrl = new URL("../src/manual-stage1-session.mjs", import.meta.url).href;
  const source = `
    import * as fs from 'node:fs/promises';
    import path from 'node:path';
    import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
    import { openManualSession } from ${JSON.stringify(moduleUrl)};
    import { encodeManualJson } from ${JSON.stringify(new URL("../src/manual-stage1-contracts.mjs", import.meta.url).href)};
    const hash = value => 'sha256:'+createHash('sha256').update(encodeManualJson(value)).digest('hex');
    let input=''; for await (const chunk of process.stdin) { input+=chunk; if (input.length>1048576) process.exit(2); }
    const {profile,ownerObservation,initialize}=JSON.parse(input), keys=generateKeyPairSync('ed25519');
    profile.publicKeyPem=keys.publicKey.export({type:'spki',format:'pem'});
    profile.keyFingerprint='sha256:'+createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex');
    const io={fs,execFile:async(file)=>({stdout:file==='powershell.exe'?ownerObservation.principal.sid+'\\n'+ownerObservation.principal.sid+'|Allow|2032127\\n':'ACL',stderr:''})};
    if(initialize){
      const r={schemaVersion:'manual-operation-record.v1',kind:'revocation',profileDigest:hash(profile),recordedAt:${JSON.stringify(NOW)},promotionEligible:false,ownerId:profile.ownerId,sequence:0,previousRevocationDigest:null,action:'GENESIS',authorizationId:null,reasonCode:null};
      for(const file of [path.join(profile.storage.journalRoot,'objects',hash(r).slice(7)+'.json'),path.join(profile.storage.journalRoot,'revocations',hash(profile).slice(7)+'-0.json')]) await fs.writeFile(file,encodeManualJson(r),{flag:'wx',mode:0o600});
    }
    try { const session=await openManualSession({profile,ownerObservation,io,now:()=>${JSON.stringify(NOW)},signingKey:keys.privateKey});
      const binding={profileDigest:session.profileDigest,ownerId:profile.ownerId,sessionId:session.sessionId,sessionNonce:session.sessionNonce,operationId:randomUUID(),idempotencyKey:'child-test-only',purpose:'synthetic-fresh',targetIntent:session.targetIntent,stage:'target-observe',capability:'verify'};
      const request={...binding,schemaVersion:'manual-runner-request.v1',attemptId:randomUUID(),runId:randomUUID()};
      const a={schemaVersion:'manual-runner-evidence.v1',kind:'attempt-allocation',recordedAt:${JSON.stringify(NOW)},promotionEligible:false,...Object.fromEntries(['profileDigest','sessionId','sessionNonce','operationId','idempotencyKey','attemptId','runId'].map(k=>[k,request[k]])),stage:'target-observe',phaseKey:'target-observe',allocatedAt:${JSON.stringify(NOW)},targetIntent:session.targetIntent,predecessorExecutionRecordDigest:null};
      request.attemptAllocationDigest=hash(a);
      for(const value of [a,request]) await fs.writeFile(path.join(profile.storage.archiveRoot,'objects',hash(value).slice(7)+'.json'),encodeManualJson(value),{flag:'wx',mode:0o600});
      const authorization=await session.sign({binding,canonicalBytes:encodeManualJson(request)});
      process.stdout.write(JSON.stringify({ready:true,sessionId:session.sessionId,authorization})+'\\n');
      setInterval(()=>{},1000);
    } catch(error){ process.stdout.write(JSON.stringify({code:error.code})+'\\n'); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("close", resolve));
    }
  });
  child.stdin.end(
    JSON.stringify({ profile: f.profile, ownerObservation: f.ownerObservation, initialize })
  );
  const result = await new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (bytes) => {
      text += bytes;
      if (text.includes("\n")) resolve(JSON.parse(text.trim()));
    });
    child.once("error", reject);
    child.once("close", () => {
      if (!text) reject(new Error(`Child exited without result: ${stderr}`));
    });
  });
  return { child, result };
}

test("real second parent process cannot acquire the held canonical target lock", async (t) => {
  const f = await fixture(t),
    session = await f.open();
  const second = await childParent(f, t, false);
  assert.equal(second.result.code, "MANUAL_SESSION_UNVERIFIED");
  await session.close();
});

test("actual parent process death preserves its unclosed history and cannot resurrect its session", async (t) => {
  const f = await fixture(t),
    { child, result } = await childParent(f, t, true);
  assert.equal(result.ready, true);
  assert.equal(result.authorization.payload.sessionId, result.sessionId);
  const stopped = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await stopped;
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
  const records = (await f.records("session")).filter((r) => r.sessionId === result.sessionId);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "OPEN");
});

test("runner signing cannot refer to absent approved schema expectation originals", async (t) => {
  const context = await liveRoot(t),
    { f, session, root } = context;
  const prefix = runnerFixture("dry-run", null, { root, session, beforeConsume: true });
  await persistArchive(f, prefix.archive);
  f.setTime(time(prefix.n + 5));
  const binding = { ...prefix.request };
  for (const key of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete binding[key];
  await fs.unlink(
    jsonPath(f.profile.storage.archiveRoot, prefix.request.expectedSchemaEvidenceDigest)
  );
  await assert.rejects(
    session.sign({ binding, canonicalBytes: encodeManualJson(prefix.request) }),
    { code: "MANUAL_EVIDENCE_INPUT_REQUIRED" }
  );
  await session.close();
});

test("package entry exposes the session without exposing a new adapter factory", async (t) => {
  const publicApi = await import("../src/index.mjs");
  assert.equal(typeof publicApi.openManualSession, "function");
  assert.equal(publicApi.openManualSession, openManualSession);
});

test("last revocation arriving during final slot observation prevents capability release", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request),
    open = f.io.fs.open;
  let reads = 0;
  f.io.fs.open = async (file, flags, ...args) => {
    if (flags === "r" && file.includes(`${path.sep}consumptions${path.sep}`) && ++reads === 2) {
      const genesis = (await f.records("revocation"))[0];
      const value = manualRecord(session, "revocation", {
        ownerId: "test-owner",
        sequence: 1,
        previousRevocationDigest: sha256Canonical(genesis),
        action: "REVOKE_AUTHORIZATION",
        authorizationId: authorization.payload.authorizationId,
        reasonCode: "OWNER_REVOKED"
      });
      await f.put(value, "journal");
      await fs.writeFile(
        path.join(
          f.profile.storage.journalRoot,
          "revocations",
          `${session.profileDigest.slice(7)}-1.json`
        ),
        encodeManualJson(value),
        { flag: "wx", mode: 0o600 }
      );
    }
    return open(file, flags, ...args);
  };
  let released = 0;
  await assert.rejects(
    session.consume({ authorization, request }).then(() => released++),
    { code: "MANUAL_AUTHORIZATION_REVOKED" }
  );
  assert.equal(released, 0);
  assert.equal((await f.records("consumption")).length, 1);
  assert.equal((await f.records("execution"))[0].status, "INTERRUPTED_UNKNOWN");
  f.io.fs.open = open;
  await session.close();
});

test("closed-write readback failure returns no CLOSED reference and preserves UNKNOWN", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    open = f.io.fs.open;
  let rejectPath = null;
  f.io.fs.open = async (file, flags, ...args) => {
    if (flags === "r" && file === rejectPath) {
      rejectPath = null;
      throw Object.assign(new Error("readback unavailable"), { code: "EIO" });
    }
    const handle = await open(file, flags, ...args);
    if (flags === "wx") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => {
        await write(bytes);
        if (JSON.parse(bytes).status === "CLOSED") rejectPath = file;
      };
    }
    return handle;
  };
  await assert.rejects(session.close(), { code: "MANUAL_STORAGE_UNVERIFIED" });
  assert.ok((await f.records("session")).some((r) => r.status === "INTERRUPTED_UNKNOWN"));
  await assert.rejects(f.open(), { code: "MANUAL_SESSION_UNVERIFIED" });
});

test("new-session reconcile can prove not-committed without erasing original UNKNOWN", async (t) => {
  const context = await liveRoot(t),
    { f } = context;
  const dry = await liveRunner(context);
  await sealExecution(context, dry);
  const original = await liveRunner(context, "apply", dry, { beforeCredential: true });
  await context.session.record("execution", original.execution);
  await context.session.close();
  context.session = await f.open();
  const recovered = await liveRunner(context, "reconcile", original, { emptyRows: true });
  assert.equal(
    assessManualRunnerEvidence(recovered.archive.input(recovered.request)).originalDatabaseOutcome,
    "not-committed"
  );
  await context.session.record("execution", recovered.execution);
  const states = await operationCheckpoints(f, original.request.operationId);
  assert.ok(
    states.some(
      (item) => item.value.status === "FAILED" && item.value.commitState === "not-committed"
    )
  );
  assert.equal(
    (await f.records("execution")).find(
      (r) => sha256Canonical(r) === sha256Canonical(original.execution)
    ).status,
    "INTERRUPTED_UNKNOWN"
  );
  const readOnly = await requestFixture(f, context.session);
  await context.session.sign(readOnly);
  for (const [phase, previous, attemptId] of [
    ["dry-run", null, uuid(801)],
    ["apply", dry, uuid(802)],
    ["replay", original, uuid(803)]
  ]) {
    const retry = runnerFixture(phase, previous, {
      root: context.root,
      shared: dry.shared,
      session: context.session,
      beforeConsume: true,
      n: 620,
      attemptId
    });
    await persistArchive(f, retry.archive);
    f.setTime(time(625));
    const binding = { ...retry.request };
    for (const key of [
      "schemaVersion",
      "attemptId",
      "runId",
      "attemptAllocationDigest",
      "domainInput",
      "expectedSchemaEvidenceDigest"
    ])
      delete binding[key];
    assert.equal(retry.request.operationId, original.request.operationId);
    assert.equal(retry.request.idempotencyKey, original.request.idempotencyKey);
    assert.notEqual(retry.request.attemptId, original.request.attemptId);
    assert.equal(retry.request.sessionId, context.session.sessionId);
    await assert.rejects(
      context.session.sign({ binding, canonicalBytes: encodeManualJson(retry.request) }),
      { code: "MANUAL_SESSION_UNVERIFIED" }
    );
  }
  await context.session.close();
});

async function unknownHistory(t, phase, fixtureOptions = {}) {
  const context = await liveRoot(t, fixtureOptions);
  const dry = await liveRunner(context);
  await sealExecution(context, dry);
  let predecessor = dry;
  if (phase === "replay") {
    predecessor = await liveRunner(context, "apply", dry);
    await sealExecution(context, predecessor);
  }
  const original = await liveRunner(context, phase, predecessor, {
    ...(phase === "apply"
      ? { beforeCredential: true }
      : { missingResult: true, missingClose: true, unknown: true })
  });
  await context.session.record("execution", original.execution);
  await context.session.close();
  return { context, dry, predecessor, original };
}

const retainedHistoryDirectories = [
  ["archiveRoot", ["objects", "raw"]],
  ["journalRoot", ["objects", "consumptions", "revocations", "checkpoints"]],
  ["backupRoot", ["objects"]]
];

async function storedHistorySnapshot(f) {
  const stored = [];
  for (const [rootKey, directories] of retainedHistoryDirectories)
    for (const directory of directories) {
      const dir = path.join(f.profile.storage[rootKey], directory);
      for (const name of await fs.readdir(dir)) {
        const file = path.join(dir, name);
        stored.push({ file, bytes: await fs.readFile(file) });
      }
    }
  return stored.sort((a, b) => a.file.localeCompare(b.file));
}

async function copyStoredHistory(source, target) {
  const copied = [];
  for (const [rootKey, directories] of retainedHistoryDirectories) {
    for (const directory of directories) {
      const sourceDir = path.join(source.profile.storage[rootKey], directory);
      const targetDir = path.join(target.profile.storage[rootKey], directory);
      for (const name of await fs.readdir(sourceDir)) {
        const bytes = await fs.readFile(path.join(sourceDir, name));
        const file = path.join(targetDir, name);
        try {
          await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          assert.deepEqual(await fs.readFile(file), bytes);
        }
        copied.push({ file, bytes });
      }
    }
  }
  return copied;
}

async function assertStoredHistory(copied) {
  for (const item of copied) assert.deepEqual(await fs.readFile(item.file), item.bytes);
}

function requestInput(request) {
  const binding = { ...request };
  for (const key of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete binding[key];
  return { binding, canonicalBytes: encodeManualJson(request) };
}

async function crossProfileReconcile(f, session, context, original) {
  const archive = archiveFixture(f.profile);
  for (const value of original.archive.artifacts.values()) archive.add(value);
  for (const bytes of original.archive.raws.values()) archive.raw(bytes);
  const root = {
    ...context.root,
    archive,
    request: { ...context.root.request, profileDigest: session.profileDigest },
    session
  };
  const previous = { ...original, root, archive };
  const recovery = runnerFixture("reconcile", previous, {
    root,
    session,
    shared: original.shared,
    beforeConsume: true,
    n: 720
  });
  await persistArchive(f, recovery.archive);
  f.setTime(time(725));
  return { recovery, input: requestInput(recovery.request) };
}

for (const phase of ["apply", "replay"])
  test(`unresolved legacy v1 ${phase} blocks valid v2 sign, consume, and ACCEPTED`, async (t) => {
    const legacy = await unknownHistory(t, phase);
    const currentAt = time(600);
    const current = await liveRoot(t, { profileVersion: "v2", recordedAt: currentAt });
    const signoff = await acceptanceRecord(current, current.root, { alreadyRecorded: true });
    const blockedSign = await requestFixture(
      current.f,
      current.session,
      "target-observe",
      {},
      currentAt
    );
    const pending = await requestFixture(
      current.f,
      current.session,
      "target-observe",
      {},
      currentAt
    );
    const authorization = await current.session.sign(pending);
    const copied = await copyStoredHistory(legacy.context.f, current.f);
    const beforeBlockedOutputs = await storedHistorySnapshot(current.f);
    const beforeConsumptions = await current.f.records("consumption");
    const beforeSignoffs = await current.f.records("signoff");

    await assert.rejects(current.session.sign(blockedSign), {
      code: "MANUAL_SESSION_UNVERIFIED"
    });
    assert.deepEqual(await storedHistorySnapshot(current.f), beforeBlockedOutputs);
    await assert.rejects(current.session.record("signoff", signoff), {
      code: "MANUAL_SESSION_UNVERIFIED"
    });
    assert.deepEqual(await storedHistorySnapshot(current.f), beforeBlockedOutputs);
    assert.deepEqual(await current.f.records("signoff"), beforeSignoffs);

    await assert.rejects(
      current.session
        .consume({ authorization, request: pending })
        .then(() => assert.fail("unresolved legacy history released a v2 capability")),
      { code: "MANUAL_SESSION_UNVERIFIED" }
    );
    assert.equal(
      (await current.f.records("consumption")).filter(
        (value) => value.requestDigest === sha256Bytes(pending.canonicalBytes)
      ).length,
      0
    );
    assert.deepEqual(await current.f.records("consumption"), beforeConsumptions);
    assert.deepEqual(await storedHistorySnapshot(current.f), beforeBlockedOutputs);
    if (phase === "apply") {
      const recovery = await crossProfileReconcile(
        current.f,
        current.session,
        legacy.context,
        legacy.original
      );
      await assert.rejects(current.session.sign(recovery.input), {
        code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
      });
    }
    await assertStoredHistory(copied);
    assert.ok(
      (await current.f.records("execution")).some(
        (value) =>
          sha256Canonical(value) === sha256Canonical(legacy.original.execution) &&
          value.status === "INTERRUPTED_UNKNOWN"
      )
    );
    await current.session.close();
    await assertStoredHistory(copied);
  });

test("a consumed legacy v1 authorization stays one-time while completed history permits v2", async (t) => {
  const context = await liveRoot(t);
  const { f, root } = context;
  await acceptExecution(context, root, { alreadyRecorded: true });
  const oldInput = requestInput(root.request);
  const slotDir = path.join(f.profile.storage.journalRoot, "consumptions");
  const oldSlotName = (await fs.readdir(slotDir))[0];
  const oldSlotBytes = await fs.readFile(path.join(slotDir, oldSlotName));
  await context.session.close();

  await selectProfileVersion(f, "v2");
  const session = await f.open();
  await assert.rejects(session.consume({ authorization: root.authorization, request: oldInput }), {
    code: "MANUAL_BINDING_MISMATCH"
  });
  assert.deepEqual(await fs.readFile(path.join(slotDir, oldSlotName)), oldSlotBytes);
  assert.equal((await fs.readdir(slotDir)).length, 1);

  const input = await requestFixture(f, session);
  const authorization = await session.sign(input);
  await session.consume({ authorization, request: input });
  const execution = await observeResult(f, session, input);
  await acceptExecution({ f, session }, execution);
  assert.deepEqual(await fs.readFile(path.join(slotDir, oldSlotName)), oldSlotBytes);
  assert.equal((await fs.readdir(slotDir)).length, 2);
  await session.close();
});

test("resolved legacy v1 UNKNOWN permits an independent v2 operation without deleting history", async (t) => {
  const { context, original } = await unknownHistory(t, "apply");
  const { f } = context;
  context.session = await f.open();
  const recovered = await liveRunner(context, "reconcile", original, { emptyRows: true });
  await context.session.record("execution", recovered.execution);
  await context.session.close();
  const historicalBytes = await storedHistorySnapshot(f);
  const historicalDigests = new Set((await f.records()).map(sha256Canonical));

  const continuedAt = time(600);
  f.setTime(continuedAt);
  await selectProfileVersion(f, "v2", continuedAt);
  const session = await f.open();
  const input = await requestFixture(f, session, "target-observe", {}, continuedAt);
  const authorization = await session.sign(input);
  await session.consume({ authorization, request: input });
  const execution = await observeResult(f, session, input, { recordedAt: continuedAt });
  await acceptExecution({ f, session }, execution);

  const records = await f.records();
  const currentDigests = new Set(records.map(sha256Canonical));
  assert.ok([...historicalDigests].every((digest) => currentDigests.has(digest)));
  assert.ok(
    records.some(
      (value) =>
        sha256Canonical(value) === sha256Canonical(original.execution) &&
        value.status === "INTERRUPTED_UNKNOWN"
    )
  );
  assert.ok(
    records.some(
      (value) =>
        value.kind === "execution" &&
        value.schemaVersion === "manual-operation-record.v2" &&
        value.status === "SUCCEEDED"
    )
  );
  await session.close();
  await assertStoredHistory(historicalBytes);
});

test("resolved foreign v2 UNKNOWN without canonical profile bytes blocks an independent v2 sign", async (t) => {
  const { context, original } = await unknownHistory(t, "apply", {
    profileVersion: "v2"
  });
  const { f } = context;
  const profileABytes = encodeManualJson(f.profile);
  const profileADigest = sha256Bytes(profileABytes);
  context.session = await f.open();
  const recovered = await liveRunner(context, "reconcile", original, { emptyRows: true });
  await context.session.record("execution", recovered.execution);
  await context.session.close();
  const historicalBytes = await storedHistorySnapshot(f);
  assert.equal(
    historicalBytes.some(({ bytes }) => bytes.equals(profileABytes)),
    false
  );

  const currentAt = time(600);
  f.setTime(currentAt);
  await selectProfileVersion(f, "v2", currentAt);
  const session = await f.open();
  assert.notEqual(session.profileDigest, profileADigest);
  const input = await requestFixture(f, session, "target-observe", {}, currentAt);
  const beforeSign = await storedHistorySnapshot(f);
  await assert.rejects(session.sign(input), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  assert.deepEqual(await storedHistorySnapshot(f), beforeSign);
  await assertStoredHistory(historicalBytes);
  await session.close();
  await assertStoredHistory(historicalBytes);
});

test("a partially persisted revocation cannot be silently treated as not revoked", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request),
    open = f.io.fs.open;
  f.io.fs.open = async (file, flags, ...args) => {
    if (flags === "wx" && file.includes(`${path.sep}revocations${path.sep}`))
      throw Object.assign(new Error("journal write unavailable"), { code: "EIO" });
    return open(file, flags, ...args);
  };
  await assert.rejects(revoke(f, session, authorization), { code: "MANUAL_STORAGE_UNVERIFIED" });
  f.io.fs.open = open;
  await assert.rejects(session.sign(request), { code: "MANUAL_REVOCATION_UNVERIFIED" });
  await session.close();
});

test("same database name at a different fixed endpoint is not unresolved history for this lock", async (t) => {
  const f = await fixture(t);
  f.profile.allowedTargets.push({
    ...clone(f.profile.allowedTargets[0]),
    endpointPolicyId: "other-endpoint",
    endpoint: "other.invalid:5432"
  });
  const genesis = {
    ...(await f.records("revocation"))[0],
    profileDigest: sha256Canonical(f.profile)
  };
  await f.put(genesis, "journal");
  await fs.writeFile(
    path.join(
      f.profile.storage.journalRoot,
      "revocations",
      `${genesis.profileDigest.slice(7)}-0.json`
    ),
    encodeManualJson(genesis),
    { flag: "wx", mode: 0o600 }
  );
  const first = await f.open(),
    request = await requestFixture(f, first),
    authorization = await first.sign(request);
  await first.consume({ authorization, request });
  f.ownerObservation.targetIntent = {
    endpointPolicyId: "other-endpoint",
    databaseName: targetIntent.databaseName
  };
  const second = await f.open();
  const consumed = (await f.records("consumption"))[0];
  const foreignPost = manualRecord(first, "post-state", {
    ...pick(JSON.parse(request.canonicalBytes), operationKeys),
    requestDigest: sha256Bytes(request.canonicalBytes),
    consumptionRecordDigest: sha256Canonical(consumed),
    outcome: "UNAVAILABLE",
    observationDigest: null,
    observedAt: null,
    reasonCode: "OBSERVER_FAILED"
  });
  await assert.rejects(second.record("post-state", foreignPost), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  await second.sign(await requestFixture(f, second));
  await second.close();
  await first.close();
});

test("MATCH custody pointing to another original cannot support ACCEPTED signoff", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    request = await requestFixture(f, session);
  const authorization = await session.sign(request);
  await session.consume({ authorization, request });
  const result = await observeResult(f, session, request);
  await session.record("execution", result.execution);
  await f.put(result.execution, "backup");
  const backup = await session.record("custody", custody(session, result.execution, "backup"));
  const wrong = await session.record("custody", custody(session, result.post));
  const value = manualRecord(session, "signoff", {
    ...pick(result.execution, operationKeys),
    ownerId: "test-owner",
    executionRecordDigest: sha256Canonical(result.execution),
    executionReadbackDigest: wrong.recordDigest,
    backupReadbackDigest: backup.recordDigest,
    decision: "ACCEPTED",
    reasonCode: null
  });
  await assert.rejects(session.record("signoff", value), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  assert.equal((await f.records("signoff")).length, 0);
  await session.close();
});

test("a later unresolved target attempt prevents ACCEPTED signoff of an older success", async (t) => {
  const context = await liveRoot(t),
    { f, session, root } = context;
  const archive = await session.record("custody", custody(session, root.execution));
  await f.put(root.execution, "backup");
  const backup = await session.record("custody", custody(session, root.execution, "backup"));
  const next = await requestFixture(f, session),
    authorization = await session.sign(next);
  await session.consume({ authorization, request: next });
  const signoff = manualRecord(session, "signoff", {
    ...pick(root.execution, operationKeys),
    ownerId: "test-owner",
    executionRecordDigest: sha256Canonical(root.execution),
    executionReadbackDigest: archive.recordDigest,
    backupReadbackDigest: backup.recordDigest,
    decision: "ACCEPTED",
    reasonCode: null
  });
  await assert.rejects(session.record("signoff", signoff), { code: "MANUAL_SESSION_UNVERIFIED" });
  assert.equal((await f.records("signoff")).length, 0);
  await session.close();
});

test("UNKNOWN execution cannot invent a started time without its result original", async (t) => {
  const f = await fixture(t),
    session = await f.open(),
    input = await requestFixture(f, session);
  const request = JSON.parse(input.canonicalBytes),
    authorization = await session.sign(input);
  await session.consume({ authorization, request: input });
  const consumption = (await f.records("consumption"))[0];
  const value = manualRecord(session, "execution", {
    ...pick(request, operationKeys),
    attemptId: request.attemptId,
    requestDigest: sha256Canonical(request),
    authorizationDigest: sha256Canonical(authorization),
    consumptionRecordDigest: sha256Canonical(consumption),
    handoffRecordDigest: null,
    handoffReadbackDigest: null,
    postStateRecordDigest: null,
    predecessorExecutionRecordDigest: null,
    startedAt: NOW,
    finishedAt: null,
    status: "INTERRUPTED_UNKNOWN",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    resultDigest: null,
    processEvidenceDigest: null
  });
  await assert.rejects(session.record("execution", value), {
    code: "MANUAL_EVIDENCE_BINDING_MISMATCH"
  });
  assert.equal((await f.records("execution")).length, 0);
  await session.close();
});

test("advancing clock never relabels an earlier revocation read as the later signing instant", async (t) => {
  const f = await fixture(t);
  let epoch = Date.parse(NOW),
    actualRead = null;
  const completed = new Map(),
    custodyTimes = [];
  f.setTime(() => new Date(epoch++).toISOString());
  const session = await f.open(),
    request = await requestFixture(f, session),
    open = f.io.fs.open;
  f.io.fs.open = async (file, flags, ...args) => {
    const handle = await open(file, flags, ...args);
    if (flags === "r" && file.includes(`${path.sep}revocations${path.sep}`)) actualRead = epoch;
    if (flags === "r") {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        if (result.bytesRead === 0) completed.set(file, epoch);
        return result;
      };
    }
    if (flags === "wx") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => {
        const value = JSON.parse(bytes);
        if (value.kind === "custody" && value.outcome === "MATCH")
          custodyTimes.push(
            Date.parse(value.observedAt) >=
              completed.get(
                jsonPath(f.profile.storage[`${value.storageRole}Root`], value.subjectDigest)
              )
          );
        return write(bytes);
      };
    }
    return handle;
  };
  const authorization = await session.sign(request);
  assert.ok(Date.parse(authorization.payload.issuedAt) <= actualRead);
  await session.consume({ authorization, request });
  assert.ok(custodyTimes.length > 0 && custodyTimes.every(Boolean));
  await session.close();
});

test("slow final history completes before the thirty-second handoff window starts", async (t) => {
  const context = await liveRoot(t),
    { f, session, root } = context;
  const prefix = runnerFixture("dry-run", null, { root, session, beforeConsume: true });
  await persistArchive(f, prefix.archive);
  f.setTime(time(prefix.n + 5));
  const binding = { ...prefix.request };
  for (const key of [
    "schemaVersion",
    "attemptId",
    "runId",
    "attemptAllocationDigest",
    "domainInput",
    "expectedSchemaEvidenceDigest"
  ])
    delete binding[key];
  const request = { binding, canonicalBytes: encodeManualJson(prefix.request) },
    authorization = await session.sign(request);
  const open = f.io.fs.open,
    readdir = f.io.fs.readdir;
  let afterReadback = false,
    delayed = false;
  f.io.fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => {
        await write(bytes);
        const value = JSON.parse(bytes);
        if (value.kind === "custody" && value.purpose === "consumption-readback")
          afterReadback = true;
      };
    }
    return handle;
  };
  f.io.fs.readdir = async (dir, ...args) => {
    const result = await readdir(dir, ...args);
    if (afterReadback && !delayed && dir === path.join(f.profile.storage.archiveRoot, "objects")) {
      delayed = true;
      f.setTime(time(prefix.n + 36));
    }
    return result;
  };
  const result = await session.consume({
    authorization,
    request,
    childObservation: pick(prefix.request, ["containerId", "runnerImageDigest", "childChallenge"])
  });
  assert.equal(delayed, true);
  assert.equal(result.handoffReceipt.issuedAt, time(prefix.n + 36));
  f.io.fs.open = open;
  f.io.fs.readdir = readdir;
  await session.close();
});

for (const mode of ["expired-receipt", "receipt-storage-failure"]) {
  test(`${mode} never releases a runner capability and retains the original attempt`, async (t) => {
    const context = await liveRoot(t),
      { f, session, root } = context;
    const prefix = runnerFixture("dry-run", null, { root, session, beforeConsume: true });
    await persistArchive(f, prefix.archive);
    f.setTime(time(prefix.n + 5));
    const binding = { ...prefix.request };
    for (const key of [
      "schemaVersion",
      "attemptId",
      "runId",
      "attemptAllocationDigest",
      "domainInput",
      "expectedSchemaEvidenceDigest"
    ])
      delete binding[key];
    const request = { binding, canonicalBytes: encodeManualJson(prefix.request) },
      authorization = await session.sign(request),
      open = f.io.fs.open;
    let rejectNext = false;
    f.io.fs.open = async (file, flags, ...args) => {
      if (mode === "receipt-storage-failure" && rejectNext && flags === "wx") {
        rejectNext = false;
        throw Object.assign(new Error("receipt storage unavailable"), { code: "EIO" });
      }
      const handle = await open(file, flags, ...args);
      if (flags === "wx") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (bytes) => {
          await write(bytes);
          const value = JSON.parse(bytes);
          if (value.kind === "consumption-handoff" && mode === "expired-receipt")
            f.setTime(value.expiresAt);
          if (value.kind === "custody" && value.purpose === "consumption-readback")
            rejectNext = true;
        };
      }
      return handle;
    };
    let released = 0;
    await assert.rejects(
      session
        .consume({
          authorization,
          request,
          childObservation: pick(prefix.request, [
            "containerId",
            "runnerImageDigest",
            "childChallenge"
          ])
        })
        .then(() => released++),
      { code: mode === "expired-receipt" ? "MANUAL_TIME_INVALID" : "MANUAL_STORAGE_UNVERIFIED" }
    );
    assert.equal(released, 0);
    const unknown = (await f.records("execution")).find(
      (r) => r.attemptId === prefix.request.attemptId
    );
    assert.equal(unknown.status, "INTERRUPTED_UNKNOWN");
    assert.equal(unknown.finishedAt, null);
    f.io.fs.open = open;
    await session.close();
  });
}

function r3CreationFixture(f) {
  const operationRef = uuid(701);
  const id = operationRef.replaceAll("-", "");
  const workspace = {
    id,
    capacityBytes: 128 * 1048576,
    backingFile: `/var/lib/stage1-snapshots/${id}.luks`,
    mountPath: `/srv/stage1-snapshot/${id}`,
    keyFile: `/dev/shm/stage1-keys/${id}.key`,
    mapperName: `s1snap_${id}`
  };
  const creationSpec = {
    schemaVersion: "manual-r3-creation-spec.v1",
    operationRef,
    profileDigest: sha256Canonical(f.profile),
    ownerId: f.profile.ownerId,
    sourceSha: "a".repeat(40),
    buildProofDigest: D,
    proofRawDigest: "sha256:" + "1".repeat(64),
    materialRawDigest: "sha256:" + "2".repeat(64),
    targetPolicyDigest: "sha256:" + "3".repeat(64),
    phase: "source",
    chain: "fresh",
    createdAt: time(-1),
    expiresAt: time(600),
    workspace,
    cleanup: "stop-owned-engine-and-remove-workspace"
  };
  const jobAdmission = {
    schemaVersion: "manual-r3-job-admission.v1",
    operationRef,
    profileDigest: creationSpec.profileDigest,
    ownerId: creationSpec.ownerId,
    creationSpecDigest: sha256Canonical(creationSpec),
    buildProofDigest: creationSpec.buildProofDigest,
    sourceSha: creationSpec.sourceSha,
    phase: creationSpec.phase,
    chain: creationSpec.chain,
    generatedAt: NOW,
    expiresAt: time(300),
    ci: {
      repository: "keqi119/subscription-Saas",
      repositoryId: "1253231368",
      runId: "123",
      runAttempt: 1,
      workflowPath: ".github/workflows/release-candidate-gate.yml",
      callerWorkflowPath: ".github/workflows/release-candidate-gate.yml",
      jobKey: "source-fresh",
      jobId: "456",
      jobName: "source-fresh",
      environment: "trusted-source-database-gate",
      runnerClass: "github-hosted"
    },
    host: {
      machineIdFingerprint: D,
      forwardingPublicKeyPem: f.profile.publicKeyPem,
      forwardingKeyFingerprint: f.profile.keyFingerprint,
      runnerId: 1,
      runnerName: "runner"
    }
  };
  const scope = {
    targetPolicyDigest: creationSpec.targetPolicyDigest,
    creationSpecDigest: sha256Canonical(creationSpec),
    jobAdmissionDigest: sha256Canonical(jobAdmission),
    buildProofDigest: creationSpec.buildProofDigest,
    sourceSha: creationSpec.sourceSha,
    phase: creationSpec.phase,
    chain: creationSpec.chain
  };
  return { scope, creationSpec, jobAdmission };
}

async function r3CreationSession(t, f, context = r3CreationFixture(f), clock = { value: NOW }) {
  const session = await openManualSession({
    profile: f.profile,
    ownerObservation: {
      ownerId: f.profile.ownerId,
      principal: f.ownerObservation.principal,
      scope: context.scope,
      observedAt: NOW
    },
    r3CreationContext: context,
    io: f.io,
    now: () => clock.value,
    signingKey: f.keys.privateKey
  });
  t.after(() => session.close().catch(() => {}));
  return session;
}

async function r3CreationRequest(f, session, fields = {}) {
  const operationId = f.r3OperationId ?? uuid(701);
  const request = {
    schemaVersion: "manual-runner-request.v4",
    profileDigest: session.profileDigest,
    ownerId: f.profile.ownerId,
    sessionId: session.sessionId,
    sessionNonce: session.sessionNonce,
    operationId,
    idempotencyKey: `r3:${operationId}`,
    attemptId: randomUUID(),
    runId: randomUUID(),
    stage: "target-create",
    capability: "create-isolated-target",
    purpose: "stage1-isolated-database-tests",
    phase: session.scope.phase,
    chain: session.scope.chain,
    sourceSha: session.scope.sourceSha,
    targetPolicyDigest: session.scope.targetPolicyDigest,
    creationSpecDigest: session.scope.creationSpecDigest,
    jobAdmissionDigest: session.scope.jobAdmissionDigest,
    candidate: { buildProofDigest: session.scope.buildProofDigest },
    ...fields
  };
  const allocation = {
    schemaVersion: "manual-runner-evidence.v2",
    kind: "attempt-allocation",
    profileDigest: request.profileDigest,
    recordedAt: NOW,
    promotionEligible: false,
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    sessionRecordDigest: sha256Canonical(
      (await f.records("session")).find((v) => v.sessionId === session.sessionId)
    ),
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    runId: request.runId,
    stage: request.stage,
    phase: request.phase,
    chain: request.chain,
    allocatedAt: NOW,
    sourceSha: request.sourceSha,
    buildProofDigest: request.candidate.buildProofDigest,
    targetPolicyDigest: request.targetPolicyDigest,
    creationSpecDigest: request.creationSpecDigest,
    jobAdmissionDigest: request.jobAdmissionDigest,
    predecessorExecutionRecordDigest: null
  };
  request.attemptAllocationDigest = await f.put(allocation);
  await f.put(request);
  const {
    schemaVersion,
    attemptId,
    runId,
    attemptAllocationDigest,
    sourceSha,
    candidate,
    ...binding
  } = request;
  return { binding, canonicalBytes: encodeManualJson(request) };
}

test("R3 creation consumes once and persists UNKNOWN before returning", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const clock = { value: NOW };
  const session = await r3CreationSession(t, f, r3CreationFixture(f), clock);
  assert.deepEqual(
    Object.keys(session).sort(),
    [
      "profileDigest",
      "sessionId",
      "sessionNonce",
      "scope",
      "sign",
      "consume",
      "holdTargets",
      "completeCreation",
      "registerLifecycleTarget",
      "completeSnapshot",
      "assertCandidateUse",
      "verifySourceOriginals",
      "custodySourceOriginals",
      "completeSource",
      "record",
      "close"
    ].sort()
  );
  const request = await r3CreationRequest(f, session);
  const authorization = await session.sign(request);
  assert.equal(authorization.payload.schemaVersion, "manual-launch-authorization.v4");
  const result = await session.consume({ authorization, request });
  assert.equal(result.stage, "target-create");
  const execution = (await f.records("execution"))[0];
  assert.equal(execution.status, "INTERRUPTED_UNKNOWN");
  assert.equal(execution.resultDigest, null);
  assert.equal(execution.finishedAt, null);
  assert.equal(result.executionRecordDigest, sha256Canonical(execution));
  assert.equal((await f.records("consumption")).length, 1);
  await assert.rejects(session.completeSnapshot(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.assertCandidateUse(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.assertCandidateUse({ approved: true }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await assert.rejects(session.verifySourceOriginals(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.verifySourceOriginals({ status: "PASSED" }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await assert.rejects(session.custodySourceOriginals(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.completeSource(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.completeSource({ status: "SUCCEEDED" }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await assert.rejects(session.custodySourceOriginals({ approved: true }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await assert.rejects(session.registerLifecycleTarget({ record: {} }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await assert.rejects(
    session.completeCreation({ destinationDigest: sha256Canonical({ destination: "untrusted" }) }),
    { code: "MANUAL_SESSION_UNVERIFIED" }
  );
  await assert.rejects(session.consume({ authorization, request }), {
    code: "MANUAL_AUTHORIZATION_CONSUMED"
  });
  clock.value = time(301);
  await session.close();
  assert.equal((await fs.readdir(path.join(f.profile.storage.journalRoot, "locks"))).length, 2);
});

test("R3 creation rejects mismatched fixed scope before writing OPEN", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const context = r3CreationFixture(f);
  context.scope.creationSpecDigest = D;
  await assert.rejects(r3CreationSession(t, f, context), { code: "MANUAL_SESSION_UNVERIFIED" });
  assert.equal((await f.records("session")).length, 0);
  const unused = await r3CreationSession(t, f);
  await unused.close();
  const legacy = await f.open();
  const legacyRequest = await requestFixture(f, legacy);
  const legacyAuthorization = await legacy.sign(legacyRequest);
  await legacy.consume({ authorization: legacyAuthorization, request: legacyRequest });
  await legacy.close();
});

test("R3 creation UNKNOWN blocks a new operation and slot reacquisition", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const session = await r3CreationSession(t, f);
  const request = await r3CreationRequest(f, session);
  const authorization = await session.sign(request);
  await session.consume({ authorization, request });
  await assert.rejects(
    session.sign(await r3CreationRequest(f, session, { operationId: uuid(702) })),
    { code: "MANUAL_BINDING_MISMATCH" }
  );
  await session.close();
  await assert.rejects(r3CreationSession(t, f), { code: "MANUAL_SESSION_UNVERIFIED" });
});

function r3LockInput() {
  return {
    engineId: "test-r3-engine",
    systemIdentifier: "7340000000000000001",
    targets: [
      {
        databaseName: `s1ci_${"1".repeat(24)}`,
        databaseOid: "2000",
        marker: encodeManualJson({
          markerVersion: "subscription-s1-ephemeral/v1",
          runIdDigest: sha256Canonical(uuid(701)),
          suiteIdDigest: sha256Canonical("test-suite"),
          shard: 0,
          createdAt: NOW
        }).toString()
      }
    ]
  };
}

async function consumedR3Session(t, f) {
  const session = await r3CreationSession(t, f);
  const request = await r3CreationRequest(f, session);
  const authorization = await session.sign(request);
  const consumption = await session.consume({ authorization, request });
  return { session, consumption };
}

test("R3 target locks require consumption, hold physical and reserved identities, and retain UNKNOWN", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const session = await r3CreationSession(t, f);
  assert.equal(typeof session.holdTargets, "function");
  await assert.rejects(session.holdTargets(r3LockInput()), { code: "MANUAL_SESSION_UNVERIFIED" });
  const request = await r3CreationRequest(f, session);
  const authorization = await session.sign(request);
  const consumption = await session.consume({ authorization, request });
  const lease = await session.holdTargets(r3LockInput());
  assert.equal(lease.locks.length, 3);
  await assert.rejects(session.registerLifecycleTarget({ record: {} }), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  assert.deepEqual(
    lease.locks.map((item) => item.lockDigest),
    lease.locks.map((item) => item.lockDigest).sort()
  );
  const lockRoot = path.join(f.profile.storage.journalRoot, "locks");
  for (const lock of lease.locks) {
    const bytes = await fs.readFile(path.join(lockRoot, `${lock.lockDigest.slice(7)}.json`));
    const value = JSON.parse(bytes);
    assert.equal(value.sessionId, session.sessionId);
    assert.equal(value.executionRecordDigest, consumption.executionRecordDigest);
    assert.deepEqual(value.target, lock.identity);
  }
  await lease.recheck();
  await assert.rejects(session.holdTargets(r3LockInput()), { code: "MANUAL_SESSION_UNVERIFIED" });
  await session.close();
  await assert.rejects(lease.recheck(), { code: "MANUAL_SESSION_UNVERIFIED" });
  assert.equal((await fs.readdir(lockRoot)).length, 5);
  assert.equal((await f.records("execution"))[0].status, "INTERRUPTED_UNKNOWN");
});

test("R3 target lock collision retains acquired prefix and never replaces another lock", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const { session } = await consumedR3Session(t, f);
  const input = r3LockInput();
  const { planManualR3TargetLocks } = await import("../src/manual-r3-target-locks.mjs");
  const { entries } = planManualR3TargetLocks({ operationRef: uuid(701), ...input });
  const root = path.join(f.profile.storage.journalRoot, "locks");
  const collision = path.join(root, `${entries[1].lockDigest.slice(7)}.json`);
  const other = encodeManualJson({ owner: "other-operation" });
  await fs.writeFile(collision, other, { flag: "wx", mode: 0o600 });
  await assert.rejects(session.holdTargets(input), { code: "MANUAL_SESSION_UNVERIFIED" });
  assert.deepEqual(await fs.readFile(collision), other);
  await assert.rejects(session.holdTargets(input), { code: "MANUAL_SESSION_UNVERIFIED" });
  await session.close();
  assert.equal(
    (await fs.readdir(root)).length,
    4,
    "two forward slots, acquired prefix and foreign collision remain"
  );
});

test("R3 target lock replacement rejects recheck and leaves uncertainty", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const { session } = await consumedR3Session(t, f);
  const lease = await session.holdTargets(r3LockInput());
  const root = path.join(f.profile.storage.journalRoot, "locks");
  const file = path.join(root, `${lease.locks[0].lockDigest.slice(7)}.json`);
  const bytes = await fs.readFile(file);
  await fs.rename(file, `${file}.original`);
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  await assert.rejects(lease.recheck(), { code: "MANUAL_SESSION_UNVERIFIED" });
  await assert.rejects(session.close(), { code: "MANUAL_SESSION_UNVERIFIED" });
  assert.equal((await fs.readdir(root)).length, 6);
  assert.equal((await f.records("execution"))[0].status, "INTERRUPTED_UNKNOWN");
});

test("R3 creation does not skip unresolved legacy consumption history", async (t) => {
  const f = await fixture(t, { profileVersion: "v2" });
  const old = await f.open();
  const request = await requestFixture(f, old);
  const authorization = await old.sign(request);
  await old.consume({ authorization, request });
  await old.close();
  const session = await r3CreationSession(t, f);
  await assert.rejects(session.sign(await r3CreationRequest(f, session)), {
    code: "MANUAL_SESSION_UNVERIFIED"
  });
  await session.close();

  const completed = await liveRoot(t, { profileVersion: "v2" });
  const dry = await liveRunner(completed);
  await sealExecution(completed, dry);
  const interrupted = await liveRunner(completed, "apply", dry, { beforeCredential: true });
  await completed.session.record("execution", interrupted.execution);
  await completed.session.close();
  completed.session = await completed.f.open();
  const reconciled = await liveRunner(completed, "reconcile", interrupted, { emptyRows: true });
  await completed.session.record("execution", reconciled.execution);
  await completed.session.close();
  assert.equal(
    (await completed.f.records("execution")).find(
      (value) => sha256Canonical(value) === sha256Canonical(interrupted.execution)
    ).status,
    "INTERRUPTED_UNKNOWN"
  );
  const creation = await r3CreationSession(t, completed.f);
  const next = await r3CreationRequest(completed.f, creation);
  assert.equal((await creation.sign(next)).payload.schemaVersion, "manual-launch-authorization.v4");
  await creation.close();
});
