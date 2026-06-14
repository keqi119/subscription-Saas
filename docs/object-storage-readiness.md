# Object Storage Readiness

Stage 9G-A implements the backend storage abstraction and Aliyun OSS adapter needed for durable upload storage. Stage 9G-B must still validate a real staging OSS bucket before production cutover.

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| Storage abstraction | Ready | `StorageService` routes uploads/downloads to local or OSS providers. |
| Local provider | Ready | Default driver for local development and dry runs. |
| Aliyun OSS provider | Ready for staging validation | Uses `ali-oss`; tests mock the client and do not connect to real OSS. |
| Customer material upload | Ready | Existing upload API stores through `StorageService`. |
| Customer material preview/download | Ready | Existing preview APIs stream from local disk or OSS through the API. |
| Real OSS bucket validation | Pending Stage 9G-B | Requires actual bucket, RAM credentials, upload smoke, and download smoke. |
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

## Production Cutover Gate

Production cutover remains blocked until:

- real OSS bucket credentials are configured outside Git;
- upload/download smoke passes against staging OSS;
- bucket lifecycle and backup expectations are documented;
- any required historical local upload migration is either completed or explicitly waived.
