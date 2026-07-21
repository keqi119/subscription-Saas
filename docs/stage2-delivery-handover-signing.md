# Stage 2 Delivery Handover Signing

## Scope

Stage 2 is the vehicle delivery handover signing domain. It is separate from the Stage 1 subscription contract signing domain.

Stage 2 represents:

- a Vehicle Delivery Handover Confirmation source document;
- a second provider contract/task;
- one customer handover confirmation signature;
- one platform/operator seal or signature;
- signed handover PDF archival;
- the delivery confirmation gate before lease/billing start.

This foundation does not execute provider calls, upload documents, start real eSign, generate final legal PDF wording, or activate live lease/billing data.

## Invariants

- One order may have multiple `Contract` rows.
- `SubscriptionOrder.contractId` remains the Stage 1 main contract pointer.
- Stage 2 handover signing must not overwrite `SubscriptionOrder.contractId`.
- Stage 2 must not regenerate or mutate Stage 1 signed evidence.
- Stage 2 eSign completion is stage-aware and must not run Stage 1 `PENDING_PAYMENT` side effects.
- Delivery confirmation requires the Stage 2 handover to be signed and archived.
- Lease activation reports missing Stage 2 handover readiness before it can become eligible.
- Billing remains protected by the existing `OrderStatus.ACTIVE` and `actualDeliveryAt` checks.

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

Current conservative gate:

```text
SIGNED_AND_ARCHIVED_REQUIRED
```

Delivery cannot be confirmed until the handover is signed and the signed PDF is archived.

## Open Items

- Final legal handover wording/template approval.
- Exact `leaseStartAt` timestamp policy.
- Stage 2 provider upload/signing/auto-seal mapping.
- Admin/Portal UX for handover generation, signing, archive retry, and PDF review.
- Whether any future business rule allows delivery confirmation after `SIGNED` but before archive.
