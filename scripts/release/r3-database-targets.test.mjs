import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { suiteDatabaseName } from "../../packages/release-foundation/src/database-target.mjs";
import {
  planR3DatabaseTargets,
  provisionR3DatabaseTargets,
  recheckR3DatabaseTargets
} from "./r3-database-targets.mjs";

const repo = new URL("../../release/contracts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("database-test-manifest.v1.json", repo)));
const policy = JSON.parse(
  readFileSync(new URL("database-target-policies.v1.json", repo))
).policies.find((item) => item.policyId === "s1-release-compose-ephemeral");
const operationRef = "10000000-0000-4000-8000-000000000001";
const createdAt = "2026-09-28T00:00:00.000Z";
const input = (phase = "source", chain = "fresh") => ({ operationRef, phase, chain, manifest });
const invalid = { code: "R3_DATABASE_TARGETS_UNAVAILABLE" };

function fakeAdmin({ failAfterCreate = Infinity, grantedTo = 0 } = {}) {
  const databases = new Map(),
    roles = new Map(),
    calls = [];
  let creates = 0;
  const executeAdmin = async ({ databaseName, sql }) => {
    calls.push({ databaseName, sql });
    if (/^CREATE ROLE /u.test(sql)) {
      const name = sql.match(/^CREATE ROLE "([^"]+)"/u)?.[1];
      assert.ok(name);
      roles.set(name, {
        oid: String(2000 + roles.size),
        name,
        canLogin: true,
        superuser: false,
        createdb: false,
        createrole: false,
        inherit: false,
        replication: false,
        bypassrls: false,
        memberships: 0,
        grantedTo,
        canConnect: true,
        canCreateDatabase: false,
        canCreateTemporary: false
      });
    } else if (/^CREATE DATABASE /u.test(sql)) {
      creates++;
      if (creates > failAfterCreate) throw new Error("synthetic creation failure");
      const [, name, owner] = sql.match(/^CREATE DATABASE "([^"]+)" OWNER "([^"]+)"$/u) ?? [];
      assert.ok(name && owner);
      databases.set(name, {
        databaseOid: String(3000 + creates),
        marker: "",
        owner,
        schemaOwner: owner
      });
    } else if (/^COMMENT ON DATABASE /u.test(sql)) {
      const [, name, marker] = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '(.+)'$/u) ?? [];
      databases.get(name).marker = marker.replaceAll("''", "'");
    } else if (/^SELECT d\.oid::text AS "databaseOid"/u.test(sql)) {
      const name = sql.match(/WHERE d\.datname='([^']+)'$/u)?.[1];
      return { rows: databases.has(name) ? [{ ...databases.get(name) }] : [] };
    } else if (/^SELECT r\.oid::text AS "oid"/u.test(sql)) {
      const name = sql.match(/WHERE r\.rolname='([^']+)'$/u)?.[1];
      if (!roles.has(name)) return { rows: [] };
      const { grantedTo: grantees, ...row } = roles.get(name);
      if (sql.includes("m.roleid=r.oid")) row.grantedTo = grantees;
      return { rows: [row] };
    } else if (/^SELECT pg_get_userbyid\(n\.nspowner\)/u.test(sql)) {
      const db = databases.get(databaseName);
      return { rows: db ? [{ schemaOwner: db.schemaOwner, canCreate: false, canUse: true }] : [] };
    }
    return { rows: [] };
  };
  return { executeAdmin, databases, roles, calls };
}
const createSecret = async ({ databaseName, profile, username }) => ({
  username,
  password: "synthetic-password-do-not-log",
  reference: `private/${databaseName}/${profile}`
});

test("R3 database plan covers every manifest suite with only lifecycle reserved", () => {
  const source = planR3DatabaseTargets(input());
  const final = planR3DatabaseTargets(input("final", "snapshot"));
  assert.equal(source.manifestDigest, sha256Canonical(manifest));
  assert.equal(source.targets.length, 37);
  assert.equal(source.reservations.length, 2);
  assert.equal(final.targets.length, 38);
  assert.equal(final.targets.at(-1).suiteId, "r3.application");
  assert.deepEqual(Object.keys(final.targets.at(-1).roles), [
    "migrate",
    "runtime-test",
    "restore",
    "api-runtime",
    "verify"
  ]);
  assert.equal(source.targets.filter((item) => item.name === "source").length, 1);
  assert.equal(
    source.targets.filter((item) => item.suiteId === "node.release-database-lifecycle.postgres")
      .length,
    0
  );
  for (const [shard, reservation] of source.reservations.entries()) {
    assert.equal(
      reservation.databaseName,
      suiteDatabaseName(operationRef, "database-lifecycle", shard)
    );
    assert.equal(Object.hasOwn(reservation, "databaseOid"), false);
    assert.equal(Object.hasOwn(reservation, "marker"), false);
  }
  assert.ok(Object.isFrozen(source) && Object.isFrozen(source.targets[0].roles));
  const duplicate = structuredClone(manifest);
  duplicate.suites[1].files = [...duplicate.suites[0].files];
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: duplicate }), invalid);
  const extraTopology = structuredClone(manifest);
  extraTopology.suites[0].databaseTopology = "source-target";
  assert.throws(() => planR3DatabaseTargets({ ...input(), manifest: extraTopology }), invalid);
});

test("R3 database provision executes single statements, bounds roles and rechecks actual identities", async () => {
  const plan = planR3DatabaseTargets(input("final", "snapshot"));
  const admin = fakeAdmin();
  let checks = 0;
  const result = await provisionR3DatabaseTargets({
    plan,
    policy,
    executeAdmin: admin.executeAdmin,
    createSecret,
    recheck: async () => {
      checks++;
    },
    createdAt
  });
  assert.equal(result.records.length, 38);
  assert.ok(result.records[0].marker.startsWith("{"));
  assert.ok(result.records.at(-1).marker.startsWith("subscription-s1-ephemeral/v1:{"));
  assert.equal(
    admin.databases.get(result.records.at(-1).databaseName).marker,
    result.records.at(-1).marker
  );
  assert.equal(checks, 76);
  assert.equal(admin.calls.filter((call) => /^CREATE DATABASE /u.test(call.sql)).length, 38);
  assert.ok(
    admin.calls.every(
      (call) => !call.sql.includes(";") || call.sql.startsWith("COMMENT ON DATABASE")
    ),
    "one SQL statement per call"
  );
  assert.ok(
    admin.calls
      .filter((call) => /^CREATE ROLE /u.test(call.sql))
      .every((call) =>
        /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS$/u.test(call.sql)
      )
  );
  assert.ok(admin.calls.some((call) => /^GRANT SELECT ON ALL TABLES/u.test(call.sql)));
  assert.ok(
    admin.calls.some((call) =>
      /^GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES/u.test(call.sql)
    )
  );
  assert.ok(admin.calls.some((call) => /^REVOKE ALL ON DATABASE /u.test(call.sql)));
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
  assert.ok(!JSON.stringify(result).includes("synthetic-password"));
  assert.equal(result.records[0].owner, plan.targets[0].roles.migrate);
  assert.equal(result.records[0].runtimeCanCreate, false);
  assert.equal(result.records[0].roleReadback["runtime-test"].memberships, 0);
  assert.equal(result.records[0].roleReadback["runtime-test"].canCreateTemporary, false);
  assert.equal(result.records[0].schemaPrivileges["runtime-test"].canUse, true);
  assert.equal(
    await recheckR3DatabaseTargets({
      plan,
      records: result.records,
      executeAdmin: admin.executeAdmin
    }),
    true
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  admin.roles.get(result.records[0].roles["runtime-test"]).memberships = 0;
  admin.roles.get(result.records[0].roles["runtime-test"]).grantedTo = 1;
  await assert.rejects(
    recheckR3DatabaseTargets({ plan, records: result.records, executeAdmin: admin.executeAdmin }),
    invalid
  );
  const delegated = fakeAdmin({ grantedTo: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: delegated.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    invalid
  );
});

test("R3 database provision preserves completed facts and partial resources on failure", async () => {
  const plan = planR3DatabaseTargets(input());
  const admin = fakeAdmin({ failAfterCreate: 1 });
  await assert.rejects(
    provisionR3DatabaseTargets({
      plan,
      policy,
      executeAdmin: admin.executeAdmin,
      createSecret,
      recheck: async () => {},
      createdAt
    }),
    (error) => {
      assert.equal(error.code, invalid.code);
      assert.equal(error.records.length, 1);
      assert.equal(error.records[0].databaseName, plan.targets[0].databaseName);
      assert.deepEqual(Object.keys(error).sort(), ["code", "records"]);
      return true;
    }
  );
  assert.equal(admin.databases.size, 1);
  assert.ok(
    admin.roles.size > Object.keys(plan.targets[0].roles).length,
    "the partially created second target remains visible for UNKNOWN"
  );
  assert.ok(admin.calls.every((call) => !/^DROP |^ROLLBACK/u.test(call.sql)));
});
