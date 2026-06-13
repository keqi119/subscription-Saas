# Stage 9A Launch Readiness And CI/CD Documentation Audit

> Audit date: 2026-06-13
> Scope: documentation and process-level audit only.
> Code/database/API/browser verification was intentionally not performed.

## 1. Source Materials

- `DEV_SPEC.md`
- `CODEX_TASKS.md`
- `README.md`
- `docs/reporting-metrics.md`
- `docs/stage-8.5-pr-acceptance.md`
- `docs/deployment-aliyun.md`
- `docs/aliyun-db-only.md`
- `docs/residual-market-user-guide.md`
- `docs/capital-structure-revenue-rights-user-guide.md`
- Stage/process records visible from commit titles for Stage 5.5 through Stage 8.6A.

## 2. Overall Closure Judgment

**Stage 9 closure judgment: Partial.**

Stage 9 is not yet an end-to-end production deployment closed loop. The documents define the launch-readiness target, quality gate commands, seed hygiene, deployment starting points, and several strong business acceptance paths. Stage 8.5 has an explicit acceptance record with quality gates passed. However, the Stage 9-specific operational closure is still incomplete because the documentation does not provide enough evidence for:

- actual CI pipeline configuration and current CI pass status;
- full production Web/API deployment runbook;
- production environment variable inventory and validation;
- final migration history and release migration procedure;
- production permission matrix export and review;
- backup, restore, and rollback runbooks;
- consolidated full-system manual acceptance checklist;
- production smoke checks and observability hooks.

Therefore, the system appears **business-rich and partially launch-prepared**, but **not yet production-deployable without a Stage 9B operational hardening pass**.

## 3. Stage 9 Content Review

### 3.1 Business Goals

Stage 9 goal in `CODEX_TASKS.md`:

```text
Make the system stable enough for deployment, rollback, regression testing, and manual acceptance.
```

Business meaning:

- Move from feature completion toward operable release.
- Ensure a fresh environment can be provisioned from documented steps.
- Ensure regressions are caught by CI and smoke checks.
- Ensure rollback, backup, permission initialization, and manual acceptance are explicit.

### 3.2 Scope

Stage 9 includes:

- CI quality gates.
- Test coverage.
- Seed strategy.
- Environment variable templates.
- Deployment documentation.
- Data backup and restore plan.
- Permission initialization.
- Manual acceptance checklist.

### 3.3 Prohibitions

Stage 9 explicitly prohibits:

- Deploying with pending migrations.
- Deploying with undocumented environment variables.
- Relying on local-only seed state for production roles.
- Putting workflow acceptance records back into the default seed.

### 3.4 Backend API Endpoints Mentioned

Stage 9 itself mentions backend APIs only at a category level:

- health checks;
- smoke paths;
- deployment observability hooks as needed.

The README gives an explicit health endpoint:

- `GET /api/health`

Business smoke paths that should be verified in Stage 9, based on prior stage docs:

- `POST /api/self-service-applications`
- `GET /api/applications/:id/available-subscription-plans`
- `POST /api/applications/:id/quotes`
- `POST /api/quotes/:id/confirm`
- `POST /api/quotes/:id/cancel`
- `POST /api/orders/from-quote/:quoteId`
- `POST /api/orders/:id/cancel`
- `POST /api/orders/:id/generate-contract`
- contract sign/archive/cancel endpoints
- delivery and return endpoints
- billing, payment/write-off, deposit, collection, and entitlement endpoints
- report APIs under `/api/reports/*`
- report detail and CSV export APIs under `/api/reports/details/*`
- asset profitability APIs under `/api/reports/asset-profitability/*`
- residual market, curve, forecast, model-run, and valuation-review APIs
- vehicle sale price, status, history, available-pool, and valuation-review APIs.

Items above are candidate Stage 9 smoke targets and require Codex code-level verification.

### 3.5 Frontend Pages And Manual Acceptance Paths

Stage 9 says manual acceptance paths must be documented in README. The current documentation provides scattered but usable acceptance paths:

- Login and system management:
  - login with `admin / Admin@123456`;
  - verify user, role, permission, menu, and audit behavior.
- Core B-line business flow:
  - `/customers`
  - `/applications`
  - `/applications/:id`
  - `/vehicles`
  - `/quotes`
  - `/quotes/:id`
  - `/orders`
  - `/orders/[id]`
  - `/contracts`
  - `/contracts/[id]`
  - `/contract-versions`
- A/B intake flow:
  - use `/applications` and `/applications/:id` as the main review workspace;
  - do not treat legacy `/orders/review` as the new Stage 5.5 mainline.
- Delivery/return/finance operations:
  - delivery center pages;
  - return management pages;
  - billing center;
  - deposit pool;
  - collection center;
  - benefits center.
- Reporting and asset analysis:
  - `/reports`
  - `/reports/asset-profitability`
- Residual and valuation flow:
  - `/residual-market`
  - vehicle detail residual forecast panel;
  - `/vehicle-valuation-reviews`

Gap: Stage 9 does not yet consolidate these into one launch acceptance checklist with expected data setup, expected status transitions, and pass/fail evidence.

### 3.6 Seed Strategy

Documented seed strategy:

- `pnpm prisma:seed` is a baseline master-data initializer only.
- It initializes roles, permissions, menus, test users, clean customer leads, active product/package config, deposit rules, available vehicles, and vehicle sale price initialization records.
- Default seed must not create workflow acceptance records such as self-service applications, quotes, orders, contracts, delivery, return, billing, collection, or entitlement demo data.
- Seed vehicles must remain:
  - `AVAILABLE`;
  - `currentSalePriceAmount > 0`;
  - `salePriceStatus = EFFECTIVE`;
  - valid insurance dates;
  - with `INITIAL_POOL` sale price history.
- Scenario seed scripts must be isolated and must not pollute the default vehicle pool:
  - `pnpm seed:scenario delivery`
  - `pnpm seed:scenario return`
  - `pnpm seed:scenario billing`
  - `pnpm seed:scenario collection`
  - `pnpm seed:scenario entitlement`
- After permission/menu seed changes, users must log out and log in again to refresh JWT/access token permissions.

Gap: docs describe desired scenario seed commands, but implementation and idempotency require Codex verification.

### 3.7 Environment Variable Guidance

Documented environment guidance:

- Copy `.env.example` to `.env`.
- Confirm `DATABASE_URL` points to the active PostgreSQL database.
- Confirm SSH tunnel maps remote PostgreSQL to `127.0.0.1:5432` when using the Alibaba Cloud DB-only setup.
- Confirm Redis is reachable at `127.0.0.1:6379` when needed.
- `docs/aliyun-db-only.md` documents:
  - `DATABASE_URL`
  - `REDIS_URL`
  - `SEED_ADMIN_PASSWORD`
  - `POSTGRES_PASSWORD`
  - `REDIS_PASSWORD`

Gap: there is no complete production environment variable matrix covering required/optional variables, owners, example values, secret handling, validation command, and production/staging differences.

### 3.8 Deployment Instructions

Documented deployment guidance:

- Target: Alibaba Cloud ECS.
- Recommended runtime:
  - Node.js 20 LTS or newer;
  - Corepack-managed pnpm;
  - Docker Compose for PostgreSQL and Redis in early environments;
  - Nginx or another reverse proxy before Web/API.
- Ports:
  - Web `3000`;
  - API `3001`;
  - PostgreSQL `5432`;
  - Redis `6379`.
- First boot:
  - enable Corepack;
  - prepare pnpm;
  - install dependencies;
  - start PostgreSQL/Redis;
  - copy env;
  - run migration, seed, validation;
  - run dev service.
- `docs/aliyun-db-only.md` is explicitly an early Stage 1-style setup where the server runs only PostgreSQL/Redis and local machine runs Web/API through SSH tunnel.

Gap: deployment documentation is not production complete. It lacks a full Web/API production build and process runbook, TLS/domain/reverse-proxy details, service manager config, deployment rollback, backup/restore, release tagging, migration sequencing, and smoke verification.

### 3.9 Quality Gates And Test Expectations

Documented quality gate:

```powershell
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
```

Stage 8.5 acceptance records these passing:

```text
pnpm -r lint
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:seed
pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @subscription-saas/web exec tsc --noEmit --incremental false
pnpm --filter @subscription-saas/api test
pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma
31 files / 524 tests passed
Database schema is up to date
```

Documentation conflict requiring verification:

- `DEV_SPEC.md` still lists `prisma migrate status` failure as a known risk.
- Stage 8.5 acceptance says migration status passed and database schema is up to date.

Stage 9 must re-run and record the current result instead of relying on older documents.

## 4. Stage 9 Mainline Capability Table

| Stage | Business Domain | Current Completion | Must-Have | End-to-End Closed | Major Gaps | Recommended Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | CI quality gates | Commands documented; Stage 8.5 has a manual pass record | CI workflow runs lint, Prisma validate/generate, API/web typecheck, API tests, migration status, smoke | Partial | No documented CI config or current CI result | P0 |
| 9 | Regression and smoke testing | Business smoke candidates can be derived from Stage 5.5-8.6A docs | Automated smoke for login, health, A/B intake, quote, order, contract, delivery, billing, reports, residual valuation | Partial | No consolidated smoke suite or pass evidence | P0 |
| 9 | Seed strategy | Strongly documented baseline seed hygiene and scenario seed direction | Idempotent baseline seed, production role grants, isolated scenario seeds | Partial | Scenario seed implementation/idempotency requires verification; production role seed cannot be local-only | P0 |
| 9 | Environment variables | README and Aliyun DB-only docs cover basic `.env`, DB, Redis, seed admin password | Complete prod/stage env matrix with required/optional vars and validation | Partial | No full env inventory or secret handling runbook | P0 |
| 9 | Deployment documentation | Early Aliyun/ECS notes exist; DB-only tunnel plan exists | Production Web/API build, process manager, reverse proxy, TLS/domain, release procedure | Not closed | Current docs are early/dev-oriented and not full production runbooks | P0 |
| 9 | Migration release process | Commands documented; conflicting migration status evidence | Final migration history, no pending migrations, backup before migration, rollback decision rules | Partial | DEV_SPEC risk conflicts with Stage 8.5 pass record; current state requires verification | P0 |
| 9 | Backup and restore | Listed in Stage 9 scope | Backup schedule, pre-release backup, restore drill, owner, retention | Not closed | No concrete backup/restore plan found | P0 |
| 9 | Rollback | Listed in Stage 9 goal and acceptance | App rollback, migration rollback/forward-fix policy, seed rollback, smoke after rollback | Not closed | No rollback runbook found | P0 |
| 9 | Permission initialization | Seed/JWT refresh guidance exists; Stage 8.6B defines residual permission matrix after 8.6A | Production permission matrix exported and reviewed across roles | Partial | No single production permission export/evidence; cross-domain permissions need verification | P1 |
| 9 | Manual acceptance checklist | README, Stage 8.5, Stage 8.6A, residual guide contain paths | One full launch checklist with data setup, expected status transitions, evidence capture | Partial | Scattered paths; no full launch sign-off artifact | P1 |
| 9 | Observability and health | `/api/health` documented; Stage 9 mentions hooks as needed | Health, logs, deploy events, error visibility, smoke hooks | Partial | No observability checklist or hook spec | P1 |
| 9 | Documentation consistency | Core docs exist, but some are stale relative to later Stage 8 records | DEV_SPEC/README/CODEX_TASKS agree on current branch, status, migration, and launch flow | Partial | DEV_SPEC and README include old blockers and Stage 5-era status | P1 |

## 5. Already Closed-Loop Or Near-Closed Capabilities

These are closed or near-closed at documentation/process level, with code-level verification still required before production:

1. B-line sales-assisted quote/order/contract baseline:
   - customer/application/risk/product/vehicle/quote/order/contract path documented;
   - quote confirmation locks vehicle from `AVAILABLE` to `RESERVED`;
   - order and contract baseline exists per README and DEV_SPEC.

2. A/B intake target mainline:
   - A-line is `SELF_SERVICE Application`, not direct order;
   - B-line remains `SALES_ASSISTED Application`;
   - both converge at application review before formal order;
   - legacy `/orders/review` and `POST /api/customer-orders` are documented as migration/compatibility artifacts.

3. Baseline seed hygiene:
   - default seed is limited to master data and clean vehicle pool;
   - workflow/demo data is excluded from default seed;
   - scenario seed isolation is defined.

4. Stage 7.6 reporting and CSV first version:
   - `/reports` page and report APIs are documented;
   - dashboard, order, finance, deposit pool, collection, vehicle asset reports are defined;
   - detail drilldown and CSV export rules are documented.

5. Stage 8 asset profitability and return trial:
   - asset profitability APIs and CSV exports are documented;
   - ROA/ROE trial remains business analysis, not formal accounting;
   - purchase price vs current sale price distinction is preserved.

6. Stage 8 capital structure and revenue-rights preview:
   - financing instruments, vehicle allocations, capital events, revenue rights, and revenue share preview are documented;
   - boundaries explicitly exclude real settlement, vouchers, and formal accounting.

7. Stage 8 residual market chain:
   - market sample import/manual entry;
   - residual curve generation;
   - single-vehicle forecast;
   - model run tracking;
   - residual sensitivity in asset return trial.

8. Stage 8.5 residual forecast to valuation review:
   - Stage 8.5 PR acceptance says manual acceptance passed;
   - quality gate passed with 524 API tests;
   - valuation review approval is documented as the only residual-chain action that updates `Vehicle.currentSalePriceAmount` and writes `VehicleSalePriceHistory`.

## 6. Partial Or Not Closed-Loop Capabilities

1. Stage 9 CI/CD:
   - no documented CI workflow file or latest CI run evidence in the audited docs.

2. Full production deployment:
   - current deployment docs are sufficient for early ECS/DB/local dev bootstrapping, but not full production Web/API deployment.

3. Backup, restore, and rollback:
   - listed as required but not documented as executable runbooks.

4. Production environment variables:
   - basic `.env` guidance exists, but no complete production matrix or validation checklist.

5. Production permission initialization:
   - permission seed and JWT refresh guidance exist, but production role matrix export/review is not documented as completed.

6. Full launch manual acceptance:
   - acceptance paths are scattered across README and stage docs;
   - no single Stage 9 sign-off checklist exists.

7. Current migration state:
   - docs contain conflicting evidence: older migration failure risk vs later Stage 8.5 pass record.

8. Stage 8.6A actual closure:
   - reporting docs define Stage 8.6A regression scope and conclusion criteria;
   - the audited docs do not prove that the full 8.6A manual regression script was executed end to end.

9. Formal accounting ROA/ROE and finance settlement:
   - deliberately out of scope in current docs; not a blocker for a back-office MVP if positioned as trial/preview, but not closed for finance-grade production reporting.

10. Delivery/return/billing scenario data:
   - scenario seed commands are proposed/documented as desired future acceptance support;
   - actual availability requires verification.

## 7. Optional Enhancements That Can Be Deferred

These should not block Stage 9 production-readiness work unless the business explicitly requires them for launch:

- Stage 8.5C valuation review statistics, batch reject, batch cancel, and batch approve preview.
- True AI/ML residual prediction, model training, Python pipelines, third-party model services.
- Crawlers, scheduled external data collection, third-party vehicle marketplace APIs.
- Excel `.xlsx` exports; current CSV export is sufficient for first launch if accepted.
- Formal accounting ROA/ROE, accounting vouchers, daily average equity capital, real financing repayment schedules.
- Real revenue-share settlement payments and finance posting.
- Customer-facing A-line app/miniprogram; current first-version flow can use back-office final-plan confirmation if accepted.
- Dedicated `VehicleStatusLog` table if existing audit/status logs are verified as sufficient for first launch.
- Advanced observability platform integration beyond basic health/log/smoke checks.

## 8. Candidate Next-Phase Directions

### Option A: Stage 9B Production Readiness Hardening

Focus:

- CI workflow;
- environment matrix;
- production deployment runbook;
- migration release checklist;
- backup/restore/rollback runbooks;
- production permission export;
- smoke tests and launch acceptance checklist.

Reason:

- Directly closes the Stage 9 blockers preventing production deployment.

### Option B: Stage 9C End-To-End Acceptance And Scenario Seeds

Focus:

- Implement or verify scenario seed scripts;
- build one acceptance checklist covering A/B intake, order, contract, delivery, billing, return, reports, residual valuation;
- record pass/fail evidence.

Reason:

- Converts scattered manual paths into repeatable release validation.

### Option C: Stage 8.6C/9 Data Consistency And Audit Verification

Focus:

- Verify write boundaries for residual forecasting, valuation review, reports, and CSV exports;
- verify audit logs for all critical mutations;
- verify read-only report/export paths do not write side effects.

Reason:

- Reduces high-impact production risks around vehicle valuation and financial reporting.

### Option D: Stage 8.5C Valuation Review Operations

Focus:

- valuation-review reporting;
- batch reject/cancel;
- batch approve preview with threshold guardrails.

Reason:

- Improves asset operations efficiency but should follow Stage 9 readiness unless urgently needed.

### Option E: Customer-Facing A-Line Productization

Focus:

- customer self-service UI;
- customer final-plan confirmation page;
- customer notification and signing experience.

Reason:

- Moves beyond internal back-office launch, but is not necessary for internal Stage 9 production readiness.

## 9. Recommended Next Phase

**Recommended focus: Option A, Stage 9B Production Readiness Hardening.**

Justification:

- Stage 9 is currently only partially closed.
- The biggest blockers are operational, not product-scope features.
- Additional Stage 8 feature work would increase deployment risk unless CI, migration, environment, backup/rollback, and acceptance evidence are first stabilized.
- A Stage 9B pass creates a reliable release boundary for all prior Stage 5.5-8.6A work.

Suggested Stage 9B deliverables:

1. CI workflow running the documented quality gates.
2. Production/staging environment variable matrix and validation checklist.
3. Fresh-environment provisioning runbook.
4. Final migration status and release migration procedure.
5. Backup, restore, and rollback runbooks.
6. Production permission matrix export and seed/re-login instructions.
7. Smoke-test checklist or automated smoke script.
8. One consolidated manual acceptance checklist.
9. Deployment docs upgraded from DB-only/dev bootstrap to Web/API production deployment.

## 10. Items Requiring Codex Code-Level Verification

### 10.1 API Verification

- `GET /api/health`
- login/auth/JWT cookie flow and token size
- `/api/vehicles/available` permission and filtering
- vehicle sale price initialization/review/history/status APIs
- `POST /api/self-service-applications`
- application review queue and detail review actions
- `GET /api/applications/:id/available-subscription-plans`
- `POST /api/applications/:id/quotes`
- `POST /api/quotes/:id/confirm`
- `POST /api/quotes/:id/cancel`
- `POST /api/orders/from-quote/:quoteId`
- order cancel, contract generation, sign/archive/cancel endpoints
- delivery and return endpoints
- billing, payment/write-off, deposit ledger, collection, entitlement APIs
- `/api/reports/*`
- `/api/reports/details/*`
- `/api/reports/asset-profitability/*`
- residual-market sample, curve, forecast, model-run APIs
- vehicle valuation review create/list/detail/approve/reject/cancel APIs.

### 10.2 Permission Verification

- `ADMIN` has all production permissions.
- Role grants for `SA`, `OP`, `AS`, `RC`, `FI`, `GM` match business responsibility.
- `vehicle:*` and `subscription_plan:*` are split and enforced correctly.
- `quote:create` can read active plans and available vehicles.
- `report:view`, `report:finance`, `report:asset`, `collection:view` protect reports and exports.
- residual permissions are enforced:
  - `residual_market:view/manage/import`
  - `residual_curve:view/generate/manage`
  - `residual_forecast:view/generate/manage`
  - `residual_model_run:view/manage`
  - `vehicle_valuation_review:view/create/approve`
- menu guards, button guards, and backend guards are consistent.
- seed updates require logout/login and no longer depend on oversized JWT permissions arrays.

### 10.3 Page Verification

- login page
- system management pages
- `/customers`
- `/applications`
- `/applications/:id`
- `/vehicles`
- vehicle detail sale price and residual forecast panels
- `/quotes`
- `/quotes/:id`
- `/orders`
- `/orders/[id]`
- `/contracts`
- `/contracts/[id]`
- `/contract-versions`
- delivery center
- return management
- billing center
- deposit pool
- collection center
- benefits center
- `/reports`
- `/reports/asset-profitability`
- `/residual-market`
- `/vehicle-valuation-reviews`

### 10.4 Migration And Seed Verification

- current `prisma migrate status`;
- no pending/untracked production migrations;
- final migration history matches target database;
- production migration process documented and tested;
- baseline seed idempotency;
- scenario seed availability and isolation;
- seed vehicles remain `AVAILABLE` and `EFFECTIVE`;
- seed does not create workflow acceptance records;
- production permission/menu seed can initialize roles without relying on local-only state.

### 10.5 CI/CD And Ops Verification

- CI workflow exists and runs on PR/main branch.
- CI executes lint, Prisma validate/generate, API/web typecheck, API tests, migration status, and smoke checks.
- production build commands are verified.
- deployment runbook can provision a fresh environment.
- environment variable inventory is complete.
- backup and restore are tested.
- rollback plan is executable.
- `/api/health` and smoke paths are monitored after deploy.
- deployment logs and failure signals are visible to operators.

## 11. Final Audit Position

Stage 9 should be treated as **not ready to close** until a Stage 9B pass produces concrete evidence for CI, deployment, migrations, env vars, permissions, backup/restore, rollback, and manual acceptance.

The prior business stages appear broad and advanced, especially Stage 8 residual valuation and reporting, but Stage 9 is a release-engineering closure phase. Its success should be measured by repeatability, evidence, and rollback safety rather than by adding more product capabilities.
