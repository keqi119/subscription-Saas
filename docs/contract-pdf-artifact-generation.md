# Contract PDF Artifact Generation

Status: renderer, artifact-writer, guarded OrderService integration, and e-sign source hardening foundations are present. This document does not enable production contract PDF generation by default.

## Current Gap

`ContractVersion.contentTemplate` is saved into `contractSnapshot.contentTemplate`. Production signing requires that snapshot content to be rendered into a formal signing PDF artifact before e-sign task creation.

The e-sign upload path resolves PDF artifacts in this order:

1. `Contract.fileId`
2. `ContractVersion.fileId`
3. deterministic test fixture only when real Fadada signing is disabled

Production signing must use a real PDF artifact. Test fixture fallback is not acceptable for real Fadada signing.

## Renderer Foundation

The backend renderer foundation uses `pdfkit` to render a deterministic PDF buffer from a structured render model.

The render model includes:

- contract identity
- legal terms body from `contentTemplate`
- Attachment 1 subscription plan / transaction terms snapshot sections and rows
- Stage 1 signing slots
- render diagnostics

The renderer validates non-empty legal body, required Stage 1 signing slots, CJK font readiness for Chinese content, PDF header, and size limit.

## Artifact Writer Foundation

The artifact writer foundation adds the internal path:

```text
ContractPdfRenderModel -> ContractPdfRendererService -> private Storage object -> FileObject
```

The writer returns generated artifact metadata to callers. `OrderService.generateContract()` can call the writer and bind the returned `FileObject` to `Contract.fileId` only when guarded artifact generation is explicitly enabled.

Generated source PDFs are stored as private objects. This remains compatible with Fadada because provider upload can send file content and does not require a public `doc_url`.

The generated object key pattern is:

```text
contracts/{contractId}/generated/{safeFileName}
```

If `FileObject` creation fails after storage succeeds, the writer performs best-effort private-object cleanup through `StorageService.deleteObject`. If cleanup also fails, an orphan private object may require operator cleanup.

## OrderService Integration

Generated signing PDF creation is guarded by:

```text
CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED=true
```

Default behavior is disabled:

- missing flag = disabled
- `false` = disabled
- `true` = enabled

When disabled, contract generation preserves the existing compatible flow and does not require `CONTRACT_PDF_CJK_FONT_PATH`.

When enabled, `OrderService.generateContract()`:

1. Creates the `Contract` in `GENERATED` state without `fileId`.
2. Builds a `ContractPdfRenderModel` from `ContractVersion.contentTemplate` and a conservative order appendix.
3. Calls `ContractPdfArtifactWriterService`.
4. Writes `Contract.fileId` from the generated `FileObject`.
5. Moves the order to `PENDING_SIGN` only after `Contract.fileId` succeeds.

If rendering, storage, `FileObject` creation, or `Contract.fileId` update fails, the order is not advanced to `PENDING_SIGN`, no e-sign task is created by this flow, and the created contract is best-effort marked `CANCELLED` so a controlled retry can generate a fresh contract.

This integration does not backfill existing contracts and must not be used to manually mark failed e-sign tasks successful.

## Legal Boundary

Formal legal contract text must be supplied externally by legal/operator reviewers.

Codex must not invent:

- legal contract terms
- legal appendix wording
- approved production template text
- seal IDs or provider credentials

Synthetic test text is allowed only for automated renderer/writer tests and must not be used as a production contract template.

Before production use, the formal template must follow the approval process in `docs/contract-template-legal-approval.md`. The approval record must include the template name, version number, effective date, legal approver, business approver, approved legal body, approved appendix field structure, approved Stage 1 signing slot keywords, and rollback version.

The Stage 1 PDF source contains the contract main body plus Attachment 1 subscription plan / transaction terms snapshot. Attachment 2 vehicle handover / delivery confirmation is excluded from Stage 1 and remains a future Stage 2 document/task.

If the legal-approved body already contains older generic anchor strings such as `服务提供方盖章` or `订阅方盖章/签字`, those strings do not satisfy the Stage 1 slot model and must not drive provider placement. Template activation must verify the generated Stage 1 PDF contains each approved Stage 1 slot keyword exactly once.

## Font Boundary

Chinese contract PDFs require a usable CJK font path.

The API image now installs the operator-approved Source Han Sans SC Regular OTF from the Adobe Source Han Sans `2.005R` release during image build. The release asset is pinned to `09_SourceHanSansSC.zip` and verified with SHA256 `ef7364f7ac2564be1ae9c1d74276de2653fe38b73449070398c4fc0b7e032ff1` before extracting `OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf`.

Default image configuration:

```text
CONTRACT_PDF_CJK_FONT_PATH=/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf
```

Font files are not committed to the repository and must not be shared in Codex output.

If rendered content contains CJK characters and no usable CJK font path is configured, the renderer must fail fast instead of silently generating garbled Chinese output.

Use `docs/cjk-font-deployment-checklist.md` for the operator deployment checklist, approval inputs, container validation commands, sandbox PDF review, production enablement gate, and rollback path. The selected Source Han Sans SC deployment records the license as SIL Open Font License 1.1 for this approved operator decision; do not describe it as Apache 2.0 in repository docs.

`CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED` must remain disabled for CJK legal content until the CJK font path has been verified inside the API runtime container and a generated sandbox PDF has passed visual review. The image font install does not resolve the separate legal-template slot placement risk; Stage 1 slot uniqueness must still be verified before formal template activation.

## Stage 1 Signing Slots

Approved Stage 1 slot keywords:

- Contract body customer signature: `合同正文-订阅方签字`
- Contract body platform/company seal: `合同正文-服务提供方盖章`
- Attachment 1 customer signature: `附件1订阅方案-订阅方签字`
- Attachment 1 platform/company seal: `附件1订阅方案-服务提供方盖章`

The Stage 1 signing PDF must contain these four keywords and reserve blank space on the right side for signing or sealing where needed. Stage 1 must not rely on repeated generic anchors.

Generated signing PDFs must be text-based and searchable. Image-only PDFs are not acceptable because Fadada keyword positioning requires the keyword to exist as searchable document text.

Each Stage 1 slot keyword must appear exactly once in the generated render model:

- `合同正文-订阅方签字`
- `合同正文-服务提供方盖章`
- `附件1订阅方案-订阅方签字`
- `附件1订阅方案-服务提供方盖章`

If a Stage 1 slot keyword is missing or duplicated, artifact writing must fail before storage write and before `FileObject` creation.

The requested platform seal right offset is:

```text
60px
```

Provider-side placement must remain consistent with the generated PDF slot layout.

The provider offset mapping is not writer responsibility. `keyx=60` and `keyy=0` belong to the e-sign/Fadada positioning layer. Multi-position provider mapping for the four Stage 1 slots remains a future task.

## Stage 1 Slot Coordinate Metadata

The contract PDF renderer captures deterministic Stage 1 signing slot coordinate metadata while it renders the PDF. The renderer must not parse the generated PDF after the fact to discover signing positions.

Each required Stage 1 slot coordinate record contains:

- `slotId`
- `keyword`
- `pageNumber`
- `x`
- `y`
- `width`
- `height`
- `coordinateSource`
- `coordinateSystem`
- `pdfPageWidth`
- `pdfPageHeight`

The coordinate source is `PDFKIT_RENDERER`. The coordinate system is `FADADA_800_1131_TOP_LEFT`, which uses zero-based pages, a top-left origin, x values in the `0..800` range, and y values in the `0..1131` range.

The recorded point represents the center of the signing or seal blank area, not the keyword text baseline and not the keyword text start position. Artifact writing must fail before storage if any required Stage 1 slot coordinate is missing, has an invalid page number, has out-of-range x/y values, or has non-positive width/height.

This metadata is the source of truth for Fadada `signature_positions` mapping. The customer-side Stage 1 mapping uses the persisted generated PDF artifact diagnostics directly and must not recalculate coordinates, parse the PDF, or use keyword fallback.

Generated Stage 1 source artifacts now propagate renderer-produced slot coordinates beyond the writer result. After successful artifact writing, `OrderService.generateContract()` stores the generated PDF artifact diagnostics in `Contract.contractSnapshot.generatedContractPdfArtifact`, including:

- `source=GENERATED_CONTRACT_PDF`
- generated `fileId`
- generated source PDF `objectKey`
- `signingStage=STAGE1_CONTRACT`
- four Stage 1 `slotCoordinates`

`ContractPdfArtifactService` reads this persisted diagnostic metadata for generated `Contract.fileId` artifacts and exposes the coordinates to future e-sign provider mapping. It does not invent coordinates for `ContractVersion.fileId` legacy fallback artifacts, parse the PDF after generation, recalculate positions, or fall back to keyword search.

When Stage 1 multi-slot signing is requested, missing or invalid persisted coordinates must fail preflight before provider calls. Customer-side `extsign.api` mapping serializes the two customer slot coordinates into one signing URL. Platform-side `extsign_auto.api` mapping serializes the two platform slot coordinates into one auto-seal request with `position_type=1` and explicit `signature_id`.

## Stage 2 Boundary

Attachment 2 vehicle handover / delivery confirmation is not rendered in the Stage 1 contract PDF. It should become a separate future document/task for delivery evidence signing. Lease commencement and billing activation alignment must be based on the future delivery handover customer signed time, not on Stage 1 contract signing, and remain separate future work.

## Size Limit

The generated signing PDF size limit is a hard 20MB limit, aligned with Fadada upload requirements. The renderer and artifact writer must reject generated PDFs larger than 20MB before storage write.

## E-Sign Upload Preflight

Issue 4A-1E hardens e-sign upload source selection before sending a document to Fadada:

- PDF header starts with `%PDF-`
- MIME type is `application/pdf`
- size is `<=20MB`
- `TEST_FIXTURE` is never used when `FADADA_ENABLED=true`
- obvious sandbox/test fixture artifact paths are rejected when identifiable
- enterprise auto seal requires `Contract.fileId`
- enterprise auto seal rejects `ContractVersion.fileId`
- enterprise auto seal requires the generated object key pattern:
- Stage 1 multi-slot signing preflight requires generated source artifact slot coordinate diagnostics

```text
contracts/{contractId}/generated/{fileName}
```

Storage prefixes are allowed when the generated pattern is still present, for example:

```text
oss:<prefix>/contracts/{contractId}/generated/{fileName}
```

`ContractVersion.fileId` remains a legacy/manual fallback only when Fadada policy allows it and enterprise auto seal is disabled. It must still pass PDF MIME/header/size validation.

PDF text extraction is intentionally deferred. The current preflight verifies artifact source and PDF envelope safety, but it does not prove the rendered PDF text is searchable or visually correct. Sandbox visual review remains required before production enablement.

## Signed PDF Archive Boundary

The artifact writer creates only the pre-signing source PDF. Final signed PDF archive remains separate and must continue to use the existing signed artifact/archive flow after customer signature and platform seal are both complete.

The sandbox validation record must capture both paths:

- generated source PDF object key
- final signed PDF archive object key

These paths must not be mixed. A generated source PDF is not proof of signing completion, and a final signed PDF archive must not be reused as a new pre-signing source artifact.

## Sandbox Validation And Go/No-Go

Before production enablement, complete `docs/esign-sandbox-validation-record.md` and the checklist in `docs/esign-enterprise-auto-seal-go-no-go.md`.

The validation record must include:

- CJK font deployment checklist evidence
- formal legal template approval evidence
- appendix approval evidence
- CJK font path verification
- Stage 1 slot strategy and uniqueness evidence
- Stage 1 slot uniqueness evidence
- generated source PDF preflight result
- Stage 1 signing slot visual check
- Fadada provider task and callback result
- final signed PDF archive verification
- reviewer result and go/no-go recommendation

Old failed e-sign tasks must not be manually marked successful. Existing stale sandbox contracts must not be automatically backfilled. After fixes, create a new controlled order, contract, and signing task.

## Fadada Documentation Boundary

Before any future task implements or modifies Fadada upload, signing, auto-signing, callback, download, or archive behavior, check the local Fadada developer documentation under:

```text
D:\Projects\document\fadada\doc
```

Do not guess Fadada parameter semantics from memory.

## Fadada Protocol Foundation

The Fadada protocol foundation now enforces safe provider transaction IDs and endpoint-specific request semantics before full Stage 1 multi-position mapping:

- provider `transaction_id` must be 1-32 ASCII letters or digits
- `extsign_auto.api` request digest includes its `transaction_id`
- `extsign_auto.api` success is the documented provider code `1000`
- `query_sign_result.api` requires `customer_id`, `contract_id`, and `transaction_id`
- `query_sign_result.api` parses the documented `view_url`
- unknown Fadada callback transactions are isolated and do not mutate tasks
- callbacks with mismatched `contract_id` are isolated and do not mutate tasks

Stage 1 provider mapping remains separate from PDF generation. The customer side maps one `extsign.api` transaction with two `signature_positions` from generated artifact coordinates. The platform side maps one `extsign_auto.api` transaction with `position_type=1`, two `signature_positions` from generated artifact coordinates, and explicit `signature_id`. This still has not been production-enabled by the PDF artifact foundation alone.

The local e-sign task model has a guarded Stage 1 slot completion foundation behind `ESIGN_STAGE1_MULTI_SLOT_ENABLED`, which defaults to false. When enabled, multiple local slot rows may share one provider transaction id, callbacks update only rows with the matching transaction id, and final completion/archive remain blocked until all required slot rows are signed.

The current Fadada provider supports customer-side and platform-side Stage 1 coordinate mapping. Platform auto seal is triggered only after both customer slot rows are signed and both `ESIGN_STAGE1_MULTI_SLOT_ENABLED=true` and `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=true` are configured. Do not enable the Stage 1 multi-slot flow in production before the complete customer and platform multi-position flow is sandbox-proven and go/no-go approved.

## Current Foundation Boundary

This renderer foundation does:

- render deterministic PDF buffers from structured render models
- validate non-empty legal body
- validate non-empty Stage 1 signing slots
- enforce CJK font configuration for CJK content
- enforce generated buffer PDF header and size limit

This artifact writer foundation does:

- call the renderer
- write generated source PDFs to private Storage
- create `FileObject`
- validate required renderer diagnostics
- validate Stage 1 signing slot uniqueness in the render model
- enforce the 20MB artifact size limit
- reject protected contract statuses
- reject existing contract PDF artifacts unless regeneration is explicitly allowed

This OrderService integration foundation does:

- add `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED`
- keep the flag disabled by default
- build a render model from the selected contract version and order snapshot
- pass the approved Stage 1 signing slots and platform offset metadata
- call the artifact writer only when the flag is enabled
- write `Contract.fileId` only after writer success
- move the order to `PENDING_SIGN` only after `Contract.fileId` succeeds

This e-sign source hardening does:

- apply Fadada upload policy before provider upload
- block `TEST_FIXTURE` in Fadada mode
- require generated `Contract.fileId` for enterprise auto seal
- reject generated-source object keys for the wrong contract or signed archive path
- enforce MIME/header/size checks before upload
- keep pre-signing source PDF separate from final signed PDF archive

This foundation does not:

- modify `ContractVersion.fileId`
- call Fadada
- trigger e-sign
- archive signed PDFs
- generate real production contracts
- import formal legal text
- commit font files

## Future PRs

Recommended follow-up sequence:

1. CJK font deployment checklist: complete `docs/cjk-font-deployment-checklist.md` evidence and choose the approved deployment method.
2. Formal template import: import legal-approved contract text and appendix structure after external approval, including Stage 1 slot strategy.
3. CJK font deployment: configure `CONTRACT_PDF_CJK_FONT_PATH` outside the repository and verify it inside the API container.
4. Stage 1 Fadada sandbox validation: prove customer two-position signing, platform two-position auto seal, callbacks, final PDF, and archive behavior against the local Fadada docs.
5. Sandbox validation record: complete the generated source PDF and final signed PDF evidence trail.
6. Stage 2 delivery handover architecture: design Attachment 2 as a separate delivery document/task.
7. Optional PDF text extraction preflight, only after dependency/security approval.
8. Production enablement runbook: enable only after legal, CJK, source hardening, double-sign, archive, and rollback gates pass.
