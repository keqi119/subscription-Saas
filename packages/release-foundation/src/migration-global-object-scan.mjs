import { readFile } from "node:fs/promises";
import path from "node:path";

import { computeMigrationCatalog } from "./catalogs.mjs";

function scanError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

export async function scanMigrationGlobalObjects(repoRoot, policy) {
  if (
    policy?.schemaVersion !== "migration-global-object-policy.v1" ||
    !Array.isArray(policy.allowedExtensions) ||
    new Set(policy.allowedExtensions).size !== policy.allowedExtensions.length
  ) {
    throw scanError("MIGRATION_GLOBAL_OBJECT_POLICY_INVALID");
  }
  const allowedExtensions = new Set(policy.allowedExtensions);
  const catalog = await computeMigrationCatalog(repoRoot);
  const extensions = new Set();
  for (const entry of catalog.entries) {
    const sql = withoutComments(
      await readFile(path.join(repoRoot, ...entry.path.split("/")), "utf8")
    );
    const forbidden = sql.match(
      /\b(?:CREATE\s+(?:ROLE|USER|DATABASE|TABLESPACE)|ALTER\s+SYSTEM)\b/i
    );
    if (forbidden) {
      throw scanError("MIGRATION_GLOBAL_OBJECT_FORBIDDEN", {
        path: entry.path,
        statementClass: forbidden[0].replace(/\s+/g, " ").toUpperCase()
      });
    }
    const extensionStatements = [...sql.matchAll(/\bCREATE\s+EXTENSION\b[^;]*;/gi)];
    const extensionTokens = sql.match(/\bCREATE\s+EXTENSION\b/gi) ?? [];
    if (extensionStatements.length !== extensionTokens.length) {
      throw scanError("MIGRATION_EXTENSION_POLICY_REJECTED", { path: entry.path });
    }
    for (const match of extensionStatements) {
      const parsed = match[0].match(
        /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+(?:"([a-z0-9_]+)"|([a-z][a-z0-9_]*))\s*;$/i
      );
      const extension = parsed?.[1]?.toLowerCase() ?? parsed?.[2]?.toLowerCase();
      if (!extension || !allowedExtensions.has(extension)) {
        throw scanError("MIGRATION_EXTENSION_POLICY_REJECTED", {
          path: entry.path,
          extension
        });
      }
      extensions.add(extension);
    }
  }
  return Object.freeze({
    migrationCatalogDigest: catalog.digest,
    extensions: Object.freeze([...extensions].sort())
  });
}
