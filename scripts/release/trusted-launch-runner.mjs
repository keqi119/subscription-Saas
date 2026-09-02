#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  fetchLatestTrustedRevocations,
  sha256Canonical,
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

function approvalExpected({ command, request, approvalPolicy }) {
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
    approvalMode: command.approvalMode,
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

  // This trust-root and target-intent check intentionally happens before any approval or secret I/O.
  verifyPreflight({ command, request, policy: targetPolicy });

  let approvalDecision;
  if (command.approvalMode === "none") {
    if (
      command.dataImpact !== "read-only" ||
      approvalRecord !== undefined ||
      approvalAttestation !== undefined ||
      githubClient !== undefined
    ) {
      throw launchError("RUNNER_APPROVAL_MODE_INVALID");
    }
  } else {
    if (approvalRecord?.approvalMode !== command.approvalMode) {
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
      expected: approvalExpected({ command, request, approvalPolicy }),
      now
    });
  }

  return executeRegisteredCommand({
    command,
    request,
    policy: targetPolicy,
    approvalDecision,
    handler: handler ?? commandHandlers.get(commandKey),
    readCredential,
    connectDatabase,
    credentialFileReference
  });
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
