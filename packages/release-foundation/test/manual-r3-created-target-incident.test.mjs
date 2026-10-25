import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { encodeManualJson, signManualAuthorization } from "../src/manual-stage1-contracts.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import { suiteDatabaseName } from "../src/database-target.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import * as incident from "../src/manual-r3-incident.mjs";

const KIND = "CREATED_TARGET_CANDIDATE_USE_UNCONSUMED";
const failed = { code: "MANUAL_R3_INCIDENT_UNVERIFIED" };
const signer = generateKeyPairSync("ed25519").privateKey;

function graphFixture() {
  const graph = new Map();
  const put = (value) => {
    const bytes = encodeManualJson(value);
    const digest = sha256Bytes(bytes);
    graph.set(digest, { value, bytes });
    return digest;
  };
  const operationRef = "728eafd7-f137-4d7f-a0ad-73b2a687e59b";
  const sessionId = "9c76295a-3fc2-4316-9382-22eb513bdf9a";
  const sessionNonce = "a".repeat(64);
  const creationAttemptId = "creation-attempt";
  const creationRunId = "creation-run";
  const candidateAttemptId = "candidate-attempt";
  const candidateRunId = "candidate-run";
  const profileDigest = sha256Canonical("profile");
  const lockScope = {
    targetPolicyDigest: sha256Canonical("policy"),
    creationSpecDigest: sha256Canonical("spec"),
    jobAdmissionDigest: sha256Canonical("admission"),
    buildProofDigest: sha256Canonical("build"),
    sourceSha: "233d237227fbcbf5bb03efb068decca63dc6bca7",
    phase: "source",
    chain: "fresh"
  };
  const openingDigest = put({ kind: "session", status: "OPEN", sessionId, sessionNonce });
  const sessionDigest = put({
    kind: "session",
    status: "INTERRUPTED_UNKNOWN",
    sessionId,
    sessionNonce,
    previousSessionRecordDigest: openingDigest
  });
  const allocationDigest = put({
    kind: "attempt-allocation",
    stage: "target-create",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    sessionRecordDigest: openingDigest,
    attemptId: creationAttemptId,
    runId: creationRunId,
    predecessorExecutionRecordDigest: null
  });
  const requestDigest = put({
    schemaVersion: "manual-runner-request.v4",
    stage: "target-create",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    attemptId: creationAttemptId,
    runId: creationRunId,
    attemptAllocationDigest: allocationDigest
  });
  const authorizationDigest = put(
    signManualAuthorization({
      privateKey: signer,
      payload: {
        schemaVersion: "manual-launch-authorization.v4",
        authorizationId: "11111111-1111-4111-8111-111111111111",
        issuedAt: "2026-10-15T14:00:00.000Z",
        expiresAt: "2026-10-15T14:05:00.000Z",
        requestDigest,
        profileDigest,
        ownerId: "owner",
        sessionId,
        sessionNonce,
        operationId: operationRef,
        idempotencyKey: "target-create",
        stage: "target-create",
        capability: "create-isolated-target",
        purpose: "stage1-isolated-database-tests",
        phase: "source",
        chain: "fresh",
        targetPolicyDigest: lockScope.targetPolicyDigest,
        creationSpecDigest: lockScope.creationSpecDigest,
        jobAdmissionDigest: lockScope.jobAdmissionDigest
      }
    })
  );
  const consumption = {
    kind: "consumption",
    stage: "target-create",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    sessionRecordDigest: openingDigest,
    requestDigest,
    authorizationDigest
  };
  const consumptionDigest = put(consumption);
  const initialExecutionDigest = put({
    kind: "execution",
    stage: "target-create",
    status: "INTERRUPTED_UNKNOWN",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    attemptId: creationAttemptId,
    predecessorExecutionRecordDigest: null,
    requestDigest,
    authorizationDigest,
    consumptionRecordDigest: consumptionDigest
  });
  const targetLocks = Array.from({ length: 39 }, (_, index) => {
    const databaseName =
      index < 37
        ? suiteDatabaseName(operationRef, `suite-${index}`, 0)
        : suiteDatabaseName(operationRef, "database-lifecycle", index - 37);
    const marker = `subscription-s1-ephemeral/v1:${canonicalJson({
      markerVersion: "subscription-s1-ephemeral/v1",
      runIdDigest: sha256Canonical(operationRef),
      suiteIdDigest: sha256Canonical(`suite-${index}`),
      shard: 0,
      createdAt: "2026-10-15T14:00:00.000Z"
    })}`;
    const identity =
      index < 37
        ? {
            kind: "r3-database-target",
            engineId: "engine",
            systemIdentifier: "1",
            databaseOid: String(index + 1),
            marker
          }
        : {
            kind: "r3-database-reservation",
            engineId: "engine",
            systemIdentifier: "1",
            databaseName
          };
    return {
      lockDigest: sha256Canonical(identity),
      identity,
      databaseName
    };
  });
  const destinationDigest = put({
    schemaVersion: "manual-r3-destination.v1",
    databaseTargetSet: { targetLocks }
  });
  const completedExecutionDigest = put({
    kind: "execution",
    stage: "target-create",
    status: "SUCCEEDED",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    attemptId: creationAttemptId,
    requestDigest,
    authorizationDigest,
    consumptionRecordDigest: consumptionDigest,
    predecessorExecutionRecordDigest: initialExecutionDigest,
    resultDigest: destinationDigest
  });
  const candidateUseAllocationDigest = put({
    kind: "attempt-allocation",
    stage: "candidate-use",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    sessionRecordDigest: openingDigest,
    attemptId: candidateAttemptId,
    runId: candidateRunId,
    predecessorExecutionRecordDigest: completedExecutionDigest,
    preparationExecutionRecordDigest: completedExecutionDigest,
    destinationAdmissionDigest: destinationDigest
  });
  const candidateUseRequestDigest = put({
    schemaVersion: "manual-runner-request.v5",
    stage: "candidate-use",
    operationId: operationRef,
    sessionId,
    sessionNonce,
    attemptId: candidateAttemptId,
    runId: candidateRunId,
    preparationExecutionRecordDigest: completedExecutionDigest,
    destinationAdmissionDigest: destinationDigest,
    attemptAllocationDigest: candidateUseAllocationDigest
  });
  const candidateUseAuthorizationDigest = put(
    signManualAuthorization({
      privateKey: signer,
      payload: {
        schemaVersion: "manual-launch-authorization.v5",
        authorizationId: "22222222-2222-4222-8222-222222222222",
        issuedAt: "2026-10-15T14:45:00.000Z",
        expiresAt: "2026-10-15T14:50:00.000Z",
        requestDigest: candidateUseRequestDigest,
        profileDigest,
        ownerId: "owner",
        sessionId,
        sessionNonce,
        operationId: operationRef,
        idempotencyKey: "candidate-use",
        stage: "candidate-use",
        capability: "execute-source-database-tests",
        purpose: "stage1-isolated-database-tests",
        phase: "source",
        chain: "fresh",
        targetPolicyDigest: lockScope.targetPolicyDigest,
        creationSpecDigest: lockScope.creationSpecDigest,
        jobAdmissionDigest: lockScope.jobAdmissionDigest,
        destinationAdmissionDigest: destinationDigest,
        preparationExecutionRecordDigest: completedExecutionDigest,
        databaseTestManifestDigest: sha256Canonical("manifest")
      }
    })
  );
  const retainedLocks = targetLocks.map((entry, index) => {
    const value = {
      profileDigest,
      sessionId,
      sessionNonce,
      scope: lockScope,
      pid: 1234,
      operationRef,
      executionRecordDigest: initialExecutionDigest,
      databaseName: entry.databaseName,
      target: entry.identity
    };
    return { name: `${entry.lockDigest.slice(7)}.json`, value, bytes: encodeManualJson(value) };
  });
  const policy = {
    incidentKind: KIND,
    operationRef,
    sessionId,
    profileDigest,
    lockScope,
    lockNames: ["a".repeat(64) + ".json", "b".repeat(64) + ".json"],
    openingDigest,
    sessionDigest,
    allocationDigest,
    requestDigest,
    authorizationDigest,
    consumptionDigest,
    initialExecutionDigest,
    completedExecutionDigest,
    destinationDigest,
    candidateUseAllocationDigest,
    candidateUseRequestDigest,
    candidateUseAuthorizationDigest
  };
  return { policy, graph, consumptions: [consumption], retainedLocks };
}

test("created-target pure assessor accepts the exact succeeded creation and preserves 39 targets", () => {
  const input = graphFixture();
  assert.equal(typeof incident.assessCreatedTargetR3IncidentGraph, "function");
  const result = incident.assessCreatedTargetR3IncidentGraph(input);
  assert.deepEqual(result, {
    targetLockCount: 39,
    remoteCreationKnown: true,
    remoteCleanupVerified: false,
    promotionEligible: false
  });
});

test("created-target historical assessor still rejects a forward slot regardless of its claimed session", () => {
  const input = graphFixture();
  const value = { sessionId: "2c1670f1-764a-4bf2-803b-a3f56b01b9de", pid: 1234 };
  input.retainedLocks.push({
    name: input.policy.lockNames[0],
    value,
    bytes: encodeManualJson(value)
  });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(input), failed);
});

test("native incident shape accepts only the fixed creation pair and pure results cannot brand", () => {
  const { policy, graph, consumptions } = graphFixture();
  assert.doesNotThrow(() => incident.assertR3IncidentSessionShape(policy, graph));
  const forged = incident.assessCreatedTargetR3IncidentGraph(graphFixture());
  assert.equal(incident.isCreatedR3IncidentDisposition(forged), false);
  assert.equal(
    incident.matchesR3IncidentDisposition(
      forged,
      consumptions[0],
      graph.get(policy.initialExecutionDigest).value
    ),
    false
  );
  const extra = { kind: "execution", sessionId: policy.sessionId, status: "SUCCEEDED" };
  graph.set(sha256Canonical(extra), { value: extra, bytes: encodeManualJson(extra) });
  assert.throws(() => incident.assertR3IncidentSessionShape(policy, graph), failed);
});

test("test-only exact policy reaches native reader only with all originals and 39 retained locks", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const profile = {
    ownerId: "owner",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    storage: { archiveRoot: "/test/archive", journalRoot: "/test/journal" }
  };
  const input = graphFixture();
  const p = input.policy;
  p.profileDigest = sha256Canonical(profile);
  p.ownerId = profile.ownerId;
  p.github = { completedAt: "2026-10-15T14:58:00.000Z" };
  p.executeNotAfter = "2026-10-16T04:00:00.000Z";
  p.consumptionSlotName = "target-create.json";
  const forwardBytes = encodeManualJson({ status: "VERIFIED" });
  const proposalBytes = encodeManualJson({ operationRef: p.operationRef });
  const approvalBytes = encodeManualJson({ approved: p.operationRef });
  const retiredBytes = encodeManualJson({ sessionId: p.sessionId, pid: 1234 });
  p.forwardShutdownDigest = sha256Bytes(forwardBytes);
  p.proposalDigest = sha256Bytes(proposalBytes);
  p.approvalDigest = sha256Bytes(approvalBytes);
  p.lockDigest = sha256Bytes(retiredBytes);
  for (const held of input.retainedLocks) {
    held.value.profileDigest = p.profileDigest;
    held.bytes = encodeManualJson(held.value);
  }
  const source = readFileSync(new URL("../src/manual-r3-incident.mjs", import.meta.url), "utf8")
    .replace(
      'from "./manual-stage1-contracts.mjs"',
      `from "${new URL("../src/manual-stage1-contracts.mjs", import.meta.url).href}"`
    )
    .replace('from "./digest.mjs"', `from "${new URL("../src/digest.mjs", import.meta.url).href}"`)
    .replace(
      "    APPROVED_R3_INCIDENT_728EAFD7\n  ];",
      "    globalThis.__createdTargetNativeTestPolicy\n  ];"
    )
    .replace(
      'await import("../../../scripts/release/r3-h1-forward-lease.mjs")',
      "({ assessR3H1ForwardShutdown: () => {} })"
    );
  globalThis.__createdTargetNativeTestPolicy = p;
  t.after(() => {
    delete globalThis.__createdTargetNativeTestPolicy;
  });
  const native = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const files = new Map();
  const putFile = (file, bytes) => files.set(file, bytes);
  for (const [digest, role] of [
    [p.openingDigest, "journal"],
    [p.sessionDigest, "journal"],
    [p.allocationDigest, "archive"],
    [p.requestDigest, "archive"],
    [p.authorizationDigest, "archive"],
    [p.consumptionDigest, "journal"],
    [p.initialExecutionDigest, "journal"],
    [p.completedExecutionDigest, "journal"],
    [p.destinationDigest, "archive"],
    [p.candidateUseAllocationDigest, "archive"],
    [p.candidateUseRequestDigest, "archive"],
    [p.candidateUseAuthorizationDigest, "archive"]
  ])
    putFile(
      path.join(profile.storage[`${role}Root`], "objects", `${digest.slice(7)}.json`),
      input.graph.get(digest).bytes
    );
  putFile(
    path.join(profile.storage.journalRoot, "consumptions", p.consumptionSlotName),
    input.graph.get(p.consumptionDigest).bytes
  );
  const root = path.join(profile.storage.archiveRoot, "incidents", p.operationRef);
  putFile(path.join(root, "proposal.json"), proposalBytes);
  putFile(path.join(root, "approval.json"), approvalBytes);
  const identities = p.lockNames.map((_, index) => ({
    dev: "1",
    ino: String(index + 2),
    uid: "0",
    gid: "0",
    mode: "33152",
    nlink: "1",
    size: String(retiredBytes.length)
  }));
  const locks = p.lockNames.map((name, index) => {
    putFile(path.join(root, "locks", name), retiredBytes);
    return { name, digest: p.lockDigest, identity: identities[index] };
  });
  putFile(path.join(root, `forward-${p.forwardShutdownDigest.slice(7)}.json`), forwardBytes);
  const seal = (record) =>
    encodeManualJson({
      record,
      signature: sign(
        null,
        Buffer.concat([
          Buffer.from("subscription-saas/r3-incident/v1\n"),
          encodeManualJson(record)
        ]),
        privateKey
      ).toString("base64")
    });
  const facts = {
    remoteCreationKnown: true,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: p.github,
    forwardShutdownDigest: p.forwardShutdownDigest,
    locks
  };
  const intentBytes = seal({
    schemaVersion: "manual-r3-incident-intent.v1",
    policyDigest: sha256Canonical(p),
    decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
    createdAt: "2026-10-15T15:00:00.000Z",
    ...facts
  });
  const dispositionBytes = seal({
    schemaVersion: "manual-r3-incident-disposition.v1",
    intentDigest: sha256Bytes(intentBytes),
    status: "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION",
    completedAt: "2026-10-15T15:01:00.000Z",
    ...facts
  });
  putFile(path.join(root, "intent.json"), intentBytes);
  putFile(path.join(root, "disposition.json"), dispositionBytes);
  const environment = {
    profile,
    store: {
      read: async (file) => {
        assert.ok(files.has(file), `missing native original: ${file}`);
        return files.get(file);
      },
      checkedPath: async (file) =>
        identities[p.lockNames.indexOf(path.basename(file))] ?? identities[0]
    },
    retainedLocks: input.retainedLocks,
    stamp: () => "2026-10-15T15:02:00.000Z",
    capture: { pinIdentity: () => {} }
  };
  const read = () =>
    native.readApprovedR3IncidentDisposition(
      environment,
      input.graph,
      p.openingDigest,
      input.consumptions
    );
  const receipt = await read();
  assert.equal(native.isCreatedR3IncidentDisposition(receipt), true);
  assert.equal(
    native.matchesR3IncidentDisposition(
      receipt,
      input.consumptions[0],
      input.graph.get(p.initialExecutionDigest).value
    ),
    false
  );
  input.retainedLocks.pop();
  await assert.rejects(read(), failed);
  input.retainedLocks = graphFixture().retainedLocks.map((held) => {
    held.value.profileDigest = p.profileDigest;
    held.bytes = encodeManualJson(held.value);
    return held;
  });
  const extra = { kind: "consumption", stage: "candidate-use", sessionId: p.sessionId };
  input.graph.set(sha256Canonical(extra), { value: extra, bytes: encodeManualJson(extra) });
  await assert.rejects(read(), failed);
});

test("created-target pure assessor rejects extra execution and candidate-use consumption", () => {
  const extra = graphFixture();
  const value = {
    kind: "execution",
    stage: "candidate-use",
    status: "INTERRUPTED_UNKNOWN",
    sessionId: extra.policy.sessionId
  };
  extra.graph.set(sha256Canonical(value), { value, bytes: encodeManualJson(value) });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(extra), failed);
  const consumed = graphFixture();
  consumed.consumptions.push({
    kind: "consumption",
    stage: "candidate-use",
    sessionId: consumed.policy.sessionId
  });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(consumed), failed);
  const graphOnlyConsumption = graphFixture();
  const extraConsumption = {
    kind: "consumption",
    stage: "candidate-use",
    sessionId: graphOnlyConsumption.policy.sessionId
  };
  graphOnlyConsumption.graph.set(sha256Canonical(extraConsumption), {
    value: extraConsumption,
    bytes: encodeManualJson(extraConsumption)
  });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(graphOnlyConsumption), failed);
  const secondSignedAttempt = graphFixture();
  const another = {
    kind: "attempt-allocation",
    stage: "candidate-use",
    sessionId: secondSignedAttempt.policy.sessionId
  };
  secondSignedAttempt.graph.set(sha256Canonical(another), {
    value: another,
    bytes: encodeManualJson(another)
  });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(secondSignedAttempt), failed);
});

test("created-target pure assessor rejects altered or missing retained target locks", () => {
  const changed = graphFixture();
  changed.retainedLocks[0].value.databaseName = "s1ci_" + "f".repeat(24);
  changed.retainedLocks[0].bytes = encodeManualJson(changed.retainedLocks[0].value);
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(changed), failed);
  const missing = graphFixture();
  missing.retainedLocks.pop();
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(missing), failed);
});

test("created-target pure assessor rejects a changed completion link or absent signed input", () => {
  const relinked = graphFixture();
  const oldDigest = relinked.policy.completedExecutionDigest;
  const completed = relinked.graph.get(oldDigest).value;
  completed.predecessorExecutionRecordDigest = sha256Canonical("another attempt");
  relinked.graph.delete(oldDigest);
  relinked.policy.completedExecutionDigest = sha256Canonical(completed);
  relinked.graph.set(relinked.policy.completedExecutionDigest, {
    value: completed,
    bytes: encodeManualJson(completed)
  });
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(relinked), failed);
  const missing = graphFixture();
  missing.graph.delete(missing.policy.candidateUseAuthorizationDigest);
  assert.throws(() => incident.assessCreatedTargetR3IncidentGraph(missing), failed);
});

test("created-target signed intent requires known creation while legacy intent remains unknown", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const profile = {
    ownerId: "owner",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  };
  const policy = {
    incidentKind: KIND,
    ownerId: "owner",
    profileDigest: sha256Canonical(profile),
    proposalDigest: sha256Canonical("proposal"),
    approvalDigest: sha256Canonical("approval"),
    lockDigest: sha256Canonical("lock"),
    lockNames: ["a".repeat(64) + ".json", "b".repeat(64) + ".json"],
    github: { completedAt: "2026-10-15T15:00:00.000Z" },
    executeNotAfter: "2026-10-16T04:00:00.000Z"
  };
  const locks = policy.lockNames.map((name, index) => ({
    name,
    digest: policy.lockDigest,
    identity: {
      dev: "1",
      ino: String(index + 1),
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "714"
    }
  }));
  const record = {
    schemaVersion: "manual-r3-incident-intent.v1",
    policyDigest: sha256Canonical(policy),
    decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
    createdAt: "2026-10-15T15:01:00.000Z",
    remoteCreationKnown: true,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: policy.github,
    forwardShutdownDigest: sha256Canonical("forward"),
    locks
  };
  const seal = () =>
    encodeManualJson({
      record,
      signature: sign(
        null,
        Buffer.concat([
          Buffer.from("subscription-saas/r3-incident/v1\n"),
          encodeManualJson(record)
        ]),
        privateKey
      ).toString("base64")
    });
  const assess = () =>
    incident.assessR3IncidentIntent({
      profile,
      policy,
      intentBytes: seal(),
      now: "2026-10-15T15:02:00.000Z"
    });
  assert.equal(assess().remoteCreationKnown, true);
  const intentBytes = seal();
  const disposition = {
    schemaVersion: "manual-r3-incident-disposition.v1",
    intentDigest: sha256Bytes(intentBytes),
    status: "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION",
    completedAt: "2026-10-15T15:01:01.000Z",
    remoteCreationKnown: true,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: policy.github,
    forwardShutdownDigest: sha256Canonical("after"),
    locks
  };
  const dispositionBytes = encodeManualJson({
    record: disposition,
    signature: sign(
      null,
      Buffer.concat([
        Buffer.from("subscription-saas/r3-incident/v1\n"),
        encodeManualJson(disposition)
      ]),
      privateKey
    ).toString("base64")
  });
  assert.equal(
    incident.assessR3IncidentRecords({
      profile,
      policy,
      intentBytes,
      dispositionBytes,
      retiredLocks: locks,
      now: "2026-10-15T15:02:00.000Z"
    }).intent.remoteCreationKnown,
    true
  );
  disposition.remoteCreationKnown = false;
  const falseDispositionBytes = encodeManualJson({
    record: disposition,
    signature: sign(
      null,
      Buffer.concat([
        Buffer.from("subscription-saas/r3-incident/v1\n"),
        encodeManualJson(disposition)
      ]),
      privateKey
    ).toString("base64")
  });
  assert.throws(
    () =>
      incident.assessR3IncidentRecords({
        profile,
        policy,
        intentBytes,
        dispositionBytes: falseDispositionBytes,
        retiredLocks: locks,
        now: "2026-10-15T15:02:00.000Z"
      }),
    failed
  );
  record.remoteCreationKnown = false;
  assert.throws(assess, failed);
  delete policy.incidentKind;
  record.policyDigest = sha256Canonical(policy);
  assert.equal(assess().remoteCreationKnown, false);
});
