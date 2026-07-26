# Stage 2 Portal Handover Review

## Scope

Portal handover review starts after the field operator has submitted Stage 2 field facts and evidence. Customer no-objection confirmation unlocks the Admin source-PDF/readiness gate but still does not generate a PDF or call a provider. After Admin creates the typed Stage 2 task, the backend exposes a safe Portal eSign status read and one intentional signing-start action. Portal never confirms delivery, writes `actualDeliveryAt`, starts lease/billing, or triggers Stage 1 payment behavior.

## API

Customer-authenticated routes:

- `GET /portal/handover-reviews`
- `GET /portal/handover-reviews/:id`
- `GET /portal/handover-reviews/:id/evidence-files/:evidenceFileId/preview`
- `GET /portal/handover-reviews/:id/evidence-files/:evidenceFileId/download`
- `GET /portal/handover-reviews/:id/esign`
- `POST /portal/handover-reviews/:id/esign/signing/start`
- `POST /portal/handover-reviews/:id/confirm`
- `POST /portal/handover-reviews/:id/object`

All routes are scoped by the current Portal customer. A customer can access only handover work orders linked to their own subscription orders.

## Portal UI

Customer routes:

- `/portal/handover-reviews`
- `/portal/handover-reviews/[id]`

The list page shows customer-owned handover review items with order number, safe vehicle summary, masked VIN/plate information if returned, field submitted time, evidence progress, and the current customer review status.

The current detail page shows safe field facts, checklist labels/status/file counts, evidence file links, and customer decision state. Evidence links use Portal-scoped preview/download proxy routes. This branch does not wire either Stage 2 eSign endpoint into the Web page: the current Web does not display eSign status and does not provide a signing-start action. A later Web integration must keep normal review and eSign status responses free of storage locators, signing URLs, finance/payment/deposit fields, identity numbers, raw DTO JSON, provider internals, and credentials.

If the work order is in `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`, the customer can either confirm no objection after checking the acknowledgement box, or submit an objection with a required reason. Confirm only enables readiness for later Admin Stage 2 source PDF generation and eSign work; it does not create a PDF, create a signing task, or call any provider. Objection blocks readiness and requires Admin follow-up.

Portal review starts only after Admin has created a handover work order and field evidence has been submitted. Portal does not create handover work orders, verify insurance, allocate payments, confirm delivery, start lease, or start billing.

## Portal eSign Boundary

`GET /portal/handover-reviews/:id/esign` is customer-owned and read-only. It returns typed Stage 2 status, the two safe signer states, archive state, signed-artifact availability, capability, and mapped blockers. It never refreshes or returns a signing URL.

Only `POST /portal/handover-reviews/:id/esign/signing/start` may request and return a short-lived signing URL and expiry. The action requires the owning customer, the exact typed Stage 2 customer/platform signer tuples, unchanged source identity, valid readiness, and an unsigned customer slot. A provider URL failure becomes the stable safe error `STAGE2_PORTAL_SIGNING_URL_UNAVAILABLE`.

Customer-facing blockers preserve only intentional concepts: confirmation missing, active objection, evidence not ready, or generic Stage 2 signing unavailable. Provider/configuration/storage internals are not forwarded. The implemented Stage 2 Portal surface has no optional signed-document preview route.

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

After customer confirmation, Admin may generate the Stage 2 handover source PDF from order detail. That source PDF is still provider-neutral: it creates the separate Stage 2 `Contract`/`FileObject` artifact and safe download route only, and must not start Fadada, create signing URLs, send notifications, confirm delivery, start lease, or start billing.

Customer objection is allowed only from `EVIDENCE_SUBMITTED` or `CUSTOMER_REVIEWING`. It moves the work order to `CUSTOMER_OBJECTED`, records the reason/details, blocks Stage 2 PDF/eSign readiness, and requires Admin follow-up.

When Admin requests field resubmission, field H5 may update and resubmit evidence, but the work order remains in `CUSTOMER_OBJECTED` with admin review state `RESUBMITTED_PENDING_ADMIN`. The customer cannot confirm no objection again until Admin explicitly sends the resubmitted evidence back to Portal review. Sending back clears the active objection for a new review attempt and returns the work order to `CUSTOMER_REVIEWING`.

## Safe DTO Policy

Portal DTOs may include:

- order number;
- handover/work-order status and type;
- delivery location, scheduled time, and field submitted time;
- vehicle brand/model, masked plate, and VIN suffix;
- masked customer mobile;
- field facts such as mileage, energy/fuel level, accessory checklist, damage/no-damage declaration, and field notes;
- evidence labels, statuses, review state, file count, safe `fileId` metadata, and Portal proxy `previewUrl`/`downloadUrl` values.

Portal review and eSign status DTOs must not include:

- OSS object keys, buckets, or private storage paths;
- signing URLs or provider payloads; the sole exception is the explicit signing-start response described above;
- tokens, cookies, OTPs, or Admin JWTs;
- full phone numbers or identity numbers;
- finance, deposit, payment, lease, billing, or internal audit fields.

Evidence preview/download routes must verify the current Portal customer owns the work order before streaming file bytes. Image/video files may be previewed inline; other file types are download-only.

## Local Validation

Local tests use synthetic customers, orders, vehicles, handovers, 14 evidence checklist items, and safe file references. They assert:

- customer-owned filtering;
- unrelated customer denial;
- safe DTO serialization with no object storage keys;
- detail field facts, evidence summary, and safe Portal file links;
- confirm no objection readiness transition;
- objection readiness blocker and Admin-mediated resubmission loop;
- no PDF/eSign/Fadada/delivery/lease/billing side effects.
- eSign status reads contain no URL, while only the intentional start action returns a short-lived URL/expiry;
- provider failures and readiness blockers map to Portal-safe codes/messages;
- no optional Stage 2 signed-document preview route.
- Portal API helpers call only customer review and Portal-safe evidence proxy endpoints;
- Portal view-models explicitly select safe display fields and drop storage/provider/finance internals;
- Portal list/detail page source includes loading, empty, error, confirm, and objection states without unsafe controls or raw DTO rendering.

## Current State And Open Items

- PDF visual acceptance has passed. The current document embeds photo derivatives four per page and video keyframes/manifest metadata, not original video streams.
- Stage 2 mapping/readiness/callback/archive behavior is documented in `docs/stage2-esign-provider-mapping.md`.
- The protected Portal eSign APIs are implemented, but the Portal Web status display and signing-start control are not yet integrated.
- Controlled sandbox validation is still required for duplicate transaction idempotency, callback retry/out-of-order behavior, auto-seal authorization validity, sign-to-download delay, and archive/filing idempotency.
- This documentation round used no real provider or database.
- Admin void/escalation policy beyond resubmission/send-back and audit timezone cleanup remain open.
