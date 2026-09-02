import postgres from "postgres";

import { sha256Canonical } from "@subscription-saas/release-foundation";

import { runnerError } from "./error-codes.mjs";

function statementAdapter(client, shared) {
  const context = {
    statementLog: shared.statementLog,
    custodyEvidence: shared.custody,
    async $queryRawUnsafe(statement, ...parameters) {
      shared.statementLog.push(String(statement));
      return client.unsafe(String(statement), parameters);
    },
    async $executeRawUnsafe(statement, ...parameters) {
      shared.statementLog.push(String(statement));
      const result = await client.unsafe(String(statement), parameters);
      return Number(result?.count ?? result?.length ?? 0);
    },
    async $transaction(callback) {
      if (typeof callback !== "function") throw runnerError("RUNNER_DATABASE_TRANSACTION_INVALID");
      return client.begin((transaction) => callback(statementAdapter(transaction, shared)));
    },
    async withReadOnlyTransaction(callback) {
      if (typeof callback !== "function") throw runnerError("RUNNER_DATABASE_TRANSACTION_INVALID");
      return client.begin("read only", (transaction) =>
        callback(statementAdapter(transaction, shared))
      );
    },
    async query(statement, parameters = []) {
      return context.$queryRawUnsafe(statement, ...parameters);
    },
    async execute(statement, parameters = []) {
      return context.$executeRawUnsafe(statement, ...parameters);
    }
  };
  context.prisma = context;
  return context;
}

export function createPostgresConnector({ createClient = postgres } = {}) {
  if (typeof createClient !== "function") throw runnerError("RUNNER_DATABASE_ADAPTER_UNAVAILABLE");
  return async function connectDatabase({ credential, target, custody }) {
    if (
      !credential ||
      credential.capabilityProfile === undefined ||
      typeof target?.hostname !== "string" ||
      typeof target?.databaseName !== "string" ||
      target.tlsMode !== "require"
    ) {
      throw runnerError("RUNNER_DATABASE_CONNECTION_INPUT_INVALID");
    }
    const client = createClient({
      host: target.hostname,
      port: target.port ?? 5432,
      database: target.databaseName,
      username: credential.username,
      password: credential.password,
      ssl: "require",
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      prepare: false
    });
    const shared = { custody, statementLog: [] };
    const context = statementAdapter(client, shared);
    context.observeIdentity = async () => {
      const rows = await context.$queryRawUnsafe(`
        SELECT
          current_database()::text AS "databaseName",
          (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS "databaseOid",
          current_user::text AS role,
          EXISTS (
            SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl = TRUE
          ) AS tls,
          ARRAY(
            SELECT nspname::text FROM pg_namespace
            WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
            ORDER BY nspname
          ) AS schemas,
          ARRAY(SELECT extname::text FROM pg_extension ORDER BY extname) AS extensions
      `);
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw runnerError("RUNNER_DATABASE_IDENTITY_UNAVAILABLE");
      }
      let migrationHead = null;
      const migrationTable = await context.$queryRawUnsafe(
        "SELECT to_regclass('public._prisma_migrations')::text AS name"
      );
      if (migrationTable?.[0]?.name) {
        const migration = await context.$queryRawUnsafe(
          'SELECT migration_name::text AS name FROM "public"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1'
        );
        migrationHead = migration?.[0]?.name ?? null;
      }
      const observation = Object.freeze({ ...rows[0], migrationHead });
      context.databaseIdentityFingerprint = sha256Canonical({
        databaseName: observation.databaseName,
        databaseOid: String(observation.databaseOid),
        role: observation.role,
        tls: observation.tls
      });
      context.databaseIdentitySha256 = context.databaseIdentityFingerprint;
      return observation;
    };
    context.close = () => client.end({ timeout: 5 });
    return context;
  };
}
