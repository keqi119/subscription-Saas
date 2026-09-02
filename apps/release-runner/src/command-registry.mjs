import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical, validateContract } from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function loadCommandRegistry(root = repoRoot) {
  const registry = JSON.parse(
    await readFile(path.join(root, "release/contracts/command-registry.v1.json"), "utf8")
  );
  validateContract("command-registry.v1", registry, { repoRoot: root });
  return Object.freeze({
    ...registry,
    commands: Object.freeze(registry.commands.map((command) => Object.freeze({ ...command })))
  });
}

export async function loadTargetPolicies(root = repoRoot) {
  const policies = JSON.parse(
    await readFile(path.join(root, "release/contracts/target-policies.v1.json"), "utf8")
  );
  validateContract("target-policies.v1", policies, { repoRoot: root });
  return policies;
}

export function assertRegistryHandlerParity(registry, handlers) {
  const declared = registry.commands
    .map(({ commandId, commandVersion }) => `${commandId}@${commandVersion}`)
    .sort();
  const implemented = [...handlers.keys()].sort();
  if (!isDeepStrictEqual(declared, implemented)) {
    throw runnerError("RUNNER_REGISTRY_HANDLER_DRIFT", { declared, implemented });
  }
}

export function assertRegistryDependencyVerifierParity(registry, verifiers) {
  const declared = registry.commands
    .filter(({ dependencyContract }) => dependencyContract)
    .map(({ commandId, commandVersion }) => `${commandId}@${commandVersion}`)
    .sort();
  const implemented = [...verifiers.keys()].sort();
  if (!isDeepStrictEqual(declared, implemented)) {
    throw runnerError("RUNNER_REGISTRY_DEPENDENCY_VERIFIER_DRIFT", {
      declared,
      implemented
    });
  }
}

export function registeredCommand(registry, commandKey) {
  const command = registry.commands.find(
    ({ commandId, commandVersion }) => `${commandId}@${commandVersion}` === commandKey
  );
  if (!command) throw runnerError("RUNNER_COMMAND_NOT_REGISTERED");
  return command;
}

export function commandApprovalMode(command, environmentClass, phase) {
  if (phase === "dry-run" && command.supports?.dryRun === true) return "none";
  return command.approvalModeOverrides?.[environmentClass] ?? command.approvalMode;
}

export function assertCommandVersionEvolution(previous, next) {
  const previousByKey = new Map(
    previous.commands.map((command) => [
      `${command.commandId}@${command.commandVersion}`,
      sha256Canonical(command)
    ])
  );
  for (const command of next.commands) {
    const key = `${command.commandId}@${command.commandVersion}`;
    const releasedDigest = previousByKey.get(key);
    if (releasedDigest && releasedDigest !== sha256Canonical(command)) {
      throw runnerError("RUNNER_COMMAND_VERSION_IMMUTABLE", { key });
    }
  }
}
