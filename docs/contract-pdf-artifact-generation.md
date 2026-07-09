# Contract PDF Artifact Generation

Status: renderer and artifact-writer foundation only. This document does not enable production contract PDF generation.

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

The writer returns generated artifact metadata to callers, but it still does not update `Contract.fileId` and does not integrate with `OrderService.generateContract()`.

Generated source PDFs are stored as private objects. This remains compatible with Fadada because provider upload can send file content and does not require a public `doc_url`.

The generated object key pattern is:

```text
contracts/{contractId}/generated/{safeFileName}
```

If `FileObject` creation fails after storage succeeds, the writer performs best-effort private-object cleanup through `StorageService.deleteObject`. If cleanup also fails, an orphan private object may require operator cleanup.

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

This foundation does not:

- integrate with `OrderService.generateContract()`
- write `Contract.fileId`
- modify `ContractVersion.fileId`
- call Fadada
- trigger e-sign
- archive signed PDFs
- generate real production contracts
- import formal legal text
- commit font files

## Future PRs

Recommended follow-up sequence:

1. Order integration: call renderer/writer during contract generation and bind `Contract.fileId`.
2. E-sign preflight: require generated artifact source for real Fadada signing and validate signing anchors.
3. Offset config: wire platform seal offset values into provider placement if not already configured.
4. Formal template import: import legal-approved contract text and appendix structure after external approval.
5. CJK font deployment: configure `CONTRACT_PDF_CJK_FONT_PATH` outside the repository.
6. Sandbox go/no-go: visually verify generated PDF and final signed PDF before production enablement.
