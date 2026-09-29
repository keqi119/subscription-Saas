// Internal execution inside the isolated migration container. H1 must authenticate
// the input, image/CIDs and physical lock, and retain the actual process originals.
// Neither this session nor its self-reported results grant execution authority.
import {
  deterministicPlanDigest,
  sha256Bytes,
  sha256Canonical
} from "@subscription-saas/release-foundation";
import { planMigration, applyMigration } from "./commands/db-migrate-deploy.mjs";
import {
  assertAppliedMigrationPrefix,
  assertReadOnlyStatements,
  verifySchema
} from "./commands/db-schema-verify.mjs";
import { validateFinalMigrationInput } from "./final-migration-input.mjs";
import { runnerError } from "./error-codes.mjs";

const same = (a, b) => sha256Canonical(a) === sha256Canonical(b);
const need = (condition, code = "R3_FINAL_MIGRATION_OBSERVATION_INVALID") => {
  if (!condition) throw runnerError(code);
};
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key).get === undefined
    )
  );
}

// Run on the transaction supplied by withMigrationLock during apply. Using the
// outer connector here would deadlock its single-connection pool under the lock.
const identitySql = `
  SELECT d.datname::text AS "databaseName", d.oid::text AS "databaseOid",
    current_user::text AS role,
    EXISTS(SELECT 1 FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS tls,
    ARRAY(SELECT nspname::text FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
      AND nspname<>'information_schema' ORDER BY nspname) AS schemas,
    ARRAY(SELECT extname::text FROM pg_extension ORDER BY extname) AS extensions,
    COALESCE(shobj_description(d.oid,'pg_database'),'') AS marker,
    pg_get_userbyid(d.datdba) AS "databaseOwner",
    (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public') AS "schemaOwner",
    r.rolcanlogin AS "canLogin", r.rolsuper AS superuser, r.rolcreatedb AS createdb,
    r.rolcreaterole AS createrole, r.rolinherit AS inherit, r.rolreplication AS replication,
    r.rolbypassrls AS bypassrls,
    (SELECT count(*)::text FROM pg_auth_members WHERE member=r.oid) AS memberships,
    (SELECT count(*)::text FROM pg_auth_members WHERE roleid=r.oid) AS "grantedTo"
  FROM pg_database d CROSS JOIN pg_roles r
  WHERE d.datname=current_database() AND r.rolname=current_user
`;

export function validateFinalMigrationCredential(input, credential) {
  need(
    exact(credential, ["username", "password", "capabilityProfile"]) &&
      credential.username === input.database.migrationRole &&
      credential.capabilityProfile === "migrate" &&
      typeof credential.password === "string" &&
      credential.password.length >= 16 &&
      sha256Bytes(Buffer.from(credential.password, "utf8")) ===
        input.database.migrationCredentialFingerprint,
    "R3_FINAL_MIGRATION_CREDENTIAL_INVALID"
  );
}

export function createFinalMigrationSession({
  input,
  manifest,
  migrationCatalog,
  globalObjectPolicy,
  database,
  credential,
  now = () => new Date()
}) {
  const held = validateFinalMigrationInput({
    input,
    manifest,
    migrationCatalog,
    globalObjectPolicy
  });
  migrationCatalog = freeze(structuredClone(migrationCatalog));
  input = held.input;
  validateFinalMigrationCredential(input, credential);
  need(
    [
      "$queryRawUnsafe",
      "loadMigrationCatalog",
      "observeMigrationState",
      "observeSchema",
      "readToolVersions",
      "withMigrationLock",
      "executePrismaMigrateDeploy"
    ].every((key) => typeof database?.[key] === "function")
  );
  const bindingDigest = sha256Canonical(input),
    originals = [];
  let state = "new",
    busy = false,
    baseline,
    domainInput,
    plan,
    planDigest,
    previous;
  const live = (expected) => need(state === expected, "R3_FINAL_MIGRATION_SEQUENCE_INVALID");
  const capture = async (kind, work) => {
    const value = await work();
    originals.push(freeze({ kind, value: structuredClone(value) }));
    return value;
  };
  const observedAt = () => {
    const value = now().toISOString();
    need(Number.isFinite(Date.parse(value)));
    return value;
  };
  async function identity(connection) {
    const rows = await capture("target-identity", () => connection.$queryRawUnsafe(identitySql));
    need(Array.isArray(rows) && rows.length === 1);
    const row = rows[0],
      target = input.database;
    need(
      row.databaseName === target.databaseName &&
        row.databaseOid === target.databaseOid &&
        row.role === target.migrationRole &&
        row.tls === true &&
        row.marker === target.marker &&
        row.databaseOwner === target.migrationRole &&
        row.schemaOwner === target.migrationRole &&
        row.canLogin === true &&
        ["superuser", "createdb", "createrole", "inherit", "replication", "bypassrls"].every(
          (key) => row[key] === false
        ) &&
        row.memberships === "0" &&
        row.grantedTo === "0" &&
        same(row.schemas, ["public"]) &&
        Array.isArray(row.extensions) &&
        row.extensions.every((extension) => held.allowedExtensions.includes(extension))
    );
    const fingerprint = sha256Canonical({
      databaseName: row.databaseName,
      databaseOid: row.databaseOid,
      role: row.role,
      tls: row.tls
    });
    need(fingerprint === target.databaseIdentityFingerprint);
    database.databaseIdentityFingerprint = fingerprint;
    return row;
  }
  async function observeBaseline(connection) {
    const row = await identity(connection);
    const catalog = await capture("migration-catalog", () => database.loadMigrationCatalog());
    need(same(catalog, migrationCatalog));
    const current = await capture("migration-state", () => database.observeMigrationState());
    assertAppliedMigrationPrefix(catalog, current.appliedMigrations);
    need(
      current.databaseIdentityFingerprint === input.database.databaseIdentityFingerprint &&
        current.schemaOwner === input.database.migrationRole &&
        current.migrationHead === (current.appliedMigrations.at(-1)?.path.split("/").at(-2) ?? null)
    );
    const schema = await capture("schema-before", () => database.observeSchema());
    need(
      same(schema.appliedMigrations, current.appliedMigrations) &&
        schema.migrationHead === current.migrationHead &&
        schema.schemaOwner === current.schemaOwner &&
        same(schema.extensions, row.extensions) &&
        /^sha256:[0-9a-f]{64}$/.test(schema.schemaDigest) &&
        Array.isArray(schema.ownerInventory) &&
        schema.ownerInventory.length > 0 &&
        schema.ownerInventory.every(({ owner }) => owner === current.schemaOwner) &&
        [0, 2].includes(schema.schemaDiff?.exitCode) &&
        typeof schema.schemaDiff.stdout === "string"
    );
    assertReadOnlyStatements(schema.statements);
    const toolVersions = await capture("tool-versions", () => database.readToolVersions());
    need(
      ["prisma", "psql", "postgresql"].every(
        (key) => typeof toolVersions[key] === "string" && toolVersions[key].length > 0
      )
    );
    return freeze({
      schemaVersion: "r3-final-migration-baseline.v1",
      identity: {
        parentBindingDigest: held.parentBindingDigest,
        assignment: input.assignment,
        migrationContainerId: input.migrationContainerId,
        imageDigest: input.actualRunnerDigest,
        sourceSha: input.sourceSha,
        engineId: input.postgres.engineId,
        postgresContainerId: input.postgres.containerId,
        systemIdentifier: input.postgres.systemIdentifier,
        ...input.database,
        migrationCatalogDigest: catalog.digest,
        appliedMigrations: structuredClone(current.appliedMigrations),
        migrationHead: current.migrationHead,
        schemaOwner: current.schemaOwner,
        schemas: [...row.schemas],
        extensions: [...row.extensions],
        schemaDigest: schema.schemaDigest,
        ownerInventory: structuredClone(schema.ownerInventory)
      },
      provenance: {
        observedAt: observedAt(),
        toolVersions: { ...toolVersions },
        targetObservationDigest: sha256Canonical(row),
        migrationObservationDigest: sha256Canonical(current),
        schemaObservationDigest: sha256Canonical(schema)
      }
    });
  }
  function result(stage, payload) {
    return freeze({
      schemaVersion: "r3-final-migration-result.v1",
      stage,
      bindingDigest,
      predecessorDigest: previous ? sha256Canonical(previous) : bindingDigest,
      baselineManifestIdentityDigest: sha256Canonical(baseline.identity),
      baselineManifestDigest: sha256Canonical(baseline),
      planDigest,
      ...payload
    });
  }
  const perform = async (expected, next, work) => {
    if (busy || state !== expected) {
      state = "failed";
      throw runnerError("R3_FINAL_MIGRATION_SEQUENCE_INVALID");
    }
    busy = true;
    try {
      const value = await work();
      live(expected);
      previous = value;
      state = next;
      return value;
    } catch (cause) {
      state = "failed";
      const error = runnerError("R3_FINAL_MIGRATION_FAILED");
      Object.defineProperties(error, {
        cause: { value: cause },
        originals: { value: freeze(originals.slice()) }
      });
      throw error;
    } finally {
      busy = false;
    }
  };
  return Object.freeze({
    plan: (...args) =>
      perform("new", "planned", async () => {
        need(args.length === 0);
        baseline = await observeBaseline(database);
        live("new");
        domainInput = freeze({
          databaseIdentityFingerprint: input.database.databaseIdentityFingerprint,
          baselineManifestIdentityDigest: sha256Canonical(baseline.identity),
          baselineManifestDigest: sha256Canonical(baseline),
          expectedSchemaDigest: input.expectedSchemaDigest,
          expectedOwner: input.database.migrationRole,
          allowedExtensions: held.allowedExtensions
        });
        plan = await capture("plan", () => planMigration(database, domainInput));
        need(
          plan.identity.migrationCatalogDigest === input.migrationCatalogDigest &&
            plan.identity.currentMigrationHead === baseline.identity.migrationHead &&
            same(
              plan.identity.pendingMigrations,
              migrationCatalog.entries.slice(baseline.identity.appliedMigrations.length)
            )
        );
        planDigest = deterministicPlanDigest(plan);
        return result("plan", { baseline, plan, originals: originals.slice() });
      }),
    apply: (request) =>
      perform("planned", "applied", async () => {
        need(
          exact(request, ["predecessorDigest", "planDigest"]) &&
            request.predecessorDigest === sha256Canonical(previous) &&
            request.planDigest === planDigest
        );
        const lockedDatabase = Object.create(database);
        lockedDatabase.executePrismaMigrateDeploy = (options) => {
          // planMigration awaits observations after the lock's baseline check.
          // An intervening invalid/concurrent call must prevent the next write.
          live("planned");
          return database.executePrismaMigrateDeploy(options);
        };
        lockedDatabase.withMigrationLock = (work) =>
          database.withMigrationLock(async (transaction) => {
            live("planned");
            need(typeof transaction?.$queryRawUnsafe === "function");
            const current = await observeBaseline(transaction);
            need(
              same(current.identity, baseline.identity) &&
                same(current.provenance.toolVersions, baseline.provenance.toolVersions),
              "R3_FINAL_MIGRATION_BASELINE_CHANGED"
            );
            live("planned");
            return work();
          });
        const { operationId, attemptId, runId } = input;
        const postStateObservation = await capture("apply", () =>
          applyMigration(
            lockedDatabase,
            { input: domainInput, planDigest },
            { executionIdentity: { operationId, attemptId, runId } }
          )
        );
        need(postStateObservation.postconditions.every(({ status }) => status === "PASSED"));
        return result("apply", { postStateObservation });
      }),
    verify: (request) =>
      perform("applied", "verified", async () => {
        need(
          exact(request, ["predecessorDigest"]) &&
            request.predecessorDigest === sha256Canonical(previous)
        );
        await identity(database);
        live("applied");
        const observation = await capture("verify", () => verifySchema(database, domainInput));
        need(observation.catalogDigest === input.migrationCatalogDigest);
        return result("verify", { observation, originals: originals.slice() });
      })
  });
}
