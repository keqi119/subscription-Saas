import assert from "node:assert/strict";
import test from "node:test";

import { compileAllSchemas, validateContract } from "../src/index.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);

function validBuildProof() {
  const image = (name) => ({
    name,
    registry: "ghcr.io/keqi119",
    platform: "linux/amd64",
    imageDigest: digest,
    sourceRevision: sourceSha
  });
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      images: {
        api: image("api"),
        web: image("web"),
        runner: image("runner")
      },
      sourceSha,
      migrationCatalogDigest: digest,
      repositoryContractDigest: digest
    },
    provenance: {
      generatedAt: "2026-09-02T08:00:00.000Z",
      ciRunRef: "github-actions:run/123",
      attestationRef: "attestation:sha256:abc",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest }],
      materials: [{ name: "pnpm", reference: "pnpm@11.4.0" }],
      registryResolutionEvidenceDigest: digest
    }
  };
}

test("compiles every registered release Schema", () => {
  const result = compileAllSchemas();
  assert.equal(result.schemaIds.length, 10);
  assert.ok(result.schemaIds.includes("build-proof.v1"));
  assert.ok(result.schemaIds.includes("controlled-target-record.v1"));
});

test("accepts a strict build proof", () => {
  assert.doesNotThrow(() => validateContract("build-proof.v1", validBuildProof()));
});

test("rejects an unregistered Schema version", () => {
  assert.throws(() => validateContract("build-proof.v2", validBuildProof()), {
    code: "CONTRACT_SCHEMA_UNREGISTERED"
  });
});

test("rejects additional proof properties", () => {
  const proof = validBuildProof();
  proof.untrusted = true;
  assert.throws(() => validateContract("build-proof.v1", proof), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("rejects non-lowercase SHA-256 values", () => {
  const proof = validBuildProof();
  proof.identity.repositoryContractDigest = `sha256:${"A".repeat(64)}`;
  assert.throws(() => validateContract("build-proof.v1", proof), {
    code: "CONTRACT_SCHEMA_INVALID"
  });
});

test("validates the Task 0 PostgreSQL image contract", () => {
  assert.doesNotThrow(() =>
    validateContract("postgres-image.v1", {
      contractVersion: "postgres-image.v1",
      repository: "docker.io/library/postgres",
      tag: "17-bookworm",
      platform: "linux/amd64",
      resolvedDigest: digest,
      serverVersionMajor: 17
    })
  );
});
