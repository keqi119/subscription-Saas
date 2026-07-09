# eSign Sandbox Validation Record

Use this record before enabling enterprise auto seal in production. This is a template only; it does not approve production enablement by itself.

Codex must not write legal contract text, invent appendix wording, add font files, call Fadada, trigger e-sign, query production data, or mark failed tasks successful.

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
| Container path exists | TBD | TBD |
| API process can read path | TBD | TBD |
| Generated PDF Chinese text is not garbled | TBD | TBD |
| PDF remains searchable text | TBD | TBD |
| No font file committed to repository | TBD | TBD |

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

## 7. Signing Anchors

Required anchors:

- `服务提供方盖章`
- `订阅方盖章/签字`

| Check | Result | Evidence |
| --- | --- | --- |
| `服务提供方盖章` appears exactly once | TBD | TBD |
| `订阅方盖章/签字` appears exactly once | TBD | TBD |
| Platform seal area has right-side blank space | TBD | TBD |
| Platform offset intent: `keyx=60`, `keyy=0` | TBD | TBD |
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
| Customer signer status | TBD |
| Platform signer status | TBD |
| Callback status | TBD |
| Callback idempotency check | TBD |
| Raw provider error, if any | TBD |

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
