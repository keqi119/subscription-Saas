import { canonicalJson, sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

export const digest = (character) => `sha256:${character.repeat(64)}`;
export const uuid = (character) =>
  `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;

export function buildProof() {
  const sourceSha = "a".repeat(40);
  return {
    schemaVersion: "build-proof.v1",
    identity: {
      schemaVersion: "build-proof.identity.v1",
      sourceSha,
      migrationCatalogDigest: digest("1"),
      repositoryContractDigest: digest("2"),
      images: Object.fromEntries(
        ["api", "web", "runner"].map((name, index) => [
          name,
          {
            name,
            registry: `ghcr.io/keqi119/subscription-${name}`,
            platform: "linux/amd64",
            imageDigest: digest(String(index + 3)),
            sourceRevision: sourceSha
          }
        ])
      )
    },
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://keqi119/subscription-Saas/actions/runs/900",
      attestationRef: "github://keqi119/subscription-Saas/attestations/build-900",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("6") }],
      materials: [{ name: "builder", reference: "github://actions/builders/1" }],
      registryResolutionEvidenceDigest: digest("7")
    }
  };
}

export function snapshotMetadata() {
  return {
    schemaVersion: "snapshot-metadata.v1",
    dumpDigest: digest("8"),
    sourceMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
    sourcePrivilegeObservationDigest: digest("9"),
    sourceFingerprintBeforeDigest: digest("a"),
    sourceFingerprintAfterDigest: digest("a"),
    sanitizationContractDigest: digest("b"),
    ownershipMapDigest: digest("c"),
    ownershipContractVersion: "1",
    scanDigest: digest("d"),
    scanSubjectDigest: digest("8"),
    exportToolVersion: "snapshot-export.v1",
    scanToolVersion: "snapshot-scan.v1",
    createdAt: "2026-09-03T00:00:00.000Z",
    reviewAt: "2026-09-10T00:00:00.000Z",
    expiresAt: "2026-10-03T00:00:00.000Z",
    owner: "release-engineering",
    readers: ["release", "qa", "security", "audit"],
    accessPolicyRef: "release/snapshot-policy/v1",
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/800"
  };
}

function counts() {
  return {
    collected: 4,
    selected: 4,
    executed: 4,
    passed: 4,
    failed: 0,
    skipped: 0,
    todo: 0,
    filtered: 0,
    cancelled: 0
  };
}

export function sourceEvidence(chain, proof = buildProof(), snapshot = snapshotMetadata()) {
  return {
    schemaVersion: "source-gate-evidence.v1",
    sourceSha: proof.identity.sourceSha,
    migrationCatalogDigest: proof.identity.migrationCatalogDigest,
    repositoryContractDigest: proof.identity.repositoryContractDigest,
    databaseTestManifestDigest: digest("e"),
    databaseTestDiscoveryDigest: digest("f"),
    postgres: { imageDigest: digest("0"), serverVersionNum: "170011" },
    chain,
    counts: counts(),
    terminalStatus: "PASSED",
    schemaDiffDigest: digest("1"),
    migrationStatusDigest: digest("2"),
    postSchemaDigest: digest("3"),
    sanitizedLogDigest: digest("4"),
    ...(chain === "snapshot"
      ? {
          snapshot: {
            snapshotMetadataDigest: sha256Canonical(snapshot),
            snapshotBundleDigest: snapshot.dumpDigest,
            sourceMigrationHead: snapshot.sourceMigrationHead,
            ownershipMapDigest: snapshot.ownershipMapDigest,
            ownershipObservationDigest: digest("4")
          }
        }
      : {}),
    provenance: {
      generatedAt: "2026-09-03T01:00:00.000Z",
      ciRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1",
      executorVersion: "source-database-gate.v1"
    }
  };
}

function releaseImages(proof) {
  return Object.fromEntries(
    Object.entries(proof.identity.images).map(([name, image]) => [
      name,
      `${image.registry}@${image.imageDigest}`
    ])
  );
}

export function finalEvidence(chain, proof, source, snapshot = snapshotMetadata()) {
  const marker = chain === "fresh" ? "5" : "6";
  const unique =
    chain === "fresh"
      ? ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
      : ["a", "b", "c", "d", "e", "f", "0", "a", "b"];
  const operationId = uuid(marker);
  return {
    schemaVersion: "final-compose-evidence.v1",
    chain,
    terminalStatus: "PASSED",
    buildProofDigest: sha256Canonical(proof),
    sourceSha: proof.identity.sourceSha,
    releaseImages: releaseImages(proof),
    sourceGateEvidenceDigest: sha256Canonical(source),
    manifestDigest: digest(marker),
    manifestIdentityDigest: digest(chain === "fresh" ? "7" : "8"),
    databaseIdentityFingerprint: digest(chain === "fresh" ? "9" : "a"),
    operationId,
    runId: uuid(chain === "fresh" ? "7" : "8"),
    attemptId: uuid(chain === "fresh" ? "9" : "a"),
    apiSessionNonceDigest: digest(chain === "fresh" ? "b" : "c"),
    contracts: {
      migrationCatalogDigest: proof.identity.migrationCatalogDigest,
      repositoryContractDigest: proof.identity.repositoryContractDigest,
      databaseTestManifestDigest: source.databaseTestManifestDigest,
      postgresImageDigest: source.postgres.imageDigest,
      snapshotMetadataDigest: chain === "snapshot" ? sha256Canonical(snapshot) : null
    },
    compose: {
      projectName: `s1-final-${chain}`,
      configDigest: digest(chain === "fresh" ? "c" : "e"),
      playwrightImageDigest: digest("d"),
      playwrightVersion: "1.62.1"
    },
    executions: {
      migration: {
        operationId: uuid(unique[0]),
        postStateObservationDigest: digest(unique[1]),
        executionProofDigest: digest(unique[2])
      },
      verify: {
        operationId: uuid(unique[3]),
        postStateObservationDigest: digest(unique[4]),
        executionProofDigest: digest(unique[5])
      },
      databaseTests: {
        operationId: uuid(unique[6]),
        postStateObservationDigest: digest(unique[7]),
        executionProofDigest: digest(unique[8])
      }
    },
    databaseTests: {
      reportDigest: digest(chain === "fresh" ? "d" : "e"),
      counts: counts()
    },
    apiReadiness: {
      healthStatus: 200,
      catalogStatus: 200,
      applicationName: `subscription-api/s1-${chain}/nonce-${marker}`,
      databaseOid: chain === "fresh" ? "11001" : "11002",
      runtimeRole: `s1a_${marker.repeat(24)}`,
      tls: true,
      sessionState: "idle",
      evidenceDigest: digest(chain === "fresh" ? "d" : "e")
    },
    webClient: {
      schemaVersion: "web-public-api-evidence.v1",
      operationId,
      buildProofDigest: sha256Canonical(proof),
      manifestDigest: digest(marker),
      publicApiBase: "http://127.0.0.1:33001/api",
      webOrigin: "http://127.0.0.1:33000",
      embeddedApiBase: "http://127.0.0.1:33001/api",
      actualRequestUrl: "http://127.0.0.1:33001/api/portal/catalog/model-definitions",
      corsAllowOrigin: "http://127.0.0.1:33000",
      responseStatus: 200,
      bundleContainsEmbeddedApiBase: true,
      mockedNetwork: false,
      traceDigest: digest("a"),
      observedAt: "2026-09-03T02:00:00.000Z",
      evidenceDigest: digest(chain === "fresh" ? "f" : "0")
    },
    custodyReceiptDigests: [digest(chain === "fresh" ? "1" : "2")],
    priorFailureProofDigests: [digest(chain === "fresh" ? "d" : "e")],
    producedAt: "2026-09-03T02:00:00.000Z"
  };
}

export function custodyRecord(content, name) {
  const contentDigest = sha256Canonical(content);
  return {
    workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1",
    content,
    receipt: {
      schemaVersion: "custody-receipt.v1",
      receiptId: uuid(name),
      contentDigest,
      contentSizeBytes: Buffer.byteLength(canonicalJson(content)),
      storeRef: `github-artifact://runs/901/${name}`,
      uploadedAt: "2026-09-03T02:00:00.000Z",
      readbackAt: "2026-09-03T02:01:00.000Z",
      readbackDigest: contentDigest,
      owner: "release-engineering",
      readers: ["release", "qa", "security", "audit"],
      retainUntil: "2027-03-02T02:00:00.000Z",
      expiryDisposition: "review",
      attestationRef: `github-attestation://runs/901/${name}`
    }
  };
}

export function aggregateInput() {
  const proof = buildProof();
  const snapshot = snapshotMetadata();
  const freshSource = sourceEvidence("fresh", proof, snapshot);
  const snapshotSource = sourceEvidence("snapshot", proof, snapshot);
  const freshFinal = finalEvidence("fresh", proof, freshSource, snapshot);
  const snapshotFinal = finalEvidence("snapshot", proof, snapshotSource, snapshot);
  const inputIdentity = (chain) =>
    sha256Canonical({
      buildProofDigest: sha256Canonical(proof),
      chain,
      sourceEvidenceDigest: sha256Canonical(chain === "fresh" ? freshSource : snapshotSource),
      snapshotMetadataDigest: chain === "snapshot" ? sha256Canonical(snapshot) : null
    });
  return {
    workflowRun: {
      repository: "keqi119/subscription-Saas",
      workflowPath: ".github/workflows/release-candidate-gate.yml",
      runId: "901",
      runAttempt: 1,
      sourceSha: proof.identity.sourceSha
    },
    buildProof: proof,
    snapshotMetadata: snapshot,
    sourceGateEvidence: { fresh: freshSource, snapshot: snapshotSource },
    finalComposeEvidence: { fresh: freshFinal, snapshot: snapshotFinal },
    custodyRecords: {
      buildProof: custodyRecord(proof, "1"),
      snapshotMetadata: custodyRecord(snapshot, "2"),
      sourceFresh: custodyRecord(freshSource, "3"),
      sourceSnapshot: custodyRecord(snapshotSource, "4"),
      finalFresh: custodyRecord(freshFinal, "5"),
      finalSnapshot: custodyRecord(snapshotFinal, "6")
    },
    attemptHistory: {
      fresh: [
        {
          runId: uuid("0"),
          attemptId: uuid("b"),
          operationId: uuid("c"),
          terminalStatus: "FAILED",
          proofDigest: freshFinal.priorFailureProofDigests[0],
          inputIdentityDigest: inputIdentity("fresh"),
          retained: true
        },
        {
          runId: freshFinal.runId,
          attemptId: freshFinal.attemptId,
          operationId: freshFinal.operationId,
          terminalStatus: "PASSED",
          proofDigest: sha256Canonical(freshFinal),
          inputIdentityDigest: inputIdentity("fresh"),
          retained: true
        }
      ],
      snapshot: [
        {
          runId: uuid("d"),
          attemptId: uuid("e"),
          operationId: uuid("f"),
          terminalStatus: "INTERRUPTED_UNKNOWN",
          proofDigest: snapshotFinal.priorFailureProofDigests[0],
          inputIdentityDigest: inputIdentity("snapshot"),
          retained: true
        },
        {
          runId: snapshotFinal.runId,
          attemptId: snapshotFinal.attemptId,
          operationId: snapshotFinal.operationId,
          terminalStatus: "PASSED",
          proofDigest: sha256Canonical(snapshotFinal),
          inputIdentityDigest: inputIdentity("snapshot"),
          retained: true
        }
      ]
    },
    aggregatedAt: "2026-09-03T03:00:00.000Z"
  };
}
