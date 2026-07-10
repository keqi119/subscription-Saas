# Contract Template Legal Approval

## Purpose

Formal contract text must come from legal and business reviewers. Codex must not write legal terms, appendix wording, production template text, credentials, or seal IDs.

This document defines the minimum approval record required before a contract template can be used for generated signing PDFs and enterprise auto seal validation.

## Required Inputs

Before activation, record:

- Template name
- Version number
- Effective date
- Legal approver
- Business approver
- Approved legal body
- Approved appendix field structure
- Approved Stage 1 signing slot keywords
- Approved rollback version
- Approval evidence location

## Template Rules

- Do not edit active or already-used template versions.
- Create a new version for contract text, appendix, signing slot, or layout changes.
- `ContractVersion.contentTemplate` is treated as text by the current PDF renderer.
- Complex legal layout, tables, clause numbering, or rich HTML/PDF templates require a separate architecture decision.
- Synthetic test text may appear only in automated tests and must not be activated as a production contract template.
- Generated contracts must keep their original `contractSnapshot.contentTemplate` and must not be rewritten after signing starts.

## Stage 1 Signing Slots

Stage 1 signing source PDFs contain:

- Contract main body
- Attachment 1: subscription plan / transaction terms snapshot

Stage 1 source PDFs must not include Attachment 2 vehicle handover / delivery confirmation. Stage 2 delivery handover signing remains a separate future task and must not be used as the lease commencement trigger until the delivery signing architecture and billing alignment are approved.

The Stage 1 render model must contain each approved slot keyword exactly once:

- Contract body customer signature: `合同正文-订阅方签字`
- Contract body platform/company seal: `合同正文-服务提供方盖章`
- Attachment 1 customer signature: `附件1订阅方案-订阅方签字`
- Attachment 1 platform/company seal: `附件1订阅方案-服务提供方盖章`

Platform seal slots should reserve right-side blank space for the provider-side placement intent:

```text
keyx=60
keyy=0
```

The older generic anchor strings are no longer sufficient as Stage 1 provider placement slots:

- `服务提供方盖章`
- `订阅方盖章/签字`

Legal DOCX source files may already contain generic signing anchors or signature sections. The Stage 1 PDF renderer now appends the four section-specific Stage 1 slot keywords separately. Before formal template activation, reviewers must confirm the final rendered Stage 1 PDF has exactly the four approved Stage 1 slot keywords, one occurrence each, and does not rely on repeated generic anchors.

Provider multi-position mapping for the four Stage 1 slots remains a future Fadada/eSign task. Any future provider mapping change must inspect the local Fadada docs under `D:\Projects\document\fadada\doc`.

The final render model must contain each required Stage 1 slot keyword exactly once before generated PDF artifact creation is enabled for the formal template.

## Appendix Field Policy

The appendix structure must be approved by legal and business reviewers before production use.

### Safe MVP Fields

- Order number
- Contract number
- Template name/version
- Generated time
- Customer name
- Masked phone
- Vehicle number
- Brand/model
- Subscription term
- Monthly fee
- Deposit
- Package summary
- Quote reference

### Needs Legal/Business Approval

- VIN
- Full plate number
- Delivery address
- Billing schedule details
- Quote detail lines

### Avoid

- Identity document numbers
- Internal risk score
- Approval comments
- Provider raw IDs
- System tokens
- Internal operation notes

## Activation Checklist

- [ ] Legal approval recorded.
- [ ] Business approval recorded.
- [ ] Template version and effective date recorded.
- [ ] Appendix field structure approved.
- [ ] Stage 1 slot strategy selected.
- [ ] Stage 1 source PDF excludes Attachment 2.
- [ ] Required Stage 1 slot keywords appear exactly once.
- [ ] Final render model Stage 1 slot uniqueness verified.
- [ ] Provider multi-position mapping remains disabled or separately approved.
- [ ] CJK font path verified in the runtime container.
- [ ] Generated sandbox PDF reviewed visually.
- [ ] Sandbox double-sign passed.
- [ ] Rollback version available.

## Rollback

If a template issue is found:

1. Do not manually mark failed e-sign tasks successful.
2. Do not backfill old contracts automatically.
3. Deactivate the faulty template version through the approved operator process.
4. Activate the approved rollback version or create a corrected new version.
5. Generate a new controlled order, contract, and signing task after fixes are verified.
