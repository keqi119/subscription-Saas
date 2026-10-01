// Internal H1 reconstruction of the migration-only stages. The caller must
// authenticate the container transcript, retained originals and physical DB.
// This is not evidence that schema fixtures or runtime grants have run.
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { validateContract } from "../../packages/release-foundation/src/schema-registry.mjs";
import { deterministicPlanDigest } from "../../packages/release-foundation/src/proof-builders.mjs";
import { planMigration } from "../../apps/release-runner/src/commands/db-migrate-deploy.mjs";
import {
  assertAppliedMigrationPrefix,
  assertReadOnlyStatements
} from "../../apps/release-runner/src/commands/db-schema-verify.mjs";
import { validateFinalMigrationInput } from "../../apps/release-runner/src/final-migration-input.mjs";

const CODE = "R3_FINAL_MIGRATION_ASSESSMENT_INVALID";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const KINDS = [
  "target-identity",
  "migration-catalog",
  "migration-state",
  "schema-before",
  "tool-versions",
  "plan",
  "target-identity",
  "migration-catalog",
  "migration-state",
  "schema-before",
  "tool-versions",
  "apply",
  "target-identity",
  "verify"
];
const PHYSICAL_KEYS = [
  "databaseName",
  "databaseOid",
  "marker",
  "engineId",
  "postgresContainerId",
  "systemIdentifier",
  "databaseOwner",
  "schemaOwner"
];
const POSTCONDITIONS = [
  "migration-head-equals-catalog-head",
  "schema-diff-zero",
  "schema-owner-matches",
  "extensions-allowed"
];
const fail = () => {
  throw Object.assign(new Error(CODE), { code: CODE });
};
const need = (condition) => {
  if (!condition) fail();
};
const same = (left, right) => sha256Canonical(left) === sha256Canonical(right);
const own = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const iso = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const copy = (value) => freeze(structuredClone(value));
const migrationName = (entry) => entry?.path.split("/").at(-2) ?? null;

function inspectIdentity(rows, input, allowedExtensions) {
  need(Array.isArray(rows) && rows.length === 1 && rows[0] && typeof rows[0] === "object");
  const row = rows[0],
    db = input.database;
  need(
    row.databaseName === db.databaseName &&
      row.databaseOid === db.databaseOid &&
      row.marker === db.marker &&
      row.role === db.migrationRole &&
      row.tls === true &&
      row.databaseOwner === db.migrationRole &&
      row.schemaOwner === db.migrationRole &&
      row.canLogin === true &&
      ["superuser", "createdb", "createrole", "inherit", "replication", "bypassrls"].every(
        (key) => row[key] === false
      ) &&
      row.memberships === "0" &&
      row.grantedTo === "0" &&
      same(row.schemas, ["public"]) &&
      Array.isArray(row.extensions) &&
      row.extensions.every((extension) => allowedExtensions.includes(extension)) &&
      sha256Canonical({
        databaseName: row.databaseName,
        databaseOid: row.databaseOid,
        role: row.role,
        tls: row.tls
      }) === db.databaseIdentityFingerprint
  );
  return row;
}

function inspectBaselineFacts(
  { rows, catalog, current, schema, versions },
  held,
  migrationCatalog
) {
  const { input, parentBindingDigest, allowedExtensions } = held;
  const row = inspectIdentity(rows, input, allowedExtensions);
  need(same(catalog, migrationCatalog));
  assertAppliedMigrationPrefix(catalog, current?.appliedMigrations);
  need(
    current.databaseIdentityFingerprint === input.database.databaseIdentityFingerprint &&
      current.schemaOwner === input.database.migrationRole &&
      current.migrationHead === migrationName(current.appliedMigrations.at(-1)) &&
      same(schema?.appliedMigrations, current.appliedMigrations) &&
      schema.migrationHead === current.migrationHead &&
      schema.schemaOwner === current.schemaOwner &&
      same(schema.extensions, row.extensions) &&
      DIGEST.test(schema.schemaDigest) &&
      Array.isArray(schema.ownerInventory) &&
      schema.ownerInventory.length > 0 &&
      schema.ownerInventory.every(({ owner }) => owner === current.schemaOwner) &&
      [0, 2].includes(schema.schemaDiff?.exitCode) &&
      typeof schema.schemaDiff.stdout === "string" &&
      ["prisma", "psql", "postgresql"].every(
        (key) => typeof versions?.[key] === "string" && versions[key].length > 0
      )
  );
  assertReadOnlyStatements(schema.statements);
  return {
    identity: {
      parentBindingDigest,
      assignment: input.assignment,
      migrationContainerId: input.migrationContainerId,
      imageDigest: input.actualRunnerDigest,
      sourceSha: input.sourceSha,
      engineId: input.postgres.engineId,
      postgresContainerId: input.postgres.containerId,
      systemIdentifier: input.postgres.systemIdentifier,
      ...input.database,
      migrationCatalogDigest: catalog.digest,
      appliedMigrations: current.appliedMigrations,
      migrationHead: current.migrationHead,
      schemaOwner: current.schemaOwner,
      schemas: row.schemas,
      extensions: row.extensions,
      schemaDigest: schema.schemaDigest,
      ownerInventory: schema.ownerInventory
    },
    digests: {
      targetObservationDigest: sha256Canonical(row),
      migrationObservationDigest: sha256Canonical(current),
      schemaObservationDigest: sha256Canonical(schema)
    },
    versions
  };
}

function baselineFromClaim(baseline, held, catalog) {
  need(
    baseline?.schemaVersion === "r3-final-migration-baseline.v1" &&
      own(baseline, ["schemaVersion", "identity", "provenance"]) &&
      own(baseline.provenance, [
        "observedAt",
        "toolVersions",
        "targetObservationDigest",
        "migrationObservationDigest",
        "schemaObservationDigest"
      ]) &&
      iso(baseline.provenance.observedAt) &&
      ["targetObservationDigest", "migrationObservationDigest", "schemaObservationDigest"].every(
        (key) => DIGEST.test(baseline.provenance[key])
      )
  );
  const input = held.input,
    identity = baseline.identity;
  const fixed = {
    parentBindingDigest: held.parentBindingDigest,
    assignment: input.assignment,
    migrationContainerId: input.migrationContainerId,
    imageDigest: input.actualRunnerDigest,
    sourceSha: input.sourceSha,
    engineId: input.postgres.engineId,
    postgresContainerId: input.postgres.containerId,
    systemIdentifier: input.postgres.systemIdentifier,
    ...input.database,
    migrationCatalogDigest: catalog.digest
  };
  need(
    identity &&
      Object.entries(fixed).every(([key, value]) => same(identity[key], value)) &&
      Array.isArray(identity.appliedMigrations) &&
      identity.migrationHead === migrationName(identity.appliedMigrations.at(-1)) &&
      identity.schemaOwner === input.database.migrationRole &&
      same(identity.schemas, ["public"]) &&
      Array.isArray(identity.extensions) &&
      identity.extensions.every((name) => held.allowedExtensions.includes(name)) &&
      DIGEST.test(identity.schemaDigest) &&
      Array.isArray(identity.ownerInventory) &&
      identity.ownerInventory.length > 0 &&
      identity.ownerInventory.every(({ owner }) => owner === input.database.migrationRole) &&
      ["prisma", "psql", "postgresql"].every(
        (key) =>
          typeof baseline.provenance.toolVersions?.[key] === "string" &&
          baseline.provenance.toolVersions[key].length > 0
      )
  );
  assertAppliedMigrationPrefix(catalog, identity.appliedMigrations);
  need(
    own(identity, [
      ...Object.keys(fixed),
      "appliedMigrations",
      "migrationHead",
      "schemaOwner",
      "schemas",
      "extensions",
      "schemaDigest",
      "ownerInventory"
    ])
  );
}

function domainInput(held, baseline) {
  return {
    databaseIdentityFingerprint: held.input.database.databaseIdentityFingerprint,
    baselineManifestIdentityDigest: sha256Canonical(baseline.identity),
    baselineManifestDigest: sha256Canonical(baseline),
    expectedSchemaDigest: held.input.expectedSchemaDigest,
    expectedOwner: held.input.database.migrationRole,
    allowedExtensions: held.allowedExtensions
  };
}

async function recomputePlan(held, baseline, catalog) {
  const domain = domainInput(held, baseline);
  return planMigration(
    {
      loadMigrationCatalog: async () => catalog,
      observeMigrationState: async () => ({
        appliedMigrations: baseline.identity.appliedMigrations,
        migrationHead: baseline.identity.migrationHead,
        databaseIdentityFingerprint: domain.databaseIdentityFingerprint,
        schemaOwner: baseline.identity.schemaOwner
      }),
      readToolVersions: async () => baseline.provenance.toolVersions
    },
    domain
  );
}

function inspectResult(result, stage, held, predecessor, baseline, planDigest) {
  const payload =
    stage === "plan"
      ? ["baseline", "plan", "originals"]
      : stage === "apply"
        ? ["postStateObservation"]
        : ["observation", "originals", "processOriginals"];
  need(
    own(result, [
      "schemaVersion",
      "stage",
      "bindingDigest",
      "predecessorDigest",
      "baselineManifestIdentityDigest",
      "baselineManifestDigest",
      "planDigest",
      ...payload
    ]) &&
      result.schemaVersion === "r3-final-migration-result.v1" &&
      result.stage === stage &&
      result.bindingDigest === sha256Canonical(held.input) &&
      result.predecessorDigest === predecessor
  );
  if (baseline)
    need(
      result.baselineManifestIdentityDigest === sha256Canonical(baseline.identity) &&
        result.baselineManifestDigest === sha256Canonical(baseline) &&
        result.planDigest === planDigest
    );
}

function inspectApply(post, held, baseline, planDigest, catalog) {
  validateContract("post-state-observation.v1", post);
  const head = migrationName(catalog.entries.at(-1));
  need(
    post.operationId === held.input.operationId &&
      post.attemptId === held.input.attemptId &&
      post.runId === held.input.runId &&
      post.baselineManifestIdentityDigest === sha256Canonical(baseline.identity) &&
      post.baselineManifestDigest === sha256Canonical(baseline) &&
      post.commandId === "db.migrate.deploy" &&
      post.commandVersion === "1" &&
      post.planDigest === planDigest &&
      post.databaseIdentityFingerprint === held.input.database.databaseIdentityFingerprint &&
      post.postMigrationHead === head &&
      post.postSchemaDigest === held.input.expectedSchemaDigest &&
      iso(post.observedAt) &&
      post.observedAt >= baseline.provenance.observedAt &&
      Array.isArray(post.postconditions) &&
      post.postconditions.length === POSTCONDITIONS.length
  );
  const expected = [
    head,
    { exitCode: 0, stdout: "" },
    held.input.database.migrationRole,
    [...held.allowedExtensions].sort()
  ];
  for (const [index, condition] of post.postconditions.entries()) {
    const value = sha256Canonical(expected[index]);
    need(
      own(condition, ["id", "status", "expectedDigest", "actualDigest"]) &&
        condition.id === POSTCONDITIONS[index] &&
        condition.status === "PASSED" &&
        condition.expectedDigest === value &&
        condition.actualDigest === value
    );
  }
}

function inspectPlanOriginals(originals, held, catalog, baseline, plan) {
  need(
    Array.isArray(originals) &&
      originals.length === 6 &&
      originals.every(
        (entry, index) => own(entry, ["kind", "value"]) && entry.kind === KINDS[index]
      )
  );
  const first = inspectBaselineFacts(
    {
      rows: originals[0].value,
      catalog: originals[1].value,
      current: originals[2].value,
      schema: originals[3].value,
      versions: originals[4].value
    },
    held,
    catalog
  );
  need(
    same(first.identity, baseline.identity) &&
      same(first.versions, baseline.provenance.toolVersions) &&
      Object.entries(first.digests).every(([key, value]) => baseline.provenance[key] === value) &&
      same(originals[5].value, plan)
  );
  return first;
}

function inspectOriginals(
  originals,
  planOriginals,
  held,
  catalog,
  baseline,
  plan,
  post,
  observation
) {
  need(
    Array.isArray(originals) &&
      originals.length === KINDS.length &&
      originals.every(
        (entry, index) => own(entry, ["kind", "value"]) && entry.kind === KINDS[index]
      )
  );
  need(same(originals.slice(0, 6), planOriginals));
  const first = inspectPlanOriginals(planOriginals, held, catalog, baseline, plan);
  const locked = inspectBaselineFacts(
    {
      rows: originals[6].value,
      catalog: originals[7].value,
      current: originals[8].value,
      schema: originals[9].value,
      versions: originals[10].value
    },
    held,
    catalog
  );
  need(
    same(locked.identity, baseline.identity) &&
      same(locked.versions, first.versions) &&
      same(originals[11].value, post) &&
      same(originals[13].value, observation)
  );
  inspectIdentity(originals[12].value, held.input, held.allowedExtensions);
  return { firstSchema: originals[3].value, lockedSchema: originals[9].value };
}

function inspectVerify(observation, held, catalog, post) {
  const head = migrationName(catalog.entries.at(-1));
  need(
    own(observation, [
      "schemaVersion",
      "catalogDigest",
      "migrationHead",
      "migrationChecksums",
      "schemaDigest",
      "schemaOwner",
      "ownerInventory",
      "extensions",
      "schemaDiff",
      "toolVersions",
      "statementLogDigest",
      "terminalStatus"
    ]) &&
      observation.schemaVersion === "schema-observation.v1" &&
      observation.terminalStatus === "PASSED" &&
      observation.catalogDigest === catalog.digest &&
      observation.migrationHead === head &&
      same(observation.migrationChecksums, catalog.entries) &&
      observation.schemaDigest === held.input.expectedSchemaDigest &&
      observation.schemaOwner === held.input.database.migrationRole &&
      Array.isArray(observation.ownerInventory) &&
      observation.ownerInventory.length > 0 &&
      observation.ownerInventory.every(
        ({ owner }) => owner === held.input.database.migrationRole
      ) &&
      Array.isArray(observation.extensions) &&
      observation.extensions.every((name) => held.allowedExtensions.includes(name)) &&
      observation.schemaDiff?.exitCode === 0 &&
      observation.schemaDiff.stdout?.trim() === "" &&
      ["prisma", "psql", "postgresql"].every(
        (key) =>
          typeof observation.toolVersions?.[key] === "string" &&
          observation.toolVersions[key].length > 0
      ) &&
      DIGEST.test(observation.statementLogDigest) &&
      post.configurationFingerprint ===
        sha256Canonical({
          schemaOwner: observation.schemaOwner,
          extensions: observation.extensions,
          toolVersions: observation.toolVersions
        })
  );
}

function inspectProcesses(processes, baseline, firstSchema, lockedSchema, observation, plan) {
  need(Array.isArray(processes) && processes.length <= 32);
  const prisma = "/app/apps/release-runner/node_modules/.bin/prisma";
  const schema = "/app/apps/api/prisma/schema.prisma";
  const config = "/app/apps/api/prisma.config.ts";
  const commands = {
    diff: [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      schema,
      "--exit-code",
      "--config",
      config
    ],
    script: [
      "migrate",
      "diff",
      "--from-empty",
      "--to-config-datasource",
      "--script",
      "--config",
      config
    ],
    deploy: ["migrate", "deploy", "--schema", schema, "--config", config],
    prismaVersion: ["--version"],
    psqlVersion: ["--version"]
  };
  const groups = Object.fromEntries(Object.keys(commands).map((name) => [name, []]));
  let byteCount = 0;
  for (const record of processes) {
    need(
      own(record, [
        "command",
        "args",
        "pid",
        "startedAt",
        "finishedAt",
        "closed",
        "exitCode",
        "signal",
        "stdout",
        "stderr",
        "timedOut",
        "aborted",
        "truncated",
        "terminationRequested"
      ]) &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        iso(record.startedAt) &&
        iso(record.finishedAt) &&
        record.startedAt <= record.finishedAt &&
        record.closed === true &&
        record.signal === null &&
        record.timedOut === false &&
        record.aborted === false &&
        record.truncated === false &&
        record.terminationRequested === false &&
        typeof record.stdout === "string" &&
        typeof record.stderr === "string"
    );
    byteCount += Buffer.byteLength(record.stdout) + Buffer.byteLength(record.stderr);
    need(
      byteCount <= 16 * 1024 * 1024 &&
        Buffer.byteLength(record.stdout) + Buffer.byteLength(record.stderr) <= 2 * 1024 * 1024
    );
    let matched = false;
    for (const [name, args] of Object.entries(commands)) {
      if (
        (name === "psqlVersion" ? record.command === "psql" : record.command === prisma) &&
        same(record.args, args)
      ) {
        groups[name].push(record);
        matched = true;
        break;
      }
    }
    need(
      matched &&
        (record.exitCode === 0 || (same(record.args, commands.diff) && record.exitCode === 2))
    );
  }
  need(
    groups.diff.length === 4 &&
      groups.script.length === 4 &&
      groups.prismaVersion.length === 6 &&
      groups.psqlVersion.length === 6 &&
      groups.deploy.length === (plan.identity.pendingMigrations.length > 0 ? 1 : 0)
  );
  const schemas = [firstSchema, lockedSchema, observation, observation];
  for (let index = 0; index < 4; index++) {
    const diff = groups.diff[index],
      script = groups.script[index],
      expected = schemas[index];
    need(
      diff.exitCode === expected.schemaDiff.exitCode &&
        diff.stdout === expected.schemaDiff.stdout &&
        script.exitCode === 0 &&
        sha256Bytes(Buffer.from(script.stdout, "utf8")) === expected.schemaDigest
    );
  }
  need(
    groups.prismaVersion.every(
      (record) =>
        record.exitCode === 0 && record.stdout.trim() === baseline.provenance.toolVersions.prisma
    ) &&
      groups.psqlVersion.every(
        (record) =>
          record.exitCode === 0 && record.stdout.trim() === baseline.provenance.toolVersions.psql
      )
  );
}

export function createR3FinalMigrationAssessment({
  input,
  manifest,
  migrationCatalog,
  globalObjectPolicy,
  observeTarget
}) {
  let held, catalog;
  try {
    need(typeof observeTarget === "function");
    held = validateFinalMigrationInput({ input, manifest, migrationCatalog, globalObjectPolicy });
    catalog = copy(migrationCatalog);
  } catch {
    fail();
  }
  let state = "new",
    baseline,
    plan,
    planDigest,
    planResult,
    applyResult,
    verifyResult;
  const physicalDigests = [];
  const physical = async (stage) => {
    const value = await observeTarget({ stage, input: held.input });
    need(own(value, PHYSICAL_KEYS));
    const db = held.input.database,
      pg = held.input.postgres;
    need(
      value.databaseName === db.databaseName &&
        value.databaseOid === db.databaseOid &&
        value.marker === db.marker &&
        value.engineId === pg.engineId &&
        value.postgresContainerId === pg.containerId &&
        value.systemIdentifier === pg.systemIdentifier &&
        value.databaseOwner === db.migrationRole &&
        value.schemaOwner === db.migrationRole
    );
    physicalDigests.push(sha256Canonical(value));
  };
  return Object.freeze({
    async assess({ stage, result }) {
      try {
        need(
          (state === "new" && stage === "plan") ||
            (state === "planned" && stage === "apply") ||
            (state === "applied" && stage === "verify")
        );
        result = copy(result);
        if (stage === "plan") {
          baseline = result.baseline;
          baselineFromClaim(baseline, held, catalog);
          plan = await recomputePlan(held, baseline, catalog);
          planDigest = deterministicPlanDigest(plan);
          inspectResult(result, stage, held, sha256Canonical(held.input), baseline, planDigest);
          need(same(result.plan, plan));
          inspectPlanOriginals(result.originals, held, catalog, baseline, plan);
          await physical(stage);
          planResult = result;
          state = "planned";
        } else if (stage === "apply") {
          inspectResult(result, stage, held, sha256Canonical(planResult), baseline, planDigest);
          inspectApply(result.postStateObservation, held, baseline, planDigest, catalog);
          await physical(stage);
          applyResult = result;
          state = "applied";
        } else {
          inspectResult(result, stage, held, sha256Canonical(applyResult), baseline, planDigest);
          inspectVerify(result.observation, held, catalog, applyResult.postStateObservation);
          const { firstSchema, lockedSchema } = inspectOriginals(
            result.originals,
            planResult.originals,
            held,
            catalog,
            baseline,
            plan,
            applyResult.postStateObservation,
            result.observation
          );
          inspectProcesses(
            result.processOriginals,
            baseline,
            firstSchema,
            lockedSchema,
            result.observation,
            plan
          );
          await physical(stage);
          verifyResult = result;
          state = "verified";
        }
        return freeze({ stage, resultDigest: sha256Canonical(result) });
      } catch (cause) {
        state = "failed";
        const error = Object.assign(new Error(CODE), { code: CODE });
        Object.defineProperty(error, "cause", { value: cause });
        throw error;
      }
    },
    finish() {
      need(state === "verified");
      state = "finished";
      const migrationEvidence = freeze({
        scope: "schema-migration",
        inputDigest: sha256Canonical(held.input),
        parentBindingDigest: held.parentBindingDigest,
        assignment: copy(held.input.assignment),
        targetLockDigest: held.input.database.targetLockDigest,
        migrationCatalogDigest: catalog.digest,
        expectedSchemaDigest: held.input.expectedSchemaDigest,
        baselineManifestDigest: sha256Canonical(baseline),
        planDigest,
        planResultDigest: sha256Canonical(planResult),
        planOriginalsDigest: sha256Canonical(planResult.originals),
        applyResultDigest: sha256Canonical(applyResult),
        verifyResultDigest: sha256Canonical(verifyResult),
        originalsDigest: sha256Canonical(verifyResult.originals),
        processOriginalsDigest: sha256Canonical(verifyResult.processOriginals),
        physicalObservationDigests: [...physicalDigests]
      });
      return freeze({
        expectedSchemaDigest: held.input.expectedSchemaDigest,
        migrationEvidence,
        migrationEvidenceDigest: sha256Canonical(migrationEvidence)
      });
    }
  });
}
