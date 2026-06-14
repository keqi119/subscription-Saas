# Staging Deployment Runbook

Stage 9F-B prepares the staging server dry-run plan.
Stage 9F-C performs the actual deployment on the staging server.

This runbook targets:

```text
Server region: Mainland China - Shanghai East China
Server IP: 139.196.227.195
ICP: 沪ICP备18045696号
Admin domain: staging-admin.subauto.keybox.cloud
API domain: staging-api.subauto.keybox.cloud
Server spec: 2 CPU / 2 GB RAM / 40 GB disk
```

Do not commit real secrets or `.env.staging`.

## 1. Goal

Deploy the current RC line to staging and verify:

```text
DNS
  -> HTTPS
  -> Docker Compose config
  -> PostgreSQL
  -> migrate deploy
  -> baseline seed
  -> API/Web/Caddy
  -> smoke
  -> backup / restore drill
  -> resource usage
```

This is not production cutover.

## 2. Server Preparation

Install:

- Docker Engine;
- Docker Compose plugin;
- Git or artifact delivery mechanism;
- basic log and disk monitoring tools.

Because the server has only 2 GB RAM, configure at least 2 GB swap before building images or running all containers:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

Confirm:

```bash
df -h
free -h
docker --version
docker compose version
```

Security group / firewall:

- allow `80/tcp`;
- allow `443/tcp`;
- restrict `22/tcp` to management IPs when possible;
- do not expose PostgreSQL `5432/tcp` to the public internet;
- do not expose API `3001` or Web `3000` directly.

## 3. DNS

In Aliyun DNS for `keybox.cloud`, create:

```text
staging-admin.subauto.keybox.cloud A 139.196.227.195
staging-api.subauto.keybox.cloud   A 139.196.227.195
```

Suggested TTL:

```text
600 seconds
```

Aliyun steps:

1. Log in to Aliyun Cloud DNS.
2. Select `keybox.cloud`.
3. Add an `A` record.
4. Host record: `staging-admin.subauto`.
5. Record value: `139.196.227.195`.
6. TTL: `600`.
7. Repeat for `staging-api.subauto`.

## 4. Environment

On the staging server:

```bash
cp .env.staging.example .env.staging
```

Edit `.env.staging` on the server only.

Required values:

```text
POSTGRES_PASSWORD
DATABASE_URL
JWT_SECRET
COOKIE_SECRET
SEED_ADMIN_PASSWORD
CORS_ORIGIN=https://staging-admin.subauto.keybox.cloud
NEXT_PUBLIC_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api
ADMIN_DOMAIN=staging-admin.subauto.keybox.cloud
API_DOMAIN=staging-api.subauto.keybox.cloud
```

Do not use `ADMIN_ALLOWED_IPS` in this stage.
The staging admin console is not IP-restricted.
Security relies on HTTPS, strong secrets, login/RBAC, CORS, secure cookies, and server security groups.

## 5. Compose Config

Validate before starting:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml config
```

Expected:

```text
exit code 0
```

Docker may warn about local client config permissions.
If exit code is `0`, record it as a non-blocking warning.

## 6. Build

On a 2 GB RAM server, server-side image build may fail with OOM.

First try:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml build
```

If build fails due to memory:

```text
Build images in CI or a local build machine, push to a registry, and let the staging server pull images.
```

The Web image uses `NEXT_PUBLIC_API_BASE_URL` at build time.
Rebuild Web if the API domain changes.

## 7. Start PostgreSQL

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml up -d postgres
docker compose --env-file .env.staging -f docker-compose.staging.example.yml ps
```

Confirm `postgres` health is healthy.

PostgreSQL staging resource hints:

```text
mem_limit: 512m
cpus: 0.60
shared_buffers=128MB
work_mem=4MB
maintenance_work_mem=64MB
max_connections=30
```

## 8. Migration

Run migration from the API container:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml run --rm api pnpm prisma:migrate:deploy
docker compose --env-file .env.staging -f docker-compose.staging.example.yml run --rm api pnpm prisma:migrate:status
```

Do not run:

```text
prisma migrate reset
prisma db push
```

If migration fails, stop the dry run and keep logs.

## 9. Baseline Seed

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml run --rm api pnpm prisma:seed
```

After first login, change the default admin password.

Default seed must remain baseline master data only.
Do not use scenario seed as production or staging baseline data.

## 10. Start API / Web / Caddy

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml up -d
docker compose --env-file .env.staging -f docker-compose.staging.example.yml ps
```

Logs:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 api
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 web
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 reverse-proxy
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 postgres
```

## 11. Smoke

From a workstation with access to the staging domains:

```bash
SMOKE_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api \
SMOKE_WEB_BASE_URL=https://staging-admin.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD="<STAGING_ADMIN_PASSWORD>" \
pnpm smoke:api
```

Scenario smoke is allowed in staging:

```bash
pnpm seed:scenario cleanup
pnpm seed:scenario mainline
pnpm seed:scenario residual
pnpm smoke:mainline
pnpm smoke:residual
pnpm seed:scenario cleanup
```

## 12. Backup

Use:

```bash
DATABASE_URL="<STAGING_DATABASE_URL>" ./scripts/backup-postgres.example.sh
```

Reference:

```text
scripts/backup-postgres.example.sh
docs/backup-restore.md
```

Backup files must not be committed.

## 13. Restore Drill

Before restore:

- stop API/Web write traffic;
- record current commit and migration status;
- keep a fresh backup of the current state.

Restore:

```bash
DATABASE_URL="<STAGING_DATABASE_URL>" ./scripts/restore-postgres.example.sh backups/<backup-file>.dump
```

After restore:

```bash
pnpm prisma:migrate:status
pnpm smoke:api
```

If restore drill is waived, record the reason in:

```text
docs/staging-dry-run-report.md
```

## 14. Upload Storage

Current code uses local file storage only.

Staging uses:

```text
LOCAL_FILE_STORAGE_DIR=/app/uploads
staging_api_uploads volume
```

Object storage readiness is documented in:

```text
docs/object-storage-readiness.md
```

If production requires durable material uploads, Stage 9G must implement Aliyun OSS adapter before production cutover.

## 15. Cleanup

If scenario seed was executed:

```bash
pnpm seed:scenario cleanup
```

Do not delete non-`SCN9_` data manually.

## 16. Result Recording

Use:

```text
docs/staging-dry-run-report.md
```

Minimum table:

| Step | Command | Result | Notes |
| --- | --- | --- | --- |
| DNS | `<command / console>` | `<Passed / Failed>` |  |
| compose config | `docker compose ... config` | `<Passed / Failed>` |  |
| build | `docker compose ... build` | `<Passed / Failed>` |  |
| up | `docker compose ... up -d` | `<Passed / Failed>` |  |
| migrate deploy | `pnpm prisma:migrate:deploy` | `<Passed / Failed>` |  |
| seed | `pnpm prisma:seed` | `<Passed / Failed>` |  |
| smoke | `pnpm smoke:api` | `<Passed / Failed>` |  |
| backup | `backup-postgres.example.sh` | `<Passed / Failed>` |  |
| restore | `restore-postgres.example.sh` | `<Passed / Waived / Failed>` |  |

## 17. Production Cutover Gate

Do not enter production cutover until:

- staging admin and API domains are reachable;
- staging smoke passes;
- staging backup passes;
- restore drill passes or has an approved waiver;
- object storage readiness is explicitly accepted or Stage 9G is completed;
- no IP allowlist decision is documented and accepted;
- Docker build/pull strategy is confirmed;
- 2 GB RAM resource behavior is observed and acceptable.
