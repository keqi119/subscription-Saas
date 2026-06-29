# Stage 10D-B5-D Fadada Post-Merge Mainline API Promotion

> Scope: normalize production API runtime from the PR #123 candidate image to a mainline image built from the merge commit.

## Summary

Stage 10D-B5-D was executed after PR #123 was merged. The production API was promoted from the PR candidate image to a mainline image built from the `main` merge commit.

This stage did not execute any signing workflow or Fadada business API.

## Source And Image

| Field | Result |
| --- | --- |
| PR #123 merged | yes |
| main source commit | `48dc98d06706fb97e91d44da9a2c23b812db3dee` |
| main source commit short | `48dc98d` |
| mainline API image | `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d` |
| image digest | `sha256:75c596de855a512ccbc7c61404a331267c076253fd0f552234f931e51af16dd1` |
| source includes B5-C closeout | yes, `321e2bb` |
| source includes H1 invalid-digest hardening | yes, `df4d33d` |

## Quality Gate

Local quality checks were run before image promotion using isolated local PostgreSQL:

```text
pnpm release:check: passed
pnpm -r lint: passed
pnpm prisma:validate: passed
pnpm prisma:generate: passed
API typecheck: passed
API tests: 61 files / 838 tests passed
quality database: 127.0.0.1:55432/subscription_saas
production seed executed: no
```

The exact Windows command form `pnpm --filter @subscription-saas/api exec tsc --noEmit -p tsconfig.json` could not resolve `tsc` from the API package bin scope because TypeScript is declared at the workspace root. Equivalent API typecheck coverage passed via the package `typecheck` script and a direct root `tsc.CMD --noEmit -p apps/api/tsconfig.json` invocation.

## Production Deployment

| Field | Result |
| --- | --- |
| deployment approved | yes |
| deployment executed | yes |
| previous API image | `ghcr.io/keqi119/subscription-api:fadada-pr123-envb-20260628-e4bf959` |
| previous API image id | `sha256:60ab5d638d13f4cf1cb35485093917feb8dbac1856478feea18ae6ef14cd682f` |
| new API image | `ghcr.io/keqi119/subscription-api:fadada-main-20260629-48dc98d` |
| new API image id | `sha256:20ac606ff7bf1504d4e8a9b9ee0748c7bb924cbf1adde43e53fb63b9389021bf` |
| new image digest | `sha256:75c596de855a512ccbc7c61404a331267c076253fd0f552234f931e51af16dd1` |
| pre-check backup dir | `/opt/subscription-saas/deploy-backups/fadada-main-promotion-20260629111952` |
| deployment backup dir | `/opt/subscription-saas/deploy-backups/fadada-main-promotion-deploy-20260629112624` |
| API container recreated | yes |
| Web container unchanged | yes |
| Postgres container unchanged | yes |
| rollback executed | no |
| rollback image if needed | `ghcr.io/keqi119/subscription-api:fadada-pr123-envb-20260628-e4bf959` |

## Runtime Verification

| Check | Result |
| --- | --- |
| API container status | running |
| API container health | healthy |
| public health endpoint | HTTP 200, `status=ok`, `storage=oss` |
| logs after restart | Nest startup completed and PostgreSQL connected |
| `ESIGN_PROVIDER` | `fadada` |
| `FADADA_ENV` | `production` |
| `FADADA_BASE_URL` | `https://textapi.fadada.com/api2/` |
| `FADADA_ENABLED` | `true` |
| `FADADA_FULL_SIGNING_SMOKE` | `0` |
| `FADADA_AUTO_SIGN_ENABLED` | `false` |
| `FADADA_APP_ID` | present |
| `FADADA_APP_SECRET` | present |
| test override env | present but inactive because `FADADA_FULL_SIGNING_SMOKE=0` |

No app secret, full customer id, full local customer id, PII, sign URL, provider raw response, storage object key, or PDF binary was printed or committed.

## Callback Readiness Probe

Invalid digest probe:

```text
POST /api/esign/callback/fadada
HTTP 201
{"handled":false,"reason":"UNVERIFIED"}
```

The endpoint did not return 404 or 500, and the invalid callback was rejected before business advancement.

## Production DB Readiness

Read-only migration status:

```text
Datasource: subscription_saas_prod
54 migrations found in prisma/migrations
Database schema is up to date
```

The running API image contains 54 migration directories, and production `_prisma_migrations` has 54 finished rows.

Customer mapping spot check:

```text
local customer count: 1
mobile mask: 186****0212
mobile-mask match count: 1
same customer: yes
provider customer id: present
```

No full mobile, full local customer id, or full provider customer id was recorded.

## Actions Not Executed

- no `uploaddocs.api` call;
- no `extsign_validation.api` call;
- no `extsign_auto.api` call;
- no sign URL generation or opening;
- no signing;
- no `ContractESignTask` creation;
- no Contract or Order advancement;
- no signed PDF download or archive;
- no PaymentRecord or PaymentWriteOff creation;
- no ReceivableBill mutation;
- no production seed;
- no production migration deploy;
- no Prisma DB push or migrate reset;
- no Web deployment.

## Final Decision

Stage 10D-B5-D passed.

Production API runtime is normalized to a mainline image built from the PR #123 merge commit.

Broad Fadada production rollout remains gated by the next customer-provider account binding and real-name mapping stages.
