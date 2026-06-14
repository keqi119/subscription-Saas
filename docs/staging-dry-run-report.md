# Staging Dry Run Report

Use this template for Stage 9F-C actual staging server execution.

## 1. Basic Information

| Item | Value |
| --- | --- |
| Server region | Mainland China - Shanghai East China |
| Server IP | `139.196.227.195` |
| ICP filing | `沪ICP备18045696号` |
| Admin domain | `staging-admin.subauto.keybox.cloud` |
| API domain | `staging-api.subauto.keybox.cloud` |
| Deployment time | `<YYYY-MM-DD HH:mm>` |
| Git commit | `<COMMIT_SHA>` |
| Release / RC tag | `<TAG>` |
| Operator | `<NAME>` |

## 2. Build and Runtime

| Item | Result | Notes |
| --- | --- | --- |
| Image build method | `<server build / CI build / local build>` |  |
| Docker version | `<VERSION>` |  |
| Docker Compose version | `<VERSION>` |  |
| `.env.staging` created on server | `<Passed / Failed>` | Do not paste secrets |
| `docker compose config` | `<Passed / Failed>` |  |
| `docker compose build` | `<Passed / Failed>` |  |
| `docker compose up -d` | `<Passed / Failed>` |  |

## 3. Database

| Item | Result | Notes |
| --- | --- | --- |
| PostgreSQL container healthy | `<Passed / Failed>` |  |
| `migrate deploy` | `<Passed / Failed>` |  |
| `migrate status` | `<Passed / Failed>` |  |
| baseline seed | `<Passed / Failed>` |  |
| scenario seed cleanup | `<Passed / Failed / Not run>` |  |

## 4. Smoke and Web Routes

| Check | Result | Notes |
| --- | --- | --- |
| `GET /api/health` | `<Passed / Failed>` |  |
| `pnpm smoke:api` | `<Passed / Failed>` |  |
| `pnpm smoke:mainline` | `<Passed / Failed / Not run>` |  |
| `pnpm smoke:residual` | `<Passed / Failed / Not run>` |  |
| `/` | `<Passed / Failed>` |  |
| `/applications` | `<Passed / Failed>` |  |
| `/vehicles` | `<Passed / Failed>` |  |
| `/orders` | `<Passed / Failed>` |  |
| `/reports` | `<Passed / Failed>` |  |
| `/reports/asset-profitability` | `<Passed / Failed>` |  |
| `/residual-market` | `<Passed / Failed>` |  |
| `/vehicle-valuation-reviews` | `<Passed / Failed>` |  |

## 5. Backup and Restore

| Item | Result | Notes |
| --- | --- | --- |
| backup script executed | `<Passed / Failed>` |  |
| backup file path | `<PATH>` | Do not commit |
| restore drill executed | `<Passed / Failed / Waived>` |  |
| post-restore migrate status | `<Passed / Failed / Not run>` |  |
| post-restore smoke | `<Passed / Failed / Not run>` |  |

## 6. Resource Usage

| Metric | Observation |
| --- | --- |
| RAM usage | `<VALUE>` |
| Swap configured | `<Yes / No>` |
| CPU load | `<VALUE>` |
| Disk usage | `<VALUE>` |
| PostgreSQL logs | `<OK / Issues>` |
| API logs | `<OK / Issues>` |
| Web logs | `<OK / Issues>` |
| Caddy logs | `<OK / Issues>` |

## 7. Upload Storage

| Item | Result |
| --- | --- |
| Current staging storage | `local uploads volume` |
| Object storage supported by code | `No` |
| Stage 9G required | `Yes, if production needs durable material uploads` |

## 8. Issues

| Severity | Issue | Owner | Status |
| --- | --- | --- | --- |
| `<P0/P1/P2>` | `<Issue>` | `<Owner>` | `<Open / Closed>` |

## 9. Decision

```text
Can enter Production Cutover: <Yes / No>
Reason:
<summary>
```
