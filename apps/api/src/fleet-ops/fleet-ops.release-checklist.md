# Fleet Ops OS v1 Release Checklist

Use this checklist before promoting Fleet Ops OS v1 beyond local development.

## Scope

Fleet Ops OS v1 includes PR-1 through PR-10:

- PR-1 state engine
- PR-2 timeline engine
- PR-3 economics engine
- PR-4 risk / control engine
- PR-5 guarded execution engine
- PR-6 optimization advisory engine
- PR-7 governance policy proposal engine
- PR-8 coordination engine
- PR-9 module / facade / health / invariants
- PR-10 release readiness / observability / smoke diagnostics

PR-10 does not add a new intelligence layer and does not add a new execution path.

## Docs traceability

Confirm the Fleet Ops runtime docs remain linked to the repository-local source-of-truth docs:

- `docs/fleet-ops/source/plan_design.md`
- `docs/fleet-ops/source/code_review_202607011626.md`
- `docs/fleet-ops/next-stage/dev_spec.md`
- `docs/fleet-ops/next-stage/agents.md`
- `docs/fleet-ops/next-stage/codex_tasks.md`
- `docs/fleet-ops/README.md`

## Required Commands

Run typecheck:

```bash
pnpm --filter @subscription-saas/api typecheck
```

Run lint:

```bash
pnpm --filter @subscription-saas/api lint
```

Run the full Fleet Ops regression suite:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/vehicle-operational-state.spec.ts test/vehicle-timeline.spec.ts test/fleet-kpi.spec.ts test/fleet-risk.spec.ts test/fleet-execution.spec.ts test/fleet-optimization.spec.ts test/fleet-governance.spec.ts test/fleet-coordination.spec.ts test/fleet-ops.integration.spec.ts test/fleet-ops.invariants.spec.ts test/fleet-ops.readonly.spec.ts test/fleet-ops.bootstrap.spec.ts test/fleet-ops.facade-contract.spec.ts test/fleet-ops.health.spec.ts test/fleet-ops.observability.spec.ts
```

Run the read-only safety scan:

```bash
rg -n -g '*.ts' -g '*.tsx' '\.create\(|\.update\(|\.delete\(|\.upsert\(|\.createMany\(|\.updateMany\(|\.deleteMany\(|\$executeRaw|\$queryRawUnsafe|\$transaction|save\(|persist\(|mutate\(|setStatus\(|updateStatus\(|auditSink\??\.write\(|auditLog|writeAudit' apps/api/src/fleet-ops
```

Expected result: no matches. `rg` exit code `1` is acceptable for no matches.

Run the schema diff check:

```bash
git -c safe.directory=D:/Projects/auto-subscription-platform -C D:/Projects/auto-subscription-platform diff -- apps/api/prisma
```

Expected result: empty diff.

## Bootstrap Smoke Check

The release smoke suite must verify:

- `AppModule` compiles with `FleetOpsModule` mounted.
- `FleetOpsFacade` is injectable.
- `FleetOpsHealthService` is injectable.
- No provider constructor performs Prisma delegate calls during bootstrap.

## Known Baseline Issue

The broader API test script can expose this unrelated existing failure:

```text
test/order-delivery.spec.ts / canPrepareDelivery
```

This is not introduced by Fleet Ops PR-10. Do not modify order delivery behavior in the Fleet Ops release PR. Track or fix it separately.

## Readiness Expectations

- `FleetOpsHealthService` must return every engine status as `OK`, `WARN`, or `ERROR`.
- `FleetOpsFacade` must remain the stable external integration surface.
- PR-6, PR-7, and PR-8 outputs are advisory only.
- PR-5 execution remains guarded by PR-4 snapshots.
- Facade and health calls must not write audit logs.
- Optional dependencies must degrade safely and must not change core decision behavior.

## Rollback Strategy

- Remove `FleetOpsModule` from `AppModule` imports to disable subsystem loading.
- Keep PR-1 to PR-10 files available for investigation because they are read-only or advisory except guarded PR-5 execution.
- Re-run typecheck, lint, schema diff, and app bootstrap after rollback.

## Production Monitoring Expectations

- Track facade operation latency with `traceId`, `requestId`, `engineName`, and `operationName`.
- Surface health degradation per engine.
- Alert on read-only invariant failures.
- Alert if PR-6, PR-7, or PR-8 attempts to execute actions.
- Audit PR-5 execution logs only for explicit execution requests.
