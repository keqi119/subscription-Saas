# eSign Sandbox Validation Record

Use this record before enabling enterprise auto seal in production. This is a template only; it does not approve production enablement by itself.

Codex must not write legal contract text, invent appendix wording, add font files, call Fadada, trigger e-sign, query production data, or mark failed tasks successful.

Complete the CJK font deployment operator checklist in `docs/cjk-font-deployment-checklist.md` before recording generated PDF artifact evidence for Chinese/CJK contract content.

For the approved image-install path, record Source Han Sans SC from the Adobe Source Han Sans `2.005R` release, license recorded as SIL Open Font License 1.1, release asset SHA256, and the runtime path `/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf`.

## 1. Basic Information

| Field | Value |
| --- | --- |
| Environment | TBD |
| Date/time | TBD |
| Reviewer | TBD |
| API commit SHA | TBD |
| Web commit SHA, if relevant | TBD |
| API image/tag | TBD |
| Database snapshot/reference, if applicable | TBD |

## 2. Feature Flags

| Flag | Value | Evidence |
| --- | --- | --- |
| `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED` | TBD | TBD |
| `CONTRACT_PDF_CJK_FONT_PATH` | TBD | TBD |
| `FADADA_ENABLED` | TBD | TBD |
| `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED` | TBD | TBD |
| `ESIGN_PLATFORM_SEAL_KEYWORD` | TBD | TBD |
| `ESIGN_PLATFORM_SEAL_KEYX` | TBD | TBD |
| `ESIGN_PLATFORM_SEAL_KEYY` | TBD | TBD |

## 3. Legal Template Approval

| Field | Value |
| --- | --- |
| Template name | TBD |
| Version number | TBD |
| Effective date | TBD |
| Legal approver | TBD |
| Business approver | TBD |
| Approval evidence location | TBD |
| Confirmation that Codex did not write legal text | TBD |
| Stage 1 slot strategy selected | TBD |
| Stage 1 source PDF excludes Attachment 2 | TBD |
| Final render model has each required Stage 1 slot keyword exactly once | TBD |

## 4. Appendix Approval

| Field | Value |
| --- | --- |
| Approved appendix fields | TBD |
| Excluded sensitive fields | TBD |
| Approver | TBD |
| Approval evidence location | TBD |

## 5. CJK Font Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Font path | TBD | TBD |
| Selected font source | Source Han Sans SC / Adobe Source Han Sans `2.005R` | TBD |
| Release asset URL | `https://github.com/adobe-fonts/source-han-sans/releases/download/2.005R/09_SourceHanSansSC.zip` | TBD |
| Release asset SHA256 | `ef7364f7ac2564be1ae9c1d74276de2653fe38b73449070398c4fc0b7e032ff1` | TBD |
| Extracted image font file | `/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf` | TBD |
| Image build checksum verification passed | TBD | TBD |
| Font family/package/file approved by operator/legal | TBD | TBD |
| Font license approval recorded | TBD | TBD |
| Container path exists | TBD | TBD |
| API process can read path | TBD | TBD |
| Generated PDF Chinese text is not garbled | TBD | TBD |
| PDF remains searchable text | TBD | TBD |
| No font file committed to repository | TBD | TBD |
| CJK checklist evidence location | TBD | TBD |

## 6. Generated PDF Artifact

| Field | Value |
| --- | --- |
| Order ID | TBD |
| Contract ID | TBD |
| Contract number | TBD |
| `contract.fileId` | TBD |
| `FileObject.objectKey` | TBD |
| Object key matches generated artifact pattern | TBD |
| MIME type | TBD |
| Size | TBD |
| `%PDF-` header check | TBD |
| Under 20MB | TBD |
| Source hardening preflight result | TBD |

The expected generated artifact path pattern is:

```text
contracts/{contractId}/generated/{fileName}
```

Storage prefixes are acceptable only when the generated artifact pattern remains present and the object is not a test, sandbox, or final signed archive path.

## 7. Stage 1 Signing Slots

Required Stage 1 slot keywords:

- Contract body customer signature: `合同正文-订阅方签字`
- Contract body platform/company seal: `合同正文-服务提供方盖章`
- Attachment 1 customer signature: `附件1订阅方案-订阅方签字`
- Attachment 1 platform/company seal: `附件1订阅方案-服务提供方盖章`

| Check | Result | Evidence |
| --- | --- | --- |
| `合同正文-订阅方签字` appears exactly once | TBD | TBD |
| `合同正文-服务提供方盖章` appears exactly once | TBD | TBD |
| `附件1订阅方案-订阅方签字` appears exactly once | TBD | TBD |
| `附件1订阅方案-服务提供方盖章` appears exactly once | TBD | TBD |
| Stage 1 source PDF contains contract main body | TBD | TBD |
| Stage 1 source PDF contains Attachment 1 subscription plan / transaction terms snapshot | TBD | TBD |
| Stage 1 source PDF excludes Attachment 2 vehicle handover / delivery confirmation | TBD | TBD |
| Platform seal slots have right-side blank space | TBD | TBD |
| Platform offset intent: `keyx=60`, `keyy=0` | TBD | TBD |
| Older generic anchors do not drive Stage 1 provider placement | TBD | TBD |
| Provider multi-position mapping checked separately before Fadada sandbox signing | TBD | TBD |
| Screenshot/evidence location | TBD | TBD |

## 8. Fadada Task

Before recording a real sandbox result, the provider request and callback behavior must be checked against the local Fadada developer documentation under:

```text
D:\Projects\document\fadada\doc
```

Representative document categories to check:

- Contract upload
- Customer/manual signing
- Platform auto signing
- All-auto batch signing, if used
- Signing result async notification / `notify_url`
- Signed file download
- Contract archive behavior

| Field | Value |
| --- | --- |
| Task number | TBD |
| Provider request checked against local Fadada docs | TBD |
| Provider `transaction_id` values are 1-32 ASCII letters/digits | TBD |
| Request digest formula evidence captured | TBD |
| `extsign_auto.api` success code is `1000` | TBD |
| `query_sign_result.api` includes `customer_id`, `contract_id`, and `transaction_id` | TBD |
| Customer signer status | TBD |
| Platform signer status | TBD |
| Callback status | TBD |
| Callback idempotency check | TBD |
| Unknown transaction callback isolation check | TBD |
| Mismatched `contract_id` callback isolation check | TBD |
| Raw provider error, if any | TBD |

Expected future Stage 1 provider mapping remains:

- customer: one `extsign.api` transaction with two `signature_positions`
- platform: one `extsign_auto.api` transaction with `position_type=1`, two `signature_positions`, and explicit `signature_id`

Do not treat this protocol foundation as proof that full Stage 1 multi-position mapping has passed sandbox validation.

## 9. Final Signed PDF Archive

| Check | Result | Evidence |
| --- | --- | --- |
| Signed PDF object key | TBD | TBD |
| Archive path is final signed artifact path, not generated source path | TBD | TBD |
| Customer signature visible | TBD | TBD |
| Platform/company seal visible | TBD | TBD |
| Final PDF downloadable by authorized admin | TBD | TBD |
| No public exposure | TBD | TBD |

## 10. Result

Allowed results:

- `PASS`
- `PASS_WITH_NOTES`
- `FAIL`

| Field | Value |
| --- | --- |
| Result | TBD |
| Notes | TBD |
| Reviewer signature/name | TBD |
| Go/no-go recommendation | TBD |

## 11. Attachments / Evidence

Record evidence references without pasting secrets, identity documents, provider tokens, seal binaries, private download URLs, or raw credentials.

| Evidence | Location |
| --- | --- |
| Generated PDF screenshot | TBD |
| Signed PDF screenshot | TBD |
| Provider task screenshot | TBD |
| Callback log reference | TBD |
| Archive object reference | TBD |
| Approval document reference | TBD |
