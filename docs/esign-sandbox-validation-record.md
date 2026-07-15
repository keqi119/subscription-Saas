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
| `ESIGN_STAGE1_MULTI_SLOT_ENABLED` | TBD | TBD |
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
| Final render model has each required Stage 1 slot definition and coordinate exactly once | TBD |

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
| `STAGE1_BODY_CUSTOMER` slot definition and coordinate appear exactly once | TBD | TBD |
| `STAGE1_BODY_PLATFORM` slot definition and coordinate appear exactly once | TBD | TBD |
| `附件1订阅方案-订阅方签字` appears exactly once | TBD | TBD |
| `附件1订阅方案-服务提供方盖章` appears exactly once | TBD | TBD |
| Stage 1 source PDF contains contract main body | TBD | TBD |
| Stage 1 source PDF contains Attachment 1 subscription plan / transaction terms snapshot | TBD | TBD |
| Stage 1 source PDF excludes independent Attachment 2 vehicle handover sections/forms/signing areas; ordinary main-body legal references to the future handover document are allowed | TBD | TBD |
| First-page title is `汽车订阅服务合同` | TBD | TBD |
| Metadata and section headings are rendered in Chinese | TBD | TBD |
| Main body signing labels are visible without duplicate standalone keyword lines | TBD | TBD |
| Platform seal slots have right-side blank space | TBD | TBD |
| Platform offset intent: `keyx=60`, `keyy=0` | TBD | TBD |
| Older generic anchors do not drive Stage 1 provider placement | TBD | TBD |
| Provider multi-position mapping checked separately before Fadada sandbox signing | TBD | TBD |
| Screenshot/evidence location | TBD | TBD |

## 7A. Stage 1 Slot Coordinates

Renderer-produced coordinate metadata must be recorded before any future Fadada `signature_positions` sandbox call. Coordinates are generated during PDFKit rendering; do not use post-render PDF text parsing as the source of truth.

| Check | Result | Evidence |
| --- | --- | --- |
| Four Stage 1 slot coordinate records exist | TBD | TBD |
| Each coordinate record has `coordinateSource=PDFKIT_RENDERER` | TBD | TBD |
| Each coordinate record has `coordinateSystem=FADADA_800_1131_TOP_LEFT` | TBD | TBD |
| Each `pageNumber` is zero-based and `>=0` | TBD | TBD |
| Each `x` is within `0..800` | TBD | TBD |
| Each `y` is within `0..1131` | TBD | TBD |
| Each `width` and `height` is positive | TBD | TBD |
| Coordinates point to signing/seal blank area centers, not keyword text starts | TBD | TBD |
| Coordinates persisted in `Contract.contractSnapshot.generatedContractPdfArtifact` | TBD | TBD |
| Persisted coordinate metadata includes `source=GENERATED_CONTRACT_PDF` | TBD | TBD |
| Persisted coordinate metadata matches generated `contract.fileId` and source object key | TBD | TBD |
| E-sign artifact resolver exposes the four persisted coordinates | TBD | TBD |
| Stage 1 multi-slot preflight rejects missing coordinates before provider calls | TBD | TBD |
| Contract body slot coordinates visually align with the body signing area | TBD | TBD |
| Attachment 1 slot coordinates visually align with the Attachment 1 signing area | TBD | TBD |
| Generated PDF has no visible `Render Diagnostics` section | TBD | TBD |
| Party A information is preserved from the approved ContractVersion template | TBD | TBD |
| Party B dynamic fields are populated from approved customer sources only | TBD | TBD |
| Party B certificate number is populated from customer-entered `CustomerIdentity.idCardNo` in the legal PDF | TBD | TBD |
| Contract/order status responses, logs, and reports do not expose the full Party B certificate number | TBD | TBD |
| Missing Party B certificate number blocks Stage 1 PDF generation before signing | TBD | TBD |
| Subscriber WeChat and email are blank when no reliable customer-facing source exists | TBD | TBD |
| Attachment 1 labels use monthly quota units and `超里程费（人民币元/公里）` | TBD | TBD |
| Attachment 1 starts on a new page after main body signing slots | TBD | TBD |
| Customer signature and platform seal slots are visually separated on both signing pages | TBD | TBD |

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
| Customer `extsign.api` digest uses the manual-signing endpoint formula, not generic business-parameter sorting | TBD |
| Customer `signature_positions` are serialized once as compact JSON and the sent parameter value is retained as evidence | TBD |
| `extsign_auto.api` success code is `1000` | TBD |
| `query_sign_result.api` includes `customer_id`, `contract_id`, and `transaction_id` | TBD |
| Customer signer status | TBD |
| Platform signer status | TBD |
| Callback status | TBD |
| Callback idempotency check | TBD |
| Unknown transaction callback isolation check | TBD |
| Mismatched `contract_id` callback isolation check | TBD |
| Local Stage 1 slot rows created from provider action result | TBD |
| Customer provider transaction covers both customer slot rows | TBD |
| Customer `extsign.api` request includes exactly two coordinate `signature_positions` | TBD |
| Customer `signature_positions` are sourced from generated artifact diagnostics, not recalculated | TBD |
| Platform provider transaction covers both platform slot rows | TBD |
| Platform auto seal is triggered only after both customer slot rows are signed | TBD |
| Platform `extsign_auto.api` request includes `position_type=1` | TBD |
| Platform `extsign_auto.api` request includes explicit `signature_id` | TBD |
| Platform `extsign_auto.api` request includes exactly two coordinate `signature_positions` | TBD |
| Platform `signature_positions` are sourced from generated artifact diagnostics, not recalculated | TBD |
| Callback updates only rows with matching provider `transaction_id` | TBD |
| Partial slot completion leaves task non-completed | TBD |
| Task completes only after all required slot rows are signed | TBD |
| Raw provider error, if any | TBD |

Expected Stage 1 provider mapping:

- customer: one `extsign.api` transaction with two coordinate `signature_positions` from generated PDF artifact diagnostics
- platform: one `extsign_auto.api` transaction with `position_type=1`, two coordinate `signature_positions` from generated PDF artifact diagnostics, and explicit `signature_id`

`ESIGN_STAGE1_MULTI_SLOT_ENABLED` defaults to false. Stage 1 platform auto-seal also requires `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=true`. Provider-side customer/platform mapping being implemented does not prove production readiness; the complete customer signing, platform auto-seal, callback, final PDF, and archive flow must pass sandbox validation before production enablement.

## 8A. Customer Fadada Readiness and Onboarding UI

| Check | Result | Evidence |
| --- | --- | --- |
| Portal contract page loads authenticated customer onboarding readiness | TBD | TBD |
| Portal blocks signing when `readyForSigning=false` | TBD | TBD |
| Portal offers real-name start/resume without displaying full ID number | TBD | TBD |
| Portal start/resume redirects using the returned real-name URL only for the authenticated customer action | TBD | TBD |
| Portal status view does not expose full real-name URL, tokens, full ID number, or raw provider customer id | TBD | TBD |
| Portal refresh updates provider-backed real-name/certificate readiness before signing retry | TBD | TBD |
| Portal shows bind-cert guidance, not repeat-real-name guidance, when readiness next action is `APPLY_CERT` | TBD | TBD |
| Readiness refresh applies and then queries Fadada cert binding after provider-backed real-name is verified | TBD | TBD |
| Admin contract page displays readiness reason before `发起电子签` | TBD | TBD |
| Admin `发起电子签` is disabled when provider-backed real-name/certificate evidence is missing | TBD | TBD |
| Manual provider-customer-id attachment remains blocked until provider-backed real-name and cert-bound evidence is refreshed | TBD | TBD |
| Backend blocks Fadada task creation when readiness is not signing-enabled | TBD | TBD |
| Backend blocks Portal signing-link return/refresh when readiness is not signing-enabled | TBD | TBD |
| Audit/log evidence excludes full real-name URL, tokens, full ID number, and raw provider customer id | TBD | TBD |

Known failed controlled task `ESG20260711184435WMCD` reached the customer signing page and failed provider digest validation. Do not repair or reuse that failed task. After deploying the digest/serialization fix, the sandbox retry must use a new controlled order, generated source PDF, and e-sign task.

## 9. Final Signed PDF Archive

| Check | Result | Evidence |
| --- | --- | --- |
| Signed PDF object key | TBD | TBD |
| Archive path is final signed artifact path, not generated source path | TBD | TBD |
| Customer signature visible | TBD | TBD |
| Platform/company seal visible | TBD | TBD |
| Final PDF downloadable by authorized admin | TBD | TBD |
| No public exposure | TBD | TBD |
| Archive blocked before all required Stage 1 slot rows are signed | TBD | TBD |
| Archive allowed only after all required Stage 1 slot rows are signed | TBD | TBD |

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

## 10A. Stage 1 V1.4 Final Sandbox Closeout

Result: `PASS_WITH_NOTES`

This closeout records the controlled Stage 1 V1.4 sandbox run completed on 2026-07-13. The initial automated visual review was corrected from `FAIL/HOLD` to `PASS_WITH_NOTES` after operator review and PDF structure inspection showed that the signed PDF uses PDF annotation appearances that were not rendered by the original `pdfplumber`/Pillow-based visual check.

| Field | Value |
| --- | --- |
| API image | `ghcr.io/keqi119/subscription-api:Staging-20260713-9580613` |
| Web image | `ghcr.io/keqi119/subscription-web:Staging-20260713-9580613` |
| ContractVersion | `test_001 / V1.4` |
| Order number | `ORD20260713063232YN5L` |
| Contract number | `CON202607130633247T8L` |
| E-sign task / provider contract id | `ESG2026071306414027KJ` |
| Platform signature id | `1783852637391749` |
| Signed PDF SHA256 | `01c34bd12db6c3ba03ae4d48c85ca0a32956ca0c94c90e493bf5d16855375808` |
| Result | `PASS_WITH_NOTES` |
| Production status | `GO CANDIDATE`; final production GO still requires explicit operator/legal approval |

Controlled pass evidence:

- Source PDF legal/visual checks passed.
- Party A / service-provider fields were preserved from the approved `ContractVersion` template.
- Party B / subscriber fields were populated from approved dynamic customer sources.
- Chinese first-page title, metadata labels, and section headings passed review.
- Attachment 1 unit labels and yuan-per-km over-mileage display passed review.
- Refined Stage 1 Attachment 2 boundary passed: independent Attachment 2 handover sections/forms/signing areas were excluded.
- Customer two-slot signing passed.
- Platform two-slot auto-seal passed with `FADADA_PLATFORM_SIGNATURE_ID=1783852637391749`.
- Callback handling passed and the task completed only after all required slot rows were signed.
- Contract moved to signed state.
- Signed PDF archive completed.
- The backend-downloaded signed PDF SHA256 matched the system-archived signed PDF SHA256.

Annotation appearance correction:

- The signed PDF contains PDF `/Widget` annotations with `/AP` appearance streams for the signature/seal appearances.
- Page 5 has two `/Widget` annotations with `/AP` appearance.
- Page 6 has two `/Widget` annotations with `/AP` appearance.
- The previous `pdfplumber`/Pillow-based visual inspection did not render annotation appearance and produced a false negative.
- Future automated visual validation must not rely solely on `pdfplumber`/Pillow for customer signature or platform seal appearance.

Preferred future validation sources:

- Human review in the system backend PDF viewer.
- Browser PDF viewer or another viewer known to render PDF annotation appearances.
- Poppler or another rasterizer configured to render annotation appearances.
- PDF structure checks for `/Widget` annotations with `/AP` appearance on the expected signing pages.
- Fadada console/log evidence for provider-side signing/seal completion.

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
