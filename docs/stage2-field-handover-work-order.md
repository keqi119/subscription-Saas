# Stage 2 Field Handover Work Order

## Scope

Field handover work orders coordinate the pre-customer-review evidence collection step for Stage 2 vehicle delivery handover. The current H5 phase lets an assigned external field operator open `/field/handover/tasks/[id]`, edit field facts, upload checklist evidence, declare damage or no visible damage, and submit the evidence for customer review.

This phase does not generate Stage 2 PDFs, start eSign, confirm delivery, start lease, start billing, or perform customer Portal review.

Work orders are created from Admin order detail after delivery preparation is ready. Field H5 can only operate on an assigned existing work order; it must not create orders, mutate delivery readiness, allocate payments, or start downstream delivery/lease/billing side effects.

## Field Session Boundary

All H5 action endpoints are guarded by the independent field operator session. Each action verifies:

- the field session is valid;
- the work order is assigned to the session phone;
- `operatorType=EXTERNAL`;
- external access is active and not revoked;
- the work order is still editable.

Admin and Portal auth are not reused for field H5 actions.

## Editable Actions

Supported field-session actions:

- start field work;
- update field facts;
- upload a private evidence file and receive a safe `fileId`;
- attach a `fileId` to a checklist item;
- declare no visible damage;
- refresh work-order detail/readiness;
- submit field evidence for customer review.

Locked states are read-only in H5: `CUSTOMER_REVIEWING`, `CUSTOMER_OBJECTED`, `CUSTOMER_CONFIRMED`, `CUSTOMER_SIGNED`, `PLATFORM_SEALED`, `FIELD_COMPLETED`, `OPS_REVIEW_PENDING`, `OPS_REVIEWED`, `VOIDED`, `FAILED`, and `CANCELLED`.

`CUSTOMER_OBJECTED` becomes editable again only when Admin explicitly requests field resubmission. In that state, the field operator can update facts/files and submit again through the same H5 task. Resubmission keeps the active customer objection and records admin review state `RESUBMITTED_PENDING_ADMIN`; it does not send the task back to the customer automatically.

## Evidence Checklist

The H5 page renders the 14 internal checklist records as operator-facing evidence items. File-based items show required/conditional state, upload status, uploaded file count, review state, and rejection reason when present.

No-visible-damage is a declaration item and does not require file upload. If damage is declared, the damage close-up item becomes required before submit.

The UI and API responses must not expose object storage keys, signing URLs, full phone numbers, full identity numbers, provider payloads, cookies, tokens, or Admin-only data.

## Validation

Submit is blocked until:

- handover mileage is positive;
- energy or fuel level is filled;
- accessory checklist is filled;
- damage state is resolved;
- all required evidence files are uploaded;
- damage close-up evidence exists when damage is declared.

On first success, the work order moves to customer review. On Admin-requested resubmission after a customer objection, the work order stays blocked for Admin review until Admin sends it back to customer review. Customer Portal review is a separate downstream phase: confirming no objection only unlocks Stage 2 PDF/eSign readiness; submitting an objection blocks Stage 2 readiness and requires Admin follow-up. Stage 2 PDF generation, eSign, delivery confirmation, lease, and billing remain unavailable from the field H5 flow.

The upstream Admin readiness path must distinguish:

- active insurance policy coverage or synced vehicle insurance dates;
- zero required deposit, which is auto-satisfied;
- registered receipts that still need bill write-off;
- the visible Admin action to create a Stage 2 handover work order when no active work order exists.
