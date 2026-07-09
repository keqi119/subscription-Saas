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
- Approved signing anchors
- Approved rollback version
- Approval evidence location

## Template Rules

- Do not edit active or already-used template versions.
- Create a new version for contract text, appendix, anchor, or layout changes.
- `ContractVersion.contentTemplate` is treated as text by the current PDF renderer.
- Complex legal layout, tables, clause numbering, or rich HTML/PDF templates require a separate architecture decision.
- Synthetic test text may appear only in automated tests and must not be activated as a production contract template.
- Generated contracts must keep their original `contractSnapshot.contentTemplate` and must not be rewritten after signing starts.

## Signing Anchors

The signing PDF must contain each required anchor exactly once:

- `服务提供方盖章`
- `订阅方盖章/签字`

The platform seal area must reserve right-side blank space for the provider-side placement intent:

```text
keyx=60
keyy=0
```

The legal body should avoid duplicating these exact anchor strings if the generated signing section already renders them.

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
- [ ] Required signing anchors appear exactly once.
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
