# Stage 9F-C Staging Dry Run Report

This report records the actual staging server deployment attempt for Stage 9F-C.
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
| Disk | `/dev/vda3 40G total, 14G used, 24G available after build attempt` |
| Initial swap | `1G` at `/www/swap` |
| Added swap | Added `/swapfile-stage9` `1G` |
| Final swap | `2G total` |
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

## 5. Build and Runtime

| Item | Result | Notes |
| --- | --- | --- |
| Build method | Server build |
| API image build | Passed | Built `subauto-staging-api:latest`, image size about `1.1GB` |
| Web image build | Failed | Next.js production build triggered server OOM |
| `docker compose up -d` | Not run | Stopped after build OOM, per Stage 9F-C rule |
| Runtime containers | Not started | No staging app containers were started |

## 6. OOM Evidence

Server kernel log recorded OOM events during the Web build:

```text
2026-06-14 16:29:27 CST oom-kill
2026-06-14 16:29:27 CST Out of memory: Killed process docker
2026-06-14 16:29:27 CST Out of memory: Killed process nginx
2026-06-14 16:29:28 CST Out of memory: Killed process tuned
```

Resource snapshot after the failed build attempt:

| Metric | Observation |
| --- | --- |
| RAM | `1.8Gi total`, about `981Mi used`, `889Mi available` after failure |
| Swap | `2.0Gi total`, about `1.0Gi used` after failure |
| Disk | `40G total`, `24G available` |
| Nginx | Nginx processes were restarted / still listening on `80`, but `systemctl is-active nginx` reported `inactive` because BT manages the process |

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
| P0 | Web image cannot be built on the 2C / 2G server due to OOM | Open | Build images in CI / local machine and push to a registry, then make the server pull images; or upgrade staging server to at least 2C / 4G |
| P1 | Host BT / Nginx already owns port `80`, while the Stage 9F-B compose assumes Caddy owns `80` / `443` | Open | Decide one reverse proxy owner for staging: use BT/Nginx reverse proxy, or stop/migrate host Nginx and let Caddy own both ports |
| P1 | HTTPS was not validated | Open | Requires successful runtime deployment and reverse proxy / certificate completion |
| P1 | Migration, seed, smoke, backup, and restore were not run | Open | Resume after image build strategy is fixed |
| P1 | Uploads still use local volume | Open | Complete Stage 9G Aliyun OSS adapter before production if durable uploads are required |

## 10. Resume Point

The next 9F-C attempt should start from one of these paths:

1. Preferred: build `api` and `web` images outside the 2G server, push them to a private registry, update staging compose to use `image:` plus `pull`.
2. Alternative: temporarily upgrade the staging server to at least `2C / 4G`, then rerun `docker compose build`.
3. Reverse proxy decision: either configure BT/Nginx to proxy staging domains to API/Web containers, or let Caddy own `80` and `443`.

After the build strategy is fixed, rerun:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging config
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging build
docker compose --env-file .env.staging -f docker-compose.staging.server.yml -p subauto-staging up -d
```

Then continue with migration, baseline seed, HTTPS health checks, smoke, scenario seed, backup, restore drill, and resource checks.

## 11. Decision

```text
Can enter Production Cutover: No

Reason:
Stage 9F-C actual staging deployment did not complete. DNS, server preparation, swap expansion,
git installation, code checkout, env creation, and compose config passed, but server-side Web image
build failed due to OOM. Runtime, migration, seed, smoke, backup, and restore checks remain unverified.
Production cutover must wait for a fixed image build / pull strategy and a completed staging deployment run.
```
