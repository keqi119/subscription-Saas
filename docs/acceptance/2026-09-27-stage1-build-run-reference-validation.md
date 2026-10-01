# Stage1 Task 2 run-reference compatibility report

Worktree: `D:/Projects/auto-subscription-platform/.worktrees/stage1-r22-launcher-20260926`
Branch/base: `feat/stage1-r22-launcher-20260926` / `900b978bc55d8a4c2e7d399d1ce47764251ad970`
Scope: exactly `.github/workflows/docker-images.yml`, `scripts/release/verify-build-delivery.mjs`, and `scripts/release/verify-build-delivery.test.mjs`.

## Changes

- The build workflow now sets `BUILD_RUN_REF` to `https://github.com/<repository>/actions/runs/<run-id>` before material and proof creation.
- Delivery verification accepts only the exact historical `github://...` or new HTTPS reference derived from expected repository/run ID, and requires proof and material to carry the same reference. Shared identity assertions and the manual consumer remain unchanged.
- Tests cover HTTPS acceptance and bind it to the workflow's projected `BUILD_RUN_REF`; existing fixture covers legacy acceptance. Both results remain `authorityCustody=INPUT_REQUIRED` and `promotionEligible=false`. Mixed forms and HTTP, foreign host/repository, wrong run, extra path, and query are rejected.

## Commands and outcomes

- `node --test --test-name-pattern="accepts the HTTPS workflow run reference" scripts/release/verify-build-delivery.test.mjs` (RED, before implementation): exit 1; expected `BUILD_DELIVERY_RUN_MISMATCH`.
- `node --test scripts/release/verify-build-delivery.test.mjs` (first post-implementation attempt): exit 1, 76 pass / 7 fail. New malformed-ref cases reached the existing `assertBuildIdentity` first and reported `BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH`; test fixture was then corrected to update its bound material digest while preserving the shared assertion.
- `pnpm exec prettier --check .github/workflows/docker-images.yml scripts/release/verify-build-delivery.mjs scripts/release/verify-build-delivery.test.mjs` (before formatting): exit 1; only the test file required formatting. `pnpm exec prettier --write scripts/release/verify-build-delivery.test.mjs`: exit 0. Repeated scoped Prettier check: exit 0.
- Stable-byte gate `node --test scripts/release/verify-build-delivery.test.mjs`: exit 0, 83 tests passed, 0 failed.
- `node --check scripts/release/verify-build-delivery.mjs`: exit 0.
- `node --check scripts/release/verify-build-delivery.test.mjs`: exit 0.
- `git diff --check`: exit 0.

The root-owned unchanged-source Prisma preflight was reported as status exit 1 because DATABASE_URL/dotenv are unavailable, and `pnpm prisma:validate` exit 0; no business or schema changes were made. No full suite, cloud access, CI trigger, or producer activation was performed. H2 remains incomplete: no live trusted staging run has exercised this corrected producer.

## Fix 1: mixed run-reference review correction

- Review found the prior mixed-reference test accidentally gave HTTPS to both proof and material because `materialRunRef` defaulted to `proofRunRef`. The test now explicitly supplies HTTPS for proof and legacy `github://` for material, and asserts the actual rejecting code.
- Focused RED command `node --test --test-name-pattern="rejects mixed proof and material run-reference representations" scripts/release/verify-build-delivery.test.mjs` with expected `BUILD_DELIVERY_RUN_MISMATCH`: exit 1. Actual error was `BUILD_PROOF_REGISTRY_SUBJECT_MISMATCH` at `verify-build-proof.mjs:81` through `assertBuildIdentity`, called by `verify-build-delivery.mjs:280`; this shared assertion explicitly requires `proof.provenance.ciRunRef === observation.ciRunRef`. The call precedes delivery-specific run-reference checks. Production constraints were left unchanged per scope.
- Focused GREEN with the precise existing shared-assertion code expected: same command, exit 0 (1 pass, 0 fail).
- `pnpm exec prettier --check scripts/release/verify-build-delivery.test.mjs`: exit 0. `git diff --check`: exit 0. No full file suite rerun as directed.
- Test file SHA256 after fix: `7E361BDF0A7444090F2F444110AFD5E2A4D4A6652127C0AE6D017291A8DAB6A5`.

## Review and integration

Independent task review found one mixed-representation fixture problem; the same reviewer approved its scoped correction after focused RED/GREEN. Production and historical compatibility logic stayed unchanged during that test correction. Source commits `e3e8749a4c71219773245591ea5e7c5c8d683a03` and `8adc39baa652dfef225874cdaf6ad4cc55a34d39` were integrated into the original Stage1 worktree as `ea3f6d6e` and `b7efeccc`. A three-file comparison against the reviewed head returned no difference. No duplicate 83-test run was performed after the test-only correction or byte-identical integration.

This closes only the approved run-reference compatibility defect. H2 private storage adapter/producer, independent identities/readbacks, trusted workflow execution and Stage1 closure remain incomplete.
