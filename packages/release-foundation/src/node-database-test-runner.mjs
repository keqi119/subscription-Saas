import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256Bytes } from "./digest.mjs";

function runnerError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function repositoryFixturePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  if (
    !/^release\/test-fixtures\/[a-z0-9][a-z0-9.-]*\.sql$/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw runnerError("DATABASE_FIXTURE_PATH_INVALID");
  }
  return normalized;
}

function withoutSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

function statementClasses(sql) {
  const statements = withoutSqlComments(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) throw runnerError("DATABASE_FIXTURE_EMPTY");
  return statements.map(
    (statement) => statement.match(/^([A-Z]+)/i)?.[1]?.toUpperCase() ?? "UNKNOWN"
  );
}

function assertFixtureIdentity({
  credentialRef,
  credentialFingerprint,
  counterpartCredentialFingerprint,
  fixturePath,
  executeSql
}) {
  if (
    typeof credentialRef !== "string" ||
    credentialRef.length === 0 ||
    /postgres(?:ql)?:\/\//i.test(credentialRef) ||
    !/^sha256:[0-9a-f]{64}$/.test(credentialFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(counterpartCredentialFingerprint ?? "") ||
    typeof executeSql !== "function"
  ) {
    throw runnerError("DATABASE_FIXTURE_INPUT_INVALID");
  }
  if (credentialFingerprint === counterpartCredentialFingerprint) {
    throw runnerError("FIXTURE_CAPABILITY_CREDENTIAL_REUSE");
  }
  return repositoryFixturePath(fixturePath);
}

function observation({ capability, credentialFingerprint, fixturePath, sql, classes }) {
  return Object.freeze({
    schemaVersion: "fixture-observation.v1",
    capability,
    credentialFingerprint,
    fixturePath,
    sqlDigest: sha256Bytes(Buffer.from(sql, "utf8")),
    statementClasses: Object.freeze(classes)
  });
}

export async function runSchemaFixture(input) {
  const fixturePath = assertFixtureIdentity(input);
  let sql = input.sql;
  if (sql === undefined)
    sql = await readFile(path.resolve(input.repoRoot ?? process.cwd(), fixturePath), "utf8");
  if (typeof sql !== "string") throw runnerError("DATABASE_FIXTURE_INPUT_INVALID");
  if (sql.includes("{{runtime_role}}")) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.runtimeRole ?? "")) {
      throw runnerError("DATABASE_FIXTURE_RUNTIME_ROLE_INVALID");
    }
    sql = sql.replaceAll("{{runtime_role}}", `"${input.runtimeRole}"`);
  }
  const classes = statementClasses(sql);
  if (
    classes.some((statementClass) =>
      ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE"].includes(statementClass)
    )
  ) {
    throw runnerError("MIGRATION_FIXTURE_BUSINESS_DML_FORBIDDEN", { classes });
  }
  if (
    classes.some(
      (statementClass) =>
        !["CREATE", "ALTER", "GRANT", "REVOKE", "COMMENT"].includes(statementClass)
    )
  ) {
    throw runnerError("MIGRATION_FIXTURE_STATEMENT_FORBIDDEN", { classes });
  }
  await input.executeSql({
    capability: "migration",
    credentialRef: input.credentialRef,
    sql
  });
  return observation({
    capability: "migration",
    credentialFingerprint: input.credentialFingerprint,
    fixturePath,
    sql,
    classes
  });
}

export async function runRuntimeSeedFixture(input) {
  const fixturePath = assertFixtureIdentity(input);
  let sql = input.sql;
  if (sql === undefined)
    sql = await readFile(path.resolve(input.repoRoot ?? process.cwd(), fixturePath), "utf8");
  if (typeof sql !== "string") throw runnerError("DATABASE_FIXTURE_INPUT_INVALID");
  const classes = statementClasses(sql);
  if (
    classes.some((statementClass) =>
      ["CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "COMMENT"].includes(statementClass)
    )
  ) {
    throw runnerError("RUNTIME_FIXTURE_DDL_FORBIDDEN", { classes });
  }
  if (
    classes.some(
      (statementClass) => !["DELETE", "INSERT", "UPDATE", "SELECT", "WITH"].includes(statementClass)
    )
  ) {
    throw runnerError("RUNTIME_FIXTURE_STATEMENT_FORBIDDEN", { classes });
  }
  await input.executeSql({
    capability: "runtime-test",
    credentialRef: input.credentialRef,
    sql
  });
  return observation({
    capability: "runtime-test",
    credentialFingerprint: input.credentialFingerprint,
    fixturePath,
    sql,
    classes
  });
}

export async function scanDatabaseFrameworkBypasses(repoRoot, manifest) {
  const files = [...new Set(manifest?.suites?.flatMap((suite) => suite.files ?? []) ?? [])].sort(
    (left, right) => left.localeCompare(right, "en")
  );
  const violations = [];
  for (const relativePath of files) {
    const source = await readFile(path.join(repoRoot, ...relativePath.split("/")), "utf8");
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      let kind;
      if (/(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]*\b(?:test|it)\.skip\b/.test(line)) {
        kind = "conditional-skip";
      } else if (/\b(?:test|it|describe)\.skip\s*\(/.test(line)) {
        kind = "framework-skip";
      } else if (/\b(?:test|it|describe)\.only\s*\(/.test(line)) {
        kind = "framework-only";
      } else if (/--bail\b|\bfailFast\s*:|\bbail\s*:/.test(line)) {
        kind = "fail-fast";
      }
      if (kind) violations.push({ path: relativePath, line: index + 1, kind });
    }
  }
  return Object.freeze(violations.map((violation) => Object.freeze(violation)));
}
