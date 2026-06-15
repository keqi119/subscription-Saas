# Stage 9F-C Staging Dry Run Report

This report records the actual staging server deployment attempts for Stage 9F-C.
No production cutover was performed, and no real secrets are included in this document.

## 1. Basic Information

| Item | Value |
| --- | --- |
| Server region | Mainland China - Shanghai East China |
| Server IP | `139.196.227.195` |
| ICP filing | `沪ICP备18045696号` |
| Admin domain | `staging-admin.subauto.keybox.cloud` |
| API domain | `staging-api.subauto.keybox.cloud` |
| Deployment date | `2026-06-14` |
| Server deployment commit | `9572aa8` |
| Local report branch | `feature/stage9-staging-actual-deployment-report` |
| Base stage | Stage 9F-B merged to `main` |
| RC tag | `rc-20260613-stage9` |

## 2. DNS Result

| Check | Result | Notes |
| --- | --- | --- |
| `staging-admin.subauto.keybox.cloud` | Passed | Ali DNS resolver `223.5.5.5` resolved to `139.196.227.195` |
| `staging-api.subauto.keybox.cloud` | Passed | Ali DNS resolver `223.5.5.5` resolved to `139.196.227.195` |
| Local router DNS | Warning | Local `192.168.3.1` `nslookup` timed out, so Ali public DNS was used for verification |

## 3. Server Baseline

| Item | Result |
| --- | --- |
| Hostname | `iZuf63lwxj7v011m6m4yimZ` |
| OS kernel | `Linux 5.10.134-19.1.al8.x86_64` |
| Docker | `Docker version 26.1.3` |
| Docker Compose | `Docker Compose version v2.27.0` |
| Disk after 4G swap retry | `/dev/vda3 40G total, 16G used, 22G available` |
| Initial swap | `1G` at `/www/swap` |
| First attempt swap | `2G total` (`/www/swap` 1G + `/swapfile-stage9` 1G) |
| Second attempt swap | `4G total` (`/www/swap` 1G + `/swapfile-stage9` 3G) |
| Existing reverse proxy | BT / Nginx already listens on `80` and `888` |
| Existing database containers | Existing PostgreSQL and Redis containers were present before staging deployment |

## 4. Server Preparation

| Step | Result | Notes |
| --- | --- | --- |
| SSH access | Passed | Existing deployment SSH key worked after retry |
| Install Git | Passed | Server did not have `git`; installed `git 2.43.7` via system package manager |
| Prepare code directory | Passed | Repository cloned / updated at `/opt/subscription-saas` |
| Checkout main | Passed | Server `main` at `9572aa8` |
| Create `.env.staging` | Passed | Generated on server with random secrets; content was not printed or committed |
| Compose config | Passed | `docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging config` passed |
| Caddy port adjustment | Passed with note | A server-only compose copy removed `80:80` because host Nginx already owns port `80` |
| Redis / Postgres container recovery after reboot | Passed | Host Redis / PgSQL were stopped and disabled from autostart; Docker `subscription-saas-redis` and `subscription-saas-postgres` are healthy |

## 5. Build Attempts

| Attempt | Swap | Result | Notes |
| --- | --- | --- | --- |
| Attempt 1 | `2G total` | Failed | API image built; Web / Next.js production build triggered OOM |
| Attempt 2 | `4G total` | Failed | API image reused cache; Web / Next.js production build again triggered OOM |

Current image state:

| Image | Result |
| --- | --- |
| `subauto-staging-api:latest` | Built successfully, about `1.1GB` |
| `subauto-staging-web:latest` | Not built |

Runtime was not started because the Web image build failed.

## 6. OOM Evidence

First attempt OOM evidence:

```text
2026-06-14 16:29:27 CST oom-kill
2026-06-14 16:29:27 CST Out of memory: Killed process docker
2026-06-14 16:29:27 CST Out of memory: Killed process nginx
2026-06-14 16:29:28 CST Out of memory: Killed process tuned
```

Second attempt with 4G swap still OOMed:

```text
2026-06-14 17:41:23 CST oom-kill
2026-06-14 17:41:23 CST Out of memory: Killed process postgres
2026-06-14 17:41:23 CST Out of memory: Killed process nginx
```

Resource snapshot after the second failed build attempt:

| Metric | Observation |
| --- | --- |
| RAM | `1.8Gi total`, about `905Mi used`, `965Mi available` after recovery |
| Swap | `4.0Gi total`, about `119Mi used` after recovery |
| Disk | `40G total`, `22G available` |
| Nginx | Restarted after OOM and confirmed listening on `80` / `888` |
| Docker PostgreSQL / Redis | Restarted / healthy after OOM recovery |

## 7. Database, Seed, Smoke, Backup

These steps were not executed because the deployment stopped at Docker build OOM.

| Item | Result | Notes |
| --- | --- | --- |
| PostgreSQL staging container | Not run | Stopped before `up -d` |
| `migrate deploy` | Not run | Blocked by image build failure |
| `migrate status` | Not run | Blocked by image build failure |
| Baseline seed | Not run | Blocked by image build failure |
| `pnpm smoke:api` | Not run | Blocked by image build failure |
| `pnpm smoke:mainline` | Not run | Blocked by image build failure |
| `pnpm smoke:residual` | Not run | Blocked by image build failure |
| Web route smoke | Not run | Blocked by image build failure |
| Backup | Not run | Blocked by image build failure |
| Restore drill | Not run | Blocked by image build failure |

## 8. Upload Storage

| Item | Result |
| --- | --- |
| Current staging storage | `local uploads volume` |
| Object storage supported by code | `No` |
| Stage 9G required | `Yes, if production needs durable material uploads` |
| Production blocker status | Open unless production explicitly accepts single-server local upload volume risk |

## 9. Issues

| Severity | Issue | Status | Recommendation |
| --- | --- | --- | --- |
| P0 | Web image cannot be built on the 2C / 2G server even after increasing total swap to 4G | Open | Stop server-side image builds; build images outside the server and deploy by registry pull |
| P1 | Host BT / Nginx already owns port `80`, while the Stage 9F-B compose assumes Caddy owns `80` / `443` | Open | Decide one reverse proxy owner for staging: use BT/Nginx reverse proxy, or stop/migrate host Nginx and let Caddy own both ports |
| P1 | HTTPS was not validated | Open | Requires successful runtime deployment and reverse proxy / certificate completion |
| P1 | Migration, seed, smoke, backup, and restore were not run | Open | Resume after image build strategy is fixed |
| P1 | Uploads still use local volume | Open | Complete Stage 9G Aliyun OSS adapter before production if durable uploads are required |

## 10. Resume Point

Do not keep increasing swap as the primary path.
The next 9F-C attempt should switch to an external image build strategy:

1. Build `api` and `web` images outside the 2G server, preferably in CI or on a local machine.
2. Push images to a private registry.
3. Update staging compose to use `image:` plus `pull`, not server-side `build:`.
4. Keep the server focused on `docker compose pull`, `up -d`, migration, seed, smoke, backup, and resource validation.

Reverse proxy decision is still required:

1. keep host Nginx and configure it to proxy staging domains to API/Web containers;
2. or migrate existing host sites away from Nginx and let Caddy own both `80` and `443`.

After the image strategy is fixed, rerun:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging config
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging pull
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging up -d
```

Then continue with migration, baseline seed, HTTPS health checks, smoke, scenario seed, backup, restore drill, and resource checks.

## 10.1 Stage 9F-C2 Fix Plan

Root cause:

```text
The 2 CPU / 2 GB staging server cannot reliably build the Web / Next.js image.
The build failed again after total swap was increased to 4 GB.
```

Fix plan:

```text
Use prebuilt API/Web images and registry deployment.
Build images locally or in CI.
Push images to a private registry.
Let the staging server only run docker compose pull and docker compose up -d.
```

Image-based deployment assets:

```text
docker-compose.staging.images.example.yml
.env.staging.images.example
docs/image-registry-deployment.md
.github/workflows/docker-images.yml
```

Nginx / Caddy decision:

```text
Existing BT / Nginx owns public HTTP/HTTPS ports on this server.
Staging should use BT / Nginx as the edge HTTPS reverse proxy.
Caddy is not used on this server unless BT / Nginx is intentionally removed or migrated.
```

Nginx proxy target:

```text
staging-admin.subauto.keybox.cloud -> http://127.0.0.1:3000
staging-api.subauto.keybox.cloud   -> http://127.0.0.1:3001
```

Next action:

```text
Re-execute Stage 9F-C with docker-compose.staging.images.example.yml.
Do not build the Web image on the staging server.
Continue with migrate deploy, baseline seed, smoke, scenario seed, backup, restore drill, and resource checks after pull/up succeeds.
```

## 10.2 Stage 9F-C-R2 Registry Pull Deployment Result

This section records the second staging actual deployment run using the registry pull path.
It supersedes the blocked runtime result in sections 5 to 10 for the current staging state.

| Item | Result |
| --- | --- |
| Deployment path | Registry pull, no server-side Web build |
| GitHub Actions run | `27502166191` |
| Server commit | `c028059` |
| API image | `ghcr.io/keqi119/subscription-api:c028059` |
| Web image | `ghcr.io/keqi119/subscription-web:c028059` |
| Compose project | `subauto-staging-r2` |
| Postgres image | `postgres:17-alpine` |
| Upload storage | Local Docker volume, still a Stage 9G production blocker |

### R2 Fixes Applied

| Fix | Result |
| --- | --- |
| API image startup | Changed API image startup from runtime `pnpm` to direct `node apps/api/dist/src/main.js` |
| Shared runtime dependencies | API image now copies `packages/shared/node_modules` so `zod` is available at runtime |
| Docker bridge firewall | Added current staging bridge `br-f46259609cb5` to firewalld `docker` zone |
| Nginx HTTP proxy | Added BT/Nginx HTTP proxy for staging domains to `127.0.0.1:3000` and `127.0.0.1:3001` |

### R2 Runtime Result

| Check | Result | Notes |
| --- | --- | --- |
| `docker compose config` | Passed | Image-based compose resolved API/Web/Postgres images |
| `docker pull` | Passed with slow API pull | API image pull exceeded one SSH wait but image landed successfully |
| `docker compose up -d` | Passed | API/Web/Postgres started from registry images |
| Container health | Passed | API, Web, and Postgres are healthy |
| API local health | Passed | `http://127.0.0.1:3001/api/health` returned 200 |
| Web local health | Passed | `http://127.0.0.1:3000` returned 200 |
| Nginx local proxy | Passed | Host-header checks for staging API/Admin returned 200 on server-local Nginx |
| External public HTTP/HTTPS | Pending | Local external TCP checks to `139.196.227.195:80/443` failed; server-local Nginx and firewalld are OK, cloud/upstream path needs recheck |

### R2 Database, Seed, Smoke, Backup

| Step | Result | Notes |
| --- | --- | --- |
| `migrate deploy` | Passed | 35 migrations applied |
| `migrate status` | Passed | Database schema is up to date |
| Prisma OpenSSL warning | Non-blocking warning | CLI warned OpenSSL could not be detected in the image; migration still completed |
| Baseline seed | Passed | `node prisma/seed.mjs` completed |
| Baseline seed verification | Passed | Verified baseline vehicles, catalog, users, and absence of old complex flow data |
| Admin smoke password | Staging-only reset | Existing admin password did not match smoke default; reset to `Admin@123456` for smoke, must be changed immediately after validation |
| `smoke:api` equivalent | Passed | Ran through SSH tunnel against API/Web local ports |
| `smoke:mainline` equivalent | Passed | Mainline scenario customer/application/vehicle checks passed; quote/order/contract skipped by scenario design |
| `smoke:residual` equivalent | Passed | Residual vehicle/curve/forecast/valuation review checks passed |
| Scenario cleanup after smoke | Passed | SCN9 scenario data was cleaned |
| Backup | Passed | `backups/staging-20260614232549.sql`, size `404K` |
| Restore drill | Not executed | Must be executed or explicitly waived before production cutover |

### R2 Resource Snapshot

| Item | Observation |
| --- | --- |
| API memory | `147.4MiB / 512MiB` |
| Web memory | `59.73MiB / 512MiB` |
| Postgres memory | `37.57MiB / 512MiB` |
| Host memory | `1.8Gi total`, `564Mi available` |
| Swap | `4.0Gi total`, `310Mi used` |
| Disk | `/dev/vda3 40G total`, `19G used`, `19G available` |

### R2 Remaining Gates

| Gate | Status | Recommendation |
| --- | --- | --- |
| Public `80/443` reachability | Open | Recheck cloud security group / upstream path because server-local Nginx works but external TCP check failed |
| HTTPS certificate | Open | Use BT panel or certbot to issue staging certificates, then rerun public Web route smoke |
| Restore drill | Open | Run restore drill on staging or document explicit waiver before production cutover |
| Upload object storage | Open | Complete Stage 9G Aliyun OSS adapter before production if uploads must be durable beyond single-server volume |
| Default admin password | Open | Change `admin` password immediately after smoke; do not leave `Admin@123456` on staging |

## 11. Decision

```text
Can enter Stage 9G: Yes
Can enter Production Cutover: No

Reason:
Stage 9F-C-R2 completed the registry-pull staging runtime path:
containers are healthy, migration passed, baseline seed and seed verification passed,
API/Web/mainline/residual smoke passed, scenario cleanup passed, and pg_dump backup passed.

Production cutover is still blocked by public 80/443 reachability validation, HTTPS certificate completion,
restore drill or waiver, and the upload storage decision. Since production requires object storage for uploads,
Stage 9G Aliyun OSS Upload Storage Adapter remains the recommended next stage before production cutover.
```

## 12. Stage 9G-B Real OSS Bucket Validation

This section records the real OSS bucket validation pass for upload storage.

Current status:

```text
Prepared, not completed.
```

### 12.1 Prepared Assets

| Item | Result |
| --- | --- |
| Stage 9G-A adapter | Included in `main` at `c40033a` |
| Upload smoke script | Added `pnpm smoke:upload` |
| Upload smoke result file | `.tmp/upload-storage-smoke.json` |
| Restart validation mode | `pnpm smoke:upload -- --download-only` |
| Real OSS secret handling | Must stay in server `.env.staging.images`; not committed |

### 12.2 Current Staging State

| Item | Observation |
| --- | --- |
| Server repository commit | `c028059` at time of check |
| Current API image | `ghcr.io/keqi119/subscription-api:c028059` |
| Current Web image | `ghcr.io/keqi119/subscription-web:c028059` |
| Upload driver | `UPLOAD_STORAGE_DRIVER=local` |
| Stage 9G-A API image rollout | Pending |
| Real OSS bucket env | Pending server-only configuration |
| GitHub Actions trigger | Blocked locally because `gh` token is invalid |

### 12.3 Required Validation Steps

| Step | Expected Result | Status |
| --- | --- | --- |
| Build/push API image for `c40033a` or newer | Registry image available | Pending |
| Roll out API image on staging | API healthy with Stage 9G-A code | Pending |
| Set `UPLOAD_STORAGE_DRIVER=oss` | `/api/health` reports `storage: "oss"` | Pending |
| Configure private OSS bucket and RAM key | Server env configured, no secret in Git | Pending |
| Run `pnpm seed:scenario mainline` | Scenario application available | Pending |
| Run `pnpm smoke:upload` | Upload/download succeeds through API stream | Pending |
| Inspect upload response and headers | No OSS public URL exposed | Pending |
| Restart API and run `pnpm smoke:upload -- --download-only` | Same uploaded object still downloads | Pending |
| Verify local upload volume | New OSS file is not dependent on local upload volume | Pending |
| Run `pnpm seed:scenario cleanup` | Scenario data cleaned | Pending |

### 12.4 Decision

```text
OSS blocker is not closed yet.

Reason:
Stage 9G-A code is merged, but staging has not yet been switched to an image containing
the OSS adapter and has not been configured with a real private OSS bucket. Real upload,
download, restart persistence, and public URL exposure checks remain pending.
```
