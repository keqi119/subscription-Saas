# Stage 9F-F Production Cutover Execution Report

This report records the completed Stage 9F-F production cutover execution. The
earlier blocked attempt remains part of the audit trail: the old
`ghcr.io/keqi119/subscription-web:d3cdc5e` image was rejected for production
because it contained `staging-api.subauto.keybox.cloud`.

## 1. Decision And Scope

| Field | Value |
| --- | --- |
| Decision | GO |
| Cutover start time | `2026-06-16 00:59 +08:00` |
| Cutover technical completion time | `2026-06-16 02:21 +08:00` |
| Executor | `keqi119` |
| Approver | `keqi119` |
| Rollback owner | `keqi119` |
| Target server | `139.196.227.195` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Execution result | Production cutover completed |
| Rollback executed | No |

## 2. Production Images

The old `d3cdc5e` Web image remains blocked for production. The completed
cutover used the rebuilt production tag:

```text
prod-20260615-5e8d04a
```

| Image | Tag | Digest | Result |
| --- | --- | --- | --- |
| API | `ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a` | `ghcr.io/keqi119/subscription-api@sha256:af3908801186ddd2ca7cbbf69029bddd7613d77d4061173011ce6276603f9eb9` | Used for production |
| Web | `ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a` | `ghcr.io/keqi119/subscription-web@sha256:ad0db73e9d8ad3ba72ec6524d716f2b9e39546691d302bc7951d5dcec696b9c3` | Used for production |

The Web bundle check passed before cutover:

```text
Contains https://api.subauto.keybox.cloud/api: Yes
Contains staging-api.subauto.keybox.cloud: No
```

The server pulled the Web image directly from GHCR and verified its digest. The
server-side GHCR pull for the API image stalled, so the already verified local
API image was transferred with `docker save` / `docker load`. The image tar
SHA256 matched on both machines:

```text
0de59d9bfa2e0a8907bb78b1c383713532e027d5c43b2e3b6a7fbf958ce0be52
```

## 3. DNS And HTTPS

| Check | Result |
| --- | --- |
| `admin.subauto.keybox.cloud` DNS | `A 139.196.227.195`, TTL `600` |
| `api.subauto.keybox.cloud` DNS | `A 139.196.227.195`, TTL `600` |
| Public TCP 80 | Passed for both domains |
| Public TCP 443 | Passed for both domains |
| HTTP to HTTPS redirect | `301` to HTTPS |
| Web HTTPS | `200` |
| API HTTPS health | `200`, `status:"ok"`, `storage:"oss"` |

BT/Let's Encrypt certificate issuance succeeded, but BT auto-deployment failed
because the manually simplified vhost files did not contain the marker
`#error_page 404/404.html;`. The certificates were manually deployed into the
production Nginx vhost files with the marker restored.

Nginx reload result:

```text
nginx -t: successful
reload: successful
backup suffix: bak-ssl-20260616021243
```

## 4. Deployment Steps

| Step | Result |
| --- | --- |
| Production env file | Uploaded to `/opt/subscription-saas/.env.production.images`, mode `600` |
| Compose config | Passed |
| Staging backup | Passed |
| Staging compose shutdown | Passed; staging volumes retained |
| Production compose up | Passed |
| Production container health | API/Web/Postgres healthy |
| Migration | Passed; `35` migrations applied, schema up to date |
| Baseline seed | Passed |
| Scenario seed | Not executed |
| Public smoke | Passed |
| Rollback | Not executed |

Staging cutover backup:

```text
/opt/subscription-saas/backups/staging-before-production-cutover-20260616013718.sql
size: 407K
```

Production baseline backup:

```text
/opt/subscription-saas/backups/production-baseline-20260616022111.sql
size: 405K
```

## 5. Migration And Seed Notes

`pnpm exec prisma migrate deploy` inside the production API container attempted a
dependency check/install path and was killed on the 2C/2G server. The migration
was then run using the Prisma CLI already present in the image:

```text
/app/apps/api/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
```

Result:

```text
35 migrations applied
Database schema is up to date
```

Baseline seed was run directly with Node:

```text
node prisma/seed.mjs
node prisma/verify-seed-baseline.mjs
```

Result:

```text
Seed baseline verification passed
```

## 6. Runtime Fixes During Cutover

Production API initially failed to reach `postgres:5432` with `EHOSTUNREACH`.
The root cause was firewalld not assigning the new production Docker bridge to
the `docker` zone. The bridge/subnet was allowed:

```text
bridge: br-c076121a1f5a
subnet: 172.23.0.0/16
zone: docker
```

After this, container-to-Postgres TCP connectivity passed and the API started
successfully.

## 7. Smoke And Account Handling

Initial production smoke with the seed admin account passed before password
rotation. After that:

| Account action | Result |
| --- | --- |
| Default admin password rotation | Completed |
| Default `admin/Admin@123456` login | Rejected with `401` after rotation |
| Production smoke account | `production_smoke_admin` created/updated |
| Production smoke account role | ADMIN |
| Production smoke after rotation | Passed |

The generated production credentials are stored only on the server:

```text
/opt/subscription-saas/secrets/production-credentials-20260616021717.txt
mode: 600
owner: root
```

No production password, database URL, JWT secret, cookie secret, or OSS
AccessKey is committed.

## 8. Public Verification

Production smoke passed against:

```text
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud
SMOKE_ADMIN_USERNAME=production_smoke_admin
```

Smoke coverage:

- `GET /health`;
- `POST /auth/login`;
- authenticated `/auth/me`;
- applications, products, quotes;
- valuation reviews;
- dashboard and asset profitability reports;
- users, roles, audit logs;
- concurrency burst against applications/products/users;
- Web routes `/`, `/applications`, `/vehicles`, `/orders`, `/reports`,
  `/reports/asset-profitability`, `/residual-market`,
  `/vehicle-valuation-reviews`.

CORS preflight result:

```text
HTTP/2 204
Access-Control-Allow-Origin: https://admin.subauto.keybox.cloud
Access-Control-Allow-Credentials: true
```

## 9. Resource Usage

Production containers after cutover:

| Container | Memory | CPU |
| --- | --- | --- |
| `subauto-production-web-1` | `71.52MiB / 512MiB` | `0.02%` |
| `subauto-production-api-1` | `196.2MiB / 512MiB` | `0.00%` |
| `subauto-production-postgres-1` | `35.42MiB / 512MiB` | `0.00%` |

Host resources:

```text
Memory: 1.8Gi total, 1.4Gi used, 438Mi available
Swap: 4.0Gi total, 398Mi used
Disk /: 40G total, 23G used, 15G available, 61%
```

Production ports:

```text
127.0.0.1:3000 -> production Web
127.0.0.1:3001 -> production API
Postgres is not published to the public interface
Nginx owns public 80/443
```

Residual security note: the server also has unrelated containers listening on
`0.0.0.0:35432` and `0.0.0.0:13306`. These are not the production stack, but
they should remain blocked by cloud security rules or be closed if unused.

## 10. Final Decision

```text
Production Cutover Complete: Yes
Stage 9F-F Status: Complete
Can announce production cutover complete: Yes
Rollback executed: No
```
