# AGENTS.md

## Project

This repository implements a China mainland EV subscription operation platform.

The current delivery target is an internal Back Office for Shanghai used EV
subscription operations. The active product line is `SUBSCRIPTION`.
`RENT_TO_OWN` remains in enums, fields, permissions, and historical data for
future expansion, but must not be exposed as a new business flow unless the user
explicitly asks for it.

## Source Of Truth

1. Resolve the active checkout with `git rev-parse --show-toplevel`; never assume a drive, home directory, or stale project copy.
2. Read `DEV_SPEC.md` before modifying business logic.
3. Use this precedence when sources disagree:
   - explicit task scope and user approvals define what actions are allowed;
   - current code, schema, tests, and configuration define implemented behavior;
   - the newest dated completion, closeout, or approval record defines verified delivery state;
   - active specifications define intended constraints;
   - older plans, reviews, prompts, and design documents are historical evidence, not proof of current behavior.
4. Do not rewrite historical records to make them look current. Record superseding evidence in a new dated document and link both records.
5. Contract/e-sign legal text must come from an approved legal source, and provider semantics must come from the original provider documentation. If either source is unavailable or conflicts with current code, stop and report the gap.
6. Do not delete existing features, `ProductPriceRule`, legacy quote fields, or `RENT_TO_OWN`.
7. Work in small, reviewable increments and keep unrelated changes out of scope.

## Required Preflight

Before each work round, resolve the checkout and run the repository-only safety gate:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
git branch --show-current
git status --short --branch --untracked-files=all
git rev-parse HEAD
git diff --name-status
git diff --check
```

Before editing, declare the task phase and branch policy: base branch, expected
branch, whether a new or existing branch is required, whether stacking is
allowed, and whether push is allowed. Stop if the branch is wrong, the tree
contains unexpected changes, or the approved file list is unclear.

Database, migration, seed, smoke, and provider preflights are conditional. Run
them only when the task explicitly requires them and the environment is
explicitly authorized for that access. A real database URL, provider credential,
or feature flag in the environment is not permission to use it. Otherwise record
the check as not run and explain the environment or approval blocker. Never run
`prisma migrate reset` or `prisma db push` against shared or production data.

## Work-Mode Safety Gates

- Modify only approved paths. Re-run `git status`, `git diff --name-status`,
  `git diff --stat`, and `git diff --check` before review and commit.
- Stage explicit file paths only. Do not use `git add .`, `git add -A`, or
  `git commit -a`.
- Do not push, create a pull request, merge, or deploy unless the user explicitly
  authorizes that remote action. A request for a local commit does not authorize
  any remote action.
- Do not connect to a real database, run a migration or seed, enable a feature
  flag, or call a real provider unless both the task and target environment are
  explicitly authorized.
- Fleet Ops must remain internal, protected by `fleet_ops:read`, controlled by
  `FLEET_OPS_API_ENABLED`, and read-only at its public controller boundary unless
  a separately approved design changes those invariants.
- Never invent contract/e-sign legal text, credentials, customer PII, seal IDs,
  provider parameters, or provider callback/retry/billing semantics. Use approved
  originals, redact sensitive evidence, and stop when required evidence is absent.

## Business Rules

- All money fields are stored in cents.
- All important status values must be enums.
- All critical operations must write audit logs.
- Product center now uses `SubscriptionPlan` as the sellable subscription package.
- `ProductPriceRule` is a legacy pricing rule retained for compatibility with old quotes and historical data.
- Quote creation for the new flow must use a concrete `vehicleId` and an active `subscriptionPlanId`.
- The A/B mainline is an intake-first model:
  A line customer self-service creates a `SELF_SERVICE` `Application`; B line
  sales-assisted creates a `SALES_ASSISTED` `Application`.
- Both lines converge at application material review, credit/deposit review,
  product-plan review, vehicle inventory review, and final-plan confirmation.
- `SubscriptionOrder` represents a formal pre-contract order and must be
  generated only after the final plan is confirmed.
- A-line customer selections are intent plans stored on `Application`, not final
  signing plans and not formal orders.
- Customer-facing A-line UI must expose only preset active `SubscriptionPlan`
  records, not free package composition.
- Keep `SubscriptionQuote` as the final price and plan snapshot object.
- Extend `Application` for self-service intake state in the first version.
- Existing `POST /api/customer-orders`, `CUSTOMER_SELF_SERVICE` direct orders,
  and `/orders/review` are legacy Stage 5.5 artifacts pending migration.
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
