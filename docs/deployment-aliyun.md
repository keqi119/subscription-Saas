# Alibaba Cloud Deployment Notes

Target deployment is an Alibaba Cloud ECS server running Node.js and Docker.

阶段 1 首选先采用方案 A：服务器只运行 PostgreSQL/Redis，本地继续运行 Web/API。
详细步骤见 `docs/aliyun-db-only.md`。

## Recommended Runtime

- Node.js 20 LTS or newer.
- pnpm managed by Corepack.
- Docker Compose for PostgreSQL and Redis in early environments.
- A reverse proxy such as Nginx in front of the web and API services.

## Ports

- Web: `3000`
- API: `3001`
- PostgreSQL: `5432`
- Redis: `6379`

## First Boot

```bash
corepack enable
corepack prepare pnpm@11.4.0 --activate
pnpm install
docker compose up -d postgres redis
cp .env.example .env
pnpm prisma:migrate
pnpm prisma:seed
pnpm prisma:validate
pnpm dev
```

Production process management can use systemd or PM2 after the Stage 1 API and web
entry points are stable.
