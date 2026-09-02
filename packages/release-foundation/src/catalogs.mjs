import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { sha256Bytes, sha256Canonical } from "./digest.mjs";

const CONTRACT_MANIFEST_PATH = "release/contracts/repository-contract-files.v1.json";
const MIGRATION_PATH = "apps/api/prisma/migrations";
const RELEASE_GATE_ENTRY_POINTS = Object.freeze([
  "Dockerfile.runner",
  "apps/release-runner/package.json",
  "apps/release-runner/src/cli.mjs",
  "apps/release-runner/src/postgres-connector.mjs",
  "apps/release-runner/src/runtime-adapters.mjs",
  "apps/release-runner/src/trusted-entrypoint.mjs",
  "docker-compose.release-gate.yml",
  "playwright.release.config.ts",
  "pnpm-lock.yaml",
  "scripts/release/run-final-compose-gate.mjs",
  "scripts/release/trusted-launch-production-adapters.mjs",
  "scripts/release/trusted-launch-runner.mjs",
  "scripts/release/verify-compose-policy.mjs",
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
