# Production Deployment Dry-Run Runbook

Stage 9F-A validates the deployment process without cutting over real production traffic.
Do not connect this dry run to a real production database unless a human operator explicitly authorizes it.

Target domains:

```text
admin.subauto.keybox.cloud
api.subauto.keybox.cloud
subauto.keybox.cloud
```

Recommended first deployment shape:

```text
Edge HTTPS reverse proxy (Caddy, Nginx, or BT-managed Nginx)
  -> Web container :3000
  -> API container :3001
API
  -> PostgreSQL
  -> persistent upload volume
PostgreSQL
  -> pg_dump backups
```

## 1. Build and Script Facts

Current repository commands:

| Area | Command |
| --- | --- |
| API build | `pnpm --filter @subscription-saas/api build` |
| API production start | `pnpm --filter @subscription-saas/api start` |
| Web build | `pnpm --filter @subscription-saas/web build` |
| Web production start | `pnpm --filter @subscription-saas/web start` |
| Prisma generate | `pnpm prisma:generate` |
| Prisma migrate deploy | `pnpm prisma:migrate:deploy` |
| Prisma migrate status | `pnpm prisma:migrate:status` |
| Baseline seed | `pnpm prisma:seed` |
| Release check | `pnpm release:check` |
| API smoke | `pnpm smoke:api` |
| Scenario smoke | `pnpm smoke:mainline` and `pnpm smoke:residual` |

The default seed must remain baseline master data only.
Scenario seed is for development and acceptance environments, not production.

## 1.0 Production Cutover Approval Gate

Production cutover execution must follow these documents in order:

1. `docs/production-cutover-approval.md`
2. `docs/production-go-no-go-record.md`
3. `docs/production-cutover-checklist.md`

Stage 9F-E is approval only. It does not switch DNS, start production compose,
run production migrations, run production seed, or connect to a production
database.

Do not proceed to execution unless `docs/production-go-no-go-record.md` records:

```text
Decision: GO
```

## 1.1 Staging Server Dry Run

Before production cutover, run Stage 9F-B against the staging domains:

```text
staging-admin.subauto.keybox.cloud
staging-api.subauto.keybox.cloud
```

The staging target server is `139.196.227.195` in mainland China Shanghai East China.
Use `docs/staging-deployment-runbook.md`.

Stage 9F-C2 update:

- the current 2 CPU / 2 GB server cannot reliably build the Web / Next.js image, even with 4 GB swap;
- the current server already has BT / Nginx on `80` / `443`, so Caddy should not also bind public HTTPS ports;
- the recommended staging path is registry pull with `docker-compose.staging.images.example.yml`;
- BT / Nginx should proxy staging domains to `127.0.0.1:3000` and `127.0.0.1:3001`.

Stage 9F-D update:

- production cutover planning is recorded in `docs/production-cutover-plan.md`;
- the recommended production path on the current 2 CPU / 2 GB server is single-stack cutover, not long-running staging and production dual-stack;
- the recommended production compose file is `docker-compose.production.images.example.yml`;
- production uses `.env.production.images` on the server, copied from `.env.production.images.example`;
- BT / Nginx should proxy production domains to `127.0.0.1:3000` and `127.0.0.1:3001` using `nginx/production-subauto.example.conf`.

Staging must prove:

- DNS and HTTPS work for both staging domains;
- PostgreSQL, API, and Web start with resource limits on the 2 CPU / 2 GB RAM server;
- migration, baseline seed, smoke, backup, and restore drill are executable;
- scenario seed remains isolated and can be cleaned up;
- uploads are validated with `UPLOAD_STORAGE_DRIVER=oss` before production cutover, unless local volume risk is explicitly accepted.

## 2. Server Preparation

Prepare a fresh server with:

- Linux distribution supported by Docker;
- Docker Engine;
- Docker Compose plugin;
- inbound firewall rules for `80` and `443`;
- restricted SSH access;
- disk space for PostgreSQL data, uploads, Caddy certificates, and backups.

Do not store the repository under a synced desktop folder.

## 3. Prepare Deployment Files

Copy the example files on the server:

```bash
cp .env.production.example .env.production
cp Caddyfile.example Caddyfile
```

Edit `.env.production` on the server only.

For the image-based production path on the current 2 CPU / 2 GB server, use:

```bash
cp .env.production.images.example .env.production.images
```

Edit `.env.production.images` on the server only. Do not commit it.

Required values:

```text
POSTGRES_PASSWORD
DATABASE_URL
JWT_SECRET
COOKIE_SECRET
SEED_ADMIN_PASSWORD
NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api
CORS_ORIGIN=https://admin.subauto.keybox.cloud
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud
```

If uploaded customer materials must survive container or server replacement, configure OSS in `.env.production`
or `.env.production.images`:

```text
UPLOAD_STORAGE_DRIVER=oss
OSS_REGION=oss-cn-shanghai
OSS_BUCKET=<private-bucket>
OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com
OSS_ACCESS_KEY_ID=<secret-manager-value>
OSS_ACCESS_KEY_SECRET=<secret-manager-value>
OSS_PREFIX=subscription-saas/production
OSS_INTERNAL_ENDPOINT=<optional-internal-endpoint>
```

Keep the OSS bucket private. Upload downloads must continue through the authenticated API stream endpoints, not public bucket URLs.

Never commit `.env.production` or `.env.production.images`.

## 4. Prepare DNS and HTTPS

Follow:

```text
docs/domain-dns-ssl.md
```

Dry run may use a temporary server IP, but production cutover must use the final DNS records.

## 5. Build Images

Option A: server-side build.

Use this only on hosts with enough memory, typically 4 GB RAM or more:

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production build
```

The Web image receives `NEXT_PUBLIC_API_BASE_URL` at build time.
If the API domain changes, rebuild the Web image.

Option B: registry pull.

This is recommended for the current 2 CPU / 2 GB server. Build API/Web images outside the server,
push them to a registry, and let the server pull:

```bash
docker build -f Dockerfile.api -t <REGISTRY>/<NAMESPACE>/subscription-api:<TAG> .
docker build -f Dockerfile.web -t <REGISTRY>/<NAMESPACE>/subscription-web:<TAG> .
docker push <REGISTRY>/<NAMESPACE>/subscription-api:<TAG>
docker push <REGISTRY>/<NAMESPACE>/subscription-web:<TAG>
```

On the server:

```bash
docker login <REGISTRY>
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml pull
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml up -d
```

See `docs/image-registry-deployment.md` for the full registry deployment path.
Record immutable API/Web tags and image digests before cutover. Do not deploy `latest`.

## 6. Start PostgreSQL

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

Confirm PostgreSQL is healthy before migrations.

For image-based production deployment:

```bash
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml up -d postgres
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml ps
```

## 7. Backup Before Migration

Before every migration on a non-empty environment:

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/backup-postgres.example.sh
```

For a fresh dry-run database, record that no prior data existed.

## 8. Prisma Migrate Deploy

Only use deploy:

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:migrate:deploy
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:migrate:status
```

For image-based production deployment:

```bash
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml run --rm api pnpm prisma:migrate:deploy
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml run --rm api pnpm prisma:migrate:status
```

Production forbidden commands:

```text
prisma migrate reset
prisma db push
manual deletion from _prisma_migrations
```

Stop the deployment if migration fails.

## 9. Baseline Seed

Run baseline seed only after migration succeeds:

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production run --rm api pnpm prisma:seed
```

For image-based production deployment:

```bash
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml run --rm api pnpm prisma:seed
```

Production seed rules:

- initialize baseline master data only;
- do not create complex acceptance flow records;
- do not run scenario seed in production;
- change the initial admin password after first login.

## 10. Start API, Web, and Reverse Proxy

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

For image-based production deployment:

```bash
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml up -d
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml ps
```

Check container logs:

```bash
docker compose -f docker-compose.prod.example.yml logs --tail=100 api
docker compose -f docker-compose.prod.example.yml logs --tail=100 web
docker compose -f docker-compose.prod.example.yml logs --tail=100 reverse-proxy
```

For the BT / Nginx image-based path, the reverse proxy is managed outside this compose file.
Check API/Web logs with Docker Compose and check Nginx logs through BT / Nginx on the host.

## 11. Health and Smoke

Health:

```bash
curl -fsS https://api.subauto.keybox.cloud/api/health
```

Smoke:

```bash
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api \
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD="<INITIAL_ADMIN_PASSWORD>" \
pnpm smoke:api
```

Scenario smoke requires scenario seed output and should only run in dry-run or acceptance environments:

```bash
pnpm seed:scenario cleanup
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm smoke:mainline
pnpm smoke:residual
pnpm seed:scenario cleanup
```

Do not run scenario seed in production cutover.

## 12. Release Check

Before cutover, run from a clean repository checkout or CI:

```bash
pnpm release:check
```

For dry-run environments where API/Web are running:

```bash
RUN_RELEASE_SCENARIOS=1 \
RUN_RELEASE_SMOKE=1 \
SMOKE_API_BASE_URL=https://api.subauto.keybox.cloud/api \
SMOKE_WEB_BASE_URL=https://admin.subauto.keybox.cloud \
pnpm release:check
```

## 13. Manual Acceptance

Use:

```text
docs/manual-acceptance.md
docs/release-checklist.md
docs/mainline-acceptance-freeze.md
```

Minimum manual checks:

- admin login;
- permissions and menu refresh;
- applications, vehicles, orders, reports pages;
- asset profitability page;
- residual market page;
- valuation review page;
- audit log spot check.

## 14. Rollback

Application rollback:

```bash
git checkout <PREVIOUS_RELEASE_TAG_OR_COMMIT>
docker compose -f docker-compose.prod.example.yml --env-file .env.production build
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d
pnpm smoke:api
```

Image-based application rollback:

```bash
# Restore the previous immutable API_IMAGE and WEB_IMAGE in .env.production.images.
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml pull
docker compose --env-file .env.production.images -f docker-compose.production.images.example.yml up -d
pnpm smoke:api
```

Database rollback:

```bash
DATABASE_URL="<DATABASE_URL>" ./scripts/restore-postgres.example.sh backups/<backup-file>.dump
pnpm prisma:migrate:status
pnpm smoke:api
```

If a migration has already been applied, prefer backup restore or forward-fix migration after review.

## 15. Evidence to Record

Record the following before Stage 9F-B cutover:

- release tag;
- Git commit;
- API image tag and digest;
- Web image tag and digest;
- server host name;
- DNS records;
- backup file name and timestamp;
- migration status output;
- seed result;
- health check result;
- smoke result;
- manual acceptance signer;
- rollback owner.
