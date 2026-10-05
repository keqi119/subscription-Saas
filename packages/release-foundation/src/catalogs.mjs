import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";

const CONTRACT_MANIFEST_PATH = "release/contracts/repository-contract-files.v1.json";
const MIGRATION_PATH = "apps/api/prisma/migrations";
const RELEASE_GATE_ENTRY_POINTS = Object.freeze([
  ".github/workflows/docker-images.yml",
  ".github/workflows/release-approval-revocations.yml",
  ".github/workflows/release-candidate-gate.yml",
  ".github/workflows/release-final-chain.yml",
  ".github/workflows/release-operation-approval.yml",
  ".github/workflows/release-owner-attestations.yml",
  ".github/workflows/sanitized-snapshot.yml",
  "Dockerfile.runner",
  "apps/release-runner/package.json",
  "apps/release-runner/src/cli.mjs",
  "apps/release-runner/src/database-runtime-adapter.mjs",
  "apps/release-runner/src/database-test-entrypoint.mjs",
  "apps/release-runner/src/database-test-envelope.mjs",
  "apps/release-runner/src/final-database-manifest.mjs",
  "apps/release-runner/src/final-database-runtime.mjs",
  "apps/release-runner/src/final-migration-entrypoint.mjs",
  "apps/release-runner/src/final-migration-input.mjs",
  "apps/release-runner/src/final-migration-process.mjs",
  "apps/release-runner/src/final-migration-runtime.mjs",
  "apps/release-runner/src/final-migration-session.mjs",
  "apps/release-runner/src/final-runtime-entrypoint.mjs",
  "apps/release-runner/src/final-runtime-preparation.mjs",
  "apps/release-runner/src/manual-command-adapter.mjs",
  "apps/release-runner/src/manual-target-observer.mjs",
  "apps/release-runner/src/postgres-connector.mjs",
  "apps/release-runner/src/reference-paths.mjs",
  "apps/release-runner/src/runtime-adapters.mjs",
  "apps/release-runner/src/trusted-entrypoint.mjs",
  "apps/release-runner/test/manual/manual-runner-migration-postgres.integration.test.mjs",
  "apps/release-runner/test/manual/manual-runner-verification-postgres.integration.test.mjs",
  "docker-compose.release-gate.yml",
  "packages/release-foundation/test/database-lifecycle.postgres.test.mjs",
  "packages/release-foundation/test/r3-lifecycle-adapter-slot.mjs",
  "playwright.release.config.ts",
  "pnpm-lock.yaml",
  "scripts/release/aggregate-release-proof.mjs",
  "scripts/release/assemble-release-aggregate-input.mjs",
  "scripts/release/assemble-s1-exit-input.mjs",
  "scripts/release/bootstrap-controlled-postgres.mjs",
  "scripts/release/database-test-launcher-runtime.mjs",
  "scripts/release/create-build-proof.mjs",
  "scripts/release/create-final-attempt-history.mjs",
  "scripts/release/dispatch-evidence-oss-storage.mjs",
  "scripts/release/dispatch-evidence-scope.mjs",
  "scripts/release/evidence-archive-ram-policy.mjs",
  "scripts/release/export-final-compose-environment.mjs",
  "scripts/release/export-sanitized-snapshot.mjs",
  "scripts/release/final-compose-database-adapters.mjs",
  "scripts/release/final-compose-application-adapters.mjs",
  "scripts/release/final-compose-custody-adapters.mjs",
  "scripts/release/final-compose-production-adapters.mjs",
  "scripts/release/generate-s1-exit-evidence.mjs",
  "scripts/release/launch-manual-stage1.mjs",
  "scripts/release/maintenance/stage1-r3-evidence-account.sh",
  "scripts/release/manual-build-custody-producer.mjs",
  "scripts/release/manual-build-custody-storage.mjs",
  "scripts/release/manual-expected-schema-producer.mjs",
  "scripts/release/manual-runner-source-inputs.mjs",
  "scripts/release/manual-stage1-trust.mjs",
  "scripts/release/verify-manual-runner-result.mjs",
  "scripts/release/prepare-final-compose-launch.mjs",
  "scripts/release/prepare-h1-snapshot-host.py",
  "scripts/release/r3-application-bootstrap.mjs",
  "scripts/release/r3-application-containers.mjs",
  "scripts/release/r3-application-originals.mjs",
  "scripts/release/r3-application-tls.mjs",
  "scripts/release/r3-browser-packages.mjs",
  "scripts/release/r3-browser-runtime.mjs",
  "scripts/release/r3-snapshot-input-admission.mjs",
  "scripts/release/r3-snapshot-payload.mjs",
  "scripts/release/r3-containerd-observation.mjs",
  "scripts/release/r3-database-targets.mjs",
  "scripts/release/r3-destination.mjs",
  "scripts/release/r3-encrypted-workspace-observer.mjs",
  "scripts/release/r3-h1-forward-lease.mjs",
  "scripts/release/r3-h1-snapshot-decrypt.mjs",
  "scripts/release/r3-engine-attach.mjs",
  "scripts/release/r3-engine-exchange.mjs",
  "scripts/release/r3-evidence-delivery.mjs",
  "scripts/release/r3-h1-evidence-delivery.mjs",
  "scripts/release/r3-hosted-evidence-delivery.mjs",
  "scripts/release/r3-operation-inputs.mjs",
  "scripts/release/r3-final-migration-channel.mjs",
  "scripts/release/r3-final-application.mjs",
  "scripts/release/r3-final-evidence.mjs",
  "scripts/release/r3-final-migration-container.mjs",
  "scripts/release/r3-final-migration-result.mjs",
  "scripts/release/r3-final-result.mjs",
  "scripts/release/r3-final-runtime-channel.mjs",
  "scripts/release/r3-final-suite-result.mjs",
  "scripts/release/r3-remote-snapshot-copy.mjs",
  "scripts/release/r3-remote-snapshot-restore.mjs",
  "scripts/release/r3-hosted-creation-control.mjs",
  "scripts/release/r3-hosted-workspace-create.mjs",
  "scripts/release/r3-lifecycle-adapter.mjs",
  "scripts/release/r3-lifecycle-channel.mjs",
  "scripts/release/r3-lifecycle-test-runner.mjs",
  "scripts/release/r3-source-suite.mjs",
  "scripts/release/r3-source-result.mjs",
  "scripts/release/r3-postgres-observation.mjs",
  "scripts/release/run-final-compose-gate.mjs",
  "scripts/release/run-r3-source-fresh.mjs",
  "scripts/release/snapshot-h1-container-hook.js",
  "scripts/release/snapshot-h1-control.py",
  "scripts/release/snapshot-h1-data-worker.mjs",
  "scripts/release/snapshot-h1-dispatch-journal.mjs",
  "scripts/release/snapshot-h1-github-jwt.mjs",
  "scripts/release/snapshot-h1-github-query.py",
  "scripts/release/snapshot-h1-github-reader.mjs",
  "scripts/release/snapshot-h1-github.py",
  "scripts/release/snapshot-h1-job-client.mjs",
  "scripts/release/snapshot-h1-key-volume.mjs",
  "scripts/release/snapshot-h1-observations.mjs",
  "scripts/release/snapshot-h1-route-journal.py",
  "scripts/release/snapshot-h1-runner-entry.mjs",
  "scripts/release/snapshot-h1-runner.py",
  "scripts/release/snapshot-h1-runtime-bundle.mjs",
  "scripts/release/snapshot-h1-signing.mjs",
  "scripts/release/snapshot-h1-volume.py",
  "scripts/release/snapshot-oss-storage.mjs",
  "scripts/release/snapshot-postgres-tools.mjs",
  "scripts/release/trusted-launch-production-adapters.mjs",
  "scripts/release/trusted-launch-runner.mjs",
  "scripts/release/verify-build-delivery.mjs",
  "scripts/release/verify-build-materials.mjs",
  "scripts/release/verify-build-proof.mjs",
  "scripts/release/verify-compose-policy.mjs",
  "scripts/release/workflow-custody-record.mjs",
  "tests/release/web-public-api.spec.ts"
]);

function codeError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function toRepositoryPath(value) {
  return value.split(path.sep).join("/");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertRepositoryPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    throw codeError("CONTRACT_FILE_PATH_INVALID", { path: value });
  }
}

async function listFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/"));
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const result = [];
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) result.push(relativePath);
  }
  return result.sort(comparePaths);
}

async function discoverRepositoryContractFiles(repoRoot) {
  const contractFiles = await listFiles(repoRoot, "release/contracts");
  const foundationFiles = ["packages/release-foundation/package.json"];
  foundationFiles.push(...(await listFiles(repoRoot, "packages/release-foundation/src")));
  const existingFoundationFiles = [];
  for (const relativePath of foundationFiles) {
    try {
      await readFile(path.join(repoRoot, ...relativePath.split("/")));
      existingFoundationFiles.push(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const existingReleaseGateEntryPoints = [];
  for (const relativePath of RELEASE_GATE_ENTRY_POINTS) {
    try {
      await readFile(path.join(repoRoot, ...relativePath.split("/")));
      existingReleaseGateEntryPoints.push(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [
    ...new Set([...contractFiles, ...existingFoundationFiles, ...existingReleaseGateEntryPoints])
  ].sort(comparePaths);
}

export async function loadContractFileManifest(repoRoot) {
  const absolutePath = path.join(repoRoot, ...CONTRACT_MANIFEST_PATH.split("/"));
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw codeError("CONTRACT_MANIFEST_MISSING");
    if (error instanceof SyntaxError) throw codeError("CONTRACT_MANIFEST_INVALID_JSON");
    throw error;
  }
  if (
    parsed?.contractVersion !== "repository-contract-files.v1" ||
    !Array.isArray(parsed.files) ||
    Object.keys(parsed).some((key) => !["contractVersion", "files"].includes(key))
  ) {
    throw codeError("CONTRACT_MANIFEST_INVALID");
  }
  for (const file of parsed.files) assertRepositoryPath(file);
  if (new Set(parsed.files).size !== parsed.files.length) {
    throw codeError("CONTRACT_FILE_DUPLICATE");
  }
  const sorted = [...parsed.files].sort(comparePaths);
  if (canonicalJson(sorted) !== canonicalJson(parsed.files)) {
    throw codeError("CONTRACT_FILE_ORDER_INVALID");
  }
  if (!parsed.files.includes(CONTRACT_MANIFEST_PATH)) {
    throw codeError("CONTRACT_MANIFEST_NOT_SELF_COVERED");
  }
  return Object.freeze({
    contractVersion: parsed.contractVersion,
    files: Object.freeze([...parsed.files])
  });
}

export async function computeRepositoryContract(repoRoot, { ignore } = {}) {
  const manifest = await loadContractFileManifest(repoRoot);
  const declared = manifest.files.filter((relativePath) => relativePath !== ignore);
  const fileBytes = new Map();
  for (const relativePath of declared) {
    try {
      fileBytes.set(relativePath, await readFile(path.join(repoRoot, ...relativePath.split("/"))));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw codeError("CONTRACT_FILE_MISSING", { path: relativePath });
      }
      throw error;
    }
  }
  const discovered = await discoverRepositoryContractFiles(repoRoot);
  if (canonicalJson(declared) !== canonicalJson(discovered)) {
    throw codeError("CONTRACT_FILE_SET_DRIFT", { declared, discovered });
  }
  const entries = [];
  for (const relativePath of declared) {
    entries.push({ path: relativePath, sha256: sha256Bytes(fileBytes.get(relativePath)) });
  }
  const identity = {
    catalogVersion: "repository-contract.v1",
    canonicalization: "RFC8785",
    entries
  };
  return Object.freeze({ ...identity, digest: sha256Canonical(identity) });
}

export async function computeMigrationCatalog(repoRoot) {
  const migrationsRoot = path.join(repoRoot, ...MIGRATION_PATH.split("/"));
  let directories;
  try {
    directories = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(comparePaths);
  } catch (error) {
    if (error?.code === "ENOENT") throw codeError("MIGRATION_DIRECTORY_MISSING");
    throw error;
  }
  const entries = [];
  for (const [index, directory] of directories.entries()) {
    if (!/^[0-9]{14}_[a-z0-9_]+$/.test(directory)) {
      throw codeError("MIGRATION_DIRECTORY_INVALID", { directory });
    }
    const relativePath = `${MIGRATION_PATH}/${directory}/migration.sql`;
    let bytes;
    try {
      bytes = await readFile(path.join(repoRoot, ...relativePath.split("/")));
    } catch (error) {
      if (error?.code === "ENOENT")
        throw codeError("MIGRATION_FILE_MISSING", { path: relativePath });
      throw error;
    }
    entries.push({
      order: index + 1,
      path: toRepositoryPath(relativePath),
      sha256: sha256Bytes(bytes)
    });
  }
  const identity = { catalogVersion: "migration-catalog.v1", entries };
  return Object.freeze({ ...identity, digest: sha256Canonical(identity) });
}

export async function verifyMigrationCatalog(repoRoot, expected) {
  const actual = await computeMigrationCatalog(repoRoot);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw codeError("MIGRATION_CATALOG_DRIFT", {
      expectedDigest: expected?.digest,
      actualDigest: actual.digest
    });
  }
  return actual;
}
