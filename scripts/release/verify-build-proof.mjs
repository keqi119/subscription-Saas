#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCustodyComplete,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";
import { validateBuildWebClient } from "./verify-build-materials.mjs";

const allowedExecutionScopes = new Set(["full-rc", "migration-schema"]);
const legacyCustodyPolicyKeys = Object.freeze([
  "owner",
  "readers",
  "retentionDays",
  "expiryDisposition"
]);
const retention90CustodyPolicyKeys = Object.freeze([...legacyCustodyPolicyKeys, "receiptContract"]);

function proofError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactDataProperties(value, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string" && expectedKeys.includes(key)) &&
    expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}

function validateArtifact(schemaId, value, code) {
  try {
    validateContract(schemaId, value);
  } catch (error) {
    throw proofError(code, { cause: error?.code });
  }
}

export function assertBuildIdentity(input) {
  const { proof, buildMaterialObservation } = input;
  validateArtifact("build-proof.v1", proof, "BUILD_PROOF_CONTRACT_INVALID");
  validateArtifact(
    "build-material-observation.v1",
    buildMaterialObservation,
    "BUILD_PROOF_MATERIAL_OBSERVATION_INVALID"
  );
  const observation = buildMaterialObservation;
  if (
    proof.identity.sourceSha !== observation.sourceSha ||
    proof.identity.sourceSha !== observation.checkoutRef ||
    proof.identity.migrationCatalogDigest !== observation.migrationCatalogDigest ||
    proof.identity.repositoryContractDigest !== observation.repositoryContractDigest ||
    proof.provenance.checkoutRef !== observation.checkoutRef ||
    proof.provenance.ciRunRef !== observation.ciRunRef ||
    proof.provenance.registryResolutionEvidenceDigest !== sha256Canonical(observation)
  ) {
    throw proofError("BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH");
  }
  if (
    proof.provenance.attestationRef !== observation.builder.provenanceRef ||
    Date.parse(proof.provenance.generatedAt) < Date.parse(observation.observedAt)
  ) {
    throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
  }
  const materialReference = proof.provenance.materials.find(
    ({ name }) => name === "build-material-observation"
  );
  if (materialReference?.reference !== sha256Canonical(observation)) {
    throw proofError("BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH");
  }
  const webMaterials = proof.provenance.materials.filter(
    ({ name }) => name === "web-public-api-base"
  );
  if (Object.hasOwn(observation, "webClient")) {
    const webClient = validateBuildWebClient(observation.webClient, observation.images);
    if (webMaterials.length !== 1 || webMaterials[0].reference !== webClient.apiBaseUrl)
      throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
  } else if (webMaterials.length !== 0) {
    throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
  }
  for (const name of ["api", "web", "runner"]) {
    const expected = proof.identity.images[name];
    const observed = observation.images.find((image) => image.name === name);
    const finalSegment = expected.registry.slice(expected.registry.lastIndexOf("/") + 1);
    if (
      !observed ||
      expected.registry.includes("@") ||
      finalSegment.includes(":") ||
      expected.registry !== observed.image ||
      expected.imageDigest !== observed.digest ||
      expected.platform !== observed.platform ||
      expected.sourceRevision !== observed.sourceRevision ||
      observed.registrySubject !== `${expected.registry}@${expected.imageDigest}`
    ) {
      throw proofError("BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH", { image: name });
    }
  }
  const expectedBaseImages = new Map();
  for (const image of observation.images) {
    for (const base of image.baseImageDigests) {
      const prior = expectedBaseImages.get(base.image);
      if (prior && prior !== base.digest) throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
      expectedBaseImages.set(base.image, base.digest);
    }
  }
  const normalizedExpectedBases = [...expectedBaseImages]
    .map(([name, resolvedDigest]) => ({ name, resolvedDigest }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (sha256Canonical(proof.provenance.baseImages) !== sha256Canonical(normalizedExpectedBases)) {
    throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
  }
  const proofMaterials = new Map(
    proof.provenance.materials.map(({ name, reference }) => [`${name}\u0000${reference}`, true])
  );
  const requiredMaterials = [
    ["builder", observation.builder.provenanceRef],
    ...observation.externalActions.map(({ name, commitSha }) => [`action:${name}`, commitSha]),
    ...observation.images.map(({ name, buildAttestationRef }) => [
      `attestation:${name}`,
      buildAttestationRef
    ])
  ];
  if (
    requiredMaterials.some(([name, reference]) => !proofMaterials.has(`${name}\u0000${reference}`))
  ) {
    throw proofError("BUILD_PROOF_PROVENANCE_MISMATCH");
  }
}

// Historical proofs remain readable, but cannot supply a missing application
// endpoint. This check is not a substitute for attestation/custody admission.
export function assertBuildWebClient(input) {
  assertBuildIdentity(input);
  if (!Object.hasOwn(input.buildMaterialObservation, "webClient"))
    throw proofError("BUILD_WEB_CLIENT_REQUIRED");
  return validateBuildWebClient(
    input.buildMaterialObservation.webClient,
    input.buildMaterialObservation.images
  );
}

function assertTrustedAttestation({ proofDigest, proof, trustRoot, verifiedAttestation }) {
  if (
    typeof trustRoot?.issuer !== "string" ||
    trustRoot.issuer.length === 0 ||
    verifiedAttestation?.issuer !== trustRoot.issuer
  ) {
    throw proofError("BUILD_PROOF_UNTRUSTED_ISSUER");
  }
  if (
    verifiedAttestation?.verificationPolicy !== "github-artifact-attestation/v1" ||
    verifiedAttestation?.verifier !== "gh-attestation-verify" ||
    verifiedAttestation?.subjectDigest !== proofDigest ||
    verifiedAttestation?.sourceSha !== proof.identity.sourceSha ||
    verifiedAttestation?.repository !== trustRoot.repository ||
    verifiedAttestation?.workflowPath !== trustRoot.workflowPath ||
    verifiedAttestation?.workflowRef !== trustRoot.workflowRef ||
    verifiedAttestation?.protectedEnvironment !== trustRoot.protectedEnvironment ||
    verifiedAttestation?.runAttempt !== trustRoot.runAttempt ||
    verifiedAttestation.runAttempt !== 1 ||
    typeof verifiedAttestation.workflowRunId !== "string" ||
    !proof.provenance.ciRunRef.endsWith(`/runs/${verifiedAttestation.workflowRunId}`) ||
    typeof verifiedAttestation.verificationEvidenceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(verifiedAttestation.verificationEvidenceDigest) ||
    typeof verifiedAttestation.attestationRef !== "string" ||
    verifiedAttestation.attestationRef.length === 0
  ) {
    throw proofError("BUILD_PROOF_ATTESTATION_UNTRUSTED");
  }
}

export function assertProofCustody({
  proofDigest,
  custodyReceipt,
  trustRoot,
  verifiedAttestation
}) {
  const policy = trustRoot?.custody;
  const legacyPolicy = hasExactDataProperties(policy, legacyCustodyPolicyKeys);
  const retention90Policy =
    hasExactDataProperties(policy, retention90CustodyPolicyKeys) &&
    policy.receiptContract === "custody-receipt.retention90.v1";
  if (!legacyPolicy && !retention90Policy) {
    throw proofError("BUILD_PROOF_CUSTODY_INVALID");
  }
  const receiptContract = retention90Policy
    ? "custody-receipt.retention90.v1"
    : "custody-receipt.v1";
  try {
    assertCustodyComplete(custodyReceipt, proofDigest, { receiptContract });
  } catch (error) {
    throw proofError("BUILD_PROOF_CUSTODY_INVALID", { cause: error?.code });
  }
  if (
    custodyReceipt.owner !== policy?.owner ||
    !sameArray(custodyReceipt.readers, policy?.readers) ||
    policy?.retentionDays !== (retention90Policy ? 90 : 180) ||
    custodyReceipt.expiryDisposition !== policy?.expiryDisposition ||
    custodyReceipt.attestationRef !== verifiedAttestation.attestationRef
  ) {
    throw proofError("BUILD_PROOF_CUSTODY_INVALID");
  }
}

export function verifyBuildProof({
  proof,
  buildMaterialObservation,
  executionScope,
  trustRoot,
  verifiedAttestation,
  custodyReceipt
}) {
  validateArtifact("build-proof.v1", proof, "BUILD_PROOF_CONTRACT_INVALID");
  validateArtifact(
    "build-material-observation.v1",
    buildMaterialObservation,
    "BUILD_PROOF_MATERIAL_OBSERVATION_INVALID"
  );
  if (!allowedExecutionScopes.has(executionScope)) {
    throw proofError("BUILD_PROOF_EXECUTION_SCOPE_INVALID");
  }
  assertBuildIdentity({ proof, buildMaterialObservation });
  const proofDigest = sha256Canonical(proof);
  assertTrustedAttestation({ proofDigest, proof, trustRoot, verifiedAttestation });
  if (
    !hasExactDataProperties(trustRoot?.custody, legacyCustodyPolicyKeys) ||
    custodyReceipt?.schemaVersion !== "custody-receipt.v1"
  ) {
    throw proofError("BUILD_PROOF_CUSTODY_INVALID");
  }
  assertProofCustody({ proofDigest, custodyReceipt, trustRoot, verifiedAttestation });
  return Object.freeze({
    status: "verified",
    buildProofDigest: proofDigest,
    executionScope,
    promotionEligible: executionScope === "full-rc",
    completeBundle: true,
    images: Object.freeze(
      Object.fromEntries(
        Object.entries(proof.identity.images).map(([name, image]) => [
          name,
          `${image.registry}@${image.imageDigest}`
        ])
      )
    )
  });
}

export function verifyBuildProofFixture(proof) {
  validateArtifact("build-proof.v1", proof, "BUILD_PROOF_CONTRACT_INVALID");
  for (const name of ["api", "web", "runner"]) {
    const image = proof.identity.images[name];
    const finalSegment = image.registry.slice(image.registry.lastIndexOf("/") + 1);
    if (
      image.registry.includes("@") ||
      finalSegment.includes(":") ||
      image.sourceRevision !== proof.identity.sourceSha
    ) {
      throw proofError("BUILD_PROOF_FIXTURE_IDENTITY_INVALID", { image: name });
    }
  }
  if (proof.provenance.checkoutRef !== proof.identity.sourceSha) {
    throw proofError("BUILD_PROOF_FIXTURE_IDENTITY_INVALID");
  }
  return Object.freeze({
    status: "fixture-verified",
    buildProofDigest: sha256Canonical(proof),
    promotionEligible: false
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const fixturePath = argument("--fixture");
  if (fixturePath) {
    const proof = JSON.parse(await readFile(path.resolve(fixturePath), "utf8"));
    process.stdout.write(`${JSON.stringify(verifyBuildProofFixture(proof))}\n`);
    return;
  }
  const inputPath = argument("--input");
  if (!inputPath) throw proofError("BUILD_PROOF_VERIFY_INPUT_REQUIRED");
  const input = JSON.parse(await readFile(path.resolve(inputPath), "utf8"));
  process.stdout.write(`${JSON.stringify(verifyBuildProof(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "BUILD_PROOF_VERIFY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
