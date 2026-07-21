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
- Required delivery evidence must be uploaded and approved before Stage 2 PDF generation, Stage 2 eSign start, and Admin delivery confirmation.
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

## Evidence Checklist

Required evidence before Stage 2 PDF/eSign:

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

- If damage is declared, at least one approved `DAMAGE_STATIC_CLOSEUP` is required.
- If no damage is declared, an audited and approved `NO_VISIBLE_DAMAGE_DECLARATION` is required.
- An unresolved damage state does not pass readiness.

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

Current delivery confirmation gate:

```text
SIGNED_REQUIRED + EVIDENCE_APPROVED_REQUIRED
```

Delivery cannot be confirmed until the handover is signed and required evidence is approved. If the signed PDF archive is missing or failed after signing, the task must expose the archive risk and retry path, but the temporary archive issue is not an absolute delivery confirmation blocker.

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
