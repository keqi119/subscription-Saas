import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_R3_INCIDENT_79FEAA9A,
  approvedR3HistoricalSourceBinding
} from "../src/manual-r3-incident.mjs";

test("the approved 79fe exception binds only its original ba872 source and job", () => {
  assert.equal(
    APPROVED_R3_INCIDENT_79FEAA9A.proposalDigest,
    "sha256:c99ac9fadc0a296bd1392a886d4253140b2fef28edb1710aa90a6440bf4eb014"
  );
  assert.equal(
    APPROVED_R3_INCIDENT_79FEAA9A.approvalDigest,
    "sha256:11510ebcdbc5b8df5e7c997e67942b3bec2ef61f2f38faf37be09089943d6a77"
  );
  assert.deepEqual(APPROVED_R3_INCIDENT_79FEAA9A.github, {
    repository: "keqi119/subscription-Saas",
    runId: "37697010723",
    runAttempt: 1,
    jobId: "113052793748",
    status: "completed",
    conclusion: "cancelled",
    completedAt: "2026-10-07T23:01:13Z"
  });
  const binding = {
    operationRef: "79feaa9a-f5ba-4a48-a781-e406726e6580",
    profileDigest: "sha256:49df6dae67aa386086f207e79e8c221ec61e466b9a19c2422d77878f621fd541",
    sourceSha: "ba872d6cb2c0e054e5ab099a8218b7220a215301",
    proofRawDigest: "sha256:d2c9299bb48f07c2831766e4c57458e3913f12cf8000fc7e970ea3ab5615ffbd",
    materialRawDigest: "sha256:50fccc8485815b014de94e0cfbb6c225af3c011d91ba46c7c0678871c7a7e89e",
    creationSpecDigest: "sha256:b657a22b04bea481da2f0ec20d310e4fdc6c03712ba815a3015cf9f0a59d9a0f",
    jobAdmissionDigest: "sha256:07b2dcb0eb606d8f232bd282fca01bc9f68cefd5daf9c2e53db69d6fa0b77b84"
  };
  assert.equal(approvedR3HistoricalSourceBinding(binding), "/opt/stage1-r3-candidate-ba872d6");
  assert.equal(approvedR3HistoricalSourceBinding({ ...binding, sourceSha: "0".repeat(40) }), null);
});
