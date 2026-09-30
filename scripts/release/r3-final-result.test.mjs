import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { encodeManualJson } from "../../packages/release-foundation/src/manual-stage1-contracts.mjs";
import { planR3DatabaseTargets } from "./r3-database-targets.mjs";
import {
  assertR3FinalAcknowledgement,
  buildR3FinalAcknowledgement,
  buildR3FinalCompletion,
  r3FinalObservationNames,
  readR3FinalOriginals
} from "./r3-final-result.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../../release/contracts/database-test-manifest.v1.json", import.meta.url))
);
const digest = (value) => sha256Bytes(Buffer.from(value));

function fixture() {
  const operationId = "10000000-0000-4000-8000-000000000001";
  const plan = planR3DatabaseTargets({
    operationRef: operationId,
    phase: "final",
    chain: "fresh",
    manifest
  });
  const names = r3FinalObservationNames({ manifest, plan });
  const buildProof = {
    identity: { sourceSha: "1".repeat(40), migrationCatalogDigest: digest("catalog") }
  };
  const destination = { schemaVersion: "manual-r3-destination.v1", databaseTargetSet: { plan } };
  const request = {
    schemaVersion: "manual-runner-request.v5",
    profileDigest: digest("profile"),
    ownerId: "owner",
    sessionId: "20000000-0000-4000-8000-000000000001",
    sessionNonce: "2".repeat(64),
    operationId,
    idempotencyKey: `r3-candidate-use:${operationId}`,
    attemptId: "30000000-0000-4000-8000-000000000001",
    runId: "40000000-0000-4000-8000-000000000001",
    stage: "candidate-use",
    capability: "execute-final-database-tests",
    purpose: "stage1-isolated-database-tests",
    phase: "final",
    chain: "fresh",
    sourceSha: buildProof.identity.sourceSha,
    targetPolicyDigest: digest("policy"),
    creationSpecDigest: digest("spec"),
    jobAdmissionDigest: digest("job"),
    candidate: { buildProofDigest: sha256Canonical(buildProof) },
    destinationAdmissionDigest: sha256Canonical(destination),
    preparationExecutionRecordDigest: digest("preparation"),
    databaseTestManifestDigest: sha256Canonical(manifest),
    matchingSourceEvidenceDigest: digest("source terminal"),
    attemptAllocationDigest: digest("allocation")
  };
  const initialExecution = {
    schemaVersion: "manual-operation-record.v3",
    kind: "execution",
    profileDigest: request.profileDigest,
    recordedAt: "2026-09-29T00:00:00.000Z",
    promotionEligible: false,
    stage: "candidate-use",
    sessionId: request.sessionId,
    sessionNonce: request.sessionNonce,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
    requestDigest: sha256Canonical(request),
    authorizationDigest: digest("authorization"),
    consumptionRecordDigest: digest("consumption"),
    predecessorExecutionRecordDigest: request.preparationExecutionRecordDigest,
    startedAt: null,
    finishedAt: null,
    status: "INTERRUPTED_UNKNOWN",
    reasonCode: "MANUAL_EVIDENCE_INCOMPLETE",
    resultDigest: null,
    processEvidenceDigest: null
  };
  const originals = names.map((name) => ({ name, digest: digest(`original:${name}`), bytes: 10 }));
  const verified = {
    readbackDigest: originals.at(-1).digest,
    reconstructedDigest: digest("reconstructed"),
    sourceClaims: {
      matchingSourceEvidenceDigest: request.matchingSourceEvidenceDigest,
      matchingSourceResultDigest: digest("source result"),
      expectedSchemaDigest: digest("schema")
    },
    originals,
    suiteReadbacks: manifest.suites.map(({ suiteId }) => ({
      suiteId,
      readbackDigest: originals.find(({ name }) => name === suiteId).digest,
      reportDigest: digest(`report:${suiteId}`)
    }))
  };
  const custodyRecords = originals.flatMap(({ digest: subjectDigest }) =>
    ["archive", "backup"].map((storageRole) => ({
      schemaVersion: "manual-operation-record.v3",
      kind: "custody",
      profileDigest: request.profileDigest,
      recordedAt: "2026-09-29T00:00:01.000Z",
      promotionEligible: false,
      ownerId: request.ownerId,
      subjectDigest,
      subjectType: "record",
      purpose: `${storageRole}-readback`,
      outcome: "MATCH",
      observedDigest: subjectDigest,
      observedAt: "2026-09-29T00:00:01.000Z",
      storageRole,
      retentionDays: 90,
      reasonCode: null
    }))
  );
  return {
    request,
    initialExecution,
    manifest,
    verified,
    custodyRecords,
    completedAt: "2026-09-29T00:00:02.000Z",
    plan,
    buildProof,
    destination
  };
}

test("final completion binds fixed observations and two custody copies per original", () => {
  const f = fixture();
  const result = buildR3FinalCompletion(f);
  assert.equal(result.schemaVersion, "manual-r3-final-result.v1");
  assert.equal(
    result.originals.length,
    r3FinalObservationNames({ manifest: f.manifest, plan: f.plan }).length
  );
  assert.equal(result.custodyRecordDigests.length, result.originals.length * 2);
  const application = f.plan.targets.find(({ kind }) => kind === "application");
  assert.equal(result.originals.filter(({ name }) => name === application.databaseName).length, 1);
  assert.equal(f.verified.suiteReadbacks.length, manifest.suites.length);
  assert.equal(result.matchingSourceEvidenceDigest, f.request.matchingSourceEvidenceDigest);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.candidateUseExecutionRecordDigest, sha256Canonical(f.initialExecution));
  assert.ok(encodeManualJson(result).length <= 1048576);
});

test("final completion rejects missing custody, mismatched source, time and original order", () => {
  for (const mutate of [
    (f) => {
      const application = f.plan.targets.find(({ kind }) => kind === "application");
      f.verified.originals = f.verified.originals.filter(
        ({ name }) => name !== application.databaseName
      );
    },
    (f) => f.custodyRecords.pop(),
    (f) => {
      f.verified.sourceClaims.matchingSourceEvidenceDigest = digest("other source");
    },
    (f) => {
      f.completedAt = "2026-09-28T23:59:59.000Z";
    },
    (f) => {
      [f.verified.originals[1], f.verified.originals[2]] = [
        f.verified.originals[2],
        f.verified.originals[1]
      ];
    }
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => buildR3FinalCompletion(value), { code: "R3_FINAL_RESULT_INVALID" });
  }
});

test("final acknowledgement binds the successful candidate-use terminal and final result", () => {
  const f = fixture();
  const result = buildR3FinalCompletion(f);
  const execution = {
    ...f.initialExecution,
    recordedAt: "2026-09-29T00:00:04.000Z",
    predecessorExecutionRecordDigest: sha256Canonical(f.initialExecution),
    startedAt: f.initialExecution.recordedAt,
    finishedAt: "2026-09-29T00:00:03.000Z",
    status: "SUCCEEDED",
    reasonCode: null,
    resultDigest: sha256Canonical(result),
    processEvidenceDigest: result.readbackDigest
  };
  const input = {
    profileDigest: f.request.profileDigest,
    ownerId: f.request.ownerId,
    execution,
    result,
    observedAt: "2026-09-29T00:00:05.000Z",
    recordedAt: "2026-09-29T00:00:06.000Z"
  };
  const acknowledgement = buildR3FinalAcknowledgement(input);
  assert.equal(acknowledgement.kind, "custody");
  assert.equal(acknowledgement.purpose, "owner-acknowledgement");
  assert.equal(acknowledgement.subjectDigest, sha256Canonical(execution));
  assert.equal(acknowledgement.promotionEligible, false);
  assert.ok(Object.isFrozen(acknowledgement));
  assert.deepEqual(
    assertR3FinalAcknowledgement({ ...input, acknowledgement, now: "2026-09-29T00:00:07.000Z" }),
    acknowledgement
  );
  for (const mutate of [
    (value) => {
      value.result.phase = "source";
    },
    (value) => {
      value.result.schemaVersion = "manual-r3-source-result.v1";
    },
    (value) => {
      value.execution.stage = "snapshot-consumer";
    },
    (value) => {
      value.execution.status = "FAILED";
    },
    (value) => {
      value.result.matchingSourceEvidenceDigest = digest("different source");
    },
    (value) => {
      value.result.sourceClaims.matchingSourceEvidenceDigest = digest("different source");
    },
    (value) => {
      value.observedAt = "2026-09-29T00:00:03.000Z";
    }
  ]) {
    const value = JSON.parse(JSON.stringify(input));
    mutate(value);
    assert.throws(() => buildR3FinalAcknowledgement(value), { code: "R3_FINAL_RESULT_INVALID" });
  }
  assert.throws(
    () => assertR3FinalAcknowledgement({ ...input, acknowledgement, now: input.observedAt }),
    { code: "R3_FINAL_RESULT_INVALID" }
  );
});

test("final original reader rejects archive/backup byte disagreement before claiming any result", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      readR3FinalOriginals({
        manifest: f.manifest,
        plan: f.plan,
        discovery: { classification: { unclassified: [] }, discoveryDigest: digest("discovery") },
        request: f.request,
        initialExecution: f.initialExecution,
        destination: f.destination,
        buildProof: f.buildProof,
        migrationCatalog: { digest: f.buildProof.identity.migrationCatalogDigest },
        globalObjectPolicy: {},
        lifecycleRecords: [],
        repoRoot: "/app",
        recheck: async () => {},
        readObservation: async ({ storageRole }) =>
          Buffer.from(storageRole === "archive" ? "{}" : '{"x":1}')
      }),
    { code: "R3_FINAL_RESULT_INVALID" }
  );
});
