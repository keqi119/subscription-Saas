# Object Storage Readiness

Stage 9G-A implements the backend storage abstraction and Aliyun OSS adapter needed for durable upload storage. Stage 9G-B validated the adapter against a real private staging OSS bucket on 2026-06-15. Production cutover still needs production-specific OSS bucket and RAM credential verification.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| Storage abstraction | Ready | `StorageService` routes uploads/downloads to local or OSS providers. |
| Local provider | Ready | Default driver for local development and dry runs. |
| Aliyun OSS provider | Ready | Uses `ali-oss`; tests mock the client in CI and staging validation used a real private bucket. |
| Customer material upload | Ready | Existing upload API stores through `StorageService`. |
| Customer material preview/download | Ready | Existing preview APIs stream from local disk or OSS through the API. |
| Real OSS bucket validation | Passed for staging | `UPLOAD_STORAGE_DRIVER=oss`, upload smoke, API stream download, API restart download, and local volume dependency checks passed on staging. |
| Historical local file migration | Not included | Existing local uploads need a separate migration plan if they must be retained. |

## Driver Modes

`UPLOAD_STORAGE_DRIVER=local`

- Uses `UPLOAD_LOCAL_DIR`, falling back to `LOCAL_FILE_STORAGE_DIR`, then `./uploads`.
- Keeps existing local development behavior.
- Suitable for local development and staging deployment dry runs.

`UPLOAD_STORAGE_DRIVER=oss`

- Uploads customer material files to Aliyun OSS.
- Stores `FileObject.bucket` as `oss:<bucket>`.
- Stores `FileObject.objectKey` as `oss:<object-key>`.
- Streams downloads through the existing API preview endpoints.
- Does not expose permanent public OSS URLs.

## Required OSS Env

```text
UPLOAD_STORAGE_DRIVER=oss

OSS_REGION=oss-cn-shanghai
OSS_BUCKET=<CHANGE_ME>
OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com
OSS_ACCESS_KEY_ID=<CHANGE_ME>
OSS_ACCESS_KEY_SECRET=<CHANGE_ME>
OSS_PREFIX=subscription-saas/staging
OSS_INTERNAL_ENDPOINT=
OSS_SIGNED_URL_EXPIRES_SECONDS=300
```

Keep the bucket private. The API should read from OSS and stream files to authenticated callers.

## Object Key Strategy

Customer material object keys use this shape:

```text
<OSS_PREFIX>/materials/<applicationId>/<yyyy>/<mm>/<uuid>-<sanitized-original-name>
```

The key:

- never stores an absolute path;
- rejects path traversal;
- preserves a sanitized extension;
- stores the original file name in the existing database fields.

## Stage 9G-B Validation

Before production cutover, staging must prove:

```text
UPLOAD_STORAGE_DRIVER=oss
private OSS bucket configured
customer material upload succeeds
customer material preview/download succeeds
API response streams the file without exposing public bucket URLs
container restart does not lose uploaded material
smoke:api/mainline/residual still pass
bucket policy is not public-read
```

Reusable smoke command:

```bash
SMOKE_API_BASE_URL=https://staging-api.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD=<staging-admin-password> \
SMOKE_SCENARIO_FILE=.tmp/scenarios/mainline.json \
SMOKE_EXPECT_STORAGE_DRIVER=oss \
pnpm smoke:upload
```

After an API restart, verify the same uploaded object:

```bash
SMOKE_API_BASE_URL=https://staging-api.subauto.keybox.cloud \
SMOKE_ADMIN_USERNAME=admin \
SMOKE_ADMIN_PASSWORD=<staging-admin-password> \
SMOKE_EXPECT_STORAGE_DRIVER=oss \
pnpm smoke:upload -- --download-only
```

Current Stage 9G-B execution status:

```text
Completed for staging.
```

Validated on staging:

- staging server `.env.staging.images` was switched to `UPLOAD_STORAGE_DRIVER=oss`;
- real OSS bucket, endpoint, RAM AccessKey ID, and RAM AccessKey Secret were configured only on the server;
- `/api/health` reported `storage: "oss"`;
- `pnpm smoke:upload` equivalent passed inside the API container;
- uploaded customer material was saved with `FileObject.bucket = oss:<masked>` and an `oss:subscription-saas/staging/materials/...` object key;
- API preview/download streamed the object content back without exposing a public OSS URL;
- API restart followed by download-only smoke passed for the same uploaded object;
- local upload directories contained no `stage9g-upload-smoke-*` file after OSS-mode upload.

Current staging rollout note:

- API/Web images `ghcr.io/keqi119/subscription-api:d3cdc5e` and `ghcr.io/keqi119/subscription-web:d3cdc5e` are running and healthy.
- A staging-only smoke user `stage9_smoke_admin` was created with ADMIN role by explicit operator approval for validation. Remove it or rotate its password before production cutover.
- Public HTTPS health for `staging-api.subauto.keybox.cloud` still belongs to the separate Stage 9F-C-R3 public 80/443 / BT-Nginx gate.

## Production Cutover Gate

Production cutover remains blocked until:

- production OSS bucket credentials are configured outside Git;
- upload/download smoke passes against the target production OSS bucket or an approved production-equivalent bucket;
- bucket lifecycle and backup expectations are documented;
- any required historical local upload migration is either completed or explicitly waived.
