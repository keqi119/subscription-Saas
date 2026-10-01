import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes, sha256Canonical } from "../../packages/release-foundation/src/digest.mjs";
import { finalMigrationInputFixture } from "../../apps/release-runner/test/fixtures/final-migration-input.mjs";
import { createFinalMigrationSession } from "../../apps/release-runner/src/final-migration-session.mjs";
import { createR3FinalMigrationAssessment } from "./r3-final-migration-result.mjs";

const digest = sha256Canonical;
const schema = (text) => sha256Bytes(Buffer.from(text));
const iso = "2026-09-29T01:00:00.000Z";

async function fixture(options) {
  const values = await finalMigrationInputFixture(options);
  const { input, migrationCatalog } = values;
  const password = "synthetic-migration-only-password";
  input.database.migrationCredentialFingerprint = sha256Bytes(Buffer.from(password));
  input.expectedSchemaDigest = schema("complete schema");
  let complete = false;
  const identity = () => ({
    databaseName: input.database.databaseName,
    databaseOid: input.database.databaseOid,
    role: input.database.migrationRole,
    tls: true,
    schemas: ["public"],
    extensions: complete ? ["btree_gist", "pgcrypto", "plpgsql"] : ["plpgsql"],
    marker: input.database.marker,
    databaseOwner: input.database.migrationRole,
    schemaOwner: input.database.migrationRole,
    canLogin: true,
    superuser: false,
    createdb: false,
    createrole: false,
    inherit: false,
    replication: false,
    bypassrls: false,
    memberships: "0",
    grantedTo: "0"
  });
  const head = () => (complete ? migrationCatalog.entries.at(-1).path.split("/").at(-2) : null);
  const database = {
    $queryRawUnsafe: async () => [identity()],
    loadMigrationCatalog: async () => structuredClone(migrationCatalog),
    observeMigrationState: async () => ({
      appliedMigrations: complete ? migrationCatalog.entries : [],
      migrationHead: head(),
      databaseIdentityFingerprint: input.database.databaseIdentityFingerprint,
      schemaOwner: input.database.migrationRole
    }),
    observeSchema: async () => ({
      appliedMigrations: complete ? migrationCatalog.entries : [],
      migrationHead: head(),
      schemaDigest: schema(complete ? "complete schema" : "empty schema"),
      schemaOwner: input.database.migrationRole,
      ownerInventory: [
        { objectClass: "schema", objectName: "public", owner: input.database.migrationRole }
      ],
      extensions: identity().extensions,
      schemaDiff: { exitCode: complete ? 0 : 2, stdout: complete ? "" : "pending DDL" },
      statements: ["SELECT current_database()"]
    }),
    readToolVersions: async () => ({
      prisma: "Prisma 7.8.0",
      psql: "psql (PostgreSQL) 17.11",
      postgresql: "17.11"
    }),
    withMigrationLock: async (work) => work({ $queryRawUnsafe: async () => [identity()] }),
    executePrismaMigrateDeploy: async () => {
      complete = true;
    },
    now: () => new Date(iso)
  };
  const session = createFinalMigrationSession({
    ...values,
    database,
    credential: { username: input.database.migrationRole, password, capabilityProfile: "migrate" },
    now: database.now
  });
  const plan = await session.plan();
  assert.equal(plan.originals.length, 6);
  const apply = await session.apply({
    predecessorDigest: digest(plan),
    planDigest: plan.planDigest
  });
  const verify = await session.verify({ predecessorDigest: digest(apply) });
  const prisma = "/app/apps/release-runner/node_modules/.bin/prisma";
  const config = "/app/apps/api/prisma.config.ts";
  const schemaPath = "/app/apps/api/prisma/schema.prisma";
  const original = (command, args, stdout, exitCode = 0) => ({
    command,
    args,
    pid: 1000,
    startedAt: iso,
    finishedAt: iso,
    closed: true,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    aborted: false,
    truncated: false,
    terminationRequested: false
  });
  const processes = [];
  const diffArgs = [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    schemaPath,
    "--exit-code",
    "--config",
    config
  ];
  const scriptArgs = [
    "migrate",
    "diff",
    "--from-empty",
    "--to-config-datasource",
    "--script",
    "--config",
    config
  ];
  const version = () => {
    processes.push(original(prisma, ["--version"], "Prisma 7.8.0\n"));
    processes.push(original("psql", ["--version"], "psql (PostgreSQL) 17.11\n"));
  };
  const schemaProcesses = (done) => {
    processes.push(original(prisma, diffArgs, done ? "" : "pending DDL", done ? 0 : 2));
    processes.push(original(prisma, scriptArgs, done ? "complete schema" : "empty schema"));
  };
  schemaProcesses(false);
  version();
  version(); // initial baseline and plan
  schemaProcesses(false);
  version();
  version(); // locked baseline and locked replan
  processes.push(
    original(
      prisma,
      ["migrate", "deploy", "--schema", schemaPath, "--config", config],
      "deployed\n"
    )
  );
  schemaProcesses(true);
  version(); // apply postcondition verification
  schemaProcesses(true);
  version(); // terminal verification
  const physical = () => ({
    databaseName: input.database.databaseName,
    databaseOid: input.database.databaseOid,
    marker: input.database.marker,
    engineId: input.postgres.engineId,
    postgresContainerId: input.postgres.containerId,
    systemIdentifier: input.postgres.systemIdentifier,
    databaseOwner: input.database.migrationRole,
    schemaOwner: input.database.migrationRole
  });
  return { ...values, plan, apply, verify: { ...verify, processOriginals: processes }, physical };
}

test("assesses each migration stage before advancing and retains reconstructed migration evidence", async () => {
  for (const options of [{}, { application: true }, { application: true, chain: "snapshot" }]) {
    const f = await fixture(options);
    let reads = 0;
    const assessment = createR3FinalMigrationAssessment({
      ...f,
      observeTarget: async () => {
        reads++;
        return f.physical();
      }
    });
    await assessment.assess({ stage: "plan", result: f.plan });
    assert.equal(reads, 1);
    await assessment.assess({ stage: "apply", result: f.apply });
    await assessment.assess({ stage: "verify", result: f.verify });
    const evidence = assessment.finish();
    assert.equal(reads, 3);
    assert.equal(evidence.expectedSchemaDigest, f.input.expectedSchemaDigest);
    assert.equal(evidence.migrationEvidenceDigest, digest(evidence.migrationEvidence));
    assert.equal(evidence.migrationEvidence.scope, "schema-migration");
  }
});

test("rejects a foreign physical target before apply and tampered terminal originals", async () => {
  const f = await fixture();
  const foreign = createR3FinalMigrationAssessment({
    ...f,
    observeTarget: async () => ({ ...f.physical(), databaseOid: "987654" })
  });
  await assert.rejects(() => foreign.assess({ stage: "plan", result: f.plan }), {
    code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID"
  });
  assert.throws(() => foreign.finish(), { code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID" });
  const assessment = createR3FinalMigrationAssessment({
    ...f,
    observeTarget: async () => f.physical()
  });
  await assessment.assess({ stage: "plan", result: f.plan });
  await assessment.assess({ stage: "apply", result: f.apply });
  const corrupt = structuredClone(f.verify);
  corrupt.originals[0].value[0].databaseOid = "987654";
  await assert.rejects(() => assessment.assess({ stage: "verify", result: corrupt }), {
    code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID"
  });
});

test("rejects a changed plan original before migration write", async () => {
  const f = await fixture();
  const assessment = createR3FinalMigrationAssessment({
    ...f,
    observeTarget: async () => f.physical()
  });
  const corrupt = structuredClone(f.plan);
  corrupt.originals[0].value[0].databaseOid = "987654";
  await assert.rejects(() => assessment.assess({ stage: "plan", result: corrupt }), {
    code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID"
  });
});

test("rejects a reported passed migration when retained process output disagrees", async () => {
  const f = await fixture();
  const assessment = createR3FinalMigrationAssessment({
    ...f,
    observeTarget: async () => f.physical()
  });
  await assessment.assess({ stage: "plan", result: f.plan });
  await assessment.assess({ stage: "apply", result: f.apply });
  const corrupt = structuredClone(f.verify);
  const script = corrupt.processOriginals.find((item) => item.args.includes("--script"));
  script.stdout = "foreign schema";
  await assert.rejects(() => assessment.assess({ stage: "verify", result: corrupt }), {
    code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID"
  });
  assert.throws(() => assessment.finish(), { code: "R3_FINAL_MIGRATION_ASSESSMENT_INVALID" });
});
