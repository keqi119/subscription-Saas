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
  -> API/Web behind the chosen edge reverse proxy
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

Because the server has only 2 GB RAM, configure at least 2 GB swap before running all containers.
Do not rely on swap to build the Web / Next.js image on this server:

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

If the server already runs BT / Nginx or another reverse proxy on `80` / `443`, do not stop it automatically.
Choose one staging reverse-proxy owner before continuing:

1. keep host Nginx and configure it to proxy staging domains to the API / Web containers;
2. or migrate existing host sites away from Nginx and let Caddy own both `80` and `443`;
3. or use a server-only compose override for a temporary dry run, and record that HTTPS / proxy validation is incomplete.

The default `docker-compose.staging.example.yml` assumes Caddy owns `80` and `443`.

Stage 9F-C showed that this server already has BT / Nginx on the edge and cannot reliably build
the Web / Next.js image even after increasing total swap to 4 GB. For this server, use the
Stage 9F-C2 image-based path:

```text
local or CI build
  -> push API/Web images to registry
  -> server docker login
  -> docker compose pull
  -> docker compose up -d
  -> host BT / Nginx proxies staging domains to 127.0.0.1:3100 / 3101
```

Use:

```text
docker-compose.staging.images.example.yml
.env.staging.images
nginx/staging-subauto.example.conf
docs/image-registry-deployment.md
```

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
SUBSCRIPTION_EXTENSION_ENABLED=true
SUBSCRIPTION_VEHICLE_SWAP_ENABLED=true
SUBSCRIPTION_EARLY_TERMINATION_ENABLED=true
SUBSCRIPTION_MANAGED_OTHER_ENABLED=true
SUBSCRIPTION_CHANGE_WORKER_ENABLED=true
SUBSCRIPTION_CHANGE_WORKER_POLL_INTERVAL_MS=5000
SUBSCRIPTION_CHANGE_WORKER_LEASE_MS=120000
```

The four contract-change flags are independent and fail closed. Before Stage 1 contract-change
acceptance, follow `docs/runbooks/stage1-active-term-contract-change-release.md` and complete its
dry-run/apply/dry-run bootstrap sequence against the confirmed Staging database.

`SUBSCRIPTION_CHANGE_WORKER_ENABLED` is a separate worker runtime switch and must be exact lowercase
`true` for polling, reconciliation, enrollment, and claiming to run. Changing it requires an API
restart. Setting it to `false` pauses every supported contract-change/closure job, including already
scheduled work; it is not equivalent to disabling only new extension enrollment.

Do not use `ADMIN_ALLOWED_IPS` in this stage.
The staging admin console is not IP-restricted.
Security relies on HTTPS, strong secrets, login/RBAC, CORS, secure cookies, and server security groups.

## 5. Compose Config

Recommended image-based config for the current 2 CPU / 2 GB server:

```bash
cp .env.staging.images.example .env.staging.images
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml config
```

The `.env.staging.images` file is server-local and must not be committed. Fill real image names,
secrets, and passwords on the server only.

The source-build compose remains available for larger hosts:

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

Do not build the Web image on the current 2 GB staging server. Stage 9F-C failed twice because the
Next.js production build triggered OOM, including after total swap was increased to 4 GB.

Build and push outside the server:

```bash
docker build -f Dockerfile.api -t <REGISTRY>/<NAMESPACE>/subscription-api:<TAG> .
docker build -f Dockerfile.web -t <REGISTRY>/<NAMESPACE>/subscription-web:<TAG> .
docker push <REGISTRY>/<NAMESPACE>/subscription-api:<TAG>
docker push <REGISTRY>/<NAMESPACE>/subscription-web:<TAG>
```

Then pull on the staging server:

```bash
docker login <REGISTRY>
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml pull
```

The Web image uses `NEXT_PUBLIC_API_BASE_URL` at build time.
Rebuild Web if the API domain changes.

Server-side build is only an option for larger hosts, typically 4 GB RAM or more, and should not be
the default path for this staging server.

## 7. Start PostgreSQL

Image-based path（由可信启动方执行，API 镜像不含 Prisma CLI）：

```bash
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml up -d postgres
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml ps
```

Source-build path on larger hosts:

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

Image-based path:

```bash
node scripts/release/trusted-launch-runner.mjs --command db.migrate.deploy@1 --phase apply --request-file .release-inputs/migrate-deploy.json
node scripts/release/trusted-launch-runner.mjs --command db.schema.verify@1 --phase verify --request-file .release-inputs/schema-verify.json
```

Source-build path（只用于受控临时环境，仍通过固定 Runner command）：

```bash
node scripts/release/trusted-launch-runner.mjs --command db.migrate.deploy@1 --phase apply --request-file .release-inputs/migrate-deploy.json
node scripts/release/trusted-launch-runner.mjs --command db.schema.verify@1 --phase verify --request-file .release-inputs/schema-verify.json
```

Do not run:

```text
prisma migrate reset
prisma db push
```

If migration fails, stop the dry run and keep logs.

## 9. Baseline Seed

环境 seed 不再通过 API 镜像执行。下列本地源码命令仅用于开发数据库，不得用于 Staging：

```bash
pnpm prisma:seed # local development database only
```

Staging 若需要夹具或基线写入，必须先有注册的 Runner fixture/repair command、独立批准和执行证明；
缺少该命令时 fail closed。

After first login, change the default admin password.

Default seed must remain baseline master data only.
Do not use scenario seed as production or staging baseline data.

## 10. Start API / Web

Image-based path:

```bash
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml up -d
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml ps
```

Source-build / Caddy path:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml up -d
docker compose --env-file .env.staging -f docker-compose.staging.example.yml ps
```

Logs:

```bash
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml logs --tail=100 api
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml logs --tail=100 web
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml logs --tail=100 postgres
```

If using the source-build / Caddy path:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 api
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 web
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 reverse-proxy
docker compose --env-file .env.staging -f docker-compose.staging.example.yml logs --tail=100 postgres
```

For the current server, configure BT / Nginx to terminate HTTPS and proxy:

```text
staging-admin.subauto.keybox.cloud -> http://127.0.0.1:3100
staging-api.subauto.keybox.cloud   -> http://127.0.0.1:3101
```

Use `nginx/staging-subauto.example.conf` as a reference. Do not expose PostgreSQL, API, or Web
container ports to the public internet.

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
node scripts/release/trusted-launch-runner.mjs --command db.schema.verify@1 --phase verify --request-file .release-inputs/schema-verify.json
pnpm smoke:api
```

If restore drill is waived, record the reason in:

```text
docs/staging-dry-run-report.md
```

## 14. Upload Storage

The API supports two upload storage drivers:

```text
UPLOAD_STORAGE_DRIVER=local
UPLOAD_STORAGE_DRIVER=oss
```

Local staging dry runs may use:

```text
UPLOAD_STORAGE_DRIVER=local
UPLOAD_LOCAL_DIR=/app/uploads
LOCAL_FILE_STORAGE_DIR=/app/uploads
staging_api_uploads volume
```

For OSS staging validation:

1. Create an Aliyun OSS bucket in the target region.
2. Keep the bucket private.
3. Create a RAM AccessKey with minimum bucket read/write/delete scope.
4. Configure `.env.staging.images` with:

```text
UPLOAD_STORAGE_DRIVER=oss
OSS_REGION=oss-cn-shanghai
OSS_BUCKET=<bucket>
OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com
OSS_ACCESS_KEY_ID=<from secret manager>
OSS_ACCESS_KEY_SECRET=<from secret manager>
OSS_PREFIX=subscription-saas/staging
OSS_INTERNAL_ENDPOINT=<optional internal endpoint>
```

5. Restart the API container.
6. Upload a customer/application material.
7. Preview/download the material through the API.
8. Confirm no public OSS URL is exposed to the browser.

Upload storage smoke:

```bash
pnpm seed:scenario cleanup
pnpm seed:scenario mainline

SMOKE_API_BASE_URL=https://staging-api.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD=<staging-admin-password> \
SMOKE_SCENARIO_FILE=.tmp/scenarios/mainline.json \
SMOKE_EXPECT_STORAGE_DRIVER=oss \
pnpm smoke:upload
```

On the 2 CPU / 2 GB staging server, prefer running scenario seed inside the API container with `node` instead of invoking `pnpm` inside the runtime image if `pnpm` tries to perform dependency checks:

```bash
docker exec subauto-staging-r2-api-1 node apps/api/prisma/seed-scenario.mjs cleanup
docker exec subauto-staging-r2-api-1 node apps/api/prisma/seed-scenario.mjs mainline
```

If the default `admin` password has already been rotated, use an explicitly approved staging-only smoke user for upload validation. Remove that user or rotate its password before production cutover.

After the upload smoke passes, restart the API container and run the same download check again:

```bash
docker compose -p subauto-staging --env-file .env.staging.images -f docker-compose.staging.images.example.yml restart api
SMOKE_API_BASE_URL=https://staging-api.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD=<staging-admin-password> \
SMOKE_SCENARIO_FILE=.tmp/scenarios/mainline.json \
SMOKE_EXPECT_STORAGE_DRIVER=oss \
pnpm smoke:upload -- --download-only
```

The second command downloads the same uploaded material recorded in `.tmp/upload-storage-smoke.json`, verifying that the API still streams the OSS-backed object after restart.

Object storage readiness and the Stage 9G-B validation gate are documented in:

```text
docs/object-storage-readiness.md
```

Stage 9G-A implements the adapter. Stage 9G-B must validate a real staging bucket before production cutover.

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

| Step               | Command                               | Result                       | Notes |
| ------------------ | ------------------------------------- | ---------------------------- | ----- |
| DNS                | `<command / console>`                 | `<Passed / Failed>`          |       |
| compose config     | `docker compose ... config`           | `<Passed / Failed>`          |       |
| image build / push | `<local or CI command>`               | `<Passed / Failed / N/A>`    |       |
| pull               | `docker compose ... pull`             | `<Passed / Failed>`          |       |
| up                 | `docker compose ... up -d`            | `<Passed / Failed>`          |       |
| migrate deploy     | Runner `db.migrate.deploy@1`          | `<Passed / Failed>`          |       |
| seed               | registered Runner fixture/repair only | `<Passed / N/A / Failed>`    |       |
| smoke              | `pnpm smoke:api`                      | `<Passed / Failed>`          |       |
| backup             | `backup-postgres.example.sh`          | `<Passed / Failed>`          |       |
| restore            | `restore-postgres.example.sh`         | `<Passed / Waived / Failed>` |       |

## 17. Production Cutover Gate

Do not enter production cutover until:

- staging admin and API domains are reachable;
- staging smoke passes;
- staging backup passes;
- restore drill passes or has an approved waiver;
- Stage 9G-B real OSS bucket upload/download validation passes, or production explicitly accepts local volume risk;
- no IP allowlist decision is documented and accepted;
- Docker registry pull strategy is confirmed for the current 2 GB server;
- BT / Nginx edge proxy is verified, or an alternate reverse proxy owner is explicitly approved;
- 2 GB RAM resource behavior is observed and acceptable.
