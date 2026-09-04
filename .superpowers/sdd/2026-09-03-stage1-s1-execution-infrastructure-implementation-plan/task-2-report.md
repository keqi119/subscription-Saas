# Task 2 report

## Result

Added ten closed v1 routing, producer-proof, infrastructure-change, and external-approval schemas. They are discovered by the existing schema registry and included in the protected repository-contract manifest. The new external approval verifier accepts only a policy-pinned Ed25519 issuer/key, verifies the canonical signed approval, expected bindings, expiry, signed current revocation response, rollback sequence, and immutable custody readback. It has no credential or connection interface and never consumes a caller-provided `verified` flag.

`create-infrastructure-change.mjs` is canonical, exclusive-create, recomputes the repository contract digest, and generates its 128-bit lowercase hexadecimal ID locally. It allocates no attempt/run identity.

## Evidence

- RED: `snapshot-routing-contracts.test.mjs` initially failed 2/2 with `CONTRACT_SCHEMA_UNREGISTERED`.
- GREEN: final focused suite passed 21/21 tests (including signed approval, signed current revocation, rollback, expiry, binding, and immutable-custody negative cases).
- `pnpm release:contracts:verify`: PASS; 126 migrations, 44 schemas, 134 protected files.
- `git diff --check`: PASS.

## Interfaces and boundaries

- The identity schema is stable and closed; observation and terminal facts are separate closed contracts.
- Snapshot admission excludes a post-approval observation. Producer completion excludes producer workflow/custody terminal facts; the later terminal observation owns run/job conclusions and API/custody readbacks.
- Existing `approval.mjs` database/GitHub attestation semantics were not changed. The new verifier is resource-mutation-only and cannot stand in for dispatch, capability, deployment, credential, or database-command approval.

## Risks / later ownership

Unit tests use synthetic Ed25519 keys and injected readback clients only; this is not evidence that I0/custody/GitHub infrastructure is installed. Task 3 owns policy/admission construction and verification; Task 15 owns the independent producer terminal control-plane readback.

## FIX ROUND1 — completed verification, 2026-09-04

This appendix supersedes the original report's unsupported coverage claims. The original 21-test run did **not** establish the review's revoked-operation, invalid-custody, terminal-negative, or valid generator behavior cases. The initial fix commit `cae6d86f` was also incomplete: its custom timestamp format remained disabled, its generator trusted stale local `main`, and several negative cases were still absent. This round completes those fixes against Task2 base `e9433dd5`; no published pre-Task2 schema is changed.

### Findings addressed

1. The new, unreleased external approval schema now requires signed `subjectDigest`. Future approval creators must compute it as `sha256Canonical(subject)` and include it in the signed payload. Verification recomputes that same subject digest, checks the trusted expected subject and digest, and rejects absent, inconsistent, or cross-attempt/bootstrap bindings before readbacks. This digest is derived data, not another caller-selected authority.
2. `trust.approverImmutableId` is mandatory and must equal the signed approver. Missing/different authority fails before readbacks. Optional plan-author/workflow-actor labels neither grant authority nor impose an unapproved two-person rule: the correctly policy-pinned approver can also be the author/actor.
3. Six new timestamp-bearing schemas opt into the executable `rfc3339Finite` keyword. It requires a finite, real UTC RFC3339 calendar/time value (the contracts already require `Z`) and rejects garbage dates, normalized February overflow, hour 24, and leap-second/nonfinite inputs. Published schemas retain their existing `validateFormats: false` behavior; a legacy build-proof regression confirms this. Merely registering a disabled format was removed.
4. Pending and approved-queued observations require corresponding deployment/review states, queued job state, and nonempty labels. Both valid baselines and individual cross-phase/job/labels/rerun mutations are exercised. Exact route-label equality and API authenticity remain runtime verification work, not authority conferred by these schemas.
5. The generator pins `refs/remotes/origin/main^{commit}`, the Task0 read-back source, never the user's stale `refs/heads/main`. Supplied SHA and HEAD must exactly match; tracked changes fail. Every computed protected-file hash, including the manifest, is compared to the raw Git blob at that pinned commit, catching assume-unchanged/checkout-byte mismatches; origin/main and cleanliness are checked again before creation. This is an offline check against the locally read-back ref, not proof of live remote freshness. The trusted caller must refresh/establish Task0's main readback before invoking it.
6. Filename/ID parity is enforced with exactly the two existing legacy filename aliases. Existing duplicate-ID error behavior is preserved. All 44 schemas still compile, and both mismatch and duplicate regressions pass; no old schema was renamed or edited.
7. Valid completion/terminal fixtures are validated before mutation. Completion rejects future workflow/current-custody/later-observation properties. Terminal shape rejects in-progress success, cancelled run, attempt 2, missing/extra/wrong job names, skipped/cancelled/UNKNOWN data and custody conclusions, absent API readback/digest/time, and absent custody readback. Real synthetic Ed25519 approval tests cover subject/approver authority, revoked operation, stale/invalid revocation, custody content/reference/immutability mismatch and unavailable readbacks. Generator fixtures exercise successful creation, canonical bytes, independently calculated Git-blob contract digest, distinct 32-hex IDs, exclusive creation preserving original bytes, malformed/nonexistent/old/unmerged/wrong-checkout/dirty/staged/assume-unchanged revisions and absent origin/main. No-output assertions cover every invalid case.
8. The real CLI subprocess path rejects absent, duplicate, unknown, empty, and flag-as-value options before any output. Ten malformed argv vectors and a valid invocation run against isolated local Git fixtures. Bare origins/checkout refs are created only inside temporary directories and cleaned up; no real repository refs, credentials, network, cloud, approval, DB, or workflow are mutated by these tests.

### RED and final GREEN evidence

Commands below were executed in `D:/Projects/auto-subscription-platform/.worktrees/stage1-s1-execution-infrastructure-20260903` by the finishing implementer unless explicitly labeled controller-reported.

- `node --test scripts/release/create-infrastructure-change.test.mjs`: RED 3 passed / 9 failed against the partial guard (valid origin/main incorrectly rejected; stale-main and malformed CLI behavior exposed); after the fix, GREEN 12/12.
- `node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs`: RED 5 passed / 2 failed, specifically accepting `2026-99-99TgarbageZ`. After the executable keyword fix, routing plus registry ran GREEN 15/15.
- `node --test packages/release-foundation/test/external-change-approval.test.mjs`: RED 0/2 when signed `subjectDigest` was not yet admitted; then 1/2 with the valid pinned author/actor wrongly rejected; then 1/2 when a signed inconsistent subject digest reached custody rather than failing the subject binding. After schema/verifier fixes, GREEN 2/2 (multiple explicit negative assertions inside the signed-fixture test).
- `node --test packages/release-foundation/test/schema-registry.test.mjs`: RED 8 passed / 1 failed when filename parity masked the existing duplicate-ID error. Reordered validation before the final full GREEN run.

Final complete required Task2 suite:

```powershell
node --test packages/release-foundation/test/snapshot-routing-contracts.test.mjs packages/release-foundation/test/external-change-approval.test.mjs packages/release-foundation/test/schema-registry.test.mjs packages/release-foundation/test/catalogs.test.mjs scripts/release/create-infrastructure-change.test.mjs
```

Result: exit 0; **40 tests, 40 passed, 0 failed, 0 skipped, 0 cancelled**. These are Node test counts, not an inflated count of individual table mutations.

```powershell
pnpm release:contracts:verify
pnpm release:database-tests:discover
```

Both exit 0. Contract verification: 126 migrations, 44 schemas, 134 protected files, 13 command contracts; repository contract digest `sha256:23af5e899af7633ca178be650691ea2f2e18daf16343ffc4129e87a85f05c47a`. Discovery: 92 candidates, 36 manifested, 56 excepted, 0 unclassified.

Changed-file formatting and whitespace commands:

```powershell
$task2ChangedFiles = @(git diff --name-only e9433dd5)
pnpm exec prettier --check @task2ChangedFiles .superpowers/sdd/2026-09-03-stage1-s1-execution-infrastructure-implementation-plan/task-2-report.md
git diff --check
```

Results: both exit 0; Prettier reports “All matched files use Prettier code style!”, and `git diff --check` emits no errors.

Controller-reported preflight (Resume 11:21Z, not rerun here):

```powershell
node scripts/release/with-controlled-target.mjs --profile migrate -- pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
node scripts/release/with-controlled-target.mjs --profile verify -- pnpm prisma:validate
```

Controller reports exit 0, 126 migrations, “Database schema is up to date”, and valid Prisma schema. No ambient Prisma invocation was made in this fix completion round.

### Remaining trust boundaries and handoff

The terminal tests establish **schema structure only**, not that any supplied IDs, names, conclusions, API response digest/time, custody reference, source SHA, or run identity were observed from GitHub. Task15 must independently retrieve actual run/jobs, compare exact job IDs/job set and run attempt against the admitted run/completion, enforce freshness and bindings, and verify custody; a structurally valid caller assertion is not accepted runtime evidence. Task3 still owns exact immutable repository/reviewer/workflow and routing policy enforcement. No Task15 runtime verifier, I0 installation, external qualification, Task30, or real approval was performed here.

Changed scope: the Task2 approval verifier, registry, approval/routing/registry tests, six new timestamp-bearing schemas, generator and generator tests, and this report. No business logic, migrations, old proof schema, or runtime architecture was changed. Next step is controller's scoped re-review of `e9433dd5..HEAD` before accepting Task2.
