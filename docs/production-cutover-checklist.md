# Production Cutover Checklist

Stage 9F-B should start only after this Stage 9F-A dry run passes.
This checklist is a release-time control document, not a new feature plan.

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
