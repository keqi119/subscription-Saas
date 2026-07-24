# Web Deployment Version Skew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent cached pre-deployment Web runtimes and HTML from breaking Field and Portal handover pages after a staging image replacement.

**Architecture:** Use the existing image tag as Next.js `deploymentId` at build time, then opt authenticated handover route shells out of the Full Route Cache. Keep immutable static assets unchanged and verify the contract in both source tests and a production build.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Docker Buildx, GitHub Actions.

## Global Constraints

- Do not add dependencies or change package manifests.
- Do not modify API, Prisma, PDF, eSign, Fadada, delivery, lease, billing, or payment behavior.
- The deployment ID must be non-empty and unique per image tag.
- Field and Portal handover HTML must be dynamically rendered.

---

### Task 1: Deployment Version Contract

**Files:**
- Create: `apps/web/test/deployment-versioning.spec.ts`
- Modify: `.github/workflows/docker-images.yml`
- Modify: `Dockerfile.web`
- Modify: `apps/web/next.config.ts`

**Interfaces:**
- Consumes: workflow input `imageTag`
- Produces: build-time `NEXT_DEPLOYMENT_ID` and Next.js `deploymentId`

- [ ] **Step 1: Write the failing test**

Assert that the workflow passes `NEXT_DEPLOYMENT_ID=${{ inputs.imageTag }}`,
the Dockerfile declares and validates the argument, and Next config exposes it
as `deploymentId`.

- [ ] **Step 2: Run test to verify it fails**

Run:
`pnpm --filter @subscription-saas/web exec vitest run test/deployment-versioning.spec.ts`

Expected: FAIL because none of the deployment ID wiring exists.

- [ ] **Step 3: Write minimal implementation**

Wire `imageTag` through the workflow and Docker build into:

```ts
deploymentId: process.env.NEXT_DEPLOYMENT_ID
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`pnpm --filter @subscription-saas/web exec vitest run test/deployment-versioning.spec.ts`

Expected: PASS.

### Task 2: Dynamic Handover Route Shells

**Files:**
- Create: `apps/web/src/app/field/handover/layout.tsx`
- Create: `apps/web/src/app/portal/handover-reviews/layout.tsx`
- Modify: `apps/web/test/deployment-versioning.spec.ts`

**Interfaces:**
- Consumes: React `children`
- Produces: dynamically rendered route segments

- [ ] **Step 1: Extend the test and verify it fails**

Assert both layout files export:

```ts
export const dynamic = "force-dynamic";
```

- [ ] **Step 2: Add the minimal layouts**

Each layout returns its children unchanged and exports `dynamic`.

- [ ] **Step 3: Run the focused test**

Run:
`pnpm --filter @subscription-saas/web exec vitest run test/deployment-versioning.spec.ts`

Expected: PASS.

### Task 3: Full Verification and Staging Release

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: verified branch commit and staging workflow
- Produces: deployed staging image and smoke evidence

- [ ] **Step 1: Run Web verification**

Run Web tests, typecheck, lint, and a production build with a synthetic
`NEXT_DEPLOYMENT_ID`.

- [ ] **Step 2: Inspect build output**

Confirm Field and Portal handover routes are dynamic and generated HTML/static
references include the deployment query parameter.

- [ ] **Step 3: Commit and push explicit files**

Commit only the files listed by this plan and push the fix branch.

- [ ] **Step 4: Build and deploy staging**

Use the repository's Docker Images workflow with the fix commit image tag and
the staging API base URL. Deploy only the staging Web/API image pair produced
by that workflow.

- [ ] **Step 5: Re-run safe smoke**

Verify health, cache headers, deployment-versioned assets, Field login/task
loading, and Portal page loading. Do not generate PDF, trigger eSign/Fadada, or
confirm delivery.
