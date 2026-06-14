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
Caddy HTTPS reverse proxy
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

Never commit `.env.production`.

## 4. Prepare DNS and HTTPS

Follow:

```text
docs/domain-dns-ssl.md
```

Dry run may use a temporary server IP, but production cutover must use the final DNS records.

## 5. Build Images

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production build
```

The Web image receives `NEXT_PUBLIC_API_BASE_URL` at build time.
If the API domain changes, rebuild the Web image.

## 6. Start PostgreSQL

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

Confirm PostgreSQL is healthy before migrations.

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

Production seed rules:

- initialize baseline master data only;
- do not create complex acceptance flow records;
- do not run scenario seed in production;
- change the initial admin password after first login.

## 10. Start API, Web, and Caddy

```bash
docker compose -f docker-compose.prod.example.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.example.yml --env-file .env.production ps
```

Check container logs:

```bash
docker compose -f docker-compose.prod.example.yml logs --tail=100 api
docker compose -f docker-compose.prod.example.yml logs --tail=100 web
docker compose -f docker-compose.prod.example.yml logs --tail=100 reverse-proxy
```

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
- server host name;
- DNS records;
- backup file name and timestamp;
- migration status output;
- seed result;
- health check result;
- smoke result;
- manual acceptance signer;
- rollback owner.
