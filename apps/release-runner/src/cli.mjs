#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildExecutionProof,
  buildPostStateObservation,
  sha256Canonical
} from "@subscription-saas/release-foundation";

import { commandDependencyVerifiers, commandHandlers } from "./command-handlers.mjs";
import {
  assertRegistryDependencyVerifierParity,
  assertRegistryHandlerParity,
  loadCommandRegistry,
  loadTargetPolicies,
  registeredCommand
} from "./command-registry.mjs";
import { runnerError } from "./error-codes.mjs";
import { createRuntimeAdapters } from "./runtime-adapters.mjs";
import { runTrustedEntrypoint } from "./trusted-entrypoint.mjs";

function parseInvocation(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "execute" ||
    !/^[a-z][a-z0-9.-]+@[1-9][0-9]*$/.test(argv[1] ?? "") ||
    argv[2] !== "--request-file" ||
    typeof argv[3] !== "string" ||
    argv[3].length === 0
  ) {
    throw runnerError("RUNNER_COMMAND_NOT_REGISTERED");
  }
  return Object.freeze({ commandKey: argv[1], requestFile: argv[3] });
}

async function defaultExecute({ commandKey, requestFile }) {
  const [registry, policies, raw] = await Promise.all([
    loadCommandRegistry(),
    loadTargetPolicies(),
    readFile(path.resolve(requestFile), "utf8")
  ]);
  assertRegistryHandlerParity(registry, commandHandlers);
  assertRegistryDependencyVerifierParity(registry, commandDependencyVerifiers);
  const command = registeredCommand(registry, commandKey);
  const request = JSON.parse(raw);
  const policy = policies.policies.find(({ policyId }) => policyId === request.targetPolicyId);
  if (!policy) throw runnerError("RUNNER_TARGET_POLICY_REJECTED");
  throw runnerError("RUNNER_TRUSTED_LAUNCHER_REQUIRED", {
    command: `${command.commandId}@${command.commandVersion}`
  });
}

export async function runCli(argv, { execute = defaultExecute } = {}) {
  const result = await execute(parseInvocation(argv));
  return finalizeRunnerExecution(result);
}

export async function runProductionEntrypoint({
  argv = [],
  environment = process.env,
  adapters,
  createAdapters = createRuntimeAdapters,
  executeTrusted = runTrustedEntrypoint
} = {}) {
  const envelopeFile = environment.RUNNER_LAUNCH_ENVELOPE_FILE;
  const runtimeAdapters =
    adapters ?? (argv.length === 0 && envelopeFile ? createAdapters() : undefined);
  const result = await executeTrusted({
    envelopeFile,
    argv,
    adapters: runtimeAdapters
  });
  return finalizeRunnerExecution(result);
}

export function finalizeRunnerExecution(result) {
  const hasObservation = result?.postStateObservationInput !== undefined;
  const hasProof = result?.executionProofInput !== undefined;
  if (!hasObservation && !hasProof) return result;
  if (!hasObservation || !hasProof) throw runnerError("RUNNER_PROOF_INPUT_INCOMPLETE");
  const postStateObservation = buildPostStateObservation(result.postStateObservationInput);
  const executionProof = buildExecutionProof({
    postStateObservation,
    ...result.executionProofInput
  });
  const { postStateObservationInput, executionProofInput, ...output } = result;
  return Object.freeze({
    ...output,
    postStateObservation,
    postStateObservationDigest: sha256Canonical(postStateObservation),
    executionProof,
    executionProofDigest: sha256Canonical(executionProof)
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runProductionEntrypoint({ argv: process.argv.slice(2) })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error?.code ?? "RUNNER_FAILED"}\n`);
      process.exitCode = 1;
    });
}
