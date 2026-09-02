import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

import { aggregateReleaseProof } from "./aggregate-release-proof.mjs";
import { generateS1ExitEvidence } from "./generate-s1-exit-evidence.mjs";
import { aggregateInput, custodyRecord, uuid } from "./task29r-proof-fixtures.mjs";

function validInput() {
  const aggregateProof = aggregateReleaseProof(aggregateInput());
  const repositoryObservation = {
    schemaVersion: "s1-repository-observation.v1",
    observationId: "scope-and-inventory",
    sourceSha: aggregateProof.sourceSha,
    repositoryContractDigest: aggregateProof.contracts.repositoryContractDigest,
    status: "EVIDENCED",
    evidenceDigests: [aggregateProof.buildProofDigest],
    observedAt: "2026-09-03T03:10:00.000Z"
  };
  const attestation = {
    schemaVersion: "s1-owner-attestation.v1",
    attestationId: uuid("7"),
    subject: {
      controlId: "legacy-external-owner-migration",
      sourceSha: aggregateProof.sourceSha,
      evidenceDigests: [aggregateProof.finalComposeEvidence.fresh]
    },
    owner: "release-operations",
    facts: [{ factId: "external-entry-closed", value: true }],
    validFrom: "2026-09-03T03:00:00.000Z",
    notAfter: "2026-09-04T03:00:00.000Z"
  };
  return {
    aggregateProof,
    repositoryObservations: [repositoryObservation],
    ownerAttestations: [{ attestation, custodyReceipt: custodyRecord(attestation, "8").receipt }],
    findings: { p0: [], p1: [], p2: ["Task30 audit pending"] },
    producedAt: "2026-09-03T03:20:00.000Z"
  };
}

test("derives S1 exit checkpoint only after the aggregate digest exists", () => {
  const input = validInput();
  const result = generateS1ExitEvidence(input);
  assert.equal(result.aggregateProofDigest, sha256Canonical(input.aggregateProof));
  assert.equal(result.sourceSha, input.aggregateProof.sourceSha);
  assert.equal(result.terminalStatus, "CHECKPOINT_EVIDENCED");
  assert.equal(
    result.controls.every(({ status }) => status !== "PASSED"),
    true
  );
});

for (const [name, mutate, code] of [
  [
    "caller supplied aggregate digest",
    (input) => (input.aggregateProofDigest = sha256Canonical(input.aggregateProof)),
    "S1_EXIT_PREBUILT_IDENTITY_FORBIDDEN"
  ],
  [
    "complete prebuilt exit evidence",
    (input) => (input.s1ExitEvidence = { schemaVersion: "s1-exit-evidence.v1" }),
    "S1_EXIT_PREBUILT_EVIDENCE_FORBIDDEN"
  ],
  [
    "repository observation from another SHA",
    (input) => (input.repositoryObservations[0].sourceSha = "b".repeat(40)),
    "S1_EXIT_REPOSITORY_OBSERVATION_MISMATCH"
  ],
  [
    "owner attestation from another subject",
    (input) => (input.ownerAttestations[0].attestation.subject.sourceSha = "b".repeat(40)),
    "S1_EXIT_OWNER_ATTESTATION_MISMATCH"
  ],
  [
    "expired owner attestation",
    (input) => (input.ownerAttestations[0].attestation.notAfter = "2026-09-03T03:19:59.000Z"),
    "S1_EXIT_OWNER_ATTESTATION_EXPIRED"
  ],
  [
    "owner custody digest mismatch",
    (input) =>
      (input.ownerAttestations[0].custodyReceipt.contentDigest =
        input.aggregateProof.buildProofDigest),
    "S1_EXIT_OWNER_ATTESTATION_CUSTODY_INVALID"
  ],
  [
    "owner claims aggregate passed",
    (input) =>
      input.ownerAttestations[0].attestation.facts.push({
        factId: "final-gate-status",
        value: "PASSED"
      }),
    "S1_EXIT_OWNER_ATTESTATION_SCOPE_FORBIDDEN"
  ],
  [
    "evidenced observation without evidence",
    (input) => (input.repositoryObservations[0].evidenceDigests = []),
    "S1_EXIT_CONTROL_EVIDENCE_MISSING"
  ]
]) {
  test(`rejects ${name}`, () => {
    const input = structuredClone(validInput());
    mutate(input);
    assert.throws(() => generateS1ExitEvidence(input), { code });
  });
}
