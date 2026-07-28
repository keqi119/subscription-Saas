# Stage 2 Document Consistency and Contract List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stage 2 archive state and PDF downloads authoritative and consistent across Admin surfaces, preserve clear signature space in newly generated PDFs, and add contract-number/order-number fuzzy search plus a contract-title column.

**Architecture:** Keep `HandoverWorkOrder` as the source of truth for typed Stage 2 archive state. Generic e-sign task artifacts may describe provider progress but cannot promote a Stage 2 document to archived. Admin downloads select the signed artifact only when the typed Stage 2 archive tuple is complete; otherwise they explicitly expose the immutable unsigned source. Contract-list filtering remains a server-side `Contract` query with two independent optional filters combined by `AND`.

**Tech Stack:** NestJS, Prisma, Vitest, Next.js App Router, React, Ant Design, PDFKit.

## Global Constraints

- Do not add or modify a database migration in this change.
- Do not mutate an already signed PDF; signature-layout changes apply only to newly generated source PDFs.
- Do not treat `ESignTask.signedObjectKey` as proof that a Stage 2 archive completed.
- Do not expose storage keys, provider payloads, or provider customer IDs in Admin DTOs.
- Keep the existing rule that signature completion permits Admin delivery confirmation even while signed-file archival is retrying.
- Keep the working-tree directories `.superpowers/`, `output/`, and `tmp/` untracked.

---

## Task 1: Enforce Typed Stage 2 Archive Authority

**Files:**
- Modify: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts`
- Modify: `apps/api/src/esign/esign.service.ts`
- Modify: `apps/web/src/lib/admin-esign-display.ts`
- Modify: `apps/web/src/app/contracts/[id]/page.tsx`
- Test: `apps/api/test/fadada-archive.spec.ts`
- Test: `apps/api/test/esign.spec.ts`
- Test: `apps/web/test/admin-esign-display.spec.ts`
- Test: `apps/web/test/contracts-detail-esign-display.spec.ts`

- [ ] Add or confirm tests proving the typed Stage 2 archive query sends `FADADA_PLATFORM_CUSTOMER_ID` to the provider sign-result query.
- [ ] Add or confirm a test proving a missing platform customer ID fails with an actionable configuration error before an archive is marked complete.
- [ ] Add or confirm a test proving the generic signed-artifact archive endpoint rejects a typed Stage 2 task with `STAGE2_HANDOVER_ARCHIVE_TYPED_ENDPOINT_REQUIRED`.
- [ ] Add or confirm projection tests proving Admin and Portal report Stage 2 as archived only when the linked `HandoverWorkOrder` has all of:

```ts
archiveStatus === "ARCHIVED";
status === "ARCHIVED";
signedDocumentFileId;
signedObjectKey;
signedPdfHash;
```

- [ ] Add or confirm Web tests proving the contract detail page uses the typed Stage 2 archive projection for `已签文件已归档`, `等待签署文件归档`, and archive-failure display. A generic task object key alone must not render the archived label.
- [ ] Run the focused tests and confirm the new assertions fail against code that relies on the generic task artifact:

```powershell
pnpm --filter @subscription-saas/api test -- test/fadada-archive.spec.ts test/esign.spec.ts
pnpm --filter @subscription-saas/web test -- test/admin-esign-display.spec.ts test/contracts-detail-esign-display.spec.ts
```

Expected result before the implementation is applied: at least one assertion fails because the provider query omits the platform customer ID or because generic task state is accepted as the Stage 2 archive source.

- [ ] In `FadadaSignedArtifactService`, pass the configured platform customer ID into the typed Stage 2 `querySignResult` request and fail closed when it is missing.
- [ ] In the generic archive path, identify typed Stage 2 tasks through their linked handover work order and reject them with the typed-endpoint-required code.
- [ ] In `ESignService`, derive the Stage 2 archive projection from the handover work order only. Preserve signature-completion fields independently so delivery confirmation remains available after both signers finish.
- [ ] In `admin-esign-display.ts`, map the typed projection to safe user-facing archive labels. Update the contract detail page to consume that display model rather than inferring archive completion from generic task fields.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/esign/fadada/fadada-signed-artifact.service.ts apps/api/src/esign/esign.service.ts apps/api/test/fadada-archive.spec.ts apps/api/test/esign.spec.ts apps/web/src/lib/admin-esign-display.ts "apps/web/src/app/contracts/[id]/page.tsx" apps/web/test/admin-esign-display.spec.ts apps/web/test/contracts-detail-esign-display.spec.ts
git commit -m "fix: enforce authoritative stage2 archive state"
```

---

## Task 2: Serve the Authoritative Stage 2 Signed PDF

**Files:**
- Modify: `apps/api/src/handover-work-order/handover-work-order.controller.ts`
- Modify: `apps/api/src/handover-work-order/handover-work-order.service.ts`
- Modify: `apps/web/src/lib/admin-stage2-handover-pdf.ts`
- Modify: `apps/web/src/app/orders/[id]/page.tsx`
- Test: `apps/api/test/stage2-handover-pdf.spec.ts`
- Test: `apps/api/test/stage2-handover-esign-lifecycle.spec.ts`
- Test: `apps/web/test/admin-stage2-handover-esign.spec.ts`

- [ ] Add or confirm API tests for `GET /handover-work-orders/:id/esign/signed-document/download` covering authorization, missing typed archive data, mismatched `FileObject.objectKey`, wrong MIME type, and successful streaming.
- [ ] Add or confirm web tests for this exact selection rule:

```ts
const useSignedPdf =
  archiveStatus === "ARCHIVED" &&
  status === "ARCHIVED" &&
  Boolean(signedDocumentFileId && signedObjectKey && signedPdfHash);
```

- [ ] Assert that the order page labels the signed path `下载已签署 PDF` and the fallback source path `查看待签原件`; do not use the ambiguous label `下载`.
- [ ] Run the focused tests and verify the assertions fail against a page that always downloads the unsigned source:

```powershell
pnpm --filter @subscription-saas/api test -- test/stage2-handover-pdf.spec.ts test/stage2-handover-esign-lifecycle.spec.ts
pnpm --filter @subscription-saas/web test -- test/admin-stage2-handover-esign.spec.ts
```

- [ ] Implement `downloadStage2SignedHandoverPdf(id)` so it validates the complete typed archive tuple, loads the linked `FileObject`, verifies exact object-key equality and PDF MIME type, and streams only that object.
- [ ] Add the DELIVERY_VIEW-protected controller route.
- [ ] Keep URL construction and download-label selection in `admin-stage2-handover-pdf.ts`, not inline in the page.
- [ ] Update the Stage 2 handover row to render the selected descriptor and preserve the source PDF as an explicitly labeled fallback until typed archival completes.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/handover-work-order/handover-work-order.controller.ts apps/api/src/handover-work-order/handover-work-order.service.ts apps/api/test/stage2-handover-pdf.spec.ts apps/api/test/stage2-handover-esign-lifecycle.spec.ts apps/web/src/lib/admin-stage2-handover-pdf.ts "apps/web/src/app/orders/[id]/page.tsx" apps/web/test/admin-stage2-handover-esign.spec.ts
git commit -m "fix: serve signed stage2 handover pdf"
```

---

## Task 3: Preserve Signature and Seal Clearance

**Files:**
- Modify: `apps/api/src/delivery-handover/delivery-handover-pdf-renderer.service.ts`
- Test: `apps/api/test/stage2-handover-pdf.spec.ts`

- [ ] Add or confirm renderer assertions that the customer signature position and platform seal position land inside a dedicated blank row at least 144 PDF points high.
- [ ] Assert that customer ID, customer phone, operator name, operator phone, and both date fields start below the signature/seal row.
- [ ] Run the PDF test and confirm a renderer using the previous compact table fails the clearance assertions:

```powershell
pnpm --filter @subscription-saas/api test -- test/stage2-handover-pdf.spec.ts
```

- [ ] Render the signature section in this order: party headings, dedicated blank signature/seal row, identity/contact rows, date row.
- [ ] Keep both signing coordinates centered in the dedicated blank row and away from all borders and text.
- [ ] Generate a representative PDF and render its signature page to PNG using the repository PDF verification workflow.
- [ ] Inspect the PNG at desktop resolution and confirm neither a customer signature image nor the platform seal bounding box can cover identity/contact/date text.
- [ ] Re-run the PDF test and confirm it passes.
- [ ] Commit this task:

```powershell
git add apps/api/src/delivery-handover/delivery-handover-pdf-renderer.service.ts apps/api/test/stage2-handover-pdf.spec.ts
git commit -m "fix: reserve stage2 signature clearance"
```

---

## Task 4: Add Contract List Search and Title

**Files:**
- Modify: `apps/api/src/order/dto/order.dto.ts`
- Modify: `apps/api/src/order/order.controller.ts`
- Modify: `apps/api/src/order/order.service.ts`
- Create: `apps/web/src/lib/admin-contracts.ts`
- Modify: `apps/web/src/app/contracts/page.tsx`
- Test: `apps/api/test/order-contract.spec.ts`
- Create: `apps/web/test/admin-contracts.spec.ts`

- [ ] Add API tests for no filters, contract-number-only fuzzy search, order-number-only fuzzy search, both filters combined by `AND`, surrounding whitespace, and sales-scope preservation.
- [ ] Define the query DTO:

```ts
export class ListContractsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  contractNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  orderNo?: string;
}
```

Normalize whitespace to `undefined` before constructing the Prisma filter.

- [ ] Run the API test and confirm the new query cases fail against the unfiltered endpoint:

```powershell
pnpm --filter @subscription-saas/api test -- test/order-contract.spec.ts
```

- [ ] Accept `ListContractsQueryDto` through `@Query()` in `OrderController.listContracts`.
- [ ] In `OrderService.listContracts`, append optional Prisma `contains` filters with `mode: "insensitive"` and combine both supplied filters by `AND`. Preserve deleted-order and sales-scope conditions.
- [ ] Add `buildAdminContractsListPath({ contractNo, orderNo })` in `admin-contracts.ts`; omit empty query parameters and encode both values.
- [ ] Add web tests for empty, single-filter, dual-filter, Unicode, and cleared-filter URLs.
- [ ] Run the web test and confirm it fails before the URL helper exists:

```powershell
pnpm --filter @subscription-saas/web test -- test/admin-contracts.spec.ts
```

- [ ] Add two independent compact search inputs labeled `合同编号` and `订单编号`, one search action, and one clear action. Submitting reloads from the server; clearing restores the unfiltered list.
- [ ] Add a `合同标题` column backed by the existing `contractTitle` response field. Use `-` only when the value is absent.
- [ ] Keep the existing row action and all current columns unless horizontal fit requires moving low-priority timestamps into the existing detail page.
- [ ] Re-run both focused test files and confirm they pass.
- [ ] Commit this task:

```powershell
git add apps/api/src/order/dto/order.dto.ts apps/api/src/order/order.controller.ts apps/api/src/order/order.service.ts apps/api/test/order-contract.spec.ts apps/web/src/lib/admin-contracts.ts apps/web/src/app/contracts/page.tsx apps/web/test/admin-contracts.spec.ts
git commit -m "feat: add contract list search and title"
```

---

## Task 5: Verify, Publish, and Reconcile Staging

**Files:**
- Verify only; do not add generated PDFs, screenshots, `.superpowers/`, `output/`, or `tmp/`.

- [ ] Run all affected tests:

```powershell
pnpm --filter @subscription-saas/api test -- test/fadada-archive.spec.ts test/esign.spec.ts test/stage2-handover-pdf.spec.ts test/stage2-handover-esign-lifecycle.spec.ts test/order-contract.spec.ts
pnpm --filter @subscription-saas/web test -- test/admin-esign-display.spec.ts test/contracts-detail-esign-display.spec.ts test/admin-stage2-handover-esign.spec.ts test/admin-contracts.spec.ts
```

- [ ] Run static verification:

```powershell
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
pnpm --filter @subscription-saas/api build
pnpm --filter @subscription-saas/web build
```

- [ ] Inspect `git status --short` and confirm only intended tracked files are committed.
- [ ] Push the branch, open a PR with the Stage 2 authority rules and contract-list behavior called out, obtain review, and merge after checks pass.
- [ ] After the new API and Web images are deployed, retry the typed Stage 2 archive for `ORD20260726073922TFHF`.
- [ ] Confirm the order page and contract page both report the same archive state.
- [ ] Confirm the order-page Stage 2 download returns the signed PDF after typed archival and the explicitly labeled unsigned source before it.
- [ ] Generate one new Stage 2 PDF and visually confirm signature/seal clearance. Do not use the already signed legal artifact as a layout test target.
- [ ] Confirm `/contracts` can find the target by partial contract number and partial order number and displays its title.
