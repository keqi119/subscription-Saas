import test from "node:test";
import assert from "node:assert/strict";
import * as incident from "../src/manual-r3-incident.mjs";

test("the c820 disposition binds only its consumed 4af sourceFresh failure", () => {
  const p = incident.APPROVED_R3_INCIDENT_C820B449;
  assert.ok(p, "the exact incident must be registered");
  assert.equal(p.operationRef, "c820b449-4356-4870-b8ca-7409ba01f507");
  assert.equal(
    p.proposalDigest,
    "sha256:93a8bfb67e49a865766bc4dd5495b353311934dc360787d9807f2a2b8e82029b"
  );
  assert.equal(
    p.approvalDigest,
    "sha256:0995fbed097e7fd702daa50d256e72100203a2afed30a7670c7bb0b5f7ba2acf"
  );
  assert.equal(
    p.consumptionDigest,
    "sha256:21bb9fc34911c3a319fe5b660650f10fdea71823bec1edaf9833e100d195e02e"
  );
  assert.equal(
    p.executionDigest,
    "sha256:1a71b243b3635fc10978a9040e4e348b0a3420889691cfd5d5eee79472bb9553"
  );
  assert.equal(
    p.sessionDigest,
    "sha256:6dc6d161f49f2ae1752a7252305346f83018c5f332e995e74ffb24e3cbe7051d"
  );
  assert.equal(p.lockIdentities, undefined);
  assert.equal(
    p.lockDigest,
    "sha256:f9a0d6bd8832f7e9f4c0ca48dba89a22906ca4cbd7de3bb676c801434046881a"
  );
  assert.deepEqual(p.lockScope, {
    targetPolicyDigest: "sha256:fb9707e26b2ad5e00d4cd61d88e6835b0aeb3210d01e9c6fbbfb9bc4a47cb8d5",
    creationSpecDigest: "sha256:765c333996470265b10b03240e45d906b0e014736ac0bea1bf8501cc74dc0aad",
    jobAdmissionDigest: "sha256:1d6f2168af3bf2826f30362c6f829c0f47f4a6081974e9a8d5360e8f0631b706",
    buildProofDigest: "sha256:f04cc477d1ea6ce768679bbc5e7d5917937cf4c0cdf73c2a062671e361c52710",
    sourceSha: "4af1e8bd3c905add104bb130d888b7708273b87f",
    phase: "source",
    chain: "fresh"
  });
  assert.equal(
    p.consumptionSlotName,
    "49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541-eecb9b58-9cd6-4b4a-b2e5-f3ea7a81c676.json"
  );
  assert.deepEqual(p.lockNames, [
    "13d8b7b5c1aaf60b6b2a5b36f861b0dda7df2b80f8feb3013120d190f332130b.json",
    "a52de7e6885d8285e8b9fea11dc44012a5e465c55f18701a176bef30b865386b.json"
  ]);
  assert.deepEqual(p.github, {
    repository: "keqi119/subscription-Saas",
    runId: "38204226514",
    runAttempt: 1,
    jobId: "114665031289",
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-10-12T04:50:52Z"
  });
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: "4af1e8bd3c905add104bb130d888b7708273b87f",
    proofRawDigest: "sha256:f04cc477d1ea6ce768679bbc5e7d5917937cf4c0cdf73c2a062671e361c52710",
    materialRawDigest: "sha256:6b5f78ee1b9975e7436451c9a2844eeb40f82190351f2b4a643dd5705c304d5b",
    creationSpecDigest: "sha256:765c333996470265b10b03240e45d906b0e014736ac0bea1bf8501cc74dc0aad",
    jobAdmissionDigest: "sha256:1d6f2168af3bf2826f30362c6f829c0f47f4a6081974e9a8d5360e8f0631b706"
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-4af1e8b"
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({ ...binding, sourceSha: "0".repeat(40) }),
    null
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      creationSpecDigest: "sha256:" + "0".repeat(64)
    }),
    null
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      jobAdmissionDigest: "sha256:" + "0".repeat(64)
    }),
    null
  );
});

test("c820 exception requires the original UNKNOWN execution and closing", () => {
  const p = incident.APPROVED_R3_INCIDENT_C820B449;
  const graph = new Map([
    [p.openingDigest, { value: { kind: "session", sessionId: p.sessionId, status: "OPEN" } }],
    [
      p.executionDigest,
      { value: { kind: "execution", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" } }
    ],
    [
      p.sessionDigest,
      { value: { kind: "session", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" } }
    ]
  ]);
  assert.doesNotThrow(() => incident.assertR3IncidentSessionShape(p, graph));
  graph.set(p.sessionDigest, {
    value: { kind: "session", sessionId: p.sessionId, status: "CLOSED" }
  });
  assert.throws(() => incident.assertR3IncidentSessionShape(p, graph), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
});
