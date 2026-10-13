import test from "node:test";
import assert from "node:assert/strict";
import * as incident from "../src/manual-r3-incident.mjs";

test("7e incident binds only its approved 8e historical source and UNKNOWN", () => {
  const p = incident.APPROVED_R3_INCIDENT_7E2DF1BA;
  assert.ok(p, "the exact approved incident must be registered");
  assert.equal(p.operationRef, "7e2df1ba-5b43-45a7-b167-78fa649d9cec");
  assert.equal(
    p.proposalDigest,
    "sha256:6c73530a2c93028de4b9f1968787747ca167e5d5ecf3916eaa1193d23f8348e2"
  );
  assert.equal(
    p.approvalDigest,
    "sha256:15a06b67c0a6607d5011efcc1a6f358d0c4583f7688ed6dbad7f62414447994a"
  );
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: p.lockScope.sourceSha,
    proofRawDigest: "sha256:fb0f4e36bef00b37e00254333feba621d7bd309774cec803069f77e44a35b38c",
    materialRawDigest: "sha256:2cbc480b3accb81efb9abcf60a16e97166382de8ad570140c39b85fda762fb1a",
    creationSpecDigest: p.lockScope.creationSpecDigest,
    jobAdmissionDigest: p.lockScope.jobAdmissionDigest
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-8e1743a"
  );
  for (const changed of [
    { operationRef: "c820b449-4356-4870-b8ca-7409ba01f507" },
    { proofRawDigest: "sha256:" + "0".repeat(64) },
    { materialRawDigest: "sha256:" + "0".repeat(64) }
  ])
    assert.equal(incident.approvedR3HistoricalSourceBinding({ ...binding, ...changed }), null);
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
  graph.get(p.executionDigest).value.status = "SUCCEEDED";
  assert.throws(() => incident.assertR3IncidentSessionShape(p, graph), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
});
