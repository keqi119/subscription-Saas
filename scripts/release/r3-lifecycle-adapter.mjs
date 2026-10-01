// Internal callbacks for the two existing lifecycle tests. The native holder
// supplies captured connections and authority; this module grants neither.
import {
  assertApprovedEphemeralTarget,
  cleanupSuiteDatabase,
  grantRuntimeEquivalentAccess,
  provisionSuiteDatabase,
  sha256Canonical,
  sqlLiteral,
  suiteDatabaseName
} from "../../packages/release-foundation/src/index.mjs";

const CODE = "R3_LIFECYCLE_ADAPTER_UNAVAILABLE";
const fail = (code = CODE) => {
  throw Object.assign(new Error(code), { code });
};

export function createR3LifecycleAdapter({
  plan,
  target,
  policy,
  executeAdmin,
  executeCredential,
  secretStore,
  migrate,
  prepareRuntimeAccess,
  registerTarget,
  recheck,
  observations
}) {
  assertApprovedEphemeralTarget(target, policy);
  if (
    !Object.isFrozen(plan) ||
    plan.reservations?.length !== 2 ||
    !Array.isArray(observations) ||
    [executeAdmin, executeCredential, migrate, registerTarget, recheck].some(
      (value) => typeof value !== "function"
    )
  )
    fail();
  if (
    prepareRuntimeAccess !== undefined &&
    (plan.phase !== "final" || typeof prepareRuntimeAccess !== "function")
  )
    fail();
  for (const [shard, reservation] of plan.reservations.entries()) {
    if (
      reservation.shard !== shard ||
      reservation.suiteIdentity !== "database-lifecycle" ||
      reservation.databaseName !== suiteDatabaseName(plan.operationRef, "database-lifecycle", shard)
    )
      fail();
  }
  const records = new Map(),
    attempted = new Set(),
    cleaned = new Set(),
    expectedFailures = new WeakSet();
  let pending = Promise.resolve(),
    failed = false;
  const serial = (work) => {
    const next = pending.then(async () => {
      if (failed) fail();
      await recheck();
      return work();
    });
    pending = next.catch((error) => {
      if (!expectedFailures.has(error)) failed = true;
    });
    return next;
  };
  const known = (record, allowCleaned = false, code = CODE) => {
    const original = records.get(record?.databaseName);
    if (
      !original ||
      sha256Canonical(original) !== sha256Canonical(record) ||
      (!allowCleaned && cleaned.has(record.databaseName))
    )
      fail(code);
    return original;
  };
  const observe = async (stage, record, work) => {
    const value = await work();
    observations.push({ stage, databaseName: record.databaseName, value });
    await recheck();
    return value;
  };
  const queryRuntime = (stage, sql) => (record) =>
    serial(() => {
      known(record);
      return observe(stage, record, () =>
        executeCredential({ record, profile: "runtime-test", sql })
      );
    });
  return Object.freeze({
    runId: plan.operationRef,
    target,
    policy,
    reservations: plan.reservations,
    provision: (shard) =>
      serial(async () => {
        if (![0, 1].includes(shard) || attempted.has(shard)) fail();
        attempted.add(shard);
        const record = await provisionSuiteDatabase({
          target,
          policy,
          runId: plan.operationRef,
          suiteId: "database-lifecycle",
          shard,
          executeAdmin,
          secretStore,
          enableRestore: plan.chain === "snapshot"
        });
        if (sha256Canonical(record.roles) !== sha256Canonical(plan.reservations[shard].roles))
          fail();
        const identity = await executeAdmin({
          databaseName: "postgres",
          sql: `SELECT d.oid::text AS "oid", COALESCE(shobj_description(d.oid,'pg_database'),'') AS "marker", pg_get_userbyid(d.datdba) AS "owner" FROM pg_database d WHERE d.datname=${sqlLiteral(record.databaseName)}`
        });
        if (
          identity.rows?.length !== 1 ||
          identity.rows[0].oid !== record.databaseOid ||
          identity.rows[0].marker !== record.marker ||
          identity.rows[0].owner !== record.roles.migrate
        )
          fail();
        const lock = await registerTarget(record);
        records.set(record.databaseName, record);
        observations.push({ stage: "provision", record, identity, lock });
        await recheck();
        return record;
      }),
    migrate: (record) =>
      serial(() => {
        known(record);
        return observe("migrate", record, () => migrate(record));
      }),
    grantRuntimeAccess: (record) =>
      serial(async () => {
        known(record);
        // The final image has already applied and verified these grants in its
        // isolated migration process. Its H1 callback only reobserves them.
        if (prepareRuntimeAccess) await prepareRuntimeAccess(record);
        else
          await grantRuntimeEquivalentAccess({
            databaseName: record.databaseName,
            migrationRole: record.roles.migrate,
            runtimeRole: record.roles["runtime-test"],
            executeDatabase: ({ databaseName, sql }) => {
              if (databaseName !== record.databaseName) fail();
              return executeCredential({ record, profile: "migrate", sql });
            }
          });
        observations.push({
          stage: prepareRuntimeAccess ? "grant-runtime-observed" : "grant-runtime",
          databaseName: record.databaseName
        });
        await recheck();
      }),
    runtimeRole: queryRuntime(
      "runtime-role",
      [
        'SELECT rolsuper::text AS "super", rolcreatedb::text AS "createdb",',
        'rolcreaterole::text AS "createrole", rolbypassrls::text AS "bypassrls",',
        'rolcanlogin::text AS "login" FROM pg_roles WHERE rolname=current_user'
      ].join(" ")
    ),
    migrationOwnership: queryRuntime(
      "migration-ownership",
      [
        'SELECT pg_get_userbyid(n.nspowner) AS "schemaOwner",',
        `(SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations') AS "migrationOwner",`,
        `has_schema_privilege(current_user,'public','CREATE')::text AS "canCreate",`,
        '(SELECT COUNT(*)::text FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS "memberships",',
        '(SELECT COUNT(*)::text FROM public._prisma_migrations) AS "migrationCount"',
        "FROM pg_namespace n WHERE n.nspname='public'"
      ].join(" ")
    ),
    attemptRuntimeCreate: (record) =>
      serial(async () => {
        known(record);
        try {
          await executeCredential({
            record,
            profile: "runtime-test",
            sql: 'CREATE TABLE "runtime_must_not_create" ("id" integer);'
          });
        } catch (error) {
          if (error?.code === "42501") {
            expectedFailures.add(error);
            observations.push({
              stage: "runtime-create-denied",
              databaseName: record.databaseName,
              sqlState: "42501"
            });
            await recheck();
          }
          throw error;
        }
      }),
    cleanup: (record) =>
      serial(async () => {
        try {
          known(record, false, "CLEANUP_IDENTITY_MISMATCH");
        } catch (error) {
          expectedFailures.add(error);
          observations.push({ stage: "forged-cleanup-refused", code: error.code });
          throw error;
        }
        await cleanupSuiteDatabase(record, { target, policy, executeAdmin });
        cleaned.add(record.databaseName);
        observations.push({
          stage: "cleanup",
          databaseName: record.databaseName,
          recordDigest: sha256Canonical(record)
        });
        await recheck();
      }),
    countDatabase: (record) =>
      serial(() => {
        known(record, true);
        return observe("database-absence", record, () =>
          executeAdmin({
            databaseName: "postgres",
            sql: `SELECT COUNT(*)::text AS "count" FROM pg_database WHERE datname=${sqlLiteral(record.databaseName)}`
          })
        );
      }),
    siblingDatabase: queryRuntime(
      "sibling-connection",
      'SELECT current_database() AS "databaseName"'
    ),
    countOwned: () =>
      serial(async () => {
        if (records.size !== 2 || cleaned.size !== 2) fail();
        const value = await executeAdmin({
          databaseName: "postgres",
          sql: `SELECT COUNT(*)::text AS "count" FROM pg_database WHERE datname IN (${plan.reservations.map((entry) => sqlLiteral(entry.databaseName)).join(", ")})`
        });
        observations.push({ stage: "owned-absence", value });
        await recheck();
        return value;
      })
  });
}
