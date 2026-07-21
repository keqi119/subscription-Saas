# Stage 2 Delivery Handover Signing

## Scope

Stage 2 is the vehicle delivery handover signing domain. It is separate from the Stage 1 subscription contract signing domain.

Stage 2 represents:

- a Vehicle Delivery Handover Confirmation source document;
- a second provider contract/task;
- one customer handover confirmation signature;
- one platform/operator seal or signature;
- signed handover PDF archival;
- a structured delivery evidence checklist;
- the delivery confirmation gate before lease/billing start.

This foundation does not execute provider calls, upload documents, start real eSign, generate final legal PDF wording, or activate live lease/billing data.

## Invariants

- One order may have multiple `Contract` rows.
- `SubscriptionOrder.contractId` remains the Stage 1 main contract pointer.
- Stage 2 handover signing must not overwrite `SubscriptionOrder.contractId`.
- Stage 2 must not regenerate or mutate Stage 1 signed evidence.
- Stage 2 eSign completion is stage-aware and must not run Stage 1 `PENDING_PAYMENT` side effects.
- Required delivery evidence must be uploaded before customer review, Stage 2 PDF generation, Stage 2 eSign start, and Admin delivery confirmation.
- Back-office evidence approval is an ops/QA review state. It is not a hard pre-eSign gate in the current policy.
- Customer no-objection confirmation is a hard gate before Stage 2 PDF generation and eSign start. Customer objection moves the work order to `CUSTOMER_OBJECTED` and requires Admin intervention.
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

Field operator H5 access uses the fixed route `/field/handover` with phone OTP login and an independent `field_access_token` session. SMS content must be code-only or a generic reminder; task-specific links, bearer tokens, customer data, and order details must not be sent by SMS. After login, task discovery is based on the normalized assigned operator phone and returns only safe DTO fields. The legacy `/field/handover/:token` path may remain for emergency or QA use, but it is no longer the primary external distribution path.

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

- Final legal handover wording/template approval.
- Stage 2 provider upload/signing/auto-seal mapping.
- Admin/Portal UX for handover generation, signing, archive retry, and PDF review.
- Admin/Portal evidence upload/review UI.
- Portal signed handover PDF viewing/downloading after archive is available.
