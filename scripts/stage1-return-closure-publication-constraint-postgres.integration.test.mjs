import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import {
  requiredReleaseDatabaseTestContext,
  sha256Canonical
} from "../packages/release-foundation/src/index.mjs";

const requireFromApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Client } = requireFromApi("pg");
const expectedDefinitionHash =
  "sha256:b5392a8226c41e0cff31766254e9e6d4d1fd1b03e8d35854548863768436f2e1";

test("PostgreSQL 17 exposes the exact publication constraint while runtime identity cannot validate it", async () => {
  const context = requiredReleaseDatabaseTestContext(import.meta.url);
  const client = new Client({ connectionString: context.databaseUrl });
  await client.connect();
  try {
    const constraint = await client.query(`
      SELECT
        c.oid::text AS "tableOid",
        con.oid::text AS "constraintOid",
        pg_get_constraintdef(con.oid, true) AS "definition",
        con.convalidated AS "convalidated",
        pg_get_userbyid(c.relowner) AS "tableOwner",
        current_user AS "currentRole"
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'subscription_closure_settlement_revision'
        AND con.conname = 'subscription_closure_settlement_publication_check'
        AND con.contype = 'c'
    `);
    assert.equal(constraint.rowCount, 1);
    const row = constraint.rows[0];
    assert.match(row.tableOid, /^[1-9][0-9]*$/u);
    assert.match(row.constraintOid, /^[1-9][0-9]*$/u);
    assert.notEqual(row.currentRole, row.tableOwner);
    assert.equal(
      sha256Canonical(
        row.definition
          .trim()
          .replace(/\s+NOT\s+VALID$/iu, "")
          .replace(/\s+/gu, " ")
      ),
      expectedDefinitionHash
    );

    await client.query("BEGIN");
    await assert.rejects(
      () =>
        client.query(
          'ALTER TABLE "public"."subscription_closure_settlement_revision" VALIDATE CONSTRAINT "subscription_closure_settlement_publication_check"'
        ),
      { code: "42501" }
    );
    await client.query("ROLLBACK");
  } finally {
    if (!client.ended) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  }
});
