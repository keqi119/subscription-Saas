# Stage 9F-F Production Cutover Execution Report

This report records the Stage 9F-F production cutover attempt. The cutover was
stopped during the mandatory pre-production image checks before any staging
shutdown, production compose startup, production DNS change, migration, seed, or
production smoke.

## 1. Decision And Scope

| Field | Value |
| --- | --- |
| Decision | GO |
| Cutover start time | `2026-06-15 22:12:29 +08:00` |
| Cutover stop time | `2026-06-15 22:22:25 +08:00` |
| Executor | `keqi119` |
| Approver | `keqi119` |
| Rollback owner | `keqi119` |
| Target server | `139.196.227.195` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Execution result | Blocked before production cutover |
| Rollback executed | No; no production changes were applied |

## 2. Target Images

| Image | Tag | Digest | Result |
| --- | --- | --- | --- |
| API | `ghcr.io/keqi119/subscription-api:d3cdc5e` | `ghcr.io/keqi119/subscription-api@sha256:d69dddf3954e645c94dd2eeb5aa777d5a6096880432780213d169203ed7cb42a` | Pulled and inspected |
| Web | `ghcr.io/keqi119/subscription-web:d3cdc5e` | `ghcr.io/keqi119/subscription-web@sha256:14e0b77862963fb69d1552e9f3cd872861eb4e8c2bf529c8f734fac5dd664574` | Pulled, inspected, then rejected |

## 3. Local Release Baseline

`pnpm release:check` passed before production execution:

- Prisma validate passed;
- Prisma generate passed;
- workspace lint passed;
- API typecheck passed;
- Web typecheck passed;
- API tests passed, `533` tests;
- Prisma migrate status passed;
- smoke script syntax passed;
- scenario seed syntax passed.

## 4. Blocking Finding

The mandatory Web image bundle check found the staging API base baked into the
target Web image:

```text
https://staging-api.subauto.keybox.cloud/api
```

The value appears in both client static chunks and server chunks copied from:

```text
/app/apps/web/.next
```

Example matching files:

```text
.next/static/chunks/151h9wmf2enin.js
.next/server/chunks/ssr/_0gssnrn._.js
```

This is a production cutover blocker because the production Web application
would continue sending browser traffic to the staging API instead of:

```text
https://api.subauto.keybox.cloud/api
```

The root cause is build-time configuration, not production runtime env. The Web
client reads `NEXT_PUBLIC_API_BASE_URL`, and `.github/workflows/docker-images.yml`
passes it as a Docker build argument. The workflow dispatch default is currently:

```text
https://staging-api.subauto.keybox.cloud/api
```

The validated staging Web image was therefore correctly built for staging, but
it is not a valid production Web image.

## 5. Actions Not Executed

The following actions were not executed:

- staging backup;
- staging compose shutdown;
- `.env.production.images` creation or modification on the server;
- production compose config, pull, or up;
- production migration;
- production baseline seed;
- production DNS change;
- production BT/Nginx configuration;
- production HTTPS certificate issuance;
- production health, CORS, or smoke;
- default admin password rotation;
- production smoke account creation;
- production baseline backup.

## 6. Environment Impact

No server-side cutover command was executed during this blocked attempt. Staging
was not stopped, production was not started, production DNS was not changed, and
no rollback was required.

## 7. Required Fix Before Retrying

Build and validate a new production Web image with:

```text
NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api
```

The retry must repeat the mandatory bundle check and must not proceed unless the
new Web image has no reference to:

```text
staging-api.subauto.keybox.cloud
```

The production image tag must remain immutable and must not be `latest`. Record
the new API/Web tags and digests in the Go / No-Go record or the next execution
report before retrying Stage 9F-F.

## 8. Final Decision

```text
Production Cutover Complete: No
Stage 9F-F Status: Blocked before execution
Can announce production cutover complete: No
```
