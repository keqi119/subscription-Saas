import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import test from "node:test";
import { encodeManualJson, assertManualDecision } from "../src/manual-stage1-contracts.mjs";
import * as manual from "../src/manual-stage1-contracts.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import { sha256Canonical } from "../src/digest.mjs";
import { validateContract } from "../src/schema-registry.mjs";

const NOW = "2026-09-07T12:00:00.000Z";
const ISSUED = "2026-09-07T11:59:59.000Z";
const OPENED = "2026-09-07T11:59:00.000Z";
const EXPIRES = "2026-09-07T12:04:59.000Z";
const D = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const UUID = "d214c57e-9453-4fc3-b138-d6330844b87a";
const UUID2 = "48b54f2b-f0ab-4cc2-a363-a1aa3851b643";
const keys = generateKeyPairSync("ed25519"); // Private material stays in this process.
const clone = (value) => structuredClone(value);
const rawSign = (payload, privateKey = keys.privateKey, domain = "manual-launch") => ({
  payload,
  signature: sign(
    null,
    Buffer.from(`subscription-saas/${domain}/v1\n${canonicalJson(payload)}`),
    privateKey
  ).toString("base64")
});
function profile() {
  return {
    schemaVersion: "manual-stage1-profile.v1",
    profileId: UUID,
    ownerId: "test-owner",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    keyFingerprint: `sha256:${createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`,
    validFrom: "2026-09-07T00:00:00.000Z",
    expiresAt: "2026-09-08T00:00:00.000Z",
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
        databaseName: "test-only",
        purposes: ["synthetic-fresh", "staging-mainline"],
        roles: { observer: "observer", migrate: "migrator", verify: "verifier" },
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
      retentionDays: 180
    }
  };
}
function profile90() {
  const value = profile();
  value.schemaVersion = "manual-stage1-profile.v2";
  value.storage.retentionDays = 90;
  return value;
}
function fixture(phase = "observe") {
  const p = profile();
  const binding = {
    profileDigest: sha256Canonical(p),
    ownerId: p.ownerId,
    sessionId: UUID,
    sessionNonce: randomBytes(32).toString("hex"),
    operationId: UUID2,
    idempotencyKey: "test-operation",
    purpose: "synthetic-fresh",
    targetIntent: { endpointPolicyId: "test-endpoint", databaseName: "test-only" },
    stage: "target-observe",
    capability: "verify"
  };
  if (phase !== "observe")
    Object.assign(binding, {
      stage: "runner-command",
      commandId: phase === "verify" ? "db.schema.verify" : "db.migrate.deploy",
      commandVersion: "1",
      capability: phase === "verify" ? "verify" : "migrate",
      phase,
      buildProofDigest: D,
      baselineManifestDigest: D,
      targetObservationDigest: D,
      physicalIdentity: { ...binding.targetIntent, databaseOid: "123", clusterFingerprint: D },
      roleObservation: {
        role: phase === "verify" ? "verifier" : "migrator",
        tls: true,
        schemaObservationDigest: D
      },
      containerId: "c".repeat(64),
      runnerImageDigest: D,
      childChallenge: randomBytes(32).toString("hex")
    });
  const sessionRecord = record("session", binding);
  const genesis = record("revocation", binding);
  const f = {
    profile: p,
    request: { binding, canonicalBytes: null },
    session: {
      record: sessionRecord,
      recordDigest: sha256Canonical(sessionRecord),
      readAt: NOW,
      predecessor: null
    },
    revocation: {
      records: [genesis],
      headDigest: sha256Canonical(genesis),
      checkpoint: { sequence: 0, digest: sha256Canonical(genesis) },
      readAt: NOW
    },
    now: NOW
  };
  if (["apply", "replay", "reconcile"].includes(phase)) {
    f.session.predecessor = record("execution", binding);
    if (phase === "reconcile")
      Object.assign(f.session.predecessor, {
        status: "INTERRUPTED_UNKNOWN",
        reasonCode: "PROCESS_LOST",
        finishedAt: null
      });
    const predecessorDigest = sha256Canonical(f.session.predecessor);
    if (phase === "apply")
      Object.assign(binding, { dryRunRecordDigest: predecessorDigest, approvedPlanDigest: D });
    else
      Object.assign(binding, {
        predecessorExecutionRecordDigest: predecessorDigest,
        originalIdempotencyKey: binding.idempotencyKey
      });
  }
  rebind(f);
  return f;
}
function fixture90(phase = "observe") {
  const f = fixture(phase);
  f.profile = profile90();
  f.request.binding.profileDigest = sha256Canonical(f.profile);
  for (const value of [f.session.record, f.session.predecessor, ...f.revocation.records].filter(
    Boolean
  )) {
    value.schemaVersion = "manual-operation-record.v2";
    value.profileDigest = f.request.binding.profileDigest;
  }
  if (f.session.predecessor) {
    const key = phase === "apply" ? "dryRunRecordDigest" : "predecessorExecutionRecordDigest";
    f.request.binding[key] = sha256Canonical(f.session.predecessor);
  }
  f.session.recordDigest = sha256Canonical(f.session.record);
  f.revocation.headDigest = sha256Canonical(f.revocation.records.at(-1));
  f.revocation.checkpoint.digest = sha256Canonical(
    f.revocation.records[f.revocation.checkpoint.sequence]
  );
  rebind(f);
  return f;
}
function rebind(f, extra = { attemptId: UUID, input: { testOnly: "no executable R2 schema" } }) {
  f.request.canonicalBytes = Buffer.from(canonicalJson({ ...f.request.binding, ...extra }));
  f.authorization = rawSign({
    schemaVersion: "manual-launch-authorization.v1",
    authorizationId: UUID2,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    requestDigest: sha256Canonical(JSON.parse(f.request.canonicalBytes)),
    ...f.request.binding
  });
}
function record(kind, b = fixtureBinding()) {
  const common = {
    schemaVersion: "manual-operation-record.v1",
    kind,
    profileDigest: b.profileDigest,
    recordedAt: OPENED,
    promotionEligible: false
  };
  const session = { sessionId: b.sessionId, sessionNonce: b.sessionNonce };
  const operation = { ...session, operationId: b.operationId, idempotencyKey: b.idempotencyKey };
  const variants = {
    session: {
      ...session,
      ownerId: b.ownerId,
      targetIntent: b.targetIntent,
      status: "OPEN",
      openedAt: OPENED,
      previousSessionRecordDigest: null,
      reasonCode: null
    },
    revocation: {
      ownerId: b.ownerId,
      sequence: 0,
      previousRevocationDigest: null,
      action: "GENESIS",
      authorizationId: null,
      reasonCode: null
    },
    consumption: {
      ...operation,
      ownerId: b.ownerId,
      authorizationDigest: D,
      requestDigest: D,
      stage: "runner-command",
      sessionRecordDigest: D,
      revocationRecordDigest: D,
      revocationSequence: 0,
      status: "CONSUMED"
    },
    "consumption-handoff": {
      ...operation,
      authorizationDigest: D,
      requestDigest: D,
      containerId: "c".repeat(64),
      runnerImageDigest: D,
      childChallenge: "d".repeat(64),
      consumptionRecordDigest: D,
      consumptionReadbackDigest: D,
      revocationSequence: 0,
      issuedAt: OPENED,
      expiresAt: "2026-09-07T11:59:30.000Z",
      signature: sign(null, Buffer.from("test fixture"), keys.privateKey).toString("base64")
    },
    "post-state": {
      ...operation,
      requestDigest: D,
      consumptionRecordDigest: D,
      outcome: "OBSERVED",
      observationDigest: D,
      observedAt: OPENED,
      reasonCode: null
    },
    execution: {
      ...operation,
      attemptId: UUID,
      requestDigest: D,
      authorizationDigest: D,
      consumptionRecordDigest: D,
      handoffRecordDigest: D,
      handoffReadbackDigest: D,
      postStateRecordDigest: D,
      predecessorExecutionRecordDigest: null,
      startedAt: OPENED,
      finishedAt: OPENED,
      status: "SUCCEEDED",
      reasonCode: null,
      resultDigest: D,
      processEvidenceDigest: D
    },
    custody: {
      ownerId: b.ownerId,
      subjectDigest: D,
      subjectType: "record",
      purpose: "archive-readback",
      outcome: "MATCH",
      observedDigest: D,
      observedAt: OPENED,
      storageRole: "archive",
      retentionDays: 180,
      reasonCode: null
    },
    signoff: {
      ...operation,
      ownerId: b.ownerId,
      executionRecordDigest: D,
      executionReadbackDigest: D,
      backupReadbackDigest: D,
      decision: "ACCEPTED",
      reasonCode: null
    }
  };
  return { ...common, ...variants[kind] };
}
function fixtureBinding() {
  return {
    profileDigest: D,
    ownerId: "test-owner",
    sessionId: UUID,
    sessionNonce: "d".repeat(64),
    operationId: UUID2,
    idempotencyKey: "test-operation",
    targetIntent: { endpointPolicyId: "test-endpoint", databaseName: "test-only" }
  };
}
function handoff(f) {
  const receipt = {
    ...record("consumption-handoff", f.request.binding),
    authorizationDigest: sha256Canonical(f.authorization),
    requestDigest: f.authorization.payload.requestDigest,
    containerId: f.request.binding.containerId,
    runnerImageDigest: f.request.binding.runnerImageDigest,
    childChallenge: f.request.binding.childChallenge,
    recordedAt: NOW,
    issuedAt: NOW,
    expiresAt: "2026-09-07T12:00:30.000Z"
  };
  receipt.schemaVersion =
    f.profile.schemaVersion === "manual-stage1-profile.v2"
      ? "manual-operation-record.v2"
      : "manual-operation-record.v1";
  resignReceipt(receipt);
  return {
    authorization: f.authorization,
    profile: f.profile,
    request: f.request,
    receipt,
    childObservation: {
      containerId: receipt.containerId,
      runnerImageDigest: receipt.runnerImageDigest,
      childChallenge: receipt.childChallenge
    },
    now: NOW
  };
}
function resignReceipt(receipt, domain = "manual-consumption") {
  const { signature, ...body } = receipt;
  receipt.signature = sign(
    null,
    Buffer.from(`subscription-saas/${domain}/v1\n${canonicalJson(body)}`),
    keys.privateKey
  ).toString("base64");
}
const rejects = (run, code) => assert.throws(run, { code });
const invalid = (schema, value, keyword) =>
  assert.throws(
    () => validateContract(schema, value),
    (error) =>
      error.code === "CONTRACT_SCHEMA_INVALID" &&
      (!keyword || error.details.errors.some((e) => e.keyword === keyword))
  );

test("rejects caller-made verification and counts UTF-8 bytes", () => {
  assert.throws(() => assertManualDecision({ verified: true }), {
    code: "MANUAL_DECISION_UNTRUSTED"
  });
  assert.throws(() => encodeManualJson({ value: "汉".repeat(400000) }), {
    code: "MANUAL_JSON_LIMIT"
  });
  const keys = generateKeyPairSync("ed25519");
  assert.equal(keys.privateKey.asymmetricKeyType, "ed25519");
});

test("canonical encoding rejects lossy or executable input and enforces both byte sizes", () => {
  assert.equal(encodeManualJson({ z: "汉", a: 1 }).toString(), '{"a":1,"z":"汉"}');
  for (const value of [
    undefined,
    NaN,
    Infinity,
    { a: undefined },
    { a: "\ud800" },
    new Date(),
    {
      get a() {
        throw new Error("accessor executed");
      }
    }
  ])
    rejects(() => encodeManualJson(value), "CANONICAL_JSON_REFUSED");
  const hidden = {};
  Object.defineProperty(hidden, "secret", { value: 1 });
  rejects(() => encodeManualJson(hidden), "CANONICAL_JSON_REFUSED");
  rejects(() => encodeManualJson(new Array(2)), "CANONICAL_JSON_REFUSED");
  const exact = { x: "x".repeat(1048568) };
  assert.equal(encodeManualJson(exact).length, 1048576);
  rejects(() => encodeManualJson({ x: exact.x + "x" }), "MANUAL_JSON_LIMIT");
});

test("real Ed25519 signer covers exactly the canonical launch domain", () => {
  const f = fixture();
  const authorization = manual.signManualAuthorization({
    payload: f.authorization.payload,
    privateKey: keys.privateKey
  });
  assert.deepEqual(authorization, f.authorization);
  assert.equal(
    verify(
      null,
      Buffer.from(`subscription-saas/manual-launch/v1\n${canonicalJson(authorization.payload)}`),
      keys.publicKey,
      Buffer.from(authorization.signature, "base64")
    ),
    true
  );
  rejects(
    () =>
      manual.signManualAuthorization({
        payload: f.authorization.payload,
        privateKey: keys.publicKey
      }),
    "MANUAL_SIGNATURE_INVALID"
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  rejects(
    () =>
      manual.signManualAuthorization({
        payload: f.authorization.payload,
        privateKey: rsa.privateKey
      }),
    "MANUAL_SIGNATURE_INVALID"
  );
});

for (const phase of ["observe", "dry-run", "apply", "replay", "reconcile", "verify"])
  test(`parent verifies ${phase} without claiming consumption`, () => {
    const f = fixture(phase);
    const decision = manual.verifyManualAuthorization(f);
    assert.deepEqual(decision, {
      kind: "manual-parent-decision",
      authorizationDigest: sha256Canonical(f.authorization),
      requestDigest: f.authorization.payload.requestDigest,
      profileDigest: sha256Canonical(f.profile),
      stage: f.request.binding.stage,
      sessionId: f.request.binding.sessionId,
      sessionNonce: f.request.binding.sessionNonce,
      operationId: f.request.binding.operationId,
      idempotencyKey: f.request.binding.idempotencyKey,
      promotionEligible: false
    });
    assert.ok(Object.isFrozen(decision));
    assert.equal(manual.assertManualDecision(decision), undefined);
    rejects(() => manual.assertManualDecision({ ...decision }), "MANUAL_DECISION_UNTRUSTED");
    rejects(
      () => manual.assertManualDecision(JSON.parse(JSON.stringify(decision))),
      "MANUAL_DECISION_UNTRUSTED"
    );
    manual.assertManualDecision(manual.verifyManualAuthorization(f));
  });

for (const [label, change, code] of [
  [
    "signature bytes",
    (f) => {
      const s = Buffer.from(f.authorization.signature, "base64");
      s[0] ^= 1;
      f.authorization.signature = s.toString("base64");
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "base64url",
    (f) => {
      f.authorization.signature = f.authorization.signature.replace(/==$/, "=");
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "different profile public key",
    (f) => {
      f.profile.publicKeyPem = generateKeyPairSync("ed25519").publicKey.export({
        type: "spki",
        format: "pem"
      });
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "SPKI fingerprint",
    (f) => {
      f.profile.keyFingerprint = OTHER;
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "launch domain",
    (f) => {
      f.authorization = rawSign(f.authorization.payload, keys.privateKey, "manual-consumption");
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "request digest",
    (f) => {
      f.authorization.payload.requestDigest = OTHER;
      f.authorization = rawSign(f.authorization.payload);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "purpose",
    (f) => {
      f.authorization.payload.purpose = "staging-mainline";
      f.authorization = rawSign(f.authorization.payload);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "owner",
    (f) => {
      f.request.binding.ownerId = "different-owner";
      rebind(f);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "target",
    (f) => {
      f.request.binding.targetIntent.databaseName = "different-db";
      rebind(f);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "nonce",
    (f) => {
      f.session.record.sessionNonce = "e".repeat(64);
      f.session.recordDigest = sha256Canonical(f.session.record);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "closed session",
    (f) => {
      Object.assign(f.session.record, { status: "CLOSED", previousSessionRecordDigest: D });
      f.session.recordDigest = sha256Canonical(f.session.record);
    },
    "MANUAL_SESSION_UNVERIFIED"
  ],
  [
    "session digest",
    (f) => {
      f.session.recordDigest = OTHER;
    },
    "MANUAL_SESSION_UNVERIFIED"
  ],
  [
    "future read",
    (f) => {
      f.session.readAt = "2026-09-07T12:00:00.001Z";
    },
    "MANUAL_SESSION_UNVERIFIED"
  ],
  [
    "revocation head",
    (f) => {
      f.revocation.headDigest = OTHER;
    },
    "MANUAL_REVOCATION_UNVERIFIED"
  ],
  [
    "checkpoint rollback",
    (f) => {
      f.revocation.checkpoint.sequence = 1;
    },
    "MANUAL_REVOCATION_UNVERIFIED"
  ],
  [
    "expired",
    (f) => {
      f.now = EXPIRES;
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "future issuance",
    (f) => {
      f.authorization.payload.issuedAt = "2026-09-07T12:00:00.001Z";
      f.authorization = rawSign(f.authorization.payload);
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "five minutes plus 1ms",
    (f) => {
      f.authorization.payload.expiresAt = "2026-09-07T12:04:59.001Z";
      f.authorization = rawSign(f.authorization.payload);
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "impossible date",
    (f) => {
      f.now = "2026-02-30T12:00:00.000Z";
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "non-roundtrip now",
    (f) => {
      f.now = "2026-09-07T12:00:00Z";
    },
    "MANUAL_TIME_INVALID"
  ]
])
  test(`rejects ${label} at its defined layer`, () => {
    const f = fixture();
    change(f);
    rejects(() => manual.verifyManualAuthorization(f), code);
  });

test("full request canonical bytes and non-projection command input are binding", () => {
  for (const transform of [
    (b) => Buffer.concat([b, Buffer.from(" ")]),
    (b) =>
      Buffer.from(
        b
          .toString()
          .replace('"testOnly":"no executable R2 schema"', '"testOnly":"No executable R2 schema"')
      ),
    (b) => Buffer.from(b.toString().replace('"attemptId":', '"attemptId":"duplicate","attemptId":'))
  ]) {
    const f = fixture();
    f.request.canonicalBytes = transform(f.request.canonicalBytes);
    rejects(() => manual.verifyManualAuthorization(f), "MANUAL_BINDING_MISMATCH");
  }
  const f = fixture();
  f.request.canonicalBytes = Buffer.alloc(1048577, 32);
  rejects(() => manual.verifyManualAuthorization(f), "MANUAL_JSON_LIMIT");
  const g = fixture();
  g.request.canonicalBytes = Buffer.from(
    canonicalJson({ ...g.request.binding, commandId: "db.schema.verify" })
  );
  g.authorization.payload.requestDigest = sha256Canonical(JSON.parse(g.request.canonicalBytes));
  g.authorization = rawSign(g.authorization.payload);
  rejects(() => manual.verifyManualAuthorization(g), "MANUAL_BINDING_MISMATCH");
});

test("closed authorization stages prohibit future fields, missing plans and write verify", () => {
  for (const [phase, change] of [
    [
      "observe",
      (p) => {
        p.buildProofDigest = D;
      }
    ],
    [
      "apply",
      (p) => {
        delete p.approvedPlanDigest;
      }
    ],
    [
      "verify",
      (p) => {
        p.capability = "migrate";
      }
    ],
    [
      "dry-run",
      (p) => {
        p.approvedPlanDigest = D;
      }
    ],
    [
      "observe",
      (p) => {
        p.purpose = "qualification";
      }
    ]
  ]) {
    const f = fixture(phase);
    change(f.authorization.payload);
    f.authorization = rawSign(f.authorization.payload);
    invalid("manual-launch-authorization.v1", f.authorization);
    rejects(() => manual.verifyManualAuthorization(f), "CONTRACT_SCHEMA_INVALID");
  }
});

test("complete revocation chain rejects either matching revocation but not other IDs", () => {
  for (const action of ["REVOKE_AUTHORIZATION", "REVOKE_PROFILE"]) {
    const f = fixture();
    const r = {
      ...record("revocation", f.request.binding),
      action,
      sequence: 1,
      previousRevocationDigest: f.revocation.headDigest,
      authorizationId:
        action === "REVOKE_AUTHORIZATION" ? f.authorization.payload.authorizationId : null,
      reasonCode: "OWNER_REVOKED",
      recordedAt: NOW
    };
    f.revocation.records.push(r);
    f.revocation.headDigest = sha256Canonical(r);
    rejects(() => manual.verifyManualAuthorization(f), "MANUAL_AUTHORIZATION_REVOKED");
    if (action === "REVOKE_AUTHORIZATION") {
      r.authorizationId = UUID;
      f.revocation.headDigest = sha256Canonical(r);
      manual.assertManualDecision(manual.verifyManualAuthorization(f));
      r.previousRevocationDigest = OTHER;
      f.revocation.headDigest = sha256Canonical(r);
      rejects(() => manual.verifyManualAuthorization(f), "MANUAL_REVOCATION_UNVERIFIED");
    }
  }
});

test("visible predecessor digest identity status and absence are enforced", () => {
  for (const phase of ["apply", "replay", "reconcile"]) {
    for (const mutate of [
      (f) => {
        f.session.predecessor = null;
      },
      (f) => {
        f.session.predecessor.operationId = UUID;
      },
      (f) => {
        f.session.predecessor.status = "FAILED";
        f.session.predecessor.reasonCode = "FAILED";
      }
    ]) {
      const f = fixture(phase);
      mutate(f);
      rejects(() => manual.verifyManualAuthorization(f), "MANUAL_BINDING_MISMATCH");
    }
  }
  const f = fixture();
  f.session.predecessor = record("execution", f.request.binding);
  rejects(() => manual.verifyManualAuthorization(f), "MANUAL_BINDING_MISMATCH");
});

test("handoff is a separate frozen brand and repeated pure verification is permitted", () => {
  const f = fixture("dry-run"),
    h = handoff(f),
    parent = manual.verifyManualAuthorization(f),
    child = manual.verifyManualHandoff(h);
  assert.deepEqual(child, {
    kind: "manual-child-decision",
    authorizationDigest: sha256Canonical(f.authorization),
    requestDigest: f.authorization.payload.requestDigest,
    profileDigest: sha256Canonical(f.profile),
    receiptDigest: sha256Canonical(h.receipt),
    ...h.childObservation,
    promotionEligible: false
  });
  assert.ok(Object.isFrozen(child));
  manual.assertManualHandoffDecision(child);
  manual.assertManualHandoffDecision(manual.verifyManualHandoff(h));
  rejects(() => manual.assertManualDecision(child), "MANUAL_DECISION_UNTRUSTED");
  rejects(() => manual.assertManualHandoffDecision(parent), "MANUAL_HANDOFF_UNTRUSTED");
  rejects(() => manual.assertManualHandoffDecision({ ...child }), "MANUAL_HANDOFF_UNTRUSTED");
});

test("object-valued profile version stays a structural error in authorization and handoff", () => {
  const parent = fixture90("verify");
  const child = handoff(parent);
  parent.profile.schemaVersion = { toString: null };
  child.profile.schemaVersion = { toString: null };
  rejects(() => manual.verifyManualAuthorization(parent), "CONTRACT_SCHEMA_INVALID");
  rejects(() => manual.verifyManualHandoff(child), "CONTRACT_SCHEMA_INVALID");
});

test("90-day profile selects only the complete v2 authorization and handoff record chain", () => {
  const current = fixture90("verify");
  manual.assertManualDecision(manual.verifyManualAuthorization(current));
  manual.assertManualHandoffDecision(manual.verifyManualHandoff(handoff(current)));

  const v1InV2 = fixture90();
  v1InV2.session.record.schemaVersion = "manual-operation-record.v1";
  v1InV2.session.recordDigest = sha256Canonical(v1InV2.session.record);
  rejects(() => manual.verifyManualAuthorization(v1InV2), "CONTRACT_SCHEMA_INVALID");

  const v2InV1 = fixture();
  v2InV1.session.record.schemaVersion = "manual-operation-record.v2";
  v2InV1.session.recordDigest = sha256Canonical(v2InV1.session.record);
  rejects(() => manual.verifyManualAuthorization(v2InV1), "CONTRACT_SCHEMA_INVALID");

  const signedWrongDigest = fixture90();
  signedWrongDigest.request.binding.profileDigest = OTHER;
  signedWrongDigest.session.record.profileDigest = OTHER;
  signedWrongDigest.revocation.records[0].profileDigest = OTHER;
  signedWrongDigest.session.recordDigest = sha256Canonical(signedWrongDigest.session.record);
  signedWrongDigest.revocation.headDigest = sha256Canonical(
    signedWrongDigest.revocation.records[0]
  );
  signedWrongDigest.revocation.checkpoint.digest = signedWrongDigest.revocation.headDigest;
  rebind(signedWrongDigest);
  rejects(() => manual.verifyManualAuthorization(signedWrongDigest), "MANUAL_BINDING_MISMATCH");
});

for (const [label, change, code] of [
  [
    "unsigned receipt",
    (h) => {
      h.receipt.signature = "";
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  ["wrong domain", (h) => resignReceipt(h.receipt, "manual-launch"), "MANUAL_SIGNATURE_INVALID"],
  [
    "wrong authorization",
    (h) => {
      h.receipt.authorizationDigest = OTHER;
      resignReceipt(h.receipt);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "wrong challenge",
    (h) => {
      h.childObservation.childChallenge = "e".repeat(64);
    },
    "MANUAL_BINDING_MISMATCH"
  ],
  [
    "tampered consumption",
    (h) => {
      h.receipt.consumptionRecordDigest = OTHER;
    },
    "MANUAL_SIGNATURE_INVALID"
  ],
  [
    "over 30 seconds",
    (h) => {
      h.receipt.expiresAt = "2026-09-07T12:00:30.001Z";
      resignReceipt(h.receipt);
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "shortened receipt",
    (h) => {
      h.receipt.expiresAt = "2026-09-07T12:00:29.999Z";
      resignReceipt(h.receipt);
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "expired receipt",
    (h) => {
      h.now = h.receipt.expiresAt;
    },
    "MANUAL_TIME_INVALID"
  ],
  [
    "over five minute parent",
    (h) => {
      h.authorization.payload.expiresAt = "2026-09-07T12:04:59.001Z";
      h.authorization = rawSign(h.authorization.payload);
      h.receipt.authorizationDigest = sha256Canonical(h.authorization);
      resignReceipt(h.receipt);
    },
    "MANUAL_TIME_INVALID"
  ]
])
  test(`handoff rejects ${label}`, () => {
    const h = handoff(fixture("dry-run"));
    change(h);
    rejects(() => manual.verifyManualHandoff(h), code);
  });

for (const kind of [
  "session",
  "revocation",
  "consumption",
  "consumption-handoff",
  "post-state",
  "execution",
  "custody",
  "signoff"
])
  test(`closed ${kind} record required fields and branches`, () => {
    const r = record(kind);
    validateContract("manual-operation-record.v1", r);
    for (const key of Object.keys(r)) {
      const missing = clone(r);
      delete missing[key];
      invalid("manual-operation-record.v1", missing, "required");
    }
    invalid("manual-operation-record.v1", { ...r, extra: true }, "additionalProperties");
    invalid("manual-operation-record.v1", { ...r, kind: "other" });
    invalid("manual-operation-record.v1", { ...r, promotionEligible: true }, "const");
    const negative = clone(r);
    if ("reasonCode" in negative) negative.reasonCode = "UNEXPECTED_REASON";
    else if (kind === "consumption") negative.status = "AVAILABLE";
    else negative.consumptionReadbackDigest = null;
    invalid("manual-operation-record.v1", negative);
  });

for (const kind of [
  "session",
  "revocation",
  "consumption",
  "consumption-handoff",
  "post-state",
  "execution",
  "custody",
  "signoff"
])
  test(`closed v2 ${kind} record required fields and branches`, () => {
    const r = record(kind);
    r.schemaVersion = "manual-operation-record.v2";
    if (kind === "custody") r.retentionDays = 90;
    validateContract("manual-operation-record.v2", r);
    for (const key of Object.keys(r)) {
      const missing = clone(r);
      delete missing[key];
      invalid("manual-operation-record.v2", missing, "required");
    }
    invalid("manual-operation-record.v2", { ...r, extra: true }, "additionalProperties");
    invalid("manual-operation-record.v2", { ...r, kind: "other" });
    invalid("manual-operation-record.v2", { ...r, promotionEligible: true }, "const");
    const negative = clone(r);
    if ("reasonCode" in negative) negative.reasonCode = "UNEXPECTED_REASON";
    else if (kind === "consumption") negative.status = "AVAILABLE";
    else negative.consumptionReadbackDigest = null;
    invalid("manual-operation-record.v2", negative);
  });

test("profile recursively closes roots targets and trust with explicit UUID patterns", () => {
  const p = profile();
  validateContract("manual-stage1-profile.v1", p);
  for (const mutate of [
    (v) => {
      v.buildTrust.extra = true;
    },
    (v) => {
      v.allowedTargets[0].roles.extra = "x";
    },
    (v) => {
      v.allowedCommands.push(v.allowedCommands[0]);
    },
    (v) => {
      v.storage.keyRef = "../key";
    },
    (v) => {
      v.profileId = UUID.toUpperCase();
    },
    (v) => {
      v.storage.archiveRoot = "relative/path";
    }
  ]) {
    const bad = clone(p);
    mutate(bad);
    invalid("manual-stage1-profile.v1", bad);
  }
});

test("v2 profile recursively closes roots targets and fixes retention at 90 days", () => {
  const p = profile90();
  validateContract("manual-stage1-profile.v2", p);
  for (const mutate of [
    (v) => {
      v.buildTrust.extra = true;
    },
    (v) => {
      v.allowedTargets[0].roles.extra = "x";
    },
    (v) => {
      v.allowedCommands.push(v.allowedCommands[0]);
    },
    (v) => {
      v.storage.keyRef = "../key";
    },
    (v) => {
      v.profileId = UUID.toUpperCase();
    },
    (v) => {
      v.storage.archiveRoot = "relative/path";
    },
    (v) => {
      v.storage.retentionDays = 180;
    }
  ]) {
    const bad = clone(p);
    mutate(bad);
    invalid("manual-stage1-profile.v2", bad);
  }
});

test("barrel keeps six manual functions while consumer checks stay module-local exports", async () => {
  const barrel = await import("../src/index.mjs");
  assert.deepEqual(
    Object.keys(manual).sort(),
    [
      "assertManualDecision",
      "assertManualHandoffDecision",
      "encodeManualJson",
      "signManualAuthorization",
      "validateManualSnapshotConsumerRequest",
      "verifyManualAuthorization",
      "verifyManualHandoff",
      "verifyManualSnapshotConsumerAuthorizationBinding"
    ].sort()
  );
  const f = fixture();
  const authorization = barrel.signManualAuthorization({
    payload: f.authorization.payload,
    privateKey: keys.privateKey
  });
  barrel.assertManualDecision(barrel.verifyManualAuthorization({ ...f, authorization }));
  barrel.assertManualHandoffDecision(barrel.verifyManualHandoff(handoff(fixture("verify"))));
  assert.equal(barrel.encodeManualJson({ ok: true }).toString(), '{"ok":true}');
  assert.equal(barrel.validateManualSnapshotConsumerRequest, undefined);
  assert.equal(barrel.verifyManualSnapshotConsumerAuthorizationBinding, undefined);
});

function consumerFixture(phase = "prebuild-source") {
  const p = profile90();
  // Digest references below are synthetic; no scope/input/destination is admitted.
  const request = {
    schemaVersion: "manual-runner-request.v2",
    profileDigest: sha256Canonical(p),
    ownerId: p.ownerId,
    sessionId: UUID,
    sessionNonce: "c".repeat(64),
    operationId: UUID2,
    idempotencyKey: "test-consumer-only",
    attemptId: UUID,
    runId: UUID2,
    attemptAllocationDigest: D,
    stage: "snapshot-consumer",
    capability: "read-decrypt-use",
    purpose: "sanitized-snapshot-test-input",
    phase,
    sourceSha: "d".repeat(40),
    scopeAuthorizationDigest: D,
    destinationAdmissionDigest: D,
    input: { prebuildBindingDigest: D }
  };
  if (phase !== "prebuild-source") {
    request.input = {
      privateCustodyDigest: D,
      producerCompletionDigest: D,
      producerTerminalObservationDigest: D
    };
    request.candidate = {
      buildProofDigest: D,
      buildBundleDigest: D,
      dispatchAuthorizationDigest: D,
      rcWorkflowRunId: "123"
    };
    if (phase === "final") request.matchingRcSourceEvidenceDigest = D;
  }
  const binding = Object.fromEntries(
    [
      "profileDigest",
      "ownerId",
      "sessionId",
      "sessionNonce",
      "operationId",
      "idempotencyKey",
      "stage",
      "capability",
      "purpose",
      "phase",
      "scopeAuthorizationDigest"
    ].map((field) => [field, request[field]])
  );
  const payload = {
    schemaVersion: "manual-launch-authorization.v2",
    authorizationId: UUID2,
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    requestDigest: sha256Canonical(request),
    ...binding
  };
  return { request, payload, profile: p, now: NOW };
}

function consumerCheck(f, authorization = rawSign(f.payload)) {
  return manual.verifyManualSnapshotConsumerAuthorizationBinding({
    authorization,
    profile: f.profile,
    requestBytes: encodeManualJson(f.request),
    now: f.now
  });
}

test("consumer v2 has three closed phases and real pure signature round trips", async (t) => {
  for (const phase of ["prebuild-source", "rc-source", "final"]) {
    await t.test(phase, () => {
      const f = consumerFixture(phase);
      const captured = manual.validateManualSnapshotConsumerRequest(f.request);
      assert.deepEqual(captured, f.request);
      assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.input));
      const authorization = manual.signManualAuthorization({
        payload: f.payload,
        privateKey: keys.privateKey
      });
      assert.equal(consumerCheck(f, authorization), undefined);
      f.request.input[Object.keys(f.request.input)[0]] = OTHER;
      assert.notDeepEqual(captured, f.request);
    });
  }
});

test("consumer v2 rejects mixed phases missing facts and executable or extra data", () => {
  const changes = [
    (r) => {
      r.candidate = consumerFixture("rc-source").request.candidate;
    },
    (r) => {
      r.input.prebuildBindingDigest = null;
    },
    (r) => {
      r.input.extra = D;
    },
    (r) => {
      r.approved = true;
    },
    (r) => {
      r.schemaVersion = "manual-runner-request.v1";
    }
  ];
  for (const change of changes) {
    const f = consumerFixture();
    change(f.request);
    rejects(
      () => manual.validateManualSnapshotConsumerRequest(f.request),
      "CONTRACT_SCHEMA_INVALID"
    );
  }
  const rc = consumerFixture("rc-source");
  delete rc.request.candidate;
  rejects(
    () => manual.validateManualSnapshotConsumerRequest(rc.request),
    "CONTRACT_SCHEMA_INVALID"
  );
  const final = consumerFixture("final");
  delete final.request.matchingRcSourceEvidenceDigest;
  rejects(
    () => manual.validateManualSnapshotConsumerRequest(final.request),
    "CONTRACT_SCHEMA_INVALID"
  );
  const sameId = consumerFixture();
  sameId.request.runId = sameId.request.attemptId;
  rejects(
    () => manual.validateManualSnapshotConsumerRequest(sameId.request),
    "MANUAL_BINDING_MISMATCH"
  );
  const getter = consumerFixture();
  Object.defineProperty(getter.request, "sourceSha", {
    enumerable: true,
    get() {
      throw new Error("must not read");
    }
  });
  rejects(
    () => manual.validateManualSnapshotConsumerRequest(getter.request),
    "CANONICAL_JSON_REFUSED"
  );
});

test("consumer v2 signature binds full request version canonical bytes and time", () => {
  for (const field of ["sourceSha", "destinationAdmissionDigest", "scopeAuthorizationDigest"]) {
    const f = consumerFixture();
    const authorization = rawSign(f.payload);
    f.request[field] = field === "sourceSha" ? "e".repeat(40) : OTHER;
    rejects(() => consumerCheck(f, authorization), "MANUAL_BINDING_MISMATCH");
  }
  const input = consumerFixture();
  const original = rawSign(input.payload);
  input.request.input.prebuildBindingDigest = OTHER;
  rejects(() => consumerCheck(input, original), "MANUAL_BINDING_MISMATCH");
  const f = consumerFixture();
  const wrongKey = generateKeyPairSync("ed25519");
  rejects(
    () => consumerCheck(f, rawSign(f.payload, wrongKey.privateKey)),
    "MANUAL_SIGNATURE_INVALID"
  );
  const v1 = rawSign({ ...f.payload, schemaVersion: "manual-launch-authorization.v1" });
  rejects(() => consumerCheck(f, v1), "CONTRACT_SCHEMA_INVALID");
  rejects(
    () =>
      manual.verifyManualSnapshotConsumerAuthorizationBinding({
        authorization: rawSign(f.payload),
        profile: f.profile,
        requestBytes: Buffer.from(JSON.stringify(f.request)),
        now: NOW
      }),
    "MANUAL_BINDING_MISMATCH"
  );
  const expired = consumerFixture();
  expired.now = EXPIRES;
  rejects(() => consumerCheck(expired), "MANUAL_TIME_INVALID");
  const tooLong = consumerFixture();
  tooLong.payload.expiresAt = "2026-09-07T12:05:00.000Z";
  rejects(() => consumerCheck(tooLong), "MANUAL_TIME_INVALID");
});

test("valid consumer v2 cannot acquire a production parent or handoff decision", async () => {
  const f = consumerFixture();
  const authorization = manual.signManualAuthorization({
    payload: f.payload,
    privateKey: keys.privateKey
  });
  assert.equal(consumerCheck(f, authorization), undefined);
  rejects(() => manual.assertManualDecision(authorization), "MANUAL_DECISION_UNTRUSTED");
  const old = fixture90();
  rejects(
    () => manual.verifyManualAuthorization({ ...old, authorization }),
    "CONTRACT_SCHEMA_INVALID"
  );
  const { validateManualRunnerRequest } = await import("../src/manual-runner-evidence.mjs");
  // This is the same unchanged validator called by session.checkedRequest.
  rejects(() => validateManualRunnerRequest(f.request), "CONTRACT_SCHEMA_INVALID");
  rejects(() => manual.assertManualHandoffDecision(authorization), "MANUAL_HANDOFF_UNTRUSTED");
});

test("SPKI input rejects concatenated keys instead of parsing only a prefix", () => {
  const f = fixture();
  f.profile.publicKeyPem += f.profile.publicKeyPem;
  rejects(() => manual.verifyManualAuthorization(f), "MANUAL_SIGNATURE_INVALID");
});

test("profile paths accept canonical Unicode locations and reject overlapping backup", () => {
  const f = fixture();
  f.profile.storage.archiveRoot = "/manual/人工档案";
  f.request.binding.profileDigest = sha256Canonical(f.profile);
  f.session.record.profileDigest = f.request.binding.profileDigest;
  f.session.recordDigest = sha256Canonical(f.session.record);
  f.revocation.records[0].profileDigest = f.request.binding.profileDigest;
  f.revocation.headDigest = sha256Canonical(f.revocation.records[0]);
  f.revocation.checkpoint.digest = f.revocation.headDigest;
  rebind(f);
  manual.assertManualDecision(manual.verifyManualAuthorization(f));
  f.profile.storage.backupRoot = "/manual/人工档案/backup";
  rejects(() => manual.verifyManualAuthorization(f), "MANUAL_BINDING_MISMATCH");
});

test("new-session reconciliation and separate read-only verification preserve visible predecessor rules", () => {
  const f = fixture("reconcile");
  f.session.predecessor.sessionId = UUID2;
  f.session.predecessor.sessionNonce = "f".repeat(64);
  f.request.binding.predecessorExecutionRecordDigest = sha256Canonical(f.session.predecessor);
  rebind(f);
  manual.assertManualDecision(manual.verifyManualAuthorization(f));
  const v = fixture("verify");
  v.session.predecessor = record("execution", v.request.binding);
  v.session.predecessor.operationId = UUID;
  v.session.predecessor.idempotencyKey = "prior-migration";
  v.request.binding.predecessorExecutionRecordDigest = sha256Canonical(v.session.predecessor);
  rebind(v);
  manual.assertManualDecision(manual.verifyManualAuthorization(v));
  const a = fixture("apply");
  a.session.predecessor.sessionId = UUID2;
  a.request.binding.dryRunRecordDigest = sha256Canonical(a.session.predecessor);
  rebind(a);
  rejects(() => manual.verifyManualAuthorization(a), "MANUAL_BINDING_MISMATCH");
});

test("authorization windows include exact lower and five-minute boundaries and clamp handoff expiry", () => {
  const f = fixture("dry-run");
  f.now = ISSUED;
  f.session.readAt = ISSUED;
  f.revocation.readAt = ISSUED;
  manual.assertManualDecision(manual.verifyManualAuthorization(f));
  const h = handoff(f);
  h.authorization.payload.expiresAt = "2026-09-07T12:00:00.001Z";
  h.authorization = rawSign(h.authorization.payload);
  h.receipt.authorizationDigest = sha256Canonical(h.authorization);
  h.receipt.expiresAt = h.authorization.payload.expiresAt;
  resignReceipt(h.receipt);
  manual.assertManualHandoffDecision(manual.verifyManualHandoff(h));
  for (const time of ["2026-02-30T12:00:00.000Z", "2026-09-07T12:00:00Z"]) {
    const payload = { ...f.authorization.payload, issuedAt: time };
    const code = time.endsWith(".000Z") ? "MANUAL_TIME_INVALID" : "CONTRACT_SCHEMA_INVALID";
    rejects(() => manual.signManualAuthorization({ payload, privateKey: keys.privateKey }), code);
  }
});

test("record status alternatives retain honest nullable evidence without inventing success", () => {
  const examples = [
    { ...record("session"), status: "CLOSED", previousSessionRecordDigest: D },
    {
      ...record("session"),
      status: "INTERRUPTED_UNKNOWN",
      previousSessionRecordDigest: D,
      reasonCode: "LOST"
    },
    {
      ...record("post-state"),
      outcome: "UNAVAILABLE",
      observationDigest: null,
      observedAt: null,
      reasonCode: "UNAVAILABLE"
    },
    {
      ...record("execution"),
      status: "PREFLIGHT_REJECTED",
      reasonCode: "REJECTED",
      startedAt: null,
      finishedAt: null,
      resultDigest: null
    },
    { ...record("execution"), status: "FAILED", reasonCode: "FAILED", processEvidenceDigest: null },
    {
      ...record("execution"),
      status: "INTERRUPTED_UNKNOWN",
      reasonCode: "LOST",
      finishedAt: null,
      resultDigest: null,
      processEvidenceDigest: null
    },
    {
      ...record("execution"),
      handoffRecordDigest: null,
      handoffReadbackDigest: null,
      processEvidenceDigest: null
    },
    {
      ...record("custody"),
      outcome: "UNKNOWN",
      observedDigest: null,
      observedAt: null,
      reasonCode: "MISSING"
    },
    { ...record("custody"), outcome: "FAILED", observedDigest: OTHER, reasonCode: "MISMATCH" },
    { ...record("signoff"), decision: "REJECTED", reasonCode: "REJECTED" }
  ];
  for (const r of examples) validateContract("manual-operation-record.v1", r);
  invalid("manual-operation-record.v1", { ...record("execution"), handoffReadbackDigest: null });
  invalid("manual-operation-record.v1", {
    ...record("execution"),
    status: "FAILED",
    reasonCode: "FAILED",
    resultDigest: null,
    processEvidenceDigest: null
  });
  invalid("manual-operation-record.v1", {
    ...record("custody"),
    purpose: "backup-readback",
    storageRole: "archive"
  });
});
