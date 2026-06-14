# Domain, DNS, and SSL Runbook

This document covers the Stage 9F-A dry-run domain plan for `keybox.cloud`.
It does not include real server IP addresses or production secrets.

## 1. Domain Structure

Recommended first production domain structure:

```text
admin.subauto.keybox.cloud  -> Web admin console
api.subauto.keybox.cloud    -> NestJS API
subauto.keybox.cloud        -> Reserved for future public site / customer ordering entry
```

The domain has ICP filing completed:

```text
沪ICP备18045696号
```

## 2. DNS Records

Use placeholders until the production server is assigned:

| Host | Type | Value | Purpose |
| --- | --- | --- | --- |
| `admin.subauto.keybox.cloud` | `A` | `<PRODUCTION_SERVER_IP>` | Web admin console |
| `api.subauto.keybox.cloud` | `A` | `<PRODUCTION_SERVER_IP>` | API service |
| `subauto.keybox.cloud` | `A` | `<PRODUCTION_SERVER_IP>` | Future public site |

Optional:

| Host | Type | Value | Purpose |
| --- | --- | --- | --- |
| `www.subauto.keybox.cloud` | `CNAME` | `subauto.keybox.cloud` | Future public alias |

Before cutover, reduce DNS TTL where supported so rollback is faster.

## 2.1 Staging DNS Records

Stage 9F-B uses staging subdomains on the Shanghai server:

| Host | Type | Value | Purpose |
| --- | --- | --- | --- |
| `staging-admin.subauto.keybox.cloud` | `A` | `139.196.227.195` | Staging Web admin console |
| `staging-api.subauto.keybox.cloud` | `A` | `139.196.227.195` | Staging API service |

Production cutover can later point the production subdomains to the same server after staging dry run passes:

| Host | Type | Value | Purpose |
| --- | --- | --- | --- |
| `admin.subauto.keybox.cloud` | `A` | `139.196.227.195` | Production Web admin console |
| `api.subauto.keybox.cloud` | `A` | `139.196.227.195` | Production API service |

Alibaba Cloud DNS steps:

1. Open Alibaba Cloud DNS console.
2. Select `keybox.cloud`.
3. Add an `A` record.
4. Use host record `staging-admin.subauto`.
5. Set record value to `139.196.227.195`.
6. Set TTL to `600` seconds for staging and pre-cutover testing.
7. Repeat for `staging-api.subauto`.

Security group requirements:

- allow public inbound `80` and `443` for Caddy HTTP/HTTPS;
- restrict SSH `22` to management IPs or require key-based login;
- do not expose PostgreSQL `5432` to the public internet;
- do not expose API `3001` or Web `3000` directly to the public internet.

## 3. HTTPS

The Stage 9F-A example uses Caddy:

```text
Caddyfile.example
docker-compose.prod.example.yml
```

Caddy can automatically request and renew certificates when:

- DNS records point to the server;
- ports `80` and `443` are reachable from the public internet;
- the Caddy container can persist `/data` and `/config`.

Alternative production option:

```text
Nginx + certbot
```

If Nginx is used later, keep the same routing rules:

```text
admin.subauto.keybox.cloud -> web:3000
api.subauto.keybox.cloud   -> api:3001
```

## 4. CORS

Production API CORS should allow the admin origin:

```text
CORS_ORIGIN=https://admin.subauto.keybox.cloud
```

If more domains are enabled later, add comma-separated origins and restart API:

```text
CORS_ORIGIN=https://admin.subauto.keybox.cloud,https://subauto.keybox.cloud
```

Do not use wildcard CORS in production.

For staging:

```text
CORS_ORIGIN=https://staging-admin.subauto.keybox.cloud
NEXT_PUBLIC_API_BASE_URL=https://staging-api.subauto.keybox.cloud/api
```

## 5. Cookies

Production login cookies require HTTPS.

Current API behavior:

```text
sameSite = lax
secure   = true when NODE_ENV=production
httpOnly = true
```

Production requirements:

- `NODE_ENV=production`;
- HTTPS terminated by Caddy or Nginx;
- browser accesses Web through `https://admin.subauto.keybox.cloud`;
- API base URL points to `https://api.subauto.keybox.cloud/api`.

## 6. ICP Notes

If `keybox.cloud` resolves to a server in mainland China, ICP filing must be completed before public production access.

If the domain resolves to a server outside mainland China, such as Hong Kong or Singapore, ICP filing is usually not required by the hosting region, but the final hosting provider policy must still be checked.

Do not publish a mainland China production endpoint before DNS, ICP, HTTPS, CORS, and cookie behavior have all been verified.

The current mainland China filing provided for this deployment is:

```text
沪ICP备18045696号
```

## 7. Staging Admin Access Policy

Stage 9F-B does not enable an admin IP allowlist.
Staging admin security depends on HTTPS, strong secrets, RBAC, CORS, secure cookies, Linux host hardening, and cloud security groups.
If stronger access control is required later, add WAF rules, VPN access, Basic Auth at the reverse proxy, or an explicit IP allowlist as a separate hardening stage.
