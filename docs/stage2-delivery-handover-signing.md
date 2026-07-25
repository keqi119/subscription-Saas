# Stage 2 Delivery Handover Signing

## Scope

Stage 2 is the vehicle delivery handover signing domain. It is separate from the Stage 1 subscription contract signing domain.

Stage 2 represents:

- a Vehicle Delivery Handover Confirmation source document;
- an Admin-generated Stage 2 source PDF artifact for visual acceptance;
- a second provider contract/task;
- one customer handover confirmation signature;
- one platform/operator seal or signature;
- signed handover PDF archival;
- a structured delivery evidence checklist;
- the delivery confirmation gate before lease/billing start.

This foundation generates the Stage 2 handover source PDF only. It does not execute provider calls, upload documents to Fadada, create signing URLs, start real eSign, send SMS/WeChat notifications, or activate live lease/billing data.

## Invariants

- One order may have multiple `Contract` rows.
- `SubscriptionOrder.contractId` remains the Stage 1 main contract pointer.
- Stage 2 handover signing must not overwrite `SubscriptionOrder.contractId`.
- Stage 2 must not regenerate or mutate Stage 1 signed evidence.
- Stage 2 eSign completion is stage-aware and must not run Stage 1 `PENDING_PAYMENT` side effects.
- Required delivery evidence must be uploaded before customer review, Stage 2 PDF generation, Stage 2 eSign start, and Admin delivery confirmation.
- Back-office evidence approval is an ops/QA review state. It is not a hard pre-eSign gate in the current policy.
- Customer no-objection confirmation is a hard gate before Stage 2 PDF generation and eSign start. Customer objection moves the work order to `CUSTOMER_OBJECTED` and requires Admin intervention.
- Stage 2 PDF generation creates a separate `Contract` linked from `VehicleDeliveryHandover.handoverContractId`; it must not update `SubscriptionOrder.contractId`, order status, Stage 1 contract rows, finance, lease, or billing state.
- Stage 2 source PDF generation is not Stage 2 eSign start. It must not create `ContractESignTask`, Fadada upload requests, signing URLs, provider payloads, or customer notification side effects.
- External field tokens are task-scoped only. They are never Admin authentication, and misuse against Admin routes should be rejected with 401/403 instead of a server error.
- Ops review is a post-signing / QA / settlement review signal. It should not be started before customer signing, platform sealing, or field completion.
- Delivery confirmation requires the Stage 2 handover to be signed.
- Signed PDF archival is strongly required for evidence completeness, but a temporary archive failure is a visible warning/retry state rather than an absolute delivery confirmation blocker.
- Lease activation reports missing Stage 2 handover readiness before it can become eligible.
- Billing remains protected by the existing `OrderStatus.ACTIVE` and `actualDeliveryAt` checks.
- `actualDeliveryAt` is the server timestamp from successful Admin delivery confirmation and is the lease start source. Stage 2 customer/platform signing timestamps remain audit evidence only.

## Data Model

`VehicleDeliveryHandover` links:

- `orderId`
- optional `vehicleDeliveryId`
- `stage1ContractId`
- optional `handoverContractId`
- optional `handoverESignTaskId`
- source/signed artifact references
- signing/archive timestamps
- `status`
- `archiveStatus`

Prisma cannot express a portable partial unique constraint for "only one active handover per order". The service enforces this by blocking a new active handover while an existing non-cancelled and non-failed record exists.

`VehicleDeliveryEvidenceItem` links:

- `orderId`
- optional `vehicleDeliveryId`
- optional `handoverId`
- evidence type and requirement level
- checklist/review status
- requirement metadata such as conditional/no-damage state
- reviewer and review timestamps
- zero or more `VehicleDeliveryEvidenceFile` rows

`VehicleDeliveryEvidenceFile` links an evidence item to an existing `FileObject`. This Phase 1 backend foundation stores photo/video references and review state; it does not embed photos or videos in the Stage 2 PDF.

Singleton evidence item duplication is guarded in service code. Damage close-up evidence is intentionally allowed to have multiple item rows/files.

`VehicleHandoverWorkOrder` links:

- `orderId`
- optional `vehicleDeliveryId`
- optional `handoverId`
- `handoverType`: `DELIVERY_OUTBOUND` now, `RETURN_INBOUND` reserved for future return inbound flow
- `status`
- `operatorType`: internal staff or external temporary operator
- internal assignment or external operator identity
- hashed, expiring, revocable external access token metadata
- field timestamps, customer review/confirmation/objection timestamps
- field facts: delivery location, mileage, energy/fuel level, accessory checklist, damage/no-damage state, field notes
- ops review status and reviewer fields

External operator access stores only `accessTokenHash`. The plaintext token is returned only once during Admin assignment. The external task view is scoped to the assigned work order and must not expose full ID numbers, finance/payment data, full contract data, provider credentials, signing URLs, or other orders. If an external task token is accidentally sent as an Admin cookie or bearer token, Admin guards must treat it as unauthenticated/forbidden and must not expose token parser internals.

Field operator H5 access uses the fixed route `/field/handover` with phone OTP login and an independent `field_access_token` session. SMS content must be code-only or a generic reminder; task-specific links, bearer tokens, customer data, and order details must not be sent by SMS. After login, task discovery is based on the normalized assigned operator phone and returns only safe DTO fields. The H5 detail route now supports field facts editing, delivery evidence upload, damage/no-damage declaration, readiness refresh, and field evidence submit. The legacy `/field/handover/:token` path may remain for emergency or QA use, but it is no longer the primary external distribution path.

The current H5 UI phase exposes `/field/handover`, `/field/handover/tasks`, and `/field/handover/tasks/[id]`. This phase includes field evidence capture only: customer Portal review, Stage 2 PDF, eSign, delivery confirmation, lease, and billing actions remain unavailable from the H5 UI.

## Evidence Checklist

Required field evidence before customer review and Stage 2 PDF/eSign:

- 客户与车辆正面合影
- 车辆车头正面
- 车辆车尾正面
- 车架号 / VIN
- 仪表台公里数
- 后排内饰
- 前排内饰
- 车辆环绕视频
- 左前轮毂近拍
- 右前轮毂近拍
- 左后轮毂近拍
- 右后轮毂近拍

Conditional damage evidence:

- If damage is declared, at least one non-rejected `DAMAGE_STATIC_CLOSEUP` file is required before customer review/PDF/eSign.
- If no damage is declared, a no-visible-damage declaration is required before customer review/PDF/eSign.
- An unresolved damage state does not pass readiness.
- Rejected evidence blocks the field completeness gate until replaced or reprocessed.
- Pending ops review does not block Stage 2 PDF/eSign in the current policy.

The Stage 2 PDF should list checklist status and file references only. It must not embed the source photos or videos.

Field H5 upload stores files through private storage and `FileObject`, then attaches the returned safe `fileId` to a checklist item. H5 responses and view models must not render raw object storage keys.

## Stage 2 Source PDF

Admin order detail exposes the Stage 2 handover PDF status on each handover work order. The protected Admin API surface is:

- `GET /handover-work-orders/:id/pdf`
- `POST /handover-work-orders/:id/pdf`
- `GET /handover-work-orders/:id/pdf/download`

`POST /handover-work-orders/:id/pdf` requires `delivery:confirm`. `GET` and download require `delivery:view`.

Generation is allowed only after the existing Stage 2 readiness gate passes: field facts complete, required evidence complete, customer confirmed no objection, no active customer objection, no `RESUBMITTED_PENDING_ADMIN` state, and no terminal work-order state. The linked Stage 1 contract must already be signed. A work order with an existing `sourceDocumentFileId` or `handoverContractId` is not regenerated.

The generator selects an active `ContractVersion` with `templateType=DELIVERY_HANDOVER` and `businessType=SUBSCRIPTION`, creates a new `Contract` with an `HDV...` contract number and `status=GENERATED`, stores the generated PDF through private storage, creates a `FileObject`, and updates `VehicleDeliveryHandover` with `handoverContractId`, `sourceDocumentFileId`, `sourceObjectKey`, and `status=SOURCE_GENERATED`.

The PDF includes:

- document/order/template metadata and the Stage 1 contract number;
- full customer legal name, mobile, and identity number for the signing document;
- vehicle brand/model, plate, full VIN, mileage, fuel/energy level, and accessory checklist;
- condition confirmation and damage/no-damage field notes;
- fee/deposit confirmation rows;
- special notices preserved from the handover confirmation template semantics;
- a 14-row evidence summary with safe file identifiers and display names only;
- customer signature and platform seal/signature areas for later provider mapping;
- operation tips.

The protected signing PDF contains the full customer mobile and identity number plus the full VIN, because it is part of the subscription contract and must identify the signing party and vehicle unambiguously. Portal, field, queue, and other API views remain masked. Neither the PDF nor API views may expose raw object storage keys, buckets, private storage paths, signing URLs, provider payloads, SMS/WeChat data, or finance internals.

Visual acceptance for this stage must confirm PDF content, table layout, signature areas, and evidence summary before Stage 2 Fadada upload/signing coordinate mapping begins.

## Portal Customer Review

After the field operator submits evidence, Portal customer review becomes available through customer-scoped APIs:

- `GET /portal/handover-reviews`
- `GET /portal/handover-reviews/:id`
- `GET /portal/handover-reviews/:id/evidence-files/:evidenceFileId/preview`
- `GET /portal/handover-reviews/:id/evidence-files/:evidenceFileId/download`
- `POST /portal/handover-reviews/:id/confirm`
- `POST /portal/handover-reviews/:id/object`

The Portal APIs require customer auth and filter by `order.customerId`. They expose safe review DTOs only: order number, work-order status, handover type/status, scheduled/location fields, field submitted time, masked customer phone, masked plate, VIN suffix, field facts, evidence checklist labels/status/file counts, safe `fileId` metadata, and Portal proxy preview/download URLs. They must not expose object storage keys, bucket paths, provider payloads, signing URLs, finance/payment/deposit fields, tokens, cookies, full phone numbers, or full identity numbers.

Customer confirmation is allowed only from `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`. It records `customerConfirmedAt`, clears objection fields, and makes Stage 2 PDF/eSign readiness true if evidence and field facts remain complete. It does not generate a PDF, create a contract, start eSign, call Fadada, confirm delivery, start lease, or start billing.

Customer objection is allowed only from `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`. It records `customerObjectedAt`, keeps the reason on `customerObjectionReason`, stores optional details in work-order metadata, moves the work order to `CUSTOMER_OBJECTED`, and blocks Stage 2 PDF/eSign readiness until Admin intervention.

The customer Portal UI is available at `/portal/handover-reviews` and `/portal/handover-reviews/[id]`. It presents safe field facts, evidence checklist labels/status/file counts, safe evidence preview/download actions, and the confirm/object decision controls. It intentionally does not show file object keys, buckets, storage paths, provider fields, signing URLs, finance/payment/deposit fields, raw DTO JSON, or full identity data.

Confirming no objection from Portal is a readiness transition only. It must not generate the Stage 2 PDF, create an eSign task, call a provider, confirm delivery, activate lease, or start billing. Submitting an objection keeps the flow in an Admin-follow-up state and must not create provider or delivery side effects.

## Admin Review Loop

Admin order detail exposes Stage 2 handover work orders, evidence file preview/download actions, customer objection details, and review attempt history. The Admin display uses the same safe file proxy policy: storage object keys and buckets remain server-side only.

Admin order detail is also the business entry point for creating the Stage 2 field handover work order. After Stage 1 is signed and the vehicle delivery module has been prepared, Admin can create a `DELIVERY_OUTBOUND` work order from the Stage 2 handover module. The UI must not show a duplicate create action while an active work order exists; the API still keeps the duplicate active-work-order guard.

If a customer objects, Admin can acknowledge the objection and request field resubmission. Field H5 becomes editable only after that request. Resubmission keeps the work order in `CUSTOMER_OBJECTED`, records admin review state `RESUBMITTED_PENDING_ADMIN`, and continues to block Stage 2 PDF/eSign readiness.

After reviewing the resubmitted field material, Admin must send the task back to customer review before the Portal customer can confirm no objection again. Sending back creates the next review attempt, clears the active objection, and returns the work order to `CUSTOMER_REVIEWING`.

## Delivery Readiness Prerequisites

Delivery readiness uses these checks before field handover and final Admin delivery confirmation:

- Stage 1 subscription contract is signed.
- The vehicle is bound to the order and remains `RESERVED`.
- The vehicle has an initialized effective sale price.
- Insurance readiness requires both a non-deleted active compulsory traffic policy and a non-deleted active commercial policy covering the delivery check date. `VehicleInsurancePolicy` is the sole source of truth; there is no vehicle-master date fallback.
- Required deposit of `0` is automatically satisfied and should be displayed as "0 元押金，自动满足". Non-zero deposits still require order deposit confirmation and prepare-delivery confirmation.
- First monthly fee and other payment readiness still come from receivable bill write-off status. Registering a receipt alone is not the same as bill write-off; Admin UI should distinguish "已登记收款，待核销" from written-off/settled bills.
- Insurance policy-period coverage is calculated automatically. Insurance manual verification, vehicle preparation, customer identity, vehicle photos, and handover documents are confirmed separately in the Admin order detail "准备交付" modal after base readiness blockers are cleared.
- Field handover work order creation is an Admin Stage 2 action after delivery preparation. It must not generate Stage 2 PDF, create contracts, start eSign, call Fadada, confirm delivery, start lease, or start billing.
- `保单管理` is expected under `车辆资产 -> 保单管理`, path `/vehicle-insurance-policies`, permission `vehicle_insurance:view`; staging environments must run the RBAC/menu seed or sync so Admin roles can see the menu.

Field evidence accepts photos up to 10MB and videos up to 300MB. The API Nginx virtual host must set `client_max_body_size 320m` or higher, `proxy_read_timeout`/`proxy_send_timeout` to `1200s`, and `proxy_request_buffering off`. Multipart evidence is spooled to an OS temporary file and then copied or streamed to the configured storage provider, so a 300MB upload is not retained as one Node.js heap buffer; the temporary file is removed after success or failure.

## Status Policy

Handover status:

- `DRAFT`
- `SOURCE_GENERATED`
- `PENDING_CUSTOMER_SIGNATURE`
- `PENDING_PLATFORM_SEAL`
- `SIGNED`
- `ARCHIVED`
- `FAILED`
- `CANCELLED`

Archive status:

- `NOT_STARTED`
- `PENDING`
- `ARCHIVED`
- `FAILED`

Handover work order status:

- `DRAFT`
- `ASSIGNED`
- `FIELD_IN_PROGRESS`
- `EVIDENCE_SUBMITTED`
- `CUSTOMER_REVIEWING`
- `CUSTOMER_OBJECTED`
- `CUSTOMER_CONFIRMED`
- `SIGNING`
- `CUSTOMER_SIGNED`
- `PLATFORM_SEALED`
- `FIELD_COMPLETED`
- `OPS_REVIEW_PENDING`
- `OPS_REVIEWED`
- `VOIDED`
- `FAILED`
- `CANCELLED`

Current Stage 2 PDF/eSign gate:

```text
FIELD_COMPLETENESS + CUSTOMER_NO_OBJECTION + NOT_OBJECTED_OR_CANCELLED
```

Field completeness requires required files uploaded, field facts completed, damage/no-damage state resolved, and the field operator submitted the work order. Customer no-objection confirmation is required before Stage 2 PDF/eSign. Ops review may be pending or rejected without blocking PDF/eSign; it remains a back-office QA/settlement signal.

Portal review detail may show "not ready" before customer confirmation or after customer objection. That readiness state is a gate only; it should not be interpreted as PDF/eSign provider failure because this phase does not call providers or create signing tasks.

Ops review pending may be requested only from `CUSTOMER_SIGNED`, `PLATFORM_SEALED`, `FIELD_COMPLETED`, `OPS_REVIEW_PENDING`, or `OPS_REVIEWED`. It must be blocked from draft, assigned, field-in-progress, customer-reviewing, customer-confirmed, customer-objected, and terminal work-order states.

Current delivery confirmation gate:

```text
STAGE2_HANDOVER_SIGNED + FIELD_COMPLETENESS + CUSTOMER_NO_OBJECTION + NOT_OBJECTED_OR_CANCELLED
```

Delivery cannot be confirmed until the Stage 2 handover is signed and the work order/evidence/customer confirmation gates are satisfied. If the signed PDF archive is missing or failed after signing, the task must expose the archive risk and retry path, but the temporary archive issue is not an absolute delivery confirmation blocker.

Lease start policy:

```text
leaseStartAt = SubscriptionOrder.actualDeliveryAt
```

`actualDeliveryAt` is written with the server timestamp when Admin successfully confirms delivery. It is not derived from Stage 1 signing, Stage 2 customer signing, platform sealing, archive completion, or browser/client time.

Void/rebuild foundation:

- Failed, cancelled, or voided handovers remain as historical evidence.
- A new active handover may supersede a cancelled/failed one.
- Only the latest active handover can satisfy the delivery/evidence gate.
- If the customer has signed but the platform has not sealed, void/rebuild is allowed.
- Old artifacts/tasks should not be deleted.

## Open Items

- Final legal handover wording/template approval after visual acceptance.
- Stage 2 Fadada provider upload/signing/auto-seal mapping after the PDF is visually accepted.
- Admin void/escalation policy beyond the basic objection resubmission loop.
- Admin/Portal UX for signing, archive retry, and signed PDF review.
- Portal signed handover PDF viewing/downloading after archive is available.
