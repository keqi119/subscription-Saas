# Stage 9F-D Production Cutover Plan

This plan defines how to move the validated staging deployment to the production
domains. It is a planning artifact only. Do not execute production cutover during
Stage 9F-D.

## 1. Cutover Objective

Move the system validated on staging to the production domains:

```text
admin.subauto.keybox.cloud
api.subauto.keybox.cloud
```

After production cutover, the staging domains can either remain available as a
validation environment or be paused when the 2 CPU / 2 GB server does not have
enough spare capacity:

```text
staging-admin.subauto.keybox.cloud
staging-api.subauto.keybox.cloud
```

## 2. Current Staging Conclusion

The staging deployment chain has been validated through:

- registry pull deployment;
- Docker Compose up;
- Prisma `migrate deploy`;
- baseline seed;
- OSS upload/download and API stream preview/download;
- API health with `storage:"oss"`;
- CORS preflight;
- HTTPS on public staging domains;
- `smoke:api`;
- `smoke:mainline`;
- `smoke:residual`;
- Web route smoke;
- backup;
- resource check on the 2 CPU / 2 GB server.

`stage9_smoke_admin` is a staging-only account. It must not become a production
default account, and its password must not be reused for production smoke or
production administration.

## 3. Cutover Mode

Recommended mode: single-stack cutover.

The current server size is:

```text
2 CPU / 2 GB RAM / 40 GB disk
```

Recommended sequence:

1. Complete staging acceptance.
2. Back up staging or existing production data.
3. Stop the staging compose stack.
4. Start the production compose stack.
5. Apply production DNS / BT / Nginx / HTTPS.
6. Run production smoke.

Long-running staging and production dual-stack operation is not recommended on
the current server because two full PostgreSQL/API/Web stacks create a high RAM
and swap pressure risk.

If the business requires long-running staging and production side by side,
upgrade to at least 2 CPU / 4 GB RAM or move PostgreSQL to a managed database.

## 4. Production Domains

Production DNS records for cutover:

| Host | Type | Value |
| --- | --- | --- |
| `admin.subauto.keybox.cloud` | `A` | `139.196.227.195` |
| `api.subauto.keybox.cloud` | `A` | `139.196.227.195` |

Set DNS TTL to `600` before cutover where supported. Do not enable these records
for production traffic before the cutover approval stage.

## 5. Production Environment Strategy

Use a server-only file named:

```text
.env.production.images
```

Do not commit the real file. The committed template is:

```text
.env.production.images.example
```

Production environment values must be isolated from staging:

```text
POSTGRES_DB=subscription_saas_prod
POSTGRES_USER=subscription_saas
POSTGRES_PASSWORD=<PROD_STRONG_PASSWORD>
DATABASE_URL=postgresql://subscription_saas:<PROD_STRONG_PASSWORD>@postgres:5432/subscription_saas_prod?schema=public

JWT_SECRET=<PROD_STRONG_SECRET>
COOKIE_SECRET=<PROD_STRONG_SECRET>

CORS_ORIGIN=https://admin.subauto.keybox.cloud
NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api

UPLOAD_STORAGE_DRIVER=oss
OSS_PREFIX=subscription-saas/production
```

Production must not use:

- the staging OSS prefix;
- the staging admin password;
- the staging smoke password;
- `.env.staging.images`;
- staging Docker volumes.

## 6. Production OSS Strategy

Recommended storage isolation:

- use an independent production bucket; or
- use the same private bucket with the production prefix:

```text
subscription-saas/production
```

The production bucket or prefix must be private and must support:

- authenticated API stream download;
- no permanent public OSS URL exposure in API responses;
- RAM policy access to the production prefix;
- upload/download validation after cutover.

## 7. Production Image Tag

Production image tags must be immutable and fixed. Do not deploy `latest`.

Recommended tag shapes:

```text
prod-YYYYMMDD-<shortSha>
rc-20260613-stage9-<shortSha>
```

Before cutover, record:

- `API_IMAGE`;
- `WEB_IMAGE`;
- Git commit;
- image digest, if available from the registry.

Stage 9F-D does not select or assume the final production image tag.

## 8. Production Compose Strategy

Use the image-based compose file:

```text
docker-compose.production.images.example.yml
```

It is separate from the staging compose file and must use:

- `.env.production.images`;
- `production_postgres_data`;
- `production_api_uploads`;
- API/Web host ports bound to `127.0.0.1`;
- no public PostgreSQL port mapping;
- resource limits suitable for the current 2 CPU / 2 GB server;
- JSON log rotation;
- health checks for PostgreSQL, API, and Web.

When `UPLOAD_STORAGE_DRIVER=oss`, the uploads volume remains a local working
directory and must not be treated as the production durable file store.

## 9. Production BT / Nginx Configuration

BT / Nginx owns public `80` and `443`. Docker Compose must not bind public
`80` or `443`.

Use:

```text
nginx/production-subauto.example.conf
```

Routing:

```text
admin.subauto.keybox.cloud -> http://127.0.0.1:3000
api.subauto.keybox.cloud   -> http://127.0.0.1:3001
```

The server blocks must preserve:

```text
Host
X-Real-IP
X-Forwarded-For
X-Forwarded-Proto
client_max_body_size 20m
proxy_read_timeout
proxy_send_timeout
```

Issue production certificates for the production domains during the cutover
window or in an approved pre-cutover certificate step.

## 10. Pre-Cutover Backup

Before production cutover, run `pg_dump` for the current data source that could
need rollback. If the production database is empty, still back up staging or the
previous production database as applicable.

Record:

- backup file path;
- backup size;
- backup timestamp;
- database source;
- restore owner.

## 11. Migration And Seed

Allowed production database commands:

```text
prisma migrate deploy
pnpm prisma:seed
```

Forbidden production database commands:

```text
prisma migrate reset
prisma db push
manual deletion from _prisma_migrations
```

Production seed rules:

- baseline seed only initializes roles, permissions, menus, admin, and baseline
  master data;
- scenario seed must not run in production;
- initial admin password must be changed after first login.

## 12. Production Smoke

Production smoke environment:

```text
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud
SMOKE_ADMIN_USERNAME=<production smoke/admin user>
SMOKE_ADMIN_PASSWORD=<secret>
```

Run:

```powershell
pnpm smoke:api
```

Production scenario seed is disabled by default. If scenario smoke is required,
it must have explicit human approval and a cleanup plan before execution.

## 13. Post-Cutover Operations

After production cutover:

1. Change the default admin password.
2. Delete or disable staging-only smoke accounts.
3. Create a production-only smoke account if ongoing smoke is required.
4. Verify permissions and menus after login.
5. Verify `/api/health` returns `storage:"oss"`.
6. Verify writes use `OSS_PREFIX=subscription-saas/production`.
7. Check API, Web, Nginx, and PostgreSQL logs.
8. Check container memory, swap, and disk usage.
9. Record the production release completion time.

## 14. Rollback Plan

### Code Or Container Rollback

1. Record the previous API and Web image tags before cutover.
2. Change `.env.production.images` back to the previous `API_IMAGE` and
   `WEB_IMAGE`.
3. Run `docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml pull`.
4. Run `docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml up -d`.
5. Run `pnpm smoke:api` against production domains.

### Database Rollback

1. If migration changed schema or data, prefer restoring from the pre-cutover
   backup.
2. Stop production writes before restore.
3. Restore the database.
4. Run `prisma migrate status`.
5. Run production smoke after restore.

## 15. Production Cutover Blockers

Do not execute production cutover if any item is true:

- staging smoke has not passed;
- OSS staging validation has not passed;
- production environment file is not prepared;
- production backup is not complete;
- production DNS is not confirmed;
- production HTTPS is not confirmed;
- `migrate deploy` fails;
- baseline seed fails;
- API health fails;
- login smoke fails;
- `/api/health` does not report `storage:"oss"`;
- default admin password is not changed after first login;
- production domain CORS is incorrect;
- production image tags are mutable or unrecorded;
- rollback owner or rollback window is not confirmed.

## 16. Approval Gate

Stage 9F-D only prepares the plan and deployment assets. The next step is:

```text
Stage 9F-E Production Cutover Approval
```

Approval must decide:

- whether staging stops before production starts;
- whether the same server is used;
- whether production uses an isolated database volume;
- production OSS bucket or prefix;
- production admin and smoke account strategy;
- cutover window;
- rollback owner.
