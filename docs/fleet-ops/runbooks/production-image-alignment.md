# Fleet Ops Production Image Alignment Runbook

## Purpose And Scope

Use this runbook to align production API and Web images to the approved main commit before any Fleet Ops production enablement.

This runbook is limited to Fleet Ops production image alignment. It is docs/checklist-only and does not enable production by itself.

This runbook does not allow Codex to:

- Build Docker images.
- Push images to GHCR.
- Pull production images.
- Deploy or restart production services.
- Run live DB sync.
- Query the production DB.
- Change `FLEET_OPS_API_ENABLED`.
- Change runtime behavior, API behavior, UI behavior, permissions, seed behavior, sync behavior, schema, migrations, package scripts, CI, Dockerfiles, or compose files.

Fleet Ops production access sync, feature flag enablement, production smoke after enablement, and rollback execution remain human/operator-controlled actions.

## Current Production Image Capture

Current production API:

| Field | Value |
| --- | --- |
| Container id | `20ac606ff7bf` |
| Container | `subauto-production-api-1` |
| Image | `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d` |
| Created | `2026-06-29 11:15:21` |

Current production Web:

| Field | Value |
| --- | --- |
| Container id | `35c54abd0b76` |
| Container | `subauto-production-web-1` |
| Image | `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85` |
| Created | `2026-06-20 14:55:42` |

Current DB/cache images:

| Service | Image |
| --- | --- |
| Postgres | `postgres:17-alpine` |
| Redis | `redis:8-alpine` |

Assessment:

- API and Web are not aligned.
- API and Web are from different dates and commit families.
- Current images cannot be assumed to contain the latest Fleet Ops production decision changes.
- Do not enable Fleet Ops on this image pair.

## Target Commit And Image Tags

Current P1-H18 target:

| Field | Value |
| --- | --- |
| Target commit SHA | `67a9f6b36fc87312c58a46c2634b68246ef63887` |
| Short SHA | `67a9f6b` |
| Target API image | `ghcr.io/keqi119/subscription-api:prod-20260704-67a9f6b` |
| Target Web image | `ghcr.io/keqi119/subscription-web:prod-20260704-67a9f6b` |

If the images are built on another date, keep the same short SHA and use:

```text
ghcr.io/keqi119/subscription-api:prod-<build-date>-67a9f6b
ghcr.io/keqi119/subscription-web:prod-<build-date>-67a9f6b
```

Rules:

- API and Web must be built from the same target commit family.
- Do not deploy only API or only Web for this alignment.
- Do not use `latest`.
- Record immutable image digests after publish.

## Build And Publish Guidance

Human operators may use the manual GitHub Actions image workflow:

```text
.github/workflows/docker-images.yml
```

Expected manual workflow dispatch parameters for this plan:

| Input | Value |
| --- | --- |
| `registry` | `ghcr.io` |
| `namespace` | `keqi119` |
| `imageTag` | `prod-20260704-67a9f6b` |
| `apiBaseUrl` | `https://api.subauto.keybox.cloud/api` |
| `environment` | `production` |

Operator requirements:

- Codex must not trigger this workflow.
- A human operator triggers the workflow and verifies image availability.
- The Web image must be built with the production API base URL.
- Record both API and Web image digests after publish.
- Do not proceed unless both API and Web images are available.

## Deployment Alignment Flow

Manual operator flow:

1. Confirm the target commit is `67a9f6b36fc87312c58a46c2634b68246ef63887`.
2. Confirm the target API and Web image tags and digests.
3. Capture the current rollback API and Web images.
4. Confirm `FLEET_OPS_API_ENABLED=false` or absent/disabled behavior before image rollout.
5. Pull the target API and Web images.
6. Run migration/preflight checks using the existing production deployment process.
7. Back up the production DB before migration deploy if pending migrations exist.
8. Apply migrations only by authorized human/operator action if needed.
9. Update API and Web images together.
10. Restart or redeploy API/Web as required by the production deployment path.
11. Keep Fleet Ops disabled.
12. Perform the post-alignment smoke checklist below.

Image alignment is not Fleet Ops enablement. Do not run access sync or set `FLEET_OPS_API_ENABLED=true` in this flow.

## Migration And Preflight

P1-H18 PLAN found that `48dc98d..origin/main` adds 4 Prisma migrations and modifies `apps/api/prisma/schema.prisma`.

Migration/preflight is required before image rollout. Production DB pending migration status requires human/operator confirmation.

Operator guidance uses existing commands only:

```bash
pnpm --filter @subscription-saas/api prisma:migrate:status
pnpm --filter @subscription-saas/api prisma:migrate:deploy
```

Rules:

- Codex must not run these commands against production.
- Back up the production DB before migration deploy.
- If migrations are applied, rollback compatibility requires DB owner review.
- This runbook does not change schema or migration files.

## Feature Flag And Access Sync Guardrails

During image alignment:

- `FLEET_OPS_API_ENABLED` must remain false.
- Do not run Fleet Ops access sync:

```bash
pnpm --filter @subscription-saas/api prisma:sync:fleet-ops-access
```

- Access sync belongs to the later Fleet Ops enablement step.
- Setting `FLEET_OPS_API_ENABLED=true` belongs to the later Fleet Ops enablement step.
- Permission/menu entries may already exist, but the API must remain disabled during image alignment.

## DB And Redis Policy

Keep DB/cache images unchanged:

| Service | Required policy |
| --- | --- |
| Postgres | Keep `postgres:17-alpine` |
| Redis | Keep `redis:8-alpine` |

Do not change DB/cache images as part of Fleet Ops image alignment unless a separate platform runbook requires it.

## Rollback

Rollback image pair:

| Service | Image |
| --- | --- |
| API | `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d` |
| Web | `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85` |

Rollback rules:

- Keep `FLEET_OPS_API_ENABLED=false` during rollback.
- Restore previous API/Web image tags if application smoke fails.
- If migrations were applied, rollback requires DB owner decision and backup/restore review.
- DB/cache image rollback is not part of this runbook.

## Post-Alignment Smoke Checklist

Run these checks after API/Web image alignment and before Fleet Ops feature enablement:

| Check | Expected |
| --- | --- |
| API image | Container runs the target API image tag/digest. |
| Web image | Container runs the target Web image tag/digest. |
| API/Web SHA | Target short SHA matches for API and Web. |
| Feature flag | `FLEET_OPS_API_ENABLED=false`. |
| API health | Existing API health check passes. |
| Web login | Production Web login works. |
| `/auth/me` | Authenticated identity, permissions, and menus load normally. |
| Core page smoke | Existing non-Fleet core page smoke passes. |
| `/fleet-ops` with flag false | Permitted users see disabled state; business panels do not silently load. |
| Permission boundary | No permission bypass. |
| Read-only boundary | No execution/write controls. |
| Public exposure | No customer/public Fleet Ops exposure. |

Do not continue to Fleet Ops enablement until post-alignment smoke is recorded.

## Evidence Capture

| Field | Value |
| --- | --- |
| Operator |  |
| Date/time |  |
| Target commit | `67a9f6b36fc87312c58a46c2634b68246ef63887` |
| API image tag |  |
| API image digest |  |
| Web image tag |  |
| Web image digest |  |
| Rollback API image | `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d` |
| Rollback Web image | `ghcr.io/keqi119/subscription-web:portal-rc-r3-20260620-1355c85` |
| Migration status |  |
| DB backup reference |  |
| Feature flag value | `FLEET_OPS_API_ENABLED=false` |
| Smoke results |  |
| Notes |  |

Do not record plaintext DSNs, passwords, tokens, cookies, registry credentials, or full customer-sensitive payloads.
