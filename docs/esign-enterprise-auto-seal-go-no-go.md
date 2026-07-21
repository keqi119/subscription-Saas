# eSign Enterprise Auto Seal Go/No-Go Checklist

Status: Stage 1 V1.4 sandbox evidence is `PASS_WITH_NOTES` and is a production `GO CANDIDATE`. Final production GO still requires explicit operator/legal approval.

This checklist must be completed before enabling enterprise auto seal in production. It does not replace legal approval, operator approval, or provider-console approval.

## Stage 1 V1.4 Closeout Update

Controlled sandbox closeout result: `PASS_WITH_NOTES`

Evidence recorded on 2026-07-13:

- API image: `ghcr.io/keqi119/subscription-api:Staging-20260713-9580613`
- Web image: `ghcr.io/keqi119/subscription-web:Staging-20260713-9580613`
- ContractVersion: `test_001 / V1.4`
- Order number: `ORD20260713063232YN5L`
- Contract number: `CON202607130633247T8L`
- E-sign task / provider contract id: `ESG2026071306414027KJ`
- Platform signature id: `1783852637391749`
- Signed PDF SHA256: `01c34bd12db6c3ba03ae4d48c85ca0a32956ca0c94c90e493bf5d16855375808`

Stage 1 technical and legal/visual sandbox evidence is a `GO CANDIDATE` for Stage 1 production enablement. This is not a final production GO. Final production enablement still requires explicit operator/legal approval, controlled runtime flag changes outside the repository, and the normal rollback readiness check.

Correction note: the first automated visual review did not show signatures/seals because the `pdfplumber`/Pillow raster path did not render PDF annotation appearance. Operator backend PDF review, Fadada console/log evidence, SHA match, and PDF structure inspection corrected the result to `PASS_WITH_NOTES`.

Future visual acceptance must not rely solely on `pdfplumber`/Pillow for signature/seal appearance. Use a backend/browser PDF viewer or Poppler-equivalent renderer that renders annotation appearance, and record PDF structure evidence for `/Widget` annotations with `/AP` appearance when automated raster evidence is uncertain.

## Release Identity

- Branch: TBD
- Commit: TBD
- API image: TBD
- Environment: staging before production
- Operator: TBD
- Reviewer: TBD

## Provider Prerequisites

- [ ] Enterprise account is configured in the provider console.
- [ ] Lessor/company seal is uploaded and approved.
- [ ] Auto-sign API permission is enabled.
- [ ] `FADADA_PLATFORM_CUSTOMER_ID` is configured outside the repository.
- [ ] `FADADA_PLATFORM_SIGNATURE_ID` is configured outside the repository.
- [ ] `ESIGN_PLATFORM_SEAL_KEYWORD` is configured outside the repository if a legacy keyword-based flow is used.
- [ ] Callback endpoint is confirmed.
- [ ] Seal placement or keyword rule is approved.
- [ ] Provider sandbox run completed.
- [ ] Fadada upload, signing, auto-signing, callback, download, and archive behavior has been checked against the local developer docs under `D:\Projects\document\fadada\doc`.
- [ ] Fadada provider `transaction_id` format is verified as 1-32 ASCII letters or digits.
- [ ] Fadada request digest formulas are checked against the relevant local docs before any provider call.
- [ ] Customer `extsign.api` coordinate signing URLs use the manual-signing endpoint digest formula and not the generic sorted business-parameter digest.
- [ ] Customer `extsign.api` `signature_positions` are serialized once as compact JSON and the value used for evidence matches the value sent to Fadada.
- [ ] `extsign_auto.api` success handling treats only documented success code `1000` as auto-sign success.
- [ ] `query_sign_result.api` calls include `customer_id`, `contract_id`, and `transaction_id`.
- [ ] Unknown or mismatched Fadada callback `transaction_id` values are isolated and do not mutate tasks.
- [ ] Stage 1 slot completion evidence shows callbacks update only rows covered by the matching provider `transaction_id`.
- [ ] Fadada Stage 1 customer slot-aware requests use generated artifact coordinates for two `extsign.api` `signature_positions`.
- [ ] Fadada Stage 1 platform slot-aware requests use generated artifact coordinates for two `extsign_auto.api` `signature_positions` with explicit `signature_id`.

Representative local Fadada docs to check before modifying or enabling related behavior:

- Contract upload
- Customer/manual signing
- Platform auto signing
- All-auto batch signing, if used
- Signing result async notification / `notify_url`
- Signed file download
- Contract archive behavior

## Application Prerequisites

- [ ] `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED` remains false before go/no-go.
- [ ] `ESIGN_STAGE1_MULTI_SLOT_ENABLED` remains false in production until complete customer/platform provider multi-position mapping has passed sandbox proof and go/no-go.
- [ ] API typecheck passes.
- [ ] API lint passes.
- [ ] Focused e-sign/Fadada/archive/order tests pass.
- [ ] No schema or migration changes are included.
- [ ] No customer/public exposure is added.
- [ ] `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED` has generated the contract source PDF in sandbox.
- [ ] E-sign artifact source preflight passes before provider upload.
- [ ] `FADADA_ENABLED=true` does not allow `TEST_FIXTURE` upload.
- [ ] Enterprise auto seal requires generated `Contract.fileId`, not `ContractVersion.fileId`.
- [ ] Formal legal contract text is approved by legal and business reviewers.
- [ ] Order appendix field structure is approved by legal and business reviewers.
- [ ] CJK font deployment checklist is completed using `docs/cjk-font-deployment-checklist.md`.
- [ ] `CONTRACT_PDF_CJK_FONT_PATH` is configured outside the repository and verified inside the runtime container.
- [ ] Font family/package/file and license approval are recorded by operator/legal reviewers.
- [ ] API image build evidence shows Source Han Sans SC `2.005R` asset SHA256 verification and extraction to `/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf`.
- [ ] Legal template Stage 1 slot strategy is resolved before generated PDF artifact creation.
- [ ] Stage 1 generated source PDF contains contract main body plus Attachment 1 subscription plan / transaction terms snapshot.
- [ ] Stage 1 generated source PDF excludes independent Attachment 2 vehicle handover sections/forms/signing areas; ordinary main-body legal references to the future handover document are allowed.
- [ ] Generated source PDF passes MIME, `%PDF-` header, size, and generated object-key preflight.
- [ ] Generated source PDF is text-based, searchable, and not image-only.
- [ ] Generated source PDF artifact diagnostics contain each required Stage 1 signing slot definition and coordinate exactly once.
- [ ] Generated source PDF does not show a visible `Render Diagnostics` section.
- [ ] Generated source PDF first-page title is `汽车订阅服务合同`.
- [ ] Generated source PDF metadata and section headings are localized in Chinese.
- [ ] Generated source PDF main-body signing labels do not duplicate standalone slot keyword lines.
- [ ] Party A information is present from the approved ContractVersion template and was not dynamically invented.
- [ ] Party B information is populated only from approved customer sources; missing WeChat/email fields remain blank.
- [ ] Attachment 1 starts on a new page after main body signing slots.
- [ ] Attachment 1 rows use approved monthly quota labels and `超里程费（人民币元/公里）`.
- [ ] Customer signature and platform/company seal slots are visually separated on both Stage 1 signing pages.
- [ ] Fadada/eSign provider multi-position mapping for Stage 1 slots is separately approved and checked against local provider docs before provider calls.
- [ ] Portal and Admin contract pages display Fadada customer readiness before signing actions.
- [ ] Portal signing blocks when `readyForSigning=false` and offers real-name start/resume plus provider-status refresh.
- [ ] After provider-backed real-name is verified, `APPLY_CERT` readiness refresh binds/queries the Fadada cert and Portal/Admin show bind-cert guidance instead of repeat-real-name guidance.
- [ ] Full Fadada real-name verification URLs are returned only from the authenticated Portal customer start/resume action and are absent from status responses, Admin readiness views, audits, logs, and docs.
- [ ] Fadada signing guards block both task creation and Portal signing-link return/refresh when provider-backed real-name or certificate binding evidence is missing.
- [ ] Admin e-sign task display groups Stage 1 internal slot rows into one customer signer group and one platform seal group, while preserving slot count/detail visibility.
- [ ] Admin e-sign archive status distinguishes completed-but-not-archived from signing failure and shows the signed PDF action only after the signed artifact exists.
- [ ] Stage 2 delivery handover signing is treated as a separate provider contract/task; it does not overwrite the Stage 1 `SubscriptionOrder.contractId` pointer or run Stage 1 order-payment side effects.
- [ ] Delivery confirmation remains blocked until the Stage 2 handover is signed and the field work order evidence/customer-confirmation gates are satisfied; missing signed PDF archive is surfaced as a warning/retry state rather than a hard delivery-confirmation blocker.

## Required Stage 1 Signing Slots

- Contract body customer signature: `合同正文-订阅方签字`
- Contract body platform/company seal: `合同正文-服务提供方盖章`
- Attachment 1 customer signature: `附件1订阅方案-订阅方签字`
- Attachment 1 platform/company seal: `附件1订阅方案-服务提供方盖章`

The platform seal slots must reserve right-side blank space. Provider-side placement intent is:

```text
keyx=60
keyy=0
```

## Sandbox Acceptance

- [ ] Task creation creates customer and platform signer rows.
- [ ] Customer signing URL belongs to the customer signer.
- [ ] Customer signing URL maps both customer slots through one `extsign.api` transaction.
- [ ] Customer completion does not mark contract signed.
- [ ] Customer completion does not move order to pending payment.
- [ ] Customer completion triggers exactly one platform auto-seal request only when `ESIGN_STAGE1_MULTI_SLOT_ENABLED=true` and `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=true`.
- [ ] Platform auto seal maps both platform slots through one `extsign_auto.api` transaction.
- [ ] Platform auto seal uses `position_type=1`, explicit `signature_id`, and two generated-coordinate `signature_positions`.
- [ ] Generated signing PDF artifact diagnostics contain the four approved Stage 1 slot definitions and coordinates exactly once.
- [ ] Generated signing PDF does not contain an independent Attachment 2 delivery handover section/form/signing area as part of Stage 1.
- [ ] Generated signing PDF source object key matches `contracts/{contractId}/generated/...`.
- [ ] Platform auto seal succeeds.
- [ ] Platform auto seal success evidence shows provider code `1000`.
- [ ] Unknown transaction callback does not advance signer, task, contract, or order state.
- [ ] Known transaction callback with mismatched `contract_id` does not advance signer, task, contract, or order state.
- [ ] Local Stage 1 slot callbacks update only rows sharing the matching provider transaction id.
- [ ] Stage 1 task completion waits for all required slot rows to be signed.
- [ ] Final PDF shows customer signature and company seal.
- [ ] Archive works only after both signers complete.
- [ ] Admin displays completed Stage 1 multi-slot tasks as business-level customer/platform signer groups, not duplicate raw slot rows.
- [ ] Admin displays completed tasks without a signed artifact as pending signed-file archive with a retry/archive action.
- [ ] Duplicate callback is idempotent.
- [ ] Provider failure leaves retryable state.
- [ ] Missing or invalid positioning leaves contract/order non-final.
- [ ] Sandbox validation record is completed using `docs/esign-sandbox-validation-record.md`.
- [ ] Generated source PDF path and final signed PDF archive path are distinct.
- [ ] Final signed PDF is downloadable only by authorized admin users.
- [ ] Customer signature is visible in the final signed PDF.
- [ ] Platform/company seal is visible in the final signed PDF.

## No-Go Conditions

Any of the following means production enablement must stop:

- Formal legal text is not approved.
- Appendix field structure is not approved.
- CJK font path is missing, unreadable, or not verified in the runtime container.
- CJK font family/package/file or license approval is missing.
- API image font install, checksum verification, or target path validation evidence is missing.
- Legal template Stage 1 slot strategy is unresolved.
- Stage 1 generated source PDF includes an independent Attachment 2 delivery handover section, form, or signing area. Ordinary main-body references to the future handover document title are not by themselves a no-go condition.
- The final render model or artifact diagnostics are missing or duplicate any approved Stage 1 slot definition or coordinate.
- Generated PDF visible title, metadata, or section headings use rejected English labels.
- Generated PDF main-body signing area visibly duplicates standalone `合同正文-订阅方签字` or `合同正文-服务提供方盖章` keyword lines.
- Generated PDF contains garbled Chinese.
- Generated PDF renders visible `Render Diagnostics` text.
- Generated PDF is image-only or not searchable.
- Generated PDF invents or dynamically overwrites Party A / service provider fields instead of preserving the approved template.
- Generated PDF uses WeChat OpenID/UnionID as a visible subscriber WeChat number.
- Generated PDF uses ambiguous money units such as `元` alone, stale minor-unit labels such as `分` for amount rows, or stale non-monthly quota labels such as `里程额度（公里）`, `能源额度（kWh）`, or standalone `能源次数`.
- Attachment 1 is tightly attached below main body signing slots instead of starting on a new page.
- Customer signature and platform/company seal overlap in the final signed PDF.
- Provider multi-position mapping for Stage 1 slots has not been checked against local Fadada docs.
- `ESIGN_STAGE1_MULTI_SLOT_ENABLED` is enabled in production before Fadada customer/platform `signature_positions` mapping is sandbox-proven and go/no-go approved.
- Platform `extsign_auto.api` coordinate mapping is not sandbox-proven.
- Local Stage 1 slot completion can complete a task before all required slot rows are signed.
- Provider transaction IDs contain punctuation, Chinese characters, or exceed 32 characters.
- Customer `extsign.api` manual signing URL fails provider `msg_digest` validation.
- Customer `extsign.api` digest evidence is computed from a different `signature_positions` value than the request parameter sent to Fadada.
- Auto-sign success evidence is missing provider code `1000`.
- `query_sign_result.api` evidence was collected without `customer_id`.
- Unknown or mismatched Fadada callbacks can mutate an e-sign task.
- Generated artifact preflight fails.
- `contract.fileId` is missing for enterprise auto seal.
- Generated object key is a sandbox, test fixture, wrong-contract, or signed archive path.
- Fadada upload/sign/auto-sign/callback/download/archive behavior has not been checked against local docs.
- Customer signature is missing from the final signed PDF.
- Platform/company seal is missing from the final signed PDF.
- Final signed PDF archive is missing.
- An old failed task is reused instead of creating a new controlled task.
- Production rollback flags and operator process are not prepared.

## Production Go/No-Go

Decision: `PENDING`

Current Stage 1 recommendation: `GO CANDIDATE` based on the V1.4 `PASS_WITH_NOTES` sandbox closeout. The production decision remains `PENDING` until operator/legal explicitly approve production enablement. Stage 2 delivery handover remains separate and is not included in this Stage 1 recommendation.

Allowed decisions:

- `GO`
- `GO_WITH_LIMITATIONS`
- `NO_GO`
- `ROLLBACK_REQUIRED`

Production enablement must be operator-controlled. Codex must not deploy, change feature flags, query production DB, create real signing tasks, call provider APIs, or archive real PDFs.

## Disable Path

If auto seal causes issues:

1. Set `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=false`.
2. If generated PDF artifact creation has issues, set `CONTRACT_PDF_ARTIFACT_GENERATION_ENABLED=false`.
3. Restart/recreate API through the approved operator process.
4. Verify customer signing behavior.
5. Keep any DB recovery separate and DB-owner approved.

Do not manually mark failed e-sign tasks successful. Do not backfill old contracts automatically. After a fix, generate a new controlled order, contract, and signing task.

The failed controlled task `ESG20260711184435WMCD` must not be reused after the manual signing digest fix. Use a new controlled sandbox order/contract/task for retry evidence.

## Evidence Rules

Do not paste:

- secrets
- raw DB URLs
- provider credentials
- seal images or binaries
- full customer identity documents
- raw provider URLs containing tokens
- private object download URLs
