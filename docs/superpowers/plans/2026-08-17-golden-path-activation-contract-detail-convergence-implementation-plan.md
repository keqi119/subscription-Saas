# Golden Path Activation and Contract Detail Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore authoritative activation after an approved Stage 2 handover and make archived Stage 1 contract e-sign results and signed PDFs visible to authorized Admin users.

**Architecture:** Make Stage 2 archive finalization atomically converge the handover, e-sign task, and handover contract onto the same signed artifact. Compare evidence hashes through one strict SHA-256 normalizer, repair existing convergent records with an idempotent migration, and align e-sign contract scope with the system's uppercase role codes. The Admin contract page must represent e-sign loading failure separately from a successful empty task list.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, TypeScript 6, Vitest 4, Next.js 16, React 19, Ant Design 6, pnpm workspace.

## Global Constraints

- Preserve `DELIVERY_EVIDENCE_DECISION`; no automatic approval or bypass.
- Do not recreate or replace completed Fadada tasks or signed PDFs.
- The migration may only converge complete archived Stage 2 handovers with an existing signed file and live linked contract.
- Invalid or missing SHA-256 values must remain unequal.
- Keep restricted sales ownership checks; only correct the existing all-order role semantics.
- Never convert an e-sign API error into an empty successful task list.
- Use TDD for every behavior change and commit each independently testable task.

---

### Task 1: Align contract e-sign access scope and expose load failures

**Files:**
- Modify: `apps/api/src/esign/esign.service.ts:3529-3543`
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts:990-1005`
- Modify: `apps/api/test/esign.spec.ts`
- Modify: `apps/api/test/fadada-archive.spec.ts`
- Modify: `apps/web/src/app/contracts/[id]/page.tsx:382-430,632-706`
- Modify: `apps/web/test/contracts-detail-esign-display.spec.ts`

**Interfaces:**
- Consumes: `RequestUser.roles`, whose values are uppercase Prisma `RoleCode` strings.
- Produces: `canViewAllOrders(user: RequestUser): boolean` semantics accepting `ADMIN`, `GM`, `OP`, `RC`, `FI`, `AS`, or `order:view:all`; `eSignTasksError: string | null` UI state.

- [ ] **Step 1: Write failing API access tests**

Add tests proving that uppercase `ADMIN` can call `listTasksForContract`, a matching sales owner can call it, and an unrelated restricted user is rejected:

```ts
it("lets uppercase ADMIN read contract e-sign tasks", async () => {
  const { service } = createESignFixture();
  await expect(
    service.listTasksForContract("contract-1", {
      ...adminUser(),
      permissions: ["contract:view"],
      roles: ["ADMIN"]
    })
  ).resolves.toEqual(expect.any(Array));
});

it("keeps restricted contract e-sign access scoped to the owning sales user", async () => {
  const { service } = createESignFixture();
  await expect(
    service.listTasksForContract("contract-1", {
      ...adminUser(),
      id: "user-other",
      permissions: ["contract:view"],
      roles: ["SALES"]
    })
  ).rejects.toBeInstanceOf(NotFoundException);
});
```

Update the signed-artifact preview fixture to use `roles: ["ADMIN"]` so the preview test exercises production role casing.

- [ ] **Step 2: Run the API tests and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/esign.spec.ts test/fadada-archive.spec.ts
```

Expected: uppercase `ADMIN` access fails before the role fix.

- [ ] **Step 3: Implement the minimal access fix**

Use the same all-order role set as `OrderService` in both e-sign access helpers:

```ts
const ALL_ORDER_ROLE_CODES = new Set(["ADMIN", "GM", "OP", "RC", "FI", "AS"]);

function canViewAllOrders(user: RequestUser) {
  return (
    user.roles.some((role) => ALL_ORDER_ROLE_CODES.has(role)) ||
    user.permissions.includes("order:view:all")
  );
}
```

Do not alter the owner comparison for restricted users.

- [ ] **Step 4: Write failing Web source-contract tests**

Extend `contracts-detail-esign-display.spec.ts` to require separate error state and forbid silent fallback:

```ts
it("does not disguise e-sign request failures as an empty task list", () => {
  expect(source).not.toContain(".catch(() => [])");
  expect(source).toContain("eSignTasksError");
  expect(source).toContain("电子签任务加载失败");
  expect(source).toContain("重新加载");
});
```

- [ ] **Step 5: Run the Web test and verify RED**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/contracts-detail-esign-display.spec.ts
```

Expected: FAIL because the page currently uses `.catch(() => [])` and has no error state.

- [ ] **Step 6: Implement explicit e-sign loading state**

Add `eSignTasksError`, load the task request in its own `try/catch`, and render an `Alert` above the task list:

```tsx
const [eSignTasksError, setESignTasksError] = useState<string | null>(null);

async function loadESignTasks(contractId: string) {
  try {
    const tasks = await apiFetch<ContractESignTask[]>(`/contracts/${contractId}/esign-tasks`);
    setESignTasks(tasks);
    setESignTasksError(null);
  } catch (error) {
    setESignTasks([]);
    setESignTasksError(getErrorMessage(error));
  }
}
```

Render `Alert` with message `电子签任务加载失败`, a safe description, and a `重新加载` button calling `loadESignTasks(params.id)`. Only render the `Empty` state when `eSignTasksError === null`.

- [ ] **Step 7: Run focused API and Web tests and verify GREEN**

Run both commands from Steps 2 and 5. Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/api/src/esign/esign.service.ts apps/api/src/esign/fadada/fadada-signed-artifact.service.ts apps/api/test/esign.spec.ts apps/api/test/fadada-archive.spec.ts apps/web/src/app/contracts/[id]/page.tsx apps/web/test/contracts-detail-esign-display.spec.ts
git commit -m "fix: restore archived contract esign visibility"
```

### Task 2: Normalize authoritative evidence SHA-256 comparison

**Files:**
- Modify: `apps/api/src/lease/lease-activation.engine.ts:614-623`
- Modify: `apps/api/test/lease-activation.spec.ts`

**Interfaces:**
- Produces: `normalizeSha256(value: unknown): string | null` and strict `sameManifest(metadata, manifestHash)` comparison.
- Consumed by: authoritative activation evaluation only.

- [ ] **Step 1: Write failing manifest-format tests**

Add fixture fields `handoverManifestHash` and `approvedManifestHash`, and use them in the handover and work-order builders. Add:

```ts
it("accepts equivalent prefixed and case-variant approved evidence hashes", async () => {
  const digest = "a".repeat(64);
  const harness = createHarness({
    approvedManifestHash: `sha256:${digest.toUpperCase()}`,
    handoverManifestHash: digest
  });

  await expect(harness.engine.evaluate(harness.orderId)).resolves.toEqual({
    canActivate: true,
    missingConditions: []
  });
});

it.each([null, "", "sha256:not-a-digest", "b".repeat(64)])(
  "rejects non-matching approved evidence hash %s",
  async (approvedManifestHash) => {
    const harness = createHarness({ approvedManifestHash });
    const result = await harness.engine.evaluate(harness.orderId);
    expect(result.missingConditions).toContain("HANDOVER_EVIDENCE_NOT_APPROVED");
  }
);
```

- [ ] **Step 2: Run the lease activation test and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/lease-activation.spec.ts
```

Expected: prefixed/case-variant digest is rejected.

- [ ] **Step 3: Implement strict normalization**

```ts
function normalizeSha256(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^sha256:/i, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function sameManifest(metadata: Prisma.JsonValue, manifestHash?: string | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const approved = normalizeSha256(metadata.journeyEvidenceManifestHash);
  const archived = normalizeSha256(manifestHash);
  return approved !== null && archived !== null && approved === archived;
}
```

- [ ] **Step 4: Run the lease activation test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/lease/lease-activation.engine.ts apps/api/test/lease-activation.spec.ts
git commit -m "fix: normalize approved handover manifest hashes"
```

### Task 3: Atomically converge the Stage 2 handover contract

**Files:**
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts:742-794`
- Modify: `apps/api/test/fadada-archive.spec.ts:319-389` and its fake Prisma fixture

**Interfaces:**
- Consumes: `input.handover.handoverContractId`, created signed `FileObject.id`, and `archivedAt`.
- Produces: an archived Stage 2 `Contract` whose `fileId` equals `VehicleDeliveryHandover.signedDocumentFileId`.

- [ ] **Step 1: Change the Stage 2 archive test to require contract convergence**

Replace the previous expectation that the contract remains `SIGNED` with:

```ts
expect(state.contract).toMatchObject({
  archivedAt: state.handover?.archivedAt,
  fileId: state.handover?.signedDocumentFileId,
  signedAt: contractSignedAt,
  status: ContractStatus.ARCHIVED,
  updatedBy: "user-admin"
});
```

Add a failure test that makes the fake `contract.updateMany` return `{ count: 0 }` and asserts the archive rejects with `STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH`.

- [ ] **Step 2: Run the Fadada archive test and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-archive.spec.ts
```

Expected: contract remains `SIGNED`, so convergence assertions fail.

- [ ] **Step 3: Extend the fake Prisma transaction**

Add `contract.updateMany` to the fixture. It must update only the row matching `id`, `deletedAt: null`, and the current handover contract identity, returning the updated count.

- [ ] **Step 4: Implement contract update in the archive transaction**

After the guarded handover update succeeds, update exactly the linked contract:

```ts
const convergedContract = await tx.contract.updateMany({
  data: {
    archivedAt,
    fileId: fileObject.id,
    signedAt: input.task.contract.signedAt ?? input.task.completedAt ?? archivedAt,
    status: ContractStatus.ARCHIVED,
    updatedBy: input.actorId ?? null
  },
  where: {
    deletedAt: null,
    id: input.handover.handoverContractId,
    orderId: input.handover.orderId
  }
});
if (convergedContract.count !== 1) {
  throw new Error(STAGE2_HANDOVER_ARCHIVE_SOURCE_MISMATCH);
}
```

Preserve an existing non-null `signedAt`: fetch it with the claimed handover/task state or use an update expression that only supplies the fallback when null. Do not replace an authoritative earlier signature timestamp.

- [ ] **Step 5: Run archive and Stage 2 workflow tests and verify GREEN**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/fadada-archive.spec.ts test/stage2-handover-esign-archive.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/src/esign/fadada/fadada-signed-artifact.service.ts apps/api/test/fadada-archive.spec.ts
git commit -m "fix: converge stage2 handover contract archive"
```

### Task 4: Repair already archived Stage 2 contracts

**Files:**
- Create: `apps/api/prisma/migrations/20260817010000_stage2_handover_contract_archive_convergence/migration.sql`
- Create: `apps/api/test/stage2-handover-contract-convergence-schema.spec.ts`

**Interfaces:**
- Consumes: complete `vehicle_delivery_handover` archive tuples and linked `file_object`/`contract` rows.
- Produces: idempotently converged `contract.status`, `contract.archived_at`, and `contract.file_id`.

- [ ] **Step 1: Write a failing migration contract test**

```ts
const migrationPath = join(
  process.cwd(),
  "prisma/migrations/20260817010000_stage2_handover_contract_archive_convergence/migration.sql"
);

it("converges only complete archived handover contracts onto the signed file", () => {
  const sql = readFileSync(migrationPath, "utf8");
  expect(sql).toContain('UPDATE "contract"');
  expect(sql).toContain('FROM "vehicle_delivery_handover"');
  expect(sql).toContain('"signed_document_file_id"');
  expect(sql).toContain('"archive_status" = \'ARCHIVED\'');
  expect(sql).toContain('"status" = \'ARCHIVED\'');
  expect(sql).toContain('"deleted_at" IS NULL');
  expect(sql).toContain('EXISTS');
});
```

- [ ] **Step 2: Run the migration test and verify RED**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-contract-convergence-schema.spec.ts
```

Expected: FAIL because the migration does not exist.

- [ ] **Step 3: Write the guarded idempotent SQL migration**

Use one `UPDATE ... FROM` guarded by complete archive facts and an existing signed file:

```sql
UPDATE "contract" AS c
SET
  "status" = 'ARCHIVED',
  "signed_at" = COALESCE(c."signed_at", h."completed_at", h."archived_at"),
  "archived_at" = h."archived_at",
  "file_id" = h."signed_document_file_id",
  "updated_at" = CURRENT_TIMESTAMP
FROM "vehicle_delivery_handover" AS h
WHERE c."id" = h."handover_contract_id"
  AND c."deleted_at" IS NULL
  AND h."deleted_at" IS NULL
  AND h."status" = 'ARCHIVED'
  AND h."archive_status" = 'ARCHIVED'
  AND h."archived_at" IS NOT NULL
  AND h."signed_document_file_id" IS NOT NULL
  AND h."signed_object_key" IS NOT NULL
  AND h."signed_pdf_hash" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "file_object" AS f
    WHERE f."id" = h."signed_document_file_id" AND f."deleted_at" IS NULL
  )
  AND (
    c."status" <> 'ARCHIVED'
    OR c."archived_at" IS DISTINCT FROM h."archived_at"
    OR c."file_id" IS DISTINCT FROM h."signed_document_file_id"
  );
```

Do not update Journey, work-order, e-sign-task, or file rows.

- [ ] **Step 4: Run schema, Prisma validation, and migration status tests**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/stage2-handover-contract-convergence-schema.spec.ts
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: test PASS, Prisma schema valid, local database reports the new migration pending before deploy.

- [ ] **Step 5: Apply the migration locally and verify idempotency**

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma migrate deploy --schema prisma/schema.prisma
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected: first deploy applies one migration, second deploy applies none, schema is up to date.

- [ ] **Step 6: Commit**

```powershell
git add apps/api/prisma/migrations/20260817010000_stage2_handover_contract_archive_convergence/migration.sql apps/api/test/stage2-handover-contract-convergence-schema.spec.ts
git commit -m "fix: repair archived stage2 contract pointers"
```

### Task 5: Full verification and handoff

**Files:**
- Verify only; modify earlier files only if a failing check exposes an in-scope defect.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a clean branch ready for review, PR, deployment, and Staging Golden Path continuation.

- [ ] **Step 1: Run all focused regressions**

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/esign.spec.ts test/fadada-archive.spec.ts test/lease-activation.spec.ts test/stage2-handover-esign-archive.spec.ts test/stage2-handover-contract-convergence-schema.spec.ts
pnpm --filter @subscription-saas/web exec vitest run test/contracts-detail-esign-display.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

```powershell
pnpm prisma:validate
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff and migration scope**

```powershell
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors, only approved files changed, clean worktree.

- [ ] **Step 4: Commit any verification-only corrections**

If Step 2 required an in-scope correction, stage only the corrected files and commit:

```powershell
git commit -m "test: complete activation convergence verification"
```

- [ ] **Step 5: Prepare Staging acceptance sequence**

After PR merge and deployment:

1. run Prisma migration deploy and confirm schema up to date;
2. open `CON20260814085019DZ64` and verify the completed Stage 1 task plus signed PDF;
3. retry the failed `AUTHORITATIVE_ACTIVATION` step for `ORD20260814085019DMGZ`;
4. verify Journey and authoritative aggregates complete once, without duplicate manual tasks or entitlements.
