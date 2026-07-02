# Fleet Ops OS v1 Production Integration Contract

Fleet Ops is a production subsystem boundary that exposes PR-1 to PR-8 through `FleetOpsModule` and `FleetOpsFacade`.

## Source of Truth

Fleet Ops implementation and hardening work must stay traceable to these repository-local documents:

- `docs/fleet-ops/source/plan_design.md`
- `docs/fleet-ops/source/code_review_202607011626.md`
- `docs/fleet-ops/next-stage/dev_spec.md`
- `docs/fleet-ops/next-stage/agents.md`
- `docs/fleet-ops/next-stage/codex_tasks.md`
- `docs/fleet-ops/README.md`

## Layer Responsibilities

- PR-1 State Engine: resolves the current vehicle operational state from existing read entities.
- PR-2 Timeline Engine: reconstructs daily historical vehicle state over a requested date range.
- PR-3 Economic Engine: converts state, timeline, payments, depreciation, and service data into vehicle and fleet KPI outputs.
- PR-4 Risk / Control Engine: evaluates operational risk, financial exposure, collection priority, and control decisions.
- PR-5 Execution Engine: executes only PR-4 approved actions through guarded handlers and audit-oriented execution logs.
- PR-6 Optimization Engine: generates advisory optimization recommendations and never executes actions.
- PR-7 Governance Engine: proposes policy changes after simulation and never overrides live PR-4 control decisions.
- PR-8 Coordination Engine: coordinates agent outputs, resolves conflicts, and returns unified advisory responses.
- PR-9 Production Contract: provides module registration, facade methods, health status, invariant checks, read-only safety rules, and documentation.

## Allowed Dependencies

Dependency direction is one way:

- PR-8 consumes PR-1 to PR-7 outputs.
- PR-7 consumes PR-1 to PR-6 outputs.
- PR-6 consumes PR-1 to PR-5 outputs.
- PR-5 consumes PR-4 decisions for guarded execution.
- PR-4 consumes PR-1 to PR-3 outputs plus core read data.
- PR-3 consumes PR-1 and PR-2 outputs plus finance read data.
- PR-2 consumes historical read data.
- PR-1 consumes current read data.

PR-9 may depend on all layers only to expose a stable subsystem boundary.

## Forbidden Dependencies

- PR-1 to PR-4 must not depend on PR-5 execution.
- PR-6 must not call PR-5 execution.
- PR-7 must not override PR-4 decisions.
- PR-8 must not execute actions.
- No layer may introduce a reverse dependency back into a higher-numbered layer.

## Execution Boundary

PR-5 is the only controlled side-effect layer. It must require a PR-4 risk snapshot, pass through `execution-gateway.guard.ts`, route through registered handlers, and create traceable execution logs. PR-9 does not expose a direct execution facade method.

Execution logging may use an existing audit sink only during an explicit PR-5 execution request. Facade, health, PR-6, PR-7, and PR-8 calls must not trigger audit writes.

## Control Boundary

PR-4 remains the live control authority for `ALLOW`, `WARN`, and `BLOCK`. PR-6 recommendations, PR-7 policy proposals, and PR-8 coordination outputs are advisory and must not bypass PR-4 or PR-5.

## Read-Only Guarantees

PR-1, PR-2, PR-3, PR-4, PR-6, PR-7, PR-8, and PR-9 are read-only or advisory surfaces. Fleet Ops read modules must not use Prisma write calls, raw execution calls, or unsafe raw queries. PR-5 may prepare controlled action side effects through handlers, but it must not mutate upstream PR outputs.

Optional dependencies must degrade safely and must not change core decision behavior. They are allowed only for integration adapters such as audit sinks or default orchestrator wiring, not for hiding required PR-4 control inputs.

## Auditability Expectations

- Facade calls should be reproducible for the same input data and date range.
- Coordination outputs must include agent contributions, conflict maps, confidence, and unresolved conflicts.
- Execution logs must trace the PR-4 decision snapshot used by PR-5.
- Governance proposals must include simulation output before adoption.
- Invariant and read-only safety tests must run as production readiness checks before promotion.

## End-to-End Contract Smoke Gate

P1-H6 readiness is test and documentation only. It does not add runtime behavior, schema changes, controllers, execution paths, or PR-1 to PR-5 logic changes.

The focused smoke gate verifies `state -> timeline -> economics -> risk -> convergence snapshot` using mocked services and pure fixtures. It must preserve evidence, warnings, confidence, cashflow, deposit exclusion details, overdue exposure, D1-D5 aging bucket, arrears pipeline, and consistency diagnostics in `FleetOpsSnapshot`.

Run the focused P1-H6 suite before release promotion:

```bash
pnpm --filter @subscription-saas/api exec vitest run test/fleet-ops.e2e-contract.spec.ts test/fleet-ops.smoke.spec.ts test/fleet-ops.facade.spec.ts test/fleet-ops.snapshot.spec.ts test/fleet-ops.convergence-parity.spec.ts test/fleet-ops.readonly.spec.ts test/fleet-ops.boundary.spec.ts test/fleet-ops.no-schema.spec.ts
```

Codex may perform local commits only when explicitly requested. Push, PR creation, merge, and release promotion remain human-owned remote actions.
