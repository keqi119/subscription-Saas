import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { classifyStage1CleanAcceptanceBaseline } from "./stage1-clean-acceptance-baseline-core.mjs";
import {
  applyStage1CleanAcceptanceBaseline,
  executeStage1CleanAcceptanceBaseline,
  validateStage1CleanAcceptanceTargetBaseline
} from "./stage1-clean-acceptance-baseline-executor.mjs";
import {
  STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES,
  loadStage1CleanAcceptanceSourceSnapshot,
  loadStage1CleanAcceptanceTargetSnapshot
} from "./stage1-clean-acceptance-baseline-snapshot.mjs";

const ADMIN_DATABASE_URL_ENV = "STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL";
const DATABASE_NAME = /^subscription_saas_s1_(source|target)_[a-f0-9]{32}$/;
const GENERATED_AT = "2026-08-30T12:00:00.000Z";
const GIT_SHA = "a".repeat(40);
const HASH_SALT = "b".repeat(64);
const IMAGE_REF = `registry.example/stage1-acceptance@sha256:${"c".repeat(64)}`;
const PASSWORD_HASH = "$2b$12$stage1.acceptance.fixture.hash";
const APPLY_ADVISORY_KEY = "stage1-clean-acceptance-baseline:apply";
const PRISMA_MIGRATION_SKIP_DOTENV = "STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV";
const repoRoot = resolve(import.meta.dirname, "..");
const apiRoot = resolve(repoRoot, "apps/api");
const requireFromApi = createRequire(resolve(apiRoot, "package.json"));
const { Pool } = requireFromApi("pg");
const adminDatabaseUrl = process.env[ADMIN_DATABASE_URL_ENV]?.trim() || null;
const integrationTest = adminDatabaseUrl ? test : test.skip;

const IDS = Object.freeze({
  admin: uuid(1),
  role: uuid(2),
  permission: uuid(3),
  menu: uuid(4),
  userRole: uuid(5),
  rolePermission: uuid(6),
  roleMenu: uuid(7),
  customer: uuid(8),
  customerAccount: uuid(9),
  customerIdentity: uuid(10),
  customerProfile: uuid(11),
  customerESign: uuid(12),
  depositRule: uuid(13),
  product: uuid(14),
  productVersion: uuid(15),
  model: uuid(16),
  vehiclePackage: uuid(17),
  vehiclePackageMember: uuid(18),
  mileagePackage: uuid(19),
  energyPackage: uuid(20),
  benefitPackage: uuid(21),
  subscriptionPlan: uuid(22),
  priceRule: uuid(23),
  owner: uuid(24),
  vehicle: uuid(25),
  listingProfile: uuid(26),
  listingMedia: uuid(27),
  listingPlan: uuid(28),
  documentBatch: uuid(29),
  insurancePolicy: uuid(30),
  vehicleDocument: uuid(31),
  insuranceCoverage: uuid(32),
  sourceBinding: uuid(33),
  salePriceHistory: uuid(34),
  ownershipPeriod: uuid(35),
  costProfile: uuid(36),
  costOriginal: uuid(37),
  costReversal: uuid(38)
});

const NOTIFICATION_CODES = Object.freeze([
  "APPLICATION_SUBMITTED_IN_APP",
  "APPLICATION_SUBMITTED_WECHAT",
  "AUTO_DEBIT_FAILURE_IN_APP",
  "AUTO_DEBIT_FAILURE_SMS",
  "AUTO_DEBIT_FAILURE_WECHAT",
  "CONTRACT_PENDING_IN_APP",
  "CONTRACT_PENDING_WECHAT",
  "FINAL_PLAN_READY_IN_APP",
  "FINAL_PLAN_READY_WECHAT",
  "HANDOVER_ESIGN_PENDING_IN_APP",
  "HANDOVER_ESIGN_PENDING_WECHAT",
  "MILEAGE_REVIEW_DUE_IN_APP",
  "MILEAGE_REVIEW_DUE_WECHAT",
  "PAYMENT_PENDING_IN_APP",
  "PAYMENT_PENDING_WECHAT",
  "SERVICE_CASE_UPDATE_IN_APP",
  "SERVICE_CASE_UPDATE_WECHAT"
]);

test("PostgreSQL integration harness has no generic database URL fallback", () => {
  assert.equal(ADMIN_DATABASE_URL_ENV, "STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL");
  if (!adminDatabaseUrl) assert.equal(integrationTest, test.skip);
});

test("disposable database names must match the exact source/target test prefixes", () => {
  const generatedNames = [];
  for (const kind of ["source", "target"]) {
    const name = `subscription_saas_s1_${kind}_${"a".repeat(32)}`;
    generatedNames.push(name);
    assert.doesNotThrow(() => assertDisposableDatabaseName(name));
    assert.ok(Buffer.byteLength(name, "utf8") <= 63);
  }
  assert.deepEqual(
    generatedNames.map((name) => Buffer.byteLength(name, "utf8")),
    [60, 60]
  );
  for (const unsafe of [
    "postgres",
    "subscription_saas_staging",
    "subscription_saas_s1_source_abc",
    `subscription_saas_s1_target_${"a".repeat(32)}_extra`,
    `subscription_saas_test_stage1_source_${"a".repeat(32)}`
  ]) {
    assert.throws(() => assertDisposableDatabaseName(unsafe), /UNSAFE_INTEGRATION_DATABASE_NAME/);
  }
});

test("cleanup ownership is registered only after CREATE DATABASE succeeds", async () => {
  const name = `subscription_saas_s1_source_${"a".repeat(32)}`;
  for (const scenario of ["collision", "create-failure"]) {
    const admin = createAdminFake({
      collision: scenario === "collision",
      createFailure: scenario === "create-failure"
    });
    const registry = createDisposableDatabaseRegistry(admin.client);
    await assert.rejects(registry.create(name));
    await registry.dropCreated();
    assert.equal(admin.dropCalls.length, 0);
  }

  const admin = createAdminFake();
  const registry = createDisposableDatabaseRegistry(admin.client);
  await registry.create(name);
  await registry.dropCreated();
  assert.deepEqual(admin.createCalls, [
    `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`
  ]);
  assert.deepEqual(admin.databaseNameParameters, [name, name]);
  assert.deepEqual(admin.dropCalls, [`DROP DATABASE "${name}" WITH (FORCE)`]);
});

test("template0 databases must have no public tables before migrations", async () => {
  const queries = [];
  let ended = 0;
  await assertApplicationEmptyBeforeMigrations("postgresql://derived", {
    createPool: () => ({
      end: async () => {
        ended += 1;
      },
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ count: 0 }] };
      }
    })
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /information_schema\.tables/);
  assert.match(queries[0], /table_schema = 'public'/);
  assert.equal(ended, 1);

  await assert.rejects(
    assertApplicationEmptyBeforeMigrations("postgresql://derived", {
      createPool: () => ({
        end: async () => {},
        query: async () => ({ rows: [{ count: 1 }] })
      })
    }),
    (error) => error?.message === "INTEGRATION_DATABASE_NOT_EMPTY_BEFORE_MIGRATIONS"
  );
});

test("migration child receives only the derived database URL and captured output", () => {
  const parentEnv = {
    PATH: "tool-path",
    SystemRoot: "system-root",
    TEMP: "temp-root",
    HTTP_PROXY: "proxy-url",
    DATABASE_URL: "generic-secret",
    STAGE1_ACCEPTANCE_INTEGRATION_ADMIN_DATABASE_URL: "admin-secret",
    STAGE1_ACCEPTANCE_SOURCE_DATABASE_URL: "source-secret",
    STAGE1_ACCEPTANCE_TARGET_DATABASE_URL: "target-secret",
    STAGING_DATABASE_URL: "staging-secret",
    POSTGRES_URL: "postgres-secret",
    DIRECT_URL: "direct-secret",
    PGHOST: "pg-host-secret",
    PGPASSWORD: "pg-password-secret",
    pgpassfile: "pg-passfile-secret",
    PgOptions: "pg-options-secret",
    PGAPPNAME: "pg-appname-secret",
    PGCONNECT_TIMEOUT: "pg-timeout-secret",
    PGCLIENTENCODING: "pg-encoding-secret",
    PGCHANNELBINDING: "pg-channel-secret",
    PGTARGETSESSIONATTRS: "pg-target-secret",
    PGSSLKEY: "pg-key-secret",
    PGSSLCERT: "pg-cert-secret",
    PGSSLROOTCERT: "pg-root-cert-secret"
  };
  const derivedUrl = "postgresql://temporary-derived";
  const portableWindowsNode = "C:\\portable\\nodejs\\node.exe";
  let childOptions;
  let childExecutable;
  let childArgs;
  runMigrationDeploy(derivedUrl, {
    nodeExecutable: portableWindowsNode,
    parentEnv,
    platform: "win32",
    spawn: (executable, args, options) => {
      childExecutable = executable;
      childArgs = args;
      childOptions = options;
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(childExecutable, portableWindowsNode);
  assert.equal(childArgs[0], "C:\\portable\\nodejs\\node_modules\\corepack\\dist\\pnpm.js");
  assert.equal(win32.isAbsolute(childArgs[0]), true);
  assert.equal(childArgs.includes("pnpm.cmd"), false);
  assert.equal(childOptions.env.DATABASE_URL, derivedUrl);
  assert.equal(childOptions.env.PATH, "tool-path");
  assert.equal(childOptions.env.SystemRoot, "system-root");
  assert.equal(childOptions.env.HTTP_PROXY, "proxy-url");
  assert.equal(childOptions.stdio, "pipe");
  for (const secret of [
    "generic-secret",
    "admin-secret",
    "source-secret",
    "target-secret",
    "staging-secret",
    "postgres-secret",
    "direct-secret",
    "pg-host-secret",
    "pg-password-secret",
    "pg-passfile-secret",
    "pg-options-secret",
    "pg-appname-secret",
    "pg-timeout-secret",
    "pg-encoding-secret",
    "pg-channel-secret",
    "pg-target-secret",
    "pg-key-secret",
    "pg-cert-secret",
    "pg-root-cert-secret"
  ]) {
    assert.equal(Object.values(childOptions.env).includes(secret), false);
  }
  assert.equal(
    Object.keys(childOptions.env).some((key) => /^pg/i.test(key)),
    false
  );
  assert.deepEqual(
    Object.keys(childOptions.env).filter((key) =>
      /(?:database|postgres|direct|(?:^|_)db(?:_|$)).*url|url.*(?:database|postgres|direct|(?:^|_)db(?:_|$))/i.test(
        key
      )
    ),
    ["DATABASE_URL"]
  );
  assert.equal(childOptions.env.STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV, "1");

  let linuxLaunch;
  runMigrationDeploy(derivedUrl, {
    parentEnv,
    platform: "linux",
    spawn: (executable, args) => {
      linuxLaunch = { args, executable };
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(linuxLaunch.executable, "pnpm");
  assert.equal(linuxLaunch.args[0], "--filter");

  assert.throws(
    () =>
      runMigrationDeploy(derivedUrl, {
        parentEnv,
        spawn: () => ({ status: 1, stdout: "admin-secret", stderr: "source-secret" })
      }),
    (error) => error?.message === "INTEGRATION_MIGRATION_DEPLOY_FAILED"
  );
});

test("Prisma migration dotenv policy blocks repository and cwd rehydration", () => {
  const { PRISMA_MIGRATION_SKIP_DOTENV, loadPrismaEnvironment } =
    requireFromApi("./prisma-env-policy.ts");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "stage1-prisma-env-"));
  const cwd = resolve(temporaryRoot, "cwd");
  const repositoryEnvPath = resolve(temporaryRoot, "repository.env");
  mkdirSync(cwd);
  writeFileSync(repositoryEnvPath, "DIRECT_URL=repository-direct-secret\n", "utf8");
  writeFileSync(resolve(cwd, ".env"), "PGPASSFILE=cwd-passfile-secret\n", "utf8");
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    const normalEnvironment = {};
    loadPrismaEnvironment({ environment: normalEnvironment, repositoryEnvPath });
    assert.equal(normalEnvironment.DIRECT_URL, "repository-direct-secret");
    assert.equal(normalEnvironment.PGPASSFILE, "cwd-passfile-secret");

    const protectedEnvironment = {
      DATABASE_URL: "postgresql://temporary-derived",
      [PRISMA_MIGRATION_SKIP_DOTENV]: "1"
    };
    loadPrismaEnvironment({ environment: protectedEnvironment, repositoryEnvPath });
    assert.equal(protectedEnvironment.DATABASE_URL, "postgresql://temporary-derived");
    assert.equal(protectedEnvironment.DIRECT_URL, undefined);
    assert.equal(protectedEnvironment.PGPASSFILE, undefined);
  } finally {
    process.chdir(previousCwd);
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("apply confirmation is restored once after success and failure", async () => {
  const previous = process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
  process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY = "before-test";
  try {
    await withApplyConfirmation(async () => {
      assert.equal(process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY, "1");
    });
    assert.equal(process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY, "before-test");
    await assert.rejects(
      withApplyConfirmation(async () => {
        assert.equal(process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY, "1");
        throw new Error("INJECTED_APPLY_FAILURE");
      }),
      /INJECTED_APPLY_FAILURE/
    );
    assert.equal(process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY, "before-test");
  } finally {
    restoreApplyConfirmation(previous);
  }
});

test("advisory barrier waits for both named apply sessions with a bounded poll", async () => {
  let polls = 0;
  const names = ["stage1_acceptance_apply_a_test", "stage1_acceptance_apply_b_test"];
  await waitForAdvisoryWaiters(
    {
      async query(_sql, parameters) {
        polls += 1;
        assert.deepEqual(parameters, [names]);
        return {
          rows:
            polls === 1
              ? [{ applicationName: names[0], waitEventType: "Lock", waitEvent: "advisory" }]
              : names.map((applicationName) => ({
                  applicationName,
                  waitEvent: "advisory",
                  waitEventType: "Lock"
                }))
        };
      }
    },
    names,
    { delay: async () => {}, maxPolls: 2 }
  );
  assert.equal(polls, 2);

  await assert.rejects(
    waitForAdvisoryWaiters({ query: async () => ({ rows: [] }) }, names, {
      delay: async () => {},
      maxPolls: 2
    }),
    (error) => error?.message === "INTEGRATION_ADVISORY_WAIT_TIMEOUT"
  );
});

integrationTest(
  "real PostgreSQL proves migrations, rollback, stale guards, locking, replay, and validation",
  { timeout: 240_000 },
  async (t) => {
    return withApplyConfirmation(async () => {
      try {
        const harness = await createPostgresHarness(adminDatabaseUrl);
        t.after(() => harness.close());
        await harness.migrateBoth();
        await harness.assertCanonicalMigrations();
        await harness.seedSource();

        const beforeDryRun = await harness.businessCounts();
        assertAllWhitelistDelegatesPresent(beforeDryRun.source);
        assertEmptyDatabaseCounts(beforeDryRun.target);
        const dryRun = await harness.execute("dry-run");
        assert.equal(dryRun.safe, true);
        assert.equal(dryRun.manifest.safeToApply, true);
        assert.match(dryRun.manifestSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(await harness.businessCounts(), beforeDryRun);

        await harness.mutateAndRestoreSourceFact(async () => {
          await assert.rejects(
            harness.execute("apply", dryRun),
            (error) => error?.message === "MANIFEST_STALE"
          );
          assertEmptyDatabaseCounts((await harness.businessCounts()).target);
        });
        await harness.assertForeignKeyRollback();
        assertEmptyDatabaseCounts((await harness.businessCounts()).target);

        const concurrent = await harness.concurrentApply(dryRun);
        const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
        const rejected = concurrent.filter((result) => result.status === "rejected");
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason?.message, "MANIFEST_STALE");
        assert.equal(fulfilled[0].value.auditCreated, 1);

        await harness.assertCopiedBaseline(dryRun);
        const beforeReplay = await harness.businessCounts();
        const replay = await harness.execute("replay", dryRun);
        assert.equal(replay.inserted, 0);
        assert.equal(replay.auditCreated, 0);
        assert.deepEqual(await harness.businessCounts(), beforeReplay);
        await harness.validateTarget(dryRun);

        await harness.withForbiddenRow(async () => {
          await assert.rejects(
            harness.execute("replay", dryRun),
            (error) => error?.message === "MANIFEST_STALE"
          );
          await assert.rejects(
            harness.validateTarget(dryRun),
            (error) => error?.message === "MANIFEST_STALE"
          );
        });
        await harness.validateTarget(dryRun);
      } catch (error) {
        throw new Error(safeIntegrationError(error));
      }
    });
  }
);

async function createPostgresHarness(connectionString) {
  const adminPool = new Pool({ connectionString, max: 1 });
  let adminClient;
  try {
    adminClient = await adminPool.connect();
  } catch {
    await adminPool.end();
    throw new Error("INTEGRATION_ADMIN_CONNECTION_FAILED");
  }
  const databaseRegistry = createDisposableDatabaseRegistry(adminClient);
  let closed = false;
  const suffix = randomUUID().replaceAll("-", "");
  const sourceName = `subscription_saas_s1_source_${suffix}`;
  const targetName = `subscription_saas_s1_target_${suffix}`;
  const sourceUrl = databaseUrlFor(connectionString, sourceName);
  const targetUrl = databaseUrlFor(connectionString, targetName);
  const applyApplicationNames = [
    `stage1_acceptance_apply_a_${suffix.slice(0, 8)}`,
    `stage1_acceptance_apply_b_${suffix.slice(0, 8)}`
  ];
  const clients = [];
  try {
    await databaseRegistry.create(sourceName);
    await databaseRegistry.create(targetName);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    assertCanonicalMigrations,
    assertCopiedBaseline,
    assertForeignKeyRollback,
    businessCounts,
    close: cleanup,
    concurrentApply,
    execute,
    migrateBoth: async () => {
      await assertApplicationEmptyBeforeMigrations(sourceUrl);
      await assertApplicationEmptyBeforeMigrations(targetUrl);
      runMigrationDeploy(sourceUrl);
      runMigrationDeploy(targetUrl);
      clients.push(
        await createPrismaClient(sourceUrl),
        await createPrismaClient(withApplicationName(targetUrl, applyApplicationNames[0])),
        await createPrismaClient(sourceUrl),
        await createPrismaClient(withApplicationName(targetUrl, applyApplicationNames[1]))
      );
    },
    mutateAndRestoreSourceFact,
    seedSource,
    validateTarget,
    withForbiddenRow
  };

  async function cleanup() {
    if (closed) return;
    closed = true;
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    let cleanupError;
    try {
      await databaseRegistry.dropCreated();
    } catch (error) {
      cleanupError = error;
    }
    adminClient.release();
    await adminPool.end();
    if (cleanupError) throw new Error("INTEGRATION_DATABASE_CLEANUP_FAILED");
  }

  async function assertCanonicalMigrations() {
    const expected = canonicalMigrationCatalog();
    assert.equal(expected.length, 124);
    for (const prisma of [clients[0], clients[1]]) {
      const actual = await prisma.$queryRawUnsafe(`
        SELECT migration_name AS "migrationName", checksum, finished_at AS "finishedAt",
               rolled_back_at AS "rolledBackAt", applied_steps_count AS "appliedStepsCount"
        FROM "_prisma_migrations" ORDER BY migration_name ASC
      `);
      assert.equal(actual.length, expected.length);
      assert.deepEqual(
        actual.map(({ migrationName, checksum }) => ({ migrationName, checksum })),
        expected
      );
      assert.ok(actual.every((row) => row.finishedAt instanceof Date));
      assert.ok(actual.every((row) => row.rolledBackAt === null));
      assert.ok(actual.every((row) => row.appliedStepsCount === 1));
    }
  }

  async function seedSource() {
    const prisma = clients[0];
    const effectiveFrom = new Date("2026-01-01T00:00:00.000Z");
    const approvedAt = new Date("2026-08-01T00:00:00.000Z");
    const occurredOn = new Date("2026-08-15T00:00:00.000Z");
    const confirmedAt = new Date("2026-08-15T08:00:00.000Z");
    const responsibilitySnapshot = { authority: "fixture", responsiblePartyType: "CUSTOMER" };

    await prisma.permission.create({
      data: {
        id: IDS.permission,
        code: "acceptance:all",
        name: "Acceptance",
        module: "acceptance",
        action: "all"
      }
    });
    await prisma.menu.create({
      data: { id: IDS.menu, code: "acceptance", name: "Acceptance", path: "/acceptance" }
    });
    await prisma.role.create({ data: { id: IDS.role, code: "ADMIN", name: "Administrator" } });
    await prisma.user.create({
      data: {
        id: IDS.admin,
        username: "keqi_119",
        name: "Acceptance Admin",
        passwordHash: PASSWORD_HASH
      }
    });
    await prisma.rolePermission.create({
      data: { id: IDS.rolePermission, roleId: IDS.role, permissionId: IDS.permission }
    });
    await prisma.roleMenu.create({
      data: { id: IDS.roleMenu, roleId: IDS.role, menuId: IDS.menu }
    });
    await prisma.userRole.create({
      data: { id: IDS.userRole, userId: IDS.admin, roleId: IDS.role }
    });

    await prisma.customer.create({
      data: {
        id: IDS.customer,
        customerNo: "ACCEPTANCE-CUSTOMER",
        name: "Acceptance Customer",
        mobile: "18616570212",
        status: "ACTIVE",
        ownerUserId: IDS.admin
      }
    });
    await prisma.customerAccount.create({
      data: {
        id: IDS.customerAccount,
        customerId: IDS.customer,
        phone: "18616570212",
        accountStatus: "ACTIVE"
      }
    });
    await prisma.customerIdentity.create({
      data: {
        id: IDS.customerIdentity,
        customerId: IDS.customer,
        realnameVerified: true,
        verifiedAt: approvedAt
      }
    });
    await prisma.customerProfile.create({
      data: { id: IDS.customerProfile, customerId: IDS.customer, monthlyIncomeAmount: 2000000n }
    });
    await prisma.customerESignProviderAccount.create({
      data: {
        id: IDS.customerESign,
        customerId: IDS.customer,
        provider: "ESIGN",
        providerOpenId: "acceptance-provider-open-id",
        registrationStatus: "REGISTERED",
        realNameStatus: "VERIFIED",
        verifiedAt: approvedAt,
        certBindingStatus: "BOUND",
        certBoundAt: approvedAt
      }
    });

    await prisma.depositRule.create({
      data: {
        id: IDS.depositRule,
        grade: "A",
        depositAmount: 500000n,
        defaultRate: "0.100000",
        effectiveFrom
      }
    });
    await prisma.product.create({
      data: {
        id: IDS.product,
        productNo: "ACCEPTANCE-PRODUCT",
        name: "Acceptance Product",
        productType: "SUBSCRIPTION",
        status: "ACTIVE",
        description: "approved"
      }
    });
    await prisma.productVersion.create({
      data: {
        id: IDS.productVersion,
        productId: IDS.product,
        versionNo: "1",
        effectiveFrom,
        status: "ACTIVE",
        approvedBy: IDS.admin,
        approvedAt
      }
    });
    await prisma.vehicleModelDefinition.create({
      data: {
        id: IDS.model,
        modelCode: "ACCEPTANCE-MODEL",
        brand: "Acceptance",
        modelName: "Model",
        displayName: "Acceptance Model",
        enabled: true,
        portalVisible: true
      }
    });
    await prisma.vehiclePackage.create({
      data: {
        id: IDS.vehiclePackage,
        packageNo: "ACCEPTANCE-VEHICLE",
        packageName: "Acceptance Vehicle",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        modelDefinitionId: IDS.model,
        minPeriodMonths: 12,
        maxPeriodMonths: 36
      }
    });
    await prisma.vehiclePackageModelMember.create({
      data: {
        id: IDS.vehiclePackageMember,
        vehiclePackageId: IDS.vehiclePackage,
        modelDefinitionId: IDS.model
      }
    });
    await prisma.mileagePackage.create({
      data: {
        id: IDS.mileagePackage,
        packageNo: "ACCEPTANCE-MILEAGE",
        packageName: "Acceptance Mileage",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        monthlyMileageKm: 1500,
        overMileageFeeAmount: 100n
      }
    });
    await prisma.energyPackage.create({
      data: {
        id: IDS.energyPackage,
        packageNo: "ACCEPTANCE-ENERGY",
        packageName: "Acceptance Energy",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        monthlyEnergyKwh: 500
      }
    });
    await prisma.benefitPackage.create({
      data: {
        id: IDS.benefitPackage,
        packageNo: "ACCEPTANCE-BENEFIT",
        packageName: "Acceptance Benefit",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        benefitType: "WASH_CAR",
        benefitCount: 1
      }
    });
    await prisma.subscriptionPlan.create({
      data: {
        id: IDS.subscriptionPlan,
        planNo: "ACCEPTANCE-PLAN",
        planName: "Acceptance Plan",
        productId: IDS.product,
        productVersionId: IDS.productVersion,
        vehiclePackageId: IDS.vehiclePackage,
        mileagePackageId: IDS.mileagePackage,
        energyPackageId: IDS.energyPackage,
        benefitPackageId: IDS.benefitPackage,
        monthlyFeeMode: "FIXED_AMOUNT",
        baseMonthlyFeeAmount: 350000n,
        minPeriodMonths: 12,
        maxPeriodMonths: 36,
        status: "ACTIVE",
        effectiveFrom
      }
    });
    await prisma.productPriceRule.create({
      data: {
        id: IDS.priceRule,
        productVersionId: IDS.productVersion,
        modelDefinitionId: IDS.model,
        minPeriodMonths: 12,
        maxPeriodMonths: 36,
        baseMileageKm: 1500,
        overMileageFeeAmount: 100n
      }
    });

    const templateTypes = ["DELIVERY_HANDOVER", "SUBSCRIPTION_EXTENSION", "SUBSCRIPTION_STANDARD"];
    const fileRows = templateTypes.map((templateType, index) => ({
      id: uuid(100 + index),
      bucket: "acceptance",
      objectKey: `templates/${templateType}.pdf`,
      originalName: `${templateType}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: BigInt(1000 + index),
      contentSha256: createHash("sha256").update(templateType).digest("hex"),
      uploadedBy: IDS.admin
    }));
    await prisma.fileObject.createMany({ data: fileRows });
    await prisma.contractVersion.createMany({
      data: templateTypes.map((templateType, index) => ({
        id: uuid(110 + index),
        templateName: `Acceptance ${templateType}`,
        versionNo: "1",
        businessType: "SUBSCRIPTION",
        templateType,
        contentTemplate: `acceptance-${templateType}`,
        fileId: fileRows[index].id,
        effectiveFrom,
        status: "ACTIVE",
        approvedBy: IDS.admin,
        approvedAt
      }))
    });
    await prisma.notificationTemplate.createMany({
      data: NOTIFICATION_CODES.map((templateCode, index) => ({
        id: uuid(130 + index),
        templateCode,
        channel: "IN_APP",
        templateType: "SYSTEM",
        templateStatus: "ACTIVE",
        title: `Acceptance ${index}`,
        content: "acceptance"
      }))
    });

    await prisma.assetOwner.create({
      data: {
        id: IDS.owner,
        ownerNo: "ACCEPTANCE-OWNER",
        name: "Acceptance Owner",
        ownerType: "PLATFORM",
        status: "ACTIVE",
        createdBy: IDS.admin,
        updatedBy: IDS.admin
      }
    });
    await prisma.vehicle.create({
      data: {
        id: IDS.vehicle,
        vehicleNo: "ACCEPTANCE-VEHICLE-001",
        vin: "ACCEPTANCEVIN0000001",
        plateNo: "沪A00001",
        brand: "Acceptance",
        modelDefinitionId: IDS.model,
        purchasePriceAmount: 20000000n,
        currentSalePriceAmount: 18000000n,
        currentSalePriceInitializedAt: approvedAt,
        currentSalePriceReviewedAt: approvedAt,
        salePriceStatus: "EFFECTIVE",
        status: "AVAILABLE"
      }
    });
    await prisma.vehicleListingProfile.create({
      data: {
        id: IDS.listingProfile,
        vehicleId: IDS.vehicle,
        listingStatus: "PUBLISHED",
        portalVisible: true,
        displayName: "Acceptance Vehicle",
        publishedAt: approvedAt
      }
    });
    await prisma.vehicleListingMedia.create({
      data: {
        id: IDS.listingMedia,
        vehicleId: IDS.vehicle,
        listingProfileId: IDS.listingProfile,
        fileName: "cover.jpg",
        mediaCategory: "COVER",
        isCover: true
      }
    });
    await prisma.vehicleListingPlan.create({
      data: {
        id: IDS.listingPlan,
        vehicleId: IDS.vehicle,
        listingProfileId: IDS.listingProfile,
        subscriptionPlanId: IDS.subscriptionPlan,
        visible: true,
        recommended: true
      }
    });
    await prisma.vehicleDocumentBatch.create({
      data: {
        id: IDS.documentBatch,
        vehicleId: IDS.vehicle,
        documentType: "VEHICLE_LICENSE",
        versionNo: 1,
        uploadedBy: IDS.admin
      }
    });
    await prisma.vehicleInsurancePolicy.create({
      data: {
        id: IDS.insurancePolicy,
        policyNo: "ACCEPTANCE-POLICY",
        vehicleId: IDS.vehicle,
        policyType: "COMMERCIAL",
        policyStatus: "ACTIVE",
        effectiveFrom,
        effectiveTo: new Date("2027-12-31T00:00:00.000Z")
      }
    });
    await prisma.vehicleDocument.create({
      data: {
        id: IDS.vehicleDocument,
        vehicleId: IDS.vehicle,
        batchId: IDS.documentBatch,
        policyId: IDS.insurancePolicy,
        documentType: "VEHICLE_LICENSE",
        documentStatus: "ACTIVE",
        fileName: "license.pdf",
        mimeType: "application/pdf",
        bucket: "acceptance",
        objectKey: "vehicle/license.pdf",
        customerVisible: true
      }
    });
    await prisma.vehicleInsuranceCoverage.create({
      data: {
        id: IDS.insuranceCoverage,
        policyId: IDS.insurancePolicy,
        coverageType: "VEHICLE_DAMAGE",
        insuredAmount: 18000000n
      }
    });
    await prisma.vehicleListingSourceBinding.create({
      data: {
        id: IDS.sourceBinding,
        vehicleId: IDS.vehicle,
        section: "CONFIGURATION_SHEET",
        documentId: IDS.vehicleDocument
      }
    });
    await prisma.vehicleSalePriceHistory.create({
      data: {
        id: IDS.salePriceHistory,
        vehicleId: IDS.vehicle,
        beforeSalePriceAmount: null,
        afterSalePriceAmount: 18000000n,
        reviewType: "INITIAL_POOL",
        effectiveFrom,
        reason: "acceptance"
      }
    });
    await prisma.vehicleOwnershipPeriod.create({
      data: {
        id: IDS.ownershipPeriod,
        vehicleId: IDS.vehicle,
        assetOwnerId: IDS.owner,
        startedAt: effectiveFrom,
        startReason: "INITIAL_ACQUISITION",
        startSourceType: "ACCEPTANCE_FIXTURE",
        startSourceId: uuid(200),
        startSourceKey: "initial",
        startSnapshot: { authority: "fixture" },
        startConfirmedBy: IDS.admin,
        startConfirmedAt: approvedAt,
        createdBy: IDS.admin
      }
    });
    await prisma.vehicleAssetCostProfile.create({
      data: {
        id: IDS.costProfile,
        vehicleId: IDS.vehicle,
        profileStatus: "ACTIVE",
        depreciationMethod: "STRAIGHT_LINE",
        depreciationStartDate: effectiveFrom,
        usefulLifeMonths: 60,
        residualValueAmount: 5000000n
      }
    });
    const sharedCost = {
      vehicleId: IDS.vehicle,
      orderId: null,
      contractId: null,
      customerId: IDS.customer,
      assetOwnerId: IDS.owner,
      workOrderId: null,
      evidenceId: null,
      responsibilitySnapshot,
      actionType: "ACTUAL_COST",
      costCategory: "OTHER",
      responsiblePartyType: "CUSTOMER",
      responsiblePartyId: IDS.customer,
      occurredOn,
      accountingPeriod: "2026-08",
      confirmedAt,
      confirmedBy: IDS.admin,
      sourceType: "ACCEPTANCE_FIXTURE"
    };
    await prisma.vehicleCostLedgerEntry.create({
      data: {
        ...sharedCost,
        id: IDS.costOriginal,
        entryKind: "ORIGINAL",
        amountCents: 1000n,
        reversalOfEntryId: null,
        sourceId: uuid(201),
        sourceKey: "original"
      }
    });
    await prisma.vehicleCostLedgerEntry.create({
      data: {
        ...sharedCost,
        id: IDS.costReversal,
        entryKind: "REVERSAL",
        amountCents: -1000n,
        reversalOfEntryId: IDS.costOriginal,
        sourceId: uuid(202),
        sourceKey: "reversal"
      }
    });
  }

  async function businessCounts() {
    const [source, target] = await Promise.all([
      targetMetadata(clients[0]),
      targetMetadata(clients[1])
    ]);
    return {
      source: { forbidden: source.forbiddenCounts, whitelist: source.tableCounts },
      target: { forbidden: target.forbiddenCounts, whitelist: target.tableCounts }
    };
  }

  async function execute(mode, approved, pairIndex = 0) {
    return executeStage1CleanAcceptanceBaseline({
      approvedManifest: approved?.manifest,
      approvedManifestSha256: approved?.manifestSha256,
      generatedAt: GENERATED_AT,
      gitSha: GIT_SHA,
      hashSalt: HASH_SALT,
      imageRef: IMAGE_REF,
      mode,
      selection: selection(),
      sourcePrisma: clients[pairIndex === 0 ? 0 : 2],
      targetPrisma: clients[pairIndex === 0 ? 1 : 3]
    });
  }

  async function concurrentApply(approved) {
    const blockerPool = new Pool({
      application_name: `stage1_acceptance_blocker_${suffix.slice(0, 8)}`,
      connectionString: targetUrl,
      max: 1
    });
    const blocker = await blockerPool.connect();
    let locked = false;
    let pending = [];
    let barrierError;
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtext($1))", [APPLY_ADVISORY_KEY]);
      locked = true;
      pending = [execute("apply", approved, 0), execute("apply", approved, 1)];
      try {
        await waitForAdvisoryWaiters(blocker, applyApplicationNames);
      } catch (error) {
        barrierError = error;
      } finally {
        await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [APPLY_ADVISORY_KEY]);
        locked = false;
      }
      const settled = await Promise.allSettled(pending);
      if (barrierError) throw barrierError;
      return settled;
    } finally {
      if (locked) {
        await blocker.query("SELECT pg_advisory_unlock(hashtext($1))", [APPLY_ADVISORY_KEY]);
      }
      if (pending.length > 0) await Promise.allSettled(pending);
      blocker.release();
      await blockerPool.end();
    }
  }

  async function mutateAndRestoreSourceFact(work) {
    const original = await clients[0].product.findUniqueOrThrow({
      select: { description: true, updatedAt: true },
      where: { id: IDS.product }
    });
    await clients[0].product.update({
      data: { description: "temporarily changed", updatedAt: new Date("2026-08-30T11:59:00.000Z") },
      where: { id: IDS.product }
    });
    try {
      await work();
    } finally {
      await clients[0].product.update({ data: original, where: { id: IDS.product } });
    }
    const restored = await clients[0].product.findUniqueOrThrow({
      select: { description: true, updatedAt: true },
      where: { id: IDS.product }
    });
    assert.deepEqual(restored, original);
  }

  async function assertForeignKeyRollback() {
    const sourceSnapshot = await clients[0].$transaction(
      async (tx) => {
        await tx.$queryRaw`SET TRANSACTION READ ONLY`;
        return loadStage1CleanAcceptanceSourceSnapshot(tx, selection(), {
          asOf: new Date(GENERATED_AT)
        });
      },
      { isolationLevel: "RepeatableRead" }
    );
    const targetSnapshot = await targetMetadata(clients[1]);
    const classification = classifyStage1CleanAcceptanceBaseline(
      { ...sourceSnapshot, target: targetSnapshot },
      selection()
    );
    assert.equal(classification.safeToApply, true);
    classification.rows.vehicle.vehicleListingSourceBindings[0].documentId = uuid(999);
    await assert.rejects(
      clients[1].$transaction(
        (tx) =>
          applyStage1CleanAcceptanceBaseline(tx, classification, {
            gitSha: GIT_SHA,
            imageRef: IMAGE_REF,
            manifestSha256: "d".repeat(64)
          }),
        { isolationLevel: "Serializable" }
      ),
      (error) => postgresCode(error) === "23503"
    );
    assertEmptyDatabaseCounts((await businessCounts()).target);
  }

  async function assertCopiedBaseline(approved) {
    const counts = await businessCounts();
    assert.deepEqual(counts.target.whitelist, counts.source.whitelist);
    assert.equal(counts.target.whitelist.fileObject, 3);
    assert.equal(counts.target.whitelist.contractVersion, 3);
    assert.equal(counts.target.whitelist.notificationTemplate, NOTIFICATION_CODES.length);
    assert.equal(counts.target.whitelist.vehicleCostLedgerEntry, 2);
    assert.equal(counts.target.forbidden.auditLog, 1);
    assert.ok(
      Object.entries(counts.target.forbidden).every(([key, value]) =>
        key === "auditLog" ? value === 1 : value === 0
      )
    );

    const [sourceUser, targetUser] = await Promise.all([
      clients[0].user.findUniqueOrThrow({ where: { id: IDS.admin } }),
      clients[1].user.findUniqueOrThrow({ where: { id: IDS.admin } })
    ]);
    assert.equal(targetUser.id, sourceUser.id);
    assert.equal(digest(targetUser.passwordHash), digest(sourceUser.passwordHash));
    assert.equal(targetUser.passwordHash.length, PASSWORD_HASH.length);

    const targetRows = await loadStage1CleanAcceptanceSourceSnapshot(clients[1], selection(), {
      asOf: new Date(GENERATED_AT)
    });
    assert.equal(typeof targetRows.customer.customerProfiles[0].monthlyIncomeAmount, "bigint");
    assert.ok(targetRows.vehicle.vehicles[0].createdAt instanceof Date);
    assert.equal(targetRows.vehicle.vehicleCostLedgerEntries.length, 2);
    assert.equal(
      targetRows.vehicle.vehicleCostLedgerEntries[1].reversalOfEntryId,
      IDS.costOriginal
    );
    assert.equal(targetRows.vehicle.vehicleDocuments[0].policyId, IDS.insurancePolicy);
    assert.equal(
      targetRows.vehicle.vehicleListingSourceBindings[0].documentId,
      IDS.vehicleDocument
    );

    const sqlNull = await clients[1].$queryRawUnsafe(
      `
      SELECT
        (SELECT provider_snapshot IS NULL FROM customer_esign_provider_account WHERE id = $1::uuid) AS "eSign",
        (SELECT snapshot IS NULL FROM vehicle_model_definition WHERE id = $2::uuid) AS "model",
        (SELECT provider_config IS NULL AND variables IS NULL FROM notification_template LIMIT 1) AS "notification",
        (SELECT onboarding_snapshot IS NULL FROM asset_owner WHERE id = $3::uuid) AS "owner",
        (SELECT selling_points IS NULL AND customer_tags IS NULL AND service_highlights IS NULL
                AND faq_snapshot IS NULL FROM vehicle_listing_profile WHERE id = $6::uuid) AS "listing",
        (SELECT snapshot IS NULL FROM vehicle_insurance_policy WHERE id = $7::uuid) AS "policy",
        (SELECT end_snapshot IS NULL AND start_snapshot IS NOT NULL
           FROM vehicle_ownership_period WHERE id = $8::uuid) AS "ownership",
        (SELECT snapshot IS NULL FROM vehicle_asset_cost_profile WHERE id = $4::uuid) AS "costProfile",
        (SELECT asset_owner_snapshot IS NULL AND evidence_snapshot IS NULL FROM vehicle_cost_ledger_entry WHERE id = $5::uuid) AS "costLedger"
    `,
      IDS.customerESign,
      IDS.model,
      IDS.owner,
      IDS.costProfile,
      IDS.costOriginal,
      IDS.listingProfile,
      IDS.insurancePolicy,
      IDS.ownershipPeriod
    );
    assert.deepEqual(sqlNull, [
      {
        eSign: true,
        model: true,
        notification: true,
        owner: true,
        listing: true,
        policy: true,
        ownership: true,
        costProfile: true,
        costLedger: true
      }
    ]);
    await validateTarget(approved);
  }

  async function validateTarget(approved) {
    return clients[1].$transaction(
      async (tx) => {
        await tx.$queryRaw`SET TRANSACTION READ ONLY`;
        return validateStage1CleanAcceptanceTargetBaseline(tx, {
          approvedManifest: approved.manifest,
          approvedManifestSha256: approved.manifestSha256
        });
      },
      { isolationLevel: "RepeatableRead" }
    );
  }

  async function withForbiddenRow(work) {
    const id = randomUUID();
    const sensitivePhone = `199${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const sensitiveHash = createHash("sha256").update(randomUUID()).digest("hex");
    await clients[1].customerVerificationCode.create({
      data: {
        id,
        phone: sensitivePhone,
        purpose: "LOGIN",
        codeHash: sensitiveHash,
        expiresAt: new Date("2026-08-30T13:00:00.000Z")
      }
    });
    try {
      await work();
    } finally {
      await clients[1].customerVerificationCode.delete({ where: { id } });
    }
  }
}

function createDisposableDatabaseRegistry(adminClient) {
  const createdDatabases = new Set();
  return { create, dropCreated };

  async function create(name) {
    assertDisposableDatabaseName(name);
    const existing = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      name
    ]);
    if (existing.rowCount !== 0) throw new Error("INTEGRATION_DATABASE_NAME_COLLISION");
    await adminClient.query(
      `CREATE DATABASE ${quoteDatabaseName(name)} TEMPLATE template0 ENCODING 'UTF8'`
    );
    createdDatabases.add(name);
  }

  async function dropCreated() {
    let firstError;
    for (const name of [...createdDatabases].reverse()) {
      assertDisposableDatabaseName(name);
      try {
        const existing = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          name
        ]);
        if (existing.rowCount !== 0) {
          await adminClient.query(`DROP DATABASE ${quoteDatabaseName(name)} WITH (FORCE)`);
        }
        createdDatabases.delete(name);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
}

function createAdminFake(options = {}) {
  let exists = options.collision === true;
  const createCalls = [];
  const databaseNameParameters = [];
  const dropCalls = [];
  return {
    client: {
      async query(sql, parameters) {
        if (/^SELECT 1 FROM pg_database/.test(sql)) {
          databaseNameParameters.push(parameters?.[0]);
          return { rowCount: exists ? 1 : 0 };
        }
        if (/^CREATE DATABASE/.test(sql)) {
          if (options.createFailure) throw new Error("INJECTED_CREATE_FAILURE");
          createCalls.push(sql);
          exists = true;
          return { rowCount: 0 };
        }
        if (/^DROP DATABASE/.test(sql)) {
          dropCalls.push(sql);
          exists = false;
          return { rowCount: 0 };
        }
        throw new Error("UNEXPECTED_ADMIN_SQL");
      }
    },
    createCalls,
    databaseNameParameters,
    dropCalls
  };
}

async function assertApplicationEmptyBeforeMigrations(databaseUrl, injected = {}) {
  const pool = (injected.createPool ?? ((options) => new Pool(options)))({
    connectionString: databaseUrl,
    max: 1
  });
  try {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    if (result.rows?.[0]?.count !== 0) {
      throw new Error("INTEGRATION_DATABASE_NOT_EMPTY_BEFORE_MIGRATIONS");
    }
  } finally {
    await pool.end();
  }
}

async function waitForAdvisoryWaiters(client, applicationNames, injected = {}) {
  const maxPolls = injected.maxPolls ?? 100;
  const delay =
    injected.delay ??
    ((milliseconds) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }));
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const result = await client.query(
      `
        SELECT application_name AS "applicationName", wait_event_type AS "waitEventType",
               wait_event AS "waitEvent"
        FROM pg_stat_activity
        WHERE application_name = ANY($1::text[])
      `,
      [applicationNames]
    );
    const waiting = new Set(
      result.rows
        .filter((row) => row.waitEventType === "Lock" && row.waitEvent === "advisory")
        .map((row) => row.applicationName)
    );
    if (applicationNames.every((name) => waiting.has(name))) return;
    if (poll + 1 < maxPolls) await delay(50);
  }
  throw new Error("INTEGRATION_ADVISORY_WAIT_TIMEOUT");
}

async function createPrismaClient(databaseUrl) {
  const [{ PrismaPg }, { PrismaClient }] = await Promise.all([
    import(pathToFileURL(requireFromApi.resolve("@prisma/adapter-pg")).href),
    import(pathToFileURL(requireFromApi.resolve("@prisma/client")).href)
  ]);
  return new PrismaClient({ adapter: new PrismaPg(databaseUrl) });
}

function runMigrationDeploy(databaseUrl, injected = {}) {
  const platform = injected.platform ?? process.platform;
  const nodeExecutable = injected.nodeExecutable ?? process.execPath;
  const migrationArgs = [
    "--filter",
    "@subscription-saas/api",
    "exec",
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "prisma/schema.prisma"
  ];
  const executable = platform === "win32" ? nodeExecutable : "pnpm";
  const args =
    platform === "win32"
      ? [
          win32.resolve(
            win32.dirname(nodeExecutable),
            "node_modules",
            "corepack",
            "dist",
            "pnpm.js"
          ),
          ...migrationArgs
        ]
      : migrationArgs;
  const result = (injected.spawn ?? spawnSync)(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: buildMigrationChildEnv(injected.parentEnv ?? process.env, databaseUrl),
    stdio: "pipe",
    timeout: 60_000
  });
  if (result.status !== 0) throw new Error("INTEGRATION_MIGRATION_DEPLOY_FAILED");
}

function buildMigrationChildEnv(parentEnv, databaseUrl) {
  const childEnv = {};
  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (!isDatabaseConnectionEnvKey(key)) childEnv[key] = value;
  }
  childEnv[PRISMA_MIGRATION_SKIP_DOTENV] = "1";
  childEnv.DATABASE_URL = databaseUrl;
  return childEnv;
}

function isDatabaseConnectionEnvKey(key) {
  const normalized = String(key).toUpperCase();
  if (normalized.startsWith("PG")) return true;
  if (normalized === "DIRECT_URL") return true;
  const hasUrl = normalized.includes("URL");
  return (
    hasUrl &&
    (normalized.includes("DATABASE") ||
      normalized.includes("POSTGRES") ||
      /(^|_)DB(_|$)/.test(normalized) ||
      normalized.includes("DIRECT") ||
      normalized.startsWith("STAGE1_ACCEPTANCE_"))
  );
}

function canonicalMigrationCatalog() {
  const migrationsRoot = resolve(apiRoot, "prisma/migrations");
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      migrationName: entry.name,
      checksum: createHash("sha256")
        .update(readFileSync(resolve(migrationsRoot, entry.name, "migration.sql")))
        .digest("hex")
    }))
    .sort((left, right) => left.migrationName.localeCompare(right.migrationName));
}

async function targetMetadata(prisma) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SET TRANSACTION READ ONLY`;
      return loadStage1CleanAcceptanceTargetSnapshot(tx);
    },
    { isolationLevel: "RepeatableRead" }
  );
}

function assertAllWhitelistDelegatesPresent(counts) {
  assert.equal(Object.keys(counts.whitelist).length, 40);
  assert.ok(Object.values(counts.whitelist).every((count) => count > 0));
  assert.equal(Object.keys(counts.forbidden).length, STAGE1_ACCEPTANCE_FORBIDDEN_DELEGATES.length);
  assert.ok(Object.values(counts.forbidden).every((count) => count === 0));
}

function assertEmptyDatabaseCounts(counts) {
  assert.ok(Object.values(counts.whitelist).every((count) => count === 0));
  assert.ok(Object.values(counts.forbidden).every((count) => count === 0));
}

function selection() {
  return { adminUsername: "keqi_119", customerPhone: "18616570212", vehicleIds: [IDS.vehicle] };
}

function databaseUrlFor(adminUrl, databaseName) {
  assertDisposableDatabaseName(databaseName);
  const value = new URL(adminUrl);
  value.pathname = `/${databaseName}`;
  value.searchParams.delete("schema");
  return value.toString();
}

function withApplicationName(databaseUrl, applicationName) {
  const value = new URL(databaseUrl);
  value.searchParams.set("application_name", applicationName);
  return value.toString();
}

function assertDisposableDatabaseName(value) {
  if (typeof value !== "string" || !DATABASE_NAME.test(value)) {
    throw new Error("UNSAFE_INTEGRATION_DATABASE_NAME");
  }
}

function quoteDatabaseName(value) {
  assertDisposableDatabaseName(value);
  return `"${value}"`;
}

function postgresCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.meta?.driverAdapterError?.cause?.originalCode;
}

function safeIntegrationError(error) {
  const message = error?.message;
  if (/^[A-Z0-9_]+$/.test(message ?? "")) return message;
  const code = postgresCode(error);
  if (/^[0-9A-Z]{5}$/.test(code ?? "")) return `INTEGRATION_POSTGRES_${code}`;
  return error?.name === "AssertionError"
    ? "INTEGRATION_ASSERTION_FAILED"
    : "STAGE1_ACCEPTANCE_POSTGRES_INTEGRATION_FAILED";
}

async function withApplyConfirmation(work) {
  const previous = process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
  process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY = "1";
  try {
    return await work();
  } finally {
    restoreApplyConfirmation(previous);
  }
}

function restoreApplyConfirmation(value) {
  if (value === undefined) delete process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY;
  else process.env.STAGE1_CLEAN_ACCEPTANCE_BASELINE_APPLY = value;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
