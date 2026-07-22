# Stage 2 Portal Handover Review

## Scope

Portal handover review starts after the field operator has submitted Stage 2 field facts and evidence. This phase provides the customer-scoped API foundation only. It does not build the full Portal review page, generate a Stage 2 PDF, create contracts, start eSign, call Fadada, confirm delivery, start lease, or start billing.

## API

Customer-authenticated routes:

- `GET /portal/handover-reviews`
- `GET /portal/handover-reviews/:id`
- `POST /portal/handover-reviews/:id/confirm`
- `POST /portal/handover-reviews/:id/object`

All routes are scoped by the current Portal customer. A customer can access only handover work orders linked to their own subscription orders.

## Review State

Portal list/detail are visible for reviewable or reviewed work orders:

- `EVIDENCE_SUBMITTED`
- `CUSTOMER_REVIEWING`
- `CUSTOMER_CONFIRMED`
- `CUSTOMER_OBJECTED`
- `SIGNING`
- `CUSTOMER_SIGNED`
- `PLATFORM_SEALED`
- `FIELD_COMPLETED`
- `OPS_REVIEW_PENDING`
- `OPS_REVIEWED`

Terminal states `VOIDED`, `FAILED`, and `CANCELLED` are hidden from Portal detail. Draft, assigned, and field-in-progress records are not customer-reviewable.

Customer confirm is allowed only from `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`. It records confirmation and unlocks readiness only. It does not create provider or delivery side effects.

Customer objection is allowed only from `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`. It moves the work order to `CUSTOMER_OBJECTED`, records the reason/details, blocks Stage 2 PDF/eSign readiness, and requires Admin follow-up.

## Safe DTO Policy

Portal DTOs may include:

- order number;
- handover/work-order status and type;
- delivery location, scheduled time, and field submitted time;
- vehicle brand/model, masked plate, and VIN suffix;
- masked customer mobile;
- field facts such as mileage, energy/fuel level, accessory checklist, damage/no-damage declaration, and field notes;
- evidence labels, statuses, review state, file count, and safe `fileId` metadata.

Portal DTOs must not include:

- OSS object keys, buckets, or private storage paths;
- signing URLs or provider payloads;
- tokens, cookies, OTPs, or Admin JWTs;
- full phone numbers or identity numbers;
- finance, deposit, payment, lease, billing, or internal audit fields.

Evidence preview/download remains a later policy decision. Until a safe Portal preview endpoint is explicitly implemented, review APIs should return metadata only.

## Local Validation

Local tests use synthetic customers, orders, vehicles, handovers, 14 evidence checklist items, and safe file references. They assert:

- customer-owned filtering;
- unrelated customer denial;
- safe DTO serialization with no object storage keys;
- detail field facts and evidence summary;
- confirm no objection readiness transition;
- objection readiness blocker;
- no PDF/eSign/Fadada/delivery/lease/billing side effects.

## Open Items

- Portal Handover Review Page UI.
- Safe evidence preview/download policy.
- Stage 2 PDF renderer and legal wording.
- Stage 2 provider mapping and eSign start.
- Admin objection handling and reopen/void policy.
- Audit timezone cleanup for displayed timestamps.
