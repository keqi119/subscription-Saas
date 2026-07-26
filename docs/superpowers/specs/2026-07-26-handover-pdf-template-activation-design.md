# Stage 2 Handover PDF Template Activation Design

## Context

Staging order `ORD20260726073922TFHF` completed field handover and customer
confirmation successfully. Admin PDF generation then returned:

`未找到生效中的车辆交接确认单模板。`

The work order is `CUSTOMER_CONFIRMED` and its delivery handover is `DRAFT`,
which are valid inputs for source PDF generation. The staging database contains
active subscription-standard contract versions but no contract version with:

- `businessType=SUBSCRIPTION`
- `templateType=DELIVERY_HANDOVER`
- `status=ACTIVE`
- a currently effective date range

The backend already accepts `templateType` when creating a contract version.
The Admin contract-version form does not expose or submit that field, so every
template created through the UI receives the backend default
`SUBSCRIPTION_STANDARD`.

## Decision

Use the existing audited contract-template API to provision the missing staging
template, and fix the Admin UI so operators can explicitly create both supported
template types.

Do not create an implicit template during PDF generation. Do not add a migration
that automatically activates legal template data in every environment.

## Staging Recovery

Create a contract version through the authenticated staging Admin API with:

- template name: `车辆交接确认单`
- version: `V1.0`
- business type: `SUBSCRIPTION`
- template type: `DELIVERY_HANDOVER`
- effective from: `2026-07-26`
- no effective end date
- initial status: `DRAFT`

Activate it through the existing activation endpoint so `approvedBy`,
`approvedAt`, `updatedBy`, and audit records are populated by the application.
The operation must be idempotent: first query existing versions and create only
when the exact template/version is absent; activate only when it is not already
active.

No direct staging SQL writes are permitted for the recovery.

## Admin UI

The contract-version creation drawer will:

- require an explicit template type;
- offer `标准订阅合同` for `SUBSCRIPTION_STANDARD`;
- offer `车辆交接确认单` for `DELIVERY_HANDOVER`;
- default to `SUBSCRIPTION_STANDARD` to preserve the existing standard-contract
  workflow;
- include `templateType` in the create request;
- display the template type in the versions table.

The API contract remains unchanged because `CreateContractVersionDto` already
validates and persists `templateType`.

## Error Handling

The PDF generator remains fail-closed when no active delivery-handover template
exists. This is required for contract version governance and Stage 2 eSign
readiness.

The staging provisioning operation must stop without mutation if login fails,
the account lacks template permissions, or an unexpected conflicting template
record exists.

## Tests

Add Web tests around a pure contract-version form model:

- the default form type is `SUBSCRIPTION_STANDARD`;
- a delivery-handover selection produces a create payload containing
  `templateType=DELIVERY_HANDOVER`;
- the two supported options have the intended Admin labels.

Run the full Web test suite, Web typecheck, and Web build. Existing API tests
remain the regression coverage for contract-version persistence and Stage 2 PDF
template lookup.

## Validation

After merge and staging deployment:

1. Confirm the audited delivery-handover contract version is active and currently
   effective.
2. Confirm staging API and Web containers are healthy.
3. Generate the Stage 2 handover PDF for work order
   `a16d72dd-a2b6-44fb-a15e-d558db6fddd3` through the authenticated Admin API.
4. Confirm a source PDF artifact is persisted and downloadable.
5. Do not start Stage 2 eSign, call Fadada, confirm delivery, start a lease, or
   create billing activity.
6. Confirm production images and containers are unchanged.

## Rollback

The code deployment uses the previous immutable staging Web image as rollback.
The newly created template is not deleted after a successful PDF generation
because the generated contract references it. If activation must be reversed
before any PDF is generated, use the existing deactivate endpoint so the change
is audited.
