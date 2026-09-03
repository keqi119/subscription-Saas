import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { verifyBuildProof } from "./verify-build-proof.mjs";

const sourceSha = "1".repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const generatedAt = "2026-09-02T16:00:00.000Z";
const ciRunRef = "github://keqi119/subscription-Saas/actions/runs/2801";

function image(name, character) {
  const repository = `ghcr.io/keqi119/subscription-${name}`;
  const imageDigest = digest(character);
  return {
    name,
    image: repository,
    platform: "linux/amd64",
    digest: imageDigest,
    sourceRevision: sourceSha,
    baseImageDigests: [
      {
        image: "node:22-bookworm-slim",
        declaredDigest: digest("a"),
        digest: digest("b")
      }
    ],
    builderName: "https://mobyproject.org/buildkit@v1",
    buildAttestationRef: `oci://${repository}@${imageDigest}#provenance=${digest("c")}`,
    registrySubject: `${repository}@${imageDigest}`,
    buildRunRef: ciRunRef
  };
}

function observation() {
  return {
    schemaVersion: "build-material-observation.v1",
    sourceSha,
    checkoutRef: sourceSha,
    ciRunRef,
    repositoryContractDigest: digest("d"),
    migrationCatalogDigest: digest("e"),
    policyDigest: digest("f"),
    promotionEligibility: "trusted-candidate",
    images: [image("api", "1"), image("web", "2"), image("runner", "3")],
    externalActions: [
      { name: "actions/checkout", commitSha: "2".repeat(40) },
      { name: "docker/build-push-action", commitSha: "3".repeat(40) }
    ],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("4")}`
    },
    observedAt: generatedAt
  };
}

function createValidProof(buildObservation = observation()) {
  return createBuildProof({
    sourceSha,
    images: buildObservation.images,
    migrationCatalog: { digest: buildObservation.migrationCatalogDigest },
    repositoryContract: { digest: buildObservation.repositoryContractDigest },
    provenance: {
      generatedAt,
      ciRunRef,
      attestationRef: buildObservation.builder.provenanceRef,
      checkoutRef: buildObservation.checkoutRef,
      buildMaterialObservation: buildObservation
    }
  });
}

function trustFixture(proof, buildObservation = observation(), executionScope = "full-rc") {
  const proofDigest = sha256Canonical(proof);
  const attestationRef = "https://github.com/keqi119/subscription-Saas/attestations/2801";
  return {
    proof,
    buildMaterialObservation: buildObservation,
    executionScope,
    trustRoot: {
      issuer: "https://token.actions.githubusercontent.com",
      repository: "keqi119/subscription-Saas",
      workflowPath: ".github/workflows/docker-images.yml",
      workflowRef: "refs/heads/main",
      protectedEnvironment: "trusted-image-build",
      runAttempt: 1,
      custody: {
        owner: "release-engineering",
        readers: ["release", "qa", "security", "audit"],
        retentionDays: 180,
        expiryDisposition: "review"
      }
    },
    verifiedAttestation: {
      subjectDigest: proofDigest,
      sourceSha,
      issuer: "https://token.actions.githubusercontent.com",
      repository: "keqi119/subscription-Saas",
      workflowPath: ".github/workflows/docker-images.yml",
      workflowRef: "refs/heads/main",
      workflowRunId: "2801",
      runAttempt: 1,
      protectedEnvironment: "trusted-image-build",
      attestationRef,
      verifier: "gh-attestation-verify",
      verificationPolicy: "github-artifact-attestation/v1",
      verificationEvidenceDigest: digest("7")
    },
    custodyReceipt: {
      schemaVersion: "custody-receipt.v1",
      receiptId: "3ba3126f-f212-455b-b308-2f1d11f73b31",
      contentDigest: proofDigest,
      contentSizeBytes: 2048,
      storeRef: `artifact://release/evidence/${proofDigest.slice("sha256:".length)}.json`,
      uploadedAt: generatedAt,
      readbackAt: "2026-09-02T16:00:01.000Z",
      readbackDigest: proofDigest,
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retainUntil: "2027-03-01T16:00:00.000Z",
      expiryDisposition: "review",
      attestationRef
    }
  };
}

test("creates and verifies one immutable three-image build proof", () => {
  const buildObservation = observation();
  const proof = createValidProof(buildObservation);
  const decision = verifyBuildProof(trustFixture(proof, buildObservation));
  assert.equal(proof.schemaVersion, "build-proof.v1");
  assert.equal(decision.status, "verified");
  assert.equal(decision.promotionEligible, true);
  assert.equal(decision.buildProofDigest, sha256Canonical(proof));
});

test("BUILD_PROOF_TAG_IDENTITY_FORBIDDEN rejects tag-based image identity", () => {
  const buildObservation = observation();
  buildObservation.images[0].image += ":candidate";
  assert.throws(() => createValidProof(buildObservation), {
    code: "BUILD_PROOF_TAG_IDENTITY_FORBIDDEN"
  });
});

test("BUILD_PROOF_MIXED_SOURCE rejects images from another checkout", () => {
  const buildObservation = observation();
  buildObservation.images[1].sourceRevision = "9".repeat(40);
  assert.throws(() => createValidProof(buildObservation), { code: "BUILD_PROOF_MIXED_SOURCE" });
});

test("BUILD_PROOF_PARTIAL_BUNDLE rejects a missing image", () => {
  const buildObservation = observation();
  buildObservation.images.pop();
  assert.throws(() => createValidProof(buildObservation), { code: "BUILD_PROOF_PARTIAL_BUNDLE" });
});

test("BUILD_PROOF_UNTRUSTED_ISSUER rejects an untrusted proof attestation", () => {
  const buildObservation = observation();
  const proof = createValidProof(buildObservation);
  const input = trustFixture(proof, buildObservation);
  input.verifiedAttestation.issuer = "https://untrusted.example";
  assert.throws(() => verifyBuildProof(input), { code: "BUILD_PROOF_UNTRUSTED_ISSUER" });
});

test("BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH rejects observation drift", () => {
  const buildObservation = observation();
  const proof = createValidProof(buildObservation);
  const input = trustFixture(proof, structuredClone(buildObservation));
  input.buildMaterialObservation.images[0].digest = digest("9");
  input.buildMaterialObservation.images[0].registrySubject = `${input.buildMaterialObservation.images[0].image}@${digest("9")}`;
  assert.throws(() => verifyBuildProof(input), {
    code: "BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH"
  });
});

test("migration-schema scope cites the complete bundle but is not promotable", () => {
  const buildObservation = observation();
  const proof = createValidProof(buildObservation);
  const decision = verifyBuildProof(trustFixture(proof, buildObservation, "migration-schema"));
  assert.deepEqual(Object.keys(proof.identity.images).sort(), ["api", "runner", "web"]);
  assert.equal(decision.promotionEligible, false);
  assert.equal(decision.executionScope, "migration-schema");
});

test("rejects a custody receipt that does not bind the proof digest", () => {
  const buildObservation = observation();
  const proof = createValidProof(buildObservation);
  const input = trustFixture(proof, buildObservation);
  input.custodyReceipt.contentDigest = digest("0");
  assert.throws(() => verifyBuildProof(input), { code: "BUILD_PROOF_CUSTODY_INVALID" });
});

test("protected aggregation is the only proof issuer and uses immutable custody", () => {
  const workflow = readFileSync(".github/workflows/docker-images.yml", "utf8");
  const registry = JSON.parse(readFileSync("release/contracts/command-registry.v1.json", "utf8"));
  assert.equal(workflow.match(/create-build-proof\.mjs/gu)?.length, 1);
  assert.match(workflow, /observe-build-materials:[\s\S]*environment: trusted-image-build/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /--source-digest/u);
  assert.equal(workflow.match(/retention-days: 180/gu)?.length, 3);
  assert.equal(workflow.match(/overwrite: false/gu)?.length, 3);
  assert.equal(
    registry.commands.some(({ commandId }) => /build[.-]proof/iu.test(commandId)),
    false
  );
});
