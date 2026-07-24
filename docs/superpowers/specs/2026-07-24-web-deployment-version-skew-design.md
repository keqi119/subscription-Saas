# Web Deployment Version Skew Design

## Problem

After a staging Web image replacement, previously visited Safari, WeChat, and
Edge sessions can reuse an immutable Turbopack runtime URL from the prior
deployment. That runtime requests chunks that no longer exist in the new
container, causing `ChunkLoadError` before the Field H5 application can start.

The current Web image build does not set a Next.js deployment ID. Field and
Portal handover routes are also fully prerendered and return a one-year shared
HTML cache lifetime.

## Design

Use the image tag as the build-time Next.js deployment ID:

- The Docker workflow passes `imageTag` as `NEXT_DEPLOYMENT_ID`.
- `Dockerfile.web` requires and exports that build argument before `next build`.
- `next.config.ts` maps `NEXT_DEPLOYMENT_ID` to `deploymentId`.

Next.js will append the deployment ID to static asset URLs and detect client /
server deployment mismatches. This is the primary version-skew protection.

Add server-component layouts with `dynamic = "force-dynamic"` for:

- `/field/handover/**`
- `/portal/handover-reviews/**`

These authenticated workflow shells must be rendered per request and return
non-cacheable HTML instead of a one-year prerender cache entry. Immutable
content-addressed static assets remain cacheable.

## Verification

- A source-level Web test proves the workflow, Dockerfile, Next config, and
  route layouts remain wired together.
- A production Web build with a synthetic deployment ID must emit `?dpl=` asset
  URLs and mark both handover routes dynamic.
- Existing Web tests, typecheck, lint, and build must pass.
- Staging headers must show deployment-versioned assets and non-cacheable Field
  and Portal handover HTML.
- A fresh automated browser must load Field login/tasks and Portal review
  routes without chunk errors.
- Real Safari, WeChat, and Edge validation remains an operator acceptance step.

## Safety

This change does not modify API behavior, Prisma schema, migrations, PDF,
eSign, Fadada, delivery confirmation, lease, billing, or payment logic.
