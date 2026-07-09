# Contract PDF Artifact Generation

Status: renderer, artifact-writer, and guarded OrderService integration foundation only. This document does not enable production contract PDF generation by default.

## Current Gap

`ContractVersion.contentTemplate` is saved into `contractSnapshot.contentTemplate`, but the current contract generation flow does not render it into a signing PDF artifact.

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
- order snapshot appendix sections and rows
- signing anchors
- render diagnostics

This renderer foundation does not create `FileObject`, does not write `Contract.fileId`, does not upload files, and does not change e-sign upload behavior.

## Artifact Writer Foundation

The artifact writer foundation adds the internal path:

```text
ContractPdfRenderModel -> ContractPdfRendererService -> private Storage object -> FileObject
```

The writer returns generated artifact metadata to callers. `OrderService.generateContract()` can now call the writer and bind the returned `FileObject` to `Contract.fileId` only when guarded artifact generation is explicitly enabled.

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

## Font Boundary

Chinese contract PDFs require an operator-supplied CJK font path.

Recommended configuration:

```text
CONTRACT_PDF_CJK_FONT_PATH=/path/to/approved-cjk-font
```

Font files are not committed to the repository and must not be shared in Codex output.

If rendered content contains CJK characters and no usable CJK font path is configured, the renderer must fail fast instead of silently generating garbled Chinese output.

## Signing Anchors

Approved anchor keywords:

- Platform / service provider seal: `服务提供方盖章`
- Customer signature: `订阅方盖章/签字`

The signing PDF must contain these keywords and reserve blank space on the right side for signing or sealing.

Generated signing PDFs must be text-based and searchable. Image-only PDFs are not acceptable because Fadada keyword positioning requires the keyword to exist as searchable document text.

Each signing anchor must appear exactly once in the generated render model:

- `服务提供方盖章`
- `订阅方盖章/签字`

If an anchor is missing or duplicated, artifact writing must fail before storage write and before `FileObject` creation. Keyword strategy support is deferred to a separately approved provider-positioning task.

The requested platform seal right offset is:

```text
60px
```

Provider-side placement must remain consistent with the generated PDF anchor layout.

The provider offset mapping is not writer responsibility. `keyx=60` and `keyy=0` belong to the e-sign/Fadada positioning layer.

## Size Limit

The generated signing PDF size limit is a hard 20MB limit, aligned with Fadada upload requirements. The renderer and artifact writer must reject generated PDFs larger than 20MB before storage write.

## E-Sign Upload Preflight Boundary

Future Issue 4A-1E must harden e-sign upload source selection before sending a document to Fadada:

- PDF header starts with `%PDF-`
- MIME type is `application/pdf`
- size is `<=20MB`
- source is a generated contract artifact
- fixture fallback is not used for production/Fadada mode
- renderer/artifact diagnostics show both anchors exist
- if practical without unacceptable dependency risk, PDF text extraction confirms both anchors are searchable text

This document does not implement the e-sign upload preflight.

## Signed PDF Archive Boundary

The artifact writer creates only the pre-signing source PDF. Final signed PDF archive remains separate and must continue to use the existing signed artifact/archive flow after customer signature and platform seal are both complete.

## Current PR Boundary

This renderer foundation does:

- render deterministic PDF buffers from structured render models
- validate non-empty legal body
- validate non-empty signing anchors
- enforce CJK font configuration for CJK content
- enforce generated buffer PDF header and size limit

This artifact writer foundation does:

- call the renderer
- write generated source PDFs to private Storage
- create `FileObject`
- validate required renderer diagnostics
- validate signing anchor uniqueness in the render model
- enforce the 20MB artifact size limit
- reject protected contract statuses
- reject existing contract PDF artifacts unless regeneration is explicitly allowed

This OrderService integration foundation does:

- add `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED`
- keep the flag disabled by default
- build a render model from the selected contract version and order snapshot
- pass the approved signing anchors and platform offset metadata
- call the artifact writer only when the flag is enabled
- write `Contract.fileId` only after writer success
- move the order to `PENDING_SIGN` only after `Contract.fileId` succeeds

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

1. E-sign preflight: require generated artifact source for real Fadada signing and validate signing anchors.
2. Formal template import: import legal-approved contract text and appendix structure after external approval.
3. CJK font deployment: configure `CONTRACT_PDF_CJK_FONT_PATH` outside the repository.
4. Sandbox go/no-go: visually verify generated PDF and final signed PDF before production enablement.
