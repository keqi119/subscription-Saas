# Stage 2 Archive And Return Workspace Recovery Implementation Plan

> Execute sequentially in the current agent. Do not use subagents.

## Task 1: Stage 2 archive recovery

**Files**

- Modify `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts`
- Modify `apps/api/src/storage/storage.service.ts`
- Modify `apps/api/test/fadada-archive.spec.ts`
- Modify `apps/api/test/stage2-handover-esign-archive.spec.ts`

**Steps**

1. Add failing tests for adopting a task-bound signed PDF, rejecting a foreign
   object key, enforcing PDF/size checks, and phase-specific failure codes.
2. Add a storage identity resolver for an existing signed-artifact object.
3. Implement bounded validation, hashing, and transactional typed archive
   completion before the provider-download path.
4. Keep missing or invalid historical objects on the normal provider path.
5. Run the focused archive tests.

## Task 2: Renderer version binding

**Files**

- Modify `apps/api/src/handover-work-order/stage2-handover-source-artifact.ts`
- Modify `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify related Stage 2 source/PDF tests

**Steps**

1. Add failing tests for persisted renderer metadata, deterministic identity,
   and legacy unsigned-source rejection.
2. Add the current renderer version and include it in source metadata and
   identity.
3. Require the current version only when selecting a reusable unsigned source.
4. Preserve historical active/signed task lifecycle validation.
5. Run focused source, readiness, archive, and PDF tests.

## Task 3: Return workspace staging

**Files**

- Modify `apps/web/src/lib/admin-order-workspace.ts`
- Modify `apps/web/src/app/orders/[id]/page.tsx`
- Modify `apps/web/test/admin-order-workspace.spec.ts`
- Modify `apps/web/test/stage2-handover-ui-flow.spec.ts`

**Steps**

1. Add failing state-machine and source-contract tests for hidden, entry,
   workflow, and completed states.
2. Add a pure return workspace state helper.
3. Skip return API calls until delivery is complete.
4. Render the compact entry before a record exists and make confirmed returns
   read-only.
5. Run focused Web tests and typecheck.

## Task 4: Operational defaults and verification

**Files**

- Modify API environment/deployment examples as needed
- Update operational documentation as needed

**Steps**

1. Document the required workflow and worker variables without changing
   production defaults implicitly.
2. Run formatting checks on changed files.
3. Run API and Web lint, typecheck, focused tests, full API tests, and the
   repository quality gate.
4. Review the diff for unrelated changes.
5. Commit, push, open a PR, wait for required checks, and merge.
6. After the new images are deployed, enable the worker variables and verify
   the historical order reaches `ARCHIVED` with the signed PDF selected.
