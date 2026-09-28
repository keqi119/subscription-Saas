// Deterministic R3 target plan and narrow PostgreSQL statements. These facts
// do not authorize consumption, execution, destination use or cleanup.
import { canonicalJson } from "../../packages/release-foundation/src/canonical-json.mjs";
import { sha256Canonical, sha256Text } from "../../packages/release-foundation/src/digest.mjs";
import { suiteDatabaseName } from "../../packages/release-foundation/src/database-target.mjs";
import {
  sqlIdentifier,
  sqlLiteral
} from "../../packages/release-foundation/src/database-roles.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";

const CODE = "R3_DATABASE_TARGETS_UNAVAILABLE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OID = /^[1-9][0-9]*$/u;
const CLEAN = "script.stage1-clean-acceptance.postgres";
const LIFECYCLE = "node.release-database-lifecycle.postgres";
const ROLE_PREFIX = {
  migrate: "s1m",
  "runtime-test": "s1r",
  restore: "s1x",
  "api-runtime": "s1a",
  verify: "s1v"
};
const fail = (records = []) => {
  throw Object.assign(new Error(CODE), { code: CODE, records: frozen(records.slice()) });
};
const need = (condition) => {
  if (!condition) fail();
};
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function roles(databaseName, chain, application = false) {
  const suffix = sha256Text(databaseName).slice(0, 24);
  return Object.fromEntries(
    [
      "migrate",
      "runtime-test",
      ...(chain === "snapshot" ? ["restore"] : []),
      ...(application ? ["api-runtime", "verify"] : [])
    ].map((profile) => [profile, `${ROLE_PREFIX[profile]}_${suffix}`])
  );
}
function target(operationRef, suiteId, suiteIdentity, name, shard, chain, kind = "suite") {
  const databaseName = suiteDatabaseName(operationRef, suiteIdentity, shard);
  return {
    kind,
    suiteId,
    name,
    databaseName,
    shard,
    roles: roles(databaseName, chain, kind === "application")
  };
}
export function planR3DatabaseTargets({ operationRef, phase, chain, manifest }) {
  try {
    need(
      UUID.test(operationRef) &&
        ["source", "final"].includes(phase) &&
        ["fresh", "snapshot"].includes(chain)
    );
    validateContract("database-test-manifest.v1", manifest);
    const suites = manifest.suites;
    need(
      suites.length >= 2 &&
        new Set(suites.map((s) => s.suiteId)).size === suites.length &&
        new Set(suites.flatMap((s) => s.files)).size === suites.flatMap((s) => s.files).length &&
        suites.filter((s) => s.suiteId === CLEAN && s.databaseTopology === "source-target")
          .length === 1 &&
        suites.filter((s) => s.suiteId === LIFECYCLE && s.barrier === "isolated-postgres-cluster")
          .length === 1 &&
        suites.filter((s) => s.databaseTopology === "source-target").length === 1 &&
        suites.every(
          (s) =>
            s.databaseTopology === undefined ||
            ["single", "source-target"].includes(s.databaseTopology)
        )
    );
    const targets = [];
    for (const [index, suite] of suites.entries()) {
      if (suite.suiteId === LIFECYCLE) continue;
      targets.push(target(operationRef, suite.suiteId, suite.suiteId, "target", index, chain));
      if (suite.suiteId === CLEAN)
        targets.push(
          target(
            operationRef,
            suite.suiteId,
            `${suite.suiteId}.source`,
            "source",
            index + 1000,
            chain
          )
        );
    }
    need(
      targets.length === suites.length &&
        new Set(targets.map((t) => t.databaseName)).size === targets.length
    );
    if (phase === "final")
      targets.push(
        target(
          operationRef,
          "r3.application",
          "r3.application",
          "application",
          0,
          chain,
          "application"
        )
      );
    const reservations = [0, 1].map((shard) => ({
      suiteId: LIFECYCLE,
      suiteIdentity: "database-lifecycle",
      name: shard === 0 ? "primary" : "sibling",
      shard,
      databaseName: suiteDatabaseName(operationRef, "database-lifecycle", shard),
      roles: roles(suiteDatabaseName(operationRef, "database-lifecycle", shard), chain)
    }));
    need(
      new Set([...targets, ...reservations].map((t) => t.databaseName)).size === targets.length + 2
    );
    return frozen({
      operationRef,
      phase,
      chain,
      manifestDigest: sha256Canonical(manifest),
      targets,
      reservations
    });
  } catch {
    fail();
  }
}
function checkedPlan(plan) {
  need(
    plan &&
      Object.isFrozen(plan) &&
      UUID.test(plan.operationRef) &&
      ["source", "final"].includes(plan.phase) &&
      ["fresh", "snapshot"].includes(plan.chain) &&
      /^sha256:[0-9a-f]{64}$/u.test(plan.manifestDigest) &&
      Array.isArray(plan.targets) &&
      plan.targets.length >= 2 &&
      Array.isArray(plan.reservations) &&
      plan.reservations.length === 2
  );
}
function checkedPolicy(policy) {
  need(
    policy?.schemaVersion === "database-target-policy.v1" &&
      policy.policyId === "s1-release-compose-ephemeral" &&
      policy.requiredEphemeralMarker === "subscription-s1-ephemeral/v1" &&
      policy.databaseNamePattern === "^s1ci_[0-9a-f]{24}$"
  );
}
function markerFor(plan, item, policy, createdAt) {
  const facts = {
    markerVersion: policy.requiredEphemeralMarker,
    runIdDigest: sha256Canonical(plan.operationRef),
    suiteIdDigest: sha256Canonical(
      item.name === "source" ? `${item.suiteId}.source` : item.suiteId
    ),
    shard: item.shard,
    createdAt
  };
  const canonical = canonicalJson(facts);
  return item.kind === "application" ? `${policy.requiredEphemeralMarker}:${canonical}` : canonical;
}
async function observed(item, marker, executeAdmin) {
  const identity = await executeAdmin({
    databaseName: "postgres",
    sql: `SELECT d.oid::text AS "databaseOid", COALESCE(shobj_description(d.oid,'pg_database'),'') AS "marker", pg_get_userbyid(d.datdba) AS "owner" FROM pg_database d WHERE d.datname=${sqlLiteral(item.databaseName)}`
  });
  const db = identity?.rows?.[0];
  need(
    identity.rows.length === 1 &&
      OID.test(db?.databaseOid) &&
      db.marker === marker &&
      db.owner === item.roles.migrate
  );
  const roleReadback = {};
  for (const [profile, username] of Object.entries(item.roles)) {
    const read = await executeAdmin({
      databaseName: "postgres",
      sql: `SELECT r.oid::text AS "oid", r.rolname AS "name", r.rolcanlogin AS "canLogin", r.rolsuper AS "superuser", r.rolcreatedb AS "createdb", r.rolcreaterole AS "createrole", r.rolinherit AS "inherit", r.rolreplication AS "replication", r.rolbypassrls AS "bypassrls", (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) AS "memberships", (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid=r.oid) AS "grantedTo", has_database_privilege(r.rolname,${sqlLiteral(item.databaseName)},'CONNECT') AS "canConnect", has_database_privilege(r.rolname,${sqlLiteral(item.databaseName)},'CREATE') AS "canCreateDatabase", has_database_privilege(r.rolname,${sqlLiteral(item.databaseName)},'TEMP') AS "canCreateTemporary" FROM pg_roles r WHERE r.rolname=${sqlLiteral(username)}`
    });
    const row = read?.rows?.[0];
    need(
      read.rows.length === 1 &&
        OID.test(row?.oid) &&
        row.name === username &&
        row.canLogin === true &&
        row.memberships === 0 &&
        row.grantedTo === 0 &&
        ["superuser", "createdb", "createrole", "inherit", "replication", "bypassrls"].every(
          (key) => row[key] === false
        ) &&
        (profile === "migrate" ||
          (row.canConnect === true &&
            row.canCreateDatabase === false &&
            row.canCreateTemporary === false))
    );
    roleReadback[profile] = { ...row };
  }
  const schemaPrivileges = {};
  let schemaOwner;
  for (const [profile, username] of Object.entries(item.roles)) {
    if (profile === "migrate") continue;
    const schema = await executeAdmin({
      databaseName: item.databaseName,
      sql: `SELECT pg_get_userbyid(n.nspowner) AS "schemaOwner", has_schema_privilege(${sqlLiteral(username)},'public','CREATE') AS "canCreate", has_schema_privilege(${sqlLiteral(username)},'public','USAGE') AS "canUse" FROM pg_namespace n WHERE n.nspname='public'`
    });
    const row = schema?.rows?.[0];
    need(
      schema.rows.length === 1 &&
        row.schemaOwner === item.roles.migrate &&
        row.canCreate === false &&
        (profile === "restore" || row.canUse === true)
    );
    schemaOwner = row.schemaOwner;
    schemaPrivileges[profile] = { canCreate: row.canCreate, canUse: row.canUse };
  }
  return {
    databaseOid: db.databaseOid,
    owner: db.owner,
    schemaOwner,
    runtimeCanCreate: false,
    roleReadback,
    schemaPrivileges
  };
}
async function statement(executeAdmin, databaseName, sql) {
  await executeAdmin({ databaseName, sql });
}
export async function provisionR3DatabaseTargets({
  plan,
  policy,
  executeAdmin,
  createSecret,
  recheck,
  createdAt
}) {
  const records = [];
  try {
    checkedPlan(plan);
    checkedPolicy(policy);
    need(
      typeof executeAdmin === "function" &&
        typeof createSecret === "function" &&
        typeof recheck === "function" &&
        typeof createdAt === "string" &&
        new Date(createdAt).toISOString() === createdAt
    );
    for (const item of plan.targets) {
      await recheck();
      need(
        item.databaseName ===
          suiteDatabaseName(
            plan.operationRef,
            item.name === "source" ? `${item.suiteId}.source` : item.suiteId,
            item.shard
          ) &&
          JSON.stringify(item.roles) ===
            JSON.stringify(roles(item.databaseName, plan.chain, item.kind === "application"))
      );
      const secrets = {};
      for (const [profile, username] of Object.entries(item.roles)) {
        const secret = await createSecret({ databaseName: item.databaseName, profile, username });
        need(
          secret?.username === username &&
            typeof secret.password === "string" &&
            secret.password.length >= 16 &&
            typeof secret.reference === "string" &&
            secret.reference.length > 0 &&
            !/postgres(?:ql)?:\/\//iu.test(secret.reference)
        );
        secrets[profile] = secret;
      }
      for (const [profile, username] of Object.entries(item.roles))
        await statement(
          executeAdmin,
          "postgres",
          `CREATE ROLE ${sqlIdentifier(username)} LOGIN PASSWORD ${sqlLiteral(secrets[profile].password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`
        );
      await statement(
        executeAdmin,
        "postgres",
        `CREATE DATABASE ${sqlIdentifier(item.databaseName)} OWNER ${sqlIdentifier(item.roles.migrate)}`
      );
      const marker = markerFor(plan, item, policy, createdAt);
      await statement(
        executeAdmin,
        "postgres",
        `COMMENT ON DATABASE ${sqlIdentifier(item.databaseName)} IS ${sqlLiteral(marker)}`
      );
      await statement(
        executeAdmin,
        "postgres",
        `REVOKE ALL ON DATABASE ${sqlIdentifier(item.databaseName)} FROM PUBLIC`
      );
      await statement(
        executeAdmin,
        "postgres",
        `GRANT CONNECT ON DATABASE ${sqlIdentifier(item.databaseName)} TO ${Object.values(item.roles).map(sqlIdentifier).join(", ")}`
      );
      await statement(
        executeAdmin,
        item.databaseName,
        `ALTER SCHEMA public OWNER TO ${sqlIdentifier(item.roles.migrate)}`
      );
      await statement(
        executeAdmin,
        item.databaseName,
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
      );
      for (const profile of [
        "runtime-test",
        ...(item.roles["api-runtime"] ? ["api-runtime"] : [])
      ]) {
        const role = sqlIdentifier(item.roles[profile]),
          migration = sqlIdentifier(item.roles.migrate);
        for (const sql of [
          `GRANT USAGE ON SCHEMA public TO ${role}`,
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
          `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`
        ])
          await statement(executeAdmin, item.databaseName, sql);
      }
      if (item.roles.verify) {
        const verify = sqlIdentifier(item.roles.verify),
          migration = sqlIdentifier(item.roles.migrate);
        for (const sql of [
          `GRANT USAGE ON SCHEMA public TO ${verify}`,
          `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${verify}`,
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA public GRANT SELECT ON TABLES TO ${verify}`
        ])
          await statement(executeAdmin, item.databaseName, sql);
      }
      const facts = await observed(item, marker, executeAdmin);
      records.push(
        frozen({
          kind: item.kind,
          suiteId: item.suiteId,
          name: item.name,
          databaseName: item.databaseName,
          shard: item.shard,
          marker,
          createdAt,
          ...facts,
          roles: { ...item.roles },
          secretReferences: Object.fromEntries(
            Object.entries(secrets).map(([profile, secret]) => [profile, secret.reference])
          )
        })
      );
      await recheck();
    }
    return frozen({ plan, records });
  } catch {
    fail(records);
  }
}
export async function recheckR3DatabaseTargets({ plan, records, executeAdmin }) {
  try {
    checkedPlan(plan);
    need(
      typeof executeAdmin === "function" &&
        Array.isArray(records) &&
        records.length === plan.targets.length
    );
    for (const [index, record] of records.entries()) {
      const item = plan.targets[index];
      need(
        record.databaseName === item.databaseName &&
          record.shard === item.shard &&
          record.kind === item.kind &&
          record.suiteId === item.suiteId &&
          record.name === item.name &&
          record.marker ===
            markerFor(
              plan,
              item,
              { requiredEphemeralMarker: "subscription-s1-ephemeral/v1" },
              record.createdAt
            )
      );
      const current = await observed(item, record.marker, executeAdmin);
      need(
        sha256Canonical(current) ===
          sha256Canonical({
            databaseOid: record.databaseOid,
            owner: record.owner,
            schemaOwner: record.schemaOwner,
            runtimeCanCreate: record.runtimeCanCreate,
            roleReadback: record.roleReadback,
            schemaPrivileges: record.schemaPrivileges
          })
      );
    }
    return true;
  } catch {
    fail();
  }
}
