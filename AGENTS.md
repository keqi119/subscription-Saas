# AGENTS.md

## Project

This repository implements a China mainland EV subscription operation platform.

The current delivery target is an internal Back Office for Shanghai used EV
subscription operations. The active product line is `SUBSCRIPTION`.
`RENT_TO_OWN` remains in enums, fields, permissions, and historical data for
future expansion, but must not be exposed as a new business flow unless the user
explicitly asks for it.

## Source Of Truth

1. Read `DEV_SPEC.md` before modifying business logic.
2. Treat the current local workspace under `D:\Projects\auto-subscription-platform` as the working baseline.
3. Do not use the old OneDrive project directory.
4. Do not delete existing features, `ProductPriceRule`, legacy quote fields, or `RENT_TO_OWN`.
5. Work in small, reviewable increments and keep unrelated changes out of scope.

## Required Preflight

Before each development round, run and record:

```powershell
git status --short
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
pnpm prisma:validate
```

If migration status fails or reports pending migrations, stop and report the
exact state before changing business code. Never run `prisma migrate reset`
unless the user explicitly approves it.

## Business Rules

- All money fields are stored in cents.
- All important status values must be enums.
- All critical operations must write audit logs.
- Product center now uses `SubscriptionPlan` as the sellable subscription package.
- `ProductPriceRule` is a legacy pricing rule retained for compatibility with old quotes and historical data.
- Quote creation for the new flow must use a concrete `vehicleId` and an active `subscriptionPlanId`.
- The order mainline must support two paths:
  A line customer self-service is order first and review later; B line
  sales-assisted is review first and order later.
- A-line customer selections are intent plans, not final signing plans.
- Customer-facing A-line UI must expose only preset active `SubscriptionPlan`
  records, not free package composition.
- Keep `SubscriptionQuote` as the price and plan snapshot object.
- Do not add `SubscriptionOrderApplication` in the first version unless a later
  reviewed design explicitly changes this decision; prefer extending
  `SubscriptionOrder`.
- A-line deposit is pending at submission and finalized after customer grade,
  deposit rule, and risk review are known.
- `purchasePriceAmount` is the asset cost basis used for depreciation and ROA/ROE.
- `currentSalePriceAmount` is the quote pricing basis used for the vehicle base fee cap.
- Vehicle base fee cap = `currentSalePriceAmount * vehiclePackage.monthlyFeeRate`.
- The 3.5% style cap constrains only the vehicle base fee, not the full subscription package total.
- Package total = vehicle base fee + mileage package price + energy package price + benefit package price.
- Generating a quote does not lock a vehicle; confirming a quote may lock `AVAILABLE -> RESERVED`.
- Target A-line vehicle hold is `AVAILABLE -> REVIEW_RESERVED`; if the first
  implementation temporarily reuses `RESERVED`, keep `REVIEW_RESERVED` as the
  documented target model.

## Permission Rules

When adding or changing permissions, update all of these together:

- `packages/shared/src/auth.ts`
- `apps/api/prisma/seed.mjs`
- `packages/shared/src/menus.ts`
- backend `RequirePermissions`
- frontend menu/button visibility
- documentation telling users to re-login after seed/JWT permission changes

`ADMIN` must receive all permissions. `OP`, `SA`, and `AS` must receive only
the permissions needed by their responsibilities.

## Testing Rules

Write or update tests when touching:

- price calculation or quote snapshots
- vehicle status transitions
- contract/order status transitions
- deposits, billing, payments, write-off, or accounting flows
- permission checks that affect menus, buttons, or protected APIs

At minimum, finish each round with the relevant subset of:

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
```

## Expected Output

When completing a task, summarize:

- changed files
- business behavior changed
- test and quality gate results
- migration status
- known limitations
- recommended next task
