# Stage 9F-F0 Production Image Rebuild Report

This report records the production image rebuild fix after Stage 9F-F stopped
before production cutover. No production cutover was executed in this stage.

## 1. Summary

| Field | Value |
| --- | --- |
| Stage | 9F-F0 Production Image Rebuild Fix |
| Execution time | `2026-06-15 23:37:38 +08:00` |
| Source commit for images | `5e8d04a` |
| Production API base baked into Web | `https://api.subauto.keybox.cloud/api` |
| Production cutover executed | No |
| DNS changed | No |
| Production compose started | No |
| Production migrate / seed executed | No |

## 2. Old Blocked Image

| Image | Digest | Status | Reason |
| --- | --- | --- | --- |
| `ghcr.io/keqi119/subscription-web:d3cdc5e` | `ghcr.io/keqi119/subscription-web@sha256:14e0b77862963fb69d1552e9f3cd872861eb4e8c2bf529c8f734fac5dd664574` | Blocked for production | Bundle contains `https://staging-api.subauto.keybox.cloud/api` |

The old `d3cdc5e` Web image remains valid as staging evidence, but it must not
be used for production cutover.

## 3. New Production Images

| Image | Tag | Digest |
| --- | --- | --- |
| API | `ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a` | `ghcr.io/keqi119/subscription-api@sha256:af3908801186ddd2ca7cbbf69029bddd7613d77d4061173011ce6276603f9eb9` |
| Web | `ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a` | `ghcr.io/keqi119/subscription-web@sha256:ad0db73e9d8ad3ba72ec6524d716f2b9e39546691d302bc7951d5dcec696b9c3` |

Build method:

```text
Local Docker build and push to GHCR.
```

Commands used:

```text
docker build -f Dockerfile.api -t ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a .
docker build -f Dockerfile.web --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.subauto.keybox.cloud/api -t ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a .
docker push ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a
docker push ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a
```

No registry password or token is recorded.

## 4. Bundle Check Result

The new Web image was checked with:

```text
node scripts/check-web-bundle-api-base.mjs --dir <extracted .next> --must-contain https://api.subauto.keybox.cloud/api --must-not-contain staging-api.subauto.keybox.cloud
```

Result:

```text
Passed
```

Findings:

```text
Contains https://api.subauto.keybox.cloud/api: Yes
Contains staging-api.subauto.keybox.cloud: No
```

The bundle was extracted from:

```text
/app/apps/web/.next
```

## 5. Build Guardrails Added

Stage 9F-F0 added guardrails to prevent this blocker from recurring:

- `.github/workflows/docker-images.yml` no longer defaults Web builds to the staging API base;
- workflow dispatch now requires explicit `apiBaseUrl`, `imageTag`, and `environment`;
- production workflow builds fail if `apiBaseUrl` contains `staging`;
- `Dockerfile.web` fails the build if `NEXT_PUBLIC_API_BASE_URL` is empty;
- `scripts/check-web-bundle-api-base.mjs` checks extracted Web bundles for required and forbidden API base strings;
- `.dockerignore` excludes nested workspace build and dependency directories so local Docker builds are not polluted by host `node_modules`.

## 6. Cutover Recommendation

Stage 9F-F can be retried only with:

```text
API_IMAGE=ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a
WEB_IMAGE=ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a
```

Before restarting production cutover, repeat the Web bundle check from the
registry-pulled image and confirm the production server can pull both tags.

## 7. Final Decision

```text
Production image rebuild: Complete
Production cutover: Not executed
Can retry Stage 9F-F: Yes, using only prod-20260615-5e8d04a images
```
