import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";
import { createFinalDatabaseAdapters } from "./final-compose-database-adapters.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const uuid = (character) =>
  `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(12)}`;

function buildProof() {
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
            registry: `ghcr.io/example/${name}`,
            platform: "linux/amd64",
            imageDigest: digest(String(index + 3)),
            sourceRevision: sourceSha
          }
        ])
      )
    },
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://runs/1/attempts/1",
      attestationRef: "github://attestations/1",
      checkoutRef: sourceSha,
      baseImages: [{ name: "node", resolvedDigest: digest("6") }],
      materials: [{ name: "builder", reference: "github://builder/1" }],
      registryResolutionEvidenceDigest: digest("7")
    }
  };
}

function sourceEvidence(chain, proof) {
  return {
    schemaVersion: "source-gate-evidence.v1",
    sourceSha: proof.identity.sourceSha,
    migrationCatalogDigest: proof.identity.migrationCatalogDigest,
    repositoryContractDigest: proof.identity.repositoryContractDigest,
    databaseTestManifestDigest: digest("8"),
    databaseTestDiscoveryDigest: digest("9"),
    postgres: { imageDigest: digest("a"), serverVersionNum: "170011" },
    chain,
    counts: {
      collected: 1,
      selected: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
      filtered: 0,
      cancelled: 0
    },
    terminalStatus: "PASSED",
    schemaDiffDigest: digest("b"),
    migrationStatusDigest: digest("c"),
    sanitizedLogDigest: digest("d"),
    ...(chain === "snapshot"
      ? {
          snapshot: {
            snapshotMetadataDigest: digest("e"),
            snapshotBundleDigest: digest("f"),
            sourceMigrationHead: "20260831010000_billing_maintenance_cycle_fact",
            ownershipMapDigest: digest("0"),
            ownershipObservationDigest: digest("1")
          }
        }
      : {}),
    provenance: {
      generatedAt: "2026-09-03T00:00:00.000Z",
      ciRunRef: "github://runs/1/attempts/1",
      executorVersion: "source-gate@1"
    }
  };
}

test("runs the final database chain in the fixed order and cleans only after custody", async () => {
  const proof = buildProof();
  const events = [];
  const operationId = uuid("1");
  const planDigest = digest("f");
  const target = {
    hostname: "postgres",
    databaseName: `s1ci_${"a".repeat(24)}`,
    tlsMode: "require"
  };
  const envelopes = new Map([
    ["migration-dry-run", registered("db.migrate.deploy@1", "dry-run", operationId, target, proof)],
    [
      "migration-apply",
      registered("db.migrate.deploy@1", "apply", operationId, target, proof, planDigest)
    ],
    [
      "migration-replay",
      registered("db.migrate.deploy@1", "replay", operationId, target, proof, planDigest)
    ],
    ["schema-verify", registered("db.schema.verify@1", "verify", uuid("2"), target, proof)],
    ["database-tests", databaseTest(uuid("3"), target, proof)]
  ]);
  const adapters = createFinalDatabaseAdapters({
    chain: "fresh",
    buildProof: proof,
    sourceEvidence: sourceEvidence("fresh", proof),
    workspace: { launchRoot: ".release-local/launch/fresh" },
    infrastructure: {
      async prepareTarget() {
        events.push("provision-or-restore");
        return {
          chain: "fresh",
          buildProofDigest: sha256Canonical(proof),
          operationId: uuid("9"),
          target
        };
      },
      async cleanupTarget() {
        events.push("cleanup");
        return { terminalStatus: "PASSED" };
      }
    },
    trustedLauncher: {
      async launchRunnerContainer({ launchEnvelopeFile }) {
        const name = launchEnvelopeFile
          .split(/[\\/]/u)
          .at(-1)
          .replace(/\.json$/u, "");
        const envelope = envelopes.get(name);
        const phase = envelope.request?.phase;
        events.push(
          name === "database-tests"
            ? "database-tests"
            : name === "schema-verify"
              ? "verify"
              : `migration:${phase === "dry-run" ? "dry-run" : phase === "apply" ? "apply" : "replay"}`
        );
        if (phase === "dry-run") events.push("migration:ci-policy-approval");
        return phase === "dry-run"
          ? { terminalStatus: "PASSED", planDigest }
          : name === "database-tests"
            ? {
                terminalStatus: "PASSED",
                reportDigest: digest("3"),
                counts: completeCounts()
              }
            : proofResult(envelope.request.operationId);
      }
    },
    custodyDatabaseProofs: async () => {
      events.push("proof-custody");
      return { receiptDigest: digest("4") };
    },
    loadLaunchEnvelope: async (_root, name) => ({
      file: `.release-local/launch/fresh/${name}.json`,
      envelope: envelopes.get(name)
    })
  });
  await adapters.prepareTarget();
  await adapters.runMigration();
  await adapters.runVerify();
  await adapters.runDatabaseTests();
  await assert.rejects(adapters.cleanupTarget({}), {
    code: "FINAL_DATABASE_CLEANUP_BEFORE_CUSTODY"
  });
  await adapters.cleanupTarget({ custody: { terminalStatus: "PASSED" } });
  assert.deepEqual(events, [
    "provision-or-restore",
    "migration:dry-run",
    "migration:ci-policy-approval",
    "migration:apply",
    "migration:replay",
    "verify",
    "database-tests",
    "proof-custody",
    "cleanup"
  ]);
});

function registered(commandKey, phase, operationId, target, proof, planDigest) {
  return {
    schemaVersion: "runner-launch-envelope.v1",
    executionMode: "registered-command",
    commandKey,
    request: {
      buildProofDigest: sha256Canonical(proof),
      actualRunnerDigest: proof.identity.images.runner.imageDigest,
      environmentClass: "ci-fresh",
      target,
      phase,
      operationId,
      ...(planDigest ? { planDigest } : {})
    }
  };
}

function databaseTest(operationId, target, proof) {
  return {
    schemaVersion: "database-test-launch-envelope.v1",
    executionMode: "database-test",
    chain: "fresh",
    buildProofDigest: sha256Canonical(proof),
    actualRunnerDigest: proof.identity.images.runner.imageDigest,
    target,
    operationId
  };
}

function proofResult(operationId) {
  return {
    terminalStatus: "PASSED",
    postStateObservationDigest: digest("1"),
    executionProofDigest: digest("2"),
    executionProof: { operationId }
  };
}

function completeCounts() {
  return {
    collected: 1,
    selected: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    todo: 0,
    filtered: 0,
    cancelled: 0
  };
}
