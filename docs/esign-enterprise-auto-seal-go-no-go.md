# eSign Enterprise Auto Seal Go/No-Go Checklist

Status: pending operator validation.

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
- [ ] `ESIGN_PLATFORM_SEAL_KEYWORD` is configured outside the repository.
- [ ] Callback endpoint is confirmed.
- [ ] Seal placement or keyword rule is approved.
- [ ] Provider sandbox run completed.

## Application Prerequisites

- [ ] `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED` remains false before go/no-go.
- [ ] API typecheck passes.
- [ ] API lint passes.
- [ ] Focused e-sign/Fadada/archive/order tests pass.
- [ ] No schema or migration changes are included.
- [ ] No customer/public exposure is added.

## Sandbox Acceptance

- [ ] Task creation creates customer and platform signer rows.
- [ ] Customer signing URL belongs to the customer signer.
- [ ] Customer completion does not mark contract signed.
- [ ] Customer completion does not move order to pending payment.
- [ ] Generated signing PDF contains the approved platform seal keyword.
- [ ] Platform auto seal succeeds.
- [ ] Final PDF shows customer signature and company seal.
- [ ] Archive works only after both signers complete.
- [ ] Duplicate callback is idempotent.
- [ ] Provider failure leaves retryable state.
- [ ] Missing or invalid positioning leaves contract/order non-final.

## Production Go/No-Go

Decision: `PENDING`

Allowed decisions:

- `GO`
- `GO_WITH_LIMITATIONS`
- `NO_GO`
- `ROLLBACK_REQUIRED`

Production enablement must be operator-controlled. Codex must not deploy, change feature flags, query production DB, create real signing tasks, call provider APIs, or archive real PDFs.

## Disable Path

If auto seal causes issues:

1. Set `ESIGN_ENTERPRISE_AUTO_SEAL_ENABLED=false`.
2. Restart/recreate API through the approved operator process.
3. Verify customer signing behavior.
4. Keep any DB recovery separate and DB-owner approved.

## Evidence Rules

Do not paste:

- secrets
- raw DB URLs
- provider credentials
- seal images or binaries
- full customer identity documents
- raw provider URLs containing tokens
