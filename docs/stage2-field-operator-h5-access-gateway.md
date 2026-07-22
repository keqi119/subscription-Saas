# Stage 2 Field Operator H5 Access Gateway

## Scope

Stage 2 field operator access uses a fixed H5 entry:

```text
/field/handover
```

The backend foundation provides phone OTP login, a short-lived field session, and task list/detail APIs for handover work orders assigned to the authenticated phone number. The first H5 UI phase now includes login, task list, and a read-only task detail placeholder. It does not include WeChat OpenID binding, evidence capture UI, eSign, PDF generation, lease activation, or billing activation.

## H5 Phase 1 Routes

The fixed WeChat service-account menu entry is:

```text
/field/handover
```

This route has no required query string and must not place tokens in the URL. It checks the independent field session and redirects authenticated field operators to:

```text
/field/handover/tasks
```

The task list page loads the current field session and then lists work orders assigned to the authenticated phone number. A lightweight placeholder detail route may be used for safe read-only summary:

```text
/field/handover/tasks/[id]
```

The placeholder is intentionally not an evidence capture page. It must not expose upload controls, field facts editing, submit actions, PDF generation, eSign, lease activation, billing activation, or provider internals.

## SMS Policy

SMS must contain only an OTP verification code or a generic reminder.

SMS must not contain:

- task-specific links
- bearer tokens
- customer data
- order details
- signing URLs

Provider calls are isolated behind the existing SMS abstraction. Tests must mock SMS and must not call the real provider.

The H5 login page must not display debug OTPs even if a non-production API response includes one. The UI success message should only tell the operator that the verification code was sent.

## Auth Boundary

Field operator authentication is independent from Admin and Portal authentication.

- Field cookie: `field_access_token`
- Admin cookie remains `access_token`
- Portal customer cookie remains `customer_access_token`
- Field JWT payload uses `tokenType=field_operator`
- Field sessions are persisted in `FieldOperatorSession`
- Session lookup uses a stored hash, not the plaintext session token
- OTP rows store only hashed codes in `FieldOperatorOtp`

A field session cannot access Admin or Portal customer routes. Admin and Portal tokens are not valid field sessions.

## Task Discovery

After login, the operator can list only active work orders assigned to the normalized phone number:

```text
VehicleHandoverWorkOrder.externalOperatorPhone == session.phone
VehicleHandoverWorkOrder.operatorType == EXTERNAL
access not revoked
legacy access expiry absent or still valid
status not in VOIDED, FAILED, CANCELLED, FIELD_COMPLETED, OPS_REVIEWED
```

No tasks is a normal result and returns an empty list. The response must not reveal whether the phone belongs to a customer, Admin user, or another operator.

## Safe DTO

Field task list/detail responses may include:

- work order id
- order number
- handover type and status
- scheduled time and delivery location
- masked customer phone
- customer display name if already safe for field work
- vehicle brand/model
- masked plate number
- VIN suffix only
- evidence progress
- safe evidence checklist metadata
- field facts needed for handover work

Responses must not include:

- full customer ID number
- full customer profile
- legal contract content
- signing URLs
- provider credentials or provider payload internals
- OSS object keys
- finance, payment, deposit, or billing details
- unrelated orders

The H5 view model should render only explicit safe fields from the DTO. It must not stringify or display raw response objects.

## Legacy Token Policy

Existing `/field/handover/:token` remains a legacy, emergency, or QA path. It is not the primary external distribution mechanism.

The legacy token route remains task-scoped and cannot act as Admin authentication. Future work may require phone login before claiming or opening a tokenized task.

## Audit

The backend records safe field operator audit events:

- OTP requested
- OTP verified
- login succeeded or failed
- session revoked
- task list viewed
- task viewed

Audit data stores phone/session/work-order identifiers and hashed request context only. It must not store plaintext OTPs, plaintext session tokens, signing URLs, secrets, or full identity numbers.

## Phase 1 UI Status

Implemented in the first H5 UI phase:

- `/field/handover` phone OTP login.
- `/field/handover/tasks` authenticated task list.
- `/field/handover/tasks/[id]` read-only summary placeholder for the next evidence capture phase.
- Logout through the field auth boundary.
- Mobile-first single-column layout with loading, empty, error, disabled, and unauthorized states.

Still deferred:

- Add H5 evidence capture and upload flow on top of the field session guard.
- Add Admin assignment/reminder UX that sends only OTP or generic reminders.
- Optionally bind WeChat OpenID/UnionID after phone login.
- Add Customer Portal handover review page for no-objection / objection confirmation.
