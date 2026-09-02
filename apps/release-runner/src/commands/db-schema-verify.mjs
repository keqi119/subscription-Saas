import { sha256Canonical } from "@subscription-saas/release-foundation";

import { runnerError } from "../error-codes.mjs";

const writeStatement =
  /\b(?:alter|call|comment|copy|create|delete|do|drop|grant|insert|merge|refresh|reindex|revoke|truncate|update|vacuum)\b/iu;
const readStatement = /^(?:explain\s+)?(?:select|show|with)\b|^set\s+transaction\s+read\s+only\b/iu;

function migrationName(entry) {
  return entry.path.split("/").at(-2) ?? null;
}

function assertRequiredFunction(context, name) {
  if (typeof context?.[name] !== "function") {
    throw runnerError("RUNNER_COMMAND_ADAPTER_MISSING", { adapter: name });
  }
}

export function assertAppliedMigrationPrefix(
  catalog,
  appliedMigrations,
  { requireComplete = false } = {}
) {
  if (!Array.isArray(catalog?.entries) || !Array.isArray(appliedMigrations)) {
    throw runnerError("MIGRATION_STATE_INVALID");
  }
  if (requireComplete && appliedMigrations.length !== catalog.entries.length) {
    throw runnerError("MIGRATION_HEAD_INCOMPLETE");
  }
  if (appliedMigrations.length > catalog.entries.length) {
    throw runnerError("MIGRATION_HISTORY_UNKNOWN");
  }
  for (const [index, applied] of appliedMigrations.entries()) {
    const expected = catalog.entries[index];
    if (applied?.path !== expected?.path) {
      throw runnerError("MIGRATION_HISTORY_NOT_PREFIX", { index, expected, applied });
    }
    if (applied.sha256 !== expected.sha256) {
      throw runnerError("MIGRATION_CHECKSUM_MISMATCH", { path: applied.path });
    }
  }
}

export function assertReadOnlyStatements(statements) {
  if (
    !Array.isArray(statements) ||
    statements.some((statement) => {
      const normalized = String(statement).replace(/--.*$/gmu, " ").trim();
      return (
        normalized.length === 0 ||
        writeStatement.test(normalized) ||
        !readStatement.test(normalized)
      );
    })
  ) {
    throw runnerError("SCHEMA_VERIFY_WRITE_STATEMENT");
  }
}

function assertSchemaPostconditions(observation, input, catalog) {
  assertAppliedMigrationPrefix(catalog, observation.appliedMigrations, { requireComplete: true });
  const catalogHead = migrationName(catalog.entries.at(-1));
  if (observation.migrationHead !== catalogHead) {
    throw runnerError("MIGRATION_HEAD_INCOMPLETE", {
      expected: catalogHead,
      actual: observation.migrationHead
    });
  }
  if (observation.schemaDigest !== input.expectedSchemaDigest) {
    throw runnerError("SCHEMA_DIGEST_MISMATCH");
  }
  if (
    observation.schemaOwner !== input.expectedOwner ||
    !Array.isArray(observation.ownerInventory) ||
    observation.ownerInventory.some(({ owner }) => owner !== input.expectedOwner)
  ) {
    throw runnerError("SCHEMA_OWNER_MISMATCH");
  }
  const allowedExtensions = new Set(input.allowedExtensions ?? []);
  if (
    !Array.isArray(observation.extensions) ||
    observation.extensions.some((extension) => !allowedExtensions.has(extension))
  ) {
    throw runnerError("SCHEMA_EXTENSION_PROHIBITED");
  }
  if (observation.schemaDiff?.exitCode !== 0 || observation.schemaDiff?.stdout?.trim() !== "") {
    throw runnerError("SCHEMA_DIFF_NONZERO");
  }
  assertReadOnlyStatements(observation.statements);
}

export async function verifySchema(context, input) {
  assertRequiredFunction(context, "loadMigrationCatalog");
  assertRequiredFunction(context, "observeSchema");
  assertRequiredFunction(context, "readToolVersions");
  const [catalog, observation, toolVersions] = await Promise.all([
    context.loadMigrationCatalog(),
    context.observeSchema(),
    context.readToolVersions()
  ]);
  assertSchemaPostconditions(observation, input, catalog);
  if (
    ["prisma", "psql", "postgresql"].some(
      (tool) => typeof toolVersions?.[tool] !== "string" || toolVersions[tool].length === 0
    )
  ) {
    throw runnerError("SCHEMA_TOOL_VERSION_MISSING");
  }
  return Object.freeze({
    schemaVersion: "schema-observation.v1",
    catalogDigest: catalog.digest,
    migrationHead: observation.migrationHead,
    migrationChecksums: Object.freeze(
      observation.appliedMigrations.map(({ order, path, sha256 }) => ({ order, path, sha256 }))
    ),
    schemaDigest: observation.schemaDigest,
    schemaOwner: observation.schemaOwner,
    ownerInventory: Object.freeze([...observation.ownerInventory]),
    extensions: Object.freeze([...observation.extensions].sort()),
    schemaDiff: Object.freeze({ ...observation.schemaDiff }),
    toolVersions: Object.freeze({
      postgresql: toolVersions.postgresql,
      prisma: toolVersions.prisma,
      psql: toolVersions.psql
    }),
    statementLogDigest: sha256Canonical(observation.statements),
    terminalStatus: "PASSED"
  });
}

export async function dbSchemaVerifyHandler({ baseline, request, database }) {
  const observation = await verifySchema(database, request.input);
  return Object.freeze({ baseline, observation, terminalStatus: "PASSED" });
}
