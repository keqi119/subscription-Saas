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
import * as historicalCatalogs from "../src/catalogs.mjs";
import { sha256Bytes } from "../src/digest.mjs";
import {
  APPROVED_R3_INCIDENT_B7A1429C,
  APPROVED_R3_INCIDENT_94D22196,
  approvedR3HistoricalContractCompatibility
} from "../src/manual-r3-incident.mjs";

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

test("471 incident historical compatibility authenticates the fixed source catalog", async () => {
  const bytes = await readFile(new URL("./fixtures/r3-catalogs-233d237.mjs.txt", import.meta.url));
  const p = APPROVED_R3_INCIDENT_94D22196;
  const compatibility = approvedR3HistoricalContractCompatibility({
    operationRef: p.operationRef,
    profileDigest: p.profileDigest,
    sourceSha: p.lockScope.sourceSha,
    proofRawDigest: p.lockScope.buildProofDigest,
    materialRawDigest: "sha256:4b82c04459d070cb11e34704a55114cd6c792eb39177990f6773680683bc9a84",
    creationSpecDigest: p.lockScope.creationSpecDigest,
    jobAdmissionDigest: p.lockScope.jobAdmissionDigest
  });
  assert.equal(sha256Bytes(bytes), compatibility.catalogRawDigest);
  assert.equal(compatibility.sourceRoot, "/opt/stage1-r3-candidate-471796a3");
  await withTempRepo(async (root) => {
    await writeRepositoryContractFixture(root, [
      "release/contracts/repository-contract-files.v1.json",
      "release/contracts/schemas/example.json"
    ]);
    assert.equal(
      (
        await historicalCatalogs.computeHistoricalRepositoryContract(root, {
          catalogBytes: bytes,
          catalogRawDigest: compatibility.catalogRawDigest
        })
      ).entries.length,
      2
    );
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    await assert.rejects(
      historicalCatalogs.computeHistoricalRepositoryContract(root, {
        catalogBytes: changed,
        catalogRawDigest: compatibility.catalogRawDigest
      }),
      { code: "CONTRACT_HISTORICAL_CATALOG_CHANGED" }
    );
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

test("repository contract binds every protected release evidence producer", async () => {
  const manifest = await loadContractFileManifest(repoRoot);
  for (const workflow of [
    ".github/workflows/docker-images.yml",
    ".github/workflows/release-operation-approval.yml",
    ".github/workflows/release-approval-revocations.yml",
    ".github/workflows/sanitized-snapshot.yml"
  ]) {
    assert.ok(manifest.files.includes(workflow), workflow);
  }
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

test("shared R3 hosted and native diagnostic static imports are contract-bound", async () => {
  const manifest = await loadContractFileManifest(repoRoot);
  const declared = new Set(manifest.files);
  for (const entry of [
    "scripts/release/run-r3-source-fresh.mjs",
    "scripts/release/diagnose-r3-native-workspace.mjs"
  ]) {
    const source = await readFile(path.join(repoRoot, entry), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu)) {
      const dependency = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry), specifier)
      );
      assert.ok(declared.has(dependency), `${entry} imports unbound ${dependency}`);
    }
  }
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

test("repository contract binds the final release gate entry points", async () => {
  await withTempRepo(async (root) => {
    const manifestPath = "release/contracts/repository-contract-files.v1.json";
    const composePath = "docker-compose.release-gate.yml";
    await writeRepositoryContractFixture(root, [
      composePath,
      manifestPath,
      "release/contracts/schemas/example.json"
    ]);
    await writeFile(path.join(root, composePath), "services: {}\n", "utf8");
    const before = await computeRepositoryContract(root);
    await writeFile(path.join(root, composePath), "services: { api: {} }\n", "utf8");
    const after = await computeRepositoryContract(root);
    assert.notEqual(after.digest, before.digest);
  });
});

test("historical repository discovery uses only a pinned literal old entrypoint list", async () => {
  await withTempRepo(async (root) => {
    const manifestPath = "release/contracts/repository-contract-files.v1.json";
    const legacy = "scripts/release/legacy.mjs";
    await writeRepositoryContractFixture(
      root,
      [manifestPath, "release/contracts/schemas/example.json", legacy].sort()
    );
    await mkdir(path.join(root, "scripts/release"), { recursive: true });
    await writeFile(path.join(root, legacy), "export const old = true;\n");
    await writeFile(
      path.join(root, "scripts/release/r3-startup-detail-timing.mjs"),
      "export const newer = true;\n"
    );
    await assert.rejects(computeRepositoryContract(root), { code: "CONTRACT_FILE_SET_DRIFT" });
    assert.equal(typeof historicalCatalogs.computeHistoricalRepositoryContract, "function");
    const catalogBytes = Buffer.from(
      'const RELEASE_GATE_ENTRY_POINTS = Object.freeze([\n  "scripts/release/legacy.mjs",\n]);\n'
    );
    const input = { catalogBytes, catalogRawDigest: sha256Bytes(catalogBytes) };
    const old = await historicalCatalogs.computeHistoricalRepositoryContract(root, input);
    assert.equal(old.entries.length, 3);
    await writeFile(path.join(root, legacy), "export const old = false;\n");
    assert.notEqual(
      (await historicalCatalogs.computeHistoricalRepositoryContract(root, input)).digest,
      old.digest
    );
    await writeFile(path.join(root, "release/contracts/schemas/extra.json"), "{}\n");
    await assert.rejects(historicalCatalogs.computeHistoricalRepositoryContract(root, input), {
      code: "CONTRACT_FILE_SET_DRIFT"
    });
  });
});

test("1c historical compatibility authenticates its original catalog bytes", async () => {
  // Exact bytes from Git object 1c8ecfdc52c46fa1c6ead634fe2c6eaa1b664825:
  // packages/release-foundation/src/catalogs.mjs; SHA-256 independently
  // confirmed against the clean installed H1 source checkout.
  const catalogBytes = await readFile(
    new URL("./fixtures/r3-catalogs-1c8ecfd.mjs.txt", import.meta.url)
  );
  assert.equal(
    sha256Bytes(catalogBytes),
    "sha256:0c5ba9cace38336b6ffb80c4d4d9e9de6a6ca71c91129f5a7a6a2205fca60280"
  );
  const old = APPROVED_R3_INCIDENT_B7A1429C;
  const compatibility = approvedR3HistoricalContractCompatibility({
    operationRef: old.operationRef,
    profileDigest: old.profileDigest,
    sourceSha: old.lockScope.sourceSha,
    proofRawDigest: "sha256:24191b964fff0a79c8b9a5553279b6230e6f78b29597d8bdb1950e7a0a8f0287",
    materialRawDigest: "sha256:bfe57da0fe69bd47162e3281186dfa0c3b8c57bdca944b97cf558317b6934fd2",
    creationSpecDigest: old.lockScope.creationSpecDigest,
    jobAdmissionDigest: old.lockScope.jobAdmissionDigest
  });
  assert.ok(compatibility);
  await withTempRepo(async (root) => {
    await writeRepositoryContractFixture(root, [
      "release/contracts/repository-contract-files.v1.json",
      "release/contracts/schemas/example.json"
    ]);
    const contract = await historicalCatalogs.computeHistoricalRepositoryContract(root, {
      catalogBytes,
      catalogRawDigest: compatibility.catalogRawDigest
    });
    assert.equal(contract.entries.length, 2);
    const tampered = Buffer.from(catalogBytes);
    tampered[0] ^= 1;
    await assert.rejects(
      historicalCatalogs.computeHistoricalRepositoryContract(root, {
        catalogBytes: tampered,
        catalogRawDigest: compatibility.catalogRawDigest
      }),
      { code: "CONTRACT_HISTORICAL_CATALOG_CHANGED" }
    );
    const duplicated = Buffer.concat([
      catalogBytes,
      Buffer.from("\nconst RELEASE_GATE_ENTRY_POINTS = Object.freeze([]);\n")
    ]);
    await assert.rejects(
      historicalCatalogs.computeHistoricalRepositoryContract(root, {
        catalogBytes: duplicated,
        catalogRawDigest: sha256Bytes(duplicated)
      }),
      { code: "CONTRACT_HISTORICAL_CATALOG_INVALID" }
    );
    const sameLineDuplicate = Buffer.concat([
      catalogBytes,
      Buffer.from("\n]); const RELEASE_GATE_ENTRY_POINTS = Object.freeze([]);\n")
    ]);
    await assert.rejects(
      historicalCatalogs.computeHistoricalRepositoryContract(root, {
        catalogBytes: sameLineDuplicate,
        catalogRawDigest: sha256Bytes(sameLineDuplicate)
      }),
      { code: "CONTRACT_HISTORICAL_CATALOG_INVALID" }
    );
  });
});

test("historical catalog parser rejects changed bytes and executable list syntax", async () => {
  await withTempRepo(async (root) => {
    await writeRepositoryContractFixture(root, [
      "release/contracts/repository-contract-files.v1.json",
      "release/contracts/schemas/example.json"
    ]);
    assert.equal(typeof historicalCatalogs.computeHistoricalRepositoryContract, "function");
    const valid = Buffer.from(
      'const RELEASE_GATE_ENTRY_POINTS = Object.freeze(["scripts/release/legacy.mjs"]);'
    );
    await assert.rejects(
      historicalCatalogs.computeHistoricalRepositoryContract(root, {
        catalogBytes: valid,
        catalogRawDigest: `sha256:${"0".repeat(64)}`
      }),
      { code: "CONTRACT_HISTORICAL_CATALOG_CHANGED" }
    );
    for (const body of [
      '"scripts/release/a.mjs", ...more',
      '"scripts/release/a.mjs" // comment',
      '"scripts/release/a\\x2emjs"',
      '"scripts/release/a.mjs", "scripts/release/a.mjs"',
      '"../outside.mjs"',
      '"scripts/release/a.mjs" + "suffix"'
    ]) {
      const catalogBytes = Buffer.from(
        `const RELEASE_GATE_ENTRY_POINTS = Object.freeze([${body}]);`
      );
      await assert.rejects(
        historicalCatalogs.computeHistoricalRepositoryContract(root, {
          catalogBytes,
          catalogRawDigest: sha256Bytes(catalogBytes)
        }),
        { code: "CONTRACT_HISTORICAL_CATALOG_INVALID" }
      );
    }
  });
});
