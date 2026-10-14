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

test("the second approved incident has its own exact historical source and cancelled job", () => {
  const p = incident.APPROVED_R3_INCIDENT_0AF9C545;
  assert.equal(p.operationRef, "0af9c545-8cbc-4d1a-9027-e840c39ce9fd");
  assert.equal(p.github.jobId, "112549922961");
  assert.equal(p.github.conclusion, "cancelled");
  assert.equal(p.sessionDigest, null);
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: "b16f5aebb6b8599eb807c65751018a4d4efe224b",
    proofRawDigest: "sha256:4541fd36e754bd2c86fbef8a30f69050c3c5e480c54cae2d94c7dc9d7e1d776a",
    materialRawDigest: "sha256:59f6f9e61a8676d3113b73f7e6bbf193f09d2822d4d533f38d5596e428ae028d",
    creationSpecDigest: "sha256:b67f92679b7af2130714a765bda0b92462e166e436058f033cd638e20fc213f7",
    jobAdmissionDigest: "sha256:89e88f63fb306e16634cd0952fe7c03a7e87004abfc2199fc2e79f1be60ba301"
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-b16f5ae"
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      operationRef: incident.APPROVED_R3_INCIDENT.operationRef
    }),
    null
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      sourceSha: "127a9eb281a65b216b53e863ad9734ac4650399e"
    }),
    null
  );
});

test("only the fixed open session shape is accepted for the unclosed incident", () => {
  const p = incident.APPROVED_R3_INCIDENT_0AF9C545;
  const graph = new Map([
    [p.openingDigest, { value: { kind: "session", sessionId: p.sessionId, status: "OPEN" } }],
    [
      p.executionDigest,
      { value: { kind: "execution", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" } }
    ]
  ]);
  assert.doesNotThrow(() => incident.assertR3IncidentSessionShape(p, graph));
  graph.set("sha256:" + "f".repeat(64), {
    value: { kind: "session", sessionId: p.sessionId, status: "INTERRUPTED_UNKNOWN" }
  });
  assert.throws(() => incident.assertR3IncidentSessionShape(p, graph), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
  assert.throws(() => incident.assertR3IncidentSessionShape(incident.APPROVED_R3_INCIDENT, graph), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
});

test("approved 588 incident binds its own failed job, historical source and real closing session", () => {
  const p = incident.APPROVED_R3_INCIDENT_588DA0DC;
  assert.equal(p.operationRef, "588da0dc-713a-4832-ab04-96421ed50236");
  assert.equal(
    p.proposalDigest,
    "sha256:e891c70738cebae883bb0032f9bd3c20c08c11542a6415ab69cbce0eed64f6d3"
  );
  assert.equal(
    p.approvalDigest,
    "sha256:5944c7bc7c638135f718950a8001718c7cf5527441d92f4a7558ea8bc881e3c4"
  );
  assert.equal(p.github.jobId, "112583597083");
  assert.equal(p.github.conclusion, "failure");
  assert.equal(
    p.sessionDigest,
    "sha256:64fd3913b34cd24602bb5d0a22c4245a166fa79108a1ef5293b2e57462107015"
  );
  const binding = {
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: "8928a0ffa3c29609e0da99144de2415438c9d081",
    proofRawDigest: "sha256:db884e1a359b40e5085b72f90d77e428d52557b03613838904d4748a3f867c3f",
    materialRawDigest: "sha256:c845f7a0edf3a88685c77823f9fd2ab2135ee0083c54a117eaf8f44a134a7d4d",
    creationSpecDigest: "sha256:de38862595bf073531fc8ce6a987f1583dd45e4207f1ff5455dfb76ffd692555",
    jobAdmissionDigest: "sha256:49836924c8b071bd7f19bf09b6f15f88279c83d6f38214b6864029d7739eb6d4"
  };
  assert.equal(
    incident.approvedR3HistoricalSourceBinding(binding),
    "/opt/stage1-r3-candidate-8928a0f"
  );
  assert.deepEqual(incident.approvedR3HistoricalContractCompatibility(binding), {
    sourceRoot: "/opt/stage1-r3-candidate-8928a0f",
    sourceSha: "8928a0ffa3c29609e0da99144de2415438c9d081",
    catalogRawDigest: "sha256:f74e7ad905e0c02764cb312708b88765f6cf304b204bd6b32edf2fb3ac67b7f8",
    discoveryVersion: "r3-historical-entrypoints-literal.v1"
  });
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      operationRef: incident.APPROVED_R3_INCIDENT_0AF9C545.operationRef
    }),
    null
  );
  assert.equal(
    incident.approvedR3HistoricalSourceBinding({
      ...binding,
      creationSpecDigest: incident.APPROVED_R3_INCIDENT_0AF9C545.executionDigest
    }),
    null
  );
  assert.equal(
    incident.approvedR3HistoricalContractCompatibility({
      ...binding,
      operationRef: incident.APPROVED_R3_INCIDENT_0AF9C545.operationRef
    }),
    null
  );
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
  graph.delete(p.sessionDigest);
  assert.throws(() => incident.assertR3IncidentSessionShape(p, graph), {
    code: "MANUAL_R3_INCIDENT_UNVERIFIED"
  });
});

test("all seven approved historical identities select pinned catalog descriptors exactly", () => {
  const rows = [
    [
      incident.APPROVED_R3_INCIDENT,
      "127a9eb281a65b216b53e863ad9734ac4650399e",
      "08dbcfa5fba486e15e919745ce79c83145d0489faddba7325bd4bf5d6958ef16",
      "601d61606ace6e4566c6ed632d06880ff0f9d2f7ba8f19793aaa4bfb07c15aab",
      "36ccc8274c9c5b3688581faf63a4346138b9fc9248eec2b715b34b559777de54",
      "211fdcd1327da1dae8dc348d70dc35f445f4173a65a964705dc29a8536e5129e",
      "093bf133860d113e31c7ecd1e4c4f2ff17e9f2c0720f0b6a722b5f6e44f47c95"
    ],
    [
      incident.APPROVED_R3_INCIDENT_0AF9C545,
      "b16f5aebb6b8599eb807c65751018a4d4efe224b",
      "4541fd36e754bd2c86fbef8a30f69050c3c5e480c54cae2d94c7dc9d7e1d776a",
      "59f6f9e61a8676d3113b73f7e6bbf193f09d2822d4d533f38d5596e428ae028d",
      "b67f92679b7af2130714a765bda0b92462e166e436058f033cd638e20fc213f7",
      "89e88f63fb306e16634cd0952fe7c03a7e87004abfc2199fc2e79f1be60ba301",
      "f74e7ad905e0c02764cb312708b88765f6cf304b204bd6b32edf2fb3ac67b7f8"
    ],
    [
      incident.APPROVED_R3_INCIDENT_588DA0DC,
      "8928a0ffa3c29609e0da99144de2415438c9d081",
      "db884e1a359b40e5085b72f90d77e428d52557b03613838904d4748a3f867c3f",
      "c845f7a0edf3a88685c77823f9fd2ab2135ee0083c54a117eaf8f44a134a7d4d",
      "de38862595bf073531fc8ce6a987f1583dd45e4207f1ff5455dfb76ffd692555",
      "49836924c8b071bd7f19bf09b6f15f88279c83d6f38214b6864029d7739eb6d4",
      "f74e7ad905e0c02764cb312708b88765f6cf304b204bd6b32edf2fb3ac67b7f8"
    ],
    [
      incident.APPROVED_R3_INCIDENT_79FEAA9A,
      "ba872d6cb2c0e054e5ab099a8218b7220a215301",
      "d2c9299bb48f07c2831766e4c57458e3913f12cf8000fc7e970ea3ab5615ffbd",
      "50fccc8485815b014de94e0cfbb6c225af3c011d91ba46c7c0678871c7a7e89e",
      "b657a22b04bea481da2f0ec20d310e4fdc6c03712ba815a3015cf9f0a59d9a0f",
      "07b2dcb0eb606d8f232bd282fca01bc9f68cefd5daf9c2e53db69d6fa0b77b84",
      "eff52b42151eba49db32040e7003fec4aeb991e7e644545dba3492c94bad910e"
    ],
    [
      incident.APPROVED_R3_INCIDENT_EB5A1850,
      "d789f752c477bd58294eb267d06e75da1a0b42f0",
      "b379f56180284ae23738a78a074a61c1375dbac108d894b69e765f6321d890b6",
      "de6208a039919f6d386b0abb620d5108701f901a7ffad4790a33d9ac55c29ed4",
      "33a1dcc7ab47197707bd63b4d9f6eeb23d55d5c0cce5154b330c580fee5cf93d",
      "35720de5c29b8f4bdc5cbcb37d2e48a6da75ed309b50f0d6e413541f6580cc5c",
      "b90945d2e8df4155f55432eb9f5a5f091ff990a6857918f1eefa409a3f702f6e"
    ],
    [
      incident.APPROVED_R3_INCIDENT_C820B449,
      "4af1e8bd3c905add104bb130d888b7708273b87f",
      "f04cc477d1ea6ce768679bbc5e7d5917937cf4c0cdf73c2a062671e361c52710",
      "6b5f78ee1b9975e7436451c9a2844eeb40f82190351f2b4a643dd5705c304d5b",
      "765c333996470265b10b03240e45d906b0e014736ac0bea1bf8501cc74dc0aad",
      "1d6f2168af3bf2826f30362c6f829c0f47f4a6081974e9a8d5360e8f0631b706",
      "d2a8bdef9f1b7aa85334946d962d6476dafce3ca36472c248b6baf5a0317a7cd"
    ],
    [
      incident.APPROVED_R3_INCIDENT_7E2DF1BA,
      "8e1743ad90705240dcaaeace45a9f130ecc3b565",
      "fb0f4e36bef00b37e00254333feba621d7bd309774cec803069f77e44a35b38c",
      "2cbc480b3accb81efb9abcf60a16e97166382de8ad570140c39b85fda762fb1a",
      "15d222b72eaf84247f0e176d26a9665ea640713f91711cfe0ff662d8fed94925",
      "66f55dd3e477d1556b0f66373c8d8d54ef018682c13f7b2b79a369e1e14504fa",
      "606292d7c0294a8cbf2152382f5033f02417923d296eb4aafcf47fd4e9b10c74"
    ]
  ];
  for (const [policy, sourceSha, proof, material, spec, admission, catalog] of rows) {
    const input = {
      operationRef: policy.operationRef,
      profileDigest: policy.profileDigest,
      sourceSha,
      proofRawDigest: `sha256:${proof}`,
      materialRawDigest: `sha256:${material}`,
      creationSpecDigest: `sha256:${spec}`,
      jobAdmissionDigest: `sha256:${admission}`
    };
    const expectedRoot = `/opt/stage1-r3-candidate-${sourceSha.slice(0, 7)}`;
    assert.deepEqual(incident.approvedR3HistoricalContractCompatibility(input), {
      sourceRoot: expectedRoot,
      sourceSha,
      catalogRawDigest: `sha256:${catalog}`,
      discoveryVersion: "r3-historical-entrypoints-literal.v1"
    });
    for (const key of Object.keys(input)) {
      assert.equal(
        incident.approvedR3HistoricalContractCompatibility({
          ...input,
          [key]:
            key === "operationRef"
              ? "00000000-0000-4000-8000-000000000000"
              : "sha256:" + "0".repeat(64)
        }),
        null,
        `${policy.operationRef}:${key}`
      );
    }
  }
});
