import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import childProcess from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  canonicalJson,
  computeManualClusterFingerprint,
  encodeManualJson,
  encodeManualRunnerFrame,
  parseManualRunnerFrames,
  sha256Bytes,
  sha256Canonical,
  signManualAuthorization,
  verifyManualHandoff
} from "@subscription-saas/release-foundation";

const entry = await import("../src/manual-entrypoint.mjs").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.url?.endsWith("/manual-entrypoint.mjs"))
    return null;
  throw error;
});

const profileFile = fileURLToPath(
  new URL("../../../release/contracts/manual-stage1-profile.v2.json", import.meta.url)
);
const syntheticDigest = "sha256:" + "a".repeat(64);
const testUUID = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));
const rawRef = (bytes) => ({ digest: sha256Bytes(bytes), bytes: bytes.length });
const aKeys = [
  "profileDigest",
  "sessionId",
  "sessionNonce",
  "operationId",
  "idempotencyKey",
  "attemptId",
  "runId"
];
function signedAuthorize(challengeBytes, retainedNonce = challenge([challengeBytes])) {
  // These are shape/binding fixtures with a real ephemeral Ed25519 signature.
  // They do not attest parent Docker, H3, private custody, or archival success.
  const key = generateKeyPairSync("ed25519"),
    now = Date.now(),
    stamp = (offset) => new Date(now + offset).toISOString();
  const target = {
    endpointPolicyId: "synthetic-child",
    endpoint: "127.0.0.1:15432",
    databaseName: "synthetic_db",
    purposes: ["synthetic-fresh"],
    roles: { observer: "observer", migrate: "migrator", verify: "verifier" },
    tls: "required"
  };
  const profile = {
    schemaVersion: "manual-stage1-profile.v2",
    profileId: testUUID(1),
    ownerId: "synthetic-owner",
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: sha256Bytes(key.publicKey.export({ type: "spki", format: "der" })),
    validFrom: stamp(-3600000),
    expiresAt: stamp(3600000),
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
    allowedTargets: [target],
    storage: {
      keyRoot: "/keys",
      keyRef: "owner.key",
      journalRoot: "/journal",
      archiveRoot: "/archive",
      backupRoot: "/backup",
      credentialRoot: "/credential",
      retentionDays: 90
    }
  };
  const targetIntent = pick(target, ["endpointPolicyId", "databaseName"]);
  const cluster = {
    systemIdentifier: "123456789012345678",
    databaseContainerId: "b".repeat(64),
    dataVolumeName: "synthetic-volume",
    postgresImageDigest: syntheticDigest,
    marker: "synthetic-marker",
    serverAddress: "172.19.0.2",
    serverPort: 5432
  };
  const physicalIdentity = {
    ...targetIntent,
    databaseOid: "123",
    clusterFingerprint: computeManualClusterFingerprint(cluster)
  };
  const baseline = {
    schemaVersion: "manual-baseline-manifest.v1",
    identity: {
      buildProofDigest: syntheticDigest,
      purpose: "synthetic-fresh",
      targetObservationDigest: syntheticDigest,
      physicalIdentity,
      roleObservation: { role: "observer", tls: true, schemaObservationDigest: syntheticDigest },
      preStateDigest: syntheticDigest,
      authorizationDigest: syntheticDigest
    },
    createdAt: stamp(-1000),
    promotionEligible: false
  };
  const request = {
    schemaVersion: "manual-runner-request.v1",
    profileDigest: sha256Canonical(profile),
    ownerId: profile.ownerId,
    sessionId: testUUID(2),
    sessionNonce: "f".repeat(64),
    operationId: testUUID(3),
    idempotencyKey: "synthetic-command",
    attemptId: testUUID(4),
    runId: testUUID(5),
    attemptAllocationDigest: syntheticDigest,
    purpose: "synthetic-fresh",
    targetIntent,
    stage: "runner-command",
    capability: "migrate",
    commandId: "db.migrate.deploy",
    commandVersion: "1",
    phase: "dry-run",
    buildProofDigest: syntheticDigest,
    baselineManifestDigest: sha256Canonical(baseline),
    targetObservationDigest: syntheticDigest,
    physicalIdentity,
    roleObservation: { role: "migrator", tls: true, schemaObservationDigest: syntheticDigest },
    containerId: "c".repeat(64),
    runnerImageDigest: syntheticDigest,
    childChallenge: retainedNonce,
    domainInput: {
      databaseIdentityFingerprint: sha256Canonical({
        databaseName: target.databaseName,
        databaseOid: "123",
        role: "migrator",
        tls: true
      }),
      baselineManifestIdentityDigest: sha256Canonical(baseline.identity),
      baselineManifestDigest: sha256Canonical(baseline),
      expectedSchemaDigest: syntheticDigest,
      expectedOwner: "migrator",
      allowedExtensions: ["plpgsql"]
    },
    expectedSchemaEvidenceDigest: syntheticDigest
  };
  const artifact = (kind, offset, fields) => ({
    schemaVersion: "manual-runner-evidence.v1",
    kind,
    recordedAt: stamp(offset),
    promotionEligible: false,
    ...pick(request, aKeys),
    ...fields
  });
  const allocation = artifact("attempt-allocation", -800, {
    stage: request.stage,
    phaseKey: request.phase,
    allocatedAt: stamp(-800),
    targetIntent,
    predecessorExecutionRecordDigest: null
  });
  request.attemptAllocationDigest = sha256Canonical(allocation);
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
    "childChallenge"
  ];
  const binding = pick(request, bindingKeys);
  const authorization = signManualAuthorization({
    payload: {
      schemaVersion: "manual-launch-authorization.v1",
      authorizationId: testUUID(6),
      issuedAt: stamp(-500),
      expiresAt: stamp(299500),
      requestDigest: sha256Canonical(request),
      ...binding
    },
    privateKey: key.privateKey
  });
  const receiptBody = {
    schemaVersion: "manual-operation-record.v2",
    kind: "consumption-handoff",
    profileDigest: request.profileDigest,
    recordedAt: stamp(-100),
    promotionEligible: false,
    ...pick(request, [
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "containerId",
      "runnerImageDigest",
      "childChallenge"
    ]),
    authorizationDigest: sha256Canonical(authorization),
    requestDigest: sha256Canonical(request),
    consumptionRecordDigest: syntheticDigest,
    consumptionReadbackDigest: syntheticDigest,
    revocationSequence: 0,
    issuedAt: stamp(-100),
    expiresAt: stamp(29900)
  };
  const receipt = {
    ...receiptBody,
    signature: sign(
      null,
      Buffer.from(`subscription-saas/manual-consumption/v1\n${canonicalJson(receiptBody)}`),
      key.privateKey
    ).toString("base64")
  };
  const event = (sequence, status, offset) => ({
    sequence,
    processSequence: 0,
    source: "parent",
    tool: "runner",
    event: status,
    at: stamp(offset),
    containerId: status === "PREPARED" ? null : request.containerId,
    pid: status === "PREPARED" ? null : process.pid,
    argvDigest: syntheticDigest,
    exitCode: null,
    signal: null,
    reasonCode: null,
    stdout: null,
    stderr: null
  });
  const processEvidence = artifact("process", -400, {
    attemptAllocationDigest: request.attemptAllocationDigest,
    requestDigest: sha256Canonical(request),
    previousProcessEvidenceDigest: syntheticDigest,
    events: [event(0, "PREPARED", -700), event(1, "SPAWNED", -600)],
    closedAt: null,
    protocol: { stdoutPrefix: rawRef(challengeBytes), parentFrames: [] }
  });
  const processReadback = {
    schemaVersion: "manual-operation-record.v2",
    kind: "custody",
    profileDigest: request.profileDigest,
    ownerId: request.ownerId,
    recordedAt: stamp(-300),
    promotionEligible: false,
    subjectDigest: sha256Canonical(processEvidence),
    subjectType: "r2-artifact",
    purpose: "archive-readback",
    outcome: "MATCH",
    observedDigest: sha256Canonical(processEvidence),
    observedAt: stamp(-350),
    storageRole: "archive",
    retentionDays: 90,
    reasonCode: null
  };
  const targetContext = {
    contextVersion: "manual-h3-target-context.v1",
    operationRef: testUUID(7),
    indexDigest: syntheticDigest,
    runId: request.runId,
    profileDigest: request.profileDigest,
    targetIntent,
    databaseOid: "123",
    h3Approval: { digest: syntheticDigest, bytes: 10 },
    h3Readback: { digest: syntheticDigest, bytes: 10 },
    cluster
  };
  verifyManualHandoff({
    authorization,
    receipt,
    profile,
    request: { binding, canonicalBytes: encodeManualJson(request) },
    childObservation: pick(request, ["containerId", "runnerImageDigest", "childChallenge"]),
    now: stamp(0)
  });
  return {
    profile,
    payload: {
      launchContext: pick(request, ["containerId", "runnerImageDigest"]),
      allocation,
      request,
      authorization,
      receipt,
      baseline,
      process: processEvidence,
      processReadback,
      targetContext
    }
  };
}

async function authorizeOnly(t, mutate = () => {}, coalescedCredential = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "r22-child-profile-")),
    publicFile = path.join(root, "profile.json");
  const native = Object.fromEntries(
    ["open", "lstat", "realpath"].map((name) => [name, fs[name].bind(fs)])
  );
  const effects = { externalProcesses: 0, secretReads: 0, databaseConnections: 0 };
  for (const name of ["spawn", "exec", "execFile", "fork"])
    t.mock.method(childProcess, name, () => {
      effects.externalProcesses++;
      throw new Error("Forbidden external process");
    });
  t.mock.method(net.Socket.prototype, "connect", () => {
    effects.databaseConnections++;
    throw new Error("Forbidden socket");
  });
  t.mock.method(tls, "connect", () => {
    effects.databaseConnections++;
    throw new Error("Forbidden TLS");
  });
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("r22-child-profile-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const incoming = new PassThrough(),
    captured = [];
  let authorizedBytes, fixture, credentialBytes;
  let announceChallenge;
  const announced = new Promise((resolve) => {
    announceChallenge = resolve;
  });
  const output = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(Buffer.from(chunk));
      callback();
      if (captured.length === 1) announceChallenge();
      if (captured.length === 2 && typeof coalescedCredential === "object")
        queueMicrotask(() => incoming.end(credentialBytes));
    }
  });
  const execution = entry.runManualEntrypoint({
    input: incoming,
    output,
    environment: { RUNNER_EXECUTION_MODE: "manual-stage1" }
  });
  execution.catch(() => {});
  await announced;
  fixture = signedAuthorize(Buffer.concat(captured));
  await mutate(fixture);
  await fs.writeFile(publicFile, encodeManualJson(fixture.profile), { flag: "wx" });
  const request = fixture.payload.request;
  const binding = {
    ...pick(request, [
      ...aKeys,
      "attemptAllocationDigest",
      "containerId",
      "runnerImageDigest",
      "childChallenge"
    ]),
    requestDigest: sha256Canonical(request),
    authorizationDigest: sha256Canonical(fixture.payload.authorization)
  };
  if (typeof coalescedCredential === "object") coalescedCredential.changeBinding?.(binding);
  credentialBytes = encodeManualRunnerFrame({
    protocol: "MS2",
    type: "CREDENTIAL",
    sequence: 1,
    payload: {
      binding,
      credential:
        typeof coalescedCredential === "object"
          ? coalescedCredential.credential
          : '{"password":"synthetic-never-real","username":"migrator"}'
    }
  });
  let prematureSent = false;
  for (const name of ["open", "lstat"])
    t.mock.method(fs, name, (file, ...args) => {
      if (
        name === "open" &&
        file === profileFile &&
        coalescedCredential === "during-profile" &&
        !prematureSent
      ) {
        prematureSent = true;
        incoming.end(credentialBytes);
      }
      if (
        name === "open" &&
        /(?:^|[\\/])(?:key|keys|credential|credentials)(?:[\\/]|$)/u.test(String(file))
      ) {
        effects.secretReads++;
        throw new Error("Forbidden secret input");
      }
      return native[name](file === profileFile ? publicFile : file, ...args);
    });
  t.mock.method(fs, "realpath", async (file, ...args) =>
    file === profileFile
      ? (await native.realpath(publicFile, ...args), profileFile)
      : native.realpath(file, ...args)
  );
  syncBuiltinESMExports();
  authorizedBytes = encodeManualRunnerFrame({
    protocol: "MS2",
    type: "AUTHORIZE",
    sequence: 0,
    payload: fixture.payload
  });
  if (coalescedCredential === true) incoming.end(Buffer.concat([authorizedBytes, credentialBytes]));
  else if (coalescedCredential === "during-profile" || typeof coalescedCredential === "object")
    incoming.write(authorizedBytes);
  else incoming.end(authorizedBytes);
  return {
    captured,
    execution,
    effects,
    get authorizedBytes() {
      return authorizedBytes;
    },
    get fixture() {
      return fixture;
    }
  };
}

test("child authenticates signed AUTHORIZE against its fixed profile and self nonce before READY", async (t) => {
  const actual = await authorizeOnly(t);
  await assert.rejects(actual.execution, { code: "MANUAL_FRAME_INCOMPLETE" });
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: Buffer.concat(actual.captured),
    ended: true
  });
  assert.deepEqual(
    parsed.frames.map(({ type }) => type),
    ["CHALLENGE", "READY"]
  );
  assert.deepEqual(parsed.frames[1].payload.authorizeFrame, rawRef(actual.authorizedBytes));
  assert.equal(
    parsed.frames[1].payload.binding.requestDigest,
    sha256Canonical(actual.fixture.payload.request)
  );
  assert.deepEqual(actual.effects, {
    externalProcesses: 0,
    secretReads: 0,
    databaseConnections: 0
  });
});

test("child rejects a credential coalesced with AUTHORIZE before its actual READY", async (t) => {
  const actual = await authorizeOnly(t, () => {}, true);
  await assert.rejects(actual.execution, { code: "MANUAL_FRAME_ORDER_INVALID" });
  assert.equal(
    parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: Buffer.concat(actual.captured),
      ended: true
    }).frames.length,
    1
  );
  assert.deepEqual(actual.effects, {
    externalProcesses: 0,
    secretReads: 0,
    databaseConnections: 0
  });
  assert.equal(Buffer.concat(actual.captured).includes(Buffer.from("synthetic-never-real")), false);
});

test("child rejects credential bytes arriving during fixed-profile IO before READY", async (t) => {
  const actual = await authorizeOnly(t, () => {}, "during-profile");
  await assert.rejects(actual.execution, { code: "MANUAL_FRAME_ORDER_INVALID" });
  assert.equal(
    parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: Buffer.concat(actual.captured),
      ended: true
    }).frames.length,
    1
  );
  assert.deepEqual(actual.effects, {
    externalProcesses: 0,
    secretReads: 0,
    databaseConnections: 0
  });
});

for (const [name, credential] of [
  ["wrong username", '{"password":"synthetic-never-real","username":"verifier"}'],
  ["provision username", '{"password":"synthetic-never-real","username":"provision"}'],
  [
    "extra capability",
    '{"capabilityProfile":"migrate","password":"synthetic-never-real","username":"migrator"}'
  ],
  [
    "extra URL",
    '{"password":"synthetic-never-real","url":"postgresql://invalid","username":"migrator"}'
  ],
  ["credential URL", "postgresql://migrator:synthetic-never-real@invalid/db"],
  ["credential array", '[{"password":"synthetic-never-real","username":"migrator"}]'],
  ["empty password", '{"password":"","username":"migrator"}'],
  ["NUL password", '{"password":"\\u0000","username":"migrator"}'],
  ["duplicate JSON key", '{"password":"x","password":"y","username":"migrator"}'],
  ["inner LF", '{"password":"synthetic-never-real","username":"migrator"}\n'],
  ["inner BOM", '\uFEFF{"password":"synthetic-never-real","username":"migrator"}']
])
  test(`child rejects authorized credential ${name} before connector or runtime`, async (t) => {
    const actual = await authorizeOnly(t, () => {}, { credential });
    await assert.rejects(actual.execution, { code: "MANUAL_CREDENTIAL_INVALID" });
    const parsed = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: Buffer.concat(actual.captured),
      ended: true
    });
    assert.deepEqual(
      parsed.frames.map(({ type }) => type),
      ["CHALLENGE", "READY"]
    );
    assert.deepEqual(actual.effects, {
      externalProcesses: 0,
      secretReads: 0,
      databaseConnections: 0
    });
    assert.equal(
      Buffer.concat(actual.captured).includes(Buffer.from("synthetic-never-real")),
      false
    );
  });

for (const field of [
  ...aKeys,
  "attemptAllocationDigest",
  "requestDigest",
  "authorizationDigest",
  "containerId",
  "runnerImageDigest",
  "childChallenge"
])
  test(`child rejects authorized credential wire drift ${field} before receipt or connector`, async (t) => {
    const actual = await authorizeOnly(t, () => {}, {
      credential: '{"password":"synthetic-never-real","username":"migrator"}',
      changeBinding: (binding) => {
        binding[field] = ["sessionId", "operationId", "attemptId", "runId"].includes(field)
          ? testUUID(99)
          : field === "idempotencyKey"
            ? "different-operation"
            : field.endsWith("Digest")
              ? "sha256:" + "e".repeat(64)
              : "e".repeat(64);
      }
    });
    await assert.rejects(actual.execution, { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" });
    assert.deepEqual(
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: Buffer.concat(actual.captured),
        ended: true
      }).frames.map(({ type }) => type),
      ["CHALLENGE", "READY"]
    );
    assert.deepEqual(actual.effects, {
      externalProcesses: 0,
      secretReads: 0,
      databaseConnections: 0
    });
  });

test("child acknowledges an exact credential after handoff but a closed parent pipe cannot connect", async (t) => {
  const actual = await authorizeOnly(t, () => {}, {
    credential: '{"password":"  synthetic密码  ","username":"migrator"}'
  });
  await assert.rejects(actual.execution, { code: "MANUAL_FRAME_INCOMPLETE" });
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: Buffer.concat(actual.captured),
    ended: true
  });
  assert.deepEqual(
    parsed.frames.map(({ type }) => type),
    ["CHALLENGE", "READY", "CREDENTIAL_RECEIVED"]
  );
  assert.deepEqual(parsed.frames[2].payload.authorizeFrame, rawRef(actual.authorizedBytes));
  assert.deepEqual(actual.effects, {
    externalProcesses: 0,
    secretReads: 0,
    databaseConnections: 0
  });
  assert.equal(Buffer.concat(actual.captured).includes(Buffer.from("synthetic密码")), false);
});

const authorizeDrift = [
  ...aKeys.flatMap((field) =>
    ["allocation", "process"].map((subject) => [
      `${subject}.${field}`,
      (f) => {
        f.payload[subject][field] = field.endsWith("Id")
          ? testUUID(99)
          : field === "idempotencyKey"
            ? "different-operation"
            : field === "profileDigest"
              ? "sha256:" + "e".repeat(64)
              : "e".repeat(64);
      }
    ])
  ),
  [
    "allocation full digest",
    (f) => {
      f.payload.allocation.allocatedAt = f.payload.process.recordedAt;
    }
  ],
  [
    "process request digest",
    (f) => {
      f.payload.process.requestDigest = syntheticDigest;
    }
  ],
  [
    "process allocation digest",
    (f) => {
      f.payload.process.attemptAllocationDigest = syntheticDigest;
    }
  ],
  [
    "closed process",
    (f) => {
      f.payload.process.closedAt = f.payload.process.recordedAt;
    }
  ],
  [
    "future parent frame",
    (f) => {
      f.payload.process.protocol.parentFrames = [{ digest: syntheticDigest, bytes: 5 }];
    }
  ],
  [
    "duplicate runner SPAWNED",
    (f) => {
      f.payload.process.events.push({ ...f.payload.process.events[1], sequence: 2 });
    }
  ],
  [
    "runner processSequence",
    (f) => {
      f.payload.process.events[1].processSequence = 1;
    }
  ],
  [
    "runner container",
    (f) => {
      f.payload.process.events[1].containerId = "e".repeat(64);
    }
  ],
  [
    "actual CHALLENGE digest",
    (f) => {
      f.payload.process.protocol.stdoutPrefix.digest = syntheticDigest;
    }
  ],
  [
    "actual CHALLENGE size",
    (f) => {
      f.payload.process.protocol.stdoutPrefix.bytes++;
    }
  ],
  [
    "baseline digest",
    (f) => {
      f.payload.baseline.identity.authorizationDigest = "sha256:" + "e".repeat(64);
    }
  ],
  [
    "launchContext container",
    (f) => {
      f.payload.launchContext.containerId = "e".repeat(64);
    }
  ],
  [
    "launchContext image",
    (f) => {
      f.payload.launchContext.runnerImageDigest = "sha256:" + "e".repeat(64);
    }
  ],
  [
    "context run",
    (f) => {
      f.payload.targetContext.runId = testUUID(99);
    }
  ],
  [
    "context profile",
    (f) => {
      f.payload.targetContext.profileDigest = syntheticDigest;
    }
  ],
  [
    "context target",
    (f) => {
      f.payload.targetContext.targetIntent = {
        ...f.payload.request.targetIntent,
        databaseName: "different_db"
      };
    }
  ],
  [
    "context OID",
    (f) => {
      f.payload.targetContext.databaseOid = "456";
    }
  ],
  [
    "context cluster",
    (f) => {
      f.payload.targetContext.cluster = {
        ...f.payload.targetContext.cluster,
        marker: "different-marker"
      };
    }
  ],
  [
    "custody subject",
    (f) => {
      f.payload.processReadback.subjectDigest = syntheticDigest;
    }
  ],
  [
    "custody observed digest",
    (f) => {
      f.payload.processReadback.observedDigest = syntheticDigest;
    }
  ],
  [
    "custody profile",
    (f) => {
      f.payload.processReadback.profileDigest = syntheticDigest;
    }
  ],
  [
    "custody owner",
    (f) => {
      f.payload.processReadback.ownerId = "different-owner";
    }
  ],
  [
    "custody type",
    (f) => {
      f.payload.processReadback.subjectType = "record";
    }
  ],
  [
    "custody legacy policy",
    (f) => {
      Object.assign(f.payload.processReadback, {
        schemaVersion: "manual-operation-record.v1",
        retentionDays: 180
      });
    }
  ],
  [
    "custody backup purpose",
    (f) => {
      Object.assign(f.payload.processReadback, {
        purpose: "backup-readback",
        storageRole: "backup"
      });
    }
  ],
  [
    "custody failed outcome",
    (f) => {
      Object.assign(f.payload.processReadback, { outcome: "FAILED", reasonCode: "OTHER" });
    }
  ],
  [
    "fixed profile digest",
    (f) => {
      f.profile.profileId = testUUID(98);
    }
  ]
];
for (const [name, mutate] of authorizeDrift)
  test(`child rejects signed AUTHORIZE drift ${name} before READY`, async (t) => {
    const actual = await authorizeOnly(t, mutate);
    await assert.rejects(actual.execution, { code: "MANUAL_EVIDENCE_BINDING_MISMATCH" });
    assert.deepEqual(actual.effects, {
      externalProcesses: 0,
      secretReads: 0,
      databaseConnections: 0
    });
    assert.equal(
      parseManualRunnerFrames({
        direction: "child-to-parent",
        bytes: Buffer.concat(actual.captured),
        ended: true
      }).frames.length,
      1
    );
  });
function invoke(chunks = [], environment = { RUNNER_EXECUTION_MODE: "manual-stage1" }) {
  assert.equal(
    typeof entry?.runManualEntrypoint,
    "function",
    "fixed manual child entrypoint must exist"
  );
  const captured = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(Buffer.from(chunk));
      callback();
    }
  });
  return {
    captured,
    execution: entry.runManualEntrypoint({ input: Readable.from(chunks), output, environment })
  };
}
function challenge(captured) {
  const parsed = parseManualRunnerFrames({
    direction: "child-to-parent",
    bytes: Buffer.concat(captured),
    ended: false
  });
  assert.equal(parsed.frames.length, 1);
  const frame = parsed.frames[0];
  assert.equal(frame.type, "CHALLENGE");
  assert.equal(frame.sequence, 0);
  assert.equal(frame.frameBytes.subarray(0, 4).toString("ascii"), "MS2 ");
  assert.deepEqual(Object.keys(frame.payload), ["childChallenge"]);
  assert.match(frame.payload.childChallenge, /^[0-9a-f]{64}$/u);
  return frame.payload.childChallenge;
}

test("manual child generates a fresh 32-byte nonce before any AUTHORIZE and rejects EOF", async () => {
  const first = invoke(),
    second = invoke();
  await assert.rejects(first.execution, { code: "MANUAL_FRAME_INCOMPLETE" });
  await assert.rejects(second.execution, { code: "MANUAL_FRAME_INCOMPLETE" });
  assert.notEqual(challenge(first.captured), challenge(second.captured));
});

for (const [name, environment, code] of [
  ["mode missing", {}, "RUNNER_EXECUTION_MODE_REJECTED"],
  ["wrong mode", { RUNNER_EXECUTION_MODE: "legacy" }, "RUNNER_EXECUTION_MODE_REJECTED"],
  [
    "old envelope mixed",
    { RUNNER_EXECUTION_MODE: "manual-stage1", RUNNER_LAUNCH_ENVELOPE_FILE: "/old/envelope.json" },
    "RUNNER_EXECUTION_MODE_REJECTED"
  ]
]) {
  test(`manual child ${name} refuses before challenge or input consumption`, async () => {
    const result = invoke([], environment);
    await assert.rejects(result.execution, { code });
    assert.equal(result.captured.length, 0);
  });
}

for (const [name, chunks, code] of [
  ["bare JSON", [Buffer.from('{"verified":true}\n')], "MANUAL_FRAME_INVALID"],
  ["MS1 parent attempt", [Buffer.from("MS1 AUTHORIZE 0 2\n{}\n")], "MANUAL_FRAME_INVALID"],
  [
    "wrong-direction frame",
    [
      encodeManualRunnerFrame({
        protocol: "MS2",
        type: "CHALLENGE",
        sequence: 0,
        payload: { childChallenge: "a".repeat(64) }
      })
    ],
    "MANUAL_FRAME_INVALID"
  ],
  [
    "split truncated AUTHORIZE",
    [Buffer.from("MS2 AUT"), Buffer.from("HORIZE 0 100\n{")],
    "MANUAL_FRAME_INCOMPLETE"
  ],
  ["raw stream exceeds limit", [Buffer.alloc(1048577, 32)], "MANUAL_OUTPUT_LIMIT"],
  [
    "invalid UTF-8 in complete payload",
    [Buffer.concat([Buffer.from("MS2 AUTHORIZE 0 1\n"), Buffer.from([255])])],
    "MANUAL_FRAME_INVALID"
  ],
  [
    "invalid UTF-8 in partial payload",
    [Buffer.concat([Buffer.from("MS2 AUTHORIZE 0 100\n"), Buffer.from([255])])],
    "MANUAL_FRAME_INVALID"
  ],
  [
    "declared frame exceeds limit",
    [Buffer.from("MS2 AUTHORIZE 0 1048577\n")],
    "MANUAL_OUTPUT_LIMIT"
  ],
  ["wrong first sequence", [Buffer.from("MS2 AUTHORIZE 1 100\n{")], "MANUAL_FRAME_ORDER_INVALID"],
  ["non-Buffer input chunk", [new Uint8Array([77, 83, 50, 32])], "MANUAL_FRAME_INVALID"]
]) {
  test(`manual child rejects ${name} and emits only its own challenge`, async () => {
    const result = invoke(chunks);
    await assert.rejects(result.execution, { code });
    challenge(result.captured);
  });
}

test("manual child does not consume caller adapters or credentials as API authority", async () => {
  assert.equal(typeof entry?.runManualEntrypoint, "function");
  await assert.rejects(
    entry.runManualEntrypoint({
      input: Readable.from([]),
      output: new Writable({
        write(_chunk, _encoding, cb) {
          cb();
        }
      }),
      environment: { RUNNER_EXECUTION_MODE: "manual-stage1" },
      adapter: "caller.mjs"
    }),
    { code: "MANUAL_ENTRYPOINT_INPUT_INVALID" }
  );
});

const syntheticWire = {
  profileDigest: "sha256:" + "a".repeat(64),
  sessionId: "10000000-0000-4000-8000-000000000001",
  sessionNonce: "b".repeat(64),
  operationId: "10000000-0000-4000-8000-000000000002",
  idempotencyKey: "synthetic-only",
  attemptId: "10000000-0000-4000-8000-000000000003",
  runId: "10000000-0000-4000-8000-000000000004",
  attemptAllocationDigest: "sha256:" + "a".repeat(64),
  requestDigest: "sha256:" + "a".repeat(64),
  authorizationDigest: "sha256:" + "a".repeat(64),
  containerId: "c".repeat(64),
  runnerImageDigest: "sha256:" + "a".repeat(64),
  childChallenge: "d".repeat(64)
};
for (const credential of [
  '{"password":"synthetic-never-real","username":"migrate"}',
  '{"password":"synthetic-never-real","username":"provision"}',
  '{"capabilityProfile":"migrate","password":"synthetic-never-real","username":"migrate"}',
  "postgresql://migrate:synthetic-never-real@forbidden.invalid/test"
]) {
  test(`manual child refuses premature credential ${credential.includes("provision") ? "provision" : credential.startsWith("postgresql") ? "URL" : credential.includes("capabilityProfile") ? "capability override" : "two-field JSON"} without emitting its secret`, async () => {
    const frame = encodeManualRunnerFrame({
      protocol: "MS2",
      type: "CREDENTIAL",
      sequence: 1,
      payload: { binding: syntheticWire, credential }
    });
    const result = invoke([frame]);
    await assert.rejects(result.execution, { code: "MANUAL_FRAME_ORDER_INVALID" });
    challenge(result.captured);
    assert.equal(
      Buffer.concat(result.captured).includes(Buffer.from("synthetic-never-real")),
      false
    );
  });
}

test("manual mode reads no ambient database URL or raw-credential environment authority", async () => {
  const environment = { RUNNER_EXECUTION_MODE: "manual-stage1" };
  for (const key of ["DATABASE_URL", "RUNNER_DATABASE_CREDENTIAL_FILE", "RUNNER_PRIVATE_KEY_FILE"])
    Object.defineProperty(environment, key, {
      get() {
        return assert.fail(`must not consume ${key}`);
      }
    });
  const result = invoke([], environment);
  await assert.rejects(result.execution, { code: "MANUAL_FRAME_INCOMPLETE" });
  challenge(result.captured);
});

test("manual child observes a failed challenge pipe without consuming parent input", async () => {
  let consumed = false;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("synthetic closed pipe"), { code: "EPIPE" }));
    }
  });
  const input = {
    async *[Symbol.asyncIterator]() {
      consumed = true;
      yield Buffer.from("MS2 ");
    }
  };
  await assert.rejects(
    entry.runManualEntrypoint({
      input,
      output,
      environment: { RUNNER_EXECUTION_MODE: "manual-stage1" }
    }),
    { code: "EPIPE" }
  );
  assert.equal(consumed, false);
});

test("actual Node child emits its own challenge on a zero-credential pipe before split parent input", async () => {
  const moduleURL = new URL("../src/manual-entrypoint.mjs", import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises'; import cp from 'node:child_process';
    import net from 'node:net'; import tls from 'node:tls';
    import {syncBuiltinESMExports} from 'node:module';
    const effects={externalProcesses:0,secretReads:0,databaseConnections:0};
    for(const name of ['spawn','exec','execFile','fork']) cp[name]=()=>{effects.externalProcesses++;throw new Error('Forbidden external process');};
    net.Socket.prototype.connect=()=>{effects.databaseConnections++;throw new Error('Forbidden socket');};
    tls.connect=()=>{effects.databaseConnections++;throw new Error('Forbidden TLS');};
    for(const name of ['open','readFile']) { const native=fs[name].bind(fs); fs[name]=(...args)=>{
      if(/(?:^|[\\\\/])(?:key|credential)(?:[\\\\/]|$)/u.test(String(args[0]))) {effects.secretReads++;throw new Error('Forbidden secret');}
      return native(...args);
    }; }
    syncBuiltinESMExports();
    const {runManualEntrypoint}=await import(${JSON.stringify(moduleURL)});
    try { await runManualEntrypoint({input:process.stdin,output:process.stdout,environment:process.env}); }
    catch(error) {process.stderr.write(error.code+'\\n');process.exitCode=1;}
    process.stderr.write('EFFECTS:'+JSON.stringify(effects)+'\\n');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    shell: false,
    windowsHide: true,
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      RUNNER_EXECUTION_MODE: "manual-stage1"
    }
  });
  assert.ok(child.pid > 0);
  const stdout = [],
    stderr = [];
  let sent = false;
  child.stdout.on("data", (chunk) => {
    stdout.push(Buffer.from(chunk));
    const parsed = parseManualRunnerFrames({
      direction: "child-to-parent",
      bytes: Buffer.concat(stdout),
      ended: false
    });
    if (!sent && parsed.frames.length === 1) {
      sent = true;
      challenge(stdout);
      child.stdin.write(Buffer.from("MS2 AUT"));
      child.stdin.end(Buffer.from("HORIZE 0 100\n{"));
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const closed = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  assert.deepEqual(closed, { exitCode: 1, signal: null });
  assert.equal(sent, true);
  challenge(stdout);
  const diagnostics = Buffer.concat(stderr).toString("utf8");
  assert.equal(
    diagnostics,
    'MANUAL_FRAME_INCOMPLETE\nEFFECTS:{"externalProcesses":0,"secretReads":0,"databaseConnections":0}\n'
  );
});
