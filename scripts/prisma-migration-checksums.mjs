import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsRoot = resolve(repoRoot, "apps/api/prisma/migrations");
const requireFromApi = createRequire(resolve(repoRoot, "apps/api/package.json"));

export function hashMigrationBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resolvePgClient(pgModule) {
  const Client = pgModule.Client ?? pgModule.default?.Client;
  if (typeof Client !== "function") throw new Error("PG_CLIENT_CONSTRUCTOR_MISSING");
  return Client;
}

export function resolveMigrationSearchPath(databaseUrl) {
  const schema = new URL(databaseUrl).searchParams.get("schema")?.trim() || "public";
  return `"${schema.replaceAll('"', '""')}"`;
}

export function compareMigrationChecksums(localMigrations, appliedMigrations) {
  const localByName = new Map(localMigrations.map((row) => [row.migrationName, row.checksum]));
  const appliedByName = new Map();
  const duplicateAppliedNames = [];
  for (const row of appliedMigrations) {
    if (appliedByName.has(row.migrationName)) duplicateAppliedNames.push(row.migrationName);
    appliedByName.set(row.migrationName, row.checksum);
  }
  const mismatchedNames = [...localByName]
    .filter(([name, checksum]) => appliedByName.has(name) && appliedByName.get(name) !== checksum)
    .map(([name]) => name)
    .sort();
  const missingFromDatabase = [...localByName.keys()]
    .filter((name) => !appliedByName.has(name))
    .sort();
  const missingLocally = [...appliedByName.keys()].filter((name) => !localByName.has(name)).sort();
  const uniqueDuplicates = [...new Set(duplicateAppliedNames)].sort();

  return {
    appliedMigrationCount: appliedMigrations.length,
    duplicateAppliedNames: uniqueDuplicates,
    localMigrationCount: localMigrations.length,
    mismatchedNames,
    missingFromDatabase,
    missingLocally,
    safe:
      uniqueDuplicates.length === 0 &&
      mismatchedNames.length === 0 &&
      missingFromDatabase.length === 0 &&
      missingLocally.length === 0
  };
}

export async function loadLocalMigrationChecksums(root = migrationsRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  return Promise.all(
    migrationNames.map(async (migrationName) => ({
      checksum: hashMigrationBytes(await readFile(resolve(root, migrationName, "migration.sql"))),
      migrationName
    }))
  );
}

export async function runMigrationChecksumVerification({
  connect = createDatabaseClient,
  loadLocal = loadLocalMigrationChecksums,
  writeStdout = (contents) => process.stdout.write(contents)
} = {}) {
  const client = await connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(`
      SELECT migration_name AS "migrationName", checksum
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
        AND rolled_back_at IS NULL
      ORDER BY migration_name
    `);
    await client.query("COMMIT");
    const comparison = compareMigrationChecksums(await loadLocal(), result.rows);
    await writeStdout(`${JSON.stringify(comparison, null, 2)}\n`);
    return comparison.safe ? 0 : 2;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The public process wrapper emits one redacted error for either failure.
    }
    throw error;
  } finally {
    await client.end();
  }
}

export async function runMigrationChecksumProcess({ run, writeStderr }) {
  try {
    return await run();
  } catch {
    writeStderr('{"error":"PRISMA_MIGRATION_CHECKSUM_VERIFICATION_FAILED"}\n');
    return 1;
  }
}

async function createDatabaseClient() {
  await loadEnvironment();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("PRISMA_MIGRATION_CHECKSUM_DATABASE_URL_REQUIRED");
  const Client = resolvePgClient(await import(pathToFileURL(requireFromApi.resolve("pg")).href));
  const client = new Client({ connectionString: normalizeLocalhostDatabaseUrl(databaseUrl) });
  await client.connect();
  await client.query("SELECT set_config('search_path', $1, false)", [
    resolveMigrationSearchPath(databaseUrl)
  ]);
  return client;
}

async function loadEnvironment() {
  const { config } = await import(pathToFileURL(requireFromApi.resolve("dotenv")).href);
  config({ path: resolve(repoRoot, ".env"), quiet: true });
  config({ path: resolve(repoRoot, "apps/api/.env"), quiet: true });
}

function normalizeLocalhostDatabaseUrl(value) {
  const url = new URL(value);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.toString();
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  runMigrationChecksumProcess({
    run: runMigrationChecksumVerification,
    writeStderr: (contents) => process.stderr.write(contents)
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
