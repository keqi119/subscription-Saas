# Contract PDF Artifact Generation

Status: renderer foundation only. This document does not enable production contract PDF generation.

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

This foundation does not create `FileObject`, does not write `Contract.fileId`, does not upload files, and does not change e-sign upload behavior.

## Legal Boundary

Formal legal contract text must be supplied externally by legal/operator reviewers.

Codex must not invent:

- legal contract terms
- legal appendix wording
- approved production template text
- seal IDs or provider credentials

Synthetic test text is allowed only for automated renderer tests and must not be used as a production contract template.

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

The requested platform seal right offset is:

```text
60px
```

Provider-side placement must remain consistent with the generated PDF anchor layout.

## Current PR Boundary

This renderer foundation does not:

- integrate with `OrderService.generateContract()`
- create `FileObject`
- write `Contract.fileId`
- modify `ContractVersion.fileId`
- upload generated PDFs
- call Fadada
- trigger e-sign
- archive signed PDFs
- generate real production contracts
- import formal legal text
- commit font files

## Future PRs

Recommended follow-up sequence:

1. Artifact writer: render PDF buffer, store it through existing storage, create `FileObject`, and bind `Contract.fileId`.
2. Order integration: call renderer/writer during contract generation.
3. E-sign preflight: require generated artifact source for real Fadada signing and validate signing anchors.
4. Offset config: wire platform seal offset values into provider placement if not already configured.
5. Formal template import: import legal-approved contract text and appendix structure after external approval.
6. Sandbox go/no-go: visually verify generated PDF and final signed PDF before production enablement.
