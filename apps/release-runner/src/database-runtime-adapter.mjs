import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";

import { computeMigrationCatalog, sha256Bytes } from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";

const schemaRelativePath = "apps/api/prisma/schema.prisma";

function assertSchemaPath(schema, repoRoot) {
  const expected = path.resolve(repoRoot, schemaRelativePath);
  if (path.resolve(schema) !== expected) throw runnerError("RUNNER_SCHEMA_PATH_FORBIDDEN");
  return expected;
}

export function prismaMigrateDeployArgs({ schema, repoRoot = "/app" }) {
  return ["migrate", "deploy", "--schema", assertSchemaPath(schema, repoRoot)];
}

export function prismaSchemaDiffArgs({ schema, repoRoot = "/app" }) {
  return [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    assertSchemaPath(schema, repoRoot),
    "--exit-code"
  ];
}

function prismaSchemaScriptArgs({ schema, repoRoot = "/app" }) {
  return [
    "migrate",
    "diff",
    "--from-empty",
    "--to-config-datasource",
    "--script",
    "--schema",
    assertSchemaPath(schema, repoRoot)
  ];
}

function databaseUrl(credential, target) {
  const user = encodeURIComponent(credential.username);
  const password = encodeURIComponent(credential.password);
  const database = encodeURIComponent(target.databaseName);
  return `postgresql://${user}:${password}@${target.hostname}:${target.port ?? 5432}/${database}?sslmode=require`;
}

function executeProcess(command, args, { environment, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode: exitCode ?? 1, signal: signal ?? null, stdout, stderr });
    });
  });
}

function requireSuccess(result, code, { allowSchemaDiff = false } = {}) {
  const accepted = allowSchemaDiff
    ? result?.signal === null && [0, 2].includes(result?.exitCode)
    : result?.signal === null && result?.exitCode === 0;
  if (!accepted) throw runnerError(code, { exitCode: result?.exitCode, signal: result?.signal });
  return result;
}

export function createDatabaseRuntimeAdapter({
  database,
  credential,
  target,
  repoRoot = "/app",
  runProcess = executeProcess,
  now = () => new Date()
}) {
  if (!database || typeof runProcess !== "function") {
    throw runnerError("RUNNER_DATABASE_ADAPTER_UNAVAILABLE");
  }
  const schema = path.resolve(repoRoot, schemaRelativePath);
  const prisma = path.resolve(repoRoot, "apps/release-runner/node_modules/.bin/prisma");
  const childEnvironment = Object.freeze({
    ...process.env,
    DATABASE_URL: databaseUrl(credential, target),
    STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV: "1"
  });
  let activeDatabase = database;

  async function appliedMigrations() {
    const exists = await activeDatabase.$queryRawUnsafe(
      "SELECT to_regclass('public._prisma_migrations')::text AS name"
    );
    if (!exists?.[0]?.name) return [];
    const rows = await activeDatabase.$queryRawUnsafe(
      'SELECT migration_name::text AS name, checksum::text AS checksum FROM "public"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY started_at, migration_name'
    );
    return rows.map(({ name, checksum }, index) => ({
      order: index + 1,
      path: `apps/api/prisma/migrations/${name}/migration.sql`,
      sha256: String(checksum).startsWith("sha256:") ? checksum : `sha256:${checksum}`
    }));
  }

  return Object.assign(database, {
    now,
    async loadMigrationCatalog() {
      return computeMigrationCatalog(repoRoot);
    },
    async observeMigrationState() {
      const migrations = await appliedMigrations();
      const owner = await activeDatabase.$queryRawUnsafe(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'"
      );
      return {
        appliedMigrations: migrations,
        migrationHead: migrations.at(-1)?.path.split("/").at(-2) ?? null,
        databaseIdentityFingerprint: database.databaseIdentityFingerprint,
        schemaOwner: owner?.[0]?.owner ?? null
      };
    },
    async observeSchema() {
      const migrations = await appliedMigrations();
      const [owner, inventory, extensions, schemaDiff, schemaScript] = await Promise.all([
        activeDatabase.$queryRawUnsafe(
          "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'"
        ),
        activeDatabase.$queryRawUnsafe(`
          SELECT 'schema'::text AS "objectClass", nspname::text AS "objectName",
                 nspowner::regrole::text AS owner
          FROM pg_namespace WHERE nspname = 'public'
          UNION ALL
          SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,
                 c.relname::text, c.relowner::regrole::text
          FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
          ORDER BY 1, 2
        `),
        activeDatabase.$queryRawUnsafe(
          "SELECT extname::text AS name FROM pg_extension ORDER BY extname"
        ),
        runProcess(prisma, prismaSchemaDiffArgs({ schema, repoRoot }), {
          environment: childEnvironment
        }),
        runProcess(prisma, prismaSchemaScriptArgs({ schema, repoRoot }), {
          environment: childEnvironment
        })
      ]);
      requireSuccess(schemaDiff, "SCHEMA_DIFF_EXECUTION_FAILED", { allowSchemaDiff: true });
      requireSuccess(schemaScript, "SCHEMA_DIGEST_EXECUTION_FAILED");
      return {
        appliedMigrations: migrations,
        migrationHead: migrations.at(-1)?.path.split("/").at(-2) ?? null,
        schemaDigest: sha256Bytes(Buffer.from(schemaScript.stdout, "utf8")),
        schemaOwner: owner?.[0]?.owner ?? null,
        ownerInventory: inventory,
        extensions: extensions.map(({ name }) => name),
        schemaDiff: { exitCode: schemaDiff.exitCode, stdout: schemaDiff.stdout },
        statements: [...database.statementLog]
      };
    },
    async readToolVersions() {
      const [prismaVersion, psqlVersion, postgresql] = await Promise.all([
        runProcess(prisma, ["--version"], { environment: childEnvironment }),
        runProcess("psql", ["--version"], { environment: childEnvironment }),
        activeDatabase.$queryRawUnsafe("SHOW server_version")
      ]);
      requireSuccess(prismaVersion, "PRISMA_VERSION_UNAVAILABLE");
      requireSuccess(psqlVersion, "PSQL_VERSION_UNAVAILABLE");
      return {
        prisma: prismaVersion.stdout.trim(),
        psql: psqlVersion.stdout.trim(),
        postgresql: postgresql?.[0]?.server_version ?? postgresql?.[0]?.serverVersion
      };
    },
    async withMigrationLock(callback) {
      return database.$transaction(async (transaction) => {
        await transaction.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1)) AS locked",
          "s1-final-runner-migration-lock"
        );
        activeDatabase = transaction;
        try {
          return await callback();
        } finally {
          activeDatabase = database;
        }
      });
    },
    async executePrismaMigrateDeploy({ timeoutMs }) {
      const result = await runProcess(prisma, prismaMigrateDeployArgs({ schema, repoRoot }), {
        environment: childEnvironment,
        timeoutMs
      });
      requireSuccess(result, "PRISMA_MIGRATE_DEPLOY_FAILED");
      return result;
    }
  });
}
