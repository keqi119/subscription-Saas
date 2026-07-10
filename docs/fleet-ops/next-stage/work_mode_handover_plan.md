# Work Mode Handover Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the repository and the current ChatGPT Work checkout for a safe plan-build-review-verify workflow without changing product runtime behavior.

**Architecture:** Keep durable operating rules in root `AGENTS.md`, keep Fleet Ops-specific workflow rules under `docs/fleet-ops/next-stage`, and record the environment/provider-document readiness in one dated handover document. Dependency state is local and ignored; tracked changes remain documentation-only.

**Tech Stack:** Git, Markdown, Node.js workspace, Corepack, pnpm 11.4.0, NestJS, Next.js, Prisma, Vitest.

## Global Constraints

- Branch policy: `NEW_BRANCH_REQUIRED: yes`, `BASE_BRANCH: origin/main`, `EXPECTED_BRANCH: chore/work-mode-handover-prep`, `CONTINUE_EXISTING_BRANCH: yes`, `STACKED_PR_ALLOWED: no`, `PUSH_ALLOWED: no`.
- Baseline commit: `fb46ca97e08a768d9d7c5eb5dc5b6346fff924aa`.
- Do not modify application source, Prisma schema, migrations, runtime configuration, legal templates, or contract/e-sign behavior.
- Do not create a real `.env` file or import production credentials, PII, provider URLs, or tokens.
- Do not connect to a database, run migrations or seeds, call Fadada/WeChat/other providers, enable feature flags, deploy, push, create a PR, or merge.
- During Task 3, export an inert, intentionally unreachable loopback
  `DATABASE_URL` across the full ten-command suite to override any ambient real
  database URL. Prisma validate/generate and API commands that load Prisma
  configuration may read it; unrelated commands merely inherit it.
- The placeholder never authorizes a connection. `prisma generate` is
  non-connecting, but it writes the local generated client and artifacts under
  ignored dependency state.
- Modify and stage explicit approved paths only.
- Approved tracked paths:
  - `AGENTS.md`
  - `docs/fleet-ops/README.md`
  - `docs/fleet-ops/next-stage/codex_workflow_rules.md`
  - `docs/fleet-ops/next-stage/work_mode_handover.md`
  - `docs/fleet-ops/next-stage/work_mode_handover_plan.md`
- Preserve the July 1 source/review/planning documents as historical evidence; resolve their staleness through explicit source precedence rather than rewriting history.
- Treat the original local Fadada PDFs as mandatory evidence for Issue 4A-1F-E. Prior summaries are not substitutes.

---

### Task 1: Portable Work-Mode Governance

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/fleet-ops/next-stage/codex_workflow_rules.md`
- Modify: `docs/fleet-ops/README.md`
- Create: `docs/fleet-ops/next-stage/work_mode_handover.md`

**Interfaces:**
- Consumes: Git baseline, repository audit findings, existing Fleet Ops governance, current contract/e-sign boundaries.
- Produces: Path-independent source precedence, phase gates, approval boundaries, verification policy, and a dated readiness record for future Work threads.

- [ ] **Step 1: Record the pre-edit safety state**

Run:

```bash
git branch --show-current
git status --short --branch --untracked-files=all
git rev-parse HEAD
git rev-list --left-right --count HEAD...origin/main
```

Expected: branch `chore/work-mode-handover-prep`, clean tree except this plan, HEAD `fb46ca97...`, divergence `0 0` before the first commit.

- [ ] **Step 2: Make root agent guidance checkout-independent**

Update `AGENTS.md` so that future agents resolve the active checkout with `git rev-parse --show-toplevel`, distinguish current code/completion records from historical planning documents, and use database/provider preflights only when the task and environment explicitly authorize them.

Carry forward these non-negotiable rules:

```text
declare task phase and branch policy
clean-tree and approved-file gates
explicit-path staging only
no push / PR / merge / deploy by default
no real database or provider action without explicit authorization
Fleet Ops stays internal, permission-controlled, feature-flagged, and read-only at its public controller boundary
contract/e-sign legal text, credentials, PII, and provider semantics must never be invented
```

- [ ] **Step 3: Add the dated Work handover record**

Create `docs/fleet-ops/next-stage/work_mode_handover.md` with:

```text
repository identity and baseline SHA
current Fleet Ops P2 closeout and P3 deferral
current contract/e-sign Stage 1 PDF slot status
Work phase sequence: BASELINE -> PLAN -> BUILD -> REVIEW -> FIX -> VERIFY -> HANDOFF
user approval boundaries
local environment/tool version matrix
safe non-live verification commands
DB/provider commands that remain blocked
minimum Fadada PDF intake checklist for Issue 4A-1F-E
readiness verdict and next action
```

- [ ] **Step 4: Link the new policy without rewriting historical records**

Update `docs/fleet-ops/README.md` to link the handover record and plan. Update the compact preamble in `codex_workflow_rules.md` to resolve the active checkout rather than hard-coding `D:\Projects\auto-subscription-platform`.

- [ ] **Step 5: Check documentation scope and formatting**

Run:

```bash
git diff --name-status
git diff --stat
git diff --ignore-space-at-eol --stat
git diff --check
rg -n "D:\\\\Projects\\\\auto-subscription-platform|work_mode_handover|BASELINE -> PLAN" AGENTS.md docs/fleet-ops
```

Expected: only approved documentation paths changed; no broad EOL churn; the legacy Windows path may remain only when explicitly labeled as the local CLI path or historical evidence.

- [ ] **Step 6: Create the initial local governance commit**

Stage only the Task 1 documentation paths plus this implementation plan and commit:

```bash
git add AGENTS.md docs/fleet-ops/README.md docs/fleet-ops/next-stage/codex_workflow_rules.md docs/fleet-ops/next-stage/work_mode_handover.md docs/fleet-ops/next-stage/work_mode_handover_plan.md
git diff --cached --name-status
git diff --cached --check
git commit -m "docs(work-mode): add handover governance"
```

Expected: one docs-only local commit; no push.

### Task 2: Reproducible Dependency Setup

**Files:**
- No tracked files. Local ignored state only: `node_modules/` and Corepack cache under `/tmp`.

**Interfaces:**
- Consumes: `package.json`, `pnpm-lock.yaml`, CI workflow.
- Produces: An installed workspace using pinned pnpm 11.4.0 without lockfile changes.

- [ ] **Step 1: Resolve the pinned package manager in temporary cache**

Run:

```bash
COREPACK_HOME=/tmp/corepack-work-mode corepack pnpm --version
```

Expected: `11.4.0`.

- [ ] **Step 2: Install the frozen workspace**

Run:

```bash
COREPACK_HOME=/tmp/corepack-work-mode corepack pnpm install --frozen-lockfile
```

Expected: successful install with no `pnpm-lock.yaml` change.

- [ ] **Step 3: Prove installation did not pollute the tracked tree**

Run:

```bash
git status --short --branch --untracked-files=all
git diff -- pnpm-lock.yaml package.json apps/api/package.json apps/web/package.json packages/shared/package.json
```

Expected: no dependency manifest or lockfile diff.

### Task 3: Offline-Safe Baseline Verification

**Files:**
- No tracked files.

**Interfaces:**
- Consumes: installed workspace and current source tree.
- Produces: static/type/test evidence without a live database or provider call.

- [ ] **Step 1: Export an inert unreachable database URL across the suite**

Use this environment for every command in this task:

```bash
export DATABASE_URL='postgresql://placeholder:placeholder@127.0.0.1:1/placeholder?schema=public'
export COREPACK_HOME=/tmp/corepack-work-mode
```

The placeholder is intentionally exported for all ten Task 3 commands to
override any ambient real `DATABASE_URL`. Prisma validate/generate and API
commands that load Prisma configuration may read it; unrelated commands merely
inherit it. It does not authorize a database connection. `prisma generate` is
non-connecting, but it writes the generated client and artifacts into ignored
local dependency state.

- [ ] **Step 2: Validate generated and static contracts**

Run in order:

```bash
corepack pnpm vehicle-model:enum-freeze
corepack pnpm prisma:validate
corepack pnpm prisma:generate
corepack pnpm -r lint
corepack pnpm --filter @subscription-saas/api typecheck
corepack pnpm --filter @subscription-saas/web typecheck
```

Expected: every command exits `0`. Stop and report the first failure before broadening scope.

- [ ] **Step 3: Run focused Fleet Ops and workspace tests**

Run:

```bash
corepack pnpm --filter @subscription-saas/shared test
corepack pnpm --filter @subscription-saas/web test
corepack pnpm --filter @subscription-saas/api test:fleet-ops
corepack pnpm --filter @subscription-saas/api test
```

Expected: all selected test suites pass without database or provider network access. Do not substitute `pnpm --filter @subscription-saas/api test -- fleet-ops` for the canonical Fleet gate.

- [ ] **Step 4: Record blocked CI-equivalent checks honestly**

Do not run:

```text
pnpm quality:gate
pnpm release:check
pnpm prisma:migrate:status
pnpm prisma:migrate*
pnpm prisma:seed
pnpm seed:scenario*
any non-test fadada/wechat/smoke command
```

Record migration status as `NOT_RUN_ENVIRONMENT_BLOCKED`, because Docker, `psql`, `pg_isready`, a disposable database, and a test-only `.env` are absent.

### Task 4: Fadada Source-Document Intake Gate

**Files:**
- Modify: `docs/fleet-ops/next-stage/work_mode_handover.md`

**Interfaces:**
- Consumes: repository references and Library search result.
- Produces: A minimum original-document package that the user can supply without exposing credentials.

- [ ] **Step 1: Record the minimum original PDFs**

The handover record must require:

```text
3.7.3 API文档_合同签署_自动签署.pdf
4.2.7 扩展接口列表_签署_文档签署接口（含有效期和次数）.pdf
the exact 3.7.1 manual-sign PDF referenced by repository records
a recursive UTF-8 filename manifest for D:\Projects\document\fadada\doc
any separate PDF/example whose title contains 多位置, 关键字定位, 坐标定位, 批量自动签, 全自动签, extsign_auto, or extBatchSignAuto
```

- [ ] **Step 2: Preserve the provider-doc boundary**

Record that Issue 4A-1F-E remains `PLAN BLOCKED` until the originals are available. Do not decide multi-call vs multi-position behavior, keyword strategy, search index, coordinate units/direction, callback/retry semantics, or billing behavior from repository summaries.

- [ ] **Step 3: Record the already-verifiable code baseline**

Record the four canonical Stage 1 keywords, the two platform offset intents (`keyx=60`, `keyy=0`), current single-placement provider shape, lack of customer placement input, and the tests that protect current behavior.

- [ ] **Step 4: Record executed environment verification and commit the readiness result**

Update the handover record with the exact Task 2 and Task 3 command results, including failures or blocked checks, then run:

```bash
git add docs/fleet-ops/next-stage/work_mode_handover.md
git diff --cached --name-status
git diff --cached --check
git commit -m "docs(work-mode): record handover readiness"
```

Expected: one docs-only local commit; no push.

### Task 5: Independent Review, Final Verification, and Local Commit

**Files:**
- Review all approved tracked paths only.

**Interfaces:**
- Consumes: Tasks 1-4 results.
- Produces: Reviewer verdict, verification evidence, and docs-only local commits; no remote action.

- [ ] **Step 1: Dispatch an independent scope and correctness review**

The reviewer must check source precedence, current-state accuracy, unsafe command labeling, Fadada blockers, approved-file scope, and absence of runtime/schema/migration changes. The reviewer must not edit files.

- [ ] **Step 2: Apply only substantiated review fixes**

Fix blockers within the approved documentation paths, then repeat:

```bash
git diff --name-status
git diff --stat
git diff --ignore-space-at-eol --stat
git diff --check
```

- [ ] **Step 3: Run final safety scans**

Run:

```bash
git diff -- apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src apps/web/src packages/shared/src
git status --short --branch --untracked-files=all
```

Expected: no schema, migration, or runtime source diff.

- [ ] **Step 4: Commit only substantiated review fixes, if any**

If review fixes changed tracked files, run:

```bash
git add AGENTS.md docs/fleet-ops/README.md docs/fleet-ops/next-stage/codex_workflow_rules.md docs/fleet-ops/next-stage/work_mode_handover.md docs/fleet-ops/next-stage/work_mode_handover_plan.md
git diff --cached --name-status
git diff --cached --stat
git diff --cached --check
git commit -m "docs(work-mode): address handover review"
```

Expected: either a clean tree with no additional commit needed, or one docs-only review-fix commit. Do not push.

- [ ] **Step 5: Produce the handoff report**

Report:

```text
Verdict
branch, base SHA, HEAD SHA
changed files
dependency/runtime versions
commands and exact results
migration status = NOT_RUN_ENVIRONMENT_BLOCKED
Fadada source-document blocker
local commit SHA/message/diffstat
manual next step
```
