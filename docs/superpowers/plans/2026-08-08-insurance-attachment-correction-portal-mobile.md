# Insurance Attachment Correction and Portal Mobile Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct insurance policies and mutable attachments safely, eliminate Chinese upload filename mojibake, hide the Admin menu scrollbar, and replace squeezed Portal mobile tables with readable cards.

**Architecture:** A shared multipart boundary owns UTF-8 parsing and filename normalization, while each domain retains its existing storage and lifecycle model. Insurance policy deletion and policy-scoped document upload are enforced transactionally in `VehicleInsuranceService`; existing mutable attachment APIs are reused, and immutable evidence remains protected. Portal pages render the same fetched data through desktop tables and mobile card components selected by CSS at the existing 768px breakpoint.

**Tech Stack:** TypeScript 6, NestJS 11, Multer 2.1.1/Busboy 1.6, Prisma 7/PostgreSQL 17, Next.js 16/React 19, Ant Design 6, CSS Modules, Vitest 4, Node.js test runner, pnpm 11.

## Global Constraints

- Execute inline in the current main-Agent session; do not dispatch subagents.
- Work only in `D:/Projects/auto-subscription-platform/.worktrees/attachment-correction-portal-records-20260808` on `feat/attachment-correction-portal-records-20260808`.
- Use test-driven development: add one focused failing test, observe the intended failure, implement the minimum behavior, rerun the focused test, then commit.
- Do not physically delete stored attachment objects and do not rename or move bucket/object keys.
- Policy deletion is a reasoned soft delete; policies with claims or product-bound documents must return a typed 409 conflict.
- Submitted application evidence, payment/write-off evidence, delivery evidence, signed contracts, and audit evidence remain immutable; correction uses a new version or a void operation.
- Configuration sheets and inspection reports cannot be deleted while referenced by `VehicleListingSourceBinding`.
- Existing filename repair must be conservative, idempotent, auditable, and reversible; ambiguous values remain unchanged.
- Portal API contracts and billing/entitlement data models do not change.
- Portal uses `768px` as the mobile breakpoint; desktop tables remain available above the breakpoint.
- Preserve unrelated user files and do not modify the dirty primary checkout.
- Use the existing `AuditLog` model for policy/document mutation and filename-repair audit; do not introduce a generic attachment-center schema.
- The approved design is `docs/superpowers/specs/2026-08-08-insurance-attachment-correction-portal-mobile-design.zh-CN.md`.

---

## File and Responsibility Map

```text
apps/api/src/upload/
  upload-filename.ts                 pure filename normalization
  multipart-upload-options.ts       Multer UTF-8 boundary and wrapped fileFilter

scripts/
  repair-upload-filenames-core.mjs  pure mojibake detection and source registry
  repair-upload-filenames.mjs       dry-run/apply/rollback database executor

apps/api/src/vehicle-insurance/
  dto/vehicle-insurance.dto.ts      delete and policy-upload DTOs
  vehicle-insurance.controller.ts   policy delete/upload HTTP contracts
  vehicle-insurance.service.ts      transactional lifecycle and storage cleanup
  vehicle-insurance.module.ts       AuditService dependency

apps/web/src/app/vehicle-insurance-policies/
  page.tsx                           list, drawer, upload and delete orchestration
  policy-delete-dialog.tsx           reasoned low-frequency delete dialog
  policy-document-panel.tsx          policy-scoped upload/list/delete UI

apps/web/src/components/vehicle-workspace/
  vehicle-documents-tab.tsx          per-file rights-document correction

apps/web/src/app/portal/entitlements/
  entitlement-records.tsx            desktop/mobile entitlement projections
  entitlement-records.module.css     responsive entitlement cards

apps/web/src/app/portal/bills/[id]/
  bill-records.tsx                   desktop/mobile payment/write-off projections
  bill-records.module.css            responsive billing cards

apps/web/src/components/
  protected-shell.module.css         hidden-but-scrollable menu viewport
```

The existing large pages continue to own data fetching and navigation. New presentation components receive already-loaded rows and do not initiate requests.

---

### Task 1: Shared UTF-8 Multipart and Safe Filename Boundary

**Files:**

- Create: `apps/api/src/upload/upload-filename.ts`
- Create: `apps/api/src/upload/multipart-upload-options.ts`
- Create: `apps/api/test/upload-filename.spec.ts`
- Create: `apps/api/test/multipart-upload-coverage.spec.ts`
- Modify: `apps/api/test/field-evidence-multipart.spec.ts`
- Modify: `apps/api/src/customer/customer.controller.ts`
- Modify: `apps/api/src/field-operator/field-evidence-upload-options.ts`
- Modify: `apps/api/src/mileage-review/mileage-review.controller.ts`
- Modify: `apps/api/src/portal/portal-application.controller.ts`
- Modify: `apps/api/src/portal/portal-mileage-review.controller.ts`
- Modify: `apps/api/src/portal/portal-profile-material.controller.ts`
- Modify: `apps/api/src/portal/portal-service-case.controller.ts`
- Modify: `apps/api/src/vehicle/vehicle-listing.controller.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.controller.ts`
- Modify: `apps/api/src/vehicle-baas/vehicle-baas.controller.ts`

**Interfaces:**

- Produces: `normalizeUploadFilename(value: string, fallback?: string): string`.
- Produces: `createUtf8MultipartOptions(options?: MulterOptions): MulterOptions`.
- Guarantees: every `AnyFilesInterceptor` in `apps/api/src` receives options with `defParamCharset: "utf8"`; an existing `fileFilter` is preserved and runs after filename normalization.

- [ ] **Step 1: Write failing filename normalization tests**

Add focused cases to `apps/api/test/upload-filename.spec.ts`:

```ts
import { describe, expect, it } from "vitest";

import { normalizeUploadFilename } from "../src/upload/upload-filename";

describe("normalizeUploadFilename", () => {
  it("keeps readable Chinese names and normalizes path/control input", () => {
    expect(normalizeUploadFilename("C:\\fakepath\\车辆行驶证.pdf\u0000")).toBe("车辆行驶证.pdf");
  });

  it("keeps an extension while bounding the result to 255 UTF-16 code units", () => {
    const result = normalizeUploadFilename(`${"车".repeat(300)}.pdf`);
    expect(result.endsWith(".pdf")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(255);
  });

  it("uses a safe fallback for an empty unsafe value", () => {
    expect(normalizeUploadFilename("C:\\fakepath\\\u0000", "upload")).toBe("upload");
  });
});
```

- [ ] **Step 2: Write a failing raw multipart UTF-8 test and coverage contract**

Extend the multipart test controller so a raw UTF-8 header filename is returned unchanged. Add a repository contract that enumerates every source file containing `AnyFilesInterceptor` and fails when it finds `AnyFilesInterceptor()` or a raw inline options object not wrapped by `createUtf8MultipartOptions`.

Core assertion:

```ts
expect(await response.json()).toMatchObject({ name: "车辆行驶证.pdf" });
expect(uncoveredInterceptors).toEqual([]);
```

- [ ] **Step 3: Run the focused tests and verify the expected failures**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/upload-filename.spec.ts test/multipart-upload-coverage.spec.ts test/field-evidence-multipart.spec.ts
```

Expected: FAIL because `upload-filename.ts`, `multipart-upload-options.ts`, and controller coverage do not exist.

- [ ] **Step 4: Implement filename normalization and the option wrapper**

Implement the public boundary:

```ts
export function normalizeUploadFilename(value: string, fallback = "upload") {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = basename
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  return boundFilename(cleaned || fallback.normalize("NFC"), 255);
}
```

Implement `createUtf8MultipartOptions` so it returns a new object, sets `defParamCharset: "utf8"`, normalizes `file.originalname`, and invokes any existing filter exactly once. Preserve existing `dest`, storage, limits and filter semantics.

- [ ] **Step 5: Apply the wrapper to every multipart controller**

Use these exact forms:

```ts
@UseInterceptors(AnyFilesInterceptor(createUtf8MultipartOptions()))
```

and for existing limits:

```ts
@UseInterceptors(
  AnyFilesInterceptor(
    createUtf8MultipartOptions({ limits: { fileSize: 20 * 1024 * 1024 } })
  )
)
```

Make `createFieldEvidenceUploadOptions()` return `createUtf8MultipartOptions({ dest, limits })` so its disk destination and parser flood limits remain unchanged.

- [ ] **Step 6: Run focused tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/upload-filename.spec.ts test/multipart-upload-coverage.spec.ts test/field-evidence-multipart.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: all focused tests PASS and typecheck exits 0.

Commit:

```powershell
git add apps/api/src/upload apps/api/src/customer/customer.controller.ts apps/api/src/field-operator/field-evidence-upload-options.ts apps/api/src/mileage-review/mileage-review.controller.ts apps/api/src/portal apps/api/src/vehicle/vehicle-listing.controller.ts apps/api/src/vehicle-insurance/vehicle-insurance.controller.ts apps/api/src/vehicle-baas/vehicle-baas.controller.ts apps/api/test/upload-filename.spec.ts apps/api/test/multipart-upload-coverage.spec.ts apps/api/test/field-evidence-multipart.spec.ts
git commit -m "fix: enforce utf8 upload filenames"
```

---

### Task 2: Auditable Existing Filename Repair CLI

**Files:**

- Create: `scripts/repair-upload-filenames-core.mjs`
- Create: `scripts/repair-upload-filenames.mjs`
- Create: `scripts/repair-upload-filenames.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: normalized UTF-8 expectations from Task 1.
- Produces: `recoverUtf8Filename(value: string): FilenameRepairDecision` where the decision is `{ status: "repair", value, reason }`, `{ status: "unchanged" }`, or `{ status: "ambiguous", reason }`.
- Produces CLI modes: `--dry-run`, `--apply`, and `--rollback-batch`; the rollback option requires a UUID value. `--output` accepts an absolute path or a path relative to the worktree.
- Produces audit rows in existing `audit_log` with `module="FILENAME_REPAIR"`, `action="UPDATE"`, entity ID/type, batch ID, field, before and after values.

- [ ] **Step 1: Write failing pure repair tests**

Add:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { recoverUtf8Filename } from "./repair-upload-filenames-core.mjs";

test("repairs UTF-8 bytes decoded as latin1", () => {
  assert.deepEqual(recoverUtf8Filename("è½¦è¾è¡Œé©¶è¯.pdf"), {
    reason: "utf8-bytes-decoded-as-latin1",
    status: "repair",
    value: "车辆行驶证.pdf"
  });
});

test("leaves valid Chinese and legitimate latin names unchanged", () => {
  assert.equal(recoverUtf8Filename("车辆行驶证.pdf").status, "unchanged");
  assert.equal(recoverUtf8Filename("résumé.pdf").status, "unchanged");
});

test("is idempotent", () => {
  const once = recoverUtf8Filename("è½¦è¾è¡Œé©¶è¯.pdf");
  assert.equal(once.status, "repair");
  assert.equal(recoverUtf8Filename(once.value).status, "unchanged");
});
```

- [ ] **Step 2: Run the pure test and verify it fails**

Run:

```powershell
node --test scripts/repair-upload-filenames.test.mjs
```

Expected: FAIL because the core module does not exist.

- [ ] **Step 3: Implement conservative detection and the source registry**

Define the registry exactly for persisted user-facing filename columns:

```js
export const filenameSources = [
  {
    entityType: "CustomerProfileMaterial",
    fields: ["fileName", "originalName"],
    model: "customerProfileMaterial"
  },
  { entityType: "ApplicationMaterialFile", fields: ["fileName"], model: "applicationMaterialFile" },
  {
    entityType: "VehicleListingMedia",
    fields: ["fileName", "originalName"],
    model: "vehicleListingMedia"
  },
  { entityType: "VehicleDocument", fields: ["fileName", "originalName"], model: "vehicleDocument" },
  {
    entityType: "VehicleBaasContractAttachment",
    fields: ["fileName", "originalName"],
    model: "vehicleBaasContractAttachment"
  },
  { entityType: "MarketPriceImportBatch", fields: ["fileName"], model: "marketPriceImportBatch" },
  {
    entityType: "ServiceCaseAttachment",
    fields: ["fileName", "originalName"],
    model: "serviceCaseAttachment"
  },
  { entityType: "FileObject", fields: ["originalName"], model: "fileObject" }
];
```

Use fatal UTF-8 decode, exact Latin-1 round-trip, mojibake marker detection, replacement/control rejection and the Task 1 filename normalization rules expressed in ESM-safe pure code. Do not repair merely because a name contains non-ASCII characters.

- [ ] **Step 4: Write failing executor tests with a fake Prisma adapter**

Test that dry-run does not call update/audit, apply writes the repaired field and matching audit in one transaction, a second apply changes zero rows, and rollback restores the audit `before` value for the requested batch only.

Required summary assertion:

```js
assert.deepEqual(summary, {
  ambiguous: 0,
  failed: 0,
  repaired: 1,
  scanned: 2,
  unchanged: 1
});
```

- [ ] **Step 5: Implement CLI execution and reporting**

The executor must:

1. require exactly one mode;
2. refuse `--apply` or rollback when `DATABASE_URL` is absent;
3. generate a UUID batch ID for dry-run/apply;
4. scan each source in deterministic ID order;
5. update one entity inside a transaction and create matching `AuditLog` rows;
6. place the batch ID and field name in both snapshots;
7. write a JSON report without credentials or object keys;
8. exit non-zero when any applied row fails;
9. print only counts and report location to stdout.

Add scripts:

```json
{
  "filename-repair:dry-run": "node scripts/repair-upload-filenames.mjs --dry-run",
  "filename-repair:apply": "node scripts/repair-upload-filenames.mjs --apply",
  "filename-repair:test": "node --test scripts/repair-upload-filenames.test.mjs"
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
pnpm filename-repair:test
node scripts/repair-upload-filenames.mjs --help
```

Expected: tests PASS and help exits 0 without opening a database connection. Database dry-run/apply/rollback is exercised against the disposable database in Task 10.

Commit:

```powershell
git add package.json scripts/repair-upload-filenames-core.mjs scripts/repair-upload-filenames.mjs scripts/repair-upload-filenames.test.mjs
git commit -m "feat: add reversible filename repair"
```

---

### Task 3: Reasoned Insurance Policy Soft Delete and Active Uniqueness

**Files:**

- Create: `apps/api/prisma/migrations/20260808190000_vehicle_insurance_policy_active_uniqueness/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/vehicle-insurance/dto/vehicle-insurance.dto.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.controller.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.module.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts`
- Modify: `apps/api/test/insurance-claim.spec.ts`
- Modify: `apps/api/test/portal-order-documents.spec.ts`
- Modify: `apps/api/test/vehicle-insurance.spec.ts`
- Modify: `apps/api/test/vehicle-insurance-schema.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

**Interfaces:**

- Consumes: existing `AuditService` and `VehicleListingSourceBinding` protection.
- Produces: `DeleteVehicleInsurancePolicyDto { reason: string }` with trimmed length 2..500.
- Produces: `VehicleInsuranceService.deletePolicy(id, dto, user): Promise<ReturnType<typeof toPolicyView>>`.
- Produces: `DELETE /vehicle-insurance-policies/:id` requiring `vehicle_insurance:manage`.
- Produces database unique index `vehicle_insurance_policy_active_vehicle_policy_no_key` on `(vehicle_id, policy_no) WHERE deleted_at IS NULL`.

- [ ] **Step 1: Add failing schema and service tests**

Add schema assertions that the old unconditional unique constraint is absent and the migration creates the partial unique index. Add service cases:

```ts
it("soft deletes an erroneous policy and active unbound documents with one audit", async () => {
  const { auditService, prisma, service, user } = createHarness();

  const result = await service.deletePolicy("policy-1", { reason: "保单号录入错误" }, user);

  expect(prisma.vehicleInsurancePolicy.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ deletedAt: expect.any(Date), updatedBy: "user-1" }),
      where: { id: "policy-1" }
    })
  );
  expect(prisma.vehicleDocument.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { deletedAt: null, policyId: "policy-1" } })
  );
  expect(auditService.write).toHaveBeenCalledWith(
    expect.objectContaining({ action: "DELETE", entityId: "policy-1" }),
    prisma
  );
  expect(result.id).toBe("policy-1");
});
```

Add distinct tests that a non-zero claim count and a bound policy document both reject with typed 409 errors and perform no updates.

- [ ] **Step 2: Run tests and verify failures**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts test/vehicle-insurance-schema.spec.ts test/permissions.spec.ts test/insurance-claim.spec.ts test/portal-order-documents.spec.ts
```

Expected: FAIL because the DTO, route, service method and partial index are absent.

- [ ] **Step 3: Implement migration and Prisma schema contract**

Migration SQL:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "vehicle_insurance_policy"
    WHERE "deleted_at" IS NULL
    GROUP BY "vehicle_id", "policy_no"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate active vehicle insurance policy numbers block partial unique index';
  END IF;
END $$;

DROP INDEX IF EXISTS "vehicle_insurance_policy_vehicle_id_policy_no_key";
CREATE UNIQUE INDEX "vehicle_insurance_policy_active_vehicle_policy_no_key"
  ON "vehicle_insurance_policy" ("vehicle_id", "policy_no")
  WHERE "deleted_at" IS NULL;
```

Remove `@@unique([vehicleId, policyNo])` from the Prisma model and add a schema comment naming the migration-owned partial index. The migration must first detect duplicate active rows and raise a descriptive exception before replacing the constraint.

- [ ] **Step 4: Implement transactional delete and audit**

Import `AuditModule` in `VehicleInsuranceModule`. In `deletePolicy`:

1. load an undeleted policy with active document IDs;
2. count any claim rows regardless of claim status but excluding soft-deleted claims;
3. throw `{ code: "POLICY_HAS_CLAIMS" }` when count is non-zero;
4. call the existing binding guard for every active document ID;
5. start one Prisma transaction;
6. soft delete/archive matching documents;
7. set policy `deletedAt` and `updatedBy`;
8. call `auditService.write` with action `DELETE`, reason in `after`, and the pre-delete policy summary in `before`, using the same transaction.

Translate the existing document-bound conflict to `POLICY_DOCUMENT_BOUND` at the policy boundary while preserving the original message.

Update every direct `new VehicleInsuranceService(...)` test harness in `vehicle-insurance.spec.ts`, `insurance-claim.spec.ts` and `portal-order-documents.spec.ts` to pass the same typed `AuditService` mock shape. Do not make the production dependency optional merely to preserve two-argument tests.

- [ ] **Step 5: Wire controller validation and permissions**

Add:

```ts
@Delete("vehicle-insurance-policies/:id")
@RequirePermissions(PermissionCode.VEHICLE_INSURANCE_MANAGE)
deletePolicy(
  @Param("id") id: string,
  @Body() dto: DeleteVehicleInsurancePolicyDto,
  @Req() request: AuthenticatedRequest
) {
  return this.vehicleInsuranceService.deletePolicy(id, dto, request.user);
}
```

Extend `permissions.spec.ts` to assert the method requires manage permission.

- [ ] **Step 6: Start an isolated PostgreSQL test database and verify migration**

Use a disposable, explicitly named container and unique port so the existing local volume is untouched:

```powershell
docker run -d --rm --name subscription-saas-attachment-test -e POSTGRES_DB=subscription_saas_attachment_test -e POSTGRES_USER=subscription -e POSTGRES_PASSWORD=subscription -p 55433:5432 postgres:17-alpine
$env:DATABASE_URL='postgresql://subscription:subscription@127.0.0.1:55433/subscription_saas_attachment_test?schema=public'
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
```

Expected: all migrations apply and status reports no pending migration. If port 55433 or the container name is occupied, inspect the exact owner before choosing one other explicit port/name; do not remove an unrelated container.

- [ ] **Step 7: Run focused tests and commit**

Run:

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts test/vehicle-insurance-schema.spec.ts test/permissions.spec.ts test/insurance-claim.spec.ts test/portal-order-documents.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260808190000_vehicle_insurance_policy_active_uniqueness apps/api/src/vehicle-insurance apps/api/test/insurance-claim.spec.ts apps/api/test/portal-order-documents.spec.ts apps/api/test/vehicle-insurance.spec.ts apps/api/test/vehicle-insurance-schema.spec.ts apps/api/test/permissions.spec.ts
git commit -m "feat: soft delete erroneous insurance policies"
```

---

### Task 4: Policy-Scoped Document Upload and Audited Document Delete

**Files:**

- Modify: `apps/api/src/vehicle-insurance/dto/vehicle-insurance.dto.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.controller.ts`
- Modify: `apps/api/src/vehicle-insurance/vehicle-insurance.service.ts`
- Modify: `apps/api/test/vehicle-insurance.spec.ts`
- Modify: `apps/api/test/permissions.spec.ts`

**Interfaces:**

- Consumes: `createUtf8MultipartOptions`, filename normalization, `AuditService`, existing private storage and cleanup.
- Produces: `UploadPolicyDocumentsDto { description?: string | null }` with description length at most 1000.
- Produces: `uploadPolicyDocuments(policyId, dto, files, user): Promise<VehicleDocumentView[]>`.
- Produces: `POST /vehicle-insurance-policies/:id/documents`, multipart `files[]` plus optional `description`, maximum 20 files.
- Extends every `VehicleDocumentView` with `boundListingSections: VehicleListingSourceSection[]`.
- Changes `deleteDocument(id, user)` to audit the soft deletion while preserving the existing bound-source 409.

- [ ] **Step 1: Write failing derivation, cleanup and audit tests**

Test the exact mapping:

```ts
it.each([
  [VehicleInsurancePolicyType.COMPULSORY_TRAFFIC, VehicleDocumentType.COMPULSORY_INSURANCE_POLICY],
  [VehicleInsurancePolicyType.COMMERCIAL, VehicleDocumentType.COMMERCIAL_INSURANCE_POLICY],
  [VehicleInsurancePolicyType.OTHER, VehicleDocumentType.OTHER]
])("derives %s policy documents as %s", async (policyType, documentType) => {
  const { prisma, service, user } = createHarness({ policyType });
  await service.uploadPolicyDocuments(
    "policy-1",
    { description: "正式保单" },
    [uploadFile("保单.pdf", "application/pdf")],
    user
  );
  expect(prisma.vehicleDocument.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        customerVisible: true,
        documentType,
        effectiveFrom: expect.any(Date),
        effectiveTo: expect.any(Date),
        policyId: "policy-1",
        vehicleId: "vehicle-1"
      })
    })
  );
});
```

Also test 21-file rejection before storage, cleanup after the second storage failure, deleted-policy rejection, `boundListingSections` projection, successful audited document delete, and bound delete rejection.

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts test/permissions.spec.ts
```

Expected: FAIL because the policy-scoped method and response projection do not exist.

- [ ] **Step 3: Implement policy-scoped multi-file upload**

Load the undeleted policy, derive fields only on the server, validate every file before storage, store sequentially, create all `VehicleDocument` rows in a transaction, and clean up every newly stored object if storage or database creation fails.

Use this mapping helper:

```ts
function policyDocumentType(policyType: VehicleInsurancePolicyType) {
  if (policyType === VehicleInsurancePolicyType.COMPULSORY_TRAFFIC) {
    return VehicleDocumentType.COMPULSORY_INSURANCE_POLICY;
  }
  if (policyType === VehicleInsurancePolicyType.COMMERCIAL) {
    return VehicleDocumentType.COMMERCIAL_INSURANCE_POLICY;
  }
  return VehicleDocumentType.OTHER;
}
```

The DTO must not accept `vehicleId`, `policyId`, `documentType`, effective dates or customer visibility.

- [ ] **Step 4: Add route, bound projection and delete audit**

Add the policy upload route with manage permission and `AnyFilesInterceptor(createUtf8MultipartOptions({ limits: { files: 20 } }))`. Include `listingSourceBindings.section` in the document query and map unique sections into `boundListingSections`.

Update the delete controller to pass `request.user`. In `deleteDocument`, soft delete and call `AuditService.write({ action: DELETE, entityType: "vehicle_document" })` in one transaction. Do not call storage deletion.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-insurance.spec.ts test/permissions.spec.ts test/portal-order-documents.spec.ts
pnpm --filter @subscription-saas/api typecheck
```

Expected: PASS, including existing Portal document visibility tests.

Commit:

```powershell
git add apps/api/src/vehicle-insurance apps/api/test/vehicle-insurance.spec.ts apps/api/test/permissions.spec.ts apps/api/test/portal-order-documents.spec.ts
git commit -m "feat: simplify policy document lifecycle"
```

---

### Task 5: Admin Insurance Policy Correction UI

**Files:**

- Create: `apps/web/src/app/vehicle-insurance-policies/policy-delete-dialog.tsx`
- Create: `apps/web/src/app/vehicle-insurance-policies/policy-document-panel.tsx`
- Create: `apps/web/test/vehicle-insurance-policy-correction-ui.spec.tsx`
- Modify: `apps/web/src/app/vehicle-insurance-policies/page.tsx`
- Modify: `apps/web/test/vehicle-insurance-policies-ui.spec.ts`

**Interfaces:**

- Consumes: Task 3 delete API and Task 4 policy document upload/delete API.
- Produces: `PolicyDeleteDialog` with props `{ open, policyNo, submitting, onCancel, onConfirm(reason) }`.
- Produces: `PolicyDocumentPanel` with props `{ documents, onChanged, policyId }`; it owns upload/delete request state but does not fetch policy data.
- Produces: `PolicyDocumentRow` containing only `boundListingSections`, `createdAt`, `description`, `fileName`, `id` and `previewUrl`; both the page detail type and panel props use this interface.
- UI behavior: normal actions remain visible; “删除错误记录” lives under `Dropdown`/“更多”; attachment upload contains only files, optional remark and submit.

- [ ] **Step 1: Write failing component and source contract tests**

Render the dialog and assert the reason is required before confirmation. Read the page source and assert:

```ts
expect(source).toContain("删除错误记录");
expect(source).toContain("/vehicle-insurance-policies/${policyId}/documents");
expect(source).not.toContain('label="材料类型"');
expect(source).not.toContain('name="customerVisible"');
expect(source).not.toContain('name="effectiveFrom"');
```

Read `policy-document-panel.tsx` for the attachment-form assertions; read `page.tsx` only for the “更多” menu and component wiring. This avoids matching the legitimate effective-date fields in the create/edit policy form.

- [ ] **Step 2: Run tests and verify failures**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-policy-correction-ui.spec.tsx test/vehicle-insurance-policies-ui.spec.ts
```

Expected: FAIL because the dialog, more menu and simplified form are absent.

- [ ] **Step 3: Implement low-frequency policy delete UI**

Use an Ant Design controlled `Modal` and `Form` in `PolicyDeleteDialog`; trim the reason, require 2..500 characters, disable cancel while submitting, and reset only after success/cancel.

In the list action column, keep “查看/编辑” and add:

```tsx
<Dropdown
  menu={{
    items: [{ danger: true, key: "delete", label: "删除错误记录" }],
    onClick: ({ key }) => key === "delete" && setDeletingPolicy(row)
  }}
>
  <Button icon={<MoreOutlined />} size="small">
    更多
  </Button>
</Dropdown>
```

On success, close an open detail drawer for the deleted policy and refresh list data. Preserve server 409 messages verbatim through `getErrorMessage`.

- [ ] **Step 4: Simplify policy attachments and add delete**

- Replace the generic vehicle-document endpoint with the policy-scoped endpoint.
- Allow multiple files up to 20.
- Send only `files` and optional `description`.
- Replace type/status/visibility columns with file name, upload time, remark and operations.
- Add preview and delete buttons.
- Disable delete when `boundListingSections.length > 0` and wrap it in a tooltip naming the product section.
- After upload/delete, refresh the open detail and policy list without a full page reload.

`PolicyDocumentPanel` receives the current documents and policy ID, owns its upload file list and delete confirmation, and invokes `onChanged()` after a successful mutation. The page implements `onChanged` by awaiting `openDetail(detail.id)` and `loadPolicies()`.

- [ ] **Step 5: Run focused tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-insurance-policy-correction-ui.spec.tsx test/vehicle-insurance-policies-ui.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/app/vehicle-insurance-policies apps/web/test/vehicle-insurance-policy-correction-ui.spec.tsx apps/web/test/vehicle-insurance-policies-ui.spec.ts
git commit -m "feat: add policy correction controls"
```

---

### Task 6: Rights-Document Per-File Correction and Attachment Boundary Regression

**Files:**

- Modify: `apps/web/src/components/vehicle-workspace/vehicle-documents-tab.tsx`
- Modify: `apps/web/src/lib/vehicle-document-workspace.ts`
- Modify: `apps/web/test/vehicle-document-workspace.spec.ts`
- Create: `apps/api/test/attachment-correction-boundary.spec.ts`

**Interfaces:**

- Consumes: existing `DELETE /vehicle-documents/:id`, `boundListingSections`, existing Portal profile delete, listing-media delete and application evidence rules.
- Produces: `canDeleteVehicleDocument(document, boundIds): boolean`, implemented beside `canArchiveDocument` and sharing its active/bound predicates.
- UI behavior: each active rights-document file has preview and delete; product-bound files show a disabled delete with a tooltip; deleting the last active file leaves the historical batch with zero active items and recalculates completeness.

- [ ] **Step 1: Add failing helper and UI tests**

Test:

```ts
expect(canDeleteVehicleDocument(activeDocument, new Set())).toBe(true);
expect(canDeleteVehicleDocument(activeDocument, new Set([activeDocument.id]))).toBe(false);
expect(canDeleteVehicleDocument(archivedDocument, new Set())).toBe(false);
```

Add a source/render assertion that the drawer exposes “删除错误文件”, calls `/vehicle-documents/${document.id}`, and reloads both workspace and vehicle summary after success.

- [ ] **Step 2: Add failing API boundary regression tests**

The test must prove the existing intended matrix rather than add new endpoints:

- Portal profile material delete performs soft deletion;
- vehicle listing media has a delete route;
- application material deletion remains controlled by `canDeleteMaterialFile` and a reason;
- `VehicleInsuranceService.deleteDocument` never calls `StorageService.deleteObject`;
- product-bound vehicle documents reject deletion.

- [ ] **Step 3: Run focused tests and verify failures**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/vehicle-document-workspace.spec.ts
pnpm --filter @subscription-saas/api exec vitest run test/attachment-correction-boundary.spec.ts test/application-workflow.spec.ts test/portal-profile-material.spec.ts test/vehicle-insurance.spec.ts
```

Expected: the new per-file UI/helper tests FAIL; existing immutable/mutable boundary tests remain green.

- [ ] **Step 4: Implement per-file deletion without a new batch state machine**

Add a deleting ID state and confirmation. Use the existing generic delete API. After success:

```ts
await Promise.all([loadWorkspace(), onVehicleChanged()]);
```

Continue deriving active count from non-deleted, `ACTIVE` items. If a batch returns zero items, render it as archived/no effective files; do not reuse or decrement its `versionNo`.

- [ ] **Step 5: Run tests and commit**

Run the commands from Step 3, then:

```powershell
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/components/vehicle-workspace/vehicle-documents-tab.tsx apps/web/src/lib/vehicle-document-workspace.ts apps/web/test/vehicle-document-workspace.spec.ts apps/api/test/attachment-correction-boundary.spec.ts
git commit -m "feat: allow rights document file correction"
```

---

### Task 7: Hide the Admin Menu Scrollbar Without Disabling Scrolling

**Files:**

- Modify: `apps/web/src/components/protected-shell.module.css`
- Modify: `apps/web/test/admin-shell-layout.spec.tsx`

**Interfaces:**

- Consumes: existing independent `.menuViewport { overflow-y: auto; }` layout and scroll position persistence.
- Produces: invisible scrollbar for Firefox and WebKit while wheel, touch, keyboard and programmatic scrolling remain available.

- [ ] **Step 1: Add a failing CSS contract test**

Read the CSS module and assert:

```ts
expect(css).toMatch(/\.menuViewport\s*\{[\s\S]*overflow-y:\s*auto/);
expect(css).toMatch(/\.menuViewport\s*\{[\s\S]*scrollbar-width:\s*none/);
expect(css).toMatch(/\.menuViewport::-webkit-scrollbar\s*\{[\s\S]*display:\s*none/);
expect(css).not.toMatch(/\.menuViewport\s*\{[\s\S]*overflow-y:\s*hidden/);
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-shell-layout.spec.tsx
```

Expected: FAIL on the missing hidden-scrollbar rules.

- [ ] **Step 3: Add the minimal CSS rules**

Add `scrollbar-width: none` to `.menuViewport` and a `.menuViewport::-webkit-scrollbar { display: none; }` rule. Do not change the shell height, `overflow-y: auto`, overscroll behavior, `onScroll`, ref or cached `scrollTop` behavior.

- [ ] **Step 4: Run test and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/admin-shell-layout.spec.tsx
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/components/protected-shell.module.css apps/web/test/admin-shell-layout.spec.tsx
git commit -m "fix: hide admin menu scrollbar"
```

---

### Task 8: Portal Entitlement Mobile Cards

**Files:**

- Create: `apps/web/src/app/portal/entitlements/entitlement-records.tsx`
- Create: `apps/web/src/app/portal/entitlements/entitlement-records.module.css`
- Create: `apps/web/test/portal-entitlement-records.spec.tsx`
- Modify: `apps/web/src/app/portal/entitlements/page.tsx`

**Interfaces:**

- Consumes: `PortalEntitlementGrant[]`, `PortalEntitlementUsage[]`, existing labels and formatters.
- Produces: `PortalEntitlementGrantRecords({ rows, loading })` and `PortalEntitlementUsageRecords({ rows, loading })`.
- Guarantees: desktop table above 768px; mobile cards at or below 768px; no network requests in presentation components.

- [ ] **Step 1: Write failing render and CSS tests**

Render one grant and one usage with Chinese labels. Assert card semantics:

```ts
expect(html).toContain('data-testid="portal-entitlement-grant-card"');
expect(html).toContain("洗车权益");
expect(html).toContain("10 次");
expect(html).toContain("2026-08-02");
expect(html).toContain("2026-09-01");
expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
expect(css).toContain("word-break: keep-all");
expect(css).not.toContain("overflow-x: scroll");
```

Also render a `TEXT` unit and assert it displays the existing text-benefit label instead of a numeric suffix.

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-records.spec.tsx
```

Expected: FAIL because the presentation component and CSS module do not exist.

- [ ] **Step 3: Implement dual desktop/mobile projections**

Render both projections from the same `rows` prop:

```tsx
return (
  <>
    <div className={styles.desktopTable}>{desktopTable}</div>
    <div className={styles.mobileCards}>{mobileCards}</div>
  </>
);
```

CSS defaults to desktop visible/mobile hidden, then swaps display values inside `@media (max-width: 768px)`. Cards place name/status in the header, remaining amount in a prominent value, then used amount, type, source and validity as key/value rows. Use `min-width: 0`, stable label widths, and `overflow-wrap: anywhere` only for machine identifiers.

- [ ] **Step 4: Replace inline tables in the page**

Keep existing `Promise.all`, authentication redirect, loading state and empty text. Move column and amount/time presentation helpers into `entitlement-records.tsx`; the page only passes `grants`, `usages` and `loading`.

- [ ] **Step 5: Run tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-entitlement-records.spec.tsx
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add apps/web/src/app/portal/entitlements apps/web/test/portal-entitlement-records.spec.tsx
git commit -m "feat: add mobile entitlement cards"
```

---

### Task 9: Portal Payment Order and Write-Off Mobile Cards

**Files:**

- Create: `apps/web/src/app/portal/bills/[id]/bill-records.tsx`
- Create: `apps/web/src/app/portal/bills/[id]/bill-records.module.css`
- Create: `apps/web/test/portal-bill-records.spec.tsx`
- Modify: `apps/web/src/app/portal/bills/[id]/page.tsx`

**Interfaces:**

- Consumes: `PortalBillDetail["paymentOrders"]`, `PortalBillDetail["writeOffs"]`, payment labels and money/time formatters.
- Produces: `PortalPaymentOrderRecords({ rows })` and `PortalWriteOffRecords({ rows })`.
- Guarantees: desktop tables unchanged above 768px; mobile cards show status, prominent amount, channel/method and time.

- [ ] **Step 1: Write failing component and CSS tests**

Render long identifiers and assert:

```ts
expect(html).toContain('data-testid="portal-payment-order-card"');
expect(html).toContain('data-testid="portal-write-off-card"');
expect(html).toContain("PAY202607230736426ZLB");
expect(html).toContain("5,400.00 元");
expect(html).toContain("银行转账");
expect(html).toContain("2026-07-23 18:43");
expect(css).toMatch(/@media\s*\(max-width:\s*768px\)/);
expect(css).toContain("overflow-wrap: anywhere");
```

Assert the write-off card uses `PAYMENT_STATUS_LABELS` for `paymentStatus`, not `PAYMENT_ORDER_STATUS_LABELS`.

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-bill-records.spec.tsx
```

Expected: FAIL because the records component and CSS do not exist.

- [ ] **Step 3: Implement desktop/mobile records**

Payment-order card order:

1. payment order number and order status;
2. prominent paid amount;
3. channel;
4. paid time.

Write-off card order:

1. payment number and payment status;
2. prominent write-off amount;
3. payment method;
4. write-off time.

Use the same 768px CSS swap pattern as Task 8, but keep components domain-specific so entitlement units do not leak into billing presentation.

- [ ] **Step 4: Replace the two inline bill tables**

Keep bill loading, payment action, auto-debit panel and data fetch untouched. Replace only the “支付单” and “核销记录” `Table` nodes. Preserve current empty states with `Empty` in both projections.

- [ ] **Step 5: Run tests, typecheck and commit**

Run:

```powershell
pnpm --filter @subscription-saas/web exec vitest run test/portal-bill-records.spec.tsx test/portal-bill-card.spec.tsx
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

Commit:

```powershell
git add -- 'apps/web/src/app/portal/bills/[id]' apps/web/test/portal-bill-records.spec.tsx apps/web/test/portal-bill-card.spec.tsx
git commit -m "feat: add mobile billing record cards"
```

---

### Task 10: Full Verification, Repair Dry Run and Acceptance Handoff

**Files:**

- Create: `docs/attachment-correction-portal-mobile-acceptance.zh-CN.md`
- Modify only if verification finds a regression: files already named in Tasks 1-9, with a failing regression test added before the fix.

**Interfaces:**

- Consumes: all previous tasks and the disposable PostgreSQL database from Task 3.
- Produces: one reproducible acceptance document with command results, filename repair counts, browser viewport checks and known environment limitations.

- [ ] **Step 1: Run formatting, lint, schema and type gates**

Run:

```powershell
pnpm format:check
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
```

Expected: all commands exit 0. If formatting fails, run Prettier only on files changed by this branch and rerun the check.

- [ ] **Step 2: Run focused and full tests with the disposable database**

Keep `DATABASE_URL` pointed at `subscription_saas_attachment_test`, then run:

```powershell
pnpm filename-repair:test
pnpm --filter @subscription-saas/shared test
pnpm --filter @subscription-saas/web test
pnpm --filter @subscription-saas/api test
```

Expected: all tests pass. Record test file/test counts. Any failure caused by this branch receives a new failing regression test before its fix.

- [ ] **Step 3: Validate repair dry-run, apply, idempotence and rollback on fixtures**

Insert a single synthetic `file_object` fixture into the disposable database. This table has no required business foreign key and lets the verification prove that `object_key` remains unchanged:

```powershell
docker exec subscription-saas-attachment-test psql -U subscription -d subscription_saas_attachment_test -c "DELETE FROM file_object WHERE id = '00000000-0000-4000-8000-000000000888'; INSERT INTO file_object (id, bucket, object_key, original_name, size_bytes) VALUES ('00000000-0000-4000-8000-000000000888', 'fixture-bucket', 'fixtures/unchanged-key.pdf', 'è½¦è¾è¡Œé©¶è¯.pdf', 128);"
```

Then run the repair lifecycle with deterministic report paths:

```powershell
node scripts/repair-upload-filenames.mjs --dry-run --output output/filename-repair-dry-run.json
node scripts/repair-upload-filenames.mjs --apply --output output/filename-repair-apply.json
node scripts/repair-upload-filenames.mjs --apply --output output/filename-repair-second-apply.json
$repairReport = Get-Content -Raw 'output/filename-repair-apply.json' | ConvertFrom-Json
node scripts/repair-upload-filenames.mjs --rollback-batch $repairReport.batchId --output output/filename-repair-rollback.json
docker exec subscription-saas-attachment-test psql -U subscription -d subscription_saas_attachment_test -tAc "SELECT object_key || '|' || original_name FROM file_object WHERE id = '00000000-0000-4000-8000-000000000888';"
```

Expected:

- dry-run changes no rows;
- first apply repairs the synthetic mojibake row;
- second apply reports `repaired: 0`;
- rollback restores the exact pre-repair value;
- bucket/object key columns remain byte-for-byte unchanged.

Capture the generated batch ID from the JSON report rather than copying terminal credentials or connection strings.

- [ ] **Step 4: Build production bundles**

Run:

```powershell
pnpm build
```

Expected: API and Web builds succeed.

- [ ] **Step 5: Start local services and perform browser verification**

Run API/Web with the disposable database and use the in-app browser at desktop, 768px, 390px and 360px widths. Verify:

- policy “更多” delete flow and reason validation;
- claim/binding 409 messages;
- Chinese names in policy, listing media and rights documents;
- policy upload contains no type/effective/visibility inputs;
- rights per-file delete and empty-batch state;
- hidden Admin scrollbar with working wheel/keyboard scroll;
- Portal entitlement, payment-order and write-off cards have no horizontal overflow or per-character Chinese wrapping;
- desktop Portal still shows tables.

Check browser console for uncaught errors and failed requests.

- [ ] **Step 6: Write acceptance evidence and stop the disposable database**

Document exact commands, pass counts, viewports, synthetic repair counts, screenshots/paths if generated, and any intentionally blocked external checks. Then stop only the explicitly named disposable container:

```powershell
docker stop subscription-saas-attachment-test
```

Because it was created with `--rm`, its temporary data is removed. Do not stop or remove `subscription-saas-postgres` or any unrelated service.

- [ ] **Step 7: Commit verification evidence**

Run:

```powershell
git add docs/attachment-correction-portal-mobile-acceptance.zh-CN.md
git commit -m "docs: record attachment correction verification"
git status --short --branch
```

Expected: the acceptance commit is created and the worktree is clean.

---

## Completion Gate

The implementation is complete only when all conditions are true:

1. Every task has its focused red/green evidence and an intentional commit.
2. The filename repair is proven dry-run safe, idempotent and reversible on the disposable database.
3. The policy partial unique migration applies cleanly to a fresh database and reports no pending migration.
4. Shared, Web and API tests pass with a valid local PostgreSQL database.
5. Lint, Prisma validation/generation, typechecks and production build pass.
6. Browser checks pass at desktop, 768px, 390px and 360px.
7. No stored object is physically deleted or renamed by the implementation or repair tool.
8. The worktree is clean and the acceptance document records evidence rather than unverified claims.

After the plan is approved, execute it inline with `superpowers:executing-plans`; do not dispatch subagents.
