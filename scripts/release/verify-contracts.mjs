#!/usr/bin/env node

import { readFile } from "node:fs/promises";

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
  validateContract("postgres-image.v1", postgresContract, { repoRoot });
  process.stdout.write(
    `${JSON.stringify({
      migrationCatalogDigest: migrationCatalog.digest,
      migrationCount: migrationCatalog.entries.length,
      repositoryContractDigest: repositoryContract.digest,
      repositoryContractFileCount: repositoryContract.entries.length,
      schemaCount: schemas.schemaIds.length
    })}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "RELEASE_CONTRACT_VERIFY_FAILED"}\n`);
  process.exitCode = 1;
});
