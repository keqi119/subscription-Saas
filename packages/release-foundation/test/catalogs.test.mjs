import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeMigrationCatalog,
  computeRepositoryContract,
  loadContractFileManifest,
  verifyMigrationCatalog
} from "../src/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function withTempRepo(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "release-foundation-catalog-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeMigration(root, name, sql) {
  const directory = path.join(root, "apps", "api", "prisma", "migrations", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "migration.sql"), sql, "utf8");
}

async function writeRepositoryContractFixture(root, files) {
  const contractDirectory = path.join(root, "release", "contracts");
  await mkdir(path.join(contractDirectory, "schemas"), { recursive: true });
  await writeFile(
    path.join(contractDirectory, "repository-contract-files.v1.json"),
    `${JSON.stringify({ contractVersion: "repository-contract-files.v1", files }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(contractDirectory, "schemas", "example.json"), "{}\n", "utf8");
}

test("migration catalog is path ordered and content addressed", async () => {
  await withTempRepo(async (root) => {
    await writeMigration(root, "20260102000000_second", "SELECT 2;\n");
    await writeMigration(root, "20260101000000_first", "SELECT 1;\n");

    const catalog = await computeMigrationCatalog(root);
    assert.deepEqual(
      catalog.entries.map(({ order, path: relativePath }) => ({ order, relativePath })),
      [
        {
          order: 1,
          relativePath: "apps/api/prisma/migrations/20260101000000_first/migration.sql"
        },
        {
          order: 2,
          relativePath: "apps/api/prisma/migrations/20260102000000_second/migration.sql"
        }
      ]
    );
    assert.match(catalog.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(catalog.entries.every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.sha256)));
  });
});

test("migration verification rejects checksum drift", async () => {
  await withTempRepo(async (root) => {
    await writeMigration(root, "20260101000000_first", "SELECT 1;\n");
    const approved = await computeMigrationCatalog(root);
    await writeMigration(root, "20260101000000_first", "SELECT 99;\n");
    await assert.rejects(verifyMigrationCatalog(root, approved), {
      code: "MIGRATION_CATALOG_DRIFT"
    });
  });
});

test("migration verification rejects ordering drift", async () => {
  await withTempRepo(async (root) => {
    await writeMigration(root, "20260102000000_second", "SELECT 2;\n");
    const approved = await computeMigrationCatalog(root);
    await writeMigration(root, "20260101000000_first", "SELECT 1;\n");
    await assert.rejects(verifyMigrationCatalog(root, approved), {
      code: "MIGRATION_CATALOG_DRIFT"
    });
  });
});

test("migration catalog rejects an invalid ordering identity", async () => {
  await withTempRepo(async (root) => {
    await writeMigration(root, "not-a-timestamp", "SELECT 1;\n");
    await assert.rejects(computeMigrationCatalog(root), {
      code: "MIGRATION_DIRECTORY_INVALID"
    });
  });
});

test("repository contract rejects an omitted contract file", async () => {
  const manifest = await loadContractFileManifest(repoRoot);
  const omitted = manifest.files.find((file) => file.endsWith("execution-proof.v1.schema.json"));
  assert.ok(omitted);
  await assert.rejects(computeRepositoryContract(repoRoot, { ignore: omitted }), {
    code: "CONTRACT_FILE_SET_DRIFT"
  });
});

test("repository manifest rejects duplicate paths", async () => {
  await withTempRepo(async (root) => {
    const manifestPath = "release/contracts/repository-contract-files.v1.json";
    await writeRepositoryContractFixture(root, [
      manifestPath,
      "release/contracts/schemas/example.json",
      "release/contracts/schemas/example.json"
    ]);
    await assert.rejects(loadContractFileManifest(root), {
      code: "CONTRACT_FILE_DUPLICATE"
    });
  });
});

test("repository contract rejects missing and unclassified files", async () => {
  await withTempRepo(async (root) => {
    const manifestPath = "release/contracts/repository-contract-files.v1.json";
    await writeRepositoryContractFixture(root, [
      manifestPath,
      "release/contracts/schemas/missing.json"
    ]);
    await assert.rejects(computeRepositoryContract(root), {
      code: "CONTRACT_FILE_MISSING"
    });

    await writeRepositoryContractFixture(root, [manifestPath]);
    await assert.rejects(computeRepositoryContract(root), {
      code: "CONTRACT_FILE_SET_DRIFT"
    });
  });
});

test("repository digest changes when a declared contract changes", async () => {
  await withTempRepo(async (root) => {
    const files = [
      "release/contracts/repository-contract-files.v1.json",
      "release/contracts/schemas/example.json"
    ];
    await writeRepositoryContractFixture(root, files);
    const before = await computeRepositoryContract(root);
    await writeFile(
      path.join(root, "release", "contracts", "schemas", "example.json"),
      '{"v":1}\n'
    );
    const after = await computeRepositoryContract(root);
    assert.notEqual(after.digest, before.digest);

    const bytes = await readFile(
      path.join(root, "release", "contracts", "repository-contract-files.v1.json")
    );
    assert.ok(bytes.length > 0);
  });
});
