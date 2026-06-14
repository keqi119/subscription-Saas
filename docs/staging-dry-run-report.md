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

## 11. Decision

```text
Can enter Production Cutover: No

Reason:
Stage 9F-C actual staging deployment did not complete. DNS, server preparation, swap expansion to 4G,
git installation, code checkout, env creation, and compose config passed, but server-side Web image
build still failed due to OOM. Runtime, migration, seed, smoke, backup, and restore checks remain unverified.
Production cutover must wait for an external image build / registry pull strategy and a completed staging deployment run.
```
