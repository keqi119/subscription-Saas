# Customer Portal Release Checklist

## Stage Status

- Stage 10H-A: complete.
- Stage 10H-B safety validation foundation: complete.
- Stage 10H-B real WeChat template-message validation: complete.
- Stage 10H-B evidence: access_token smoke passed, one `PAYMENT_PENDING` single-openid template message was sent, WeChat `msgid` was recorded, and the WeChat client receipt/click-through to the Portal order page was confirmed.
- Stage 10J release-candidate evidence is tracked in `docs/customer-portal-release-candidate-report.md`.
- Stage 10K-A: Aliyun SMS login provider and invited beta gate are implemented in code; real SMS staging validation remains required before production customer traffic.
- Stage 10M-A: customer profile material center and application precheck are implemented in code; manual acceptance should confirm missing-material warning does not block submission.
- Stage 10M-B: vehicle insurance policies, vehicle documents, customer-visible order documents, and basic insurance claim records are implemented in code; manual acceptance should confirm private preview and ownership checks.
- Stage 10M-C-A: BaaS battery contracts and monthly cost ledger are implemented in code; manual acceptance should confirm cost generation is idempotent and does not affect asset profitability formulas yet.

## Checklist

| Area | Check | Status |
| --- | --- | --- |
| H5 domain | `https://app.subauto.keybox.cloud` resolves and serves Portal H5 over HTTPS | Production route smoke reached the domain; three RC routes returned 404 |
| Portal route smoke | Run `pnpm portal:route-smoke` locally/staging/production | Production smoke failed on `/portal/terms`, `/portal/privacy`, and `/portal/notifications` |
| Portal API smoke | Run `pnpm portal:api-smoke` public checks | Production public API smoke passed |
| Authenticated Portal API smoke | Run with `PORTAL_CUSTOMER_COOKIE` for a controlled customer | Pending controlled cookie |
| Customer login | Phone-code login works; login requires agreement checkbox | Stage 10K-A adds SMS provider abstraction and beta gate; staging real-SMS validation pending |
| Login SMS provider | Aliyun provider configured through env; production does not return `debugCode` | Implemented in code; no real SMS sent in local tests |
| Beta phone gate | `PORTAL_BETA_MODE=true` allows only invited phones to request/use login codes | Implemented; whitelist values must stay out of Git |
| Terms/privacy | `/portal/terms` and `/portal/privacy` exist in code | Placeholder text, legal review pending; production currently returns 404 until latest Web image is deployed |
| Product browsing | Vehicle catalog list/detail load and do not expose internal cost fields | Pending smoke/manual acceptance |
| Catalog CTA | Vehicle card primary action is `查看详情`, not direct application submission | Pending manual acceptance |
| Application submission | Customer can submit self-service application | Pending manual acceptance |
| Application precheck | Vehicle detail warns about missing required profile materials before submission and still allows continue-submit | Pending manual acceptance |
| Customer profile materials | `/portal/materials` supports upload/replace/preview/archive for ID card and driver-license files | Pending manual acceptance |
| Material upload | Customer can upload required materials; preview is ownership-checked | Pending manual acceptance |
| Application progress | Customer can view progress and material supplement hints | Pending manual acceptance |
| Final plan confirmation | Customer can confirm/reject final plan | Pending manual acceptance |
| Contract signing | Portal contract list/detail/sign flow works with mock ESign | Pending manual acceptance |
| WeChat payment | JSAPI payment has passed prior real validation | Prior stage passed |
| Payment fallback | WeChat-outside H5 fallback is not in Stage 10I scope | Deferred |
| Orders | Customer can view own orders only | Pending manual acceptance |
| Order vehicle documents | Customer can view customer-visible vehicle license / policy / authorization documents for own active order vehicle only | Pending manual acceptance |
| Bills | Customer can view own bills and payable status | Pending manual acceptance |
| Deposit | Customer can view own deposit ledger | Pending manual acceptance |
| Entitlements | Customer can view own grants/usages | Pending manual acceptance |
| Accident report | Customer can submit and track accident service case | Pending manual acceptance |
| Insurance claim summary | Accident service-case detail can show read-only claim summary for the current customer only | Pending manual acceptance |
| Rescue request | Customer can submit and track rescue service case | Pending manual acceptance |
| Notifications | Portal notification center lists own in-app notifications | Implemented in code; production route currently returns 404 until latest Web image is deployed |
| Back-office notifications | Back-office records/events are visible and openid is masked | Pending manual acceptance |
| Back-office insurance policies | Back office can create separate compulsory traffic and commercial insurance policies, maintain coverage rows, upload documents, and archive policies | Pending manual acceptance |
| Back-office vehicle documents | Vehicle document preview streams private files and does not expose OSS public URLs or storage keys | Pending manual acceptance |
| Back-office insurance claims | Accident service cases can create and update basic claim records without changing vehicle/order status or generating bills | Pending manual acceptance |
| Back-office BaaS contracts | Back office can create/activate/suspend/terminate/archive BaaS contracts for BAAS vehicles only | Pending manual acceptance |
| BaaS cost ledger | Dry-run does not write records; formal generation creates idempotent cost records and payment day 31 uses month end | Pending manual acceptance |
| BaaS reporting boundary | BaaS costs do not change asset profitability, CSV export, billing, payment, or write-off results in Stage 10M-C-A | Pending manual acceptance |
| WeChat service account menu | Menu dry-run targets customer Portal pages | Dry-run ready |
| WeChat menu apply | Requires explicit `WECHAT_MENU_APPLY=1` and human confirmation | Pending |
| Template messages | Real single-openid template smoke | Passed in Stage 10H-B R2 |
| Data redaction | No purchase price, cost, financing, residual internals, full VIN/plate, or storage internals in Portal DTOs | Audit documented |
| File download | Material/service-case previews enforce parent ownership | Covered by implementation/tests |
| Admin/customer token isolation | Admin token cannot replace customer session for protected Portal APIs | Audit documented |
| Release notes | Customer-facing limitations include deferred real e-sign, H5 payment fallback, legal text, and menu apply status | Stage 10J RC docs added |

## Go / No-Go

Go only after:

- Route smoke and API smoke pass for target environment.
- Stage 10K-A-Staging real Aliyun SMS validation passes for one controlled phone, and non-whitelist phone rejection is confirmed.
- Legal has approved or explicitly accepted placeholder terms/privacy for pilot.
- Customer ownership checks pass for the controlled E2E account.
- Latest production Web/API image includes Stage 10I and Stage 10H-A Portal routes.
- WeChat service-account menu apply is explicitly approved or deliberately deferred for invited beta.

No-go if:

- Production route smoke returns 404 for `/portal/terms`, `/portal/privacy`, or `/portal/notifications`.
- Any protected Portal endpoint can return another customer's data.
- Portal H5 exposes storage internals, payment secrets, WeChat secrets, or back-office-only financial fields.
- Login or payment paths show raw server errors to customers.
