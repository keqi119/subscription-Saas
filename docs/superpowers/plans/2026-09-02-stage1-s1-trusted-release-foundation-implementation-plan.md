# Stage 1 S1 Trusted Release Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved S1 trusted release foundation: isolated PostgreSQL 17 database tests with zero skips, an immutable API/Web/Runner release bundle, capability-scoped Runner execution and proofs, a sanitized snapshot upgrade chain, final-artifact Compose verification, and removal of governance tooling from the API runtime.

**Architecture:** Keep one repository and one fixed source SHA, but separate three responsibilities: source-gate execution before image build, a one-shot closed-command Runner for candidate and long-lived environments, and an external trusted launcher/CI trust root. Store versioned contracts under `release/contracts`, share canonicalization and proof logic through a focused release-foundation package, and promote only a complete three-image bundle whose fresh and snapshot proofs agree with the source gate.

**Tech Stack:** Node.js 22, pnpm 11.4.0, Node ESM and `node:test`, TypeScript/Vitest, Prisma 7.8, PostgreSQL 17, Docker Buildx/Compose, GitHub Actions and artifact attestations, Ajv 8.20.0, `canonicalize` 4.0.0, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-09-01-stage1-s1-trusted-release-foundation-and-test-isolation-design.zh-CN.md` at approved baseline `ee9ca6bca41ef3b8ec1403b584b45705301ec5b5`.

## Global Constraints

- Start implementation in a new isolated worktree from a `main` commit that already contains the approved ADR, S0 specification, S1 specification, and this plan. Do not implement on the documentation worktree.
- Before every implementation task run `git status --short`, `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`, and `pnpm prisma:validate`. Stop on pending migrations, target drift, an unknown database identity, or unrelated overlapping changes.
- S1 adds no business model, business enum, application RBAC permission, business migration, or feature flag. It must not change customer-visible behavior, application API contracts, domain semantics, audit semantics, lock order, or business transaction boundaries.
- Never edit an applied migration. S1 may read, hash, copy into the Runner image, and execute the existing migration catalog only.
- PostgreSQL release tests use a digest-pinned PostgreSQL 17 image and record `server_version_num`. A suite or shard gets its own database by default; Schema-only isolation requires a separately approved proof and is not part of this plan.
- Database test release evidence must satisfy `collected = selected = executed = passed + failed`, with `failed=0`, `skipped=0`, `todo=0`, `filtered=0`, and `cancelled=0`.
- The Runner supports only `runner execute <commandId>@<commandVersion>`. It is one-shot, receives exactly one capability credential, never exposes a supported arbitrary shell/script/SQL entry, and never receives Docker socket access.
- The trusted launcher validates build proof, registry-resolved Runner digest, command, execution scope, environment policy, target metadata, and capability/secret-reference binding before passing the credential file to the Runner.
- `full-rc` and `migration-schema` always reference the same complete build proof. `migration-schema` may omit starting Web, but never creates a promotable partial bundle.
- Every `ci-policy` or human approval binds the build-proof digest, baseline Manifest identity/full digest, database identity, command ID/version, operation ID, input digest, and deterministic plan digest. Any change requires a new dry-run and approval.
- RFC 8785 canonical JSON uses UTF-8 and SHA-256 lowercase hexadecimal digests. Timestamps are RFC 3339 with an explicit UTC offset; money, bigint, and exact decimals are decimal strings.
- A post-state observation never references an execution-proof digest. Generate and custody the observation first, then create the execution proof that references the observation digest.
- Evidence enters a content-addressed, non-overwritable GitHub Actions artifact before database cleanup or release aggregation. Default retention is 180 days; secrets, raw URLs, phone numbers, tokens, customer identifiers, and raw Staging data are prohibited.
- The snapshot export runs only in the protected `stage1-snapshot-export` GitHub environment. Ordinary CI receives only the final immutable sanitized artifact plus its contract, owner mapping, scan evidence, and digest.
- During command migration, old and Runner write entry points may coexist in test images only. At most one entry receives an active credential in any real environment. Behavior equivalence uses two independent databases restored from the same baseline.
- API runtime extraction is complete only when `/app/scripts` governance entry points, Prisma CLI, `psql`, and direct governance package scripts are unavailable while the API still starts and queries PostgreSQL through Prisma Client.
- Every task is a separate review/commit boundary. Do not combine Tasks 4-7, Tasks 12-15, or Tasks 17-19 into one PR. Stop if a task exceeds approximately 1,500 production lines or 25 production files and split it for approval.
- S2 and S3 remain blocked. This plan does not create the S3 mature-order fixture, repair Staging data, promote an RC, or run human Stage 1 acceptance.

## Delivery Topology

```text
Contract kernel
  -> database discovery -> isolated database lifecycle -> suite migration -> source gate
  -> Runner trust boundary -> proof/custody state machine
  -> sanitized snapshot chain
  -> API tooling inventory -> command adapters -> API runtime extraction
  -> trusted three-image build -> final Compose/browser gate -> release aggregation
```

The 19 tasks below are the minimum review units. A reviewer may split a task further, but must not merge adjacent tasks merely to reduce PR count.

## Planned File Map

| Area                 | Files and responsibility                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository contracts | `release/contracts/**`: proof Schemas, command registry, test discovery/manifest, target policies, PostgreSQL image identity, snapshot contracts, API runtime allowlist, retention rules, and the self-covering contract-file manifest |
| Shared release logic | `packages/release-foundation/**`: RFC 8785 wrapper, digest/catalog computation, Ajv validation, proof builders, database lifecycle, test discovery/reporting, and custody helpers                                                      |
| Runner               | `apps/release-runner/**`: closed CLI, preflight, secret-file handoff, capability profiles, command adapters, proof emission, and tests                                                                                                 |
| Source gate          | `scripts/release/**`: source-only orchestration, database suite launcher, build-proof aggregation, artifact custody confirmation, inventory generation, and policy validation                                                          |
| Images and Compose   | `Dockerfile.api`, `Dockerfile.web`, `Dockerfile.runner`, `docker-compose.release-gate.yml`, and image deployment examples                                                                                                              |
| CI                   | `.github/workflows/ci.yml`, `.github/workflows/docker-images.yml`, `.github/workflows/sanitized-snapshot.yml`                                                                                                                          |
| Final client gate    | `playwright.release.config.ts`, `tests/release/web-public-api.spec.ts`                                                                                                                                                                 |
| Operations           | `docs/operations/stage1-s1-*.md`, existing deployment Runbooks, and machine-generated evidence summaries                                                                                                                               |

---

### Task 1: Establish the versioned contract and digest kernel

**Files:**

- Create: `packages/release-foundation/package.json`
- Create: `packages/release-foundation/src/canonical-json.mjs`
- Create: `packages/release-foundation/src/digest.mjs`
- Create: `packages/release-foundation/src/schema-registry.mjs`
- Create: `packages/release-foundation/src/catalogs.mjs`
- Create: `packages/release-foundation/src/index.mjs`
- Create: `packages/release-foundation/test/canonical-json.test.mjs`
- Create: `packages/release-foundation/test/schema-registry.test.mjs`
- Create: `packages/release-foundation/test/catalogs.test.mjs`
- Create: `release/contracts/repository-contract-files.v1.json`
- Create: `release/contracts/schemas/build-proof.v1.schema.json`
- Create: `release/contracts/schemas/source-gate-evidence.v1.schema.json`
- Create: `release/contracts/schemas/baseline-environment-manifest.v1.schema.json`
- Create: `release/contracts/schemas/post-state-observation.v1.schema.json`
- Create: `release/contracts/schemas/execution-proof.v1.schema.json`
- Create: `release/contracts/schemas/release-aggregate-proof.v1.schema.json`
- Create: `release/contracts/schemas/launch-attestation.v1.schema.json`
- Create: `release/contracts/schemas/custody-receipt.v1.schema.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `canonicalJson(value): string`, `sha256Canonical(value): string`, `computeMigrationCatalog(repoRoot): MigrationCatalog`, `computeRepositoryContract(repoRoot): RepositoryContract`, and `validateContract(schemaId, value): void`.
- Consumes: only repository files and pure JSON values; it must not read environment secrets or connect to a database.

- [ ] **Step 1: Add the package and exact dependencies**

```json
{
  "name": "@subscription-saas/release-foundation",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./src/index.mjs",
  "scripts": {
    "test": "node --test test/*.test.mjs"
  },
  "dependencies": {
    "ajv": "8.20.0",
    "canonicalize": "4.0.0"
  }
}
```

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` records the exact versions; no floating range is introduced.

- [ ] **Step 2: Write failing RFC 8785 and rejection tests**

```js
test("uses RFC 8785 ordering without sorting array elements", () => {
  assert.equal(canonicalJson({ z: [2, 1], a: "中" }), '{"a":"中","z":[2,1]}');
});

for (const value of [NaN, Infinity, undefined, 1n]) {
  test(`rejects non-I-JSON value ${String(value)}`, () => {
    assert.throws(() => canonicalJson({ value }), /CANONICAL_JSON_REFUSED/);
  });
}
```

Run: `pnpm --filter @subscription-saas/release-foundation test`

Expected: FAIL because the package exports do not exist.

- [ ] **Step 3: Implement the canonical wrapper and lowercase digest**

```js
import canonicalize from "canonicalize";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  const result = canonicalize(value);
  if (typeof result !== "string") throw codeError("CANONICAL_JSON_REFUSED");
  return result;
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
```

Add explicit pre-validation for `undefined`, functions, symbols, bigint, cycles, and non-finite numbers so failure codes are deterministic.

- [ ] **Step 4: Write failing Schema and self-covering catalog tests**

```js
test("repository contract rejects an omitted contract file", async () => {
  const manifest = await loadContractFileManifest(repoRoot);
  const omitted = manifest.files.find((file) => file.endsWith("execution-proof.v1.schema.json"));
  assert.ok(omitted);
  await assert.rejects(
    computeRepositoryContract(repoRoot, { ignore: omitted }),
    /CONTRACT_FILE_SET_DRIFT/
  );
});
```

Expected: the test also rejects unknown Schema versions, additional proof properties, missing files, duplicate paths, non-lowercase SHA values, and migration-order/checksum drift.

- [ ] **Step 5: Implement strict Ajv validation and catalog hashing**

```js
const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });

export function validateContract(schemaId, value) {
  const validate = validators.get(schemaId);
  if (!validate) throw codeError("CONTRACT_SCHEMA_UNREGISTERED");
  if (!validate(value)) throw codeError("CONTRACT_SCHEMA_INVALID", validate.errors);
}
```

`computeMigrationCatalog` sorts migration directories by path and hashes each `migration.sql`; `computeRepositoryContract` hashes the canonical ordered list of every file declared by `repository-contract-files.v1.json`, including that manifest itself.

- [ ] **Step 6: Add root verification commands**

```json
{
  "release:contracts:test": "pnpm --filter @subscription-saas/release-foundation test",
  "release:contracts:verify": "node scripts/release/verify-contracts.mjs"
}
```

Create `scripts/release/verify-contracts.mjs` as a thin source-only caller of `computeMigrationCatalog`, `computeRepositoryContract`, and all registered Schema compilation.

- [ ] **Step 7: Run the focused gate and commit**

```powershell
pnpm --filter @subscription-saas/release-foundation test
pnpm release:contracts:verify
pnpm exec prettier --check packages/release-foundation release/contracts package.json
git diff --check
git add packages/release-foundation release/contracts scripts/release/verify-contracts.mjs package.json pnpm-lock.yaml
git commit -m "build: add release contract digest kernel"
```

Expected: all tests pass; the output prints only migration/repository digests and counts, never repository secrets.

### Task 2: Define the database-test discovery universe and committed manifest

**Files:**

- Create: `release/contracts/database-test-discovery.v1.json`
- Create: `release/contracts/database-test-manifest.v1.json`
- Create: `release/contracts/database-test-exceptions.v1.json`
- Create: `release/contracts/external-validation-applicability.v1.json`
- Create: `release/contracts/schemas/database-test-manifest.v1.schema.json`
- Create: `release/contracts/schemas/database-test-report.v1.schema.json`
- Create: `release/contracts/schemas/external-validation-applicability.v1.schema.json`
- Create: `packages/release-foundation/src/database-test-discovery.mjs`
- Create: `packages/release-foundation/test/database-test-discovery.test.mjs`
- Create: `scripts/release/discover-database-tests.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `apps/api/vitest.config.ts`
- Modify: `apps/api/test/vitest-config.spec.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `discoverDatabaseTestCandidates(repoRoot, rules): Candidate[]` and `classifyDatabaseTests(candidates, manifest, exceptions): ClassificationReport`.
- Manifest suite fields: `suiteId`, `runner`, `files`, explicit `chainApplicability` for both `fresh` and `snapshot`, `databaseRole`, `parallelism`, `timeoutMs`, `barrier`, `externalDependency`, and `owner`.
- External applicability status is exactly one of `must-automate`, `must-external-verify`, `must-human-verify`, or approved `not-applicable`; it is never represented as a framework skip.

- [ ] **Step 1: Write failing discovery tests with fixture files**

```js
test("discovers candidates by filename, imports, environment use, and explicit label", async () => {
  const candidates = await discoverDatabaseTestCandidates(fixtureRoot, rules);
  assert.deepEqual(candidates.map(({ path }) => path).sort(), [
    "imports-pg.spec.ts",
    "labeled.spec.ts",
    "reads-database-url.test.mjs",
    "schema.integration.spec.ts"
  ]);
});

test("fails when a candidate is neither manifested nor excepted", () => {
  assert.throws(() => classifyDatabaseTests(candidates, [], []), /DATABASE_TEST_UNCLASSIFIED/);
});
```

Run: `pnpm --filter @subscription-saas/release-foundation test`

Expected: FAIL because discovery is absent.

- [ ] **Step 2: Implement the four-rule union and exact classification**

```js
export const candidateReasons = Object.freeze([
  "filename-pattern",
  "database-client-import",
  "database-environment-read",
  "explicit-database-label"
]);
```

Scan tracked `apps/**/test/**` and `scripts/**/*.test.mjs` files only. Normalize paths to forward slashes, deduplicate reasons, reject duplicate suite IDs/files, and require every exception to include `owner`, `reason`, `scope`, and `reviewDate`.

If a candidate mixes database invariants with a supplier/browser/manual dependency, the classifier must require a database-only contract suite plus a separately owned external applicability record. Missing credentials cannot suppress the database contract portion.

- [ ] **Step 3: Generate and review the real repository candidate report**

```powershell
node scripts/release/discover-database-tests.mjs --mode report --output output/s1-database-candidates.json
```

Expected: the report includes all 26 files currently listed by `apps/api/vitest.config.ts`, both conditional Node PostgreSQL test files, and any additional file discovered by import/environment/tag rules. The command exits nonzero until every candidate is committed to the manifest or exception file.

- [ ] **Step 4: Commit the manifest with explicit fresh/snapshot applicability**

For each manifested suite use this shape; do not use an implicit default:

```json
{
  "suiteId": "api.asset-accounting.repository",
  "runner": "vitest",
  "files": ["apps/api/test/asset-accounting.repository.integration.spec.ts"],
  "chainApplicability": {
    "fresh": { "status": "required" },
    "snapshot": { "status": "required" }
  },
  "databaseRole": "runtime-equivalent-test",
  "parallelism": { "mode": "parallel", "maxShards": 1 },
  "timeoutMs": 120000,
  "barrier": "database",
  "externalDependency": "none",
  "owner": "api-database-test"
}
```

Exceptions are allowed only for a discovered file proven to be pure mock/type/Schema text inspection; each exception has a review date and cannot suppress a runnable database invariant. If one suite is not executed on one upgrade chain, that chain entry must be `approved-na` with owner, reason, approval reference, and review date; absence or an implicit default fails discovery.

- [ ] **Step 5: Make Vitest consume the committed manifest instead of a second list**

```ts
const databaseTestFiles = loadDatabaseTestManifest(repoRoot)
  .filter((suite) => suite.runner === "vitest")
  .flatMap((suite) => suite.files)
  .map((path) => relative(apiRoot, resolve(repoRoot, path)).replaceAll("\\", "/"));
```

Keep the unit project exclusion, but remove the handwritten `databaseTestFiles` array. Add a config test proving every manifested Vitest file appears once in the database project and once in the unit exclusion.

- [ ] **Step 6: Add the discovery gate and commit**

```powershell
node scripts/release/discover-database-tests.mjs --mode verify
pnpm --filter @subscription-saas/api exec vitest run test/vitest-config.spec.ts --project unit
pnpm release:contracts:verify
git diff --check
git add release/contracts packages/release-foundation scripts/release/discover-database-tests.mjs apps/api/vitest.config.ts apps/api/test/vitest-config.spec.ts package.json
git commit -m "test: define database test discovery manifest"
```

Expected: zero unclassified files and zero manifest entries absent from discovery.

### Task 3: Build safe ephemeral database and role isolation

**Files:**

- Create: `release/contracts/postgres-image.v1.json`
- Create: `release/contracts/database-target-policies.v1.json`
- Create: `release/contracts/schemas/database-target-policy.v1.schema.json`
- Create: `release/contracts/migration-global-object-policy.v1.json`
- Create: `release/contracts/schemas/migration-global-object-policy.v1.schema.json`
- Create: `packages/release-foundation/src/database-target.mjs`
- Create: `packages/release-foundation/src/database-lifecycle.mjs`
- Create: `packages/release-foundation/src/database-roles.mjs`
- Create: `packages/release-foundation/src/migration-global-object-scan.mjs`
- Create: `packages/release-foundation/test/database-target.test.mjs`
- Create: `packages/release-foundation/test/database-lifecycle.postgres.test.mjs`
- Create: `scripts/release/run-postgres-contract-tests.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- Produces: `assertApprovedEphemeralTarget(metadata)`, `provisionSuiteDatabase(input): ProvisionedDatabase`, `grantRuntimeEquivalentAccess(input)`, and `cleanupSuiteDatabase(record)`.
- `ProvisionedDatabase` returns secret references and fingerprints, never a printable raw URL.

- [ ] **Step 1: Add failing target-policy tests**

```js
test("rejects staging, production, unknown clusters and absent markers", () => {
  for (const environment of ["staging", "production", "unknown"]) {
    assert.throws(
      () => assertApprovedEphemeralTarget({ ...validTarget, environment }),
      /EPHEMERAL_TARGET_REJECTED/
    );
  }
});

test("cleanup requires exact run record and database comment marker", async () => {
  await assert.rejects(
    cleanupSuiteDatabase({ ...record, databaseName: `${record.databaseName}_x` }),
    /CLEANUP_IDENTITY_MISMATCH/
  );
});
```

- [ ] **Step 2: Pin PostgreSQL 17 by resolved digest**

Create `postgres-image.v1.json` with `repository`, `tag`, `platform`, `resolvedDigest`, and `serverVersionMajor: 17`. Resolve the digest from the registry during implementation and commit the exact `sha256:` value; the verification command must reject a tag-only contract.

Run: `docker buildx imagetools inspect postgres:17-bookworm`

Expected: one recorded linux/amd64 digest, later verified again by `docker image inspect` after pull.

- [ ] **Step 3: Implement exact-name provisioning and marker comments**

```js
export function suiteDatabaseName(runId, suiteId, shard) {
  const suffix = sha256Text(`${runId}:${suiteId}:${shard}`).slice(0, 24);
  return `s1ci_${suffix}`;
}
```

Provisioner creates one migration owner and one runtime-equivalent role per database. The database comment stores canonical `subscription-s1-ephemeral/v1`, run ID digest, suite ID digest, and creation timestamp. No cleanup function accepts a prefix or glob.

- [ ] **Step 4: Implement least-privilege grants**

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO runtime_test_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO runtime_test_role;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO runtime_test_role;
ALTER DEFAULT PRIVILEGES FOR ROLE migration_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO runtime_test_role;
```

Tests assert the runtime role has no `SUPERUSER`, `CREATEDB`, `BYPASSRLS`, role membership, or Schema ownership, while the migration role owns `public` and `_prisma_migrations` after deploy. If an existing database test needs a privilege outside this DML contract, classify whether it is test setup that belongs to the migration/fixture phase or a genuine runtime requirement; do not grant it ad hoc to make the test pass.

Scan the complete migration catalog before provisioning. Allow only database-local `CREATE EXTENSION IF NOT EXISTS` for the committed `pgcrypto` and `btree_gist` set. Reject role, user, database, tablespace, `ALTER SYSTEM`, or unregistered extension operations. If a future approved migration needs another cluster-global object, stop and redesign that Release test chain around an isolated PostgreSQL cluster instead of weakening the database-isolation policy.

- [ ] **Step 5: Run real PostgreSQL lifecycle tests**

```powershell
node scripts/release/run-postgres-contract-tests.mjs --suite database-lifecycle
```

Expected: the harness pulls the pinned image, creates two databases concurrently, proves role isolation, refuses a forged target/marker, drops exactly the two recorded names, and leaves the container with no `s1ci_` database.

- [ ] **Step 6: Commit the isolation foundation**

```powershell
pnpm --filter @subscription-saas/release-foundation test
pnpm release:contracts:verify
git diff --check
git add release/contracts packages/release-foundation scripts/release/run-postgres-contract-tests.mjs package.json
git commit -m "test: isolate release database identities"
```

### Task 4: Remove the two conditional Node-test skips

**Files:**

- Create: `release/test-fixtures/stage1-clean-acceptance.sql`
- Create: `release/test-fixtures/stage1-invalid-order-retirement.sql`
- Create: `packages/release-foundation/src/node-database-test-runner.mjs`
- Create: `packages/release-foundation/test/node-database-test-runner.test.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-postgres.integration.test.mjs`
- Modify: `release/contracts/database-test-manifest.v1.json`
- Modify: `package.json`

**Interfaces:**

- Consumes: provisioned source/target database secret files and fixture paths from Task 3.
- Produces: one normalized `database-test-report.v1` per suite with full Node test counts.

- [ ] **Step 1: Write a failing static test that forbids framework skips**

```js
test("database candidates contain no conditional skip or only", async () => {
  const violations = await scanDatabaseFrameworkBypasses(repoRoot, manifest);
  assert.deepEqual(violations, []);
});
```

Expected RED findings are exactly the current `integrationTest = value ? test : test.skip` declarations in the two script test files.

- [ ] **Step 2: Split fixture setup from test execution**

Move DDL/setup into the two SQL fixture files, executed by the migration role before test start. The test processes receive only their declared test capability and cannot create/drop databases or Schemas.

```js
const sourceUrl = requiredSecretFile("S1_TEST_SOURCE_DATABASE_URL_FILE");
const targetUrl = requiredSecretFile("S1_TEST_TARGET_DATABASE_URL_FILE");
test("real PostgreSQL applies and replays", async () => runScenario({ sourceUrl, targetUrl }));
```

Missing files must throw `RELEASE_DATABASE_SECRET_FILE_REQUIRED`; never substitute `DATABASE_URL`.

- [ ] **Step 3: Remove `test.skip` and make standalone misuse fail**

```js
if (process.env.S1_RELEASE_DATABASE_TEST !== "1") {
  throw new Error("RELEASE_DATABASE_TEST_LAUNCHER_REQUIRED");
}
```

The source-gate launcher sets this marker only after target policy, marker, and role verification.

- [ ] **Step 4: Run both suites through the source-gate runner**

```powershell
node scripts/release/run-database-suite.mjs --suite-id script.stage1-clean-acceptance.postgres --chain fresh
node scripts/release/run-database-suite.mjs --suite-id script.stage1-invalid-order-retirement.postgres --chain fresh
```

Expected: both reports have `skipped=0`, `todo=0`, `filtered=0`, `cancelled=0`, `failed=0`; the second execution of each suite uses a distinct database identity.

- [ ] **Step 5: Commit the explicit database tests**

```powershell
node scripts/release/discover-database-tests.mjs --mode verify
pnpm --filter @subscription-saas/release-foundation test
git diff --check
git add release/test-fixtures release/contracts/database-test-manifest.v1.json packages/release-foundation scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs scripts/stage1-staging-invalid-test-order-retirement-postgres.integration.test.mjs package.json
git commit -m "test: require explicit postgres test identities"
```

---

### Task 5: Migrate database suites batch A to isolated databases

**Files:**

- Modify: `apps/api/test/asset-accounting.repository.integration.spec.ts`
- Modify: `apps/api/test/asset-facts.repository.integration.spec.ts`
- Modify: `apps/api/test/asset-operations.repository.integration.spec.ts`
- Modify: `apps/api/test/auto-debit-settlement.integration.spec.ts`
- Modify: `apps/api/test/billing-automation.integration.spec.ts`
- Modify: `apps/api/test/contract-segment.integration.spec.ts`
- Modify: `apps/api/test/vehicle-availability.integration.spec.ts`
- Modify: `apps/api/test/mileage-review-e2e.spec.ts`
- Modify: `apps/api/test/sms.integration.spec.ts`
- Modify: `release/contracts/database-test-manifest.v1.json`
- Modify: `packages/release-foundation/src/database-test-launcher.mjs`
- Create: `packages/release-foundation/test/database-batch-a.integration.test.mjs`

**Interfaces:**

- Consumes: one exact ephemeral database identity and one runtime-equivalent test credential per suite process.
- Produces: nine independent normalized reports whose suite IDs match the committed manifest.

- [ ] **Step 1: Add a failing isolation contract test for batch A**

```js
for (const suiteId of batchA) {
  test(`${suiteId} uses its assigned database only`, async () => {
    const report = await runManifestSuite({ suiteId, chain: "fresh" });
    assert.equal(report.target.databaseName, report.assignment.databaseName);
    assert.equal(report.target.roleAttributes.superuser, false);
    assert.equal(report.target.roleAttributes.createdb, false);
    assert.equal(report.target.schemaOwner, false);
  });
}
```

Run: `pnpm --filter @subscription-saas/release-foundation test -- database-batch-a.integration.test.mjs`

Expected: FAIL while the suites still read a shared or fallback `DATABASE_URL`.

- [ ] **Step 2: Replace fallback database lookup with the injected test context**

Each suite must obtain its client from the shared helper and must not provision, migrate, create a Schema, or drop its own database:

```ts
const context = requiredReleaseDatabaseTestContext(import.meta.url);
const prisma = createPrismaClient(context.databaseUrl);
```

Remove localhost defaults, `?schema=public` fallbacks, and suite-local cleanup of shared objects. Keep existing assertions and business fixtures unchanged.

- [ ] **Step 3: Execute every suite in its own process and database**

```powershell
node scripts/release/run-database-manifest.mjs --chain fresh --batch batch-a --concurrency 4
```

Expected: nine unique database names and marker IDs; all reports satisfy the zero-skip equation. The provisioner, migration, and runtime-equivalent test identities are different for every assignment.

- [ ] **Step 4: Prove deterministic cleanup by exact identity**

Interrupt one suite after migration, then invoke cleanup with its recorded database name and marker. Expected: that one database is removed; sibling databases remain queryable; wildcard and prefix-only cleanup attempts are refused.

- [ ] **Step 5: Commit batch A separately**

```powershell
pnpm --filter @subscription-saas/release-foundation test
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add apps/api/test release/contracts/database-test-manifest.v1.json packages/release-foundation
git commit -m "test: isolate database suites batch a"
```

---

### Task 6: Migrate database suites batch B to isolated databases

**Files:**

- Modify: `apps/api/test/stage2-handover-pdf.integration.spec.ts`
- Modify: `apps/api/test/stage2-handover-provider-reconciliation.integration.spec.ts`
- Modify: `apps/api/test/stage2-handover-workflow.repository.spec.ts`
- Modify: `apps/api/test/subscription-expiry-return.integration.spec.ts`
- Modify: `apps/api/test/subscription-journey-failure-recovery.e2e-spec.ts`
- Modify: `apps/api/test/subscription-journey-golden-path.e2e-spec.ts`
- Modify: `apps/api/test/subscription-journey-integrity.integration.spec.ts`
- Modify: `apps/api/test/subscription-journey.repository.integration.spec.ts`
- Modify: `release/contracts/database-test-manifest.v1.json`
- Create: `packages/release-foundation/test/database-batch-b.integration.test.mjs`

**Interfaces:**

- Consumes: the Task 3 lifecycle and Task 5 process-isolation adapter.
- Produces: eight independent reports without changing Stage2 or Journey behavior.

- [ ] **Step 1: Add a failing batch-B isolation and concurrency test**

Launch the Journey integrity and golden-path suites simultaneously behind an explicit barrier. Assert they receive different database identities and neither can observe the other's marker row.

```js
await Promise.all([
  runManifestSuite({ suiteId: "subscription-journey-integrity", barrier }),
  runManifestSuite({ suiteId: "subscription-journey-golden-path", barrier })
]);
assert.equal(await leakedMarkerCount(), 0);
```

- [ ] **Step 2: Inject assigned URLs without changing workflow timing or worker behavior**

Replace shared URL lookup only. Preserve existing transaction boundaries, advisory locks, worker counts, fake clocks, and expected events. A scenario that intentionally uses one worker may remain serial; the batch runner itself must support parallel shards.

- [ ] **Step 3: Execute the fresh chain twice with different shard order**

```powershell
node scripts/release/run-database-manifest.mjs --chain fresh --batch batch-b --concurrency 4 --order manifest
node scripts/release/run-database-manifest.mjs --chain fresh --batch batch-b --concurrency 4 --order reverse
```

Expected: both executions pass with identical selected-suite digests and zero skipped/filtered/cancelled tests.

- [ ] **Step 4: Validate no suite owns its Schema**

Query `pg_roles`, `pg_namespace`, and table ownership from the verify identity. Expected: the migration role owns the application Schema and objects; runtime-equivalent test roles have only the grants needed by the application tests.

- [ ] **Step 5: Commit batch B separately**

```powershell
pnpm --filter @subscription-saas/release-foundation test
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add apps/api/test release/contracts/database-test-manifest.v1.json packages/release-foundation
git commit -m "test: isolate database suites batch b"
```

---

### Task 7: Migrate database suites batch C and enforce the source database gate

**Files:**

- Modify: `apps/api/test/subscription-closure.schema.spec.ts`
- Modify: `apps/api/test/subscription-closure.repository.integration.spec.ts`
- Modify: `apps/api/test/subscription-change-active-order.e2e-spec.ts`
- Modify: `apps/api/test/subscription-change-migration.integration.spec.ts`
- Modify: `apps/api/test/subscription-extension.integration.spec.ts`
- Modify: `apps/api/test/subscription-early-termination-change.e2e-spec.ts`
- Modify: `apps/api/test/subscription-vehicle-swap.integration.spec.ts`
- Modify: `apps/api/test/subscription-vehicle-swap.e2e-spec.ts`
- Modify: `apps/api/test/subscription-vehicle-swap-failure-injection.spec.ts`
- Modify: `apps/api/vitest.config.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `release/contracts/database-test-manifest.v1.json`
- Create: `scripts/release/run-source-database-gate.mjs`
- Create: `packages/release-foundation/test/source-database-gate.test.mjs`

**Interfaces:**

- Consumes: the complete discovery manifest, PostgreSQL image contract, fresh-chain policies, and exact suite assignments.
- Produces: `source-gate-evidence.v1` with the discovery digest, manifest digest, PostgreSQL digest/version, migration catalog digest, and complete count equation.

- [ ] **Step 1: Add failing batch-C and aggregate count tests**

```js
assert.equal(report.collected, report.selected);
assert.equal(report.selected, report.executed);
assert.equal(report.executed, report.passed + report.failed);
for (const key of ["failed", "skipped", "todo", "filtered", "cancelled"]) {
  assert.equal(report[key], 0);
}
```

Also fail on `.only`, conditional suite selection, fail-fast, an unclassified candidate, or a suite that neither executes on `fresh` nor carries an explicit approved N/A for that chain.

- [ ] **Step 2: Migrate batch C to injected database contexts**

Preserve all existing closure, change, extension, early-termination, and swap assertions. This task changes test infrastructure only; it must not repair or reinterpret those capabilities.

- [ ] **Step 3: Split API test commands without silently excluding database tests**

```json
{
  "scripts": {
    "test:unit": "vitest run --project unit",
    "test:database": "node ../../scripts/release/run-source-database-gate.mjs",
    "test": "pnpm test:unit && pnpm test:database"
  }
}
```

The exact command may use existing workspace filters, but `pnpm --filter @subscription-saas/api test` must always include the database gate.

- [ ] **Step 4: Upgrade CI to the digest-pinned PostgreSQL 17 contract**

Remove the shared `subscription_saas_test?schema=public` service URL. The provisioner starts the approved temporary cluster, verifies its identity and `server_version_num`, then gives each suite its own exact database.

```yaml
- name: Run complete API test gate
  run: pnpm --filter @subscription-saas/api test
```

Expected: missing database infrastructure, a migration failure, or any count mismatch fails the job; no conditional skip path exists.

- [ ] **Step 5: Run the complete source gate locally**

```powershell
pnpm --filter @subscription-saas/api test:unit
pnpm --filter @subscription-saas/api test:database
pnpm --filter @subscription-saas/api test
node scripts/release/discover-database-tests.mjs --mode verify
```

Expected: the aggregate evidence identifies every collected suite and both applicability chains; no suite is omitted by a second hard-coded list.

- [ ] **Step 6: Commit the enforced source gate**

```powershell
git diff --check
git add .github/workflows/ci.yml apps/api package.json release/contracts scripts/release packages/release-foundation
git commit -m "ci: enforce isolated postgres release tests"
```

---

### Task 8: Build the closed Runner CLI and trust boundary

**Files:**

- Create: `apps/release-runner/package.json`
- Create: `apps/release-runner/src/cli.mjs`
- Create: `apps/release-runner/src/preflight.mjs`
- Create: `apps/release-runner/src/credential-file.mjs`
- Create: `apps/release-runner/src/command-registry.mjs`
- Create: `apps/release-runner/src/error-codes.mjs`
- Create: `apps/release-runner/test/cli.test.mjs`
- Create: `apps/release-runner/test/preflight.test.mjs`
- Create: `apps/release-runner/test/credential-boundary.test.mjs`
- Create: `release/contracts/schemas/command-registry.v1.schema.json`
- Create: `release/contracts/schemas/target-policy.v1.schema.json`
- Create: `release/contracts/command-registry.v1.json`
- Create: `release/contracts/target-policies.v1.json`
- Create: `Dockerfile.runner`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Supported invocation: `runner execute <commandId>@<commandVersion> --request-file <path>`.
- Preflight input: build proof, trusted launch attestation, actual registry-resolved Runner digest, scope, environment declaration, target metadata, command request, and capability profile.
- Credential handoff: a launcher-created, read-once file reference exposed only after pre-connection validation succeeds.

- [ ] **Step 1: Write failing CLI surface tests**

```js
for (const argv of [["sh"], ["execute", "scripts/foo.mjs"], ["sql", "select 1"]]) {
  test(`rejects ${argv.join(" ")}`, async () => {
    await assert.rejects(() => runCli(argv), /RUNNER_COMMAND_NOT_REGISTERED/);
  });
}
```

The registry must reject an unknown environment, a prohibited environment, an undeclared capability, a mutable image identity, and an entry whose command contract version changed without a `commandVersion` increment.

- [ ] **Step 2: Prove fail-closed ordering before secret access**

Instrument the credential reader and database connector. For invalid proof, Runner digest, target policy, or capability binding, assert both counters remain zero and the trusted launcher records `PREFLIGHT_REJECTED`.

```js
assert.equal(secretReads, 0);
assert.equal(databaseConnections, 0);
```

- [ ] **Step 3: Implement the closed registry and single-profile binding**

Each registry entry declares command ID/version, category, data impact, capability profile, allowed/prohibited environments, approval mode, dry-run/apply/replay support, lock/timeout/postconditions, evidence Schema, owner, and exit condition. One execution request has exactly one profile; a command needing DDL and business DML must be split.

Define protocols and policy validation for all five Runner capabilities. Configure actual S1 environment identities only for `verify`, `migrate`, `repair`, and `evidence`; `fixture` has no S1 command or credential and remains reserved for the later S3 fixture design.

- [ ] **Step 4: Implement stable target-intent checks**

Validate environment declaration, secret reference, host allowlist, exact database intent, TLS policy, and prohibited environments before reading credentials. After connecting, read and freeze actual database identity, role, Schema, extensions, and migration head into the baseline Manifest.

- [ ] **Step 5: Build and inspect the one-shot Runner image**

`Dockerfile.runner` must set the closed CLI as `ENTRYPOINT`, copy only registered command dependencies, include the pinned Prisma and `psql` tools required by declared commands, and add the OCI source revision label. Runtime policy—not absence of `/bin/sh`—must prohibit entrypoint override, container exec, and Docker socket access.

```powershell
$s1SourceSha = (git rev-parse HEAD).Trim()
docker build -f Dockerfile.runner --label "org.opencontainers.image.revision=$s1SourceSha" -t subscription-runner:s1 .
docker inspect subscription-runner:s1
```

- [ ] **Step 6: Commit the Runner trust boundary**

```powershell
pnpm --filter @subscription-saas/release-runner test
pnpm --filter @subscription-saas/release-foundation test
git diff --check
git add apps/release-runner release/contracts Dockerfile.runner pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build: add capability scoped release runner"
```

---

### Task 9: Implement the acyclic proof lifecycle and trusted custody

**Files:**

- Create: `packages/release-foundation/src/proof-builders.mjs`
- Create: `packages/release-foundation/src/execution-state-machine.mjs`
- Create: `packages/release-foundation/src/evidence-custody.mjs`
- Create: `packages/release-foundation/test/proof-builders.test.mjs`
- Create: `packages/release-foundation/test/execution-state-machine.test.mjs`
- Create: `packages/release-foundation/test/evidence-custody.test.mjs`
- Create: `scripts/release/trusted-launch-runner.mjs`
- Create: `scripts/release/custody-evidence.mjs`
- Create: `docs/operations/stage1-s1-evidence-custody.md`
- Modify: `apps/release-runner/src/cli.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Proof chain: baseline Manifest digest -> deterministic plan digest -> post-state observation digest -> execution proof digest.
- Cross-attempt chain: one `operationId`, distinct attempt/run IDs, and explicit predecessor proof digests.
- Terminal classes: `PREFLIGHT_REJECTED`, `SUCCEEDED`, `FAILED`, and launcher-owned `INTERRUPTED_UNKNOWN`.

- [ ] **Step 1: Write failing acyclic proof tests**

```js
assert.equal("executionProofDigest" in postStateObservation, false);
assert.equal(executionProof.postStateObservationDigest, digest(postStateObservation));
assert.equal(replay.predecessorExecutionProofDigest, digest(applyProof));
```

Also prove that generating the same deterministic plan twice yields the same digest even when wall-clock time differs.

- [ ] **Step 2: Implement phase-specific proof builders**

`dry-run`, `apply`, and `replay/reconcile` each emit their own proof. Apply re-reads facts and recomputes the plan under the registered lock/transaction or CAS boundary; a changed digest returns `PLAN_CHANGED_SINCE_APPROVAL` before writes.

- [ ] **Step 3: Implement interruption reconciliation**

If the launcher loses the Runner after a possibly committed transaction, record `INTERRUPTED_UNKNOWN`. Block a new apply for that idempotency key. Permit only the registered reconcile/replay command with the same operation ID, baseline Manifest, prior plan digest, and available post-state facts.

- [ ] **Step 4: Implement content-addressed custody and readback**

Upload canonical evidence using its digest as the immutable object identity, read it back, recompute the digest, and write a custody receipt before database cleanup or Release aggregation. Enforce the 180-day default and redact prohibited fields before upload.

- [ ] **Step 5: Test failed upload and overwrite attempts**

Expected: cleanup remains blocked when upload/readback fails; a second different payload at the same digest key is refused; failed and UNKNOWN proofs use the same retention/access policy as successful proofs.

- [ ] **Step 6: Commit proof and custody support**

```powershell
pnpm --filter @subscription-saas/release-foundation test
pnpm --filter @subscription-saas/release-runner test
git diff --check
git add packages/release-foundation apps/release-runner scripts/release docs/operations release/contracts
git commit -m "build: add release proof custody chain"
```

---

### Task 10: Build the sanitized snapshot upgrade chain

**Files:**

- Create: `release/contracts/schemas/sanitization-contract.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-metadata.v1.schema.json`
- Create: `release/contracts/schemas/ownership-map.v1.schema.json`
- Create: `release/contracts/sanitization-contract.v1.json`
- Create: `release/contracts/snapshot-ownership-map.v1.json`
- Create: `packages/release-foundation/src/snapshot/export-sanitized.mjs`
- Create: `packages/release-foundation/src/snapshot/restore-sanitized.mjs`
- Create: `packages/release-foundation/src/snapshot/normalize-ownership.mjs`
- Create: `packages/release-foundation/src/snapshot/scan-artifact.mjs`
- Create: `packages/release-foundation/test/snapshot-chain.integration.test.mjs`
- Create: `scripts/release/export-sanitized-snapshot.mjs`
- Create: `scripts/release/restore-sanitized-snapshot.mjs`
- Create: `.github/workflows/sanitized-snapshot.yml`
- Create: `docs/operations/stage1-s1-sanitized-snapshot.md`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Protected export input: a secret reference inside the `stage1-snapshot-export` environment; raw Staging data never becomes an ordinary CI artifact.
- Immutable output: sanitized dump, source migration head, tool versions, sanitization contract digest, scan result, ownership map digest, creation/expiry metadata, owner, access policy, and artifact digest.
- Restore profiles: provision/restore first, then migration, verify, and runtime-equivalent test; no profile is reused.
- Export and restore are trusted-launch/source-executor infrastructure actions, not Runner capability commands. They cannot issue a build proof, Environment Manifest, or Runner execution proof.

- [ ] **Step 1: Write failing sanitization and expiry tests**

Test known phone numbers, identity numbers, access tokens, URLs containing credentials, and secret-shaped strings. Expired metadata, failed scans, missing owner/review dates, a changed contract digest, or an unknown source migration head must be rejected.

- [ ] **Step 2: Implement protected export and deterministic metadata**

The protected source executor applies the versioned field transformations before export, scans the final artifact, computes its digest, and publishes only the immutable sanitized artifact and evidence. Timestamp provenance is recorded but does not alter build identity.

- [ ] **Step 3: Restore without source ownership**

The trusted launcher grants the one-use restore executor audited temporary membership in the target migration role. Run `pg_restore --no-owner --no-acl` under `SET ROLE migration_role` so the approved Schema, tables, sequences, functions, types, and `_prisma_migrations` are created directly under the migration owner. Apply only the versioned owner-map normalizations and prove the runtime-equivalent test role owns no restored object.

- [ ] **Step 4: Revoke restore access before migration**

After normalization, revoke/expire the restore credential, prove it can no longer connect, then execute forward migrations with the migration profile. Do not use a cross-target superuser or temporarily grant ownership to the runtime test role.

- [ ] **Step 5: Run the snapshot chain and its database suites**

```powershell
node scripts/release/run-source-database-gate.mjs --chain snapshot --snapshot-metadata-file .release-inputs/snapshot-metadata.json
```

Expected: every suite marked `snapshot: required` executes; each excluded suite carries its approved N/A reference; Schema diff is zero; server version, source/head migration catalogs, ownership inventory, sanitization scan, and count equation are present in source-gate evidence.

- [ ] **Step 6: Commit the snapshot chain**

```powershell
pnpm --filter @subscription-saas/release-foundation test
git diff --check
git add release/contracts packages/release-foundation scripts/release .github/workflows/sanitized-snapshot.yml docs/operations
git commit -m "ci: verify sanitized snapshot upgrades"
```

---

### Task 11: Inventory API runtime governance files, commands, and callers

**Files:**

- Create: `release/contracts/api-runtime-governance-inventory.v1.json`
- Create: `release/contracts/schemas/api-runtime-governance-inventory.v1.schema.json`
- Create: `release/contracts/api-runtime-allowlist.v1.json`
- Create: `scripts/release/generate-api-governance-inventory.mjs`
- Create: `scripts/release/verify-api-governance-inventory.mjs`
- Create: `scripts/release/api-governance-inventory.test.mjs`
- Create: `docs/operations/stage1-s1-api-governance-inventory.md`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- File view: `imagePath -> repositorySource -> dependent commands/runtime consumers -> disposition`.
- Command view: `entrypoint -> complete dependency closure -> package/CI/Compose/Runbook/external/manual callers -> runnerCommandId@version -> migration owner`.
- Dispositions: `application-runtime`, `runner-only`, `source-test-only`, or `retire-after-caller-migration`.

- [ ] **Step 1: Write a failing inventory completeness test**

Parse every `COPY` source and destination in `Dockerfile.api`, every root/API package script, all workflow and Compose commands, and repository Runbook command blocks. Assert each detected governance file and executable entry is represented in both directions.

```js
assert.deepEqual(inventoryImagePaths.sort(), dockerfileGovernancePaths.sort());
assert.deepEqual(inventoryEntrypoints.sort(), discoveredEntrypoints.sort());
```

- [ ] **Step 2: Generate the baseline and review all 25 current script copies**

The generated machine file must preserve shared dependency relationships instead of assuming one copied file equals one command. Record external automation owner/sign-off status and manual emergency entry closure separately; startup logs are supplemental evidence only.

- [ ] **Step 3: Classify source-only assets as formally non-executable**

For a `source-test-only` file, assert it is absent from API runtime, absent from Release/Staging package scripts and Runbooks, and executable in formal environments only through a registered Runner adapter. During transition, only one write entry may receive a capability credential.

- [ ] **Step 4: Add the API runtime allowlist contract**

List application modules, Prisma Client runtime artifacts, generated client files, migrations needed only for identity/readiness if approved, and static assets that may remain. Explicitly forbid `/app/scripts`, Prisma CLI executables, `psql`, and governance package entrypoints.

- [ ] **Step 5: Commit inventory before changing the image**

```powershell
node scripts/release/generate-api-governance-inventory.mjs --check
node scripts/release/verify-api-governance-inventory.mjs
node --test scripts/release/api-governance-inventory.test.mjs
git diff --check
git add release/contracts scripts/release docs/operations
git commit -m "docs: inventory api governance runtime"
```

---

### Task 12: Register verify, migration, and evidence commands

**Files:**

- Create: `apps/release-runner/src/commands/db-migrate-deploy.mjs`
- Create: `apps/release-runner/src/commands/db-schema-verify.mjs`
- Create: `apps/release-runner/src/commands/stage1-acceptance-target-verify.mjs`
- Create: `apps/release-runner/src/commands/stage1-task9-preflight.mjs`
- Create: `apps/release-runner/src/commands/stage1-billing-maintenance-evidence.mjs`
- Create: `apps/release-runner/test/verify-migrate-evidence.integration.test.mjs`
- Modify: `apps/release-runner/src/command-registry.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`

**Interfaces:**

- Consumes: a trusted launch request, the matching complete build proof, an allowed execution scope, one exact capability credential, and one target baseline Manifest.
- Produces: command-specific observations and proofs using the shared Task 9 envelope; no adapter may accept an arbitrary module or SQL path.

**Registered commands:**

| Command                                 | Capability | Impact                                    | Approval                                        |
| --------------------------------------- | ---------- | ----------------------------------------- | ----------------------------------------------- |
| `db.migrate.deploy@1`                   | `migrate`  | DDL                                       | `ci-policy` on ephemeral CI; `human` on Staging |
| `db.schema.verify@1`                    | `verify`   | read-only                                 | `none`                                          |
| `stage1.acceptance.target.verify@1`     | `verify`   | read-only                                 | `none`                                          |
| `stage1.task9.preflight@1`              | `verify`   | read-only                                 | `none`                                          |
| `stage1.billing-maintenance.evidence@1` | `evidence` | read-only plus controlled artifact output | `none`                                          |

- [ ] **Step 1: Write failing registry and profile tests**

Assert exact command versions, single profiles, environment policies, timeout/lock declarations, evidence Schemas, and no application RBAC permission lookup. A `migration-schema` request may omit Web startup but must reference the same complete build proof as `full-rc`.

- [ ] **Step 2: Adapt existing modules behind closed commands**

Reuse the existing target validator, Task9 governance, migration checksum, and billing evidence core logic as library calls. Runner code must not spawn `node scripts/<file>` or accept an arbitrary path.

- [ ] **Step 3: Implement migration plan/apply semantics**

Dry-run records current migration head, pending ordered migrations, migration catalog digest, expected object owner, and expected Schema result. Apply acquires the registered migration lock, re-reads/recomputes the plan, refuses digest drift, then invokes the pinned Prisma CLI. Post-state records migration head, checksums, Schema diff, ownership, and actual tool versions.

- [ ] **Step 4: Prove read-only commands cannot mutate**

Run `db.schema.verify`, target verify, Task9 preflight, and billing evidence with a read-only transaction plus statement logging. Expected: zero DDL/DML statements and no credential capable of writes.

- [ ] **Step 5: Exercise both capability scopes with the Runner image**

```powershell
node scripts/release/trusted-launch-runner.mjs --scope migration-schema --command db.schema.verify@1 --request-file .release-inputs/schema-verify.json
node scripts/release/trusted-launch-runner.mjs --scope full-rc --command stage1.acceptance.target.verify@1 --request-file .release-inputs/target-verify.json
```

Expected: both use the same build proof; only `full-rc` requires all three deployed image observations.

- [ ] **Step 6: Commit the first closed command set**

```powershell
pnpm --filter @subscription-saas/release-runner test
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
git add apps/release-runner release/contracts
git commit -m "build: register release verify and migrate commands"
```

---

### Task 13: Move clean-acceptance baseline behavior behind one repair command

**Files:**

- Create: `apps/release-runner/src/commands/stage1-clean-acceptance-baseline.mjs`
- Create: `apps/release-runner/test/clean-acceptance-baseline-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.clean-acceptance.baseline.v1.json`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-clean-acceptance-baseline-core.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-executor.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-snapshot.mjs`

**Interfaces:**

- Command: `stage1.clean-acceptance.baseline@1`.
- Capability: `repair`; environments: ephemeral acceptance and approved Staging only; approval mode: `ci-policy` for ephemeral, `human` for Staging.
- Plan binds exact target identities, expected per-table writes, baseline values, postconditions, lock order, and idempotency key.

- [ ] **Step 1: Freeze a normalized behavior contract from the old entry**

Normalize target rows, per-table inserts/updates/deletes, domain audit records, exit classification, and postconditions. Exclude Runner proof-envelope fields and wall-clock provenance from the equivalence comparison.

- [ ] **Step 2: Write RED equivalence tests on two independent databases**

Restore the same fixture into database A and B. Execute the old entry on A and the Runner adapter on B, then compare normalized results. Never run both write paths sequentially against one database.

- [ ] **Step 3: Implement deterministic dry-run and locked apply**

Refactor only enough core logic to expose pure plan computation and controlled execution. Apply recomputes the plan under the current lock/transaction boundary and refuses TOCTOU drift. Replay must produce no duplicate side effects.

- [ ] **Step 4: Add failure, cancellation, and UNKNOWN recovery cases**

Inject faults before writes, before commit, after commit/before proof, and during evidence custody. Expected behavior must match the normalized error classes and the Task 9 recovery state machine.

- [ ] **Step 5: Commit the clean-acceptance adapter**

```powershell
pnpm --filter @subscription-saas/release-runner test -- clean-acceptance
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
git add apps/release-runner scripts/stage1-clean-acceptance-* release/contracts
git commit -m "build: migrate clean acceptance repair command"
```

---

### Task 14: Move active facts, period, and segment repairs behind Runner adapters

**Files:**

- Create: `apps/release-runner/src/commands/stage1-active-source-facts-repair.mjs`
- Create: `apps/release-runner/src/commands/stage1-period-backfill.mjs`
- Create: `apps/release-runner/src/commands/subscription-segment-bootstrap.mjs`
- Create: `apps/release-runner/test/active-facts-period-segment-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.active-source-facts.repair.v1.json`
- Create: `release/contracts/command-contracts/stage1.period.backfill.v1.json`
- Create: `release/contracts/command-contracts/subscription.segment.bootstrap.v1.json`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-active-source-facts-repair-core.mjs`
- Modify: `scripts/stage1-active-source-facts-repair-executor.mjs`
- Modify: `scripts/stage1c-period-backfill-core.mjs`
- Modify: `scripts/stage1c-period-backfill-executor.mjs`
- Modify: `scripts/subscription-segment-bootstrap-core.mjs`

**Interfaces:**

- Consumes: one approved deterministic repair plan, exact target identities, and a single `repair` credential.
- Produces: normalized domain-impact results plus post-state/execution proofs compatible with the frozen v1 command contracts.

**Registered commands:**

- `stage1.active-source-facts.repair@1`
- `stage1.period.backfill@1`
- `subscription.segment.bootstrap@1`

- [ ] **Step 1: Add three normalized command contracts**

For each command, freeze its input Schema, target selection, per-table impact, current lock/transaction boundary, idempotency behavior, audit output, timeout/cancel behavior, postconditions, and allowed environments. Any later semantic change requires a new command version.

- [ ] **Step 2: Write independent-database equivalence tests**

Use matched fixture pairs for dry-run, apply, second apply, replay, and stale-plan cases. Compare normalized table facts and audits rather than stdout bytes.

- [ ] **Step 3: Implement adapters using shared core modules**

The adapters own proof/approval/credential handling; the existing core modules retain business selection and mutation semantics. Do not introduce a generalized SQL executor.

- [ ] **Step 4: Prove capability and environment separation**

Each execution receives only `repair`; no migration or provision privilege is present. A command policy mismatch must fail before its database secret is read.

- [ ] **Step 5: Fault-inject commit ambiguity and reconcile**

For each command, simulate process loss after a database commit but before proof output. Expected: launcher records UNKNOWN, repeated apply is refused, and same-key reconcile observes the committed facts without duplicates.

- [ ] **Step 6: Commit the three adapters**

```powershell
pnpm --filter @subscription-saas/release-runner test -- active-facts-period-segment
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
git add apps/release-runner scripts/stage1-active-source-facts-* scripts/stage1c-period-* scripts/subscription-segment-* release/contracts
git commit -m "build: migrate stage1 fact repair commands"
```

---

### Task 15: Move return, invalid-order, and contract-change maintenance behind Runner adapters

**Files:**

- Create: `apps/release-runner/src/commands/stage1-return-closure-backfill.mjs`
- Create: `apps/release-runner/src/commands/stage1-invalid-test-order-retire.mjs`
- Create: `apps/release-runner/src/commands/stage1-contract-change-bootstrap.mjs`
- Create: `apps/release-runner/test/return-retirement-bootstrap-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.return-closure.backfill.v1.json`
- Create: `release/contracts/command-contracts/stage1.invalid-test-order.retire.v1.json`
- Create: `release/contracts/command-contracts/stage1.contract-change.bootstrap.v1.json`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-return-closure-backfill-core.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-core.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-executor.mjs`
- Modify: `scripts/stage1-contract-change-bootstrap-core.mjs`

**Interfaces:**

- Consumes: exact order/vehicle/Closure identities and expected versions from the approved plan; it never accepts a broad status predicate as authorization.
- Produces: idempotent retirement/backfill/bootstrap facts and command-specific proof output; the contract-change command is non-Staging by policy.

**Registered commands:**

- `stage1.return-closure.backfill@1`
- `stage1.invalid-test-order.retire@1`
- `stage1.contract-change.bootstrap@1`

- [ ] **Step 1: Freeze and test normalized semantics on paired databases**

Cover exact target order IDs, vehicle-release changes, Closure source facts, audit records, no-op replays, and all existing safety refusals. Preserve the distinction between a test-order retirement and a general-purpose order deletion tool.

- [ ] **Step 2: Make contract-change bootstrap non-Staging by default**

Its v1 registry entry allows only ephemeral CI/development fixture databases and explicitly prohibits Staging/Production. A future need to run it against an existing valid order requires a separately approved command version and is outside S1.

- [ ] **Step 3: Implement deterministic plans and CAS/lock revalidation**

Bind every plan to exact record identities and expected versions/states. Apply re-reads all selected records; any change in ownership, lifecycle, bill, vehicle, or Closure facts changes the plan digest and refuses execution.

- [ ] **Step 4: Prove replay and UNKNOWN reconciliation**

Run apply twice, then inject after-commit loss and reconcile with the original idempotency key. Expected: no repeated vehicle release, duplicate Closure, duplicate audit, or repeated invalid-order retirement.

- [ ] **Step 5: Update the caller inventory but retain old entries until Task 16**

Mark every command's Runner equivalence evidence and caller-migration readiness. Do not remove old API image copies or package scripts in this task.

- [ ] **Step 6: Commit the final S1 repair adapters**

```powershell
pnpm --filter @subscription-saas/release-runner test -- return-retirement-bootstrap
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
git add apps/release-runner scripts/stage1-return-* scripts/stage1-staging-invalid-* scripts/stage1-contract-change-* release/contracts
git commit -m "build: migrate remaining stage1 maintenance commands"
```

---

### Task 16: Switch callers and remove governance tooling from the API runtime

**Files:**

- Modify: `Dockerfile.api`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `apps/api/test/api-runtime-media.spec.ts`
- Modify: `docker-compose.staging.example.yml`
- Modify: `docker-compose.staging.images.example.yml`
- Modify: `.env.staging.example`
- Modify: `.env.staging.images.example`
- Modify: `docs/deployment.md`
- Modify: `docs/image-registry-deployment.md`
- Modify: `docs/staging-deployment-runbook.md`
- Modify: `docs/runbooks/stage1-clean-staging-acceptance-database-rollout.zh-CN.md`
- Modify: `docs/runbooks/stage1-active-term-contract-change-release.md`
- Modify: `scripts/stage1-clean-acceptance-runbook-contract.test.mjs`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `release/contracts/api-runtime-allowlist.v1.json`
- Create: `scripts/release/verify-api-runtime-image.mjs`
- Create: `scripts/release/api-runtime-negative.test.mjs`

**Interfaces:**

- Formal operational entry: trusted launcher plus registered `runner execute` command; direct `node scripts/*.mjs` is no longer a supported Release/Staging entry.
- API image: application server plus Prisma Client and approved runtime assets only.
- Rollback: application-image rollback is allowed only with explicit proof that the old API is compatible with the currently applied Schema; database restore remains an independently approved last resort.

- [ ] **Step 1: Prove every caller has a migration disposition**

Run the inventory against package scripts, CI, Compose, deployment configuration, both listed Runbooks, external automation sign-offs, and manual operation records. Refuse extraction while any caller is `unowned`, `unknown`, or still invokes an API-container script.

- [ ] **Step 2: Change formal package and Runbook entries to the trusted launcher**

Replace direct write commands with fixed wrappers that select an exact registered command and request file. Do not keep a generic `runner:exec` package script or an emergency API-container back door.

```json
{
  "stage1:clean-acceptance:dry-run": "node scripts/release/trusted-launch-runner.mjs --command stage1.clean-acceptance.baseline@1 --phase dry-run --request-file .release-inputs/clean-acceptance.json"
}
```

- [ ] **Step 3: Add RED API-runtime negative tests**

```ts
expect(await imagePathExists("/app/scripts")).toBe(false);
expect(await imageCommandWorks("prisma", ["--version"])).toBe(false);
expect(await imageCommandWorks("psql", ["--version"])).toBe(false);
expect(await apiCanQueryCatalog()).toBe(true);
```

Also compare the final filesystem/SBOM to `api-runtime-allowlist.v1.json`; renaming a forbidden tool must not bypass the gate.

- [ ] **Step 4: Remove copied governance files and non-runtime CLIs**

Delete all governed script `COPY` rules from `Dockerfile.api`, install/copy the production dependency closure without Prisma CLI, and keep generated Prisma Client runtime files. Migrations execute only through the matching Runner image.

- [ ] **Step 5: Verify caller cutover and old-entry denial**

Build the API and Runner images. Expected: every registered command succeeds through Runner equivalence tests; the API image cannot execute old commands; old entries cannot obtain any active capability credential; no deployment config mounts repository scripts into API.

- [ ] **Step 6: Validate the rollback matrix**

Document and test four classes: no database change/safe stop, known result/reconcile, compatible API-only rollback, and last-resort database restore with stopped writes and an approved loss window. Never rewrite or reverse an applied migration.

- [ ] **Step 7: Commit API runtime extraction**

```powershell
node scripts/release/verify-api-governance-inventory.mjs
node --test scripts/release/api-runtime-negative.test.mjs scripts/stage1-clean-acceptance-runbook-contract.test.mjs
pnpm --filter @subscription-saas/api test -- api-runtime-media.spec.ts
git diff --check
git add Dockerfile.api apps/api package.json docker-compose.staging* .env.staging* docs release/contracts scripts/release scripts/stage1-clean-acceptance-runbook-contract.test.mjs
git commit -m "build: remove governance tools from api runtime"
```

---

### Task 17: Produce one trusted three-image build proof

**Files:**

- Modify: `Dockerfile.api`
- Modify: `Dockerfile.web`
- Modify: `Dockerfile.runner`
- Modify: `.github/workflows/docker-images.yml`
- Create: `scripts/release/create-build-proof.mjs`
- Create: `scripts/release/verify-build-proof.mjs`
- Create: `scripts/release/verify-build-materials.mjs`
- Create: `scripts/release/build-proof.test.mjs`
- Create: `release/contracts/build-material-policy.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- `build-proof.v1.identity`: API/Web/Runner platform image digests, source SHA, migration catalog hash, repository contract digest, and Schema version.
- `build-proof.v1.provenance`: generation time, protected CI run/attestation references, resolved base-image digests, builder identity, and pinned workflow materials.
- Trust root: the protected final aggregation job, outside Runner, signs/stores the proof; Runner only verifies it against trusted-launch observations.

- [ ] **Step 1: Add failing proof and material tests**

Reject a tag in an identity field, a digest not resolved from the registry, different source revisions across images, a mutable external action reference not allowed by policy, missing base-image provenance, and a proof produced by a PR-only workflow.

- [ ] **Step 2: Put the OCI source revision in all three images**

Pass one fixed checkout SHA to API, Web, and Runner builds. Verify `org.opencontainers.image.revision` from registry-pulled images and ensure it equals the build-proof source SHA.

- [ ] **Step 3: Build three images in one trusted build run**

The workflow may build in parallel, but a protected aggregate job must read the actual platform digests from the registry and refuse any artifact from another checkout or run. Tags are discovery metadata only.

```yaml
needs: [build-api, build-web, build-runner]
```

- [ ] **Step 4: Generate identity and provenance externally**

The aggregate job computes migration and repository contract digests from the fixed checkout, records resolved base images/actions/builders, constructs `build-proof.v1`, validates it, and places it in trusted content-addressed storage. Runner must not issue or sign this proof.

- [ ] **Step 5: Enforce bundle immutability and scoped execution**

A Runner-only fix requires a new trusted build run and new three-image bundle. `migration-schema` may start only API Schema dependencies and Runner, but it still cites the unmodified complete proof and cannot become a promotable partial Release.

- [ ] **Step 6: Commit the trusted build workflow**

```powershell
node --test scripts/release/build-proof.test.mjs
node scripts/release/verify-build-materials.mjs --workflow .github/workflows/docker-images.yml
git diff --check
git add Dockerfile.api Dockerfile.web Dockerfile.runner .github/workflows/docker-images.yml scripts/release release/contracts
git commit -m "ci: build immutable api web runner bundle"
```

---

### Task 18: Verify digest-pinned final artifacts with Compose and a real client

**Files:**

- Create: `docker-compose.release-gate.yml`
- Create: `playwright.release.config.ts`
- Create: `tests/release/web-public-api.spec.ts`
- Create: `scripts/release/run-final-compose-gate.mjs`
- Create: `scripts/release/verify-compose-policy.mjs`
- Create: `scripts/release/compose-policy.test.mjs`
- Create: `release/contracts/schemas/final-compose-evidence.v1.schema.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Compose inputs: registry-resolved API/Web/Runner digests, one build-proof digest, one chain-specific baseline Manifest, and chain-specific exact database identities.
- Fresh and snapshot runs use distinct `operationId`, run ID, Manifest, database, and execution proofs.
- Web gate: HTTP health first, then Playwright 1.62.1 executing the built client's request logic and capturing the actual API request target.

- [ ] **Step 1: Add exact Playwright and policy dependencies**

Pin `@playwright/test` and the test image/runtime to 1.62.1. Add a policy test that rejects Compose `build`, source mounts, mutable image tags, Docker socket mounts, entrypoint/command override, privileged mode, or a supported exec path.

- [ ] **Step 2: Define capability-separated final Compose jobs**

Provision/restore prepares the target, migration applies the catalog, verify performs catalog/Schema checks, API starts with its runtime identity, and database tests use runtime-equivalent identities. Runner is never started with all profiles at once and is not a resident service.

- [ ] **Step 3: Prove API database readiness through a real query**

After process health, call `GET /api/portal/catalog/model-definitions` through the API service and assert a valid response from the expected database identity. A listening port without a successful database-backed query is not ready.

- [ ] **Step 4: Exercise Web's actual public API request path**

```ts
test("built portal calls the manifest API base", async ({ page }) => {
  const requests: string[] = [];
  const expectedCatalogUrl = new URL(
    "portal/catalog/model-definitions",
    `${manifest.publicApiBase}/`
  ).toString();
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${webBase}/portal/catalog`);
  await expect(page.getByText(/车型|model/i)).toBeVisible();
  expect(requests).toContain(expectedCatalogUrl);
});
```

Compare the captured origin/path, Web-bundle embedded API Base, and Manifest value. Also prove CORS and route prefix work. Visual and full business acceptance remain S3.

- [ ] **Step 5: Run independent fresh and snapshot gates**

```powershell
node scripts/release/run-final-compose-gate.mjs --chain fresh --build-proof-file .release-inputs/build-proof.json
node scripts/release/run-final-compose-gate.mjs --chain snapshot --build-proof-file .release-inputs/build-proof.json --snapshot-metadata-file .release-inputs/snapshot-metadata.json
```

Expected: both use the same image digests/source/contracts but have separate target identities, Manifests, operation IDs, post-state observations, execution proofs, custody receipts, and complete test counts.

- [ ] **Step 6: Test legal retry semantics**

Force an infrastructure failure before database writes, retain its proof, and rerun the complete failed stage with a new run/operation ID against the same immutable bundle. Reject replacement images, overwritten proof, or aggregation across different snapshot/test-contract versions.

- [ ] **Step 7: Commit final-artifact verification**

```powershell
pnpm exec playwright test --config playwright.release.config.ts
node --test scripts/release/compose-policy.test.mjs
node scripts/release/verify-compose-policy.mjs docker-compose.release-gate.yml
git diff --check
git add docker-compose.release-gate.yml playwright.release.config.ts tests/release scripts/release release/contracts package.json pnpm-lock.yaml
git commit -m "ci: verify final release bundle end to end"
```

---

### Task 19: Aggregate Release evidence and audit S1 exit criteria

**Files:**

- Create: `scripts/release/aggregate-release-proof.mjs`
- Create: `scripts/release/aggregate-release-proof.test.mjs`
- Create: `scripts/release/audit-s1-exit.mjs`
- Create: `scripts/release/audit-s1-exit.test.mjs`
- Create: `.github/workflows/release-candidate-gate.yml`
- Create: `docs/operations/stage1-s1-release-candidate-gate.md`
- Create: `docs/acceptance/2026-09-02-stage1-s1-exit-evidence.md`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`

**Interfaces:**

- Release aggregate references source-gate evidence plus fresh and snapshot final-artifact execution proofs whose source SHA, migration catalog, repository contract, test manifest, PostgreSQL image contract, and sanitized snapshot version agree.
- A successful aggregate proves S1 technical readiness only. It does not promote Staging, approve S2/S3, or declare Stage 1 business acceptance complete.

- [ ] **Step 1: Write failing cross-proof consistency tests**

Reject mixed source SHAs, replacement image digests, mismatched migration or repository contracts, differing test manifests, expired snapshot evidence, incomplete custody receipts, partial bundles, count-equation failures, and an unclassified S1 P1.

- [ ] **Step 2: Assemble the five-stage Release workflow**

1. Source static/unit gate.
2. Source fresh/snapshot database gate producing source-gate evidence.
3. Trusted three-image build and build proof.
4. Final Runner fresh/snapshot Compose executions and client gate.
5. External Release proof aggregation and S1 exit audit.

Stage 2 source evidence is not an execution proof; Stage 4 must repeat equivalent migration, Schema, database-test, and final-image checks with the final Runner.

- [ ] **Step 3: Enforce evidence selection and custody before aggregation**

Select one internally consistent successful proof set from the same immutable inputs. Preserve failed/UNKNOWN attempts. A retry may replace only the selected attempt proof, not mutate the bundle or erase history.

- [ ] **Step 4: Implement the S1 exit audit**

The audit must verify:

- database discovery has zero unclassified candidates and the complete execution equation passes on both chains;
- Postgres 17 digest/version, role separation, exact cleanup, and snapshot ownership/sanitization evidence pass;
- Runner proof/capability/approval/TOCTOU/UNKNOWN/custody contracts pass;
- all current API-image governance files and command callers have migrated or have an approved non-executable disposition;
- API runtime negative allowlist/SBOM and real database readiness pass;
- one build proof covers API/Web/Runner; final Compose and real-client API-base checks pass;
- no S1 change adds business models, enums, RBAC permissions, migrations, feature flags, customer/API/domain semantic changes, or S2/S3 behavior.

- [ ] **Step 5: Run the complete local/pre-merge verification set**

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
pnpm prisma:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @subscription-saas/release-foundation test
pnpm --filter @subscription-saas/release-runner test
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
node scripts/release/verify-compose-policy.mjs docker-compose.release-gate.yml
node scripts/release/audit-s1-exit.mjs --evidence-dir .release-evidence
git diff --check
```

Expected: no pending migration or Schema drift, all tests and builds pass, both chain evidence sets are in trusted custody, and the exit audit reports no P0/P1. If the configured database identity is unknown, stop instead of claiming the migration check passed.

- [ ] **Step 6: Commit the aggregate gate and publish the review report**

```powershell
git add .github/workflows/release-candidate-gate.yml scripts/release release/contracts docs/operations docs/acceptance
git commit -m "ci: aggregate stage1 s1 release evidence"
git status --short --branch
```

Open the final S1 review with the exact source SHA, build-proof digest, API/Web/Runner digests, migration/repository/test/snapshot contract digests, proof/custody links, full test counts, API runtime inventory result, and remaining P2/non-blocking observations. Do not mark S1 complete until that review is explicitly approved.

---

## Specification Coverage Matrix

| Approved S1 requirement                                                               | Implementation tasks |
| ------------------------------------------------------------------------------------- | -------------------- |
| A+ immutable three-image bundle and external trust root                               | 1, 8, 17, 19         |
| Build identity/provenance and capability-scoped execution                             | 1, 8, 9, 12, 17      |
| Closed command registry, one credential profile, approval policy                      | 8, 12-15             |
| Stable baseline Manifest, deterministic plans, TOCTOU, UNKNOWN recovery               | 8, 9, 12-15          |
| Content-addressed proof custody and 180-day governance                                | 9, 10, 19            |
| Database discovery universe, independent databases, least-privilege roles, zero skips | 2-7                  |
| PostgreSQL 17 fresh and sanitized snapshot upgrade chains                             | 3, 7, 10, 18, 19     |
| Snapshot sanitization, ownership normalization, expiry, and scanning                  | 10                   |
| Bidirectional API tooling inventory and behavior equivalence                          | 11-15                |
| API runtime extraction and negative allowlist                                         | 16                   |
| Final digest-pinned Compose, database readiness, real Web/API request                 | 18                   |
| Release aggregation, retry rules, and S1 exit audit                                   | 19                   |

## Stop and Rollback Rules

| Condition                                                                                         | Required response                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending migration, Schema drift, unknown database/cluster identity, or dirty overlapping worktree | Stop before the task; do not mutate the target                                                                                                     |
| A task exceeds the approved size bound or reveals a new business semantic decision                | Split the task and obtain plan/spec approval                                                                                                       |
| Proof/digest/target/capability mismatch                                                           | Fail before credential read or database connection; launcher records `PREFLIGHT_REJECTED`                                                          |
| Approved plan changes before apply                                                                | Refuse apply with `PLAN_CHANGED_SINCE_APPROVAL`; repeat dry-run and approval                                                                       |
| Process loss with uncertain commit                                                                | Record `INTERRUPTED_UNKNOWN`; forbid new apply; reconcile with the same idempotency key                                                            |
| Evidence custody upload/readback failure                                                          | Keep the database and evidence workspace; do not aggregate or clean up                                                                             |
| Final gate failure caused by infrastructure                                                       | Preserve failure proof; rerun the complete failed stage with a new operation/run ID against the same bundle                                        |
| Image or contract input must change                                                               | Invalidate the attempted Release set and produce a new trusted build proof                                                                         |
| API rollback requested after migration                                                            | Allow only with compatibility proof; database restore requires stopped writes, verified restore, explicit loss window, and separate human approval |

## S1 Completion Boundary

S1 is ready for approval only after Task 19 produces a successful, reviewable evidence set and the S1 exit review is explicitly approved. That approval permits the subsequent S2 specification/planning decision under the main ADR. It does not itself deploy Staging, promote a Release Candidate, create the S3 mature-order fixture, or begin Stage 1 human acceptance.
