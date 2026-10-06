import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import { assessR3IncidentRecords } from "../src/manual-r3-incident.mjs";
import * as incident from "../src/manual-r3-incident.mjs";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const profile = {
    ownerId: "test-owner",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  };
  const policy = {
    profileDigest: sha256Canonical(profile),
    ownerId: "test-owner",
    approvalDigest: sha256Canonical("approved"),
    proposalDigest: sha256Canonical("proposal"),
    executeNotAfter: "2026-10-07T06:53:54.742Z",
    lockDigest: sha256Canonical("original-lock"),
    lockNames: ["a".repeat(64) + ".json", "b".repeat(64) + ".json"],
    github: {
      repository: "test/repo",
      runId: "123",
      runAttempt: 1,
      jobId: "456",
      status: "completed",
      conclusion: "failure",
      completedAt: "2026-10-06T17:18:11Z"
    }
  };
  const locks = policy.lockNames.map((name, index) => ({
    name,
    digest: policy.lockDigest,
    identity: {
      dev: "2",
      ino: String(10 + index),
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "200"
    }
  }));
  const intent = {
    schemaVersion: "manual-r3-incident-intent.v1",
    policyDigest: sha256Canonical(policy),
    decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
    createdAt: "2026-10-06T19:00:00.000Z",
    remoteCreationKnown: false,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: policy.github,
    forwardShutdownDigest: sha256Canonical("before"),
    locks
  };
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
  const intentBytes = seal(intent);
  const disposition = {
    schemaVersion: "manual-r3-incident-disposition.v1",
    intentDigest: sha256Bytes(intentBytes),
    status: "LOCAL_CHANNEL_SLOTS_RETIRED_WITH_OWNER_EXCEPTION",
    completedAt: "2026-10-06T19:00:01.000Z",
    remoteCreationKnown: false,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: policy.github,
    forwardShutdownDigest: sha256Canonical("after"),
    locks
  };
  return {
    profile,
    policy,
    intent,
    disposition,
    seal,
    input: {
      profile,
      policy,
      intentBytes,
      dispositionBytes: seal(disposition),
      retiredLocks: structuredClone(locks),
      now: "2026-10-06T19:01:00.000Z"
    }
  };
}

test("signed incident admits only unresolved failure after both original locks are retained", () => {
  const f = fixture();
  const result = assessR3IncidentRecords(f.input);
  assert.equal(result?.status, "OWNER_ACCEPTED_UNRESOLVED_FAILURE");
  assert.equal(result.remoteCleanupVerified, false);
  assert.equal(result.promotionEligible, false);
  assert.deepEqual(result.intent, f.intent);
  assert.deepEqual(result.disposition, f.disposition);
});

test("partial retirement, substituted lock or mismatched approval never admits an incident", () => {
  for (const mutate of [
    (f) => f.input.retiredLocks.pop(),
    (f) => {
      f.input.retiredLocks[0].identity.ino = "999";
    },
    (f) => {
      f.input.policy = { ...f.policy, approvalDigest: sha256Canonical("different-owner-decision") };
    },
    (f) => {
      f.disposition.remoteCleanupVerified = true;
      f.input.dispositionBytes = f.seal(f.disposition);
    },
    (f) => {
      f.disposition.completedAt = "2026-10-07T07:00:00.000Z";
      f.input.dispositionBytes = f.seal(f.disposition);
    },
    (f) => {
      f.disposition.job = { ...f.policy.github, jobId: "457" };
      f.input.dispositionBytes = f.seal(f.disposition);
    }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assessR3IncidentRecords(f.input), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
  }
});

test("wrong signing key or tampered signed intent remains blocked", () => {
  const f = fixture();
  const signed = JSON.parse(f.input.intentBytes);
  signed.record.createdAt = "2026-10-06T18:59:59.000Z";
  f.input.intentBytes = encodeManualJson(signed);
  assert.throws(() => assessR3IncidentRecords(f.input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
  const g = fixture();
  g.input.dispositionBytes = f.seal(g.disposition);
  assert.throws(() => assessR3IncidentRecords(g.input), { code: "MANUAL_R3_INCIDENT_UNVERIFIED" });
});

test("a resumed retirement requires the same signed intent and preserves original lock identities", () => {
  const f = fixture();
  const intent = incident.assessR3IncidentIntent({
    profile: f.profile,
    policy: f.policy,
    intentBytes: f.input.intentBytes,
    now: f.input.now
  });
  assert.deepEqual(intent, f.intent);
  assert.deepEqual(
    incident.planR3IncidentLockRetirement(
      intent,
      [null, f.intent.locks[1]],
      [f.intent.locks[0], null]
    ),
    [f.intent.locks[1].name]
  );
  for (const [active, retired] of [
    [
      [null, null],
      [f.intent.locks[0], null]
    ],
    [
      [f.intent.locks[0], f.intent.locks[1]],
      [f.intent.locks[0], null]
    ],
    [
      [null, f.intent.locks[1]],
      [{ ...f.intent.locks[0], identity: { ...f.intent.locks[0].identity, ino: "999" } }, null]
    ]
  ])
    assert.throws(() => incident.planR3IncidentLockRetirement(intent, active, retired), {
      code: "MANUAL_R3_INCIDENT_UNVERIFIED"
    });
});

test("pure signed assessments and caller supplied booleans cannot authorize historical exceptions", () => {
  const f = fixture();
  assert.equal(
    incident.matchesR3IncidentDisposition(assessR3IncidentRecords(f.input), {}, {}),
    false
  );
  assert.equal(
    incident.matchesR3IncidentDisposition({ status: "OWNER_ACCEPTED_UNRESOLVED_FAILURE" }, {}, {}),
    false
  );
});
