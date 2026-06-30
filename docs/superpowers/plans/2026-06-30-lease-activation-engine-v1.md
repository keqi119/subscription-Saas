# Lease Activation Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimal lease activation decision engine, persistence model, and API endpoints for deciding whether a subscription order can start its lease.

**Architecture:** Add minimal Prisma `Lease` and `VehicleInspection` persistence because the current system has order delivery but no order-level lease/inspection record. Implement a focused Nest service named `LeaseActivationEngine` that reads existing order, current contract, receivable bills, delivery, and inspection state, and writes only a `Lease` record during activation.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Vitest, existing RBAC guards and audit service.

---

### Task 1: Schema And Migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260630143000_lease_activation_engine/migration.sql`

- [ ] Add enum `LeaseStatus` with `NOT_ACTIVE`, `READY`, `ACTIVE`.
- [ ] Add enum `VehicleInspectionStatus` with `PENDING`, `PASSED`, `FAILED`.
- [ ] Add model `Lease` with `id`, unique `orderId`, `status`, `activatedAt`, timestamps, and relation to `SubscriptionOrder`.
- [ ] Add model `VehicleInspection` with `id`, unique `orderId`, `status`, `inspectedAt`, timestamps, soft-delete, and relation to `SubscriptionOrder`.
- [ ] Add `lease` and `vehicleInspection` relations to `SubscriptionOrder`.
- [ ] Run `pnpm prisma:validate` and `pnpm prisma:generate`.

### Task 2: Failing Engine Tests

**Files:**
- Create: `apps/api/test/lease-activation.spec.ts`

- [ ] Write tests for these six required rules before production code exists:
  - unsigned contract blocks activation
  - incomplete deposit or first-rent payment blocks activation
  - undelivered order blocks activation
  - non-passed inspection blocks activation
  - all requirements satisfied returns `canActivate: true`
  - `activate` persists/returns an `ACTIVE` lease
- [ ] Run `pnpm --filter @subscription-saas/api exec vitest run test/lease-activation.spec.ts` and confirm the failure is caused by the missing module/service.

### Task 3: Engine And API

**Files:**
- Create: `apps/api/src/lease/lease-activation.types.ts`
- Create: `apps/api/src/lease/lease-activation.engine.ts`
- Create: `apps/api/src/lease/lease.controller.ts`
- Create: `apps/api/src/lease/lease.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] Implement `LeaseActivationResult`.
- [ ] Implement `LeaseActivationEngine.evaluate(orderId)`.
- [ ] Implement `LeaseActivationEngine.canActivate(orderId)`.
- [ ] Implement `LeaseActivationEngine.activate(orderId, user?, context?)`.
- [ ] Add `GET /lease/activation/check/:orderId`, `POST /lease/activation/activate/:orderId`, and `GET /lease/:orderId/status`.
- [ ] Protect read endpoints with `ORDER_VIEW` and activation with `ORDER_UPDATE`.
- [ ] Write an audit log on activation only.

### Task 4: Verification And Commit

**Files:**
- All changed files from Tasks 1-3

- [ ] Run targeted test: `pnpm --filter @subscription-saas/api exec vitest run test/lease-activation.spec.ts`.
- [ ] Run API typecheck: `pnpm --filter @subscription-saas/api typecheck`.
- [ ] Run Prisma checks: `pnpm prisma:validate`, `pnpm --filter @subscription-saas/api exec prisma migrate status --schema prisma/schema.prisma`.
- [ ] Run API tests if targeted checks pass: `pnpm --filter @subscription-saas/api test`.
- [ ] Commit with message `feat: add lease activation engine`.
