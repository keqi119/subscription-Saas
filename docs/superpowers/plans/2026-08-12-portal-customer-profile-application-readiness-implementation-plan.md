# Portal Customer Profile and A/B-Line Application Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let customers complete the minimum application profile in Portal, let B-line sales refresh that profile without editing it, and freeze a versioned customer-profile snapshot when an A- or B-line application is submitted.

**Architecture:** `Customer`, `CustomerIdentity`, and `CustomerProfile` remain the pre-submission source of truth. A shared readiness module validates the minimum profile, while a focused snapshot module freezes that source into `Application.customerProfileSnapshot`. Portal and Admin reuse the same backend rules; Admin never writes customer identity data from an application form.

**Tech Stack:** Next.js 16, React 19, Ant Design 6, `@vant/area-data` 2.1.0, NestJS 11, Prisma 7, TypeScript 6, Vitest 4, PostgreSQL.

## Global Constraints

- Follow `AGENTS.md` and `DEV_SPEC.md`.
- Keep `SUBSCRIPTION` as the only active product line; do not expose `RENT_TO_OWN`.
- Required before application submission: name, verified login mobile, ID number, residence province, city, district, detail, emergency-contact name, and emergency-contact mobile.
- Emergency-contact mobile must be a valid mainland mobile and must differ from the customer's login mobile.
- Do not display or collect occupation, company, monthly income, social-security months, or housing-fund months in this round.
- Do not collect driver-license number or expiry; driving qualification remains a manual review of uploaded driver-license materials.
- Do not move Fadada real-name verification or add a Journey step/status.
- Admin may create an incomplete B-line `DRAFT`, but submission must fail until the customer completes Portal data.
- Admin must not edit or overwrite customer identity/profile fields from the application UI or application-create API.
- Store all money unchanged in cents; this feature adds no money behavior.
- Preserve existing fields and historical rows; migrations are additive and do not backfill unparseable historical addresses.
- Web and API must be deployed one-to-one because the Admin create payload changes.
- Implement with TDD and use Inline Execution in this thread; do not dispatch subagents unless the user explicitly reverses the existing instruction.

---

### Task 1: Add structured address and application snapshot persistence

**Files:**
- Create: `apps/api/prisma/migrations/20260812120000_customer_application_profile_readiness/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/test/customer-application-profile-schema.spec.ts`

**Interfaces:**
- Produces: nullable `CustomerProfile.residenceProvince`, `residenceCity`, `residenceDistrict`, `residenceDetail`, and nullable `Application.customerProfileSnapshot`.
- Consumed by: Tasks 3-7.

- [ ] **Step 1: Write the failing Prisma contract test**

Create a schema contract test that reads the generated Prisma DMMF:

```ts
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

function field(modelName: string, fieldName: string) {
  const model = Prisma.dmmf.datamodel.models.find((item) => item.name === modelName);
  return model?.fields.find((item) => item.name === fieldName);
}

describe("customer application profile persistence", () => {
  it.each([
    ["residenceProvince", "String"],
    ["residenceCity", "String"],
    ["residenceDistrict", "String"],
    ["residenceDetail", "String"]
  ])("adds optional CustomerProfile.%s", (name, type) => {
    expect(field("CustomerProfile", name)).toMatchObject({
      isList: false,
      isRequired: false,
      type
    });
  });

  it("adds an optional Application customer profile snapshot", () => {
    expect(field("Application", "customerProfileSnapshot")).toMatchObject({
      isList: false,
      isRequired: false,
      type: "Json"
    });
  });
});
```

- [ ] **Step 2: Run the schema test and confirm it fails**

```powershell
pnpm --filter @subscription-saas/api test -- test/customer-application-profile-schema.spec.ts
```

Expected: FAIL because all five fields are absent.

- [ ] **Step 3: Add the Prisma fields**

Add to `CustomerProfile`:

```prisma
residenceProvince       String?   @map("residence_province") @db.VarChar(64)
residenceCity           String?   @map("residence_city") @db.VarChar(64)
residenceDistrict       String?   @map("residence_district") @db.VarChar(64)
residenceDetail         String?   @map("residence_detail") @db.VarChar(255)
```

Add to `Application` near the intent/customer-selected snapshots:

```prisma
customerProfileSnapshot Json?    @map("customer_profile_snapshot")
```

- [ ] **Step 4: Add the additive SQL migration**

```sql
ALTER TABLE "customer_profile"
  ADD COLUMN "residence_province" VARCHAR(64),
  ADD COLUMN "residence_city" VARCHAR(64),
  ADD COLUMN "residence_district" VARCHAR(64),
  ADD COLUMN "residence_detail" VARCHAR(255);

ALTER TABLE "application"
  ADD COLUMN "customer_profile_snapshot" JSONB;
```

- [ ] **Step 5: Generate Prisma Client and rerun the schema test**

```powershell
pnpm prisma:generate
pnpm --filter @subscription-saas/api test -- test/customer-application-profile-schema.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Validate migration state without applying destructive operations**

```powershell
pnpm prisma:validate
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected before deployment: schema validates; migrate status reports only the newly created migration as pending on databases where it has not yet been deployed.

- [ ] **Step 7: Commit persistence changes**

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260812120000_customer_application_profile_readiness/migration.sql apps/api/test/customer-application-profile-schema.spec.ts
git commit -m "feat: add application profile snapshot persistence"
```

### Task 2: Build the shared application-profile readiness rules

**Files:**
- Create: `apps/api/src/customer/customer-application-profile-readiness.ts`
- Create: `apps/api/test/customer-application-profile-readiness.spec.ts`
- Modify: `apps/api/src/customer/customer-identity-readiness.ts`

**Interfaces:**
- Consumes: existing identity normalization and placeholder-name rules.
- Produces:
  - `CustomerApplicationProfileFieldKey`;
  - `CustomerApplicationProfileSource`;
  - `buildCustomerApplicationProfileReadiness(source)`;
  - `assertCustomerApplicationProfileReady(source)`;
  - `normalizeCustomerApplicationProfile(source)`;
  - `formatResidenceAddress(profile)`.

- [ ] **Step 1: Write readiness tests for the accepted minimum profile**

Use this complete fixture:

```ts
const completeProfile = {
  id: "customer-1",
  identity: { idCardNo: "11010519491231002X" },
  mobile: "13800000000",
  name: "测试客户",
  profile: {
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市"
  },
  sourceChannel: "portal"
};

it("accepts the minimum application profile", () => {
  expect(buildCustomerApplicationProfileReadiness(completeProfile)).toEqual({
    complete: true,
    missingFields: []
  });
});
```

- [ ] **Step 2: Write rejection tests for every required field**

Cover the exact keys:

```ts
function deleteProfileField(
  source: typeof completeProfile,
  key: CustomerApplicationProfileFieldKey
) {
  if (key === "name" || key === "mobile") {
    source[key] = "";
    return;
  }
  if (key === "idCardNo") {
    source.identity.idCardNo = "";
    return;
  }
  source.profile[key] = "";
}

it.each([
  "name",
  "mobile",
  "idCardNo",
  "residenceProvince",
  "residenceCity",
  "residenceDistrict",
  "residenceDetail",
  "emergencyContactName",
  "emergencyContactMobile"
] as const)("reports missing %s", (key) => {
  const source = structuredClone(completeProfile);
  deleteProfileField(source, key);
  expect(buildCustomerApplicationProfileReadiness(source).missingFields).toEqual(
    expect.arrayContaining([expect.objectContaining({ key, reason: "MISSING" })])
  );
});
```

Also add:

```ts
it("rejects an emergency contact mobile equal to the login mobile", () => {
  const source = structuredClone(completeProfile);
  source.profile.emergencyContactMobile = source.mobile;
  expect(buildCustomerApplicationProfileReadiness(source).missingFields).toContainEqual(
    expect.objectContaining({ key: "emergencyContactMobile", reason: "INVALID" })
  );
});

it("formats direct-municipality addresses without duplicating the city", () => {
  expect(formatResidenceAddress(completeProfile.profile)).toBe(
    "上海市闵行区北翟路1554弄53号"
  );
});
```

- [ ] **Step 3: Run tests and confirm the module is missing**

```powershell
pnpm --filter @subscription-saas/api test -- test/customer-application-profile-readiness.spec.ts
```

Expected: FAIL because the readiness module does not exist.

- [ ] **Step 4: Export the existing profile-text normalizer**

Change the existing private helper to:

```ts
export function normalizeProfileText(value: null | string | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}
```

Do not change existing identity readiness behavior.

- [ ] **Step 5: Implement the shared readiness module**

Define the source shape and merge identity issues with profile issues:

```ts
export const CUSTOMER_APPLICATION_PROFILE_INCOMPLETE =
  "CUSTOMER_APPLICATION_PROFILE_INCOMPLETE";

export type CustomerApplicationProfileFieldKey =
  | "name"
  | "mobile"
  | "idCardNo"
  | "residenceProvince"
  | "residenceCity"
  | "residenceDistrict"
  | "residenceDetail"
  | "emergencyContactName"
  | "emergencyContactMobile";

export interface CustomerApplicationProfileSource extends CustomerIdentityProfileSource {
  id: string;
  profile?: {
    emergencyContactMobile?: null | string;
    emergencyContactName?: null | string;
    residenceCity?: null | string;
    residenceDetail?: null | string;
    residenceDistrict?: null | string;
    residenceProvince?: null | string;
  } | null;
}
```

The implementation must:

```ts
const identity = buildCustomerIdentityProfileReadiness(source);
const mobile = normalizeMobile(source.mobile);
const emergencyMobile = normalizeMobile(source.profile?.emergencyContactMobile);
const profileFields = {
  emergencyContactMobile: emergencyMobile,
  emergencyContactName: normalizeProfileText(source.profile?.emergencyContactName),
  residenceCity: normalizeProfileText(source.profile?.residenceCity),
  residenceDetail: normalizeProfileText(source.profile?.residenceDetail),
  residenceDistrict: normalizeProfileText(source.profile?.residenceDistrict),
  residenceProvince: normalizeProfileText(source.profile?.residenceProvince)
};
```

Copy identity issues into the expanded key type. Append `MISSING` issues for every empty profile field. Append `INVALID` for `emergencyContactMobile` when it is not a mainland mobile or equals `mobile`.

`normalizeCustomerApplicationProfile` must call the readiness assertion and return this exact normalized shape:

```ts
export interface NormalizedCustomerApplicationProfile {
  customerId: string;
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo: string;
  mobile: string;
  name: string;
  residenceAddress: string;
  residenceCity: string;
  residenceDetail: string;
  residenceDistrict: string;
  residenceProvince: string;
}
```

The assertion must throw:

```ts
throw new BadRequestException(
  `${CUSTOMER_APPLICATION_PROFILE_INCOMPLETE}: required customer application profile is incomplete or invalid (${details})`
);
```

`formatResidenceAddress` must omit the duplicated city when province and city are equal, concatenate district and detail, and throw `CUSTOMER_APPLICATION_PROFILE_INVALID` when the generated address exceeds 255 characters.

- [ ] **Step 6: Run readiness and existing identity tests**

```powershell
pnpm --filter @subscription-saas/api test -- test/customer-application-profile-readiness.spec.ts test/application-review-api.spec.ts test/portal-application.spec.ts
```

Expected: PASS. The new readiness module is not wired into application submission until Tasks 4 and 5, so existing application behavior remains unchanged in this task.

- [ ] **Step 7: Commit the readiness boundary**

```powershell
git add apps/api/src/customer/customer-application-profile-readiness.ts apps/api/src/customer/customer-identity-readiness.ts apps/api/test/customer-application-profile-readiness.spec.ts
git commit -m "feat: validate minimum application profile"
```

### Task 3: Expand Portal profile storage and auditing

**Files:**
- Modify: `apps/api/src/portal/portal-profile.dto.ts`
- Modify: `apps/api/src/portal/portal-profile.service.ts`
- Modify: `apps/api/src/portal/portal.controller.ts`
- Create: `apps/api/test/portal-profile.spec.ts`

**Interfaces:**
- Consumes: Task 2 readiness and address formatting functions.
- Produces: expanded `GET /portal/profile` and `PATCH /portal/profile` responses with `profileComplete` and `missingProfileFields` based on all required fields.

- [ ] **Step 1: Write a Portal profile update test**

Create a harness and assert one transaction writes identity and profile data:

```ts
await service.updateProfile(
  {
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    idCardNo: "11010519491231002X",
    name: "测试客户",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市"
  },
  currentCustomer,
  { ipAddress: "127.0.0.1", userAgent: "vitest" }
);

expect(tx.customerProfile.upsert).toHaveBeenCalledWith(
  expect.objectContaining({
    create: expect.objectContaining({
      emergencyContactMobile: "13900000000",
      residenceAddress: "上海市闵行区北翟路1554弄53号",
      residenceDistrict: "闵行区"
    }),
    where: { customerId: currentCustomer.customerId }
  })
);
expect(auditService.write).toHaveBeenCalledWith(
  expect.objectContaining({ entityType: "customer_profile", operatorId: "account-1" })
);
```

Add tests that an invalid emergency mobile produces no transaction writes and that `mobile` is taken from `currentCustomer.phone`, not accepted from the request body.

- [ ] **Step 2: Run the Portal profile test and confirm it fails**

```powershell
pnpm --filter @subscription-saas/api test -- test/portal-profile.spec.ts
```

Expected: FAIL because the DTO, profile upsert, request context, and audit call are absent.

- [ ] **Step 3: Expand and constrain the DTO**

Keep `name` and `idCardNo`; remove editable `mobile`; add optional patch fields with exact maximum lengths:

```ts
@IsOptional() @IsString() @MaxLength(64) residenceProvince?: string;
@IsOptional() @IsString() @MaxLength(64) residenceCity?: string;
@IsOptional() @IsString() @MaxLength(64) residenceDistrict?: string;
@IsOptional() @IsString() @MaxLength(255) residenceDetail?: string;
@IsOptional() @IsString() @MaxLength(64) emergencyContactName?: string;
@IsOptional() @IsString() @MaxLength(32) emergencyContactMobile?: string;
```

- [ ] **Step 4: Update service reads and transactional writes**

Change `findCustomer` to include both `identity` and `profile`. Merge omitted patch fields with stored values, set mobile from the verified account, call `normalizeCustomerApplicationProfile`, then upsert:

```ts
await tx.customerProfile.upsert({
  create: {
    createdBy: currentCustomer.customerAccountId,
    customerId: currentCustomer.customerId,
    emergencyContactMobile: valid.emergencyContactMobile,
    emergencyContactName: valid.emergencyContactName,
    residenceAddress: valid.residenceAddress,
    residenceCity: valid.residenceCity,
    residenceDetail: valid.residenceDetail,
    residenceDistrict: valid.residenceDistrict,
    residenceProvince: valid.residenceProvince,
    updatedBy: currentCustomer.customerAccountId
  },
  update: {
    emergencyContactMobile: valid.emergencyContactMobile,
    emergencyContactName: valid.emergencyContactName,
    residenceAddress: valid.residenceAddress,
    residenceCity: valid.residenceCity,
    residenceDetail: valid.residenceDetail,
    residenceDistrict: valid.residenceDistrict,
    residenceProvince: valid.residenceProvince,
    updatedBy: currentCustomer.customerAccountId
  },
  where: { customerId: currentCustomer.customerId }
});
```

Return the structured fields, masked ID state, profile `updatedAt`, and shared readiness result.

- [ ] **Step 5: Add request context and audit logging**

Inject `AuditService`, accept context in `updateProfile`, and pass request IP/user-agent from `PortalController`. Audit the before/after profile view with:

```ts
await this.auditService.write({
  action: AuditAction.UPDATE,
  after: toPortalProfileView(updated),
  before: toPortalProfileView(before),
  entityId: currentCustomer.customerId,
  entityType: "customer_profile",
  ipAddress: context.ipAddress,
  module: "portal",
  operatorId: currentCustomer.customerAccountId,
  userAgent: context.userAgent
});
```

- [ ] **Step 6: Run focused tests**

```powershell
pnpm --filter @subscription-saas/api test -- test/portal-profile.spec.ts test/portal-auth.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Portal profile API changes**

```powershell
git add apps/api/src/portal/portal-profile.dto.ts apps/api/src/portal/portal-profile.service.ts apps/api/src/portal/portal.controller.ts apps/api/test/portal-profile.spec.ts
git commit -m "feat: complete portal application profile"
```

### Task 4: Freeze and expose versioned application profile snapshots

**Files:**
- Create: `apps/api/src/customer/application-customer-profile-snapshot.ts`
- Create: `apps/api/test/application-customer-profile-snapshot.spec.ts`
- Modify: `apps/api/src/customer/dto/create-application.dto.ts`
- Modify: `apps/api/src/customer/customer.service.ts`
- Modify: `apps/api/test/application-review-api.spec.ts`
- Modify: `apps/api/test/self-service-application.spec.ts`

**Interfaces:**
- Consumes: Task 2 normalized complete profile.
- Produces:
  - `ApplicationCustomerProfileSnapshot`;
  - `buildApplicationCustomerProfileSnapshot(source, previousSnapshot, capturedAt)`;
  - Application view fields `customerProfileSnapshot`, `customerProfileReadiness`, `customerProfileDisplaySource`, and `customerProfileUpdatedAt`.

- [ ] **Step 1: Write snapshot builder tests**

```ts
it("builds a V1 snapshot from a complete customer profile", () => {
  expect(
    buildApplicationCustomerProfileSnapshot(completeProfile, null, now)
  ).toMatchObject({
    capturedAt: "2026-08-12T00:00:00.000Z",
    customerId: "customer-1",
    emergencyContactMobile: "13900000000",
    idCardNo: "11010519491231002X",
    residenceAddress: "上海市闵行区北翟路1554弄53号",
    snapshotVersion: 1,
    source: "CUSTOMER_PORTAL_PROFILE"
  });
});

it("increments an existing snapshot version", () => {
  const v1 = buildApplicationCustomerProfileSnapshot(completeProfile, null, now);
  expect(buildApplicationCustomerProfileSnapshot(completeProfile, v1, later)).toMatchObject({
    snapshotVersion: 2
  });
});
```

- [ ] **Step 2: Run the builder test and confirm it fails**

```powershell
pnpm --filter @subscription-saas/api test -- test/application-customer-profile-snapshot.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the snapshot builder**

The snapshot interface must contain exactly the approved fields:

```ts
export interface ApplicationCustomerProfileSnapshot {
  capturedAt: string;
  customerId: string;
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo: string;
  mobile: string;
  name: string;
  residenceAddress: string;
  residenceCity: string;
  residenceDetail: string;
  residenceDistrict: string;
  residenceProvince: string;
  snapshotVersion: number;
  source: "CUSTOMER_PORTAL_PROFILE";
}
```

Call `assertCustomerApplicationProfileReady`, normalize fields, derive the full address, and set version to `previousVersion + 1`, defaulting to 1 when the previous JSON is absent or invalid.

- [ ] **Step 4: Replace B-line application identity editing tests**

Delete the test that expects `customerIdentity` to update Customer and CustomerIdentity. Replace it with:

```ts
it("allows an incomplete customer to have a sales-assisted draft", async () => {
  const harness = createApplicationReviewHarness({
    customer: { identity: null, mobile: "13800000000", name: "测试客户", profile: null }
  });

  await expect(
    harness.service.createApplication(
      { customerId: "customer-1", intendedModel: "ET5" },
      harness.user,
      harness.context
    )
  ).resolves.toMatchObject({ status: ApplicationStatus.DRAFT });
  expect(harness.tx.customerIdentity.upsert).not.toHaveBeenCalled();
});
```

Add a submit test that supplies a complete current customer, then asserts `customerProfileSnapshot.snapshotVersion === 1`. Add a `NEED_MORE_INFO` test with an existing V1 snapshot and assert the update stores V2.

- [ ] **Step 5: Run B-line tests and confirm current behavior fails**

```powershell
pnpm --filter @subscription-saas/api test -- test/application-review-api.spec.ts
```

Expected: FAIL because incomplete draft creation is blocked and submission does not save a snapshot.

- [ ] **Step 6: Remove application-level identity writes**

Remove `ApplicationCustomerIdentityDto` and `CreateApplicationDto.customerIdentity`. In `CustomerService.createApplication`:

- do not call `assertCustomerIdentityProfileReady`;
- do not update Customer or CustomerIdentity;
- create only the B-line draft and existing intent fields.

- [ ] **Step 7: Make B-line submission authoritative and atomic**

Inside `submitApplication` transaction, reload the customer with identity and profile, build the next snapshot, and update:

```ts
const currentCustomer = await tx.customer.findUniqueOrThrow({
  include: { identity: true, profile: true },
  where: { id: before.customerId }
});
const customerProfileSnapshot = buildApplicationCustomerProfileSnapshot(
  currentCustomer,
  before.customerProfileSnapshot,
  submittedAt
);
await tx.application.update({
  data: {
    customerProfileSnapshot,
    status: ApplicationStatus.SUBMITTED,
    submittedAt,
    updatedBy: user.id
  },
  where: { id }
});
```

This call must occur before Journey signal creation. A validation failure must leave Application and Customer unchanged.

- [ ] **Step 8: Persist a V1 snapshot in A-line creation**

In the self-service transaction, reload the customer with identity/profile before the vehicle status update, build V1, and include it in `tx.application.create.data.customerProfileSnapshot`. Update the harness with `tx.customer.findUniqueOrThrow` and assert the snapshot is present.

- [ ] **Step 9: Expose current readiness and snapshot display metadata**

Extend the application projection with:

```ts
customerProfileDisplaySource:
  | "CURRENT"
  | "SNAPSHOT"
  | "HISTORICAL_CURRENT_FALLBACK";
customerProfileReadiness: CustomerApplicationProfileReadiness;
customerProfileSnapshot: ApplicationCustomerProfileSnapshot | null;
customerProfileUpdatedAt: string | null;
```

Use `CURRENT` for `DRAFT` and `NEED_MORE_INFO`, `SNAPSHOT` for submitted/later records with a snapshot, and `HISTORICAL_CURRENT_FALLBACK` for submitted/later historical records without one.

- [ ] **Step 10: Run focused application tests**

```powershell
pnpm --filter @subscription-saas/api test -- test/application-customer-profile-snapshot.spec.ts test/application-review-api.spec.ts test/self-service-application.spec.ts
```

Expected: PASS.

- [ ] **Step 11: Commit snapshot and application behavior**

```powershell
git add apps/api/src/customer/application-customer-profile-snapshot.ts apps/api/src/customer/dto/create-application.dto.ts apps/api/src/customer/customer.service.ts apps/api/test/application-customer-profile-snapshot.spec.ts apps/api/test/application-review-api.spec.ts apps/api/test/self-service-application.spec.ts
git commit -m "feat: freeze customer profile on application submit"
```

### Task 5: Apply the shared readiness rule to Portal A-line precheck and create

**Files:**
- Modify: `apps/api/src/portal/portal-application.service.ts`
- Modify: `apps/api/test/portal-application.spec.ts`

**Interfaces:**
- Consumes: Task 2 readiness and Task 4 authoritative A-line snapshot behavior.
- Produces: Portal precheck response with all missing profile keys; Portal create remains fail-closed even when precheck is bypassed.

- [ ] **Step 1: Expand the incomplete-profile fixture and expectations**

For a customer with identity but no profile, assert precheck returns:

```ts
expect(result).toMatchObject({ canSubmit: false, profileComplete: false });
expect(result.missingProfileFields.map((item) => item.key)).toEqual([
  "residenceProvince",
  "residenceCity",
  "residenceDistrict",
  "residenceDetail",
  "emergencyContactName",
  "emergencyContactMobile"
]);
expect(result.actions).toContainEqual(
  expect.objectContaining({ key: "COMPLETE_PROFILE", url: "/portal/me" })
);
```

Add a creation test that bypasses precheck and expects `CUSTOMER_APPLICATION_PROFILE_INCOMPLETE` with no `createSelfServiceApplication` call.

- [ ] **Step 2: Run Portal application tests and confirm failure**

```powershell
pnpm --filter @subscription-saas/api test -- test/portal-application.spec.ts
```

Expected: FAIL because Portal still uses the old three-field identity readiness helper.

- [ ] **Step 3: Replace the Portal identity readiness source**

Update the customer lookup to include `profile`, call `buildCustomerApplicationProfileReadiness`, and return its complete/missing result from precheck. Use `assertCustomerApplicationProfileReady` in create as the UX-level guard; Task 4's transaction remains authoritative.

- [ ] **Step 4: Update complete Portal fixtures**

Every fixture representing a ready customer must include:

```ts
profile: {
  emergencyContactMobile: "13900000000",
  emergencyContactName: "王女士",
  residenceAddress: "上海市闵行区北翟路1554弄53号",
  residenceCity: "上海市",
  residenceDetail: "北翟路1554弄53号",
  residenceDistrict: "闵行区",
  residenceProvince: "上海市",
  updatedAt: new Date("2026-08-12T00:00:00.000Z")
}
```

- [ ] **Step 5: Run Portal application tests**

```powershell
pnpm --filter @subscription-saas/api test -- test/portal-application.spec.ts test/portal-profile-material.spec.ts
```

Expected: PASS and profile-material behavior remains unchanged.

- [ ] **Step 6: Commit Portal A-line readiness**

```powershell
git add apps/api/src/portal/portal-application.service.ts apps/api/test/portal-application.spec.ts
git commit -m "feat: enforce portal application profile readiness"
```

### Task 6: Build the Portal profile form and address cascader

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/lib/china-region-options.ts`
- Create: `apps/web/src/lib/portal-profile-form.ts`
- Modify: `apps/web/src/lib/portal-types.ts`
- Modify: `apps/web/src/app/portal/me/page.tsx`
- Modify: `apps/web/src/app/portal/catalog/[id]/page.tsx`
- Create: `apps/web/test/portal-profile-form.spec.ts`
- Create: `apps/web/test/portal-profile-page.spec.tsx`

**Interfaces:**
- Consumes: expanded Portal profile API from Task 3 and missing-field responses from Task 5.
- Produces: `CHINA_REGION_OPTIONS`, `toPortalProfileFormValues`, and `toPortalProfileUpdatePayload` for a mobile-friendly profile form.

- [ ] **Step 1: Add pure form-mapping tests**

```ts
it("maps structured profile values to the Portal PATCH payload", () => {
  expect(
    toPortalProfileUpdatePayload({
      emergencyContactMobile: "13900000000",
      emergencyContactName: "王女士",
      idCardNo: "11010519491231002X",
      name: "测试客户",
      residenceRegion: ["上海市", "上海市", "闵行区"],
      residenceDetail: "北翟路1554弄53号"
    })
  ).toEqual({
    emergencyContactMobile: "13900000000",
    emergencyContactName: "王女士",
    idCardNo: "11010519491231002X",
    name: "测试客户",
    residenceCity: "上海市",
    residenceDetail: "北翟路1554弄53号",
    residenceDistrict: "闵行区",
    residenceProvince: "上海市"
  });
});
```

Test that persisted region names map back to the three-item Cascader path and that omitting a region throws a form-mapping error.

- [ ] **Step 2: Add a page contract test**

Assert the Portal profile source contains labels “省 / 市 / 区县”, “详细地址”, “紧急联系人姓名”, and “紧急联系人手机号”; assert the login mobile uses a read-only control and no editable `name="mobile"` field remains.

- [ ] **Step 3: Run Web tests and confirm failure**

```powershell
pnpm --filter @subscription-saas/web test -- test/portal-profile-form.spec.ts test/portal-profile-page.spec.tsx
```

Expected: FAIL because the helper and new fields do not exist.

- [ ] **Step 4: Add the frozen area-data dependency**

```powershell
pnpm --filter @subscription-saas/web add @vant/area-data@2.1.0
```

Expected: `apps/web/package.json` and `pnpm-lock.yaml` record exactly version 2.1.0.

- [ ] **Step 5: Convert area data to Ant Design Cascader options**

```ts
import { areaList } from "@vant/area-data";

export interface ChinaRegionOption {
  children?: ChinaRegionOption[];
  label: string;
  value: string;
}

export const CHINA_REGION_OPTIONS: ChinaRegionOption[] = Object.entries(
  areaList.province_list
).map(([provinceCode, provinceName]) => ({
  children: Object.entries(areaList.city_list)
    .filter(([cityCode]) => cityCode.slice(0, 2) === provinceCode.slice(0, 2))
    .map(([cityCode, cityName]) => ({
      children: Object.entries(areaList.county_list)
        .filter(([districtCode]) => districtCode.slice(0, 4) === cityCode.slice(0, 4))
        .map(([, districtName]) => ({ label: districtName, value: districtName })),
      label: cityName,
      value: cityName
    })),
  label: provinceName,
  value: provinceName
}));
```

- [ ] **Step 6: Implement the form mapper and API types**

Add the exact structured fields, `profileUpdatedAt`, and expanded missing-field types to `PortalCustomerProfile`. The mapper must omit `idCardNo` when the user leaves the password field blank and `idCardNoPresent` is already true.

- [ ] **Step 7: Rebuild the Portal profile page**

Use:

```tsx
<Form.Item
  label="省 / 市 / 区县"
  name="residenceRegion"
  rules={[{ required: true, message: "请选择省、市和区县" }]}
>
  <Cascader
    options={CHINA_REGION_OPTIONS}
    placeholder="请选择居住地区"
    showSearch
  />
</Form.Item>
```

Add required detailed-address and emergency-contact controls, show the verified login mobile in `Descriptions` instead of an editable form item, preserve the masked-ID replacement behavior, and keep redirect-after-save.

- [ ] **Step 8: Keep product-page recovery behavior**

When precheck reports incomplete data, route to:

```ts
router.push(
  `/portal/me?redirect=${encodeURIComponent(`/portal/catalog/${params.id}`)}`
);
```

After saving a complete profile, the existing redirect returns the customer to the same vehicle and plan screen.

- [ ] **Step 9: Run Web tests and typecheck**

```powershell
pnpm --filter @subscription-saas/web test -- test/portal-profile-form.spec.ts test/portal-profile-page.spec.tsx test/portal-catalog-presentation.spec.ts
pnpm --filter @subscription-saas/web typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit Portal Web changes**

```powershell
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/china-region-options.ts apps/web/src/lib/portal-profile-form.ts apps/web/src/lib/portal-types.ts apps/web/src/app/portal/me/page.tsx apps/web/src/app/portal/catalog/[id]/page.tsx apps/web/test/portal-profile-form.spec.ts apps/web/test/portal-profile-page.spec.tsx
git commit -m "feat: add portal application profile form"
```

### Task 7: Make Admin B-line intake read-only and refreshable

**Files:**
- Create: `apps/web/src/lib/application-customer-profile-view-model.ts`
- Modify: `apps/web/src/app/applications/page.tsx`
- Modify: `apps/web/src/app/applications/[id]/page.tsx`
- Create: `apps/web/test/application-customer-profile-view-model.spec.ts`
- Create: `apps/web/test/application-customer-profile-ui.spec.tsx`

**Interfaces:**
- Consumes: Task 4 application projection.
- Produces: `buildApplicationCustomerProfileView(detail)` with source label, snapshot version/time, readiness state, missing labels, and the fields to render.

- [ ] **Step 1: Write view-model tests for all display sources**

```ts
it.each([
  ["CURRENT", "客户当前资料"],
  ["SNAPSHOT", "V2 进件提交快照"],
  ["HISTORICAL_CURRENT_FALLBACK", "历史记录，当前展示客户档案"]
] as const)("labels %s correctly", (source, label) => {
  expect(
    buildApplicationCustomerProfileView(
      applicationDetail({ customerProfileDisplaySource: source })
    ).sourceLabel
  ).toBe(label);
});
```

Also assert missing fields are rendered from `customerProfileReadiness`, structured address is formatted as one line, and driving qualification copy is “驾驶资格以驾驶证材料人工审核结果为准”.

- [ ] **Step 2: Write Admin page contract tests**

Assert:

- the create page no longer contains `customerIdentity`, “客户姓名”, “实名手机号”, or a create-form ID-number field;
- the detail page contains “刷新客户资料” and the manual driving-qualification copy;
- refresh calls the existing detail loader and does not call a mutation endpoint.

- [ ] **Step 3: Run Web tests and confirm failure**

```powershell
pnpm --filter @subscription-saas/web test -- test/application-customer-profile-view-model.spec.ts test/application-customer-profile-ui.spec.tsx
```

Expected: FAIL because the view model and UI contract do not exist.

- [ ] **Step 4: Remove B-line identity fields from the create modal**

Change the form type to:

```ts
interface CreateApplicationValues {
  customerId: string;
  intendedModel?: string;
  intendedPeriodMonths?: number;
}
```

Delete `fillCustomerIdentity`, all nested `customerIdentity` fields, and any customer-selection side effect that edits identity data. Keep customer selection and existing intent fields.

- [ ] **Step 5: Implement the profile display view model**

For `SNAPSHOT`, use `customerProfileSnapshot`; for `CURRENT` and historical fallback, use current `detail.customer`. Return:

```ts
interface ApplicationCustomerProfileView {
  address: string;
  capturedAt: string | null;
  emergencyContactMobile: string;
  emergencyContactName: string;
  idCardNo: string;
  missingFieldLabels: string[];
  mobile: string;
  name: string;
  profileComplete: boolean;
  sourceLabel: string;
}
```

- [ ] **Step 6: Update the application detail panel**

Add source tag, timestamp, missing-field alert, and:

```tsx
<Button loading={loading} onClick={() => void loadDetail()}>
  刷新客户资料
</Button>
```

Show the button for `DRAFT` and `NEED_MORE_INFO`. Do not add a PATCH/POST request. Disable the existing submit action when `customerProfileReadiness.complete` is false, while retaining backend enforcement.

Remove structured driver-license number/expiry rows and display the manual material-review explanation near the existing driver-license material group.

- [ ] **Step 7: Run Web tests, typecheck, and focused API test**

```powershell
pnpm --filter @subscription-saas/web test -- test/application-customer-profile-view-model.spec.ts test/application-customer-profile-ui.spec.tsx
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api test -- test/application-review-api.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Admin changes**

```powershell
git add apps/web/src/lib/application-customer-profile-view-model.ts apps/web/src/app/applications/page.tsx apps/web/src/app/applications/[id]/page.tsx apps/web/test/application-customer-profile-view-model.spec.ts apps/web/test/application-customer-profile-ui.spec.tsx
git commit -m "feat: refresh customer profile in assisted intake"
```

### Task 8: Run end-to-end quality gates and migration verification

**Files:**
- Verify: all files changed by Tasks 1-7.

**Interfaces:**
- Consumes: complete backend and Web implementation.
- Produces: release evidence for PR review and staging deployment.

- [ ] **Step 1: Run all focused API tests**

```powershell
pnpm --filter @subscription-saas/api test -- test/customer-application-profile-schema.spec.ts test/customer-application-profile-readiness.spec.ts test/portal-profile.spec.ts test/application-customer-profile-snapshot.spec.ts test/application-review-api.spec.ts test/self-service-application.spec.ts test/portal-application.spec.ts test/portal-profile-material.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run all focused Web tests**

```powershell
pnpm --filter @subscription-saas/web test -- test/portal-profile-form.spec.ts test/portal-profile-page.spec.tsx test/application-customer-profile-view-model.spec.ts test/application-customer-profile-ui.spec.tsx test/portal-catalog-presentation.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run schema, generation, typecheck, and lint gates**

```powershell
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api typecheck
pnpm --filter @subscription-saas/web typecheck
pnpm --filter @subscription-saas/api lint
pnpm --filter @subscription-saas/web lint
```

Expected: all commands exit 0.

- [ ] **Step 4: Run the complete API suite**

```powershell
pnpm --filter @subscription-saas/api test
```

Expected: PASS.

- [ ] **Step 5: Verify migration state on the development database**

```powershell
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Expected after applying the new migration to the development database: all migrations are applied and the schema is up to date. Do not run `prisma migrate reset`.

- [ ] **Step 6: Review the branch diff for scope and secrets**

```powershell
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
```

Expected: only the approved migration, customer profile/readiness/snapshot code, Portal/Admin UI, dependency lock, tests, and documentation are present; no credentials or environment files are included.

- [ ] **Step 7: Staging acceptance after one-to-one API/Web deployment**

Verify manually:

1. Portal profile saves and reloads province/city/district/detail and emergency contact;
2. an incomplete A-line customer is redirected to profile and cannot create an application;
3. a complete A-line customer creates an application with a V1 snapshot;
4. sales creates an incomplete B-line draft without editing customer identity;
5. the customer completes Portal data, sales clicks refresh, and B-line submission succeeds;
6. Admin shows the frozen snapshot after submission;
7. changing Portal data after submission does not change that snapshot;
8. a `NEED_MORE_INFO` resubmission generates V2;
9. driver-license materials remain reviewable and no structured driver-license input is required;
10. historical applications without a snapshot display the explicit fallback warning.
