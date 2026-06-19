# Customer Portal Release Checklist

## Stage Status

- Stage 10H-A: complete.
- Stage 10H-B safety validation foundation: complete.
- Stage 10H-B real WeChat template-message validation: pending.
- Pending reason: WeChat Official Account normal template-message capability is still under platform review.
- Stage 10I does not depend on real template IDs and may proceed.

## Checklist

| Area | Check | Status |
| --- | --- | --- |
| H5 domain | `https://app.subauto.keybox.cloud` resolves and serves Portal H5 over HTTPS | Pending operator verification |
| Portal route smoke | Run `pnpm portal:route-smoke` locally/staging/production | Script ready |
| Portal API smoke | Run `pnpm portal:api-smoke` public checks | Script ready |
| Authenticated Portal API smoke | Run with `PORTAL_CUSTOMER_COOKIE` for a controlled customer | Pending controlled cookie |
| Customer login | Phone-code login works; login requires agreement checkbox | Ready for manual acceptance |
| Terms/privacy | `/portal/terms` and `/portal/privacy` exist | Placeholder text, legal review pending |
| Product browsing | Vehicle catalog list/detail load and do not expose internal cost fields | Pending smoke/manual acceptance |
| Application submission | Customer can submit self-service application | Pending manual acceptance |
| Material upload | Customer can upload required materials; preview is ownership-checked | Pending manual acceptance |
| Application progress | Customer can view progress and material supplement hints | Pending manual acceptance |
| Final plan confirmation | Customer can confirm/reject final plan | Pending manual acceptance |
| Contract signing | Portal contract list/detail/sign flow works with mock ESign | Pending manual acceptance |
| WeChat payment | JSAPI payment has passed prior real validation | Prior stage passed |
| Payment fallback | WeChat-outside H5 fallback is not in Stage 10I scope | Deferred |
| Orders | Customer can view own orders only | Pending manual acceptance |
| Bills | Customer can view own bills and payable status | Pending manual acceptance |
| Deposit | Customer can view own deposit ledger | Pending manual acceptance |
| Entitlements | Customer can view own grants/usages | Pending manual acceptance |
| Accident report | Customer can submit and track accident service case | Pending manual acceptance |
| Rescue request | Customer can submit and track rescue service case | Pending manual acceptance |
| Notifications | Portal notification center lists own in-app notifications | Pending manual acceptance |
| Back-office notifications | Back-office records/events are visible and openid is masked | Pending manual acceptance |
| WeChat service account menu | Menu dry-run targets customer Portal pages | Dry-run ready |
| WeChat menu apply | Requires explicit `WECHAT_MENU_APPLY=1` and human confirmation | Pending |
| Template messages | Real single-openid template smoke | Pending WeChat review |
| Data redaction | No purchase price, cost, financing, residual internals, full VIN/plate, or storage internals in Portal DTOs | Audit documented |
| File download | Material/service-case previews enforce parent ownership | Covered by implementation/tests |
| Admin/customer token isolation | Admin token cannot replace customer session for protected Portal APIs | Audit documented |
| Release notes | Customer-facing limitations include 10H-B template-message pending state | Pending final release notes |

## Go / No-Go

Go only after:

- Route smoke and API smoke pass for target environment.
- Legal has approved or explicitly accepted placeholder terms/privacy for pilot.
- Customer ownership checks pass for the controlled E2E account.
- WeChat template-message pending state is communicated if the review is still open.

No-go if:

- Any protected Portal endpoint can return another customer's data.
- Portal H5 exposes storage internals, payment secrets, WeChat secrets, or back-office-only financial fields.
- Login or payment paths show raw server errors to customers.
