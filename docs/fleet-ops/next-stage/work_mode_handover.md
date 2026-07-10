# Work Mode Handover Record — 2026-07-10

## 1. Purpose And Scope

This record hands the repository to future ChatGPT Work threads without relying
on a machine-specific checkout path. It records the Git baseline, current Fleet
Ops and contract/e-sign boundaries, local tool readiness, approval gates, and
the checks that are safe without a live database or provider call.

This is a documentation and readiness record. It does not change runtime code,
schema, migrations, environment configuration, legal templates, feature flags,
database state, provider state, or deployed services.

## 2. Repository Identity And Baseline

| Field | Recorded value |
| --- | --- |
| Repository | `subscription-Saas` / `auto-subscription-platform` checkout |
| Origin | `https://github.com/keqi119/subscription-Saas.git` |
| Checkout discovery | `git rev-parse --show-toplevel` |
| Base | `origin/main` |
| Work branch | `chore/work-mode-handover-prep` |
| Baseline SHA | `fb46ca97e08a768d9d7c5eb5dc5b6346fff924aa` |
| Baseline subject | `feat(contracts): add stage1 signing slots to pdfs (#181)` |
| Baseline divergence | `HEAD...origin/main = 0 0` before the first handover commit |
| Pre-edit tree | No tracked changes; only the approved untracked `docs/fleet-ops/next-stage/work_mode_handover_plan.md` |
| Record date | 2026-07-10, Asia/Taipei |

Future threads must resolve the active checkout rather than reuse a recorded
absolute path:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
```

## 3. Source Precedence

Use the following order when evidence conflicts:

1. Explicit task scope and user approvals define which actions are authorized.
2. Current code, schema, tests, and configuration define implemented behavior.
3. The newest dated completion, closeout, or approval record defines verified
   delivery state.
4. Active specifications and governance documents define intended constraints.
5. Older plans, code reviews, prompts, and design documents are historical
   evidence. Preserve them, but do not treat them as proof of current behavior.

Do not silently reconcile conflicting evidence. Record the discrepancy, inspect
the relevant Git history, and request a decision when it affects scope or safety.
Legal text requires an approved legal source. Fadada behavior requires the
original provider documentation; repository summaries are not a substitute.

## 4. Current Fleet Ops State

The current completion record is
`docs/fleet-ops/runbooks/p2-production-closeout-20260705.md`.

- P2-H1 through P2-H5 are closed as `PASS_WITH_NOTES`.
- The recorded production smoke covered the pool/cohort overview, formal pool
  pages, anomaly drilldown, and the single-vehicle diagnostic path.
- No immediate runtime, UI/copy, or test hardening was required by that record.
- Passive observation and pasted raw numeric calibration evidence remain
  incomplete; new hardening must be opened from new evidence.
- P3 saved custom views remain deferred until operators explicitly demonstrate
  a need and separately approve write scope, ownership, audit, lifecycle, and
  permissions.

Fleet Ops invariants remain non-negotiable for current work:

- internal management access only;
- `fleet_ops:read` permission control;
- `FLEET_OPS_API_ENABLED` feature-flag control;
- GET-only public controller surface and no execution/write controls;
- no customer or public exposure.

## 5. Current Contract And E-Sign Stage 1 State

At the baseline SHA, the Stage 1 PDF render model defines four canonical slots:

| Slot | Keyword | Signer | Provider offset intent |
| --- | --- | --- | --- |
| Contract body customer | `合同正文-订阅方签字` | customer | none |
| Contract body platform | `合同正文-服务提供方盖章` | platform | `keyx=60`, `keyy=0` |
| Attachment 1 customer | `附件1订阅方案-订阅方签字` | customer | none |
| Attachment 1 platform | `附件1订阅方案-服务提供方盖章` | platform | `keyx=60`, `keyy=0` |

Current code creates these slots in the OrderService render model. The renderer
and artifact writer reject missing or duplicate slots before the source PDF is
stored. Current protection is covered by:

- `apps/api/test/order-contract.spec.ts`
- `apps/api/test/contract-pdf-renderer.spec.ts`
- `apps/api/test/contract-pdf-artifact-writer.spec.ts`

This slot contract is not proof that provider multi-position signing is ready:

- `AutoSealTaskInput` accepts one optional placement, not a slot collection.
- The Fadada client maps one keyword placement to one `sign_keyword`, with
  optional `keyword_strategy`, `search_index`, `keyx`, and `keyy`.
- platform auto seal resolves one `ESIGN_PLATFORM_SEAL_KEYWORD`; it does not
  propagate the four Stage 1 slots or both platform offsets from the render model.
- customer `extsign_validation.api` URL creation has no placement input.
- formal legal template activation, searchable-PDF review, provider mapping,
  sandbox double-sign, and signed-archive evidence remain separate gates.

Do not invent legal text, signature placement behavior, provider parameters,
credentials, customer PII, seal IDs, callback rules, or retry/billing semantics.

## 6. Work Phase Sequence

Every future task must declare its current phase and branch policy before writes:

`BASELINE -> PLAN -> BUILD -> REVIEW -> FIX -> VERIFY -> HANDOFF`

| Phase | Required outcome |
| --- | --- |
| `BASELINE` | Resolve checkout; record branch, status, HEAD, divergence, approved paths, and environment limits. |
| `PLAN` | Read current sources and historical evidence; define scope, invariants, approval needs, and checks. No implementation writes. |
| `BUILD` | Modify only approved paths on the expected branch; keep runtime, schema, provider, and data boundaries intact. |
| `REVIEW` | Independently inspect source precedence, current-state accuracy, scope, safety labels, and diff quality. |
| `FIX` | Apply only substantiated review fixes within the approved paths. |
| `VERIFY` | Run the task-specific checks plus Git scope, EOL, whitespace, and unsafe-command scans. |
| `HANDOFF` | Stage explicit paths, make only an authorized local commit, record results and blockers, and leave remote actions undone. |

Required branch policy fields are `BASE_BRANCH`, `EXPECTED_BRANCH`,
`NEW_BRANCH_REQUIRED`, `CONTINUE_EXISTING_BRANCH`, `STACKED_PR_ALLOWED`, and
`PUSH_ALLOWED`.

## 7. User Approval Boundaries

| Action | Minimum authority and precondition |
| --- | --- |
| Read-only repository inspection | Allowed within the assigned task. |
| File edits or local commit | Task must approve the paths and requested write/commit scope. Stage explicit paths only. |
| Dependency or generated-state writes | Task must explicitly authorize them; preserve manifests and lockfile unless separately approved. |
| Parse-only Prisma validate/generate | Task must authorize it; use an unreachable placeholder URL, no real `.env`, and no real credentials. |
| Any real database read | Explicit user authorization for the named command and independently verified target. |
| Any database mutation, migration, seed, or backfill apply | Explicit user authorization, verified disposable/approved target, backup and rollback requirements appropriate to the environment. |
| Any real provider or smoke call | Explicit user authorization for that run, approved sanitized inputs, original provider docs, and a named environment. |
| Feature-flag change, access sync, deployment, push, PR, or merge | Explicit user authorization for the specific external action. None is implied by build or local-commit work. |
| Legal text or provider semantic decision | Approved legal original or original provider documentation; never inference from a summary. |

The presence of a database URL, credential, token, provider endpoint, or feature
flag in the shell never grants permission to use it.

## 8. Local Environment And Tool Matrix

Snapshot recorded on 2026-07-10 before dependency setup:

| Component | Work checkout | Declared or reference baseline | Readiness note |
| --- | --- | --- | --- |
| Host | Linux `6.12.47`, x86_64 | CI uses Ubuntu | Available |
| Node.js | `v24.14.0` | `>=20.9.0`; CI uses Node 22 | Engine-compatible, but not CI-parity |
| npm | `11.9.0` | Not the workspace package manager | Available, not selected |
| pnpm | `11.7.0` | `packageManager: pnpm@11.4.0`; CI uses 11.4.0 | Version mismatch; use pinned Corepack pnpm for follow-up |
| Corepack | `0.34.6` | Used to resolve pnpm 11.4.0 | Available |
| Git | `2.51.1` | Required | Available |
| Workspace dependencies | root `node_modules/` absent | Frozen lockfile install required | Not installed; no build/test claim |
| Docker / Compose | Not installed | Needed for the documented local service path | Environment blocker |
| `psql` / `pg_isready` | Not installed | Useful for independent DB target checks | Environment blocker |
| PostgreSQL | No local target | CI: 16; Compose: 17; deployment guide: 16 | Target/version must be selected before DB checks |
| Redis | No local target | Compose: 8; deployment guide: 7-compatible | Not needed for docs-only handover; version drift remains |
| Root `.env` | Absent | Test-only configuration required for runtime/DB work | No environment imported |
| DB/provider/Fleet Ops variables | Relevant variables unset in this shell | Real values must remain outside Git | No authorization and no target |

## 9. Safe Non-Live Verification

These commands are the planned non-live gate after dependency setup is
explicitly authorized and completed with pnpm 11.4.0. They were not executed by
this docs-only handover task; their exact Task 2/Task 3 results are
`PENDING_OFFLINE_GATE` and must be replaced by Task 4. Run them without a real `.env` or credentials and
with outbound provider access disabled. The loopback URL is deliberately
unreachable and is for Prisma configuration parsing only:

```bash
export COREPACK_HOME=/tmp/corepack-work-mode
export DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:1/placeholder?schema=public'

corepack pnpm vehicle-model:enum-freeze
corepack pnpm prisma:validate
corepack pnpm prisma:generate
corepack pnpm -r lint
corepack pnpm --filter @subscription-saas/api typecheck
corepack pnpm --filter @subscription-saas/web typecheck
corepack pnpm --filter @subscription-saas/shared test
corepack pnpm --filter @subscription-saas/web test
corepack pnpm --filter @subscription-saas/api test:fleet-ops
corepack pnpm --filter @subscription-saas/api test
```

Stop on the first unexpected connection attempt or failure. Do not substitute
the aggregate `quality:gate` or `release:check`, because their current definitions
include database-backed checks.

Documentation-only changes use this repository safety gate:

```bash
git diff --name-status
git diff --stat
git diff --ignore-space-at-eol --stat
git diff --check
```

## 10. Commands That Remain Blocked

Until a later task supplies explicit authorization and a verified target, status
for migration and live integration checks is `NOT_RUN_ENVIRONMENT_BLOCKED`.

Do not run the following in this handover flow:

- database reads such as `pnpm prisma:migrate:status`, constraint-readiness
  scripts, or database-backed backfill dry-runs;
- database mutations such as `pnpm prisma:migrate`,
  `pnpm prisma:migrate:deploy`, `pnpm prisma:seed`, scenario seeds, access sync,
  or any backfill `--apply` command;
- `pnpm quality:gate` or `pnpm release:check` while they include DB-backed steps;
- `prisma migrate reset`, `prisma db push`, or destructive recovery commands;
- non-test Fadada, WeChat, upload, portal, API, or production smoke commands;
- Fleet Ops live curl checks, access sync, or `FLEET_OPS_API_ENABLED` changes;
- image build/pull/push, deployment, push, PR creation, or merge.

Do not copy production credentials or a real database URL into Work mode to
remove this blocker. Use a separately approved disposable/test environment.

## 11. Fadada Intake Gate For Issue 4A-1F-E

Issue 4A-1F-E is `PLAN BLOCKED` until original provider documents are available.
The minimum intake package is:

- `3.7.3 API文档_合同签署_自动签署.pdf`;
- `4.2.7 扩展接口列表_签署_文档签署接口（含有效期和次数）.pdf`;
- the exact `3.7.1` manual-sign PDF referenced in
  `docs/stage-10d-fadada-production-upload-signurl-smoke.md`;
- a recursive UTF-8 filename manifest for the historical Windows source
  directory `D:\Projects\document\fadada\doc`, so abbreviated repository
  references can be matched to exact basenames;
- every separate PDF or example whose title contains `多位置`, `关键字定位`,
  `坐标定位`, `批量自动签`, `全自动签`, `extsign_auto`, or
  `extBatchSignAuto`.

The intake must contain documentation only: no credentials, tokens, live URLs,
customer PII, provider customer IDs, signature IDs, PDF contracts, or raw
provider responses.

Until those originals are reviewed, do not decide:

- one multi-position request versus multiple idempotent requests;
- whether customer manual signing can pre-map both customer slots;
- `keyword_strategy` and `search_index` meaning or valid combinations;
- `keyx` / `keyy` units, axes, direction, or repeated-keyword behavior;
- whether repeated calls append, replace, conflict, or create additional fees;
- transaction ID, callback, retry, authorization, and billing semantics;
- whether batch or all-auto APIs are required.

Repository summaries may guide document discovery, but they cannot clear this
gate or authorize a provider call.

## 12. Readiness Verdict And Next Action

| Area | Verdict |
| --- | --- |
| Portable docs-only governance | `READY` after the Task 1 local commit and verification |
| Runtime behavior | `UNCHANGED` by this handover |
| Dependency-backed static/type/test baseline | `PENDING_OFFLINE_GATE`; dependencies are absent and Task 4 must record exact Task 2/Task 3 results |
| Migration/database verification | `NOT_RUN_ENVIRONMENT_BLOCKED` |
| Real provider verification | `NOT_RUN_APPROVAL_AND_ENVIRONMENT_BLOCKED` |
| Fleet Ops P2 | `PASS_WITH_NOTES`; controlled internal read-only use, with P3 deferred |
| Issue 4A-1F-E | `PLAN BLOCKED` pending the original Fadada intake package |

Next action: with explicit task authorization, resolve pnpm 11.4.0 in the
temporary Corepack cache, install the frozen workspace without manifest or
lockfile changes, and run the non-live verification gate above. In parallel, the
user may supply the sanitized Fadada documentation intake package. Do not begin
database-backed or provider work as part of either next step.
