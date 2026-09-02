import assert from "node:assert/strict";
import test from "node:test";

import { sha256Canonical } from "../../packages/release-foundation/src/index.mjs";

import { buildProof, digest, snapshotMetadata, sourceEvidence } from "./task29r-proof-fixtures.mjs";
import {
  assertPreparedLaunchBindings,
  prepareFinalComposeLaunch
} from "./prepare-final-compose-launch.mjs";

test("rejects an unbound target before the first Runner database connection", () => {
  const proof = buildProof();
  const source = sourceEvidence("fresh", proof);
  const proofDigest = sha256Canonical(proof);
  const manifest = {
    identity: {
      buildProofDigest: proofDigest,
      sourceSha: proof.identity.sourceSha,
      migrationCatalogDigest: proof.identity.migrationCatalogDigest,
      repositoryContractDigest: proof.identity.repositoryContractDigest,
      databaseIdentityFingerprint: digest("2"),
      environmentClass: "ci-fresh"
    }
  };
  const target = { chain: "fresh", databaseIdentityFingerprint: digest("2") };
  const custodyPolicy = { retentionDays: 180 };
  const manifestDigest = sha256Canonical(manifest);
  const custodyPolicyDigest = sha256Canonical(custodyPolicy);
  const runtime = {
    chain: "fresh",
    manifestDigest,
    targetDigest: digest("4"),
    custodyPolicyDigest
  };
  const envelope = {
    commandKey: "db.migrate.deploy@1",
    buildProofDigest: proofDigest,
    actualRunnerDigest: proof.identity.images.runner.imageDigest,
    custodyPolicyDigest,
    request: {
      phase: "dry-run",
      buildProofDigest: proofDigest,
      baselineManifestDigest: manifestDigest,
      databaseIdentityDigest: digest("2"),
      environmentClass: "ci-fresh"
    }
  };
  assert.throws(
    () =>
      assertPreparedLaunchBindings({
        runtime,
        target,
        manifest,
        custodyPolicy,
        envelope,
        input: { chain: "fresh", buildProof: proof, sourceGateEvidence: source }
      }),
    { code: "FINAL_PREPARATION_BINDING_MISMATCH" }
  );
});

test("prepares only a launch-input bundle through the protected infrastructure adapter", async () => {
  const proof = buildProof();
  const source = sourceEvidence("fresh", proof);
  let inspected;
  const result = await prepareFinalComposeLaunch(
    {
      phase: "prepare",
      chain: "fresh",
      buildProof: proof,
      sourceGateEvidence: source,
      launchRoot: ".release-local/launch/fresh",
      composeFile: "docker-compose.release-gate.yml",
      workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1"
    },
    {
      adapter: {
        trustPolicy: "protected-final-compose-preparation/v1",
        prepare: async () => ({
          schemaVersion: "final-compose-preparation.v1",
          phase: "prepare",
          chain: "fresh",
          terminalStatus: "PREPARED",
          launchRoot: ".release-local/launch/fresh",
          composeProject: "s1-final-fresh",
          files: {
            runtime: "final-compose-runtime.v1.json",
            target: "final-compose-target.v1.json",
            dryRunEnvelope: "migration-dry-run.json"
          }
        })
      },
      inspectPreparation: async (value) => {
        inspected = value;
      }
    }
  );
  assert.equal(result.terminalStatus, "PREPARED");
  assert.equal(inspected.phase, "prepare");
  assert.equal("finalComposeEvidence" in result, false);
});

test("finalizes only plan-bound envelopes after a real dry-run result", async () => {
  const proof = buildProof();
  const source = sourceEvidence("snapshot", proof);
  const result = await prepareFinalComposeLaunch(
    {
      phase: "finalize",
      chain: "snapshot",
      buildProof: proof,
      sourceGateEvidence: source,
      snapshotMetadata: snapshotMetadata(),
      launchRoot: ".release-local/launch/snapshot",
      composeFile: "docker-compose.release-gate.yml",
      workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1",
      planResult: { terminalStatus: "PASSED", planDigest: digest("f") }
    },
    {
      adapter: {
        trustPolicy: "protected-final-compose-preparation/v1",
        finalizePlan: async () => ({
          schemaVersion: "final-compose-preparation.v1",
          phase: "finalize",
          chain: "snapshot",
          terminalStatus: "FINALIZED",
          launchRoot: ".release-local/launch/snapshot",
          composeProject: "s1-final-snapshot",
          planDigest: digest("f"),
          files: {
            applyEnvelope: "migration-apply.json",
            replayEnvelope: "migration-replay.json",
            verifyEnvelope: "schema-verify.json",
            databaseTestsEnvelope: "database-tests.json"
          }
        })
      },
      inspectPreparation: async () => {}
    }
  );
  assert.equal(result.planDigest, digest("f"));
});

test("rejects a preparation adapter that attempts to supply result evidence", async () => {
  const proof = buildProof();
  await assert.rejects(
    prepareFinalComposeLaunch(
      {
        phase: "prepare",
        chain: "fresh",
        buildProof: proof,
        sourceGateEvidence: sourceEvidence("fresh", proof),
        launchRoot: ".release-local/launch/fresh",
        composeFile: "docker-compose.release-gate.yml",
        workflowRunRef: "github://keqi119/subscription-Saas/actions/runs/901/attempts/1"
      },
      {
        adapter: {
          trustPolicy: "protected-final-compose-preparation/v1",
          prepare: async () => ({ finalComposeEvidence: { terminalStatus: "PASSED" } })
        },
        inspectPreparation: async () => {}
      }
    ),
    { code: "FINAL_PREPARATION_RESULT_EVIDENCE_FORBIDDEN" }
  );
});
