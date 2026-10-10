import test from "node:test";
import assert from "node:assert/strict";
import * as incident from "../src/manual-r3-incident.mjs";

test("the eb5a disposition binds only its consumed d789 failure", () => {
  const p = incident.APPROVED_R3_INCIDENT_EB5A1850;
  assert.ok(p, "the exact incident must be registered");
  assert.equal(p.operationRef, "eb5a1850-8fb0-4bbd-a832-9e99be5d166a");
  assert.equal(
    p.proposalDigest,
    "sha256:e73900c42bc2e8a48d4504cb44fd9191f326d37b6039072865aa522de3b524b5"
  );
  assert.equal(
    p.approvalDigest,
    "sha256:bedce8cb38cb1afea5a2e28e2beb159986be0ebfacd72cf413dcb7715bbbb927"
  );
  assert.equal(
    p.consumptionDigest,
    "sha256:a94c29bb2d97a50378ffce023b6e04a7bc2e26406153027871694baec08c979f"
  );
  assert.equal(
    p.executionDigest,
    "sha256:b591f7bb7683a5604523c4c88317ca7a7eb05fd099a5adf348f10365f761ecda"
  );
  assert.equal(
    p.sessionDigest,
    "sha256:3b8f051c896b9c5f9b1743640e4def006b2b5feb0822a921d71170b03ee38d98"
  );
  assert.equal(p.lockIdentities, undefined);
  assert.deepEqual(p.github, {
    repository: "keqi119/subscription-Saas",
    runId: "38018148143",
    runAttempt: 1,
    jobId: "114113872845",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-10T03:03:30Z"
  });
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: "d789f752c477bd58294eb267d06e75da1a0b42f0",
    proofRawDigest: "sha256:b379f56180284ae23738a78a074a61c1375dbac108d894b69e765f6321d890b6",
    materialRawDigest: "sha256:de6208a039919f6d386b0abb620d5108701f901a7ffad4790a33d9ac55c29ed4",
    creationSpecDigest: "sha256:33a1dcc7ab47197707bd63b4d9f6eeb23d55d5c0cce5154b330c580fee5cf93d",
    jobAdmissionDigest: "sha256:35720de5c29b8f4bdc5cbcb37d2e48a6da75ed309b50f0d6e413541f6580cc5c"
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-d789f75"
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({ ...binding, sourceSha: "0".repeat(40) }),
    null
  );
});
