#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createExecutionState,
  fetchLatestTrustedRevocations,
  sha256Canonical,
  transitionExecution,
  validateContract,
  verifyApproval
} from "../../packages/release-foundation/src/index.mjs";
import { commandHandlers } from "../../apps/release-runner/src/command-handlers.mjs";
import {
  assertRegistryHandlerParity,
  loadCommandRegistry,
  loadTargetPolicies,
  registeredCommand
} from "../../apps/release-runner/src/command-registry.mjs";
import {
  executeRegisteredCommand,
  verifyPreflight
} from "../../apps/release-runner/src/preflight.mjs";

function launchError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

async function appendLauncherState(journal, state) {
  if (
    journal?.trustPolicy !== "append-only-execution-state/v1" ||
    typeof journal.append !== "function"
  ) {
    throw launchError("EXECUTION_JOURNAL_UNAVAILABLE");
  }
  const stateDigest = sha256Canonical(state);
  const result = await journal.append({
    operationId: state.operationId,
    terminalClass: state.terminalClass,
    stateDigest,
    state
  });
  if (
    result?.accepted !== true ||
    result.stateDigest !== stateDigest ||
    result.readbackDigest !== stateDigest
  ) {
    throw launchError("EXECUTION_JOURNAL_UNAVAILABLE");
  }
}

function approvalExpected({ command, request, approvalPolicy, approvalMode }) {
  const required = [
    "baselineManifestIdentityDigest",
    "baselineManifestDigest",
    "databaseIdentityDigest",
    "operationId",
    "inputDigest",
    "planDigest"
  ];
  if (required.some((field) => typeof request[field] !== "string" || request[field].length === 0)) {
    throw launchError("APPROVAL_BINDING_MISSING");
  }
  return Object.freeze({
    buildProofDigest: request.buildProofDigest,
    baselineManifestIdentityDigest: request.baselineManifestIdentityDigest,
    baselineManifestDigest: request.baselineManifestDigest,
    databaseIdentityDigest: request.databaseIdentityDigest,
    commandId: command.commandId,
    commandVersion: command.commandVersion,
    executionScope: request.executionScope,
    operationId: request.operationId,
    inputDigest: request.inputDigest,
    planDigest: request.planDigest,
    approvalPolicyDigest: sha256Canonical(approvalPolicy),
    approvalMode,
    environmentClass: request.environmentClass,
    dataImpact: command.dataImpact
  });
}

export async function trustedLaunchRunner({
  commandKey,
  request,
  approvalRecord,
  approvalAttestation,
  approvalAttestationVerifier,
  approvalCustodyReceipt,
  githubClient,
  revocationCheckpointStore,
  executionState: suppliedExecutionState,
  executionJournal,
  readCredential,
  connectDatabase,
  credentialFileReference,
  handler,
  registry: suppliedRegistry,
  targetPolicies: suppliedTargetPolicies,
  approvalPolicy: suppliedApprovalPolicy,
  now = new Date(),
  repoRoot = process.cwd()
}) {
  const [registry, targetPolicies, approvalPolicy] = await Promise.all([
    suppliedRegistry ?? loadCommandRegistry(repoRoot),
    suppliedTargetPolicies ?? loadTargetPolicies(repoRoot),
    suppliedApprovalPolicy ??
      readFile(path.join(repoRoot, "release/contracts/approval-policies.v1.json"), "utf8").then(
        JSON.parse
      )
  ]);
  validateContract("approval-policy.v1", approvalPolicy, { repoRoot });
  assertRegistryHandlerParity(registry, commandHandlers);
  const command = registeredCommand(registry, commandKey);
  const targetPolicy = targetPolicies.policies.find(
    ({ policyId }) => policyId === request.targetPolicyId
  );
  if (!targetPolicy) throw launchError("RUNNER_TARGET_POLICY_REJECTED");

  const executionState =
    suppliedExecutionState ??
    createExecutionState({
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey
    });
  if (
    executionJournal?.trustPolicy !== "append-only-execution-state/v1" ||
    typeof executionJournal.append !== "function"
  ) {
    throw launchError("EXECUTION_JOURNAL_UNAVAILABLE");
  }

  // This trust-root and target-intent check intentionally happens before any approval or secret I/O.
  let preflightDecision;
  try {
    preflightDecision = verifyPreflight({ command, request, policy: targetPolicy });
  } catch (error) {
    const rejected = transitionExecution(executionState, {
      type: "PREFLIGHT_REJECTED",
      attemptId: request.attemptId,
      phase: request.phase,
      reasonCode: error?.code ?? "RUNNER_PREFLIGHT_REJECTED"
    });
    await appendLauncherState(executionJournal, rejected);
    throw error;
  }

  let approvalDecision;
  if (preflightDecision.approvalMode === "none") {
    const readOnlyDryRun = request.phase === "dry-run" && command.supports?.dryRun === true;
    if (
      (command.dataImpact !== "read-only" && !readOnlyDryRun) ||
      approvalRecord !== undefined ||
      approvalAttestation !== undefined ||
      githubClient !== undefined
    ) {
      throw launchError("RUNNER_APPROVAL_MODE_INVALID");
    }
  } else {
    if (approvalRecord?.approvalMode !== preflightDecision.approvalMode) {
      throw launchError("APPROVAL_MODE_MISMATCH");
    }
    if (
      revocationCheckpointStore?.trustPolicy !== "append-only-monotonic/v1" ||
      typeof revocationCheckpointStore.read !== "function" ||
      typeof revocationCheckpointStore.writeMonotonic !== "function"
    ) {
      throw launchError("APPROVAL_REVOCATIONS_CHECKPOINT_UNAVAILABLE");
    }
    const previouslyObserved = await revocationCheckpointStore.read(approvalPolicy.policyId);
    const verifiedRevocations = await fetchLatestTrustedRevocations({
      policy: approvalPolicy,
      githubClient,
      previouslyObserved,
      now
    });
    const checkpointResult = await revocationCheckpointStore.writeMonotonic({
      policyId: approvalPolicy.policyId,
      sequence: verifiedRevocations.sequence,
      artifactDigest: verifiedRevocations.artifactDigest
    });
    if (checkpointResult?.accepted !== true) {
      throw launchError("APPROVAL_REVOCATIONS_CHECKPOINT_UNAVAILABLE");
    }
    approvalDecision = await verifyApproval({
      record: approvalRecord,
      policy: approvalPolicy,
      attestation: approvalAttestation,
      attestationVerifier: approvalAttestationVerifier,
      custodyReceipt: approvalCustodyReceipt,
      verifiedRevocations,
      expected: approvalExpected({
        command,
        request,
        approvalPolicy,
        approvalMode: preflightDecision.approvalMode
      }),
      now
    });
  }

  try {
    return await executeRegisteredCommand({
      command,
      request,
      policy: targetPolicy,
      approvalDecision,
      handler: handler ?? commandHandlers.get(commandKey),
      readCredential,
      connectDatabase,
      credentialFileReference
    });
  } catch (error) {
    if (error?.outcomeUnknown === true) {
      const unknown = transitionExecution(executionState, {
        type: "PROCESS_LOST",
        commitState: error.commitState ?? "unknown"
      });
      await appendLauncherState(executionJournal, unknown);
    }
    throw error;
  }
}

async function main() {
  throw launchError("RUNNER_TRUSTED_LAUNCH_ADAPTERS_REQUIRED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "RUNNER_TRUSTED_LAUNCH_FAILED"}\n`);
    process.exitCode = 1;
  });
}
