import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { encodeManualJson } from "../src/manual-stage1-contracts.mjs";
import { sha256Bytes, sha256Canonical } from "../src/digest.mjs";
import {
  APPROVED_R3_INCIDENT_EB5A1850,
  assessR3IncidentIntent,
  planR3IncidentLockRetirement
} from "../src/manual-r3-incident.mjs";

test("eb5a signed intent pins live inodes and permits only same-intent partial resume", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const profile = {
    ownerId: "test-owner",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  };
  const policy = {
    ...APPROVED_R3_INCIDENT_EB5A1850,
    ownerId: profile.ownerId,
    profileDigest: sha256Canonical(profile)
  };
  const locks = policy.lockNames.map((name, index) => ({
    name,
    digest: policy.lockDigest,
    identity: {
      dev: "50",
      ino: String(index + 100),
      uid: "0",
      gid: "0",
      mode: "33152",
      nlink: "1",
      size: "713"
    }
  }));
  const record = {
    schemaVersion: "manual-r3-incident-intent.v1",
    policyDigest: sha256Canonical(policy),
    decision: "OWNER_ACCEPTED_UNRESOLVED_FAILURE",
    createdAt: "2026-10-10T04:30:00.000Z",
    remoteCreationKnown: false,
    remoteCleanupVerified: false,
    promotionEligible: false,
    ownerProcessesAbsent: true,
    job: policy.github,
    forwardShutdownDigest: sha256Bytes(Buffer.from("safe shutdown")),
    locks
  };
  const intentBytes = encodeManualJson({
    record,
    signature: sign(
      null,
      Buffer.concat([Buffer.from("subscription-saas/r3-incident/v1\n"), encodeManualJson(record)]),
      privateKey
    ).toString("base64")
  });
  const intent = assessR3IncidentIntent({
    profile,
    policy,
    intentBytes,
    now: "2026-10-10T04:30:01.000Z"
  });
  assert.deepEqual(planR3IncidentLockRetirement(intent, locks, [null, null]), policy.lockNames);
  assert.deepEqual(planR3IncidentLockRetirement(intent, [null, locks[1]], [locks[0], null]), [
    policy.lockNames[1]
  ]);
  const replacement = { ...locks[1], identity: { ...locks[1].identity, ino: "999" } };
  assert.throws(() => planR3IncidentLockRetirement(intent, [null, replacement], [locks[0], null]), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
});
