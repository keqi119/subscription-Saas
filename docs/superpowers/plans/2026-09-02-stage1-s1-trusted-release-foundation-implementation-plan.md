# Stage 1 S1 Trusted Release Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved S1 trusted release foundation: isolated PostgreSQL 17 database tests with zero skips, an immutable API/Web/Runner release bundle, capability-scoped Runner execution and proofs, a sanitized snapshot upgrade chain, final-artifact Compose verification, and removal of governance tooling from the API runtime.

**Architecture:** Keep one repository and one fixed source SHA, but separate three responsibilities: source-gate execution before image build, a one-shot closed-command Runner for candidate and long-lived environments, and an external trusted launcher/CI trust root. Store versioned contracts under `release/contracts`, share canonicalization and proof logic through a focused release-foundation package, and promote only a complete three-image bundle whose fresh and snapshot proofs agree with the source gate.

**Tech Stack:** Node.js 22, pnpm 11.4.0, Node ESM and `node:test`, TypeScript/Vitest, Prisma 7.8, PostgreSQL 17, Docker Buildx/Compose, GitHub Actions and artifact attestations, Ajv 8.20.0, `canonicalize` 4.0.0, Playwright 1.62.1.

**Spec:** `docs/superpowers/specs/2026-09-01-stage1-s1-trusted-release-foundation-and-test-isolation-design.zh-CN.md` at approved baseline `ee9ca6bca41ef3b8ec1403b584b45705301ec5b5`.

## Global Constraints

- Start implementation in a new isolated worktree from a `main` commit that already contains the approved ADR, S0 specification, S1 specification, and this plan. Do not implement on the documentation worktree.
- Before every implementation task run `git status --short` and stop on unrelated overlapping changes. Database preflight is phase-specific: Task 0 creates the controlled target; Tasks 1-2 are offline and must not read `DATABASE_URL`, repository `.env`, or connect to PostgreSQL; Task 3 and every later database-aware task run Prisma status/validation only through `scripts/release/with-controlled-target.mjs` and the Task 0 target record. Never run Prisma against an ambient connection.
- S1 adds no business model, business enum, application RBAC permission, business migration, or feature flag. It must not change customer-visible behavior, application API contracts, domain semantics, audit semantics, lock order, or business transaction boundaries.
- Never edit an applied migration. S1 may read, hash, copy into the Runner image, and execute the existing migration catalog only.
- PostgreSQL release tests use a digest-pinned PostgreSQL 17 image and record `server_version_num`. A suite or shard gets its own database by default; Schema-only isolation requires a separately approved proof and is not part of this plan.
- Database test release evidence must satisfy `collected = selected = executed = passed + failed`, with `failed=0`, `skipped=0`, `todo=0`, `filtered=0`, and `cancelled=0`.
- From Task 2 onward, every task that adds or renames a tracked test/spec file runs `node scripts/release/discover-database-tests.mjs --mode verify`; each newly discovered candidate must enter the manifest or an approved exception in the same commit.
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
- Every task is a separate review/commit boundary. Do not combine adjacent database-suite, command-adapter, proof, snapshot, build, or final-gate tasks merely to reduce PR count. Stop if a task exceeds approximately 1,500 production lines or 25 production files and split it for approval.
- S2 and S3 remain blocked. This plan does not create the S3 mature-order fixture, repair Staging data, promote an RC, or run human Stage 1 acceptance.

## Delivery Topology

```text
controlled PostgreSQL baseline -> offline contract kernel
  -> full-repository database discovery -> isolated lifecycle -> evidence custody -> unified launcher -> suite migration -> source gate
  -> Runner trust boundary -> verifiable approval -> proof state machine
  -> protected snapshot export -> ownership-normalized snapshot chain
  -> API tooling inventory -> command adapters -> API runtime extraction
  -> trusted three-image build -> external build proof -> final Compose/session/browser gate -> release aggregation
```

The tasks below are minimum review units. A reviewer may split a task further, but must not merge independently rejectable commands or trust boundaries merely to reduce PR count.

## Planned File Map

| Area                 | Files and responsibility                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controlled bootstrap | `scripts/release/bootstrap-controlled-postgres.mjs`, `scripts/release/with-controlled-target.mjs`, and `.release-local/**`: prevent ambient database use during implementation                                                         |
| Repository contracts | `release/contracts/**`: proof Schemas, command registry, test discovery/manifest, target policies, PostgreSQL image identity, snapshot contracts, API runtime allowlist, retention rules, and the self-covering contract-file manifest |
| Shared release logic | `packages/release-foundation/**`: RFC 8785 wrapper, digest/catalog computation, Ajv validation, proof builders, database lifecycle, test discovery/reporting, and custody helpers                                                      |
| Runner               | `apps/release-runner/**`: closed CLI, preflight, secret-file handoff, capability profiles, command adapters, proof emission, and tests                                                                                                 |
| Source gate          | `scripts/release/**`: source-only orchestration, database suite launcher, build-proof aggregation, artifact custody confirmation, inventory generation, and policy validation                                                          |
| Images and Compose   | `Dockerfile.api`, `Dockerfile.web`, `Dockerfile.runner`, `docker-compose.release-gate.yml`, and image deployment examples                                                                                                              |
| CI                   | `.github/workflows/ci.yml`, `.github/workflows/docker-images.yml`, `.github/workflows/sanitized-snapshot.yml`                                                                                                                          |
| Final client gate    | `playwright.release.config.ts`, `tests/release/web-public-api.spec.ts`                                                                                                                                                                 |
| Operations           | `docs/operations/stage1-s1-*.md`, existing deployment Runbooks, and machine-generated evidence summaries                                                                                                                               |

---

### Task 0: Establish an offline-safe controlled PostgreSQL 17 implementation baseline

**Files:**

- Create: `release/contracts/postgres-image.v1.json`
- Create: `release/contracts/schemas/postgres-image.v1.schema.json`
- Create: `release/contracts/schemas/controlled-target-record.v1.schema.json`
- Create: `scripts/release/bootstrap-controlled-postgres.mjs`
- Create: `scripts/release/with-controlled-target.mjs`
- Create: `scripts/release/bootstrap-controlled-postgres.test.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `bootstrapControlledPostgres(input): Promise<ControlledTargetRecord>` and `runWithControlledTarget(input): Promise<number>`.
- `ControlledTargetRecord` contains `recordVersion`, source SHA, resolved PostgreSQL image digest, container ID/label, non-sensitive cluster fingerprint, exact database name/OID, role names, TLS mode, migration head, and local secret-file references; it never contains credentials or a printable URL.
- The local record lives at `.release-local/controlled-target.v1.json`, is gitignored, and is valid only while the exact container marker, database comment, OID, and secret references still match.

- [ ] **Step 1: Write RED ambient-database and exact-target tests**

```js
test("refuses ambient DATABASE_URL before Docker access", async () => {
  const docker = spyDocker();
  await assert.rejects(
    () =>
      bootstrapControlledPostgres({ environment: { DATABASE_URL: "postgres://ambient" }, docker }),
    /AMBIENT_DATABASE_URL_FORBIDDEN/
  );
  assert.equal(docker.calls.length, 0);
});

test("refuses a target record whose database oid changed", async () => {
  await assert.rejects(
    () => runWithControlledTarget({ ...fixture, actualDatabaseOid: "44" }),
    /CONTROLLED_TARGET_IDENTITY_MISMATCH/
  );
});
```

- [ ] **Step 2: Run the focused test and observe the missing bootstrap implementation**

Run: `node --test scripts/release/bootstrap-controlled-postgres.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bootstrap-controlled-postgres.mjs`.

- [ ] **Step 3: Resolve and commit the PostgreSQL 17 platform digest**

```powershell
docker buildx imagetools inspect postgres:17-bookworm
```

Write the resolved linux/amd64 platform digest, repository, tag, platform, and `serverVersionMajor: 17` to `postgres-image.v1.json`. The bootstrap rejects tag-only input and records the pulled image's actual repo digest.

- [ ] **Step 4: Implement the minimal exact-target bootstrap**

```js
export async function bootstrapControlledPostgres({
  environment,
  imageContract,
  repoRoot,
  outputDirectory,
  docker
}) {
  if (environment.DATABASE_URL) throw codeError("AMBIENT_DATABASE_URL_FORBIDDEN");
  const runId = crypto.randomUUID();
  const databaseName = `s1dev_${sha256Text(`${runId}:${repoRoot}`).slice(0, 24)}`;
  return docker.createExactTarget({
    image: `${imageContract.repository}@${imageContract.resolvedDigest}`,
    databaseName,
    runId
  });
}
```

Start one digest-pinned container with a unique `subscription-s1-controlled/v1` label. Generate one-use bootstrap, migration, verify, and runtime-test credentials into `.release-local/secrets/` with owner-only permissions. Create only the exact database and marker comment; cleanup accepts the complete record, never a prefix or glob.

- [ ] **Step 5: Implement the controlled subprocess wrapper**

`runWithControlledTarget` re-reads the container label, image digest, database comment/OID, server version, and requested role before spawning a command. It sets `STAGE1_ACCEPTANCE_MIGRATION_SKIP_DOTENV=1` and a URL assembled from the selected secret file in the child only; it removes every inherited database URL and never prints the assembled value.

- [ ] **Step 6: Deploy the current migration catalog and freeze the baseline record**

```powershell
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node scripts/release/bootstrap-controlled-postgres.mjs --output .release-local/controlled-target.v1.json
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
```

Expected: PostgreSQL reports major version 17, all migrations are applied, Prisma validation passes, and no command reads the repository `.env`.

- [ ] **Step 7: Run the negative cleanup and identity cases**

Run: `node --test scripts/release/bootstrap-controlled-postgres.test.mjs`

Expected: PASS, including wrong image digest, forged marker, changed OID, wrong role, ambient URL, prefix cleanup, and missing secret-file cases.

- [ ] **Step 8: Commit the controlled bootstrap**

```powershell
git diff --check
git add .gitignore release/contracts/postgres-image.v1.json release/contracts/schemas/postgres-image.v1.schema.json release/contracts/schemas/controlled-target-record.v1.schema.json scripts/release/bootstrap-controlled-postgres.mjs scripts/release/with-controlled-target.mjs scripts/release/bootstrap-controlled-postgres.test.mjs
git commit -m "build: add controlled postgres implementation baseline"
```

After this task, every database-aware task begins with:

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
```

If the record or target no longer matches, create a new Task 0 target and reapply the unchanged migration catalog; do not fall back to an ambient database.

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
- Consumes: only repository files and pure JSON values; it must not read environment secrets or connect to a database. The initial `repository-contract-files.v1.json` already includes Task 0's PostgreSQL image contract, PostgreSQL image Schema, and controlled-target-record Schema; later tasks extend the same manifest rather than creating parallel contract lists.

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

Obtain the repository test universe from `git ls-files`, not hard-coded directories. Include every tracked JavaScript/TypeScript file whose path is under a `test`, `tests`, or `__tests__` directory or whose basename contains a registered `test`, `spec`, `integration`, `e2e`, `postgres`, or `schema` test marker. Apply the four candidate reasons to that complete tracked set, then normalize paths to forward slashes, deduplicate reasons, reject duplicate suite IDs/files, and require every exception to include `owner`, `reason`, `scope`, and `reviewDate`.

```js
export function trackedTestUniverse(paths) {
  return paths.filter(
    (path) =>
      /(^|\/)(__tests__|tests?|specs?)(\/|$)/.test(path) ||
      /[.-](test|spec|integration|e2e(?:-spec)?|postgres|schema)\.[cm]?[jt]sx?$/.test(path)
  );
}
```

If a candidate mixes database invariants with a supplier/browser/manual dependency, the classifier must require a database-only contract suite plus a separately owned external applicability record. Missing credentials cannot suppress the database contract portion.

- [ ] **Step 3: Generate and review the real repository candidate report**

```powershell
node scripts/release/discover-database-tests.mjs --mode report --output output/s1-database-candidates.json
```

Expected: the report includes all 26 files currently listed by `apps/api/vitest.config.ts`, both conditional Node PostgreSQL test files, and any additional tracked test from `apps`, `packages`, `scripts`, or future `apps/release-runner` paths discovered by import/environment/tag rules. The command exits nonzero until every candidate is committed to the manifest or exception file.

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

- [ ] **Step 2: Re-verify the Task 0 image identity already covered by the repository contract**

Confirm that `postgres-image.v1.json`, its Schema, and `controlled-target-record.v1` remain in `repository-contract-files.v1.json`. Re-resolve the platform digest and fail on any unreviewed change; the verification command rejects a tag-only contract.

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
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add release/contracts packages/release-foundation scripts/release/run-postgres-contract-tests.mjs package.json
git commit -m "test: isolate release database identities"
```

---

### Task 4: Implement content-addressed evidence custody

**Files:**

- Create: `packages/release-foundation/src/evidence-custody.mjs`
- Create: `packages/release-foundation/test/evidence-custody.test.mjs`
- Create: `scripts/release/custody-evidence.mjs`
- Create: `scripts/release/custody-evidence.test.mjs`
- Create: `docs/operations/stage1-s1-evidence-custody.md`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `redactEvidence(value, policy): JsonValue`, `custodyEvidence(input): Promise<CustodyReceiptV1>`, and `assertCustodyComplete(receipt, expectedDigest): void`.
- A custody receipt binds subject digest, storage provider/object identity, upload/readback times, readback digest, owner, access policy, and retention-until time; database cleanup and Release aggregation consume only a verified receipt.

- [ ] **Step 1: Write RED redaction and overwrite tests**

```js
test("rejects evidence containing a raw database url", async () => {
  await assert.rejects(
    () => custodyEvidence({ ...fixture, value: { url: "postgres://u:p@db/x" } }),
    /EVIDENCE_SECRET_DETECTED/
  );
});
```

Run: `node --test packages/release-foundation/test/evidence-custody.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `evidence-custody.mjs`.

- [ ] **Step 2: Implement canonical redaction and content addressing**

Reject rather than mask raw URLs, tokens, phone numbers, customer IDs, or secret-shaped values in formal proofs. Upload the canonical allowed value under its SHA-256 subject digest with create-only semantics.

- [ ] **Step 3: Implement mandatory readback verification**

Read the stored object through the audit reader identity, recompute its digest, then write and read back the custody receipt. Cleanup remains blocked until `assertCustodyComplete` verifies both subject and receipt.

- [ ] **Step 4: Run explicit storage failure cases**

Run: `node --test scripts/release/custody-evidence.test.mjs`

Expected: PASS for upload/readback and FAIL with `EVIDENCE_OVERWRITE_REFUSED`, `EVIDENCE_READBACK_DIGEST_MISMATCH`, or `CUSTODY_RECEIPT_MISSING` in their corresponding fixtures.

- [ ] **Step 5: Verify 180-day retention and failed/UNKNOWN parity**

Test that successful, failed, and UNKNOWN records use the same owner/access/redaction policy and cannot be deleted or overwritten during the configured 180-day retention window.

- [ ] **Step 6: Run contract and discovery gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit custody before database cleanup depends on it**

```powershell
git add packages/release-foundation/src/evidence-custody.mjs packages/release-foundation/test/evidence-custody.test.mjs scripts/release/custody-evidence.mjs scripts/release/custody-evidence.test.mjs docs/operations/stage1-s1-evidence-custody.md release/contracts/repository-contract-files.v1.json
git commit -m "build: add content addressed evidence custody"
```

---

### Task 5: Create the single database-test launcher before any suite consumes it

**Files:**

- Create: `packages/release-foundation/src/database-test-launcher.mjs`
- Create: `packages/release-foundation/test/database-test-launcher.test.mjs`
- Create: `scripts/release/run-database-suite.mjs`
- Create: `scripts/release/run-database-manifest.mjs`
- Create: `scripts/release/run-source-database-gate.mjs`
- Create: `scripts/release/database-test-launcher-cli.test.mjs`
- Create: `release/contracts/schemas/database-test-manifest-report.v1.schema.json`
- Modify: `release/contracts/database-test-manifest.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `package.json`

**Interfaces:**

- Produces: `selectManifestSuites(input): SuiteExecution[]`, `runDatabaseSuite(input): Promise<DatabaseTestReportV1>`, `runDatabaseManifest(input): Promise<DatabaseManifestReportV1>`, and `runSourceDatabaseGate(input): Promise<SourceGateEvidenceV1>`.
- `run-database-suite.mjs` selects exactly one manifested suite; `run-database-manifest.mjs` selects a committed batch or all required suites for one chain; `run-source-database-gate.mjs` invokes the manifest layer and aggregates it. All three call `selectManifestSuites`; none owns another list or glob.
- Every `SuiteExecution` contains suite/manifest/discovery digests, chain, exact database assignment, migration/runtime secret references, test command/arguments, timeout, barrier, and expected count policy.

- [ ] **Step 1: Write RED selection-parity tests for all three CLIs**

```js
test("suite, manifest, and source gate share one selector", async () => {
  const suite = selectForCli("suite", fixture);
  const manifest = selectForCli("manifest", fixture);
  const sourceGate = selectForCli("source-gate", fixture);
  assert.deepEqual(
    manifest.selections.filter((item) => item.suiteId === suite.suiteId),
    [suite]
  );
  assert.deepEqual(sourceGate.selections, manifest.selections);
  assert.equal(sourceGate.manifestDigest, manifest.manifestDigest);
});
```

Run: `node --test scripts/release/database-test-launcher-cli.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `database-test-launcher.mjs`.

- [ ] **Step 2: Implement the shared manifest selector**

```js
export function selectManifestSuites({ manifest, discoveryDigest, chain, suiteIds, batchId }) {
  validateManifest(manifest);
  const selected = selectByCommittedIds(manifest, { suiteIds, batchId });
  assertChainApplicability(selected, chain);
  return selected.map((suite) => Object.freeze({ ...suite, chain, discoveryDigest }));
}
```

Reject an unknown suite/batch, unclassified test, unapproved chain exclusion, duplicate file, `.only`, fail-fast, or a caller-supplied file path.

- [ ] **Step 3: Implement one-suite execution and normalized reporting**

`runDatabaseSuite` asks the Task 3 lifecycle for an exact database, deploys migrations with the migration role, invokes only the manifested runner command with the runtime-equivalent credential, normalizes framework counts, confirms evidence custody, then performs exact cleanup.

Run: `pnpm --filter @subscription-saas/release-foundation test -- database-test-launcher.test.mjs`

Expected: PASS for a one-test fixture and fail with `DATABASE_TEST_COUNT_INCOMPLETE` when a reporter omits filtered/cancelled counts.

- [ ] **Step 4: Add only thin CLI argument adapters**

```js
// scripts/release/run-database-suite.mjs
const request = parseSuiteArgs(process.argv.slice(2));
process.exitCode = await runOneManifestedSuite(request);
```

The manifest and source-gate CLIs follow the same shape. The source-gate layer adds source SHA, migration/repository/discovery/manifest/PostgreSQL digests and per-chain aggregate counts; it does not discover files itself.

- [ ] **Step 5: Run an exact real-database fixture through each layer**

```powershell
node scripts/release/run-database-suite.mjs --suite-id release.launcher.fixture --chain fresh
node scripts/release/run-database-manifest.mjs --batch launcher-fixture --chain fresh --concurrency 1
node scripts/release/run-source-database-gate.mjs --chain fresh --batch launcher-fixture
```

Expected: the three outputs reference the same suite/manifest/discovery digests, use three distinct exact database identities, and report `collected=selected=executed=passed=1` with all other counts zero.

- [ ] **Step 6: Run contract and discovery gates**

```powershell
node scripts/release/discover-database-tests.mjs --mode verify
pnpm release:contracts:verify
node --test scripts/release/database-test-launcher-cli.test.mjs
```

Expected: the newly added release-foundation and CLI tests are either manifested database tests or explicit approved non-database exceptions; no path is silently omitted.

- [ ] **Step 7: Commit the unified launcher**

```powershell
git diff --check
git add packages/release-foundation/src/database-test-launcher.mjs packages/release-foundation/test/database-test-launcher.test.mjs scripts/release/run-database-suite.mjs scripts/release/run-database-manifest.mjs scripts/release/run-source-database-gate.mjs scripts/release/database-test-launcher-cli.test.mjs release/contracts/schemas/database-test-manifest-report.v1.schema.json release/contracts/database-test-manifest.v1.json release/contracts/repository-contract-files.v1.json package.json
git commit -m "test: add unified database test launcher"
```

---

### Task 6: Remove the two conditional Node-test skips

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
pnpm release:contracts:verify
git diff --check
git add release/test-fixtures release/contracts/database-test-manifest.v1.json packages/release-foundation scripts/stage1-clean-acceptance-baseline-postgres.integration.test.mjs scripts/stage1-staging-invalid-test-order-retirement-postgres.integration.test.mjs package.json
git commit -m "test: require explicit postgres test identities"
```

---

### Task 7: Migrate database suites batch A to isolated databases

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
pnpm release:contracts:verify
git diff --check
git add apps/api/test release/contracts/database-test-manifest.v1.json packages/release-foundation
git commit -m "test: isolate database suites batch a"
```

---

### Task 8: Migrate database suites batch B to isolated databases

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

- Consumes: the Task 3 lifecycle and Task 5 unified launcher/process-isolation adapter.
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
pnpm release:contracts:verify
git diff --check
git add apps/api/test release/contracts/database-test-manifest.v1.json packages/release-foundation
git commit -m "test: isolate database suites batch b"
```

---

### Task 9: Migrate database suites batch C and enforce the source database gate

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
- Modify: `scripts/release/run-source-database-gate.mjs`
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
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add .github/workflows/ci.yml apps/api package.json release/contracts scripts/release packages/release-foundation
git commit -m "ci: enforce isolated postgres release tests"
```

---

### Task 10: Build the closed Runner CLI and trust boundary

**Files:**

- Create: `apps/release-runner/package.json`
- Create: `apps/release-runner/src/cli.mjs`
- Create: `apps/release-runner/src/preflight.mjs`
- Create: `apps/release-runner/src/credential-file.mjs`
- Create: `apps/release-runner/src/command-registry.mjs`
- Create: `apps/release-runner/src/command-handlers.mjs`
- Create: `apps/release-runner/src/error-codes.mjs`
- Create: `apps/release-runner/test/cli.test.mjs`
- Create: `apps/release-runner/test/preflight.test.mjs`
- Create: `apps/release-runner/test/credential-boundary.test.mjs`
- Create: `apps/release-runner/test/command-registry.test.mjs`
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

- [ ] **Step 3: Make the JSON registry the only declaration authority**

`release/contracts/command-registry.v1.json` is the only source for command ID/version, category, data impact, capability profile, allowed/prohibited environments, approval mode, dry-run/apply/replay support, lock/timeout/postconditions, evidence Schema, owner, and exit condition. `command-handlers.mjs` exports only a map from exact `commandId@version` to an implementation function; it may not repeat policy fields.

```js
export function assertRegistryHandlerParity(registry, handlers) {
  const declared = registry.commands
    .map(({ commandId, commandVersion }) => `${commandId}@${commandVersion}`)
    .sort();
  const implemented = [...handlers.keys()].sort();
  if (!isDeepStrictEqual(declared, implemented)) throw codeError("RUNNER_REGISTRY_HANDLER_DRIFT");
}
```

Startup validates both directions: every declaration has exactly one handler, every handler has exactly one declaration, and every entry's versioned command contract is present in `repository-contract-files.v1.json`.

- [ ] **Step 4: Implement single-profile binding**

One execution request has exactly one profile; a command needing DDL and business DML must be split.

Define protocols and policy validation for all five Runner capabilities. Configure actual S1 environment identities only for `verify`, `migrate`, `repair`, and `evidence`; `fixture` has no S1 command or credential and remains reserved for the later S3 fixture design.

- [ ] **Step 5: Implement stable target-intent checks**

Validate environment declaration, secret reference, host allowlist, exact database intent, TLS policy, and prohibited environments before reading credentials. After connecting, read and freeze actual database identity, role, Schema, extensions, and migration head into the baseline Manifest.

- [ ] **Step 6: Build and inspect the one-shot Runner image**

`Dockerfile.runner` must set the closed CLI as `ENTRYPOINT`, copy only registered command dependencies, include the pinned Prisma and `psql` tools required by declared commands, and add the OCI source revision label. Runtime policy—not absence of `/bin/sh`—must prohibit entrypoint override, container exec, and Docker socket access.

```powershell
$s1SourceSha = (git rev-parse HEAD).Trim()
docker build -f Dockerfile.runner --label "org.opencontainers.image.revision=$s1SourceSha" -t subscription-runner:s1 .
docker inspect subscription-runner:s1
```

- [ ] **Step 7: Run registry, contract, and discovery gates**

```powershell
pnpm --filter @subscription-saas/release-runner test
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
```

Expected: PASS, including `RUNNER_REGISTRY_HANDLER_DRIFT` RED/green coverage for missing and extra handlers.

- [ ] **Step 8: Commit the Runner trust boundary**

```powershell
pnpm --filter @subscription-saas/release-foundation test
git diff --check
git add apps/release-runner release/contracts Dockerfile.runner pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build: add capability scoped release runner"
```

---

### Task 11: Implement verifiable approval policy and records before credential access

**Files:**

- Create: `release/contracts/schemas/approval-policy.v1.schema.json`
- Create: `release/contracts/schemas/approval-record.v1.schema.json`
- Create: `release/contracts/schemas/approval-revocations.v1.schema.json`
- Create: `release/contracts/approval-policies.v1.json`
- Create: `packages/release-foundation/src/approval.mjs`
- Create: `packages/release-foundation/test/approval.test.mjs`
- Create: `scripts/release/trusted-launch-runner.mjs`
- Create: `scripts/release/trusted-launch-runner.test.mjs`
- Create: `.github/workflows/release-operation-approval.yml`
- Modify: `apps/release-runner/src/preflight.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `verifyApproval(input): ApprovalDecision` and the only supported launcher path for approved Runner execution.
- `ApprovalRecordV1` binds `approvalId`, `approvalMode`, approver authority, issued/not-after times, build-proof digest, baseline Manifest identity/full digest, database identity, command ID/version, execution scope, operation ID, input digest, plan digest, approval-policy digest, and attestation subject digest.
- `ApprovalDecision` is an immutable `{ status: "verified", approvalRecordDigest, authority, expiresAt }`; Runner preflight accepts this decision plus the attested record, never a boolean `approved` flag.

- [ ] **Step 1: Write RED binding, authority, expiry, and revocation tests**

```js
for (const field of ["buildProofDigest", "databaseIdentity", "commandVersion", "planDigest"]) {
  test(`rejects approval bound to another ${field}`, async () => {
    const record = {
      ...validRecord,
      bindings: { ...validRecord.bindings, [field]: "sha256:wrong" }
    };
    await assert.rejects(() => verifyApproval({ ...fixture, record }), /APPROVAL_BINDING_MISMATCH/);
  });
}

test("rejects expired or revoked approval before secret read", async () => {
  await assert.rejects(() => launch({ approval: expiredRecord }), /APPROVAL_EXPIRED/);
  await assert.rejects(() => launch({ approval: revokedRecord }), /APPROVAL_REVOKED/);
  assert.equal(secretReads, 0);
  assert.equal(databaseConnections, 0);
});
```

Run: `pnpm --filter @subscription-saas/release-foundation test -- approval.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `approval.mjs`.

- [ ] **Step 2: Define approval authority and attestation policy**

`none` is valid only for a registry-declared read-only command and has no approval record. `ci-policy` records are emitted by the protected Release workflow identity. `human` records are emitted only after the protected `s1-database-operation-approval` GitHub environment records an allowed reviewer. Both non-none modes store an immutable record and GitHub artifact attestation whose subject is the canonical record digest.

The policy pins repository, workflow path/ref, environment, issuer, allowed team/role references, maximum lifetime, and permitted command/environment/impact tuples. Application RBAC is not consulted.

- [ ] **Step 3: Implement strict approval verification**

```js
export async function verifyApproval({ record, policy, attestation, revocations, expected, now }) {
  validateContract("approval-record.v1", record);
  verifyAttestationSubject(attestation, sha256Canonical(record));
  verifyTrustedAuthority(attestation, policy);
  verifyAllBindings(record.bindings, expected);
  verifyLifetimeAndRevocation(record, revocations, now);
  return Object.freeze({
    status: "verified",
    approvalRecordDigest: sha256Canonical(record),
    authority: attestation.signer,
    expiresAt: record.notAfter
  });
}
```

- [ ] **Step 4: Put approval verification in the launcher before credential handoff**

The trusted launcher verifies build/Runner/target intent, then approval policy/record/attestation/revocations, and only then resolves the capability secret reference. Wrong mode, wrong signer, wrong build/Manifest/database/command/operation/input/plan, expired record, stale revocation set, or invalid attestation returns a specific `PREFLIGHT_REJECTED` reason with zero secret reads and zero database connections.

- [ ] **Step 5: Test policy issuance and revocation workflow contracts**

Run: `node --test scripts/release/trusted-launch-runner.test.mjs`

Expected: PASS for `none`, protected `ci-policy`, and protected `human` fixtures; FAIL with `APPROVAL_AUTHORITY_UNTRUSTED`, `APPROVAL_BINDING_MISMATCH`, `APPROVAL_EXPIRED`, or `APPROVAL_REVOKED` in their respective cases.

- [ ] **Step 6: Run repository contract and discovery gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit approval as its own trust boundary**

```powershell
git add release/contracts/schemas/approval-policy.v1.schema.json release/contracts/schemas/approval-record.v1.schema.json release/contracts/schemas/approval-revocations.v1.schema.json release/contracts/approval-policies.v1.json release/contracts/repository-contract-files.v1.json packages/release-foundation/src/approval.mjs packages/release-foundation/test/approval.test.mjs scripts/release/trusted-launch-runner.mjs scripts/release/trusted-launch-runner.test.mjs apps/release-runner/src/preflight.mjs .github/workflows/release-operation-approval.yml
git commit -m "build: verify release operation approvals"
```

---

### Task 12: Implement the acyclic proof and execution state machine

**Files:**

- Create: `packages/release-foundation/src/proof-builders.mjs`
- Create: `packages/release-foundation/src/execution-state-machine.mjs`
- Create: `packages/release-foundation/test/proof-builders.test.mjs`
- Create: `packages/release-foundation/test/execution-state-machine.test.mjs`
- Modify: `scripts/release/trusted-launch-runner.mjs`
- Modify: `apps/release-runner/src/cli.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `buildPostStateObservation(input): PostStateObservationV1`, `buildExecutionProof(input): ExecutionProofV1`, `transitionExecution(state, event): ExecutionState`, and `assertApplyAllowed(input): void`.
- Proof chain: baseline Manifest identity/full digest -> deterministic plan digest -> post-state observation digest -> execution proof digest. The observation never accepts an execution-proof digest.
- Terminal classes: `PREFLIGHT_REJECTED`, `SUCCEEDED`, `FAILED`, and launcher-owned `INTERRUPTED_UNKNOWN`.

- [ ] **Step 1: Write RED acyclic-content tests**

```js
test("post-state cannot reference its future execution proof", () => {
  assert.throws(
    () =>
      buildPostStateObservation({
        ...validObservationInput,
        executionProofDigest: "sha256:future"
      }),
    /POST_STATE_FORWARD_REFERENCE_FORBIDDEN/
  );
});
```

Run: `node --test packages/release-foundation/test/proof-builders.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `proof-builders.mjs`.

- [ ] **Step 2: Implement observation-before-proof builders**

```js
export function buildExecutionProof({ postStateObservation, ...input }) {
  return validateAndFreeze("execution-proof.v1", {
    ...input,
    postStateObservationDigest: sha256Canonical(postStateObservation)
  });
}
```

Prove identical deterministic plans have identical digests even when provenance timestamps differ.

- [ ] **Step 3: Write RED state-transition tests**

Test normal dry-run/apply/replay, apply after plan drift, process loss before commit, process loss after commit-before-proof, and repeated apply after UNKNOWN.

Run: `node --test packages/release-foundation/test/execution-state-machine.test.mjs`

Expected: FAIL with `EXECUTION_TRANSITION_UNIMPLEMENTED`.

- [ ] **Step 4: Implement deterministic apply and UNKNOWN recovery rules**

Apply re-reads facts and recomputes the plan under the command's registered lock/transaction or CAS boundary; a changed digest raises `PLAN_CHANGED_SINCE_APPROVAL` before writes. After `INTERRUPTED_UNKNOWN`, `assertApplyAllowed` raises `UNKNOWN_REQUIRES_RECONCILE`; only same-key reconcile/replay may inspect database facts and construct a recovery observation.

- [ ] **Step 5: Integrate the state machine into launcher and Runner**

The launcher owns preflight/UNKNOWN records; Runner owns normal failed/successful observations and proofs. Dry-run, apply, and replay have distinct attempt IDs and predecessor proof references under one operation ID.

- [ ] **Step 6: Run proof, approval, registry, contract, and discovery gates**

```powershell
node --test packages/release-foundation/test/proof-builders.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs
pnpm --filter @subscription-saas/release-runner test
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit the proof state machine**

```powershell
git add packages/release-foundation/src/proof-builders.mjs packages/release-foundation/src/execution-state-machine.mjs packages/release-foundation/test/proof-builders.test.mjs packages/release-foundation/test/execution-state-machine.test.mjs scripts/release/trusted-launch-runner.mjs apps/release-runner/src/cli.mjs release/contracts/repository-contract-files.v1.json
git commit -m "build: add release execution proof state machine"
```

---

### Task 13: Produce the protected sanitized snapshot artifact

**Files:**

- Create: `release/contracts/schemas/sanitization-contract.v1.schema.json`
- Create: `release/contracts/schemas/snapshot-metadata.v1.schema.json`
- Create: `release/contracts/sanitization-contract.v1.json`
- Create: `packages/release-foundation/src/snapshot/export-sanitized.mjs`
- Create: `packages/release-foundation/src/snapshot/scan-artifact.mjs`
- Create: `packages/release-foundation/test/snapshot-export.test.mjs`
- Create: `scripts/release/export-sanitized-snapshot.mjs`
- Create: `.github/workflows/sanitized-snapshot.yml`
- Create: `docs/operations/stage1-s1-sanitized-snapshot.md`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Consumes: a protected `stage1-snapshot-export` secret reference and `SanitizationContractV1`; raw Staging data never leaves that protected boundary.
- Produces: `exportSanitizedSnapshot(input): Promise<SnapshotMetadataV1>` and `scanSanitizedArtifact(input): Promise<SanitizationScanV1>`.
- The immutable output binds sanitized dump digest, source migration head, export/scan tool versions, sanitization contract digest, scan digest, creation/expiry metadata, owner, and access policy. It is source-governance evidence, not a build proof, Manifest, or Runner proof.

- [ ] **Step 1: Write RED field-transformation and secret-scan tests**

Create fixtures containing known phone numbers, identity numbers, access tokens, URLs with credentials, and secret-shaped strings.

Run: `node --test packages/release-foundation/test/snapshot-export.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `export-sanitized.mjs`.

- [ ] **Step 2: Implement protected export and deterministic metadata**

The protected source executor applies every versioned field transformation before export, scans the final artifact, computes its digest, and publishes only the immutable sanitized artifact and evidence. Timestamp provenance is recorded but does not alter artifact identity.

- [ ] **Step 3: Reject incomplete or expired snapshot metadata**

Reject failed scans, missing owner/review/expiry data, expired artifacts, changed contract digests, unknown source migration heads, or a dump digest that does not match the scanned subject.

- [ ] **Step 4: Verify the protected workflow cannot publish raw input**

The workflow uploads only the final dump, metadata, scan proof, and custody receipt. Its raw dump path is inside an isolated job workspace with `if: always()` secure deletion and no artifact upload step. Ordinary PR/CI jobs cannot request the protected environment.

- [ ] **Step 5: Run export contract and custody tests**

```powershell
node --test packages/release-foundation/test/snapshot-export.test.mjs
node --test scripts/release/custody-evidence.test.mjs
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
```

Expected: sanitization and custody tests pass; the new test is explicitly classified; repository contract includes both snapshot Schemas and the sanitization contract.

- [ ] **Step 6: Commit protected snapshot export**

```powershell
git diff --check
git add release/contracts/schemas/sanitization-contract.v1.schema.json release/contracts/schemas/snapshot-metadata.v1.schema.json release/contracts/sanitization-contract.v1.json release/contracts/repository-contract-files.v1.json packages/release-foundation/src/snapshot/export-sanitized.mjs packages/release-foundation/src/snapshot/scan-artifact.mjs packages/release-foundation/test/snapshot-export.test.mjs scripts/release/export-sanitized-snapshot.mjs .github/workflows/sanitized-snapshot.yml docs/operations/stage1-s1-sanitized-snapshot.md
git commit -m "ci: produce protected sanitized snapshot"
```

---

### Task 14: Restore snapshot ownership and execute the source upgrade chain

**Files:**

- Create: `release/contracts/schemas/ownership-map.v1.schema.json`
- Create: `release/contracts/snapshot-ownership-map.v1.json`
- Create: `packages/release-foundation/src/snapshot/restore-sanitized.mjs`
- Create: `packages/release-foundation/src/snapshot/normalize-ownership.mjs`
- Create: `packages/release-foundation/test/snapshot-chain.integration.test.mjs`
- Create: `scripts/release/restore-sanitized-snapshot.mjs`
- Modify: `scripts/release/run-source-database-gate.mjs`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/database-test-manifest.v1.json`

**Interfaces:**

- Produces: `restoreSanitizedSnapshot(input): Promise<RestoredSnapshotRecord>`, `verifyOwnershipMap(input): Promise<OwnershipObservationV1>`, and the `snapshot` branch of `runSourceDatabaseGate`.
- Restore is a trusted-launch infrastructure action with a single restore credential. After revocation, migration/verify/runtime-test use different credentials and the shared Task 5 launcher.

- [ ] **Step 1: Write RED ownership and credential-revocation tests**

Run: `node scripts/release/run-database-suite.mjs --suite-id release.snapshot-chain --chain snapshot`

Expected: FAIL because `restore-sanitized.mjs` is absent.

- [ ] **Step 2: Implement exact restore under the migration owner**

The launcher grants the one-use restore executor audited temporary membership in the target migration role. Run `pg_restore --no-owner --no-acl` under `SET ROLE migration_role` so approved objects are created directly under the migration owner. Apply only versioned owner-map normalizations; reject any unknown owner/object class.

- [ ] **Step 3: Revoke restore capability before migration**

Revoke temporary role membership, expire/remove the secret, prove the restore executor cannot reconnect, and only then allow migration. Do not use `SUPERUSER`, a cross-target owner change, or the runtime-test role as owner.

- [ ] **Step 4: Execute the snapshot source gate through the unified launcher**

```powershell
node scripts/release/run-source-database-gate.mjs --chain snapshot --snapshot-metadata-file .release-inputs/snapshot-metadata.json
```

Expected: every suite marked `snapshot: required` executes; each exclusion carries an approved N/A; Schema diff is zero; server version, source/head catalogs, ownership inventory, sanitization proof, and the complete count equation are present.

- [ ] **Step 5: Run wrong-owner, stale-snapshot, and leaked-restore negative cases**

Run: `node --test packages/release-foundation/test/snapshot-chain.integration.test.mjs`

Expected: PASS, including `SNAPSHOT_OWNER_UNMAPPED`, `SNAPSHOT_EXPIRED`, `RESTORE_CREDENTIAL_STILL_ACTIVE`, and `SNAPSHOT_SCHEMA_DIFF` cases.

- [ ] **Step 6: Run contract and discovery gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit snapshot restore separately**

```powershell
git add release/contracts/schemas/ownership-map.v1.schema.json release/contracts/snapshot-ownership-map.v1.json release/contracts/repository-contract-files.v1.json release/contracts/database-test-manifest.v1.json packages/release-foundation/src/snapshot/restore-sanitized.mjs packages/release-foundation/src/snapshot/normalize-ownership.mjs packages/release-foundation/test/snapshot-chain.integration.test.mjs scripts/release/restore-sanitized-snapshot.mjs scripts/release/run-source-database-gate.mjs
git commit -m "ci: verify sanitized snapshot upgrade chain"
```

---

### Task 15: Inventory API runtime governance files, commands, and callers

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
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add release/contracts scripts/release docs/operations
git commit -m "docs: inventory api governance runtime"
```

---

### Task 16: Register schema verification and migration deploy commands

**Files:**

- Create: `apps/release-runner/src/commands/db-migrate-deploy.mjs`
- Create: `apps/release-runner/src/commands/db-schema-verify.mjs`
- Create: `apps/release-runner/test/db-migrate-schema.integration.test.mjs`
- Create: `release/contracts/command-contracts/db.migrate.deploy.v1.json`
- Create: `release/contracts/command-contracts/db.schema.verify.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`

**Interfaces:**

- Produces: `planMigration(context, input): Promise<MigrationPlanV1>`, `applyMigration(context, approved): Promise<PostStateObservationV1>`, and `verifySchema(context, input): Promise<SchemaObservationV1>`.
- `db.migrate.deploy@1` uses `migrate`, DDL impact, `ci-policy` on ephemeral CI and `human` on Staging. `db.schema.verify@1` uses read-only `verify` and approval `none`. Both allow `migration-schema` and `full-rc` under the same complete build proof.

- [ ] **Step 1: Add both command contracts to the digest manifest first**

Each contract fixes input/plan/output Schemas, pending-migration selection, migration lock, transaction boundary, tool versions, timeout/cancel behavior, checksums, ownership and Schema postconditions, approval mode, and allowed scopes. Add both paths to `repository-contract-files.v1.json` in the same RED commit state.

- [ ] **Step 2: Write RED migration plan and read-only Schema tests**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.db-migrate-schema --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:db.migrate.deploy@1`.

- [ ] **Step 3: Implement deterministic migration planning and apply**

Dry-run records current head, ordered pending migrations, catalog digest, expected owner, and expected Schema digest. Apply takes the registered migration lock, recomputes the plan, calls the pinned Prisma CLI only after approval verification, and refuses drift with `PLAN_CHANGED_SINCE_APPROVAL`.

- [ ] **Step 4: Implement read-only Schema verification**

The verify adapter uses catalog-only/read-only SQL and returns migration head/checksums, Schema diff, owner inventory, extension allowlist, and actual Prisma/psql/PostgreSQL versions. Statement logging must prove zero DDL/business DML.

- [ ] **Step 5: Register handlers and prove bidirectional parity**

Add the two declarations to the JSON registry and two implementations to `command-handlers.mjs`. Do not add policy data to the handler map.

- [ ] **Step 6: Exercise both scopes**

```powershell
node scripts/release/trusted-launch-runner.mjs --scope migration-schema --command db.schema.verify@1 --request-file .release-inputs/schema-verify.json
node scripts/release/trusted-launch-runner.mjs --scope full-rc --command db.schema.verify@1 --request-file .release-inputs/schema-verify.json
```

Expected: same complete build proof; the first does not require Web startup and cannot form a promotable partial bundle.

- [ ] **Step 7: Run all contract/discovery/registry gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- db-migrate-schema
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 8: Commit the schema/migration pair**

```powershell
git add apps/release-runner/src/commands/db-migrate-deploy.mjs apps/release-runner/src/commands/db-schema-verify.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/db-migrate-schema.integration.test.mjs release/contracts/command-contracts/db.migrate.deploy.v1.json release/contracts/command-contracts/db.schema.verify.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json
git commit -m "build: register schema migration commands"
```

---

### Task 17: Register acceptance-target and Task9 read-only verification commands

**Files:**

- Create: `apps/release-runner/src/commands/stage1-acceptance-target-verify.mjs`
- Create: `apps/release-runner/src/commands/stage1-task9-preflight.mjs`
- Create: `apps/release-runner/test/stage1-target-task9-verify.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.acceptance.target.verify.v1.json`
- Create: `release/contracts/command-contracts/stage1.task9.preflight.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`

**Interfaces:**

- Produces: `verifyAcceptanceTarget(context, input): Promise<TargetVerificationV1>` and `verifyTask9Preflight(context, input): Promise<Task9VerificationV1>`.
- Both commands use read-only `verify`, approval `none`, and the frozen target/Task9 rule sets; neither may mutate or invoke an arbitrary script.

- [ ] **Step 1: Add both v1 contracts and RED handler-parity fixtures**

Run: `pnpm --filter @subscription-saas/release-runner test -- stage1-target-task9-verify`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.acceptance.target.verify@1`.

- [ ] **Step 2: Adapt existing target-validator and Task9 core functions**

Call imported core functions directly. Freeze exact inputs, output classifications, prohibited-domain checks, statement timeout, and no-write postcondition in each command contract.

- [ ] **Step 3: Prove read-only behavior and exact error mapping**

Run both under a read-only transaction with statement logging. Expected: zero DDL/DML; invalid database identity returns `TARGET_IDENTITY_MISMATCH`; Task9 forbidden facts return the existing normalized refusal class.

- [ ] **Step 4: Register both handlers and run digest/discovery gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 5: Commit the verification pair**

```powershell
git add apps/release-runner/src/commands/stage1-acceptance-target-verify.mjs apps/release-runner/src/commands/stage1-task9-preflight.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-target-task9-verify.integration.test.mjs release/contracts/command-contracts/stage1.acceptance.target.verify.v1.json release/contracts/command-contracts/stage1.task9.preflight.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json
git commit -m "build: register stage1 verification commands"
```

---

### Task 18: Register billing-maintenance evidence as a read-only command

**Files:**

- Create: `apps/release-runner/src/commands/stage1-billing-maintenance-evidence.mjs`
- Create: `apps/release-runner/test/stage1-billing-maintenance-evidence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.billing-maintenance.evidence.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/billing-maintenance-cycle-evidence-core.mjs`

**Interfaces:**

- Produces: `collectBillingMaintenanceEvidence(context, input): Promise<BillingMaintenanceEvidenceV1>`.
- Command `stage1.billing-maintenance.evidence@1` uses `evidence`, approval `none`, database read-only plus the Task 4 controlled evidence-output capability.

- [ ] **Step 1: Add the v1 contract and RED missing-handler test**

Run: `pnpm --filter @subscription-saas/release-runner test -- stage1-billing-maintenance-evidence`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.billing-maintenance.evidence@1`.

- [ ] **Step 2: Adapt the existing evidence core without spawning its CLI**

Freeze input, bounded polling, sequence 1/2 checks, release/image/database binding, `blockedCount=0`, no-overlap, canonical hashes, timeout classification, and public-safe evidence Schema in the command contract.

- [ ] **Step 3: Prove zero database writes and custody-only output**

Run with a read-only database role and a writeable evidence directory. Expected: no DDL/DML; successful output is accepted only after Task 4 custody receipt; timeout cannot synthesize success.

- [ ] **Step 4: Register the handler and run all contract gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 5: Commit billing evidence independently**

```powershell
git add apps/release-runner/src/commands/stage1-billing-maintenance-evidence.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-billing-maintenance-evidence.integration.test.mjs release/contracts/command-contracts/stage1.billing-maintenance.evidence.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/billing-maintenance-cycle-evidence-core.mjs
git commit -m "build: register billing maintenance evidence command"
```

---

### Task 19: Move clean-acceptance baseline behavior behind one repair command

**Files:**

- Create: `apps/release-runner/src/commands/stage1-clean-acceptance-baseline.mjs`
- Create: `apps/release-runner/test/clean-acceptance-baseline-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.clean-acceptance.baseline.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-clean-acceptance-baseline-core.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-executor.mjs`
- Modify: `scripts/stage1-clean-acceptance-baseline-snapshot.mjs`

**Interfaces:**

- Produces: `planCleanAcceptanceBaseline(context, input): Promise<CleanAcceptancePlanV1>`, `applyCleanAcceptanceBaseline(context, approved): Promise<PostStateObservationV1>`, and `reconcileCleanAcceptanceBaseline(context, prior): Promise<ReconcileResultV1>`.
- Command: `stage1.clean-acceptance.baseline@1`.
- Capability: `repair`; environments: ephemeral acceptance and approved Staging only; approval mode: `ci-policy` for ephemeral, `human` for Staging.
- Plan binds exact target identities, expected per-table writes, baseline values, postconditions, lock order, and idempotency key.

- [ ] **Step 1: Freeze the v1 behavior contract and add it to the digest manifest**

Normalize target rows, per-table inserts/updates/deletes, domain audit records, exit classification, current lock/transaction order, timeout/cancel behavior, and postconditions. Exclude Runner proof-envelope fields and wall-clock provenance from the equivalence comparison. Add the command contract path to `repository-contract-files.v1.json` before registry activation.

- [ ] **Step 2: Write RED equivalence tests on two independent databases**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-clean-acceptance-baseline --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.clean-acceptance.baseline@1` after preparing the independent A/B fixtures.

- [ ] **Step 3: Implement deterministic dry-run and locked apply**

Refactor only enough to call existing `classifyStage1CleanAcceptanceBaseline`, `buildStage1CleanAcceptanceManifest`, `loadStage1CleanAcceptanceSourceSnapshot`, and `executeStage1CleanAcceptanceBaseline`. Database A executes the old entry; B executes the adapter. Apply recomputes under the current lock/transaction boundary and refuses TOCTOU drift; replay has no duplicate side effects.

- [ ] **Step 4: Add failure, cancellation, and UNKNOWN recovery cases**

Inject faults before writes, before commit, after commit/before proof, and during evidence custody. Expected behavior must match the normalized error classes and the Task 12 recovery state machine.

- [ ] **Step 5: Run registry/digest/discovery/inventory gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- clean-acceptance
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit the clean-acceptance adapter**

```powershell
git add apps/release-runner/src/commands/stage1-clean-acceptance-baseline.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/clean-acceptance-baseline-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.clean-acceptance.baseline.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1-clean-acceptance-baseline-core.mjs scripts/stage1-clean-acceptance-baseline-executor.mjs scripts/stage1-clean-acceptance-baseline-snapshot.mjs
git commit -m "build: migrate clean acceptance repair command"
```

---

### Task 20: Migrate `stage1.active-source-facts.repair@1`

**Files:**

- Create: `apps/release-runner/src/commands/stage1-active-source-facts-repair.mjs`
- Create: `apps/release-runner/test/stage1-active-source-facts-repair-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.active-source-facts.repair.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-active-source-facts-repair-core.mjs`
- Modify: `scripts/stage1-active-source-facts-repair-executor.mjs`

**Interfaces:**

- Produces: `planActiveSourceFactsRepair(context, input): Promise<ActiveSourceFactsPlanV1>`, `applyActiveSourceFactsRepair(context, approved): Promise<PostStateObservationV1>`, and `reconcileActiveSourceFactsRepair(context, prior): Promise<ReconcileResultV1>`.
- The adapter calls existing `classifyStage1ActiveSourceFactsRepair`, `loadStage1ActiveSourceFactsRepairSnapshot`, and `executeStage1ActiveSourceFactsRepair`; it does not duplicate selection SQL.

- [ ] **Step 1: Add the v1 contract to the repository digest**

Freeze exact source-fact candidates, expected row versions/per-table writes, current lock/transaction order, audit output, timeout/cancel behavior, idempotency, postconditions, `repair` profile, approval modes, and allowed environments.

- [ ] **Step 2: Write the paired-database RED test**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-active-source-facts-repair --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.active-source-facts.repair@1`.

- [ ] **Step 3: Implement the minimal adapter and handler registration**

Database A executes the old entry; database B executes the adapter from the same fixture. Compare normalized target IDs, per-table changes, audits, postconditions, and error classes; exclude the proof envelope.

- [ ] **Step 4: Test replay, stale plan, and UNKNOWN reconcile**

Run apply/replay, mutate one candidate version before apply, and inject process loss after commit. Expected: no duplicate facts/audits, `PLAN_CHANGED_SINCE_APPROVAL` for drift, and same-key reconcile after UNKNOWN.

- [ ] **Step 5: Run registry/digest/discovery/inventory gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- stage1-active-source-facts-repair
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/stage1-active-source-facts-repair.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-active-source-facts-repair-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.active-source-facts.repair.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1-active-source-facts-repair-core.mjs scripts/stage1-active-source-facts-repair-executor.mjs
git commit -m "build: migrate active source facts repair command"
```

---

### Task 21: Migrate `stage1.period.backfill@1`

**Files:**

- Create: `apps/release-runner/src/commands/stage1-period-backfill.mjs`
- Create: `apps/release-runner/test/stage1-period-backfill-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.period.backfill.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1c-period-backfill-core.mjs`
- Modify: `scripts/stage1c-period-backfill-executor.mjs`

**Interfaces:**

- Produces: `planPeriodBackfill(context, input): Promise<PeriodBackfillPlanV1>`, `applyPeriodBackfill(context, approved): Promise<PostStateObservationV1>`, and `reconcilePeriodBackfill(context, prior): Promise<ReconcileResultV1>`.
- The adapter calls existing `classifyStage1cPeriodBackfill`, `loadStage1cPeriodBackfillSnapshot`, and `executeStage1cPeriodBackfill` without changing period semantics.

- [ ] **Step 1: Add the v1 contract and digest entry**

Freeze candidate period identities, start/end source keys, row versions, lock/transaction order, exact writes, no-overlap postconditions, audit/error classes, timeout, and idempotency.

- [ ] **Step 2: Write and run the paired-database RED test**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-period-backfill --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.period.backfill@1`.

- [ ] **Step 3: Implement the adapter and compare normalized outcomes**

Use identical A/B fixtures; compare periods, source keys, occupancy constraints, audits, and exit classes after dry-run/apply/replay.

- [ ] **Step 4: Test concurrency barrier, stale plan, and UNKNOWN**

Release two approved applies at a deterministic barrier. Expected: registered lock order prevents overlap; stale digest refuses; after-commit loss reconciles without another period.

- [ ] **Step 5: Run all command gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- stage1-period-backfill
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/stage1-period-backfill.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-period-backfill-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.period.backfill.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1c-period-backfill-core.mjs scripts/stage1c-period-backfill-executor.mjs
git commit -m "build: migrate period backfill command"
```

---

### Task 22: Migrate `subscription.segment.bootstrap@1`

**Files:**

- Create: `apps/release-runner/src/commands/subscription-segment-bootstrap.mjs`
- Create: `apps/release-runner/test/subscription-segment-bootstrap-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/subscription.segment.bootstrap.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/subscription-segment-bootstrap-core.mjs`

**Interfaces:**

- Produces: `planSubscriptionSegmentBootstrap(context, input): Promise<SegmentBootstrapPlanV1>`, `applySubscriptionSegmentBootstrap(context, approved): Promise<PostStateObservationV1>`, and `reconcileSubscriptionSegmentBootstrap(context, prior): Promise<ReconcileResultV1>`.
- The adapter calls existing `buildSubscriptionSegmentBootstrapPlan` and `applySubscriptionSegmentBootstrapPlan`; it cannot accept caller-supplied SQL or unbounded selectors.

- [ ] **Step 1: Add the v1 contract and digest entry**

Freeze input identities, segment order/range constraints, exact planned writes, current transaction boundary, error mapping, idempotency and postconditions.

- [ ] **Step 2: Write and run the paired-database RED test**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.subscription-segment-bootstrap --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:subscription.segment.bootstrap@1`.

- [ ] **Step 3: Implement the adapter and normalized equivalence**

Compare segment IDs/order/bounds, affected orders, audit facts, no-op replay, and exit class between old and Runner databases.

- [ ] **Step 4: Test overlapping input, stale plan, and UNKNOWN**

Expected: overlap/incomplete facts retain existing refusal classes; plan drift refuses before writes; same-key reconcile produces no duplicate segment.

- [ ] **Step 5: Run all command gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- subscription-segment-bootstrap
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/subscription-segment-bootstrap.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/subscription-segment-bootstrap-equivalence.integration.test.mjs release/contracts/command-contracts/subscription.segment.bootstrap.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/subscription-segment-bootstrap-core.mjs
git commit -m "build: migrate subscription segment bootstrap command"
```

---

### Task 23: Migrate `stage1.return-closure.backfill@1`

**Files:**

- Create: `apps/release-runner/src/commands/stage1-return-closure-backfill.mjs`
- Create: `apps/release-runner/test/stage1-return-closure-backfill-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.return-closure.backfill.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-return-closure-backfill-core.mjs`

**Interfaces:**

- Produces: `planReturnClosureBackfill(context, input): Promise<ReturnClosurePlanV1>`, `applyReturnClosureBackfill(context, approved): Promise<PostStateObservationV1>`, and `reconcileReturnClosureBackfill(context, prior): Promise<ReconcileResultV1>`.
- The adapter calls existing `classifyStage1ReturnClosureBackfill`, `applicableStage1ReturnClassification`, and `executeStage1ReturnClosureBackfill`; payment/write-off authority remains external.

- [ ] **Step 1: Add the v1 contract and digest entry**

Freeze exact order/Closure/return evidence identities, expected versions, financial-authority fingerprint, exact writes, lock/transaction boundary, audit/error classes, idempotency and postconditions.

- [ ] **Step 2: Write and run the paired-database RED test**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-return-closure-backfill --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.return-closure.backfill@1`.

- [ ] **Step 3: Implement minimal adapter and normalized equivalence**

Compare exact target IDs, return/Closure facts, financial fingerprint, audit events, postconditions, and refusal classes on independent A/B databases.

- [ ] **Step 4: Test stale financial facts, replay, and UNKNOWN**

Change one bill/disposition after dry-run and require `PLAN_CHANGED_SINCE_APPROVAL`; replay and same-key reconcile must not create another Closure or overwrite payment authority.

- [ ] **Step 5: Run all command gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- stage1-return-closure-backfill
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/stage1-return-closure-backfill.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-return-closure-backfill-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.return-closure.backfill.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1-return-closure-backfill-core.mjs
git commit -m "build: migrate return closure backfill command"
```

---

### Task 24: Migrate `stage1.invalid-test-order.retire@1`

**Files:**

- Create: `apps/release-runner/src/commands/stage1-invalid-test-order-retire.mjs`
- Create: `apps/release-runner/test/stage1-invalid-test-order-retire-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.invalid-test-order.retire.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-core.mjs`
- Modify: `scripts/stage1-staging-invalid-test-order-retirement-executor.mjs`

**Interfaces:**

- Produces: `planInvalidTestOrderRetirement(context, input): Promise<InvalidOrderRetirementPlanV1>`, `applyInvalidTestOrderRetirement(context, approved): Promise<PostStateObservationV1>`, and `reconcileInvalidTestOrderRetirement(context, prior): Promise<ReconcileResultV1>`.
- The adapter calls existing target assertion/classifier/snapshot/executor functions and accepts only exact registered test-order identities, never a general status query.

- [ ] **Step 1: Add the v1 contract and digest entry**

Freeze test-order allowlist identity, operator, vehicle ownership/version, exact close/release writes, lock/transaction order, audit output, idempotency and safety refusals.

- [ ] **Step 2: Write and run the paired-database RED test**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-invalid-test-order-retire --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.invalid-test-order.retire@1`.

- [ ] **Step 3: Implement adapter and prove it is not an order-deletion tool**

Compare retirement, vehicle release, audits and refusal classes on A/B fixtures. A non-allowlisted or valid business order must return `INVALID_TEST_ORDER_TARGET_REFUSED` before writes.

- [ ] **Step 4: Test replay, changed vehicle owner, and UNKNOWN**

Expected: second apply/reconcile has no repeated release/audit; changed owner/version invalidates plan; UNKNOWN does not authorize a new apply.

- [ ] **Step 5: Run all command gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- stage1-invalid-test-order-retire
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/stage1-invalid-test-order-retire.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-invalid-test-order-retire-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.invalid-test-order.retire.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1-staging-invalid-test-order-retirement-core.mjs scripts/stage1-staging-invalid-test-order-retirement-executor.mjs
git commit -m "build: migrate invalid test order retirement command"
```

---

### Task 25: Migrate `stage1.contract-change.bootstrap@1` as an ephemeral-only command

**Files:**

- Create: `apps/release-runner/src/commands/stage1-contract-change-bootstrap.mjs`
- Create: `apps/release-runner/test/stage1-contract-change-bootstrap-equivalence.integration.test.mjs`
- Create: `release/contracts/command-contracts/stage1.contract-change.bootstrap.v1.json`
- Modify: `apps/release-runner/src/command-handlers.mjs`
- Modify: `release/contracts/command-registry.v1.json`
- Modify: `release/contracts/repository-contract-files.v1.json`
- Modify: `release/contracts/api-runtime-governance-inventory.v1.json`
- Modify: `scripts/stage1-contract-change-bootstrap-core.mjs`

**Interfaces:**

- Produces: `planContractChangeBootstrap(context, input): Promise<ContractChangeBootstrapPlanV1>`, `applyContractChangeBootstrap(context, approved): Promise<PostStateObservationV1>`, and `reconcileContractChangeBootstrap(context, prior): Promise<ReconcileResultV1>`.
- v1 allows only ephemeral CI/development acceptance databases, uses `repair` plus `ci-policy`, and explicitly rejects Staging/Production before secret access.

- [ ] **Step 1: Add the ephemeral-only v1 contract and digest entry**

Freeze feature-flag requirements, exact source order/change identities, planned writes, transaction boundary, audit/error classes, idempotency, allowed environments and explicit prohibited environments.

- [ ] **Step 2: Write RED environment and paired-database tests**

Run: `node scripts/release/run-database-suite.mjs --suite-id runner.stage1-contract-change-bootstrap --chain fresh`

Expected: FAIL with `RUNNER_HANDLER_MISSING:stage1.contract-change.bootstrap@1`.

- [ ] **Step 3: Implement adapter with pre-credential environment refusal**

Call existing `validateContractChangeFeatureFlags`, `buildContractChangeBootstrapPlan`, and `applyContractChangeBootstrapPlan`. A Staging request returns `RUNNER_ENVIRONMENT_PROHIBITED` with zero secret reads/connections.

- [ ] **Step 4: Test equivalence, replay, stale input, and UNKNOWN**

Compare exact bootstrap facts/audits on A/B databases. Changed order/change versions refuse; replay/reconcile create no duplicate request or projection.

- [ ] **Step 5: Run all command gates**

```powershell
pnpm --filter @subscription-saas/release-runner test -- stage1-contract-change-bootstrap
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
git diff --check
```

- [ ] **Step 6: Commit this command only**

```powershell
git add apps/release-runner/src/commands/stage1-contract-change-bootstrap.mjs apps/release-runner/src/command-handlers.mjs apps/release-runner/test/stage1-contract-change-bootstrap-equivalence.integration.test.mjs release/contracts/command-contracts/stage1.contract-change.bootstrap.v1.json release/contracts/command-registry.v1.json release/contracts/repository-contract-files.v1.json release/contracts/api-runtime-governance-inventory.v1.json scripts/stage1-contract-change-bootstrap-core.mjs
git commit -m "build: migrate ephemeral contract change bootstrap command"
```

---

### Task 26: Switch callers and remove governance tooling from the API runtime

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
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add Dockerfile.api apps/api package.json docker-compose.staging* .env.staging* docs release/contracts scripts/release scripts/stage1-clean-acceptance-runbook-contract.test.mjs
git commit -m "build: remove governance tools from api runtime"
```

---

### Task 27: Build three immutable images from one trusted checkout

**Files:**

- Modify: `Dockerfile.api`
- Modify: `Dockerfile.web`
- Modify: `Dockerfile.runner`
- Modify: `.github/workflows/docker-images.yml`
- Create: `scripts/release/verify-build-materials.mjs`
- Create: `scripts/release/build-materials.test.mjs`
- Create: `release/contracts/build-material-policy.v1.json`
- Create: `release/contracts/schemas/build-material-observation.v1.schema.json`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `verifyBuildMaterials(input): BuildMaterialObservationV1` and three registry-resolved `{ image, platform, digest, sourceRevision, baseImageDigests, buildAttestationRef }` records from one fixed checkout.
- This task builds and observes artifacts but does not issue `build-proof.v1`; Task 28's protected external aggregator does that after registry resolution.

- [ ] **Step 1: Write RED build-material policy tests**

Reject a mutable external action reference, unpinned/unobserved base image, PR-only promotion marker, checkout ref that differs from SHA, or a workflow that lets individual image jobs choose source.

Run: `node --test scripts/release/build-materials.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `verify-build-materials.mjs`.

- [ ] **Step 2: Put the OCI source revision in all three images**

Pass one fixed checkout SHA to API, Web, and Runner builds. Verify `org.opencontainers.image.revision` from registry-pulled images and ensure it equals the build-proof source SHA.

- [ ] **Step 3: Build three images in one trusted build run**

The workflow may build in parallel. Each build receives the same protected checkout SHA and emits an attested registry subject. Tags are discovery metadata only; no output is yet promotable.

```yaml
needs: [build-api, build-web, build-runner]
```

- [ ] **Step 4: Resolve and verify actual registry subjects**

After push, a protected observer reads each linux/amd64 platform digest from the registry, pulls its OCI source revision and attestation, and returns `BuildMaterialObservationV1`. Reject tag-only identity, mixed revisions/runs, or absent base/builder provenance.

- [ ] **Step 5: Run explicit negative material cases**

Run: `node --test scripts/release/build-materials.test.mjs`

Expected: PASS with named cases `BUILD_ACTION_UNPINNED`, `BUILD_BASE_IMAGE_UNPROVEN`, `BUILD_SOURCE_REVISION_MISMATCH`, `BUILD_REGISTRY_DIGEST_REQUIRED`, and `PR_ARTIFACT_NOT_PROMOTABLE`.

- [ ] **Step 6: Run contract, discovery, and workflow checks**

```powershell
node scripts/release/verify-build-materials.mjs --workflow .github/workflows/docker-images.yml
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
```

- [ ] **Step 7: Commit immutable image construction**

```powershell
git add Dockerfile.api Dockerfile.web Dockerfile.runner .github/workflows/docker-images.yml scripts/release/verify-build-materials.mjs scripts/release/build-materials.test.mjs release/contracts/build-material-policy.v1.json release/contracts/schemas/build-material-observation.v1.schema.json release/contracts/repository-contract-files.v1.json
git commit -m "ci: build immutable api web runner images"
```

---

### Task 28: Generate and custody the external three-image build proof

**Files:**

- Create: `scripts/release/create-build-proof.mjs`
- Create: `scripts/release/verify-build-proof.mjs`
- Create: `scripts/release/build-proof.test.mjs`
- Create: `scripts/release/fixtures/build-proof.valid.json`
- Modify: `.github/workflows/docker-images.yml`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Produces: `createBuildProof(input): BuildProofV1` and `verifyBuildProof(input): BuildProofDecision`.
- `identity` contains API/Web/Runner platform digests, source SHA, migration catalog hash, repository contract digest, and Schema version. `provenance` contains generation time, protected CI/attestation references, fixed checkout, resolved base images, builder/actions/dependency materials, and registry observation evidence.
- Only the protected final aggregation job outside Runner can issue and custody this proof; Runner can only verify it against the trusted launch attestation.

- [ ] **Step 1: Write RED build-proof identity and trust-root tests**

Run: `node --test scripts/release/build-proof.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `create-build-proof.mjs`.

- [ ] **Step 2: Implement canonical proof creation from Task 27 observations**

```js
export function createBuildProof({
  sourceSha,
  images,
  migrationCatalog,
  repositoryContract,
  provenance
}) {
  assertExactlyThreeImages(images, ["api", "web", "runner"]);
  assertOneSourceRevision(images, sourceSha);
  return validateAndFreeze("build-proof.v1", {
    identity: buildIdentity({ sourceSha, images, migrationCatalog, repositoryContract }),
    provenance
  });
}
```

- [ ] **Step 3: Implement external verification and custody**

Verify protected workflow/attestation authority, registry-resolved platform subjects, fixed checkout and contract digests, then store the proof content-addressed through Task 4. Runner has no signing key or proof-issuance command.

- [ ] **Step 4: Enforce bundle immutability and scoped execution**

A Runner-only change creates a new trusted build run and complete proof. `migration-schema` may start only Runner and API Schema dependencies but cites the same complete proof and cannot become a partial promotable bundle.

- [ ] **Step 5: Run named negative proof cases**

Run: `node --test scripts/release/build-proof.test.mjs`

Expected: PASS with `BUILD_PROOF_TAG_IDENTITY_FORBIDDEN`, `BUILD_PROOF_MIXED_SOURCE`, `BUILD_PROOF_PARTIAL_BUNDLE`, `BUILD_PROOF_UNTRUSTED_ISSUER`, and `BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH` cases.

- [ ] **Step 6: Run contract/discovery/workflow gates**

```powershell
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-build-proof.mjs --fixture scripts/release/fixtures/build-proof.valid.json
git diff --check
```

- [ ] **Step 7: Commit external proof generation**

```powershell
git add scripts/release/create-build-proof.mjs scripts/release/verify-build-proof.mjs scripts/release/build-proof.test.mjs scripts/release/fixtures/build-proof.valid.json .github/workflows/docker-images.yml release/contracts/repository-contract-files.v1.json
git commit -m "ci: issue trusted three image build proof"
```

---

### Task 29: Verify digest-pinned final artifacts with Compose and a real client

**Files:**

- Create: `docker-compose.release-gate.yml`
- Create: `playwright.release.config.ts`
- Create: `tests/release/web-public-api.spec.ts`
- Create: `scripts/release/run-final-compose-gate.mjs`
- Create: `scripts/release/verify-compose-policy.mjs`
- Create: `scripts/release/compose-policy.test.mjs`
- Create: `release/contracts/schemas/final-compose-evidence.v1.schema.json`
- Modify: `apps/api/src/prisma/prisma.service.ts`
- Modify: `apps/api/test/prisma-service.spec.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `release/contracts/repository-contract-files.v1.json`

**Interfaces:**

- Compose inputs: registry-resolved API/Web/Runner digests, one build-proof digest, one chain-specific baseline Manifest, chain-specific exact database identities, and one non-sensitive API session nonce.
- Fresh and snapshot runs use distinct `operationId`, run ID, Manifest, database, and execution proofs.
- Web gate: HTTP health first, then Playwright 1.62.1 executing the built client's request logic and capturing the actual API request target.

- [ ] **Step 1: Add exact Playwright and policy dependencies**

Pin `@playwright/test` and the test image/runtime to 1.62.1. Add a policy test that rejects Compose `build`, source mounts, mutable image tags, Docker socket mounts, entrypoint/command override, privileged mode, or a supported exec path.

- [ ] **Step 2: Write RED API session-identity configuration tests**

```ts
it("binds the pool application_name to the manifest and session nonce", () => {
  expect(buildDatabaseApplicationName("manifest-ab12", "session-cd34")).toBe(
    "subscription-api/manifest-ab12/session-cd34"
  );
});
```

Run: `pnpm --filter @subscription-saas/api exec vitest run test/prisma-service.spec.ts`

Expected: FAIL because `buildDatabaseApplicationName` is not exported.

- [ ] **Step 3: Add the non-sensitive session identity to the API pool**

`PrismaService` requires `DATABASE_MANIFEST_ID` and `DATABASE_SESSION_NONCE` in the final gate and passes a length/charset-validated `application_name` to `pg.Pool`. It must not put database hostname, name, credential, customer data, or raw manifest content into the value. Existing non-Release environments retain the stable `subscription-api` fallback.

- [ ] **Step 4: Define capability-separated final Compose jobs**

Provision/restore prepares the target, migration applies the catalog, verify performs catalog/Schema checks, API starts with its runtime identity and Manifest/session environment, and database tests use runtime-equivalent identities. The controlled verify role receives catalog-only access plus the read-only PostgreSQL statistics role needed to inspect the API session; Runner is never started with all profiles at once and is not a resident service.

- [ ] **Step 5: Prove API database readiness and exact session identity**

After process health, call `GET /api/portal/catalog/model-definitions` and require a valid response. Then the verify role queries `pg_stat_activity`, `pg_database`, and `pg_stat_ssl` for the exact Manifest/session `application_name` and asserts database OID, runtime role, TLS policy, API session state, and nonce all match the chain Manifest. Zero or multiple mismatched sessions returns `API_DATABASE_SESSION_IDENTITY_MISMATCH`; a listening port or valid empty response alone is insufficient.

```sql
SELECT d.oid::text AS database_oid,
       a.usename,
       a.application_name,
       COALESCE(s.ssl, false) AS tls
FROM pg_stat_activity AS a
JOIN pg_database AS d ON d.datname = a.datname
LEFT JOIN pg_stat_ssl AS s ON s.pid = a.pid
WHERE a.datname = current_database()
  AND a.application_name = $1;
```

- [ ] **Step 6: Exercise Web's actual public API request path**

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

- [ ] **Step 7: Run independent fresh and snapshot gates**

```powershell
node scripts/release/run-final-compose-gate.mjs --chain fresh --build-proof-file .release-inputs/build-proof.json
node scripts/release/run-final-compose-gate.mjs --chain snapshot --build-proof-file .release-inputs/build-proof.json --snapshot-metadata-file .release-inputs/snapshot-metadata.json
```

Expected: both use the same image digests/source/contracts but have separate target identities, Manifests, API session nonces, operation IDs, post-state observations, execution proofs, custody receipts, and complete test counts.

- [ ] **Step 8: Test wrong-database and legal retry semantics**

First point API at a second database with the same Schema while keeping the expected target Manifest; the catalog call may succeed, but session verification must fail with `API_DATABASE_SESSION_IDENTITY_MISMATCH`. Then force an infrastructure failure before database writes, retain its proof, and rerun the complete failed stage with a new run/operation ID against the same immutable bundle. Reject replacement images, overwritten proof, or aggregation across different snapshot/test-contract versions.

- [ ] **Step 9: Commit final-artifact verification**

```powershell
pnpm exec playwright test --config playwright.release.config.ts
node --test scripts/release/compose-policy.test.mjs
node scripts/release/verify-compose-policy.mjs docker-compose.release-gate.yml
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
git diff --check
git add docker-compose.release-gate.yml playwright.release.config.ts tests/release scripts/release release/contracts apps/api/src/prisma/prisma.service.ts apps/api/test/prisma-service.spec.ts package.json pnpm-lock.yaml
git commit -m "ci: verify final release bundle end to end"
```

---

### Task 30: Aggregate Release evidence and audit S1 exit criteria

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
- API runtime negative allowlist/SBOM, catalog query, and exact Manifest/session `pg_stat_activity` database identity evidence pass;
- one build proof covers API/Web/Runner; final Compose and real-client API-base checks pass;
- no S1 change adds business models, enums, RBAC permissions, migrations, feature flags, customer/API/domain semantic changes, or S2/S3 behavior.

- [ ] **Step 5: Run the complete local/pre-merge verification set**

```powershell
git status --short
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:generate
pnpm lint
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm typecheck
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm test
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm build
pnpm --filter @subscription-saas/release-foundation test
pnpm --filter @subscription-saas/release-runner test
pnpm release:contracts:verify
node scripts/release/discover-database-tests.mjs --mode verify
node scripts/release/verify-api-governance-inventory.mjs
node scripts/release/verify-compose-policy.mjs docker-compose.release-gate.yml
node scripts/release/audit-s1-exit.mjs --evidence-dir .release-evidence
git diff --check
```

Expected: the Task 0 record still identifies the exact controlled target, no migration or Schema drift exists, all tests/builds pass, both chain evidence sets are in trusted custody, and the exit audit reports no P0/P1. A missing/mismatched controlled record stops the gate; it never falls back to ambient configuration.

- [ ] **Step 6: Commit the aggregate gate and publish the review report**

```powershell
git add .github/workflows/release-candidate-gate.yml scripts/release release/contracts docs/operations docs/acceptance
git commit -m "ci: aggregate stage1 s1 release evidence"
git status --short --branch
```

Open the final S1 review with the exact source SHA, build-proof digest, API/Web/Runner digests, migration/repository/test/snapshot contract digests, proof/custody links, full test counts, API runtime inventory result, and remaining P2/non-blocking observations. Do not mark S1 complete until that review is explicitly approved.

---

## Specification Coverage Matrix

| Approved S1 requirement                                                        | Implementation tasks |
| ------------------------------------------------------------------------------ | -------------------- |
| Offline-safe implementation target; no ambient database                        | 0-3                  |
| A+ immutable three-image bundle and external trust root                        | 1, 10-12, 27-30      |
| Build identity/provenance and capability-scoped execution                      | 1, 10-12, 27-28      |
| Closed JSON command registry, handler parity, one credential profile           | 10, 16-25            |
| Verifiable approval authority, binding, expiry and revocation                  | 11, 16, 19-25        |
| Stable baseline Manifest, deterministic plans, TOCTOU, UNKNOWN recovery        | 10-12, 16-25         |
| Content-addressed proof custody and 180-day governance                         | 4, 13, 28, 30        |
| Full-repository database discovery, unified launcher, isolation and zero skips | 2-9                  |
| PostgreSQL 17 fresh and sanitized snapshot upgrade chains                      | 0, 3-9, 13-14, 29-30 |
| Snapshot sanitization, ownership normalization, expiry and scanning            | 13-14                |
| Bidirectional API tooling inventory and per-command behavior equivalence       | 15-25                |
| API runtime extraction and negative allowlist                                  | 26                   |
| Final Compose, exact API database session identity and real Web/API request    | 29                   |
| Release aggregation, retry rules and S1 exit audit                             | 30                   |

## Stop and Rollback Rules

| Condition                                                                                         | Required response                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending migration, Schema drift, unknown database/cluster identity, or dirty overlapping worktree | Stop before the task; do not mutate the target                                                                                                     |
| Ambient `DATABASE_URL` or repository `.env` would be used                                         | Stop before process launch; use Task 0/controlled-target wrapper only                                                                              |
| A task exceeds the approved size bound or reveals a new business semantic decision                | Split the task and obtain plan/spec approval                                                                                                       |
| Proof/digest/target/capability mismatch                                                           | Fail before credential read or database connection; launcher records `PREFLIGHT_REJECTED`                                                          |
| Approved plan changes before apply                                                                | Refuse apply with `PLAN_CHANGED_SINCE_APPROVAL`; repeat dry-run and approval                                                                       |
| Process loss with uncertain commit                                                                | Record `INTERRUPTED_UNKNOWN`; forbid new apply; reconcile with the same idempotency key                                                            |
| Evidence custody upload/readback failure                                                          | Keep the database and evidence workspace; do not aggregate or clean up                                                                             |
| Final gate failure caused by infrastructure                                                       | Preserve failure proof; rerun the complete failed stage with a new operation/run ID against the same bundle                                        |
| Image or contract input must change                                                               | Invalidate the attempted Release set and produce a new trusted build proof                                                                         |
| API rollback requested after migration                                                            | Allow only with compatibility proof; database restore requires stopped writes, verified restore, explicit loss window, and separate human approval |

## S1 Completion Boundary

S1 is ready for approval only after Task 30 produces a successful, reviewable evidence set and the S1 exit review is explicitly approved. That approval permits the subsequent S2 specification/planning decision under the main ADR. It does not itself deploy Staging, promote a Release Candidate, create the S3 mature-order fixture, or begin Stage 1 human acceptance.
