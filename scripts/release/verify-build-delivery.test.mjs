import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  computeRepositoryContract,
  sha256Canonical
} from "../../packages/release-foundation/src/index.mjs";
import { createBuildProof } from "./create-build-proof.mjs";
import { assertProofCustody, verifyBuildProof } from "./verify-build-proof.mjs";
import { verifyBuildDelivery } from "./verify-build-delivery.mjs";

const script = fileURLToPath(new URL("./verify-build-delivery.mjs", import.meta.url));
const repository = "keqi119/subscription-Saas";
const workflowRunId = "2801";
const runAttempt = 1;
const sourceSha = "1".repeat(40);
const materialObservedAt = "2026-09-01T00:00:00.000Z";
const generatedAt = "2026-09-01T00:00:01.000Z";
const deliveryObservedAt = "2026-09-03T00:00:00.000Z";
const createdAt = "2026-09-02T00:00:00Z";
const exact90ExpiresAt = "2026-12-01T00:00:00Z";
const proofArtifactId = "9001";
const evidenceArtifactId = "9002";
const digest = (character) => `sha256:${character.repeat(64)}`;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function image(name, character, fixtureSourceSha, ciRunRef) {
  const imageRepository = `ghcr.io/keqi119/subscription-${name}`;
  const imageDigest = digest(character);
  return {
    name,
    image: imageRepository,
    platform: "linux/amd64",
    digest: imageDigest,
    sourceRevision: fixtureSourceSha,
    baseImageDigests: [
      {
        image: "node:22-bookworm-slim",
        declaredDigest: digest("a"),
        digest: digest("b")
      }
    ],
    builderName: "https://mobyproject.org/buildkit@v1",
    buildAttestationRef: `oci://${imageRepository}@${imageDigest}#provenance=${digest("c")}`,
    registrySubject: `${imageRepository}@${imageDigest}`,
    buildRunRef: ciRunRef
  };
}

function buildIdentity({
  fixtureRepository = repository,
  fixtureRunId = workflowRunId,
  fixtureSourceSha = sourceSha,
  fixtureRunRefFormat = "legacy"
} = {}) {
  const ciRunRef =
    fixtureRunRefFormat === "https"
      ? `https://github.com/${fixtureRepository}/actions/runs/${fixtureRunId}`
      : `github://${fixtureRepository}/actions/runs/${fixtureRunId}`;
  const observation = {
    schemaVersion: "build-material-observation.v1",
    sourceSha: fixtureSourceSha,
    checkoutRef: fixtureSourceSha,
    ciRunRef,
    repositoryContractDigest: digest("d"),
    migrationCatalogDigest: digest("e"),
    policyDigest: digest("f"),
    promotionEligibility: "trusted-candidate",
    images: [
      image("api", "1", fixtureSourceSha, ciRunRef),
      image("web", "2", fixtureSourceSha, ciRunRef),
      image("runner", "3", fixtureSourceSha, ciRunRef)
    ],
    externalActions: [
      { name: "actions/checkout", commitSha: "2".repeat(40) },
      { name: "docker/build-push-action", commitSha: "3".repeat(40) }
    ],
    builder: {
      name: "https://mobyproject.org/buildkit@v1",
      provenanceRef: `build-material-attestations:${digest("4")}`
    },
    observedAt: materialObservedAt
  };
  const proof = createBuildProof({
    sourceSha: fixtureSourceSha,
    images: observation.images,
    migrationCatalog: { digest: observation.migrationCatalogDigest },
    repositoryContract: { digest: observation.repositoryContractDigest },
    provenance: {
      generatedAt,
      ciRunRef,
      attestationRef: observation.builder.provenanceRef,
      checkoutRef: observation.checkoutRef,
      buildMaterialObservation: observation
    }
  });
  return { observation, proof };
}

function artifactMetadata({
  artifactId,
  name,
  fixtureCreatedAt = createdAt,
  fixtureExpiresAt = exact90ExpiresAt,
  expired = false,
  fixtureRepository = repository,
  fixtureRunId = workflowRunId,
  fixtureSourceSha = sourceSha
}) {
  const apiRoot = `https://api.github.com/repos/${fixtureRepository}/actions/artifacts/${artifactId}`;
  return Buffer.from(
    `${JSON.stringify(
      {
        id: Number(artifactId),
        node_id: `synthetic-artifact-${artifactId}`,
        name,
        size_in_bytes: 1234,
        url: apiRoot,
        archive_download_url: `${apiRoot}/zip`,
        expired,
        created_at: fixtureCreatedAt,
        expires_at: fixtureExpiresAt,
        updated_at: fixtureCreatedAt,
        workflow_run: {
          id: Number(fixtureRunId),
          repository_id: 100,
          head_repository_id: 100,
          head_branch: "main",
          head_sha: fixtureSourceSha
        }
      },
      null,
      2
    )}\n`
  );
}

function file(pathname, bytes) {
  return { path: pathname, bytes };
}

function deliveryFixture({
  fixtureCreatedAt = createdAt,
  fixtureExpiresAt = exact90ExpiresAt,
  fixtureRepository = repository,
  fixtureRunId = workflowRunId,
  fixtureSourceSha = sourceSha,
  fixtureRunRefFormat = "legacy"
} = {}) {
  const { observation, proof } = buildIdentity({
    fixtureRepository,
    fixtureRunId,
    fixtureSourceSha,
    fixtureRunRefFormat
  });
  const buildProofDigest = sha256Canonical(proof);
  const digestHex = buildProofDigest.slice("sha256:".length);
  const proofBytes = Buffer.from(canonicalJson(proof));
  // This is the actual verify-build-materials producer shape; the final LF is intentional.
  const observationBytes = Buffer.from(`${canonicalJson(observation)}\n`);
  // gh attestation evidence is a raw JSON array and is intentionally not canonicalized.
  const attestationBytes = Buffer.from('[\n  { "verificationResult": "synthetic-only" }\n]\n');
  const proofName = `build-proof-${digestHex}`;
  const evidenceName = `build-proof-evidence-${digestHex}`;
  const proofMetadataBytes = artifactMetadata({
    artifactId: proofArtifactId,
    name: proofName,
    fixtureCreatedAt,
    fixtureExpiresAt,
    fixtureRepository,
    fixtureRunId,
    fixtureSourceSha
  });
  const evidenceMetadataBytes = artifactMetadata({
    artifactId: evidenceArtifactId,
    name: evidenceName,
    fixtureCreatedAt,
    fixtureExpiresAt,
    fixtureRepository,
    fixtureRunId,
    fixtureSourceSha
  });
  return {
    expected: {
      repository,
      workflowRunId,
      runAttempt,
      sourceSha,
      buildProofDigest
    },
    entries: [
      {
        kind: "proof",
        artifactId: proofArtifactId,
        name: proofName,
        metadataBytes: proofMetadataBytes,
        originalFiles: [file("build-proof.v1.json", proofBytes)],
        readbackFiles: [file("build-proof.v1.json", Buffer.from(proofBytes))]
      },
      {
        kind: "supporting-evidence",
        artifactId: evidenceArtifactId,
        name: evidenceName,
        metadataBytes: evidenceMetadataBytes,
        originalFiles: [
          file("build-material-observation.v1.json", observationBytes),
          file("build-proof-attestation-verification.json", attestationBytes)
        ],
        readbackFiles: [
          file("build-material-observation.v1.json", Buffer.from(observationBytes)),
          file("build-proof-attestation-verification.json", Buffer.from(attestationBytes))
        ]
      }
    ],
    observedAt: deliveryObservedAt
  };
}

function entry(input, kind) {
  return input.entries.find((candidate) => candidate.kind === kind);
}

function replaceMetadata(candidate, mutate) {
  const metadata = JSON.parse(candidate.metadataBytes);
  mutate(metadata);
  candidate.metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
}

function verify(input = deliveryFixture()) {
  return verifyBuildDelivery(input);
}

function replaceRunReferences(input, proofRunRef, materialRunRef = proofRunRef) {
  const proof = JSON.parse(entry(input, "proof").originalFiles[0].bytes);
  proof.provenance.ciRunRef = proofRunRef;
  const proofBytes = Buffer.from(canonicalJson(proof));
  entry(input, "proof").originalFiles[0].bytes = proofBytes;
  entry(input, "proof").readbackFiles[0].bytes = Buffer.from(proofBytes);
  input.expected.buildProofDigest = sha256Canonical(proof);

  const supporting = entry(input, "supporting-evidence");
  const observation = JSON.parse(supporting.originalFiles[0].bytes);
  observation.ciRunRef = materialRunRef;
  for (const builtImage of observation.images) builtImage.buildRunRef = materialRunRef;
  const materialBytes = Buffer.from(`${canonicalJson(observation)}\n`);
  supporting.originalFiles[0].bytes = materialBytes;
  supporting.readbackFiles[0].bytes = Buffer.from(materialBytes);
  const updatedProof = JSON.parse(proofBytes);
  updatedProof.provenance.registryResolutionEvidenceDigest = sha256Canonical(observation);
  const materialReference = updatedProof.provenance.materials.find(
    ({ name }) => name === "build-material-observation"
  );
  materialReference.reference = sha256Canonical(observation);
  const updatedProofBytes = Buffer.from(canonicalJson(updatedProof));
  entry(input, "proof").originalFiles[0].bytes = updatedProofBytes;
  entry(input, "proof").readbackFiles[0].bytes = Buffer.from(updatedProofBytes);
  input.expected.buildProofDigest = sha256Canonical(updatedProof);
}

test("verifies exact producer/readback bytes at the 90-day boundary without promoting", () => {
  const input = deliveryFixture();
  const result = verify(input);
  assert.deepEqual(result, {
    status: "delivery-verified",
    buildProofDigest: input.expected.buildProofDigest,
    sourceSha,
    workflowRunId,
    runAttempt,
    promotionEligible: false,
    authorityCustody: "INPUT_REQUIRED",
    artifacts: input.entries.map((candidate) => {
      const metadata = JSON.parse(candidate.metadataBytes);
      return {
        artifactId: Number(candidate.artifactId),
        name: candidate.name,
        createdAt: metadata.created_at,
        expiresAt: metadata.expires_at,
        metadataDigest: hash(candidate.metadataBytes),
        files: candidate.originalFiles.map(({ path: pathname, bytes }) => ({
          path: pathname,
          rawDigest: hash(bytes),
          sizeBytes: bytes.length
        }))
      };
    })
  });
  assertDeepFrozen(result);
});

test("accepts the HTTPS workflow run reference without promoting", async () => {
  const input = deliveryFixture({ fixtureRunRefFormat: "https" });
  const result = verify(input);
  assert.equal(result.status, "delivery-verified");
  assert.equal(result.authorityCustody, "INPUT_REQUIRED");
  assert.equal(result.promotionEligible, false);
  const workflow = await readFile(".github/workflows/docker-images.yml", "utf8");
  const match = workflow.match(/BUILD_RUN_REF:\s*(.+)/u);
  assert.ok(match);
  const projected = match[1]
    .replaceAll("${{ github.repository }}", repository)
    .replaceAll("${{ github.run_id }}", workflowRunId);
  assert.equal(projected, `https://github.com/${repository}/actions/runs/${workflowRunId}`);
});

test("rejects mixed proof and material run-reference representations", () => {
  const input = deliveryFixture();
  replaceRunReferences(input, `https://github.com/${repository}/actions/runs/${workflowRunId}`);
  assert.throws(() => verify(input));
});

for (const runRef of [
  `http://github.com/${repository}/actions/runs/${workflowRunId}`,
  `https://example.com/${repository}/actions/runs/${workflowRunId}`,
  `https://github.com/other/repository/actions/runs/${workflowRunId}`,
  `https://github.com/${repository}/actions/runs/2802`,
  `https://github.com/${repository}/actions/runs/${workflowRunId}/extra`,
  `https://github.com/${repository}/actions/runs/${workflowRunId}?x=1`
]) {
  test(`rejects run reference ${runRef}`, () => {
    const input = deliveryFixture();
    replaceRunReferences(input, runRef);
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_RUN_MISMATCH" });
  });
}

test("accepts entry order changes but returns proof before supporting evidence", () => {
  const input = deliveryFixture();
  input.entries.reverse();
  const result = verify(input);
  assert.deepEqual(
    result.artifacts.map(({ name }) => name),
    [
      `build-proof-${input.expected.buildProofDigest.slice(7)}`,
      `build-proof-evidence-${input.expected.buildProofDigest.slice(7)}`
    ]
  );
});

test("preserves a longer service-observed expiration instead of truncating it", () => {
  const expiresAt = "2027-04-01T03:04:05.678Z";
  const result = verify(deliveryFixture({ fixtureExpiresAt: expiresAt }));
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.expiresAt),
    [expiresAt, expiresAt]
  );
});

test("delivery output cannot be used as a build promotion or custody input", () => {
  const result = verify();
  assert.throws(() => verifyBuildProof(result), { code: "BUILD_PROOF_CONTRACT_INVALID" });
  assert.throws(() => assertProofCustody(result), { code: "BUILD_PROOF_CUSTODY_INVALID" });
});

for (const mutation of [
  {
    name: "extra top-level input field",
    code: "BUILD_DELIVERY_INPUT_INVALID",
    apply: (input) => {
      input.callerVerified = true;
    }
  },
  {
    name: "extra expected field",
    code: "BUILD_DELIVERY_INPUT_INVALID",
    apply: (input) => {
      input.expected.retainUntil = exact90ExpiresAt;
    }
  },
  {
    name: "extra entry field",
    code: "BUILD_DELIVERY_INPUT_INVALID",
    apply: (input) => {
      input.entries[0].verified = true;
    }
  },
  {
    name: "extra file field",
    code: "BUILD_DELIVERY_INPUT_INVALID",
    apply: (input) => {
      input.entries[0].originalFiles[0].secret = "forbidden";
    }
  },
  {
    name: "non-Buffer bytes",
    code: "BUILD_DELIVERY_INPUT_INVALID",
    apply: (input) => {
      input.entries[0].originalFiles[0].bytes = input.entries[0].originalFiles[0].bytes.toString();
    }
  },
  {
    name: "missing artifact entry",
    code: "BUILD_DELIVERY_ARTIFACT_SET_INVALID",
    apply: (input) => {
      input.entries.pop();
    }
  },
  {
    name: "duplicate artifact kind",
    code: "BUILD_DELIVERY_ARTIFACT_SET_INVALID",
    apply: (input) => {
      input.entries[1].kind = "proof";
    }
  },
  {
    name: "unknown artifact kind",
    code: "BUILD_DELIVERY_ARTIFACT_SET_INVALID",
    apply: (input) => {
      input.entries[1].kind = "custody";
    }
  },
  {
    name: "caller-selected run attempt",
    code: "BUILD_DELIVERY_EXPECTED_INVALID",
    apply: (input) => {
      input.expected.runAttempt = 2;
    }
  },
  {
    name: "invalid expected repository",
    code: "BUILD_DELIVERY_EXPECTED_INVALID",
    apply: (input) => {
      input.expected.repository = "../other";
    }
  },
  {
    name: "invalid expected run ID",
    code: "BUILD_DELIVERY_EXPECTED_INVALID",
    apply: (input) => {
      input.expected.workflowRunId = "02801";
    }
  }
]) {
  test(`rejects ${mutation.name}`, () => {
    const input = deliveryFixture();
    mutation.apply(input);
    assert.throws(() => verify(input), { code: mutation.code });
  });
}

for (const mutation of [
  {
    name: "proof readback drift",
    apply: (input) => {
      entry(input, "proof").readbackFiles[0].bytes[0] ^= 1;
    }
  },
  {
    name: "material readback drift",
    apply: (input) => {
      entry(input, "supporting-evidence").readbackFiles[0].bytes[0] ^= 1;
    }
  },
  {
    name: "attestation readback drift",
    apply: (input) => {
      entry(input, "supporting-evidence").readbackFiles[1].bytes[0] ^= 1;
    }
  }
]) {
  test(`rejects ${mutation.name}`, () => {
    const input = deliveryFixture();
    mutation.apply(input);
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_READBACK_MISMATCH" });
  });
}

for (const mutation of [
  {
    name: "a missing proof file",
    apply: (input) => entry(input, "proof").originalFiles.pop()
  },
  {
    name: "a missing supporting file",
    apply: (input) => entry(input, "supporting-evidence").readbackFiles.pop()
  },
  {
    name: "an unknown public file",
    apply: (input) =>
      entry(input, "supporting-evidence").originalFiles.push(
        file("environment.txt", Buffer.from("SECRET=value\n"))
      )
  },
  {
    name: "a duplicate public file",
    apply: (input) =>
      entry(input, "proof").originalFiles.push(file("build-proof.v1.json", Buffer.from("{}")))
  }
]) {
  test(`rejects ${mutation.name}`, () => {
    const input = deliveryFixture();
    mutation.apply(input);
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_FILE_SET_INVALID" });
  });
}

test("rejects valid but noncanonical proof bytes", () => {
  const input = deliveryFixture();
  const proof = entry(input, "proof");
  proof.originalFiles[0].bytes = Buffer.concat([proof.originalFiles[0].bytes, Buffer.from("\n")]);
  proof.readbackFiles[0].bytes = Buffer.from(proof.originalFiles[0].bytes);
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_PROOF_BYTES_INVALID" });
});

test("rejects material bytes outside the producer's canonical-plus-LF shape", () => {
  const input = deliveryFixture();
  const supporting = entry(input, "supporting-evidence");
  const parsed = JSON.parse(supporting.originalFiles[0].bytes);
  supporting.originalFiles[0].bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
  supporting.readbackFiles[0].bytes = Buffer.from(supporting.originalFiles[0].bytes);
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_MATERIAL_BYTES_INVALID" });
});

test("rejects malformed raw attestation JSON without treating it as verified", () => {
  const input = deliveryFixture();
  const supporting = entry(input, "supporting-evidence");
  supporting.originalFiles[1].bytes = Buffer.from("not-json");
  supporting.readbackFiles[1].bytes = Buffer.from("not-json");
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_JSON_INVALID" });
});

test("rejects invalid UTF-8 instead of parsing replacement characters", () => {
  const input = deliveryFixture();
  const supporting = entry(input, "supporting-evidence");
  supporting.originalFiles[1].bytes = Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]);
  supporting.readbackFiles[1].bytes = Buffer.from(supporting.originalFiles[1].bytes);
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_JSON_INVALID" });
});

test("rejects malformed raw service metadata", () => {
  const input = deliveryFixture();
  entry(input, "proof").metadataBytes = Buffer.from("not-json");
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_JSON_INVALID" });
});

test("rejects a single public file over 1 MiB", () => {
  const input = deliveryFixture();
  const oversized = Buffer.from(JSON.stringify([{ evidence: "x".repeat(1024 * 1024) }]));
  const supporting = entry(input, "supporting-evidence");
  supporting.originalFiles[1].bytes = oversized;
  supporting.readbackFiles[1].bytes = Buffer.from(oversized);
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_FILE_TOO_LARGE" });
});

test("rejects service metadata over 1 MiB", () => {
  const input = deliveryFixture();
  const proof = entry(input, "proof");
  const metadata = JSON.parse(proof.metadataBytes);
  metadata.syntheticPadding = "x".repeat(1024 * 1024);
  proof.metadataBytes = Buffer.from(JSON.stringify(metadata));
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_FILE_TOO_LARGE" });
});

test("rejects a proof digest that is not the canonical proof digest", () => {
  const input = deliveryFixture();
  input.expected.buildProofDigest = digest("0");
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_PROOF_DIGEST_MISMATCH" });
});

test("rejects a build identity from another exact repository run URL", () => {
  const input = deliveryFixture({ fixtureRepository: "other/repository" });
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_RUN_MISMATCH" });
});

test("delegates semantic proof/material identity drift to the shared RP4 assertion", () => {
  const input = deliveryFixture();
  const supporting = entry(input, "supporting-evidence");
  const observation = JSON.parse(supporting.originalFiles[0].bytes);
  observation.images[0].digest = digest("9");
  observation.images[0].registrySubject = `${observation.images[0].image}@${digest("9")}`;
  supporting.originalFiles[0].bytes = Buffer.from(`${canonicalJson(observation)}\n`);
  supporting.readbackFiles[0].bytes = Buffer.from(supporting.originalFiles[0].bytes);
  assert.throws(() => verify(input), { code: "BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH" });
});

for (const mutation of [
  {
    name: "metadata artifact ID unlike the upload output",
    code: "BUILD_DELIVERY_ARTIFACT_ID_MISMATCH",
    apply: (input) => {
      entry(input, "proof").artifactId = "9003";
    }
  },
  {
    name: "the same ID for both uploads",
    code: "BUILD_DELIVERY_ARTIFACT_SET_INVALID",
    apply: (input) => {
      const supporting = entry(input, "supporting-evidence");
      supporting.artifactId = proofArtifactId;
      replaceMetadata(supporting, (metadata) => {
        metadata.id = Number(proofArtifactId);
        metadata.url = `https://api.github.com/repos/${repository}/actions/artifacts/${proofArtifactId}`;
        metadata.archive_download_url = `${metadata.url}/zip`;
      });
    }
  },
  {
    name: "proof and evidence metadata exchanged",
    code: "BUILD_DELIVERY_ARTIFACT_ID_MISMATCH",
    apply: (input) => {
      const proof = entry(input, "proof");
      const supporting = entry(input, "supporting-evidence");
      [proof.metadataBytes, supporting.metadataBytes] = [
        supporting.metadataBytes,
        proof.metadataBytes
      ];
    }
  },
  {
    name: "metadata artifact name unlike the digest-bound name",
    code: "BUILD_DELIVERY_ARTIFACT_NAME_MISMATCH",
    apply: (input) => {
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata.name = `build-proof-${"0".repeat(64)}`;
      });
    }
  },
  {
    name: "caller artifact name unlike the digest-bound name",
    code: "BUILD_DELIVERY_ARTIFACT_NAME_MISMATCH",
    apply: (input) => {
      entry(input, "supporting-evidence").name = "build-proof-evidence-caller-selected";
    }
  },
  {
    name: "metadata from another workflow run",
    code: "BUILD_DELIVERY_RUN_MISMATCH",
    apply: (input) => {
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata.workflow_run.id = 2802;
      });
    }
  },
  {
    name: "metadata from another source SHA",
    code: "BUILD_DELIVERY_SOURCE_MISMATCH",
    apply: (input) => {
      replaceMetadata(entry(input, "supporting-evidence"), (metadata) => {
        metadata.workflow_run.head_sha = "9".repeat(40);
      });
    }
  },
  {
    name: "metadata API URL from another repository",
    code: "BUILD_DELIVERY_REPOSITORY_MISMATCH",
    apply: (input) => {
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata.url = metadata.url.replace(repository, "other/repository");
      });
    }
  },
  {
    name: "metadata archive URL from another repository",
    code: "BUILD_DELIVERY_REPOSITORY_MISMATCH",
    apply: (input) => {
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata.archive_download_url = metadata.archive_download_url.replace(
          repository,
          "other/repository"
        );
      });
    }
  },
  {
    name: "expired service metadata",
    code: "BUILD_DELIVERY_EXPIRED",
    apply: (input) => {
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata.expired = true;
      });
    }
  }
]) {
  test(`rejects ${mutation.name}`, () => {
    const input = deliveryFixture();
    mutation.apply(input);
    assert.throws(() => verify(input), { code: mutation.code });
  });
}

for (const invalidId of ["", "0", "01", "1.5", "NaN", "9007199254740992"]) {
  test(`rejects non-strict upload artifact ID ${JSON.stringify(invalidId)}`, () => {
    const input = deliveryFixture();
    entry(input, "proof").artifactId = invalidId;
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_ARTIFACT_ID_INVALID" });
  });
}

for (const invalidMetadataId of ["9001", 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects non-safe numeric metadata artifact ID ${JSON.stringify(invalidMetadataId)}`, () => {
    const input = deliveryFixture();
    replaceMetadata(entry(input, "proof"), (metadata) => {
      metadata.id = invalidMetadataId;
    });
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_ARTIFACT_ID_INVALID" });
  });
}

for (const field of ["created_at", "expires_at"]) {
  for (const invalidDate of [
    "",
    "NaN",
    "2026-02-30T00:00:00Z",
    "2026-09-02T00:00:00+00:00",
    "+275760-09-12T23:59:59.999Z"
  ]) {
    test(`rejects invalid ${field} service timestamp ${JSON.stringify(invalidDate)}`, () => {
      const input = deliveryFixture();
      replaceMetadata(entry(input, "proof"), (metadata) => {
        metadata[field] = invalidDate;
      });
      assert.throws(() => verify(input), { code: "BUILD_DELIVERY_RETENTION_INVALID" });
    });
  }
}

test("rejects 89 days of service-observed retention", () => {
  const input = deliveryFixture({ fixtureExpiresAt: "2026-11-30T00:00:00Z" });
  assert.throws(() => verify(input), { code: "BUILD_DELIVERY_RETENTION_INVALID" });
});

for (const observedAt of ["not-a-date", "2026-09-01T23:59:59.999Z", exact90ExpiresAt]) {
  test(`rejects delivery observation outside the live artifact interval: ${observedAt}`, () => {
    const input = deliveryFixture();
    input.observedAt = observedAt;
    assert.throws(() => verify(input), { code: "BUILD_DELIVERY_OBSERVED_AT_INVALID" });
  });
}

async function writeCliFixture({ oversizedAttestation = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "build-delivery-cli-"));
  const output = path.join(root, ".release-output");
  const proofReadback = path.join(root, ".release-readback", "proof");
  const evidenceReadback = path.join(root, ".release-readback", "evidence");
  const input = deliveryFixture({
    fixtureCreatedAt: "2020-01-01T00:00:00Z",
    fixtureExpiresAt: "2099-01-01T00:00:00Z"
  });
  if (oversizedAttestation) {
    const bytes = Buffer.from(JSON.stringify([{ evidence: "x".repeat(1024 * 1024) }]));
    const supporting = entry(input, "supporting-evidence");
    supporting.originalFiles[1].bytes = bytes;
    supporting.readbackFiles[1].bytes = Buffer.from(bytes);
  }
  await Promise.all([
    mkdir(output, { recursive: true }),
    mkdir(proofReadback, { recursive: true }),
    mkdir(evidenceReadback, { recursive: true })
  ]);
  const proof = entry(input, "proof");
  const supporting = entry(input, "supporting-evidence");
  await Promise.all([
    writeFile(path.join(output, "build-proof.v1.json"), proof.originalFiles[0].bytes),
    writeFile(
      path.join(output, "build-material-observation.v1.json"),
      supporting.originalFiles[0].bytes
    ),
    writeFile(
      path.join(output, "build-proof-attestation-verification.json"),
      supporting.originalFiles[1].bytes
    ),
    writeFile(path.join(output, "build-proof-artifact-metadata.json"), proof.metadataBytes),
    writeFile(path.join(output, "build-evidence-artifact-metadata.json"), supporting.metadataBytes),
    writeFile(path.join(proofReadback, "build-proof.v1.json"), proof.readbackFiles[0].bytes),
    writeFile(
      path.join(evidenceReadback, "build-material-observation.v1.json"),
      supporting.readbackFiles[0].bytes
    ),
    writeFile(
      path.join(evidenceReadback, "build-proof-attestation-verification.json"),
      supporting.readbackFiles[1].bytes
    )
  ]);
  return {
    root,
    input,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: workflowRunId,
      GITHUB_RUN_ATTEMPT: String(runAttempt),
      SOURCE_SHA: sourceSha,
      PROOF_DIGEST: input.expected.buildProofDigest,
      PROOF_ARTIFACT_ID: proofArtifactId,
      EVIDENCE_ARTIFACT_ID: evidenceArtifactId
    }
  };
}

function runCli(fixture, args = ["--directory", ".release-output"]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8"
  });
}

async function withCliFixture(callback, options) {
  const fixture = await writeCliFixture(options);
  try {
    await callback(fixture);
  } finally {
    assert.ok(path.resolve(fixture.root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("CLI reads only fixed files and emits only the non-promotable delivery result", async () => {
  await withCliFixture(async (fixture) => {
    const result = runCli(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.endsWith("\n"), true);
    assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.status, "delivery-verified");
    assert.equal(decision.buildProofDigest, fixture.input.expected.buildProofDigest);
    assert.equal(decision.authorityCustody, "INPUT_REQUIRED");
    assert.equal(decision.promotionEligible, false);
    assert.deepEqual(
      decision.artifacts.map(({ artifactId }) => artifactId),
      [Number(proofArtifactId), Number(evidenceArtifactId)]
    );
  });
});

test("CLI rejects missing, duplicate, unknown, valueless and nonfixed directory options", async () => {
  await withCliFixture(async (fixture) => {
    const cases = [
      [],
      ["--directory"],
      ["--directory", ""],
      ["--directory", ".release-output", "--directory", ".release-output"],
      ["--directory", ".release-output", "--observed-at", deliveryObservedAt],
      ["--unknown", ".release-output"],
      ["--directory", ".release-readback"],
      ["--directory", path.join("nested", ".release-output")]
    ];
    for (const args of cases) {
      const result = runCli(fixture, args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /BUILD_DELIVERY_ARGUMENT_INVALID/u);
      assert.equal(result.stdout, "");
    }
  });
});

test("CLI rejects an incomplete fixed file set", async () => {
  await withCliFixture(async (fixture) => {
    await rm(
      path.join(
        fixture.root,
        ".release-readback",
        "evidence",
        "build-proof-attestation-verification.json"
      )
    );
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BUILD_DELIVERY_FILE_INVALID/u);
    assert.equal(result.stdout, "");
  });
});

test("CLI rejects symlinked or reparse readback paths even when bytes match", async () => {
  await withCliFixture(async (fixture) => {
    const readbackProof = path.join(fixture.root, ".release-readback", "proof");
    await rm(readbackProof, { recursive: true, force: true });
    await symlink(
      path.join(fixture.root, ".release-output"),
      readbackProof,
      process.platform === "win32" ? "junction" : "dir"
    );
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BUILD_DELIVERY_PATH_INVALID/u);
    assert.equal(result.stdout, "");
  });
});

test("CLI enforces the 1 MiB limit before emitting any result", async () => {
  await withCliFixture(
    async (fixture) => {
      const result = runCli(fixture);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /BUILD_DELIVERY_FILE_TOO_LARGE/u);
      assert.equal(result.stdout, "");
    },
    { oversizedAttestation: true }
  );
});

test("CLI rejects missing or caller-shaped environment identity", async () => {
  await withCliFixture(async (fixture) => {
    for (const [name, value, expectedCode] of [
      ["GITHUB_REPOSITORY", undefined, "BUILD_DELIVERY_EXPECTED_INVALID"],
      ["GITHUB_RUN_ID", "02801", "BUILD_DELIVERY_EXPECTED_INVALID"],
      ["GITHUB_RUN_ATTEMPT", "2", "BUILD_DELIVERY_EXPECTED_INVALID"],
      ["SOURCE_SHA", "9".repeat(40), "BUILD_DELIVERY_SOURCE_MISMATCH"],
      ["PROOF_DIGEST", digest("0"), "BUILD_DELIVERY_PROOF_DIGEST_MISMATCH"],
      ["PROOF_ARTIFACT_ID", "9002", "BUILD_DELIVERY_ARTIFACT_SET_INVALID"],
      ["EVIDENCE_ARTIFACT_ID", "9001", "BUILD_DELIVERY_ARTIFACT_SET_INVALID"]
    ]) {
      const original = fixture.env[name];
      if (value === undefined) delete fixture.env[name];
      else fixture.env[name] = value;
      const result = runCli(fixture);
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, new RegExp(expectedCode, "u"));
      assert.equal(result.stdout, "");
      fixture.env[name] = original;
    }
  });
});

test("repository contract discovers and content-addresses the delivery verifier", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "build-delivery-catalog-"));
  const manifestPath = "release/contracts/repository-contract-files.v1.json";
  const verifierPath = "scripts/release/verify-build-delivery.mjs";
  try {
    await mkdir(path.join(root, "release", "contracts"), { recursive: true });
    await mkdir(path.join(root, "scripts", "release"), { recursive: true });
    await writeFile(path.join(root, ...verifierPath.split("/")), "export const version = 1;\n");
    await writeFile(
      path.join(root, ...manifestPath.split("/")),
      `${JSON.stringify(
        { contractVersion: "repository-contract-files.v1", files: [manifestPath] },
        null,
        2
      )}\n`
    );
    await assert.rejects(computeRepositoryContract(root), { code: "CONTRACT_FILE_SET_DRIFT" });

    await writeFile(
      path.join(root, ...manifestPath.split("/")),
      `${JSON.stringify(
        {
          contractVersion: "repository-contract-files.v1",
          files: [manifestPath, verifierPath]
        },
        null,
        2
      )}\n`
    );
    const before = await computeRepositoryContract(root);
    await writeFile(path.join(root, ...verifierPath.split("/")), "export const version = 2;\n");
    const after = await computeRepositoryContract(root);
    assert.notEqual(after.digest, before.digest);
    assert.notEqual(
      after.entries.find(({ path: pathname }) => pathname === verifierPath).sha256,
      before.entries.find(({ path: pathname }) => pathname === verifierPath).sha256
    );
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("repository contract binds the delivery verifier used by the workflow", async () => {
  const contract = await computeRepositoryContract(process.cwd());
  assert.ok(
    contract.entries.some(
      ({ path: pathname }) => pathname === "scripts/release/verify-build-delivery.mjs"
    )
  );
});

test("CLI fixed file names match the workflow-owned delivery boundary", async () => {
  const workflow = await readFile(".github/workflows/docker-images.yml", "utf8");
  for (const pathname of [
    ".release-output/build-proof.v1.json",
    ".release-output/build-material-observation.v1.json",
    ".release-output/build-proof-attestation-verification.json",
    ".release-output/build-proof-artifact-metadata.json",
    ".release-output/build-evidence-artifact-metadata.json",
    ".release-readback/proof/build-proof.v1.json",
    ".release-readback/evidence/build-material-observation.v1.json",
    ".release-readback/evidence/build-proof-attestation-verification.json"
  ]) {
    assert.match(workflow, new RegExp(pathname.replaceAll(".", "\\."), "u"));
  }
  assert.match(
    workflow,
    /node scripts\/release\/verify-build-delivery\.mjs --directory \.release-output/u
  );
});
