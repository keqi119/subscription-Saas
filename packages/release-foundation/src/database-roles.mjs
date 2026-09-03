function lifecycleError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

export function sqlIdentifier(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw lifecycleError("DATABASE_IDENTIFIER_INVALID", { value });
  }
  return `"${value}"`;
}

export function sqlLiteral(value) {
  if (typeof value !== "string") throw lifecycleError("DATABASE_LITERAL_INVALID");
  return `'${value.replaceAll("'", "''")}'`;
}

export async function grantRuntimeEquivalentAccess({
  databaseName,
  migrationRole,
  runtimeRole,
  executeDatabase
}) {
  if (!/^s1ci_[0-9a-f]{24}$/.test(databaseName ?? "") || !executeDatabase) {
    throw lifecycleError("DATABASE_ACCESS_INPUT_INVALID");
  }
  const migration = sqlIdentifier(migrationRole);
  const runtime = sqlIdentifier(runtimeRole);
  const sql = [
    `ALTER SCHEMA public OWNER TO ${migration};`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
    `REVOKE ALL ON SCHEMA public FROM ${runtime};`,
    `GRANT USAGE ON SCHEMA public TO ${runtime};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtime};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime};`
  ].join("\n");
  await executeDatabase({ databaseName, sql });
}
