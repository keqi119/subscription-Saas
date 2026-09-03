import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256Canonical, validateContract } from "../../packages/release-foundation/src/index.mjs";
import { createTrustedLaunchProductionAdapters } from "./trusted-launch-production-adapters.mjs";

function adapterError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function launchFile(root, name) {
  const absolute = path.resolve(root, `${name}.json`);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw adapterError("FINAL_DATABASE_LAUNCH_PATH_FORBIDDEN");
  }
  return absolute;
}

async function loadEnvelope(root, name) {
  const file = launchFile(root, name);
  const envelope = JSON.parse(await readFile(file, "utf8"));
  validateContract(
    envelope.executionMode === "database-test"
      ? "database-test-launch-envelope.v1"
      : "runner-launch-envelope.v1",
    envelope
  );
  return Object.freeze({ file, envelope });
}

function assertSharedIdentity({ envelope, chain, buildProof, target }) {
  const request = envelope.executionMode === "registered-command" ? envelope.request : envelope;
  const actualTarget = request.target;
  if (
    request.buildProofDigest !== sha256Canonical(buildProof) ||
    request.actualRunnerDigest !== buildProof.identity.images.runner.imageDigest ||
    (request.environmentClass ?? request.chain) !==
      (request.environmentClass ? `ci-${chain}` : chain) ||
    actualTarget.databaseName !== target.databaseName ||
    (actualTarget.port ?? 5432) !== (target.port ?? 5432) ||
    actualTarget.hostname !== target.hostname ||
    actualTarget.tlsMode !== "require"
  ) {
    throw adapterError("FINAL_DATABASE_CHAIN_IDENTITY_MISMATCH");
  }
}

function assertRegistered(envelope, { commandKey, phase, operationId, planDigest }) {
  if (
    envelope.executionMode !== "registered-command" ||
    envelope.commandKey !== commandKey ||
    envelope.request.phase !== phase ||
    (operationId && envelope.request.operationId !== operationId) ||
    (planDigest && envelope.request.planDigest !== planDigest)
  ) {
    throw adapterError("FINAL_DATABASE_LAUNCH_SEQUENCE_INVALID");
  }
}

function assertExecutionProof(result, expectedOperationId) {
  if (
    result?.terminalStatus !== "PASSED" ||
    result?.executionProof?.operationId !== expectedOperationId ||
    !/^sha256:[0-9a-f]{64}$/u.test(result?.executionProofDigest ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(result?.postStateObservationDigest ?? "")
  ) {
    throw adapterError("FINAL_DATABASE_EXECUTION_PROOF_INVALID");
  }
  return Object.freeze({
    operationId: expectedOperationId,
    postStateObservationDigest: result.postStateObservationDigest,
    executionProofDigest: result.executionProofDigest
  });
}

export function createFinalDatabaseAdapters({
  chain,
  buildProof,
  sourceEvidence,
  snapshot,
  workspace,
  composeFile = "docker-compose.release-gate.yml",
  composeProject = `s1-final-${chain}`,
  infrastructure,
  trustedLauncher = createTrustedLaunchProductionAdapters(),
  custodyDatabaseProofs,
  loadLaunchEnvelope = loadEnvelope
}) {
  if (
    !["fresh", "snapshot"].includes(chain) ||
    !workspace?.launchRoot ||
    !infrastructure ||
    typeof infrastructure.prepareTarget !== "function" ||
    typeof infrastructure.cleanupTarget !== "function" ||
    typeof trustedLauncher.launchRunnerContainer !== "function" ||
    typeof custodyDatabaseProofs !== "function"
  ) {
    throw adapterError("FINAL_DATABASE_ADAPTER_INPUT_INVALID");
  }
  validateContract("build-proof.v1", buildProof);
  validateContract("source-gate-evidence.v1", sourceEvidence);
  if (
    sourceEvidence.chain !== chain ||
    sourceEvidence.sourceSha !== buildProof.identity.sourceSha ||
    sourceEvidence.migrationCatalogDigest !== buildProof.identity.migrationCatalogDigest ||
    sourceEvidence.repositoryContractDigest !== buildProof.identity.repositoryContractDigest ||
    (chain === "snapshot" && !snapshot)
  ) {
    throw adapterError("FINAL_DATABASE_SOURCE_EVIDENCE_MISMATCH");
  }
  const expectedRunnerImage = `${buildProof.identity.images.runner.registry}@${buildProof.identity.images.runner.imageDigest}`;
  let targetRecord;
  let databaseProofsCustodied = false;

  async function launch(name, service) {
    const loaded = await loadLaunchEnvelope(workspace.launchRoot, name);
    assertSharedIdentity({
      envelope: loaded.envelope,
      chain,
      buildProof,
      target: targetRecord.target
    });
    const result = await trustedLauncher.launchRunnerContainer({
      launchEnvelopeFile: loaded.file,
      composeFile,
      projectName: composeProject,
      service,
      expectedRunnerImage
    });
    return Object.freeze({ ...loaded, result });
  }

  return Object.freeze({
    async prepareTarget() {
      targetRecord = await infrastructure.prepareTarget({
        chain,
        buildProof,
        sourceEvidence,
        snapshot,
        workspace,
        composeFile,
        composeProject
      });
      if (
        targetRecord?.chain !== chain ||
        targetRecord?.buildProofDigest !== sha256Canonical(buildProof) ||
        !targetRecord?.target ||
        targetRecord.target.tlsMode !== "require"
      ) {
        throw adapterError("FINAL_DATABASE_TARGET_PREPARATION_INVALID");
      }
      return Object.freeze({ ...targetRecord });
    },

    async runMigration() {
      if (!targetRecord) throw adapterError("FINAL_DATABASE_TARGET_NOT_PREPARED");
      const dryRun = await launch("migration-dry-run", "runner-migration");
      assertRegistered(dryRun.envelope, {
        commandKey: "db.migrate.deploy@1",
        phase: "dry-run"
      });
      const operationId = dryRun.envelope.request.operationId;
      const planDigest = dryRun.result.planDigest;
      if (!/^sha256:[0-9a-f]{64}$/u.test(planDigest ?? "")) {
        throw adapterError("FINAL_DATABASE_MIGRATION_PLAN_INVALID");
      }
      const apply = await launch("migration-apply", "runner-migration");
      assertRegistered(apply.envelope, {
        commandKey: "db.migrate.deploy@1",
        phase: "apply",
        operationId,
        planDigest
      });
      const replay = await launch("migration-replay", "runner-migration");
      assertRegistered(replay.envelope, {
        commandKey: "db.migrate.deploy@1",
        phase: "replay",
        operationId,
        planDigest
      });
      return Object.freeze({
        ...assertExecutionProof(apply.result, operationId),
        dryRunPlanDigest: planDigest,
        replayDigest: sha256Canonical(replay.result)
      });
    },

    async runVerify() {
      const verify = await launch("schema-verify", "runner-verify");
      assertRegistered(verify.envelope, {
        commandKey: "db.schema.verify@1",
        phase: "verify"
      });
      return assertExecutionProof(verify.result, verify.envelope.request.operationId);
    },

    async runDatabaseTests() {
      const execution = await launch("database-tests", "runner-database-test");
      if (
        execution.envelope.executionMode !== "database-test" ||
        execution.envelope.operationId === targetRecord.operationId ||
        execution.result?.terminalStatus !== "PASSED"
      ) {
        throw adapterError("FINAL_DATABASE_TEST_EXECUTION_INVALID");
      }
      const custody = await custodyDatabaseProofs({
        chain,
        targetRecord,
        migration: targetRecord.migration,
        databaseTests: execution.result
      });
      if (!/^sha256:[0-9a-f]{64}$/u.test(custody?.receiptDigest ?? "")) {
        throw adapterError("FINAL_DATABASE_PROOF_CUSTODY_INCOMPLETE");
      }
      databaseProofsCustodied = true;
      return Object.freeze({
        operationId: execution.envelope.operationId,
        postStateObservationDigest: execution.result.reportDigest,
        executionProofDigest: custody.receiptDigest,
        reportDigest: execution.result.reportDigest,
        counts: execution.result.counts,
        custodyReceiptDigest: custody.receiptDigest
      });
    },

    async cleanupTarget(context) {
      if (!databaseProofsCustodied || !context?.custody) {
        throw adapterError("FINAL_DATABASE_CLEANUP_BEFORE_CUSTODY");
      }
      return infrastructure.cleanupTarget({ targetRecord, context });
    }
  });
}
