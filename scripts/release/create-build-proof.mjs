#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  sha256Canonical,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const sourceShaPattern = /^[0-9a-f]{40}$/u;
const requiredImageNames = Object.freeze(["api", "runner", "web"]);

function proofError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonicalClone(value) {
  return JSON.parse(canonicalJson(value));
}

function digestOf(value, code) {
  const candidate = typeof value === "string" ? value : value?.digest;
  if (!digestPattern.test(candidate ?? "")) throw proofError(code);
  return candidate;
}

function assertRepositoryIdentity(image) {
  if (typeof image !== "string" || image.length === 0 || image.includes("@")) {
    throw proofError("BUILD_PROOF_TAG_IDENTITY_FORBIDDEN");
  }
  const finalSegment = image.slice(image.lastIndexOf("/") + 1);
  if (finalSegment.includes(":")) throw proofError("BUILD_PROOF_TAG_IDENTITY_FORBIDDEN");
}

function normalizeImages(images, sourceSha) {
  if (!sourceShaPattern.test(sourceSha ?? "") || !Array.isArray(images)) {
    throw proofError("BUILD_PROOF_MIXED_SOURCE");
  }
  const observedNames = images.map(({ name }) => name).sort();
  if (
    images.length !== requiredImageNames.length ||
    new Set(observedNames).size !== requiredImageNames.length ||
    observedNames.some((name, index) => name !== requiredImageNames[index])
  ) {
    throw proofError("BUILD_PROOF_PARTIAL_BUNDLE", { observedNames });
  }
  const normalized = {};
  for (const image of images) {
    assertRepositoryIdentity(image.image);
    if (
      image.platform !== "linux/amd64" ||
      image.sourceRevision !== sourceSha ||
      !digestPattern.test(image.digest ?? "")
    ) {
      throw proofError("BUILD_PROOF_MIXED_SOURCE", { image: image.name });
    }
    if (image.registrySubject !== `${image.image}@${image.digest}`) {
      throw proofError("BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH", { image: image.name });
    }
    normalized[image.name] = {
      name: image.name,
      registry: image.image,
      platform: image.platform,
      imageDigest: image.digest,
      sourceRevision: image.sourceRevision
    };
  }
  return normalized;
}

function buildBaseImages(images) {
  const unique = new Map();
  for (const image of images) {
    for (const base of image.baseImageDigests ?? []) {
      if (!digestPattern.test(base?.digest ?? "") || typeof base?.image !== "string") {
        throw proofError("BUILD_PROOF_BASE_IMAGE_INVALID", { image: image.name });
      }
      const existing = unique.get(base.image);
      if (existing && existing !== base.digest) {
        throw proofError("BUILD_PROOF_BASE_IMAGE_INVALID", { baseImage: base.image });
      }
      unique.set(base.image, base.digest);
    }
  }
  if (unique.size === 0) throw proofError("BUILD_PROOF_BASE_IMAGE_INVALID");
  return [...unique]
    .map(([name, resolvedDigest]) => ({ name, resolvedDigest }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildMaterials(observation) {
  const materials = [
    {
      name: "build-material-observation",
      reference: sha256Canonical(observation)
    },
    { name: "builder", reference: observation.builder.provenanceRef },
    ...observation.externalActions.map(({ name, commitSha }) => ({
      name: `action:${name}`,
      reference: commitSha
    })),
    ...observation.images.map(({ name, buildAttestationRef }) => ({
      name: `attestation:${name}`,
      reference: buildAttestationRef
    }))
  ];
  return materials.sort((left, right) =>
    left.name === right.name
      ? left.reference.localeCompare(right.reference)
      : left.name.localeCompare(right.name)
  );
}

export function createBuildProof({
  sourceSha,
  images,
  migrationCatalog,
  repositoryContract,
  provenance
}) {
  const normalizedImages = normalizeImages(images, sourceSha);
  const observation = provenance?.buildMaterialObservation;
  try {
    validateContract("build-material-observation.v1", observation);
  } catch (error) {
    throw proofError("BUILD_PROOF_MATERIAL_OBSERVATION_INVALID", { cause: error?.code });
  }
  if (
    observation.sourceSha !== sourceSha ||
    observation.checkoutRef !== sourceSha ||
    observation.ciRunRef !== provenance.ciRunRef ||
    provenance.checkoutRef !== sourceSha ||
    provenance.attestationRef !== observation.builder.provenanceRef ||
    sha256Canonical(images) !== sha256Canonical(observation.images)
  ) {
    throw proofError("BUILD_PROOF_MIXED_SOURCE");
  }
  const migrationCatalogDigest = digestOf(
    migrationCatalog,
    "BUILD_PROOF_MIGRATION_CATALOG_INVALID"
  );
  const repositoryContractDigest = digestOf(
    repositoryContract,
    "BUILD_PROOF_REPOSITORY_CONTRACT_INVALID"
  );
  if (
    migrationCatalogDigest !== observation.migrationCatalogDigest ||
    repositoryContractDigest !== observation.repositoryContractDigest
  ) {
    throw proofError("BUILD_PROOF_CONTRACT_DIGEST_MISMATCH");
  }
  if (
    Number.isNaN(Date.parse(provenance.generatedAt)) ||
    !String(provenance.generatedAt).endsWith("Z") ||
    Date.parse(provenance.generatedAt) < Date.parse(observation.observedAt)
  ) {
    throw proofError("BUILD_PROOF_GENERATED_AT_INVALID");
  }

  const proof = {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: normalizedImages,
      sourceSha,
      migrationCatalogDigest,
      repositoryContractDigest
    },
    provenance: {
      generatedAt: provenance.generatedAt,
      ciRunRef: provenance.ciRunRef,
      attestationRef: provenance.attestationRef,
      checkoutRef: provenance.checkoutRef,
      baseImages: buildBaseImages(images),
      materials: buildMaterials(observation),
      registryResolutionEvidenceDigest: sha256Canonical(observation)
    }
  };
  try {
    validateContract("build-proof.v1", proof);
  } catch (error) {
    throw proofError("BUILD_PROOF_CONTRACT_INVALID", { cause: error?.code });
  }
  return deepFreeze(canonicalClone(proof));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const observationPath = argument("--observation");
  const outputPath = argument("--output");
  const generatedAt = argument("--generated-at");
  if (!observationPath || !outputPath || !generatedAt) {
    throw proofError("BUILD_PROOF_ARGUMENT_REQUIRED");
  }
  const observation = JSON.parse(await readFile(path.resolve(observationPath), "utf8"));
  const proof = createBuildProof({
    sourceSha: observation.sourceSha,
    images: observation.images,
    migrationCatalog: { digest: observation.migrationCatalogDigest },
    repositoryContract: { digest: observation.repositoryContractDigest },
    provenance: {
      generatedAt,
      ciRunRef: observation.ciRunRef,
      attestationRef: observation.builder.provenanceRef,
      checkoutRef: observation.checkoutRef,
      buildMaterialObservation: observation
    }
  });
  await writeFile(path.resolve(outputPath), canonicalJson(proof), { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ buildProofDigest: sha256Canonical(proof) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "BUILD_PROOF_CREATE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
