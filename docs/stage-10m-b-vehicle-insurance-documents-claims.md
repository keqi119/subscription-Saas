# Stage 10M-B Vehicle Insurance, Documents, And Claims

Stage 10M-B adds the first foundation for vehicle insurance policy management, vehicle certificate/document management, and basic insurance claim tracking.

The scope is intentionally operational and back-office controlled. It does not integrate with insurers, does not automate claim submission, and does not change vehicle, order, billing, payment, or write-off state machines.

## Goals

- Manage compulsory traffic insurance and commercial insurance as separate policies.
- Store policy numbers, insurers, policy holders, insured names, effective dates, expiry dates, premiums, insured amounts, and renewal reminders.
- Maintain policy coverage rows such as vehicle damage, third-party liability, personnel, medical outside, and additional coverage.
- Upload private vehicle documents such as vehicle license, compulsory policy, commercial policy, inspection certificate, authorization files, and other vehicle materials.
- Let customers view customer-visible vehicle documents for their own subscription orders.
- Create basic insurance claim records from accident service cases.
- Show claim summaries in back-office service-case detail and customer service-case detail.

## Policy Model

`VehicleInsurancePolicy` is vehicle-scoped and separates policy type from status:

- `COMPULSORY_TRAFFIC`: compulsory traffic insurance.
- `COMMERCIAL`: commercial insurance.
- `OTHER`: other vehicle-related insurance.

The model supports independent `effectiveFrom` and `effectiveTo` dates, so compulsory and commercial policies can have different periods. `renewalReminderAt` records an operational reminder date; this stage does not send automatic reminder notifications.

## Coverage Model

`VehicleInsuranceCoverage` stores coverage rows under a policy:

- `COMPULSORY_TRAFFIC`
- `VEHICLE_DAMAGE`
- `THIRD_PARTY_LIABILITY`
- `VEHICLE_PERSONNEL`
- `MEDICAL_OUTSIDE`
- `ADDITIONAL`
- `OTHER`

Coverages are maintained with the policy and are not used for automated rating or claim calculation in this stage.

## Vehicle Documents

`VehicleDocument` stores private vehicle materials:

- Vehicle license.
- Compulsory insurance policy.
- Commercial insurance policy.
- Inspection certificate.
- Vehicle authorization.
- Other vehicle materials.

Documents are stored through `StorageService` under:

```text
vehicle-documents/{vehicleId}/{yyyy}/{uuid}-{filename}
```

Objects remain private. Back-office and Portal previews use API stream routes and never expose OSS public URLs, `bucket`, or `objectKey` to customer-facing responses.

## Customer Visibility

Portal order documents are exposed through:

```text
GET /api/portal/orders/:id/documents
GET /api/portal/orders/:id/documents/:documentId/preview
```

The customer can only view documents when:

- The order belongs to the current customer.
- The document belongs to the order vehicle.
- The document is `ACTIVE`.
- `customerVisible=true`.
- The document is not soft deleted.

## Insurance Claims

`InsuranceClaim` is a basic operational claim record. It can be created from an accident `ServiceCase` and carries the related vehicle, customer, and order when available.

This stage only stores claim facts and status:

- `claimNo`
- `claimStatus`
- `insurerClaimNo`
- accident / submit / accept / close timestamps
- estimated / approved / paid amounts
- remark and snapshot

It does not call insurance company APIs, does not submit claims automatically, and does not synchronize claim status automatically.

## Back Office

Back office now includes:

- `/vehicle-insurance-policies` policy management page.
- Policy list filters by vehicle, policy type, status, effective-to range, and expiring-within days.
- Policy create/edit drawer with coverage rows.
- Policy detail drawer with attached documents.
- Vehicle detail `insurance / documents` summary and vehicle-document upload.
- Service-case detail claim block for accident cases.

## Permissions And Menu

New permissions:

```text
vehicle_insurance:view
vehicle_insurance:manage
vehicle_document:view
vehicle_document:manage
insurance_claim:view
insurance_claim:manage
```

Role defaults:

- `ADMIN`: all permissions.
- `OP`: view/manage permissions.
- `SA`: view permissions.
- `GM`: view permissions.

Menu:

```text
Vehicles -> Insurance Policies
```

## Portal

Customer Portal changes:

- `/portal/orders/[id]` shows a vehicle-documents section.
- `/portal/service-cases/[id]` shows a read-only insurance claim summary when claims exist.

Customers cannot create or update claims from Portal.

## Redaction

Portal order document and claim summary APIs do not return:

- `bucket`
- `objectKey`
- OSS public URL
- internal remarks
- deleted audit fields
- other customers' documents or claims

This stage does not expose vehicle purchase price, current sale price, full VIN, full plate, financing, residual, cost, or ROE internals.

## Out Of Scope

Stage 10M-B does not include:

- Insurance company API integration.
- Automatic insurance claim submission.
- Automatic claim status synchronization.
- Insurance OCR.
- Complex actuarial pricing.
- Automatic damage-fee bill generation.
- Automatic rescue-fee bill generation.
- Vehicle state changes.
- Order state changes.
- Payment, write-off, billing, WeChat Pay, SMS, or notification main-flow changes.
- Production deployment.
- `prisma migrate reset`.
- `prisma db push`.

## Next Stage

Recommended next stage:

```text
Stage 10M-C: BaaS battery contracts and monthly costs
```
