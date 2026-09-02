#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  compileAllSchemas,
  computeMigrationCatalog,
  computeRepositoryContract,
  validateContract
} from "../../packages/release-foundation/src/index.mjs";

async function main() {
  const repoRoot = process.cwd();
  const schemas = compileAllSchemas(repoRoot);
  const migrationCatalog = await computeMigrationCatalog(repoRoot);
  const repositoryContract = await computeRepositoryContract(repoRoot);
  const postgresContract = JSON.parse(
    await readFile(
      new URL("../../release/contracts/postgres-image.v1.json", import.meta.url),
      "utf8"
    )
  );
  const approvalPolicy = JSON.parse(
    await readFile(
      new URL("../../release/contracts/approval-policies.v1.json", import.meta.url),
      "utf8"
    )
  );
  const commandRegistry = JSON.parse(
    await readFile(
      new URL("../../release/contracts/command-registry.v1.json", import.meta.url),
      "utf8"
    )
  );
  validateContract("postgres-image.v1", postgresContract, { repoRoot });
  validateContract("approval-policy.v1", approvalPolicy, { repoRoot });
  validateContract("command-registry.v1", commandRegistry, { repoRoot });
  const commandContractDirectory = path.join(repoRoot, "release/contracts/command-contracts");
  const commandContractFiles = (await readdir(commandContractDirectory))
    .filter((file) => file.endsWith(".json"))
    .sort();
  for (const file of commandContractFiles) {
    const commandContract = JSON.parse(
      await readFile(path.join(commandContractDirectory, file), "utf8")
    );
    validateContract("runner-command-contract.v1", commandContract, { repoRoot });
    const registered = commandRegistry.commands.find(
      ({ commandId, commandVersion }) =>
        commandId === commandContract.commandId && commandVersion === commandContract.commandVersion
    );
    const approvalByEnvironment = Object.fromEntries(
      (registered?.allowedEnvironments ?? []).map((environment) => [
        environment,
        registered.approvalModeOverrides?.[environment] ?? registered.approvalMode
      ])
    );
    if (
      registered?.capabilityProfile !== commandContract.capabilityProfile ||
      registered?.dataImpact !== commandContract.dataImpact ||
      JSON.stringify(registered?.allowedExecutionScopes) !==
        JSON.stringify(commandContract.allowedExecutionScopes) ||
      JSON.stringify(approvalByEnvironment) !==
        JSON.stringify(commandContract.approvalByEnvironment) ||
      registered?.timeoutMs !== commandContract.timeoutMs ||
      registered?.lock !== commandContract.lock.id ||
      registered?.evidenceSchema !== commandContract.evidenceSchema ||
      registered?.owner !== commandContract.owner ||
      registered?.exitCondition !== commandContract.exitCondition
    ) {
      throw Object.assign(new Error("COMMAND_CONTRACT_REGISTRY_MISMATCH"), {
        code: "COMMAND_CONTRACT_REGISTRY_MISMATCH",
        details: { file, commandId: commandContract.commandId }
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      migrationCatalogDigest: migrationCatalog.digest,
      migrationCount: migrationCatalog.entries.length,
      repositoryContractDigest: repositoryContract.digest,
      repositoryContractFileCount: repositoryContract.entries.length,
      schemaCount: schemas.schemaIds.length,
      commandContractCount: commandContractFiles.length
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "RELEASE_CONTRACT_VERIFY_FAILED"}\n`);
  process.exitCode = 1;
});
