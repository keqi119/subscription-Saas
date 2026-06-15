# Production Cutover Checklist

Stage 9F-B should start only after this Stage 9F-A dry run passes.
This checklist is a release-time control document, not a new feature plan.

Production cutover must not start until the staging dry run has been completed and recorded.

## 0. Staging Gate

- [ ] `staging-admin.subauto.keybox.cloud` resolves to `139.196.227.195`.
- [ ] `staging-api.subauto.keybox.cloud` resolves to `139.196.227.195`.
- [ ] Public TCP `80/443` reaches the staging edge from an external network.
- [ ] BT / Nginx or the chosen edge proxy issues valid HTTPS certificates for both staging domains.
- [ ] Staging `docker compose config` passes.
- [ ] Staging API and Web containers start successfully.
- [ ] Staging `migrate deploy` succeeds.
- [ ] Staging baseline seed succeeds.
- [ ] Staging smoke checks pass.
- [ ] Staging backup succeeds.
- [ ] Staging restore drill is completed or formally waived.
- [ ] Object storage readiness is documented in `docs/object-storage-readiness.md`.
- [ ] Stage 9G-B real OSS bucket staging validation has passed, or local uploads volume risk is formally accepted.
- [ ] Stage 9G-A OSS adapter is included in the release build.
- [ ] Real OSS bucket is configured for staging with `UPLOAD_STORAGE_DRIVER=oss`.
- [ ] `pnpm smoke:upload` passes against the private OSS bucket.
- [ ] `pnpm smoke:upload -- --download-only` passes after API restart.
- [ ] OSS bucket is not public-read.
- [ ] API streams OSS downloads and does not expose permanent public bucket URLs.
- [ ] Staging-only smoke users are removed or passwords rotated before production cutover.
- [ ] 2 GB RAM resource limits and swap guidance have been verified.
- [ ] Image build strategy is registry pull for the current 2 CPU / 2 GB server.
- [ ] Server does not build the Web / Next.js image during cutover.
- [ ] API image tag and Web image tag match the release commit or release tag.
- [ ] Registry credentials are injected on the server only and are not committed to Git.
- [ ] BT / Nginx reverse proxy config has been verified for staging domains.
- [ ] API and Web host bindings are limited to `127.0.0.1`.
- [ ] PostgreSQL and other database ports are not exposed to the public internet by cloud security group, host firewall, or Docker publishing.
- [ ] Caddy and BT / Nginx are not competing for `80` / `443`.
- [ ] No admin IP allowlist is enabled; HTTPS, strong passwords, RBAC, CORS, secure cookies, and security groups are confirmed.
- [ ] ICP filing is confirmed: `沪ICP备18045696号`.

## 1. Release Identity

| Item | Value |
| --- | --- |
| Release tag | `<RC_OR_RELEASE_TAG>` |
| Git commit | `<COMMIT_SHA>` |
| Cutover date | `<YYYY-MM-DD>` |
| Target environment | `production` |
| Owner | `<OWNER>` |
| Verifier | `<VERIFIER>` |
| Rollback owner | `<ROLLBACK_OWNER>` |

## 2. Domain and ICP

- [ ] `keybox.cloud` ICP filing is confirmed.
- [ ] ICP record is recorded: `沪ICP备18045696号`.
- [ ] `admin.subauto.keybox.cloud` points to `<PRODUCTION_SERVER_IP>`.
- [ ] `api.subauto.keybox.cloud` points to `<PRODUCTION_SERVER_IP>`.
- [ ] `subauto.keybox.cloud` points to `<PRODUCTION_SERVER_IP>` or is intentionally deferred.
- [ ] DNS TTL has been lowered before cutover if supported.

## 3. Environment and Secrets

- [ ] `.env.production` exists only on the server.
- [ ] No real secret is committed to Git.
- [ ] `DATABASE_URL` points to the intended production database.
- [ ] `JWT_SECRET` is a long production secret.
- [ ] `COOKIE_SECRET` is a long production secret.
- [ ] `CORS_ORIGIN=https://admin.subauto.keybox.cloud`.
- [ ] `NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api`.
- [ ] `NODE_ENV=production`.
- [ ] If production uploads must be durable, `UPLOAD_STORAGE_DRIVER=oss`.
- [ ] OSS bucket, endpoint, prefix, and RAM AccessKey are configured outside Git.
- [ ] Production OSS bucket/env is verified separately from the staging bucket/env.
- [ ] Historical local upload migration is completed or explicitly waived.

## 4. Backup

- [ ] Pre-cutover `pg_dump` completed.
- [ ] Backup file name recorded.
- [ ] Backup file stored outside Git.
- [ ] Restore procedure reviewed.
- [ ] Rollback window agreed.

## 5. Migration

- [ ] `pnpm prisma:validate` passed.
- [ ] `pnpm prisma:migrate:status` checked before deploy.
- [ ] `prisma migrate deploy` completed.
- [ ] `pnpm prisma:migrate:status` checked after deploy.
- [ ] No `prisma migrate reset` used.
- [ ] No `prisma db push` used.

## 6. Seed

- [ ] Baseline seed executed only if approved.
- [ ] Default seed remains baseline master data only.
- [ ] Scenario seed was not run in production.
- [ ] Initial admin password changed after first login.

## 7. Services

- [ ] PostgreSQL service healthy.
- [ ] API service healthy.
- [ ] Web service healthy.
- [ ] Reverse proxy healthy.
- [ ] Upload volume mounted for API.
- [ ] Container restart policy configured.
- [ ] Registry image deployment path is documented in `docs/image-registry-deployment.md`.
- [ ] If using image-based compose, API and Web publish only to `127.0.0.1`.

## 8. HTTPS

- [ ] `https://admin.subauto.keybox.cloud` opens.
- [ ] `https://api.subauto.keybox.cloud/api/health` returns OK.
- [ ] Certificate issuer and expiry checked.
- [ ] HTTP redirects or upgrades to HTTPS as expected.
- [ ] Browser cookie is secure in production.

## 9. Smoke

- [ ] `pnpm smoke:api` passed with production base URLs.
- [ ] Web route smoke passed for:
  - [ ] `/`
  - [ ] `/applications`
  - [ ] `/vehicles`
  - [ ] `/orders`
  - [ ] `/reports`
  - [ ] `/reports/asset-profitability`
  - [ ] `/residual-market`
  - [ ] `/vehicle-valuation-reviews`
- [ ] `smoke:mainline` and `smoke:residual` passed in dry-run or acceptance environment.
- [ ] Scenario cleanup completed after dry-run smoke.

## 10. Manual Acceptance

- [ ] Admin login.
- [ ] Permission refresh after login.
- [ ] A/B application entry path spot check.
- [ ] Quote / order / contract pages spot check.
- [ ] Initial billing / payment pages spot check.
- [ ] Delivery and return pages spot check.
- [ ] Deposit and damage settlement pages spot check.
- [ ] Reports dashboard.
- [ ] Asset profitability report.
- [ ] Residual market page.
- [ ] Valuation review page.
- [ ] CSV export spot check.
- [ ] Audit logs spot check.

## 11. Logs and Monitoring

- [ ] API logs checked.
- [ ] Web logs checked.
- [ ] Reverse proxy logs checked.
- [ ] PostgreSQL logs checked.
- [ ] Error rate reviewed.
- [ ] Disk usage checked.
- [ ] Backup schedule checked.

## 12. Release Blockers

Cutover must stop or roll back if any item is true:

- [ ] `release:check` fails.
- [ ] migration fails.
- [ ] `migrate status` is abnormal.
- [ ] API or Web cannot start.
- [ ] admin login fails.
- [ ] smoke fails.
- [ ] HTTPS certificate fails.
- [ ] permissions or menus are broadly incorrect.
- [ ] default seed creates complex business flow data.
- [ ] backup is missing or restore path is unclear.

## 13. Completion Record

| Item | Value |
| --- | --- |
| Cutover result | `<Passed / Rolled back / Deferred>` |
| Final release tag | `<TAG>` |
| Final commit | `<SHA>` |
| Backup file | `<BACKUP_FILE>` |
| Smoke result | `<RESULT>` |
| Manual verifier | `<NAME>` |
| Notes | `<NOTES>` |
