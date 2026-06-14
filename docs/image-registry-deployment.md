# Image Registry Deployment

Stage 9F-C showed that the `2C / 2G RAM` staging server cannot reliably build the Web / Next.js image.
Stage 9F-C2 changes the deployment path to prebuilt images:

```text
local or CI build
  -> push image registry
  -> staging server pull
  -> docker compose up
```

Do not store registry credentials, image registry passwords, or real production secrets in Git.

## 1. Why Registry Deployment

The staging server failed during `Dockerfile.web` / `next build`, even after increasing total swap to `4G`.
The server should run containers, not build the Web production image.

This also separates deployment concerns:

- image build happens in local / CI with enough memory;
- staging server performs `docker compose pull` and `docker compose up -d`;
- BT / Nginx owns public `80` / `443`;
- API and Web bind only to localhost host ports.

## 2. Image Names

Recommended image shape:

```text
<REGISTRY>/<NAMESPACE>/subscription-api:<TAG>
<REGISTRY>/<NAMESPACE>/subscription-web:<TAG>
```

Recommended tag sources:

- release candidate tag, for example `rc-20260613-stage9`;
- short Git SHA;
- release date.

Use the same tag for API and Web when they come from the same commit.

## 3. Registry Options

Any private registry that the server can reach is acceptable:

- Aliyun Container Registry;
- GitHub Container Registry;
- Harbor;
- another private registry.

For Aliyun ACR, image names usually look like:

```text
registry.cn-shanghai.aliyuncs.com/<namespace>/<repo>:<tag>
```

Create namespace, repositories, username, and password in the registry console.
Do not commit those values.

## 4. Local Build and Push

Example commands:

```bash
export REGISTRY="<REGISTRY>"
export NAMESPACE="<NAMESPACE>"
export TAG="rc-20260613-stage9"

docker build -f Dockerfile.api -t "$REGISTRY/$NAMESPACE/subscription-api:$TAG" .
docker build -f Dockerfile.web \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api \
  -t "$REGISTRY/$NAMESPACE/subscription-web:$TAG" .

docker push "$REGISTRY/$NAMESPACE/subscription-api:$TAG"
docker push "$REGISTRY/$NAMESPACE/subscription-web:$TAG"
```

If the Web public API URL changes, rebuild and push the Web image.

## 5. Server Pull and Up

On the staging server:

```bash
cd /opt/subscription-saas
cp .env.staging.images.example .env.staging.images
chmod 600 .env.staging.images
nano .env.staging.images
```

Fill:

```text
API_IMAGE=<REGISTRY>/<NAMESPACE>/subscription-api:<TAG>
WEB_IMAGE=<REGISTRY>/<NAMESPACE>/subscription-web:<TAG>
POSTGRES_PASSWORD=<strong password>
DATABASE_URL=postgresql://subscription_saas:<same password>@postgres:5432/subscription_saas_staging?schema=public
JWT_SECRET=<strong secret>
COOKIE_SECRET=<strong secret>
SEED_ADMIN_PASSWORD=<initial admin password>
SMOKE_ADMIN_PASSWORD=<initial admin password>
```

Then:

```bash
docker login <REGISTRY>

docker compose \
  --env-file .env.staging.images \
  -f docker-compose.staging.images.example.yml \
  -p subauto-staging \
  pull

docker compose \
  --env-file .env.staging.images \
  -f docker-compose.staging.images.example.yml \
  -p subauto-staging \
  up -d
```

The compose file binds:

```text
Web -> 127.0.0.1:3000
API -> 127.0.0.1:3001
```

BT / Nginx should proxy public staging domains to those localhost ports.

## 6. GitHub Actions Option

The optional `docker-images.yml` workflow is manual-only via `workflow_dispatch`.
It requires registry credentials through GitHub Secrets:

```text
REGISTRY_USERNAME
REGISTRY_PASSWORD
```

The workflow inputs provide:

```text
registry
namespace
image_tag
next_public_api_base_url
```

Do not add automatic image push on normal PR or `main` push until release ownership is settled.
