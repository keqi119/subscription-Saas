# Object Storage Readiness

Stage 9F-B includes a code-level documentation audit for upload storage.
No upload storage adapter is implemented in this stage.

## Current Finding

Current upload implementation is local-disk only.

Evidence:

- `apps/api/src/customer/customer.controller.ts` uses `AnyFilesInterceptor()` for material uploads.
- `apps/api/src/customer/customer.service.ts` calls `saveLocalFile(file)` for each uploaded material file.
- `saveLocalFile()` writes buffers with `writeFile()` under `LOCAL_FILE_STORAGE_DIR`.
- `resolveLocalFilePath()` reads from the same local directory.
- `apps/api/src/app.service.ts` health response reports `storage: "local"`.
- Existing env examples only configure `LOCAL_FILE_STORAGE_DIR`.

## Not Found

The current code does not include:

- OSS adapter;
- S3 adapter;
- upload storage interface abstraction;
- object storage env variables read by runtime code;
- presigned upload / download URL flow;
- background migration from local files to object storage.

## Staging Decision

Stage 9F-B staging deployment should use a Docker named volume:

```text
staging_api_uploads -> /app/uploads
LOCAL_FILE_STORAGE_DIR=/app/uploads
UPLOAD_STORAGE_DRIVER=local
```

This is acceptable for staging dry run only.

## Production Risk

Local upload volume is risky for production because:

- files are tied to one server;
- backup and restore must include both PostgreSQL and upload volume;
- server replacement can lose attachments if the volume is not migrated;
- horizontal scaling cannot share files without a shared storage layer.

## Stage 9G Blocker

If production requires durable customer material uploads, Stage 9G must implement Aliyun OSS upload storage before production cutover.

Minimum Stage 9G scope:

- storage adapter interface;
- local adapter for development;
- Aliyun OSS adapter for staging/production;
- env names for OSS region, bucket, endpoint, access key id, and access key secret;
- upload and preview/download path compatibility;
- backup / lifecycle / permission documentation;
- migration plan for existing local uploads if needed.

Until Stage 9G is completed, production cutover must explicitly accept the local-upload-volume risk or block release.
