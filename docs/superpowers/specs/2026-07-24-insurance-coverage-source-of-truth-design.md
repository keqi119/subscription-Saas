# Insurance Coverage Source Of Truth Design

Date: 2026-07-24

Status: Approved

Branch: `fix/insurance-coverage-source-of-truth`

## 1. Context

The vehicle asset ledger and delivery readiness currently read insurance data from different sources:

- insurance policy management writes `VehicleInsurancePolicy`;
- delivery readiness checks active policy rows first, then falls back to
  `Vehicle.insuranceStartDate` and `Vehicle.insuranceEndDate`;
- the vehicle list and vehicle detail "linked insurance period" still render the
  two legacy date columns.

This creates a split source of truth. A vehicle can have valid compulsory and
commercial policies while the asset ledger displays no linked insurance period.
The delivery page also presents two different concepts with similar wording:

- automatic policy-period coverage;
- the manual insurance verification checkbox recorded during delivery preparation.

The observed issue is not caused by the `VehicleModelDefinition` master-data
refactor. Insurance policies relate directly to `Vehicle.id`.

## 2. Decisions

### 2.1 Canonical insurance data

`VehicleInsurancePolicy` is the only canonical source for vehicle insurance
coverage and periods.

The following legacy fields will be retired:

```text
Vehicle.insuranceStartDate
Vehicle.insuranceEndDate
```

No runtime read, write, API serializer, DTO, UI, or delivery fallback may depend
on those fields after the migration.

### 2.2 Delivery coverage rule

A vehicle passes the automatic insurance coverage gate only when both required
policy types cover the delivery evaluation date:

```text
COMPULSORY_TRAFFIC
COMMERCIAL
```

For each required type, at least one policy must satisfy all of:

```text
deletedAt is null
policyStatus is ACTIVE
effectiveFrom <= evaluationDate
effectiveTo >= evaluationDate
```

`OTHER` policies do not satisfy either required type. Multiple policies of the
same type are allowed; any one covering policy satisfies that type.

The evaluation date keeps the existing precedence:

```text
explicit confirmation target
delivery.deliveredAt
delivery.scheduledAt
order.startDate
order.createdAt
```

### 2.3 Manual verification

`VehicleDelivery.insuranceValidConfirmed` remains a separate operational
checklist fact. It does not replace or override automatic policy-period coverage.

Admin copy must distinguish the two concepts:

```text
automatic: 保单期限覆盖状态
manual: 保险人工核验
```

The manual check is completed in the "准备交付" action.

### 2.4 VehicleModel legacy boundary

The `VehicleModel` enum and enum-typed compatibility columns are not part of the
insurance fix. Current removal gates remain:

```text
externalUsageCount = 9
hardRemovalReady = false
decision = NOT_READY
```

Their removal requires a separate staged decommission of API, CSV, report,
pricing, quote, order, snapshot, fixture, and schema dependencies.

The visible Admin "兼容车型（legacy）" control may be removed in that separate
workstream, but this branch will not drop or rewrite model compatibility data.

## 3. Coverage Resolver

Introduce one pure coverage resolver shared by delivery readiness and vehicle
serialization.

Input:

```ts
{
  evaluationDate: Date;
  policies: Array<{
    deletedAt: Date | null;
    effectiveFrom: Date;
    effectiveTo: Date;
    policyStatus: VehicleInsurancePolicyStatus;
    policyType: VehicleInsurancePolicyType;
  }>;
}
```

Output:

```ts
{
  evaluationDate: Date;
  covered: boolean;
  compulsoryTraffic: PolicyTypeCoverage;
  commercial: PolicyTypeCoverage;
}
```

Each `PolicyTypeCoverage` contains only safe business fields:

```ts
{
  covered: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  policyId: string | null;
}
```

The resolver must not return policy documents, object keys, storage paths,
provider data, or internal secrets.

When multiple policies cover the evaluation date, choose a deterministic
representative policy:

1. latest `effectiveFrom`;
2. latest `effectiveTo`;
3. stable id order.

## 4. API Changes

### 4.1 Vehicle list and detail

Vehicle queries include non-deleted insurance policies needed to build an
insurance summary. The vehicle response adds:

```ts
insuranceCoverage: {
  evaluatedAt: string;
  covered: boolean;
  compulsoryTraffic: {
    covered: boolean;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  };
  commercial: {
    covered: boolean;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  };
}
```

For the asset ledger, `evaluatedAt` is the current date. Existing policy
management endpoints remain the source for full policy records.

The legacy response fields `insuranceStartDate` and `insuranceEndDate` are
removed together with the schema fields.

### 4.2 Delivery check

Delivery readiness returns both the aggregate boolean and per-type coverage:

```ts
insuranceValid: boolean;
insuranceCoverage: {
  evaluatedAt: string;
  compulsoryTrafficCovered: boolean;
  commercialCovered: boolean;
};
```

Blocking reasons are specific:

```text
交强险未覆盖计划交付日
商业险未覆盖计划交付日
```

If both are missing, both reasons are returned. The result must not fall back to
legacy vehicle dates.

## 5. Admin UX

### 5.1 Vehicle asset ledger

Replace the single ambiguous "保单有效期（关联）" value with two explicit
business rows or compact lines:

```text
交强险：YYYY-MM-DD 至 YYYY-MM-DD
商业险：YYYY-MM-DD 至 YYYY-MM-DD
```

If a type has no policy covering today, show its state explicitly rather than
displaying a shared dash.

Vehicle detail continues to provide the full policy table and link to policy
management.

### 5.2 Delivery readiness

Show:

```text
交强险期限覆盖
商业险期限覆盖
保险人工核验
```

Automatic coverage blockers link to policy management for the current vehicle.
The manual verification blocker guides the operator to "准备交付" and must not
link to policy management.

## 6. Migration Safety

The legacy insurance date columns have no foreign-key dependents, but their data
must not be silently discarded while it is the only available coverage evidence.

Before applying the drop migration, run a read-only readiness check that reports:

```text
vehicles with either legacy insurance date populated
vehicles with legacy dates but no non-deleted policy rows
vehicles with legacy dates but no active compulsory policy
vehicles with legacy dates but no active commercial policy
vehicles whose active policy periods do not cover the legacy period
```

Hard gate:

```text
legacy dates populated but no usable policy record = 0
```

The migration must stop when the hard gate is not met. It must not synthesize
policy numbers, insurers, policy types, statuses, or dates.

After the gate passes:

1. deploy runtime code that no longer reads or writes legacy dates;
2. apply the Prisma migration dropping both columns;
3. regenerate Prisma Client;
4. verify vehicle list, vehicle detail, policy management, and delivery readiness.

For environments where old and new application versions may overlap, use a short
maintenance window for the column drop.

## 7. Tests

### 7.1 Coverage resolver

Cover:

- both required policy types cover the date;
- compulsory only;
- commercial only;
- `OTHER` only;
- expired policy;
- future policy;
- cancelled, archived, pending-renewal, and deleted policies;
- multiple overlapping policies of one type;
- deterministic representative policy selection;
- inclusive start and end dates;
- date-only behavior independent of server timezone.

### 7.2 Delivery

Cover:

- delivery preparation passes only when both policy types cover the evaluation date;
- each missing type produces its own blocking reason;
- manual verification remains independently required for final delivery;
- changing scheduled delivery date re-evaluates both policies;
- legacy vehicle dates cannot satisfy the gate.

### 7.3 Vehicle API and Admin

Cover:

- vehicle list/detail summary is derived from policy rows;
- compulsory and commercial periods render separately;
- no legacy insurance date response or UI reference remains;
- policy management still loads full policy records;
- no object key, storage path, signing URL, full identity number, or secret is exposed.

### 7.4 Migration

Cover:

- readiness check blocks legacy-only vehicles;
- readiness check passes when policy rows are complete;
- Prisma validate/generate succeeds after column removal;
- repository search finds no runtime references to the dropped fields.

## 8. Rollback

Before the column drop, rollback is application-only.

After the column drop, rollback should keep the policy table canonical and deploy
the previous compatible runtime only if it does not require the removed columns.
Recreating the old columns is not the preferred rollback because it would
reintroduce a second source of truth.

If emergency schema recreation is required, add nullable columns only; do not
backfill them as authoritative insurance data.

## 9. Acceptance Criteria

- the controlled staging vehicle shows both current policy periods in the asset ledger;
- automatic delivery coverage reports both required types as covered;
- missing either required type blocks preparation with a specific reason;
- "保险人工核验" remains a distinct preparation checklist item;
- `VehicleInsurancePolicy` is the sole insurance-period source;
- both legacy vehicle insurance date columns and all code references are removed;
- no `VehicleModel` enum or model compatibility schema field is changed;
- no signing, PDF, Fadada, delivery confirmation, lease, billing, or payment side effect is introduced.
